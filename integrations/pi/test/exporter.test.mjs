import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import test from 'node:test'
import { TraceExporter } from '../exporter.ts'

async function until(check, message) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await pause(10)
  }
  assert.fail(message)
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return server.address().port
}

async function stop(server) {
  server.closeAllConnections()
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function fixture(t, respond = (_, response) => response.end('{}')) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-trace-exporter-'))
  const received = []
  const reports = []
  const exporters = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    received.push({ method: request.method, path: request.url, payload })
    respond(payload, response)
  })
  const port = await listen(server)
  const url = `http://127.0.0.1:${port}`
  t.after(async () => {
    await stop(server)
    for (const exporter of exporters) await exporter.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    server, port, received, reports, directory,
    async exporter() {
      const exporter = new TraceExporter(url, directory, state => reports.push(state))
      exporters.push(exporter)
      await exporter.start()
      return exporter
    },
    async files() {
      const namespaces = await readdir(directory)
      const files = await Promise.all(namespaces.map(async namespace => {
        const folder = join(directory, namespace)
        return Promise.all((await readdir(folder)).filter(name => !name.endsWith('.tmp')).map(async name => {
          try {
            return { name, body: JSON.parse(await readFile(join(folder, name), 'utf8')) }
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }))
      }))
      return files.flat().filter(Boolean)
    },
  }
}

function trace(id, revision = 1) {
  return { id, revision, source: 'pi', name: 'coding-request', status: 'completed', output: `revision ${revision}` }
}

test('an offline trace survives close and replays from disk after restart', { timeout: 10000 }, async t => {
  const context = await fixture(t)
  await stop(context.server)
  const first = await context.exporter()
  const snapshot = trace('offline-trace')
  first.enqueue(snapshot)
  await first.close()
  assert.deepEqual(await context.files(), [{ name: 'offline-trace.1.json', body: { trace: snapshot } }])
  assert(context.reports.includes('Traces queued; backend unavailable'))

  await listen(context.server, context.port)
  const restarted = await context.exporter()
  await restarted.flush()
  assert.deepEqual(context.received, [{ method: 'POST', path: '/api/ingest', payload: { trace: snapshot } }])
  assert.deepEqual(await context.files(), [])
})

test('an old acknowledgement cannot remove a newer queued revision', { timeout: 10000 }, async t => {
  const responses = new Map()
  const context = await fixture(t, ({ trace }, response) => responses.set(trace.revision, response))
  const exporter = await context.exporter()
  exporter.enqueue(trace('changing-trace', 1))
  const firstFlush = exporter.flush()
  await until(() => responses.has(1), 'The receiver did not get the first revision')

  exporter.enqueue(trace('changing-trace', 2))
  exporter.enqueue(trace('changing-trace', 3))
  await until(async () => (await context.files()).some(file => file.body.trace.revision === 3), 'The latest revision was not saved while delivery was in progress')
  responses.get(1).end('{}')
  await until(() => responses.has(3), 'The latest revision was not delivered after the first acknowledgement')
  assert.deepEqual(await context.files(), [{ name: 'changing-trace.3.json', body: { trace: trace('changing-trace', 3) } }])
  responses.get(3).end('{}')
  await firstFlush
  await exporter.flush()
  assert.deepEqual(context.received.map(request => request.payload.trace.revision), [1, 3])
  assert.deepEqual(await context.files(), [])
})

test('close delivers the final revision queued during an earlier request', { timeout: 10000 }, async t => {
  let firstResponse
  const context = await fixture(t, ({ trace }, response) => {
    if (trace.revision === 1) firstResponse = response
    else response.end('{}')
  })
  const exporter = await context.exporter()
  exporter.enqueue(trace('closing-trace', 1))
  await until(() => firstResponse, 'The receiver did not get the first revision')
  exporter.enqueue(trace('closing-trace', 2))
  const closing = exporter.close()
  await until(async () => (await context.files()).some(file => file.body.trace.revision === 2), 'The final revision was not saved')
  firstResponse.end('{}')
  await closing
  assert.deepEqual(context.received.map(request => request.payload.trace.revision), [1, 2])
  assert.deepEqual(await context.files(), [])
})

test('temporary failures retry in the background while new traces are saved', { timeout: 10000 }, async t => {
  let requests = 0
  const context = await fixture(t, (_, response) => {
    response.statusCode = ++requests === 1 ? 503 : 200
    response.end('{}')
  })
  const exporter = await context.exporter()
  assert.equal(exporter.enqueue(trace('retry-trace')), undefined)
  await until(() => context.reports.includes('Traces queued; backend unavailable'), 'The temporary failure was not reported')
  assert.equal(exporter.enqueue(trace('next-trace')), undefined)
  await until(async () => (await context.files()).length === 2, 'New traces were not saved during retry backoff')
  assert.equal(context.received.length, 1)

  await until(async () => context.received.length === 3 && (await context.files()).length === 0, 'Queued traces did not retry without an explicit flush')
  assert.deepEqual(context.received.map(request => request.payload.trace.id), ['retry-trace', 'retry-trace', 'next-trace'])
  assert.equal(context.reports.at(-1), '')
})

test('another exporter cannot delete a newer revision while replaying the same trace', { timeout: 10000 }, async t => {
  const responses = []
  const context = await fixture(t, ({ trace }, response) => responses.push({ revision: trace.revision, response }))
  const first = await context.exporter()
  first.enqueue(trace('shared-trace', 1))
  await until(() => responses.length === 1, 'The first exporter did not send revision 1')
  const second = await context.exporter()
  await until(() => responses.length === 2, 'The second exporter did not replay revision 1')
  first.enqueue(trace('shared-trace', 2))
  await until(async () => (await context.files()).some(file => file.body.trace.revision === 2), 'Revision 2 was not saved')

  responses[1].response.end('{}')
  await second.close()
  assert.deepEqual(await context.files(), [{ name: 'shared-trace.2.json', body: { trace: trace('shared-trace', 2) } }])
  responses[0].response.end('{}')
  await until(() => responses.length === 3, 'The first exporter did not send revision 2')
  assert.equal(responses[2].revision, 2)
  responses[2].response.end('{}')
  await first.close()
  assert.deepEqual(await context.files(), [])
})

test('concurrent startup replays the highest saved revision and removes obsolete snapshots', { timeout: 10000 }, async t => {
  const responses = []
  const context = await fixture(t, ({ trace }, response) => responses.push({ revision: trace.revision, response }))
  const setup = await context.exporter()
  await setup.close()
  const namespace = (await readdir(context.directory))[0]
  const folder = join(context.directory, namespace)
  for (const revision of [1, 9, 10]) {
    await writeFile(join(folder, `saved-trace.${revision}.json`), JSON.stringify({ trace: trace('saved-trace', revision) }))
  }
  const exporters = await Promise.all([context.exporter(), context.exporter()])
  assert.deepEqual(await context.files(), [{ name: 'saved-trace.10.json', body: { trace: trace('saved-trace', 10) } }])
  await until(() => responses.length === 2, 'Both exporters did not replay the saved trace')
  assert.deepEqual(responses.map(item => item.revision), [10, 10])
  for (const { response } of responses) response.end('{}')
  await Promise.all(exporters.map(exporter => exporter.close()))
  assert.deepEqual(await context.files(), [])
})

test('permanent rejection preserves the payload and does not prevent other delivery', { timeout: 10000 }, async t => {
  const context = await fixture(t, ({ trace }, response) => {
    response.statusCode = trace.id === 'invalid-trace' ? 400 : 200
    response.end('{}')
  })
  const first = await context.exporter()
  const rejected = trace('invalid-trace')
  first.enqueue(rejected)
  first.enqueue(trace('valid-trace'))
  await first.close()
  assert.deepEqual(context.received.map(request => request.payload.trace.id), ['invalid-trace', 'valid-trace'])
  assert.deepEqual(await context.files(), [{ name: 'invalid-trace.1.rejected', body: { trace: rejected } }])
  assert(context.reports.includes('Trace rejected (400); kept in local queue'))

  const restarted = await context.exporter()
  await restarted.flush()
  assert.equal(context.received.length, 2)
  assert.deepEqual(await context.files(), [{ name: 'invalid-trace.1.rejected', body: { trace: rejected } }])
})
