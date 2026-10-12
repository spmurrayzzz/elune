import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { record } from './content.js'

export function createElune({ databasePath, onError } = {}) {
  if (typeof databasePath !== 'string' || !databasePath || databasePath.includes('\0')) throw new TypeError('databasePath is required')
  const path = resolve(databasePath)
  const listeners = new Set()
  const requests = new Map()
  const pending = new Map()
  const durabilityErrors = new Map()
  let worker
  let failed
  let closing = false
  let closed = false
  let closePromise
  let sequence = 0
  let writeSequence = 0
  let durabilityBytes = 0
  let pendingBytes = 0
  let inflightBytes = 0
  let draining
  let scheduled

  function report(error) {
    try { Promise.resolve(onError?.(error)).catch(() => {}) } catch {}
  }

  function fields(value) {
    const result = new Set(Object.keys(value || {}).filter(key => key !== 'metadata'))
    for (const key of Object.keys(value?.metadata || {})) result.add(`metadata.${key}`)
    return result
  }

  function acknowledge(required, value) {
    for (const key of fields(value)) required.delete(key)
  }

  function writeFailure(traceId, error, version, trace, observations = new Map()) {
    const previous = durabilityErrors.get(traceId)
    version = Math.max(version, previous?.version || 0)
    if (durabilityErrors.size >= 128 && !previous) {
      durabilityErrors.set('additional-failures', { error: new Error('Additional Elune writes failed'), version, bytes: 0 })
      return
    }
    const requiredTrace = previous?.requiredTrace || fields(trace)
    for (const key of fields(trace)) requiredTrace.add(key)
    const requiredRows = previous?.requiredRows || new Map()
    let bytes = previous?.bytes || 0
    for (const [id, row] of observations) {
      const required = requiredRows.get(id) || new Set()
      for (const key of fields(row)) if (!required.has(key)) { required.add(key); bytes += 128 + key.length * 4 }
      if (!requiredRows.has(id)) bytes += 128 + id.length * 4
      if (durabilityBytes - (previous?.bytes || 0) + bytes > 16 * 1024 * 1024) {
        failure(new Error('Elune durability ledger overloaded; unresolved writes remain'))
        return
      }
      requiredRows.set(id, required)
    }
    durabilityBytes += bytes - (previous?.bytes || 0)
    durabilityErrors.set(traceId, { error, version, requiredTrace, requiredRows, bytes, unresolved: previous?.unresolved || error.unresolved === true })
  }

  function notify(notices) {
    for (const notice of notices || []) {
      for (const listener of listeners) {
        try { Promise.resolve(listener({ ...notice })).catch(report) } catch (error) { report(error) }
      }
    }
  }

  function failure(error) {
    if (failed || closed) return
    failed = error
    if (scheduled) clearImmediate(scheduled)
    scheduled = undefined
    for (const request of requests.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    requests.clear()
    for (const item of pending.values()) item.reject(error)
    pending.clear()
    pendingBytes = 0
    report(error)
    void worker?.terminate().catch(() => {})
  }

  function start() {
    if (worker) return
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { databasePath: path }, resourceLimits: { maxOldGenerationSizeMb: 128 }, execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) })
      worker.on('message', message => {
        if (message.fatal) return failure(new Error(`Elune initialization failed: ${message.fatal}`))
        const request = requests.get(message.requestId)
        if (!request) return
        requests.delete(message.requestId)
        clearTimeout(request.timer)
        if (!requests.size) worker.unref()
        if (message.error) {
          const error = new Error(message.error.message)
          error.name = message.error.name
          report(error)
          request.reject(error)
        } else {
          notify(message.result?.notices)
          request.resolve(message.result)
        }
      })
      worker.on('error', failure)
      worker.on('exit', code => {
        if (!closed && (code !== 0 || requests.size || !closing)) failure(new Error(`Elune worker exited (${code})`))
      })
      worker.unref()
    } catch (error) { failure(error) }
  }

  function request(operation, value) {
    if (failed) return Promise.reject(failed)
    if (closed) return Promise.reject(new Error('Elune store is closed'))
    if (requests.size >= 64) return Promise.reject(new Error('Elune request limit exceeded'))
    start()
    if (failed) return Promise.reject(failed)
    return new Promise((resolveRequest, reject) => {
      const requestId = ++sequence
      const timer = setTimeout(() => failure(new Error('Elune worker request timed out')), 10000)
      requests.set(requestId, { resolve: resolveRequest, reject, timer })
      worker.ref()
      try { worker.postMessage({ requestId, operation, value }) } catch (error) { failure(error) }
    })
  }

  function pump() {
    scheduled = undefined
    if (draining || !pending.size || failed) return
    const batch = []
    let bytes = 0
    for (const [traceId, item] of pending) {
      if (batch.length && (batch.length >= 16 || bytes + item.bytes > 2 * 1024 * 1024)) break
      pending.delete(traceId)
      pendingBytes -= item.bytes
      bytes += item.bytes
      batch.push(item)
    }
    inflightBytes = bytes
    draining = (async () => {
      for (const item of batch) {
        try {
          let notice
          let changes = []
          let size = item.headerBytes
          const save = async () => {
            const result = await request('writeBatch', [{ trace: item.trace, observations: changes }])
            const saved = result.results[0]
            if (saved.error) throw Object.assign(new Error(saved.error.message), { name: saved.error.name })
            notice = saved.notice
            changes = []
            size = item.headerBytes
          }
          const children = new Map()
          const ordered = []
          for (const [id, observation] of item.observations) {
            if (item.observations.has(observation.parentId)) {
              if (!children.has(observation.parentId)) children.set(observation.parentId, [])
              children.get(observation.parentId).push(id)
            } else ordered.push(id)
          }
          for (let index = 0; index < ordered.length; index++) for (const child of children.get(ordered[index]) || []) ordered.push(child)
          if (ordered.length !== item.observations.size) throw new TypeError('Invalid observation parent linkage')
          for (const id of ordered) {
            const observation = item.observations.get(id)
            const bytes = item.sizes.get(id)
            if (changes.length && (changes.length >= 512 || size + bytes > 2 * 1024 * 1024)) await save()
            changes.push(observation)
            size += bytes
          }
          await save()
          const failure = durabilityErrors.get(item.trace.id)
          if (failure?.requiredTrace && !failure.unresolved && failure.version <= item.version) {
            acknowledge(failure.requiredTrace, item.trace)
            for (const [id, row] of item.observations) {
              const required = failure.requiredRows.get(id)
              if (required) { acknowledge(required, row); if (!required.size) failure.requiredRows.delete(id) }
            }
            if (!failure.requiredTrace.size && !failure.requiredRows.size) {
              durabilityErrors.delete(item.trace.id)
              durabilityBytes -= failure.bytes
            }
          }
          item.resolve(notice)
        } catch (error) {
          writeFailure(item.trace.id, error, item.version, item.trace, item.observations)
          report(error)
          item.reject(error)
        }
      }
    })().finally(() => {
      inflightBytes = 0
      draining = undefined
      if (pending.size && !failed) pump()
    })
  }

  function writeTrace({ trace, observations = [] } = {}) {
    if (closing || closed || failed) return Promise.reject(failed || new Error('Elune store is closing'))
    const version = ++writeSequence
    let header
    try {
      if (!Array.isArray(observations)) throw new TypeError('Changed observations must be an array')
      header = record(trace)
      if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(header.id || '')) throw new TypeError('Invalid trace identifier')
      const previous = pending.get(header.id)
      if (!previous && pending.size >= 128) throw Object.assign(new Error('Elune pending write limit exceeded; write was not queued'), { unresolved: true })
      if (previous?.trace.status && previous.trace.status !== 'running' && header.status === 'running') throw new Error('A settled trace cannot resume')
      for (const key of ['sessionId', 'timestamp']) if (previous?.trace[key] !== undefined && header[key] !== undefined && previous.trace[key] !== header[key]) throw new Error('Trace session and timestamp cannot change')
      const updates = new Map()
      let observationBytes = previous ? previous.bytes - previous.headerBytes : 0
      for (const value of observations) {
        const item = record(value, true)
        if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(item.id || '')) throw new TypeError('Invalid observation identifier')
        const prior = updates.get(item.id)?.value || previous?.observations.get(item.id)
        if (prior?.status && prior.status !== 'running' && item.status === 'running') throw new Error('A finalized observation cannot resume')
        const merged = { ...prior, ...item, metadata: { ...prior?.metadata, ...item.metadata } }
        const bytes = Buffer.byteLength(JSON.stringify(merged)) + 16
        observationBytes += bytes - (updates.get(item.id)?.bytes || previous?.sizes.get(item.id) || 0)
        updates.set(item.id, { value: merged, bytes })
        if (pendingBytes + inflightBytes - (previous?.bytes || 0) + observationBytes > 16 * 1024 * 1024) throw Object.assign(new Error('Elune pending content limit exceeded; write was not queued'), { unresolved: true })
      }
      const merged = { ...previous?.trace, ...header, metadata: { ...previous?.trace.metadata, ...header.metadata } }
      const headerBytes = Buffer.byteLength(JSON.stringify(merged)) + 64
      const bytes = headerBytes + observationBytes
      if (pendingBytes + inflightBytes - (previous?.bytes || 0) + bytes > 16 * 1024 * 1024) throw Object.assign(new Error('Elune pending content limit exceeded; write was not queued'), { unresolved: true })
      const changes = previous?.observations || new Map()
      const sizes = previous?.sizes || new Map()
      for (const [id, update] of updates) { changes.set(id, update.value); sizes.set(id, update.bytes) }
      const item = { ...previous, trace: merged, observations: changes, sizes, bytes, headerBytes, version }
      if (!previous) item.promise = new Promise((resolveWrite, reject) => { item.resolve = resolveWrite; item.reject = reject })
      pending.set(header.id, item)
      pendingBytes += bytes - (previous?.bytes || 0)
      if (!scheduled && !draining) scheduled = setImmediate(pump)
      return item.promise
    } catch (error) {
      writeFailure(trace?.id || 'invalid-write', error, version, header || { id: trace?.id })
      report(error)
      return Promise.reject(error)
    }
  }

  async function flush() {
    if (scheduled) clearImmediate(scheduled)
    scheduled = undefined
    while (pending.size || draining) {
      if (failed) throw failed
      pump()
      await draining
    }
    if (failed) throw failed
    if (durabilityErrors.size) throw new AggregateError([...durabilityErrors.values()].map(item => item.error), 'Elune writes failed to commit')
  }

  async function readable(operation, value) {
    if (closing || closed) throw new Error('Elune store is closing')
    if (operation === 'list') {
      if (value !== undefined && (!value || typeof value !== 'object')) throw new TypeError('List options must be an object')
      const options = {}
      for (const key of ['sessionId', 'cwd', 'q', 'status', 'page', 'limit']) if (Object.hasOwn(value || {}, key) && value[key] !== undefined) {
        if (key === 'page' || key === 'limit') {
          if (!Number.isSafeInteger(value[key]) || value[key] < 1) throw new TypeError('Page and limit must be positive integers')
        } else if (typeof value[key] !== 'string' || value[key].length > (key === 'q' ? 2048 : 4096)) throw new TypeError('Invalid list filter')
        options[key] = value[key]
      }
      value = options
    } else {
      const traceId = value.traceId
      if (typeof traceId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(traceId)) throw new TypeError('Invalid trace identifier')
      if (operation !== 'bookmark') {
        const allowed = operation === 'get' ? ['observationOffset', 'observationLimit', 'scoreOffset', 'scoreLimit'] : ['offset', 'limit']
        if (!value.options || typeof value.options !== 'object' || Array.isArray(value.options)) throw new TypeError('Read options must be an object')
        const options = {}
        for (const key of allowed) if (value.options[key] !== undefined) {
          if (!Number.isSafeInteger(value.options[key]) || value.options[key] < (key.toLowerCase().endsWith('offset') ? 0 : 1)) throw new TypeError('Invalid read pagination')
          options[key] = value.options[key]
        }
        value = { traceId, options }
      }
    }
    try { await flush() } catch (error) { if (failed) throw error }
    if (closing || closed) throw new Error('Elune store is closing')
    return request(operation, value)
  }

  function close() {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      let timeout
      try {
        await Promise.race([
          (async () => { await flush(); if (worker && !failed) await request('close') })(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Elune close timed out')), 12000) }),
        ])
      } catch (error) {
        failure(error)
        throw error
      } finally {
        clearTimeout(timeout)
        closed = true
        listeners.clear()
        for (const request of requests.values()) {
          clearTimeout(request.timer)
          request.reject(new Error('Elune store is closed'))
        }
        requests.clear()
        if (worker) await worker.terminate()
      }
    })()
    return closePromise
  }

  return {
    list: options => readable('list', options),
    get: (traceId, options = {}) => readable('get', { traceId, options }),
    observations: (traceId, options = {}) => readable('observations', { traceId, options }),
    scores: (traceId, options = {}) => readable('scores', { traceId, options }),
    setBookmarked: async (traceId, bookmarked) => (await readable('bookmark', { traceId, bookmarked })).trace,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A listener is required')
      if (closed || closing) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    writeTrace,
    flush,
    close,
  }
}
