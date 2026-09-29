import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { TraceExporter } from './exporter.ts'

type Status = 'running' | 'completed' | 'error' | 'aborted'
type Observation = {
  id: string
  parentId: string | null
  name: string
  type: string
  startTime: number
  duration: number
  status: Status
  level: string
  model: string
  input: string
  output: string
  inputTokens: number
  outputTokens: number
  cost: number
  metadata: Record<string, unknown>
}
type Trace = {
  id: string
  name: string
  timestamp: string
  environment: string
  userId: string
  sessionId: string
  latency: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cost: number
  level: string
  tags: string[]
  bookmarked: boolean
  input: string
  output: string
  metadata: Record<string, unknown>
  model: string
  version: string
  scores: unknown[]
  observations: Observation[]
  source: 'pi'
  status: Status
  revision: number
}

const textLimit = 32768
const text = (value: unknown) => {
  const result = typeof value === 'string' ? value : JSON.stringify(value ?? null, (_key, item) => {
    if (item?.type === 'image') return { type: 'image', mimeType: item.mimeType, omitted: true }
    if (item?.type === 'thinking') return { type: 'thinking', omitted: true }
    return item
  }, 2)
  return result.length <= textLimit ? result : `${result.slice(0, textLimit)}\n[truncated]`
}
const numeric = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0
const contentText = (content: unknown) => {
  if (!Array.isArray(content)) return text(content)
  const visible = content.filter(part => part.type !== 'thinking')
  if (visible.every(part => part.type === 'text')) return text(visible.map(part => part.text).join('\n'))
  return text(visible.map(part => part.type === 'text' ? part.text : part.type === 'toolCall' ? { toolCallId: part.id, name: part.name, arguments: part.arguments } : { type: part.type, omitted: true }))
}

