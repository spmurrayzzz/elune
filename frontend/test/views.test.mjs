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

async function render(route, responses, values = {}) {
  location.hash = `#${route}`
  const requests = []
  const fetch = globalThis.fetch
  globalThis.fetch = async path => {
    const url = new URL(path,'http://localhost')
    requests.push(url)
    if (url.pathname === '/api/filters') return {ok:true,json:async () => ({totalTraces:100,scopeTotal:21,sourceCounts:{pi:21,sample:0},environments:[],names:[],levels:[],scoreNames:[],histogram:[]})}
    assert.ok(url.pathname in responses, `Unexpected request: ${url.pathname}`)
    return {ok:true,json:async () => responses[url.pathname]}
  }
  try {
    const html = await renderToString(createSSRApp({ ...App, async setup(props, context) {
      const state = App.setup(props, context)
      for (const [key, value] of Object.entries({ dateRange:'1', ...values })) state[key].value = value
      await state.load()
      assert.equal(state.error.value,'')
      return state
    } }))
    return {html,requests}
  } finally { globalThis.fetch = fetch }
}

function tableBody(html) {
  return html.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/)?.[1] || ''
}

test('recent scores use the server page and send date, source, and environment filters', async () => {
  const {html,requests} = await render('/scores', {
    '/api/scores':{data:[score('recent-score-old-trace','old')],total:21,page:2,pageSize:20},
  }, {environment:'local',source:'pi',scoreSource:'ANNOTATION',scoreName:'quality',page:2})
  assert.match(tableBody(html), /recent-score-old-trace/)
  assert.match(html, /21–21 of 21 scores/)
  const params = requests.find(url => url.pathname === '/api/scores').searchParams
  assert.equal(params.get('page'),'2')
  assert.equal(params.get('pageSize'),'20')
  assert.equal(params.get('source'),'pi')
  assert.equal(params.get('environment'),'local')
  assert.equal(params.get('scoreSource'),'ANNOTATION')
  assert.equal(params.get('scoreName'),'quality')
  assert.equal(Date.parse(params.get('to'))-Date.parse(params.get('from')),86400000)
  assert.ok(requests.every(url => url.pathname !== '/api/traces'))
})

test('session list and conversation use scoped server totals and a separate detail request', async () => {
  const session = {id:'session-1',userId:'user-1',environment:'local',startTime:timestamp(3),endTime:new Date(now-3600000+2000).toISOString(),traceCount:2,totalTokens:30,cost:0.003}
  const responses = {
    '/api/sessions':{data:[session],total:1,page:1,pageSize:20},
    '/api/sessions/session-1':{session,traces:[trace('first',{timestamp:timestamp(3)}),trace('second',{totalTokens:20,cost:0.002})]},
  }
  const {html:detail,requests} = await render('/sessions/session-1',responses,{environment:'local',source:'pi'})
  assert.match(detail, /<b>2<\/b> traces/)
  assert.match(detail, /<b>30<\/b> tokens/)
  assert.match(detail, /<b>\$0\.0030<\/b> total cost/)
  assert.match(detail, /input-first/)
  assert.match(detail, /input-second/)
  const detailURL = requests.find(url => url.pathname === '/api/sessions/session-1')
  assert.equal(detailURL.searchParams.get('source'),'pi')
  assert.equal(detailURL.searchParams.get('environment'),'local')
  assert.ok(detailURL.searchParams.has('from'))
  const body = tableBody((await render('/sessions',responses)).html)
  assert.match(body, /count-badge[^>]*>2<\/span>/)
  assert.match(body, />7202\.00s<\/td>/)
  assert.match(body, />30<\/td>/)
  assert.match(body, />\$0\.0030<\/td>/)
})

test('model calls use server aggregates without loading all traces', async () => {
  const {html,requests} = await render('/overview', {'/api/overview':{
    totalTraces:5,totalTokens:50,models:[{name:'model-a',tokens:30,count:3,cost:0.003},{name:'legacy-model',tokens:10,count:1,cost:0.001},{name:'Unknown',tokens:10,count:1,cost:0.001}],series:[],recentTraces:[],
  }})
  const modelList = html.match(/class="model-list"[\s\S]*?class="model-total"/)?.[0] || ''
  assert.match(modelList, /model-a[\s\S]*?3 calls/)
  assert.match(modelList, /legacy-model[\s\S]*?1 calls/)
  assert.match(modelList, /Unknown[\s\S]*?1 calls/)
  assert.ok(requests.every(url => url.pathname !== '/api/traces'))
})

test('recent trace status uses execution state and falls back to sample level', async () => {
  const body = tableBody((await render('/overview', {'/api/overview':{recentTraces:[
    trace('running',{status:'running'}),
    trace('aborted',{status:'aborted',level:'WARNING'}),
    trace('completed',{status:'completed',level:'WARNING'}),
    trace('error',{status:'error'}),
    trace('sample-warning',{source:'sample',status:undefined,level:'WARNING'}),
  ]}})).html)
  for (const [status, label] of [['running','Running'],['aborted','Aborted'],['completed','Completed'],['error','Error'],['warning','Warning']]) {
    assert.match(body, new RegExp(`class="(?:status ${status}|${status} status)"[^>]*><span[^>]*><\/span>${label}<\/span>`))
  }
})
