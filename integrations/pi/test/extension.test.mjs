import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import test from 'node:test'
import extension from '../index.ts'

const usage = { input: 10, output: 3, cacheRead: 5, cacheWrite: 2, totalTokens: 20, cost: { input: 0.01, output: 0.03, cacheRead: 0.005, cacheWrite: 0.002, total: 0.047 } }
const assistant = (stopReason = 'stop', responseUsage = usage) => ({ role: 'assistant', content: [{ type: 'text', text: 'Done' }], model: 'test-model', provider: 'test-provider', usage: responseUsage, stopReason })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-elune-extension-'))
  const received = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    received.push(JSON.parse(Buffer.concat(chunks).toString()).trace)
    response.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const previous = { PI_TRACE_URL: process.env.PI_TRACE_URL, PI_TRACE_QUEUE_DIR: process.env.PI_TRACE_QUEUE_DIR }
  process.env.PI_TRACE_URL = `http://127.0.0.1:${server.address().port}`
  process.env.PI_TRACE_QUEUE_DIR = directory
  const handlers = new Map()
  extension({ on: (name, handler) => handlers.set(name, handler) })
  const ctx = {
    cwd: directory,
    model: { id: 'test-model', provider: 'test-provider' },
    sessionManager: { getSessionDir: () => directory, getSessionId: () => 'test-session', getSessionName: () => 'Test session' },
    ui: { setStatus() {}, notify(message) { assert.fail(message) } },
    getSystemPrompt: () => 'Test system prompt',
  }
  const emit = async (type, event = {}) => handlers.get(type)?.({ type, ...event }, ctx)
  t.after(async () => {
    await emit('session_shutdown')
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  await emit('session_start')
  return {
    emit,
    traces: () => [...new Map(received.map(trace => [trace.id, trace])).values()],
    async received(check) {
      const deadline = Date.now() + 3000
      while (!check(received) && Date.now() < deadline) await pause(10)
      assert(check(received), 'Expected trace was not exported')
      return received
    },
    async turn(message = assistant(), prompt) {
      if (prompt !== undefined) await emit('before_agent_start', { prompt })
      await emit('agent_start')
      await emit('turn_start', { turnIndex: 0, timestamp: Date.now() })
      await emit('message_start', { message: { role: prompt === undefined ? 'custom' : 'user', customType: 'test-trigger', content: [{ type: 'text', text: prompt || 'Extension request' }] } })
      await emit('context', { messages: [{ role: 'user', content: 'Request' }] })
      await emit('before_provider_request', { payload: { input: 'Provider request' } })
      await emit('message_end', { message })
      await emit('turn_end', { message, toolResults: [] })
    },
  }
}

test('an extension-triggered run gets its own trace and cannot change the previous trace', async t => {
  const run = await fixture(t)
  await run.turn(assistant(), 'User request')
  await run.emit('agent_settled')
  await run.received(traces => traces.some(trace => trace.status === 'completed'))
  const first = structuredClone(run.traces()[0])

  await run.turn()
  await run.emit('agent_settled')
  await run.emit('context', { messages: [{ role: 'custom', content: 'Unrelated context' }] })
  await run.emit('before_provider_request', { payload: { unrelated: true } })
  await run.emit('turn_end')
  await run.emit('session_shutdown')

  const traces = run.traces()
  assert.equal(traces.length, 2)
  assert.deepEqual(traces[0], first)
  assert.equal(traces[1].input, 'Extension request')
  assert.equal(traces[1].status, 'completed')
  assert.equal(traces[1].totalTokens, usage.totalTokens)
  assert.equal(traces[1].metadata.attempts, 1)
  assert.equal(traces[1].sessionId, first.sessionId)
  assert.deepEqual(JSON.parse(traces[1].observations.find(item => item.type === 'GENERATION').input), { input: 'Provider request' })
})

test('automatic compaction and retries stay in the run with exact usage and no duplicate summary charge', async t => {
  const run = await fixture(t)
  const compactUsage = { input: 50, output: 7, cacheRead: 11, cacheWrite: 13, totalTokens: 81, cost: { input: 0.05, output: 0.07, cacheRead: 0.011, cacheWrite: 0.013, total: 0.144 } }
  await run.turn(assistant('error'), 'Long request')
  await run.emit('agent_end', { messages: [assistant('error')] })
  await run.emit('session_before_compact', { reason: 'overflow', willRetry: true, preparation: { messagesToSummarize: [{ role: 'user', content: 'Long request' }], turnPrefixMessages: [] } })
  await run.emit('before_provider_request', { payload: { input: 'Compaction request' } })
  await pause(10)
  const compact = { reason: 'overflow', willRetry: true, fromExtension: false, compactionEntry: { id: 'summary-one', summary: 'Short summary', tokensBefore: 1000, usage: compactUsage } }
  await run.emit('session_compact', compact)
  await run.emit('session_compact', compact)
  await run.turn()
  await run.emit('agent_settled')
  await run.emit('session_shutdown')

  const [trace] = run.traces()
  assert.equal(run.traces().length, 1)
  assert.equal(trace.status, 'completed')
  assert.equal(trace.level, 'WARNING')
  assert.equal(trace.metadata.attempts, 2)
  const generations = trace.observations.filter(item => item.type === 'GENERATION')
  assert.equal(generations.length, 3)
  assert.equal(generations[0].status, 'error')
  assert.deepEqual(JSON.parse(generations[0].input), { input: 'Provider request' })
  const summary = generations.find(item => item.metadata.compactionId === 'summary-one')
  assert(summary)
  assert.equal(summary.name, 'Context compaction')
  assert.equal(summary.parentId, trace.observations[0].id)
  assert.equal(summary.output, compact.compactionEntry.summary)
  assert.equal(summary.status, 'completed')
  assert(summary.duration > 0)
  assert.equal(summary.metadata.reason, 'overflow')
  assert.equal(summary.metadata.willRetry, true)
  assert.deepEqual(summary.metadata.usage, compactUsage)
  assert.equal(trace.inputTokens, 2 * (usage.input + usage.cacheRead + usage.cacheWrite) + compactUsage.input + compactUsage.cacheRead + compactUsage.cacheWrite)
  assert.equal(trace.outputTokens, 2 * usage.output + compactUsage.output)
  assert.equal(trace.totalTokens, 2 * usage.totalTokens + compactUsage.totalTokens)
  assert.equal(trace.cost, 2 * usage.cost.total + compactUsage.cost.total)
  assert.equal(trace.metadata.cacheReadTokens, 2 * usage.cacheRead + compactUsage.cacheRead)
  assert.equal(trace.metadata.cacheWriteTokens, 2 * usage.cacheWrite + compactUsage.cacheWrite)
  assert.equal(trace.output, 'Done')
})

for (const reason of ['manual', 'threshold']) {
  test(`${reason} compaction while idle has a separate trace and keeps the prior run unchanged`, async t => {
    const run = await fixture(t)
    await run.turn(assistant(), 'Previous request')
    await run.emit('agent_settled')
    await run.received(traces => traces.some(trace => trace.status === 'completed'))
    const first = structuredClone(run.traces()[0])
    await run.emit('session_before_compact', { reason, willRetry: false, preparation: { messagesToSummarize: [{ role: 'user', content: 'Previous request' }], turnPrefixMessages: [] } })
    await pause(10)
    await run.emit('session_compact', { reason, willRetry: false, fromExtension: false, compactionEntry: { id: 'idle-summary', summary: 'Idle summary', tokensBefore: 1000, usage } })
    await run.emit('session_shutdown')

    const traces = run.traces()
    assert.equal(traces.length, 2)
    assert.deepEqual(traces[0], first)
    assert.equal(traces[1].name, 'pi-compaction')
    assert.equal(traces[1].status, 'completed')
    assert.equal(traces[1].totalTokens, usage.totalTokens)
    assert.equal(traces[1].cost, usage.cost.total)
    assert.equal(traces[1].output, 'Idle summary')
    assert.equal(traces[1].observations[0].startTime, 0)
    assert(traces[1].observations[1].duration > 0)
    assert(traces[1].observations[1].duration <= traces[1].latency)
    assert.equal(traces[1].sessionId, first.sessionId)
  })
}

test('a canceled compaction records no model usage and preserves an aborted run', async t => {
  const run = await fixture(t)
  await run.turn(assistant('aborted'), 'Interrupted request')
  await run.emit('session_before_compact', { reason: 'threshold', willRetry: false, preparation: { messagesToSummarize: [], turnPrefixMessages: [] } })
  await run.emit('agent_settled')
  await run.turn(assistant(), 'Next request')
  await run.emit('session_before_compact', { reason: 'threshold', willRetry: false, preparation: { messagesToSummarize: [], turnPrefixMessages: [] } })
  await run.emit('session_compact', { reason: 'threshold', willRetry: false, fromExtension: true, compactionEntry: { id: 'extension-summary', summary: 'Local summary', tokensBefore: 1000 } })
  await run.emit('agent_settled')
  await run.emit('session_shutdown')

  const traces = run.traces()
  assert.equal(traces.length, 2)
  assert.equal(traces[0].status, 'aborted')
  assert.equal(traces[0].observations.filter(item => item.type === 'GENERATION').length, 1)
  assert.equal(traces[1].totalTokens, usage.totalTokens)
  assert.equal(traces[1].cost, usage.cost.total)
  const summary = traces[1].observations.find(item => item.metadata.compactionId)
  assert.equal(summary.type, 'SPAN')
  assert.equal(summary.model, '')
  assert.equal(summary.metadata.fromExtension, true)
  assert.equal(summary.status, 'completed')
})
