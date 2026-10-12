import { createHash, randomUUID } from 'node:crypto'
import { clean, clip, contentText, record, text } from './content.js'

const numeric = value => typeof value === 'number' && Number.isFinite(value) ? Math.min(1e12, Math.max(0, value)) : 0
const outcome = message => message?.stopReason === 'aborted' ? 'aborted' : message?.stopReason === 'error' ? 'error' : 'completed'
const usageTotals = usage => ({ inputTokens: numeric(usage?.input ?? usage?.inputTokens) + numeric(usage?.cacheRead) + numeric(usage?.cacheWrite), outputTokens: numeric(usage?.output ?? usage?.outputTokens), cost: numeric(typeof usage?.cost === 'number' ? usage.cost : usage?.cost?.total), cacheRead: numeric(usage?.cacheRead), cacheWrite: numeric(usage?.cacheWrite) })

function childLinks(details) {
  const links = new Map()
  let nodes = 256
  function visit(value, depth, descriptor = false) {
    if (!value || typeof value !== 'object' || depth > 5 || --nodes < 0 || links.size >= 32) return
    const child = value.childSession || (descriptor ? value : undefined)
    if (child && typeof child === 'object' && (child.id || child.sessionId)) {
      const descriptor = { sessionId: clip(child.id || child.sessionId, 160), sessionFile: clip(child.path || child.sessionFile, 2048), cwd: clip(child.cwd, 2048) }
      links.set(descriptor.sessionId, descriptor)
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 32) && nodes > 0; i++) visit(value[i], depth + 1, descriptor)
    } else {
      for (const key of ['results', 'result', 'details', 'children', 'childSessions']) visit(value[key], depth + 1, key === 'children' || key === 'childSessions')
    }
  }
  visit(details, 0)
  return [...links.values()]
}