export default function (pi: ExtensionAPI) {
  let exporter: TraceExporter | undefined
  let current: Trace | undefined
  let root: Observation | undefined
  let turn: Observation | undefined
  let generation: Observation | undefined
  let started = 0
  let turnCount = 0
  let lastReason = ''
  let lastStream = 0
  let compaction: { started: number; input: string; traceId?: string } | undefined
  const compactions = new Set<string>()
  const tools = new Map<string, Observation>()

  function observation(name: string, type: string, parentId: string | null, input = '', id = randomUUID()) {
    const item: Observation = { id, parentId, name, type, startTime: Math.max(0, (Date.now() - started) / 1000), duration: 0, status: 'running', level: 'DEFAULT', model: '', input: text(input), output: '', inputTokens: 0, outputTokens: 0, cost: 0, metadata: {} }
    current?.observations.push(item)
    return item
  }

  function stop(item: Observation | undefined, status: Status = 'completed') {
    if (!item || item.status !== 'running') return
    item.duration = Math.max(0, (Date.now() - started) / 1000 - item.startTime)
    item.status = status
    if (status === 'error') item.level = 'ERROR'
    if (status === 'aborted') item.level = 'WARNING'
  }

  function publish() {
    if (!current || !exporter) return
    current.latency = Math.max(0, (Date.now() - started) / 1000)
    current.revision++
    for (const item of current.observations) {
      if (item.status === 'running') item.duration = Math.max(0, current.latency - item.startTime)
    }
    const calls = current.observations.filter(item => item.type === 'GENERATION' || item.type === 'TOOL')
    current.inputTokens = calls.reduce((sum, item) => sum + item.inputTokens, 0)
    current.outputTokens = calls.reduce((sum, item) => sum + item.outputTokens, 0)
    current.totalTokens = current.inputTokens + current.outputTokens
    current.cost = calls.reduce((sum, item) => sum + item.cost, 0)
    current.metadata.cacheReadTokens = calls.reduce((sum, item) => sum + numeric((item.metadata.usage as any)?.cacheRead), 0)
    current.metadata.cacheWriteTokens = calls.reduce((sum, item) => sum + numeric((item.metadata.usage as any)?.cacheWrite), 0)
    if (root) {
      root.inputTokens = current.inputTokens
      root.outputTokens = current.outputTokens
      root.cost = current.cost
      root.output = current.output
    }
    const snapshot = JSON.parse(JSON.stringify(current)) as Trace
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 6 * 1024 * 1024) {
      snapshot.metadata.contentTruncated = true
      for (const item of snapshot.observations) {
        item.input = item.input.slice(0, 256)
        item.output = item.output.slice(0, 256)
      }
    }
    exporter.enqueue(snapshot)
  }

  function finish(status?: Status) {
    if (!current || current.status !== 'running') return
    const final = status || (lastReason === 'aborted' ? 'aborted' : lastReason === 'error' ? 'error' : 'completed')
    for (const item of current.observations) stop(item, final === 'completed' ? 'completed' : final)
    current.status = final
    current.level = final === 'error' ? 'ERROR' : final === 'aborted' || current.observations.some(item => item.level === 'ERROR') ? 'WARNING' : 'DEFAULT'
    if (root) root.level = current.level
    publish()
    root = undefined
    turn = undefined
    generation = undefined
    tools.clear()
  }

  async function initialize(ctx: ExtensionContext) {
    if (exporter) return
    try {
      exporter = new TraceExporter(process.env.PI_TRACE_URL || 'http://127.0.0.1:8080', process.env.PI_TRACE_QUEUE_DIR || join(ctx.sessionManager.getSessionDir(), '.elune-queue'), state => ctx.ui.setStatus('elune', state ? `elune: ${state}` : undefined))
      await exporter.start()
    } catch (error) {
      exporter = undefined
      ctx.ui.notify(`elune tracing could not start: ${error instanceof Error ? error.message : 'Unknown error'}`, 'warning')
    }
  }

  function begin(ctx: ExtensionContext, input: string, name = 'pi-agent', timestamp = Date.now()) {
    finish()
    started = timestamp
    turnCount = 0
    lastReason = ''
    lastStream = 0
    tools.clear()
    current = { id: randomUUID(), name, timestamp: new Date(started).toISOString(), environment: process.env.PI_TRACE_ENVIRONMENT || 'local', userId: '', sessionId: ctx.sessionManager.getSessionId(), latency: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cost: 0, level: 'DEFAULT', tags: ['pi', 'coding-agent'], bookmarked: false, input: text(input), output: '', metadata: { cwd: ctx.cwd, sessionName: ctx.sessionManager.getSessionName() || '', attempts: 0 }, model: ctx.model?.id || '', version: '0.1.0', scores: [], observations: [], source: 'pi', status: 'running', revision: 0 }
    root = observation(name, 'AGENT', null, input)
    root.startTime = 0
    turn = undefined
    generation = undefined
    publish()
  }

  pi.on('session_start', async (_event, ctx) => { await initialize(ctx) })

  pi.on('before_agent_start', async (event, ctx) => {
    await initialize(ctx)
    begin(ctx, event.prompt)
  })

  pi.on('agent_start', async (_event, ctx) => {
    if (!current || current.status !== 'running') {
      await initialize(ctx)
      begin(ctx, '')
      current!.metadata.trigger = 'extension'
    }
    current!.metadata.attempts = numeric(current!.metadata.attempts) + 1
    publish()
  })

  pi.on('message_start', event => {
    if (!current || current.status !== 'running' || current.input || current.metadata.trigger !== 'extension') return
    if (event.message.role !== 'custom' && event.message.role !== 'user') return
    current.input = contentText(event.message.content)
    root!.input = current.input
    publish()
  })

  pi.on('session_before_compact', event => {
    compaction = {
      started: Date.now(),
      input: text({ instructions: event.customInstructions, messages: event.preparation.messagesToSummarize, turnPrefixMessages: event.preparation.turnPrefixMessages }),
      traceId: event.reason !== 'manual' && current?.status === 'running' ? current.id : undefined,
    }
  })

  pi.on('session_compact', async (event, ctx) => {
    const entry = event.compactionEntry
    if (compactions.has(entry.id)) return
    compactions.add(entry.id)
    const pending = compaction
    compaction = undefined
    const standalone = !current || current.status !== 'running' || current.id !== pending?.traceId
    if (standalone) {
      await initialize(ctx)
      begin(ctx, pending?.input || '', 'pi-compaction', pending?.started)
    }
    const item = observation('Context compaction', entry.usage ? 'GENERATION' : 'SPAN', root!.id, pending?.input)
    item.startTime = Math.max(0, ((pending?.started || Date.now()) - started) / 1000)
    item.model = event.fromExtension ? '' : ctx.model?.id || ''
    item.output = text(entry.summary)
    item.inputTokens = numeric(entry.usage?.input) + numeric(entry.usage?.cacheRead) + numeric(entry.usage?.cacheWrite)
    item.outputTokens = numeric(entry.usage?.output)
    item.cost = numeric(entry.usage?.cost.total)
    item.metadata = { compactionId: entry.id, reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension, provider: event.fromExtension ? '' : ctx.model?.provider || '', tokensBefore: entry.tokensBefore, usage: entry.usage }
    stop(item)
    if (standalone) {
      current!.output = item.output
      finish('completed')
    } else publish()
  })

  pi.on('turn_start', (_event, ctx) => {
    if (!current || current.status !== 'running') return
    if (current.observations.length > 4000) {
      current.metadata.observationsTruncated = true
      generation = undefined
      turn = undefined
      return
    }
    stop(turn)
    turn = observation(`Turn ${++turnCount}`, 'SPAN', root!.id)
    turn.metadata.turnIndex = turnCount - 1
    generation = observation(ctx.model?.id || 'model-call', 'GENERATION', turn.id)
    generation.model = ctx.model?.id || ''
    generation.metadata.provider = ctx.model?.provider || ''
    publish()
  })

  pi.on('context', (event, ctx) => {
    if (generation?.status === 'running') generation.input = text({ systemPrompt: ctx.getSystemPrompt(), messages: event.messages })
  })

  pi.on('before_provider_request', event => {
    if (generation?.status === 'running') generation.input = text(event.payload)
  })

  pi.on('message_update', event => {
    if (!current || current.status !== 'running' || !generation || event.message.role !== 'assistant') return
    if (Date.now() - lastStream < 750) return
    lastStream = Date.now()
    generation.output = contentText(event.message.content)
    publish()
  })

  pi.on('message_end', event => {
    if (!current || current.status !== 'running' || event.message.role !== 'assistant') return
    const message = event.message
    lastReason = message.stopReason
    current.model = message.model
    current.output = contentText(message.content)
    if (generation) {
      generation.model = message.model
      generation.name = message.model
      generation.inputTokens = numeric(message.usage.input) + numeric(message.usage.cacheRead) + numeric(message.usage.cacheWrite)
      generation.outputTokens = numeric(message.usage.output)
      generation.cost = numeric(message.usage.cost.total)
      generation.output = message.errorMessage ? text(message.errorMessage) : current.output
      generation.metadata = { ...generation.metadata, provider: message.provider, usage: message.usage, stopReason: message.stopReason, responseId: message.responseId || '', errorMessage: message.errorMessage || '' }
      stop(generation, message.stopReason === 'error' ? 'error' : message.stopReason === 'aborted' ? 'aborted' : 'completed')
    }
    publish()
  })

  pi.on('tool_execution_start', event => {
    if (!current || current.status !== 'running' || current.observations.length >= 4090) return
    const id = `tool-${createHash('sha256').update(`${current.id}:${turn?.id || root!.id}:${event.toolCallId}`).digest('hex').slice(0, 32)}`
    const item = observation(event.toolName, 'TOOL', turn?.id || root!.id, text(event.args), id)
    item.metadata.toolCallId = event.toolCallId
    tools.set(event.toolCallId, item)
    publish()
  })

  pi.on('tool_execution_update', event => {
    const item = tools.get(event.toolCallId)
    if (!item || item.status !== 'running' || Date.now() - lastStream < 750) return
    lastStream = Date.now()
    item.output = text(event.partialResult)
    publish()
  })

  pi.on('tool_execution_end', event => {
    const item = tools.get(event.toolCallId)
    if (!item) return
    item.output = text(event.result)
    const usage = event.result?.usage
    if (usage) {
      item.inputTokens = numeric(usage.input) + numeric(usage.cacheRead) + numeric(usage.cacheWrite)
      item.outputTokens = numeric(usage.output)
      item.cost = numeric(usage.cost?.total)
      item.metadata.usage = usage
    }
    stop(item, event.isError ? 'error' : 'completed')
    publish()
  })

  pi.on('turn_end', () => {
    if (current?.status !== 'running') return
    stop(turn)
    publish()
  })
  pi.on('agent_settled', () => { finish() })
  pi.on('session_shutdown', async () => {
    finish('aborted')
    await exporter?.close()
    exporter = undefined
  })
}
