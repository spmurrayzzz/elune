import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'

const now = Date.parse('2026-09-28T12:00:00Z')
const timestamp = hoursAgo => new Date(now - hoursAgo * 3600000).toISOString()
let server
let App

before(async () => {
  globalThis.location = { hash: '' }
  globalThis.localStorage = { getItem: () => null, setItem: () => {} }
  globalThis.document = { documentElement: { dataset: {} } }
  server = await createServer({ server: { middlewareMode: true, watch: null }, appType: 'custom' })
  App = (await server.ssrLoadModule('/src/App.vue')).default
})

after(async () => {
  await server?.close()
  delete globalThis.location
  delete globalThis.localStorage
  delete globalThis.document
})

function trace(id, values = {}) {
  return { id, name:id, timestamp:timestamp(1), sessionId:'session-1', userId:'user-1', environment:'local', source:'pi', status:'completed', level:'DEFAULT', input:`input-${id}`, output:`output-${id}`, model:'model-a', latency:2, totalTokens:10, cost:0.001, tags:[], scores:[], observations:[], ...values }
}

function score(id, traceId, values = {}) {
  return { id, traceId, traceName:traceId, timestamp:timestamp(1), name:id, source:'ANNOTATION', value:1, comment:'', ...values }
}

async function render(route, values) {
  location.hash = `#${route}`
  return renderToString(createSSRApp({ ...App, setup(props, context) {
    const state = App.setup(props, context)
    for (const [key, value] of Object.entries({ now, loading:false, dateRange:'1', ...values })) state[key].value = value
    return state
  } }))
}

function tableBody(html) {
  return html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1] || ''
}

test('recent scores use their own date and the trace source and environment', async () => {
  const html = await render('/scores', {
    environment:'local', source:'pi',
    traces:[trace('old',{timestamp:timestamp(48)}), trace('recent'), trace('other-env',{environment:'production'}), trace('sample',{source:'sample'})],
    scores:[score('recent-score-old-trace','old'), score('old-score','recent',{timestamp:timestamp(48)}), score('other-env-score','other-env'), score('sample-score','sample')],
  })
  const body = tableBody(html)
  assert.match(body, /recent-score-old-trace/)
  assert.doesNotMatch(body, /old-score|other-env-score|sample-score/)
})

test('session list and conversation totals use the same filtered traces', async () => {
  const values = {
    environment:'local', source:'pi',
    traces:[trace('first',{timestamp:timestamp(3)}), trace('second',{totalTokens:20,cost:0.002}), trace('old',{timestamp:timestamp(48),totalTokens:100}), trace('other-env',{environment:'production',totalTokens:200}), trace('sample',{source:'sample',totalTokens:300})],
  }
  const detail = await render('/sessions/session-1', values)
  assert.match(detail, /<b>2<\/b> traces/)
  assert.match(detail, /<b>30<\/b> tokens/)
  assert.match(detail, /<b>\$0\.0030<\/b> total cost/)
  assert.match(detail, /input-first/)
  assert.match(detail, /input-second/)
  assert.doesNotMatch(detail, /input-old|input-other-env|input-sample/)
  const body = tableBody(await render('/sessions', values))
  assert.match(body, /count-badge[^>]*>2<\/span>/)
  assert.match(body, />7202\.00s<\/td>/)
  assert.match(body, />30<\/td>/)
  assert.match(body, />\$0\.0030<\/td>/)
})

test('model calls include sample and Pi generations and preserve legacy samples', async () => {
  const generation = {type:'GENERATION',model:'model-a',inputTokens:6,outputTokens:4,cost:0.001}
  const html = await render('/overview', {traces:[
    trace('sample',{source:'sample',observations:[generation,generation]}),
    trace('pi',{observations:[generation]}),
    trace('legacy',{source:'sample',model:'legacy-model'}),
    trace('tools-only',{source:'sample',model:'unused-model',observations:[{type:'TOOL',model:'unused-model'}]}),
    trace('unknown',{observations:[{...generation,model:''}]}),
  ]})
  const modelList = html.match(/class="model-list"[\s\S]*?class="model-total"/)?.[0] || ''
  assert.match(modelList, /model-a[\s\S]*?3 calls/)
  assert.match(modelList, /legacy-model[\s\S]*?1 calls/)
  assert.match(modelList, /Unknown[\s\S]*?1 calls/)
  assert.doesNotMatch(modelList, /unused-model/)
})

test('recent trace status uses execution state and falls back to sample level', async () => {
  const body = tableBody(await render('/overview', {traces:[
    trace('running',{status:'running'}),
    trace('aborted',{status:'aborted',level:'WARNING'}),
    trace('completed',{status:'completed',level:'WARNING'}),
    trace('error',{status:'error'}),
    trace('sample-warning',{source:'sample',status:undefined,level:'WARNING'}),
  ]}))
  for (const [status, label] of [['running','Running'],['aborted','Aborted'],['completed','Completed'],['error','Error'],['warning','Warning']]) {
    assert.match(body, new RegExp(`class="(?:status ${status}|${status} status)"[^>]*><span[^>]*><\\/span>${label}<\\/span>`))
  }
})