export function createPiTracingExtension(options = {}) {
  const getStore = options.getStore || options.getSink
  if (typeof getStore !== 'function') throw new TypeError('getStore is required')
  let active
  let root
  let turn
  let generation
  let compaction
  let started = 0
  let turnCount = 0
  let lastReason = ''
  let lastStream = 0
  let sink
  let sending
  let stopped = false
  let unsubscribe
  let boundSession
  let currentContext
  let removals = []
  let durabilityFailure
  let retryTimer
  let retries = 0
  let queuedBytes = 0
  let dirtyBytes = 0
  let attributionBytes = 0
  let closePromise
  let owner
  let completion
  let reconciliationCount = 0
  let retainedAccountingBytes = 0
  const owners = new Set()
  const capturedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const queueLimit = 16 * 1024 * 1024
  let lastCompactionId
  let hostCompactionFailed = false
  const tools = new Map()
  const outbox = new Map()
  const accounted = new WeakMap()
  const finalized = new WeakSet()

  function report(error) {
    try { Promise.resolve(options.onError?.(error)).catch(() => {}) } catch {}
  }

  async function bounded(promise, timeout = 5000) {
    let timer
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Elune capture timed out')), timeout) })])
    } finally { clearTimeout(timer) }
  }

  function context(ctx) {
    const manager = ctx?.sessionManager
    const extra = options.getContext?.(ctx) || {}
    return {
      sessionId: manager?.getSessionId?.() || ctx?.sessionId || extra.sessionId,
      metadata: {
        ...clean(extra, 4096),
        cwd: clip(ctx?.cwd || manager?.getCwd?.() || extra.cwd, 2048),
        sessionName: clip(manager?.getSessionName?.() || ctx?.sessionName || extra.sessionName, 512),
        sessionFile: clip(manager?.getSessionFile?.() || ctx?.sessionFile || extra.sessionFile, 2048),
        branchId: manager?.getLeafId?.() || extra.branchId || null,
        parentSessionFile: clip(manager?.getHeader?.()?.parentSession || extra.parentSessionFile, 2048),
        parent: clean(typeof options.getParent === 'function' ? options.getParent(ctx) : options.parent || extra.parent, 2048),
      },
    }
  }

  function touch(item, current = owner) {
    if (!current || !item) return
    const dirty = current.dirty
    const previous = dirty.get(item.id)?.value || outbox.get(current.trace.id)?.observations.get(item.id)?.value
    const snapshot = { ...previous, ...record(item, true) }
    const bytes = Buffer.byteLength(JSON.stringify(snapshot)) + 32
    const nextBytes = dirtyBytes + bytes - (dirty.get(item.id)?.bytes || 0)
    if (queuedBytes + nextBytes > queueLimit) throw new Error('Elune capture queue overloaded; changed rows could not be retained')
    dirty.set(item.id, { value: snapshot, bytes })
    dirtyBytes = nextBytes
  }

  function observation(name, type, parentId, input = '', itemId = randomUUID()) {
    const item = { id: itemId, parentId, name: clip(name || 'Observation', 512), type, startTime: Math.max(0, (Date.now() - started) / 1000), duration: 0, status: 'running', level: 'DEFAULT', model: '', input: text(input), output: '', inputTokens: 0, outputTokens: 0, cost: 0, metadata: {} }
    touch(item)
    return item
  }

  function stop(item, status = 'completed', replace = false) {
    if (!item || (item.status !== 'running' && !replace)) return
    if (item.status === 'running') item.duration = Math.max(0, (Date.now() - started) / 1000 - item.startTime)
    item.status = status
    item.level = status === 'error' ? 'ERROR' : status === 'aborted' ? 'WARNING' : 'DEFAULT'
    touch(item)
  }

  function account(item, usage, included = true, current = owner) {
    if (!current || !item) return
    const active = current.trace
    const previous = accounted.get(item) || { inputTokens: 0, outputTokens: 0, cost: 0, cacheRead: 0, cacheWrite: 0 }
    const raw = usageTotals(usage)
    const excluded = { inputTokens: 0, outputTokens: 0, cost: 0, cacheRead: 0, cacheWrite: 0 }
    for (const contribution of item.childContributions?.values() || []) for (const key of Object.keys(excluded)) excluded[key] += contribution[key]
    const next = Object.fromEntries(Object.keys(excluded).map(key => [key, included ? Math.max(0, raw[key] - excluded[key]) : 0]))
    if (Object.keys(excluded).some(key => excluded[key] > raw[key])) item.metadata.usageAttributionUnknown = true
    for (const key of ['inputTokens', 'outputTokens', 'cost']) {
      active[key] = Math.max(0, active[key] + next[key] - previous[key])
      item[key] = raw[key]
    }
    for (const key of ['cacheRead', 'cacheWrite']) active.metadata[`${key}Tokens`] = Math.max(0, numeric(active.metadata[`${key}Tokens`]) + next[key] - previous[key])
    active.totalTokens = active.inputTokens + active.outputTokens
    item.metadata.usage = clean(usage, 2048)
    item.metadata.usageKnown = usage != null
    item.metadata.usageIncluded = included
    item.metadata.includedUsage = next
    accounted.set(item, next)
    touch(item, current)
  }

  function fail(error) {
    if (durabilityFailure) return
    durabilityFailure = Object.assign(error instanceof Error ? error : new Error(String(error)), { durable: false, retainedBytes: queuedBytes + dirtyBytes + retainedAccountingBytes })
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    for (const current of owners) for (const pending of current.pending.values()) pending.reject(durabilityFailure)
    report(durabilityFailure)
    settleCompletion()
  }

  function settleCompletion() {
    if (!completion) return
    if (durabilityFailure) completion.reject(durabilityFailure)
    else if (!active && !sending && !outbox.size && !dirtyBytes && !reconciliationCount) completion.resolve({ captured: true, usage: { ...capturedUsage } })
    else return
    completion = undefined
  }

  function retainAccounting(current) {
    const bytes = current.pending.size ? Buffer.byteLength(JSON.stringify([current.trace, current.root, [...current.items.values()]], (_key, value) => value instanceof Map ? [...value] : value instanceof Set ? [...value] : value)) + 256 : 0
    const next = retainedAccountingBytes + bytes - current.accountingBytes
    if (next > queueLimit) throw new Error('Elune child reconciliation state overloaded; attribution is incomplete')
    retainedAccountingBytes = next
    current.accountingBytes = bytes
    if (!current.pending.size) current.items.clear()
    if (current !== owner && !current.pending.size && !current.dirty.size && !outbox.has(current.trace.id) && !durabilityFailure) owners.delete(current)
  }

  function pump() {
    if (sending || retryTimer || durabilityFailure || !outbox.size) return
    const [traceId, patch] = outbox.entries().next().value
    const header = patch.trace
    const changes = new Map()
    let bytes = patch.headerBytes
    for (const [id, item] of patch.observations) {
      if (changes.size && (changes.size >= 512 || bytes + item.bytes > 1024 * 1024)) break
      changes.set(id, item)
      bytes += item.bytes
    }
    sending = (async () => {
      sink ||= await bounded(Promise.resolve().then(getStore))
      if (!sink || typeof sink.writeTrace !== 'function') throw new TypeError('Elune sink must provide writeTrace')
      await sink.writeTrace({ trace: header, observations: [...changes.values()].map(item => item.value) })
      for (const [id, item] of changes) if (patch.observations.get(id) === item) {
        patch.observations.delete(id)
        queuedBytes -= item.bytes
      }
      if (!patch.observations.size && patch.trace === header) {
        outbox.delete(traceId)
        queuedBytes -= patch.headerBytes
        if (header.status !== 'running') {
          const cacheRead = numeric(header.metadata.cacheReadTokens)
          const cacheWrite = numeric(header.metadata.cacheWriteTokens)
          const usage = { input: Math.max(0, header.inputTokens - cacheRead - cacheWrite), output: header.outputTokens, cacheRead, cacheWrite, cost: header.cost }
          for (const key of Object.keys(capturedUsage)) capturedUsage[key] += usage[key] - patch.owner.committedUsage[key]
          patch.owner.committedUsage = usage
        }
        retainAccounting(patch.owner)
      }
      retries = 0
    })().catch(error => {
      report(error)
      if (error?.unresolved || error?.name === 'TypeError' || ++retries >= 4) fail(error)
      else retryTimer = setTimeout(() => { retryTimer = undefined; pump() }, [100, 500, 1500][retries - 1])
    }).finally(() => {
      sending = undefined
      pump()
      settleCompletion()
    })
  }

  function publish(current = owner) {
    if (!current) return false
    const active = current.trace
    const root = current.root
    const dirty = current.dirty
    if (active.status === 'running') active.latency = Math.max(0, (Date.now() - current.started) / 1000)
    if (root) {
      root.inputTokens = active.inputTokens
      root.outputTokens = active.outputTokens
      root.cost = active.cost
      root.output = active.output
      touch(root, current)
    }
    const previous = outbox.get(active.id)
    if (!previous && outbox.size >= 128) throw new Error('Elune capture trace queue overloaded; trace was not queued')
    const trace = record(active)
    const headerBytes = Buffer.byteLength(JSON.stringify(trace)) + 64
    let nextBytes = queuedBytes + headerBytes - (previous?.headerBytes || 0)
    for (const [id, item] of dirty) nextBytes += item.bytes - (previous?.observations.get(id)?.bytes || 0)
    if (nextBytes > queueLimit) throw new Error('Elune capture queue overloaded; changed rows could not be retained')
    const patch = previous || { observations: new Map(), owner: current }
    for (const [id, item] of dirty) patch.observations.set(id, item)
    patch.trace = trace
    patch.headerBytes = headerBytes
    queuedBytes = nextBytes
    for (const item of dirty.values()) dirtyBytes -= item.bytes
    dirty.clear()
    outbox.set(active.id, patch)
    pump()
    return true
  }

  async function flush() {
    try {
      for (const current of owners) if (current.dirty.size) publish(current)
      const deadline = Date.now() + 5000
      await bounded((async () => {
        while (sending || outbox.size || retryTimer || reconciliationCount) {
          if (Date.now() >= deadline) throw new Error('Elune capture timed out; unresolved data remains retained')
          if (durabilityFailure) throw durabilityFailure
          pump()
          if (sending) await sending
          else await new Promise(resolve => setTimeout(resolve, 20))
        }
        if (durabilityFailure) throw durabilityFailure
        if (dirtyBytes) throw new Error('Elune changed rows remain unpublished')
        await sink?.flush?.()
      })())
    } catch (error) { report(error); throw error }
  }

  function finish(status) {
    if (!active) return
    const final = lastReason === 'aborted' ? 'aborted' : status || (lastReason === 'error' ? 'error' : 'completed')
    if (compaction) {
      stop(compaction.item, final === 'completed' ? 'aborted' : final)
      compaction.item.metadata.incomplete = true
      touch(compaction.item)
      compaction = undefined
    }
    for (const item of tools.values()) if (item.status === 'running') stop(item, final === 'completed' ? 'aborted' : final)
    if (generation?.status === 'running') stop(generation, final)
    stop(turn, final)
    stop(root, final)
    active.latency = Math.max(0, (Date.now() - started) / 1000)
    active.status = final
    active.level = final === 'error' ? 'ERROR' : final === 'aborted' || active.metadata.hadErrors ? 'WARNING' : 'DEFAULT'
    if (root) { root.level = active.level; touch(root) }
    const current = owner
    try { publish() } finally {
      owner = undefined
      active = undefined
      root = undefined
      turn = undefined
      generation = undefined
      tools.clear()
      attributionBytes = 0
      retainAccounting(current)
      settleCompletion()
    }
  }

  function begin(ctx, input = '', name = 'pi-agent') {
    if (stopped || durabilityFailure || (typeof options.enabled === 'function' ? !options.enabled(ctx) : options.enabled === false)) return
    if (active) finish()
    const info = context(ctx)
    if (!info.sessionId) throw new Error('Pi session identity is required for capture')
    currentContext = ctx
    started = Date.now()
    turnCount = 0
    lastStream = 0
    lastReason = ''
    if (owners.size >= 128) throw new Error('Elune retained trace limit exceeded; capture is incomplete')
    active = { id: randomUUID(), source: 'pi', status: 'running', name, timestamp: new Date(started).toISOString(), environment: clip(options.environment || 'local', 160), userId: '', sessionId: info.sessionId, latency: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cost: 0, level: 'DEFAULT', tags: ['pi', 'coding-agent'], input: text(input), output: '', metadata: { ...info.metadata, startEntryId: info.metadata.branchId, attempts: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: '', version: '0.1.0' }
    owner = { trace: active, root: undefined, started, dirty: new Map(), pending: new Map(), items: new Map(), accountingBytes: 0, committedUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }
    owners.add(owner)
    root = observation(name, 'AGENT', null, input)
    owner.root = root
    root.startTime = 0
    publish()
  }

  function generationEnd(message, entryId, ctx) {
    if (!active || message?.role !== 'assistant' || !generation) return
    lastReason = message.stopReason
    active.model = clip(message.model, 512)
    active.output = contentText(message.content)
    generation.name = active.model || 'model-call'
    generation.model = active.model
    generation.output = message.errorMessage ? text(message.errorMessage) : active.output
    generation.metadata = { ...generation.metadata, provider: message.provider, api: message.api, responseModel: message.responseModel, responseId: message.responseId, stopReason: message.stopReason, errorMessage: clip(message.errorMessage, 2048), messageEntryId: entryId || generation.metadata.messageEntryId }
    if (entryId) {
      const entry = ctx?.sessionManager?.getEntry?.(entryId)
      generation.metadata.entryParentId = entry?.parentId ?? null
      active.metadata.endEntryId = entryId
      let ancestor = entry
      for (let depth = 0; ancestor && depth < 256; depth++) {
        if (ancestor.type === 'message' && ancestor.message?.role === 'user') {
          active.metadata.userEntryId ||= ancestor.id
          break
        }
        if (!ancestor.parentId || ancestor.id === active.metadata.startEntryId) break
        ancestor = ctx?.sessionManager?.getEntry?.(ancestor.parentId)
      }
    }
    account(generation, message.usage)
    stop(generation, outcome(message), true)
    if (outcome(message) === 'error') active.metadata.hadErrors = true
    if (message.errorMessage) active.metadata.lastErrorMessage = clip(message.errorMessage, 1024)
    publish()
  }

  function attributeChildren(item, contributions, chain, current = owner) {
    for (const childId of new Set([...(item.directChildren || []), ...contributions.keys()])) {
      for (const parent of chain) {
        parent.childContributions ||= new Map()
        parent.childSources ||= new Map()
        let sources = parent.childSources.get(childId)
        if (contributions.has(childId)) {
          const bytes = (!sources ? 256 : 0) + (!sources?.has(item.id) ? 256 : 0)
          if (current === owner && attributionBytes + bytes > queueLimit) throw new Error('Elune current-turn usage state overloaded; attribution is incomplete')
          if (current === owner) attributionBytes += bytes
          if (!sources) { sources = new Map(); parent.childSources.set(childId, sources) }
          sources.set(item.id, contributions.get(childId))
        } else if (sources?.delete(item.id) && current === owner) attributionBytes -= 256
        if (sources?.size) parent.childContributions.set(childId, [...sources.values()].at(-1))
        else {
          if (sources) { parent.childSources.delete(childId); if (current === owner) attributionBytes -= 256 }
          parent.childContributions.delete(childId)
        }
        parent.metadata.childUsageCaptured = parent.childContributions.size > 0
        if (parent !== item && parent.metadata.usage) account(parent, parent.metadata.usage, !parent.metadata.parentToolCallId, current)
      }
    }
    item.directChildren = new Set(contributions.keys())
  }

  function reconcileChild(item, link, promise, chain, current) {
    const key = `${item.id}:${link.sessionId}`
    const committed = Promise.resolve(promise)
    void committed.catch(report)
    if (current.pending.has(key)) return
    if (reconciliationCount >= 4096) throw new Error('Elune child reconciliation limit exceeded; attribution is incomplete')
    for (const parent of chain) current.items.set(parent.id, parent)
    const pending = {}
    const abort = new Promise((_resolve, reject) => { pending.reject = reject })
    current.pending.set(key, pending)
    reconciliationCount++
    void bounded(Promise.race([committed, abort]), 15000).then(state => {
      if (durabilityFailure || !item.metadata.childSessions?.some(child => child.sessionId === link.sessionId)) return
      if (state?.captured !== true || !state.usage) throw new Error('Elune child capture completed without durable usage')
      const contributions = new Map([...item.directChildren || []].map(id => [id, item.childSources?.get(id)?.get(item.id)]).filter(([, usage]) => usage))
      contributions.set(link.sessionId, usageTotals(state.usage))
      attributeChildren(item, contributions, chain, current)
      for (const child of item.metadata.childSessions || []) if (child.sessionId === link.sessionId) { child.captured = true; child.usageKnown = true }
      account(item, item.metadata.usage, !item.metadata.parentToolCallId, current)
      retainAccounting(current)
      publish(current)
    }).catch(fail).finally(() => {
      current.pending.delete(key)
      reconciliationCount--
      try { retainAccounting(current) } catch (error) { fail(error) }
      settleCompletion()
    })
    retainAccounting(current)
  }

  function toolEnd(item, result, isError, entryId, ctx, authoritative = false) {
    if (!active || !item || (!authoritative && finalized.has(item))) return
    item.output = contentText(result?.content ?? result)
    const links = childLinks(result?.details)
    const contributions = new Map()
    const chain = []
    let ancestor = item
    while (ancestor && !chain.includes(ancestor)) { chain.push(ancestor); ancestor = tools.get(ancestor.metadata.parentToolCallId) }
    if (links.length || item.directChildren?.size) item.metadata.childSessions = links
    for (const link of links) {
      const state = options.isChildCaptured?.(link)
      const captured = typeof state === 'boolean' ? state : state?.captured === undefined ? undefined : state.captured === true
      link.captured = captured ?? null
      link.usageKnown = Boolean(captured && state?.usage)
      if (link.usageKnown) contributions.set(link.sessionId, usageTotals(state.usage))
      else if (state?.completion) reconcileChild(item, link, state.completion, chain, owner)
      else if (captured !== false) {
        item.metadata.usageAttributionUnknown = true
        active.metadata.usageAttributionUnknown = true
      }
    }
    attributeChildren(item, contributions, chain)
    item.metadata.resultDetails = clean(result?.details, 1024)
    item.metadata.nestedCalls = clean(result?.nestedCalls, 1024)
    if (entryId) {
      item.metadata.toolResultEntryId = entryId
      item.metadata.entryParentId = ctx?.sessionManager?.getEntry?.(entryId)?.parentId ?? null
    }
    account(item, result?.usage, !item.metadata.parentToolCallId)
    stop(item, isError ? 'error' : 'completed', true)
    if (isError) {
      active.metadata.hadErrors = true
      active.metadata.lastToolError = { toolCallId: item.metadata.toolCallId, output: clip(item.output, 1024) }
    }
    if (authoritative) finalized.add(item)
    publish()
    delete item.input
    delete item.output
    if (owner.pending.size) retainAccounting(owner)
  }

  function turnEnd(event, ctx) {
    if (!active) return
    generationEnd(event.message, event.messageEntryId, ctx)
    for (let i = 0; i < (event.toolResults?.length || 0); i++) {
      const result = event.toolResults[i]
      toolEnd(tools.get(result.toolCallId), result, result.isError, event.toolResultEntryIds?.[i], ctx, true)
    }
    if (turn) {
      if (event.messageEntryId) turn.metadata.messageEntryId = event.messageEntryId
      if (event.toolResultEntryIds) turn.metadata.toolResultEntryIds = clean(event.toolResultEntryIds, 4096)
    }
    stop(turn, event.outcome || outcome(event.message), true)
    publish()
  }

  function compactStart(event, ctx) {
    hostCompactionFailed = false
    if (compaction) {
      if (event.preparation) {
        compaction.item.input = text({ instructions: event.customInstructions, messages: event.preparation.messagesToSummarize, turnPrefixMessages: event.preparation.turnPrefixMessages })
        compaction.item.metadata.willRetry = Boolean(event.willRetry)
        touch(compaction.item)
        publish()
      }
      return
    }
    const standalone = !active || event.reason === 'manual'
    if (standalone) begin(ctx, event.customInstructions || '', 'pi-compaction')
    if (!active) return
    const item = observation('Context compaction', 'SPAN', root.id, { instructions: event.customInstructions, messages: event.preparation?.messagesToSummarize, turnPrefixMessages: event.preparation?.turnPrefixMessages })
    const model = event.model || (boundSession?.sessionManager === ctx?.sessionManager ? boundSession.model : ctx?.model)
    const virtual = model?.api === 'pi-virtual'
    item.model = virtual ? '' : clip(typeof model === 'string' ? model : model?.id, 512)
    item.metadata = { reason: event.reason, willRetry: Boolean(event.willRetry), requestModel: item.model, selectedModel: clip(typeof model === 'string' ? model : model?.id, 512), selectedProvider: clip(model?.provider, 160), provider: virtual ? '' : clip(event.provider || model?.provider, 160), api: virtual ? '' : clip(event.api || model?.api, 160), identityKnown: Boolean(item.model), identitySource: event.type === 'compaction_start' ? 'compaction_start' : 'session_before_compact' }
    active.model = item.model || active.model
    compaction = { item, standalone }
    touch(item)
    publish()
  }

  function compactEnd(event, ctx) {
    if (event.type === 'session_compact_failed' && !compaction && hostCompactionFailed) { hostCompactionFailed = false; return }
    const entry = event.compactionEntry
    if (entry?.id && entry.id === lastCompactionId) return
    if (!compaction) compactStart(event, ctx)
    if (!compaction || !active) return
    const pending = compaction
    compaction = undefined
    const item = pending.item
    const result = entry || event.result
    const status = event.aborted ? 'aborted' : event.errorMessage || (!result && event.type !== 'session_compact') ? 'error' : 'completed'
    const usage = result?.usage || item.metadata.usage
    item.type = usage ? 'GENERATION' : 'SPAN'
    item.output = text(result?.summary || event.errorMessage || (event.aborted ? 'Compaction canceled' : ''))
    item.metadata = { ...item.metadata, compactionId: entry?.id, firstKeptEntryId: result?.firstKeptEntryId, fromExtension: event.fromExtension, tokensBefore: result?.tokensBefore, errorMessage: clip(event.errorMessage, 2048) }
    account(item, usage)
    stop(item, status)
    if (status === 'error') active.metadata.hadErrors = true
    if (entry?.id) {
      lastCompactionId = entry.id
      active.metadata.endEntryId = entry.id
      item.metadata.entryParentId = entry.parentId
      touch(item)
    }
    if (pending.standalone) { active.output = item.output; finish(status) } else publish()
    hostCompactionFailed = event.type === 'compaction_end' && status !== 'completed'
  }

  function safe(handler) {
    return (event, ctx) => {
      try {
        const result = handler(event, ctx)
        if (result?.then) return result.catch(fail).then(() => undefined)
      } catch (error) { fail(error) }
      return undefined
    }
  }

  const handlers = {
    session_start: (_event, ctx) => {
      stopped = false
      closePromise = undefined
      currentContext = ctx
      if (boundSession?.sessionManager === ctx?.sessionManager) bindSession(boundSession)
    },
    before_agent_start: (event, ctx) => { begin(ctx, event.prompt) },
    agent_start: (_event, ctx) => {
      if (!active) begin(ctx)
      if (active) { delete active.metadata.settlementOutcome; lastReason = ''; active.metadata.attempts++; publish() }
    },
    message_start: event => {
      if (!active || active.input || !['user', 'custom'].includes(event.message?.role)) return
      active.input = contentText(event.message.content)
      root.input = active.input
      touch(root)
      publish()
    },
    turn_start: event => {
      if (!active) return
      stop(turn)
      tools.clear()
      attributionBytes = 0
      turn = observation(`Turn ${++turnCount}`, 'SPAN', root.id)
      turn.metadata = { turnIndex: event.turnIndex, attempt: active.metadata.attempts }
      delete active.metadata.settlementOutcome
      generation = observation('model-call', 'GENERATION', turn.id)
      touch(turn)
      publish()
    },
    context: event => {
      if (generation?.status === 'running' && !compaction) { generation.input = text({ messages: event.messages }); touch(generation) }
    },
    before_provider_request: event => {
      const item = compaction?.item || generation
      if (item?.status !== 'running') return
      item.input = text(event.payload)
      const model = event.payload?.model || event.payload?.modelId
      if (typeof model === 'string') { item.model = clip(model, 512); item.metadata.requestModel = item.model }
      touch(item)
    },
    provider_stream_event: event => {
      const item = compaction?.item || generation
      if (!active || !item || item.metadata.requestIdentity) return
      item.model = clip(event.model, 512)
      item.metadata.provider = clip(event.provider, 160)
      item.metadata.api = clip(event.api, 160)
      item.metadata.requestIdentity = true
      item.metadata.identityKnown = Boolean(item.model)
      item.metadata.identitySource = 'provider_stream_event'
      if (compaction) active.model = item.model || active.model
      touch(item)
    },
    message_update: event => {
      if (!active || !generation || event.message?.role !== 'assistant' || Date.now() - lastStream < 750 || sending) return
      lastStream = Date.now()
      generation.output = contentText(event.message.content)
      generation.model = clip(event.message.model || generation.model, 512)
      touch(generation)
      publish()
    },
    message_end: (event, ctx) => {
      if (event.message?.role === 'assistant') generationEnd(event.message, undefined, ctx)
      if (event.message?.role === 'toolResult') toolEnd(tools.get(event.message.toolCallId), event.message, event.message.isError, undefined, ctx)
    },
    tool_execution_start: event => {
      if (!active) return
      if (tools.size >= 4096) throw new Error('Elune current-turn tool state overloaded; capture is incomplete')
      const parent = tools.get(event.parentToolCallId)
      const itemId = `tool-${createHash('sha256').update(`${active.id}:${turn?.id}:${event.toolCallId}`).digest('hex').slice(0, 32)}`
      const item = observation(event.toolName, 'TOOL', parent?.id || turn?.id || root.id, event.args, itemId)
      item.metadata = { toolCallId: clip(event.toolCallId, 512), parentToolCallId: clip(event.parentToolCallId, 512) || null }
      tools.set(event.toolCallId, item)
      touch(item)
      publish()
      delete item.input
    },
    tool_execution_update: event => {
      const item = tools.get(event.toolCallId)
      if (!active || !item || item.status !== 'running' || Date.now() - lastStream < 750 || sending) return
      lastStream = Date.now()
      item.output = contentText(event.partialResult?.content ?? event.partialResult)
      touch(item)
      publish()
      delete item.output
    },
    tool_execution_end: (event, ctx) => { toolEnd(tools.get(event.toolCallId), event.result, event.isError, undefined, ctx) },
    turn_end: turnEnd,
    agent_before_settle: event => { if (active) active.metadata.settlementOutcome = event.outcome },
    agent_settled: (_event, ctx) => {
      if (active) {
        const info = context(ctx)
        active.metadata.sessionName = info.metadata.sessionName
        active.metadata.endEntryId = info.metadata.branchId || active.metadata.endEntryId
        finish(active.metadata.settlementOutcome)
      }
    },
    session_before_compact: compactStart,
    session_compact: compactEnd,
    session_compact_failed: compactEnd,
    session_info_changed: event => { if (active) { active.metadata.sessionName = clip(event.name, 512); publish() } },
    session_shutdown: () => {
      finish('aborted')
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      return flush()
    },
  }

  const factory = pi => {
    stopped = false
    for (const remove of removals) remove?.()
    removals = Object.entries(handlers).map(([name, handler]) => pi.on(name, safe(handler)))
    if (boundSession) bindSession(boundSession)
  }

  factory.observe = safe((event, ctx) => {
    if (stopped || durabilityFailure) return
    if (ctx?.sessionManager) currentContext = ctx
    if (event.type === 'provider_request') {
      const item = event.operation === 'compaction' ? compaction?.item : generation
      if (active && item) {
        item.model = clip(typeof event.model === 'string' ? event.model : event.model?.id, 512)
        item.metadata.provider = clip(event.provider || event.model?.provider, 160)
        item.metadata.api = clip(event.api || event.model?.api, 160)
        item.metadata.requestIdentity = true
        item.metadata.identityKnown = Boolean(item.model)
        item.metadata.identitySource = 'provider_request'
        if (event.operation === 'compaction') active.model = item.model || active.model
        touch(item)
        publish()
      }
    } else if (event.type === 'compaction_usage') {
      if (active && compaction) {
        compaction.item.type = 'GENERATION'
        account(compaction.item, event.usage)
        publish()
      }
    } else if (event.type === 'message_end') {
      if (event.message?.role === 'assistant') generationEnd(event.message, undefined, ctx)
      if (event.message?.role === 'toolResult') toolEnd(tools.get(event.message.toolCallId), event.message, event.message.isError, undefined, ctx, true)
    } else if (event.type === 'turn_end') turnEnd(event, ctx)
    else if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end' || event.type === 'summarization_retry_scheduled') {
      if (!active) return
      active.metadata.retry = clean(event, 2048)
      if (event.type === 'auto_retry_end' && !event.success && event.finalError === 'Retry cancelled') {
        lastReason = 'aborted'
        active.metadata.retryCanceled = true
      } else if (event.finalError) lastReason = 'error'
      publish()
    } else if (event.type === 'compaction_start') compactStart(event, ctx)
    else if (event.type === 'compaction_end' && compaction) compactEnd(event, ctx)
    else if (event.type === 'entry_appended' && active) {
      const entry = event.entry
      if (entry?.type === 'context_edit') {
        active.metadata.recoveryOmissions = numeric(active.metadata.recoveryOmissions) + 1
        publish()
      } else if (entry?.type === 'compaction') compactEnd({ type: 'session_compact', reason: 'boundary', compactionEntry: entry, fromExtension: true, willRetry: false }, ctx)
    }
  })
  function bindSession(session) {
    if (active && active.sessionId !== session.sessionManager.getSessionId()) {
      try { finish('aborted') } catch (error) { fail(error) }
    }
    unsubscribe?.()
    boundSession = session
    currentContext = { sessionManager: session.sessionManager, cwd: session.sessionManager.getCwd(), model: session.model }
    const remove = session.subscribe(event => factory.observe(event, { sessionManager: session.sessionManager, cwd: session.sessionManager.getCwd(), model: session.model }))
    unsubscribe = remove
    return () => { remove(); if (unsubscribe === remove) unsubscribe = undefined }
  }
  factory.bindSession = bindSession
  factory.flush = flush
  factory.close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      try { finish('aborted') } catch (error) { fail(error) }
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      boundSession = undefined
      currentContext = undefined
      for (const remove of removals) remove?.()
      removals = []
      try { await flush() } catch (error) { fail(error); throw error }
    })()
    return closePromise
  }
  factory.getDurability = () => {
    const retainedBytes = queuedBytes + dirtyBytes + retainedAccountingBytes
    if (durabilityFailure) durabilityFailure.retainedBytes = retainedBytes
    return { pending: Boolean(sending || outbox.size || dirtyBytes || reconciliationCount), retainedBytes, dirtyRows: [...owners].reduce((total, current) => total + current.dirty.size, 0), queuedRows: [...outbox.values()].reduce((total, patch) => total + patch.observations.size, 0), pendingReconciliations: reconciliationCount, failedRecords: durabilityFailure ? owners.size : 0, error: durabilityFailure || null }
  }
  factory.getCapturedUsage = () => ({ captured: !active && !sending && !outbox.size && !dirtyBytes && !reconciliationCount && !durabilityFailure, usage: { ...capturedUsage } })
  factory.whenCaptured = () => {
    const snapshot = factory.getCapturedUsage()
    if (durabilityFailure) return Promise.reject(durabilityFailure)
    if (snapshot.captured) return Promise.resolve(snapshot)
    if (!completion) {
      const pending = {}
      pending.promise = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject })
      completion = pending
    }
    return completion.promise
  }
  factory.getActiveTraceId = () => active?.id || null
  factory.getParentContext = toolCallId => {
    if (!active) return null
    const tool = tools.get(toolCallId)
    let callId = toolCallId
    let ancestor = tool
    const visited = new Set()
    while (ancestor?.metadata.parentToolCallId && !visited.has(ancestor.id)) {
      visited.add(ancestor.id)
      callId = ancestor.metadata.parentToolCallId
      ancestor = tools.get(callId)
    }
    let entryId = tool?.metadata.messageEntryId || generation?.metadata.messageEntryId
    if (!entryId) {
      const manager = currentContext?.sessionManager || boundSession?.sessionManager
      let entry = manager?.getLeafEntry?.() || manager?.getEntry?.(manager?.getLeafId?.())
      while (entry && entry.id !== active.metadata.startEntryId) {
        if (entry.type === 'message' && entry.message?.role === 'assistant' && (!callId || entry.message.content?.some(part => part.type === 'toolCall' && part.id === callId))) {
          entryId = entry.id
          if (generation) generation.metadata.messageEntryId = entryId
          if (tool) tool.metadata.messageEntryId = entryId
          break
        }
        entry = entry.parentId ? manager?.getEntry?.(entry.parentId) : undefined
      }
    }
    return { traceId: active.id, sessionId: active.sessionId, sessionFile: active.metadata.sessionFile, toolCallId: toolCallId || null, observationId: tool?.id || null, entryId: entryId || null }
  }
  return factory
}
