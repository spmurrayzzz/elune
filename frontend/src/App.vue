<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Activity, ArrowDown, ArrowDownUp, ArrowLeft, ArrowUpRight, BarChart3, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns3, Download, ExternalLink, Filter, Folder, Info, Layers, ListFilter, MessageSquare, Moon, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, SlidersHorizontal, Star, Sun, Table2, Users, X, Zap } from 'lucide-vue-next'
import TraceDetail from './components/TraceDetail.vue'
import Overview from './components/Overview.vue'

const currentRows = ref([])
const totalRows = ref(0)
const selectedTrace = ref(null)
const selectedSession = ref(null)
const sessionTraces = ref([])
const overview = ref({})
const facets = ref({totalTraces:0,scopeTotal:0,sourceCounts:{pi:0,sample:0},environments:[],names:[],levels:[],scoreNames:[],histogram:[]})
const exporting = ref(false)
const loading = ref(true)
const refreshing = ref(false)
const liveState = ref('connecting')
const error = ref('')
const route = ref(location.hash.slice(1) || '/traces')
const query = ref('')
const environment = ref('all')
const source = ref('all')
const dateRange = ref('7')
const level = ref('all')
const names = ref([])
const preset = ref('all')
const showFilters = ref(true)
const showChart = ref(true)
const menu = ref('')
const page = ref(1)
const pageSize = ref(20)
const sortKey = ref('timestamp')
const sortDirection = ref(-1)
const sidebarCollapsed = ref(false)
const selectedRows = ref([])
const columns = ref(['timestamp', 'name', 'input', 'latency', 'tokens', 'cost', 'environment', 'scores'])
const theme = ref(localStorage.getItem('elune-theme') || 'dark')
const toast = ref('')
const scoreSource = ref('all')
const scoreName = ref('all')
let toastTimer
let refreshTimer
let requestController
let requestVersion = 0
let mounted = false
let liveEvents
let disposed = false
const labels = { overview: 'Overview', traces: 'Tracing', sessions: 'Sessions', scores: 'Scores' }
const columnOptions = [{id:'timestamp',label:'Timestamp'},{id:'name',label:'Name'},{id:'input',label:'Input'},{id:'output',label:'Output'},{id:'latency',label:'Latency'},{id:'tokens',label:'Tokens'},{id:'cost',label:'Total cost'},{id:'environment',label:'Environment'},{id:'scores',label:'Scores'},{id:'user',label:'User ID'},{id:'tags',label:'Tags'}]
const parts = computed(() => route.value.split('/').filter(Boolean))
const view = computed(() => labels[parts.value[0]] ? parts.value[0] : 'traces')
const now = ref(Date.now())
const dateCutoff = computed(() => now.value - Number(dateRange.value) * 86400000)
const environments = computed(() => facets.value.environments.map(item => item.name))
const traceNames = computed(() => facets.value.names.map(item => item.name))
const scoreNames = computed(() => facets.value.scoreNames)
const dataLabel = computed(() => {
  if (source.value !== 'all') return source.value === 'pi' ? 'Live Pi' : 'Sample data'
  const {pi, sample} = facets.value.sourceCounts
  return pi && sample ? 'Live Pi + sample data' : pi ? 'Live Pi' : sample ? 'Sample data' : 'Local traces'
})
const totalPages = computed(() => Math.max(1, Math.ceil(totalRows.value / pageSize.value)))
const pageRows = computed(() => currentRows.value)
const allSelected = computed(() => pageRows.value.length > 0 && pageRows.value.every(t => selectedRows.value.includes(t.id)))
const filtersActive = computed(() => names.value.length + (level.value !== 'all' ? 1 : 0) + (environment.value !== 'all' ? 1 : 0) + (source.value !== 'all' ? 1 : 0))
const histogram = computed(() => {
  const bins = facets.value.histogram
  const max = Math.max(1, ...bins.map(bin => bin.count))
  return bins.map(bin => ({...bin,height:bin.count / max * 100}))
})
const chartLabels = computed(() => [dateCutoff.value, dateCutoff.value + Number(dateRange.value)*43200000, now.value].map(d=>new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric'})))

function go(path) { location.hash = path; menu.value = '' }
function inspect(trace) { go(`/traces/${trace.id}`) }
function notify(message) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(()=>toast.value='',3200) }
async function api(path, options) {
  const response = await fetch(`/api${path}`,options)
  if(!response.ok) { const result = await response.json().catch(()=>({})); throw Object.assign(new Error(result.error || `Request failed (${response.status})`),{status:response.status}) }
  return response.json()
}
function requestParams(kind, includeSearch = true) {
  const params = new URLSearchParams({from:new Date(dateCutoff.value).toISOString(),to:new Date(now.value).toISOString()})
  if (source.value !== 'all') params.set('source',source.value)
  if (environment.value !== 'all') params.set('environment',environment.value)
  if (includeSearch && query.value.trim()) params.set('q',query.value.trim())
  if (kind === 'traces') {
    if (level.value !== 'all') params.set('level',level.value)
    for (const name of names.value) params.append('names',name)
    if (preset.value !== 'all') params.set('preset',preset.value)
    params.set('sort',sortKey.value)
    params.set('order',sortDirection.value === 1 ? 'asc' : 'desc')
  }
  if (kind === 'scores') {
    if (scoreSource.value !== 'all') params.set('scoreSource',scoreSource.value)
    if (scoreName.value !== 'all') params.set('scoreName',scoreName.value)
  }
  return params
}
async function load() {
  clearTimeout(refreshTimer); refreshTimer = null
  requestController?.abort()
  const controller = new AbortController()
  requestController = controller
  const version = ++requestVersion
  const kind = view.value
  const id = parts.value[1]
  refreshing.value = true
  now.value = Date.now()
  const params = requestParams(kind,kind !== 'overview')
  params.set('page',page.value)
  params.set('pageSize',pageSize.value)
  const filters = requestParams(kind === 'traces' ? 'traces' : '',kind === 'traces')
  const options = {signal:controller.signal}
  try {
    const [result, counts, detail] = await Promise.all([
      api(`/${kind}?${params}`,options),
      api(`/filters?${filters}`,options),
      id && kind === 'traces' ? api(`/traces/${encodeURIComponent(id)}`,options) : id && kind === 'sessions' ? api(`/sessions/${encodeURIComponent(id)}?${requestParams('',false)}`,options).catch(e => { if (e.status === 404) return null; throw e }) : null
    ])
    if (disposed || version !== requestVersion) return
    facets.value = counts
    if (kind === 'overview') overview.value = result
    else {
      currentRows.value = result.data
      totalRows.value = result.total
      const lastPage = Math.max(1,Math.ceil(result.total / pageSize.value))
      if (page.value > lastPage) page.value = lastPage
    }
    selectedTrace.value = kind === 'traces' ? detail : null
    selectedSession.value = kind === 'sessions' ? detail?.session || null : null
    sessionTraces.value = kind === 'sessions' ? detail?.traces || [] : []
    error.value = ''
  } catch(e) {
    if (version === requestVersion && e.name !== 'AbortError') {
      error.value = e.message
      selectedTrace.value = null; selectedSession.value = null; sessionTraces.value = []
    }
  } finally {
    if (version === requestVersion) { loading.value = false; refreshing.value = false }
  }
}
function scheduleRefresh(delay = 500) {
  if (refreshTimer || disposed) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    if (refreshing.value && !requestController?.signal.aborted) scheduleRefresh()
    else load()
  }, typeof delay === 'number' ? delay : 500)
}
function reloadView() {
  requestVersion++
  requestController?.abort()
  if (mounted) { clearTimeout(refreshTimer); refreshTimer = null; scheduleRefresh(150) }
}
function connectLive() {
  liveEvents = new EventSource('/api/events')
  liveEvents.onopen = () => { liveState.value = 'connected'; scheduleRefresh() }
  liveEvents.onerror = () => { liveState.value = 'reconnecting' }
  liveEvents.addEventListener('traces', scheduleRefresh)
}
async function bookmark(trace) {
  try {
    const updated = await api(`/traces/${encodeURIComponent(trace.id)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({bookmarked:!trace.bookmarked})})
    if (selectedTrace.value?.id === updated.id) selectedTrace.value = updated
    await load()
    notify(updated.bookmarked ? 'Trace bookmarked' : 'Bookmark removed')
  } catch(e) { notify(e.message) }
}
async function scored() { await load(); notify('Score saved') }
function resetFilters() { query.value=''; environment.value='all'; source.value='all'; level.value='all'; names.value=[]; preset.value='all'; scoreName.value='all'; scoreSource.value='all' }
function sort(key) { if(sortKey.value === key) sortDirection.value *= -1; else { sortKey.value=key; sortDirection.value=-1 } }
function toggleAll() { if(allSelected.value) selectedRows.value = selectedRows.value.filter(id=>!pageRows.value.some(t=>t.id===id)); else selectedRows.value=[...new Set([...selectedRows.value,...pageRows.value.map(t=>t.id)])] }
function toggleColumn(id) { columns.value = columns.value.includes(id) ? columns.value.filter(c=>c!==id) : [...columns.value,id] }
function hasColumn(id) { return columns.value.includes(id) }
async function download() {
  if (exporting.value) return
  exporting.value = true
  const kind = view.value
  const selected = new Set(selectedRows.value)
  const params = requestParams(kind)
  params.set('pageSize',200)
  try {
    const data = []
    let exportPage = 1
    let result
    do {
      params.set('page',exportPage++)
      result = await api(`/${kind}?${params}`)
      data.push(...result.data.filter(row => !selected.size || selected.has(row.id)))
    } while ((result.page * result.pageSize) < result.total)
    const keys = kind === 'sessions' ? ['id','userId','startTime','traceCount','totalTokens','cost'] : kind === 'scores' ? ['name','value','source','traceId','comment','timestamp'] : ['id','name','timestamp','environment','userId','sessionId','latency','totalTokens','cost','level']
    const csv = [keys.join(','),...data.map(t=>keys.map(k=>`"${String(t[k] ?? '').replaceAll('"','""')}"`).join(','))].join('\n')
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}))
    const a = document.createElement('a'); a.href=url; a.download=`elune-${kind}.csv`; a.click(); URL.revokeObjectURL(url)
    notify(`Exported ${data.length} ${kind}`)
  } catch(e) { notify(e.message) }
  finally { exporting.value = false }
}
function facetCount(key, name) { return facets.value[key].find(item => item.name === name)?.count || 0 }
function date(value) { return new Date(value).toLocaleDateString('en-US',{month:'short',day:'2-digit'}) }
function time(value) { return new Date(value).toLocaleTimeString('en-US',{hour12:false}) }
function number(value) { return new Intl.NumberFormat('en-US').format(value || 0) }
function money(value) { return `$${Number(value || 0).toFixed(4)}` }
function duration(value) { return `${Number(value || 0).toFixed(2)}s` }
function traceStatus(trace) { return trace.status || (trace.level === 'ERROR' ? 'error' : trace.level === 'WARNING' ? 'warning' : 'completed') }
function statusLabel(trace) { return {running:'Running',completed:'Completed',error:'Error',aborted:'Aborted',warning:'Warning'}[traceStatus(trace)] }
function scoreColor(value) { return value >= .8 ? 'green' : value >= .5 ? 'amber' : 'red' }
function hashChanged() { route.value=location.hash.slice(1)||'/traces' }
function keydown(e) {
  if(e.key === 'Escape') menu.value=''
  if((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); document.querySelector('.search-input')?.focus() }
}
watch(theme, value=>{document.documentElement.dataset.theme=value;localStorage.setItem('elune-theme',value)},{immediate:true})
watch([query,environment,source,dateRange,level,names,preset,pageSize,scoreSource,scoreName,sortKey,sortDirection],()=>{page.value=1;selectedRows.value=[]},{deep:true})
watch(view,()=>{query.value='';page.value=1;selectedRows.value=[];currentRows.value=[];totalRows.value=0;document.title=`${labels[view.value]} · elune`})
watch(route,()=>{selectedTrace.value=null;selectedSession.value=null;sessionTraces.value=[]})
watch([route,query,environment,source,dateRange,level,names,preset,pageSize,scoreSource,scoreName,sortKey,sortDirection,page],reloadView,{deep:true})
onMounted(()=>{mounted=true;load();connectLive();window.addEventListener('hashchange',hashChanged);window.addEventListener('keydown',keydown)})
onUnmounted(()=>{disposed=true;requestController?.abort();liveEvents?.close();clearTimeout(refreshTimer);window.removeEventListener('hashchange',hashChanged);window.removeEventListener('keydown',keydown);clearTimeout(toastTimer)})
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <aside class="sidebar">
      <a href="#/traces" class="brand" aria-label="elune home"><svg class="brand-symbol" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M4 7C1 20 7 29 16 29S31 20 28 7C27 17 22 23 16 25C10 23 5 17 4 7Z" fill="currentColor"/><path d="m16 2 3.5 7.5L16 17l-3.5-7.5Z" fill="currentColor"/></svg><span>elune</span></a>
      <div class="project-wrap"><button class="project-selector" aria-label="Choose project" @click="menu = menu === 'project' ? '' : 'project'"><span class="project-icon"><Folder :size="15"/></span><span class="project-label">Agent workspace<small>Local project</small></span><ChevronDown :size="13"/></button><div v-if="menu === 'project'" class="popover project-popover"><span class="menu-title">Projects</span><button @click="menu=''" class="menu-item"><Folder :size="14"/> Agent workspace <Check :size="14"/></button><div class="menu-note">Traces saved on this computer.</div></div></div>
      <nav class="main-nav" aria-label="Main navigation">
        <a href="#/overview" aria-label="Overview" class="nav-link" :class="{active:view==='overview'}"><BarChart3 :size="16"/><span>Overview</span></a>
        <div class="nav-heading">Observability</div>
        <a href="#/traces" aria-label="Tracing" class="nav-link" :class="{active:view==='traces'}"><Activity :size="16"/><span>Tracing</span><span class="nav-count">{{ facets.totalTraces }}</span></a>
        <a href="#/sessions" aria-label="Sessions" class="nav-link" :class="{active:view==='sessions'}"><MessageSquare :size="16"/><span>Sessions</span></a>
        <div class="nav-heading">Evaluation</div>
        <a href="#/scores" aria-label="Scores" class="nav-link" :class="{active:view==='scores'}"><CheckCheck :size="16"/><span>Scores</span></a>
      </nav>
      <div class="sidebar-bottom">
        <div class="local-notice"><span class="status-dot"></span><span>Local workspace<small>Persistent trace data</small></span></div>
        <button class="nav-link" :aria-label="theme==='light'?'Dark mode':'Light mode'" @click="theme=theme==='light'?'dark':'light'"><Moon v-if="theme==='light'" :size="15"/><Sun v-else :size="15"/><span>{{ theme==='light'?'Dark mode':'Light mode' }}</span></button>
        <div class="profile"><span class="avatar">L</span><span>Local developer<small>Personal workspace</small></span><button class="icon-button" title="Collapse sidebar" aria-label="Collapse sidebar" @click="sidebarCollapsed=!sidebarCollapsed"><PanelLeftClose :size="15"/></button></div>
      </div>
    </aside>
    <main class="main">
      <header class="topbar"><button class="icon-button" :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'" @click="sidebarCollapsed=!sidebarCollapsed"><PanelLeftOpen v-if="sidebarCollapsed" :size="16"/><PanelLeftClose v-else :size="16"/></button><span class="top-divider"></span><span class="organization">Personal workspace</span><ChevronRight :size="13" class="muted"/><Folder :size="14" class="muted"/><span>Agent workspace</span><ChevronDown :size="12" class="muted"/><div class="topbar-right"><span class="local-badge"><span class="status-dot"></span>Local</span><span class="avatar small">L</span></div></header>
      <div class="page-heading"><div class="title-group"><h1>{{ labels[view] }}</h1><span v-if="view!=='overview'" class="count-badge">{{ totalRows }}</span><span class="heading-info" :title="view==='traces'?'Inspect agent requests, model calls, and tool executions.':view==='sessions'?'Conversations grouped across multiple traces.':'Evaluation results and manual annotations.'"><Info :size="14"/></span></div><div class="heading-actions"><span class="data-label">{{ dataLabel }}</span><button class="button" @click="load" :disabled="refreshing"><RefreshCw :size="13" :class="{spinning:refreshing}"/><span>Refresh</span></button></div></div>
      <div v-if="error" class="error-banner"><Info :size="16"/><span>Could not load workspace: {{ error }}</span><button class="button" @click="load">Retry</button></div>
      <div class="workspace-content">
        <div v-if="view!=='overview'" class="search-bar"><Search :size="15"/><input class="search-input" v-model="query" :placeholder="view==='traces'?'Search traces by name, input, user ID, or session…':view==='sessions'?'Search sessions by ID or user…':'Search scores by name, trace, or comment…'" :aria-label="`Search ${view}`"/><button v-if="query" class="icon-button" @click="query=''" aria-label="Clear search"><X :size="13"/></button><kbd>⌘ K</kbd></div>
        <div class="toolbar">
          <div class="toolbar-left" v-if="view==='traces'">
            <button class="button" :class="{pressed:showFilters}" @click="showFilters=!showFilters"><ListFilter :size="14"/>Filters<span class="filter-count" v-if="filtersActive">{{ filtersActive }}</span></button>
            <div class="toolbar-divider"></div>
            <button class="preset" :class="{selected:preset==='all'}" @click="preset='all'">All traces</button>
            <button class="preset" :class="{selected:preset==='bookmarked'}" @click="preset=preset==='bookmarked'?'all':'bookmarked'"><Star :size="13"/>Bookmarked</button>
            <button class="preset" :class="{selected:preset==='errors'}" @click="preset=preset==='errors'?'all':'errors'"><span class="tiny-dot red-dot"></span>Errors</button>
            <button class="preset slow-preset" :class="{selected:preset==='slow'}" @click="preset=preset==='slow'?'all':'slow'"><Zap :size="13"/>Slow</button>
          </div>
          <div class="toolbar-left" v-else-if="view==='scores'"><div class="select-control"><Filter :size="13"/><select v-model="scoreName" aria-label="Score name"><option value="all">All score names</option><option v-for="name in scoreNames" :key="name">{{ name }}</option></select></div><div class="select-control"><select v-model="scoreSource" aria-label="Score source"><option value="all">All sources</option><option value="API">API</option><option value="EVAL">Evaluator</option><option value="ANNOTATION">Annotation</option></select></div></div>
          <div class="toolbar-left" v-else><span class="subtle-caption">{{ view==='overview'?'Project overview':'Conversations across your agent traces' }}</span></div>
          <div class="toolbar-right"><div class="select-control"><select v-model="source" aria-label="Trace source"><option value="all">All sources</option><option value="pi">Live Pi</option><option value="sample">Sample data</option></select></div><div class="select-control environment-select"><span class="tiny-dot green-dot"></span><select v-model="environment" aria-label="Environment"><option value="all">All environments</option><option v-for="env in environments" :key="env" :value="env">{{ env }}</option></select></div><div class="select-control"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg><select v-model="dateRange" aria-label="Date range"><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></div><template v-if="view==='traces'"><button class="icon-button bordered" :class="{pressed:showChart}" @click="showChart=!showChart" title="Toggle activity chart" aria-label="Toggle activity chart"><BarChart3 :size="15"/></button><div class="menu-wrap"><button class="icon-button bordered" @click="menu=menu==='columns'?'':'columns'" title="Columns" aria-label="Columns"><Columns3 :size="15"/></button><div v-if="menu==='columns'" class="popover columns-popover"><span class="menu-title">Visible columns</span><label v-for="column in columnOptions" :key="column.id" class="menu-check"><input type="checkbox" :checked="hasColumn(column.id)" @change="toggleColumn(column.id)"/>{{ column.label }}</label></div></div></template><button v-if="view!=='overview'" class="icon-button bordered" @click="download" :disabled="exporting" title="Export CSV" aria-label="Export CSV"><Download :size="15"/></button></div>
        </div>
        <div v-if="loading" class="loading-state"><RefreshCw :size="24" class="spinning"/><span>Loading your workspace…</span></div>
        <Overview v-else-if="view==='overview'" :overview="overview" :traces="overview.recentTraces || []" @navigate-traces="go('/traces')" @inspect="inspect"/>
        <template v-else-if="selectedSession">
          <section class="session-detail"><button class="text-button" @click="go('/sessions')"><ArrowLeft :size="14"/> All sessions</button><div class="session-title"><div><h2>{{ selectedSession.id }}</h2><span class="muted">{{ selectedSession.userId }} <span class="dot-separator">·</span> {{ date(selectedSession.startTime) }}, {{ time(selectedSession.startTime) }}</span></div><span class="badge">{{ selectedSession.environment }}</span></div><div class="session-metrics"><span><b>{{ selectedSession.traceCount }}</b> traces</span><span><b>{{ number(selectedSession.totalTokens) }}</b> tokens</span><span><b>{{ money(selectedSession.cost) }}</b> total cost</span></div><div class="conversation"><article v-for="trace in sessionTraces" :key="trace.id" class="conversation-turn"><div class="conversation-time">{{ time(trace.timestamp) }}<span class="badge">{{ trace.name }}</span></div><div class="message user-message"><span class="message-role"><Users :size="13"/>User</span><p>{{ trace.input }}</p></div><div class="message agent-message"><span class="message-role"><Zap :size="13"/>Assistant <span class="muted">{{ trace.model }}</span></span><p>{{ trace.output }}</p><button class="text-button" @click="inspect(trace)">View trace <ArrowUpRight :size="13"/></button></div></article></div></section>
        </template>
        <div v-else class="data-layout">
          <aside class="filters-panel" v-if="view==='traces' && showFilters"><div class="filter-panel-heading"><Filter :size="13"/><span>Filters</span><button class="text-button" v-if="filtersActive" @click="resetFilters">Reset</button></div><section class="filter-section"><h3><ChevronDown :size="12"/>Environment</h3><label class="filter-option"><input type="radio" name="environment-filter" v-model="environment" value="all"/><span>All environments</span><small>{{ facets.totalTraces }}</small></label><label v-for="env in environments" :key="env" class="filter-option"><input type="radio" name="environment-filter" v-model="environment" :value="env"/><span>{{ env }}</span><small>{{ facetCount('environments',env) }}</small></label></section><section class="filter-section"><h3><ChevronDown :size="12"/>Level</h3><label class="filter-option"><input type="radio" name="level-filter" v-model="level" value="all"/><span>All levels</span><small>{{ facets.scopeTotal }}</small></label><label v-for="item in [{id:'DEFAULT',label:'Default',color:'green-dot'},{id:'WARNING',label:'Warning',color:'amber-dot'},{id:'ERROR',label:'Error',color:'red-dot'}]" :key="item.id" class="filter-option"><input type="radio" name="level-filter" v-model="level" :value="item.id"/><span class="tiny-dot" :class="item.color"></span><span>{{ item.label }}</span><small>{{ facetCount('levels',item.id) }}</small></label></section><section class="filter-section"><h3><ChevronDown :size="12"/>Trace name</h3><label v-for="name in traceNames" :key="name" class="filter-option name-option"><input type="checkbox" v-model="names" :value="name"/><span :title="name">{{ name }}</span><small>{{ facetCount('names',name) }}</small></label></section><div class="filter-help"><Info :size="13"/><p>Filters apply to the chart and trace list.</p></div></aside>
          <div class="data-main">
            <div v-if="view==='traces' && showChart" class="activity-chart"><div class="chart-label"><span>Trace count</span><span class="chart-legend"><i></i>{{ totalRows }} traces</span></div><div class="histogram"><div class="grid-lines"><i></i><i></i><i></i></div><div v-for="(bin,i) in histogram" :key="i" class="histogram-slot" :title="`${bin.count} traces · ${bin.errors} errors`"><div class="histogram-bar" :style="{height:bin.height+'%'}"><span v-if="bin.errors" :style="{height:bin.errors / bin.count * 100+'%'}"></span></div></div></div><div class="chart-axis"><span v-for="(label,i) in chartLabels" :key="i">{{ label }}</span></div></div>
            <div v-if="selectedRows.length" class="selection-bar"><span>{{ selectedRows.length }} selected</span><button class="text-button" @click="download" :disabled="exporting"><Download :size="13"/>Export selected</button><button class="icon-button" @click="selectedRows=[]" aria-label="Clear selection"><X :size="13"/></button></div>
            <div class="table-scroll">
              <table v-if="view==='traces'" class="data-table trace-table"><thead><tr><th class="check-cell"><input type="checkbox" :checked="allSelected" @change="toggleAll" aria-label="Select all traces on this page"/></th><th class="star-cell"></th><th v-if="hasColumn('timestamp')"><button @click="sort('timestamp')">Timestamp <ArrowDown v-if="sortKey==='timestamp'" :size="12" :class="{ascending:sortDirection===1}"/><ArrowDownUp v-else :size="12"/></button></th><th v-if="hasColumn('name')"><button @click="sort('name')">Name <ArrowDownUp :size="12"/></button></th><th v-if="hasColumn('input')">Input</th><th v-if="hasColumn('output')">Output</th><th v-if="hasColumn('latency')" class="numeric"><button @click="sort('latency')">Latency<ArrowDownUp :size="11"/></button></th><th v-if="hasColumn('tokens')" class="numeric"><button @click="sort('tokens')">Tokens<ArrowDownUp :size="11"/></button></th><th v-if="hasColumn('cost')" class="numeric"><button @click="sort('cost')">Total cost<ArrowDownUp :size="11"/></button></th><th v-if="hasColumn('environment')">Environment</th><th v-if="hasColumn('scores')">Scores</th><th v-if="hasColumn('user')">User ID</th><th v-if="hasColumn('tags')">Tags</th><th class="row-end"></th></tr></thead><tbody><tr v-for="trace in pageRows" :key="trace.id" @click="inspect(trace)" :class="{'row-selected':selectedRows.includes(trace.id)}"><td class="check-cell" @click.stop><input type="checkbox" :value="trace.id" v-model="selectedRows" :aria-label="`Select ${trace.id}`"/></td><td class="star-cell" @click.stop><button class="star-button" :class="{bookmarked:trace.bookmarked}" @click="bookmark(trace)" :aria-label="trace.bookmarked?'Remove bookmark':'Bookmark trace'"><Star :size="13" :fill="trace.bookmarked?'currentColor':'none'"/></button></td><td v-if="hasColumn('timestamp')" class="timestamp-cell"><span>{{ date(trace.timestamp) }}</span><span class="muted">{{ time(trace.timestamp) }}</span></td><td v-if="hasColumn('name')" class="name-cell"><a :href="`#/traces/${trace.id}`" @click.stop><span class="trace-icon" :class="traceStatus(trace)"><Activity :size="13"/></span>{{ trace.name }}<span v-if="trace.source==='pi' || traceStatus(trace)!=='completed'" class="trace-status" :class="traceStatus(trace)">{{ statusLabel(trace) }}</span></a></td><td v-if="hasColumn('input')"><span class="truncate input-preview" :title="trace.input">{{ trace.input }}</span></td><td v-if="hasColumn('output')"><span class="truncate input-preview" :title="trace.output">{{ trace.output }}</span></td><td v-if="hasColumn('latency')" class="numeric"><span class="latency" :class="{slow:trace.latency>5}">{{ duration(trace.latency) }}</span></td><td v-if="hasColumn('tokens')" class="numeric mono">{{ number(trace.totalTokens) }}</td><td v-if="hasColumn('cost')" class="numeric mono">{{ money(trace.cost) }}</td><td v-if="hasColumn('environment')"><span class="badge env-badge"><span class="tiny-dot" :class="trace.environment==='production'?'green-dot':trace.environment==='staging'?'amber-dot':'gray-dot'"></span>{{ trace.environment }}</span></td><td v-if="hasColumn('scores')"><span v-if="trace.scores.length" class="score-pill" :class="scoreColor(trace.scores[0].value)" :title="trace.scores.map(s=>`${s.name}: ${s.value}`).join(', ')"><span>{{ trace.scores[0].name }}</span><b>{{ Number(trace.scores[0].value).toFixed(2) }}</b></span><span v-else class="muted">—</span></td><td v-if="hasColumn('user')" class="mono">{{ trace.userId }}</td><td v-if="hasColumn('tags')"><span v-for="tag in trace.tags" :key="tag" class="badge tag">{{ tag }}</span></td><td class="row-end"><ChevronRight :size="13"/></td></tr></tbody></table>
              <table v-else-if="view==='sessions'" class="data-table"><thead><tr><th>Session ID</th><th>Created at</th><th>User ID</th><th>Environment</th><th class="numeric">Traces</th><th class="numeric">Duration</th><th class="numeric">Tokens</th><th class="numeric">Total cost</th><th></th></tr></thead><tbody><tr v-for="session in pageRows" :key="session.id" @click="go(`/sessions/${session.id}`)"><td><a class="session-link" :href="`#/sessions/${session.id}`"><MessageSquare :size="14"/>{{ session.id }}</a></td><td class="timestamp-cell">{{ date(session.startTime) }}<span class="muted">{{ time(session.startTime) }}</span></td><td class="mono">{{ session.userId }}</td><td><span class="badge">{{ session.environment }}</span></td><td class="numeric"><span class="count-badge">{{ session.traceCount }}</span></td><td class="numeric mono">{{ duration((new Date(session.endTime)-new Date(session.startTime))/1000) }}</td><td class="numeric mono">{{ number(session.totalTokens) }}</td><td class="numeric mono">{{ money(session.cost) }}</td><td><ChevronRight :size="13"/></td></tr></tbody></table>
              <table v-else class="data-table"><thead><tr><th>Timestamp</th><th>Name</th><th>Value</th><th>Data type</th><th>Source</th><th>Trace</th><th>Comment</th><th></th></tr></thead><tbody><tr v-for="score in pageRows" :key="score.id" @click="go(`/traces/${score.traceId}`)"><td class="timestamp-cell">{{ date(score.timestamp) }}<span class="muted">{{ time(score.timestamp) }}</span></td><td class="weight-medium">{{ score.name }}</td><td><span class="score-pill" :class="scoreColor(score.value)">{{ Number(score.value).toFixed(2) }}</span></td><td><span class="badge">{{ score.dataType || 'NUMERIC' }}</span></td><td><span class="source-badge" :class="score.source.toLowerCase()">{{ score.source==='EVAL'?'Evaluator':score.source==='ANNOTATION'?'Annotation':'API' }}</span></td><td><a :href="`#/traces/${score.traceId}`" class="session-link"><Activity :size="13"/>{{ score.traceName }}</a></td><td><span class="truncate comment-preview">{{ score.comment || '—' }}</span></td><td><ChevronRight :size="13"/></td></tr></tbody></table>
              <div v-if="!pageRows.length" class="empty-state"><Search :size="27"/><h3>No {{ view }} found</h3><p>Try another search or change your filters.</p><button class="button" @click="resetFilters">Clear filters</button></div>
            </div>
            <footer class="table-footer"><span>{{ totalRows ? (page-1)*pageSize+1 : 0 }}–{{ Math.min(page*pageSize,totalRows) }} of {{ number(totalRows) }} {{ view }}</span><div class="pagination"><label>Rows per page <select v-model.number="pageSize" aria-label="Rows per page"><option :value="10">10</option><option :value="20">20</option><option :value="50">50</option></select></label><span>Page {{ page }} of {{ totalPages }}</span><button class="icon-button bordered" @click="page=1" :disabled="page===1" aria-label="First page"><ChevronsLeft :size="14"/></button><button class="icon-button bordered" @click="page--" :disabled="page===1" aria-label="Previous page"><ChevronLeft :size="14"/></button><button class="icon-button bordered" @click="page++" :disabled="page===totalPages" aria-label="Next page"><ChevronRight :size="14"/></button><button class="icon-button bordered" @click="page=totalPages" :disabled="page===totalPages" aria-label="Last page"><ChevronsRight :size="14"/></button></div></footer>
          </div>
        </div>
      </div>
      <div class="app-footer"><span role="status"><span class="status-dot" :class="{'amber-dot':liveState!=='connected' || error}"></span>{{ error ? 'Backend unavailable' : `Live updates ${liveState}` }}</span><span>elune <span class="dot-separator">·</span> {{ number(facets.totalTraces) }} stored traces</span></div>
    </main>
    <div v-if="selectedTrace" class="inspector-backdrop" @click="go('/traces')"></div>
    <TraceDetail v-if="selectedTrace" :key="selectedTrace.id" :trace="selectedTrace" @close="go('/traces')" @bookmark="bookmark(selectedTrace)" @scored="scored" @navigate-session="go(`/sessions/${$event}`)"/>
    <div v-if="toast" class="toast" role="status"><Check :size="15"/>{{ toast }}</div>
  </div>
</template>
