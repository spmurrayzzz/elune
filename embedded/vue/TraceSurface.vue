<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { surfaceEvents, surfaceProps } from './props.js'
import { useTraces } from './useTraces.js'
import { date, money, projectLabel, seconds, sessionLabel, sessionTarget, status } from './format.js'
import EluneIcon from './EluneIcon.vue'
import PageControls from './PageControls.vue'
import TraceSummary from './TraceSummary.vue'
import TraceViewer from './TraceViewer.vue'

const props = defineProps({ ...surfaceProps, mode: { type: String, required: true } })
const emit = defineEmits(surfaceEvents)
const surface = ref(null)
const explorerPane = ref(props.selection?.traceId ? 'preview' : 'list')
const width = ref(0)
const previewVisible = computed(() => props.mode !== 'explorer' || width.value > 1050 || explorerPane.value === 'preview')
const { selection, select, listState, setListState, traces, trace, total, listLoading, traceLoading, saving, listError, traceError, bookmarkError, liveError, enabled, scope, refresh, bookmark, loadObservationPage, previousObservationOffset } = useTraces(props, emit, previewVisible)
let observer
let previousRow = props.selection?.traceId
const title = computed(() => ({ inspector: 'Trace inspector', workspace: 'Session traces', explorer: 'Trace explorer' })[props.mode])
const selectedListed = computed(() => traces.value.some(item => item.id === selection.value.traceId))
const query = computed({ get: () => listState.value.q, set: q => setListState({ q, page: 1 }) })
const filter = computed({ get: () => listState.value.status, set: status => setListState({ status, page: 1 }) })
const canBookmark = computed(() => typeof props.client.setBookmarked === 'function')
function switchExplorer(pane) {
  explorerPane.value = pane
  if (pane === 'preview') previousRow = selection.value.traceId
  if (width.value > 1050) return
  nextTick(() => {
    const row = pane === 'list' ? [...surface.value.querySelectorAll('[data-trace-id]')].find(button => button.dataset.traceId === previousRow) : null
    const target = row || surface.value.querySelector(`.elune-explorer-switch button[data-panel="${pane}"]`)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  })
}
function chooseTrace(id) {
  previousRow = id
  select({ traceId: id, observationId: null })
  if (props.mode === 'explorer') switchExplorer('preview')
}
function openWorkspace() {
  if (!trace.value) return
  emit('open-workspace', { selection: { ...selection.value }, sessionId: trace.value.sessionId || props.sessionId || '', cwd: trace.value.metadata?.cwd || '' })
}
function openSession(observation) {
  const target = sessionTarget(trace.value, observation)
  if (target) emit('open-session', target)
}
onMounted(() => {
  const measure = () => { width.value = surface.value?.clientWidth || 0 }
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(surface.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <section ref="surface" class="elune-ui" :class="`elune-${mode}`" :aria-label="title" :aria-busy="listLoading || traceLoading">
    <div class="elune-surface">
      <header class="elune-header">
        <button v-if="mode === 'workspace'" type="button" class="elune-button" @click="emit('close')"><EluneIcon name="back"/>Back</button>
        <EluneIcon name="elune" class="elune-mark"/><h2>{{ title }}</h2><span class="elune-credit">elune</span>
        <button type="button" class="elune-icon-button" aria-label="Close traces" @click="emit('close')"><EluneIcon name="close"/></button>
      </header>
      <div v-if="mode === 'explorer'" class="elune-filters">
        <input v-model="query" type="search" placeholder="Search traces across projects" aria-label="Search traces"/>
        <select v-model="filter" aria-label="Trace status"><option value="">All statuses</option><option value="completed">Completed</option><option value="running">Running</option><option value="error">Error</option><option value="aborted">Aborted</option></select>
        <select :value="listState.limit" aria-label="Traces per page" @change="setListState({ limit: Number($event.target.value), page: 1 })"><option :value="10">10 per page</option><option :value="20">20 per page</option><option :value="50">50 per page</option><option v-if="![10, 20, 50].includes(listState.limit)" :value="listState.limit">{{ listState.limit }} per page</option></select>
        <button type="button" class="elune-button" :disabled="!enabled || listLoading" @click="refresh">Refresh</button>
        <span v-if="listState.cwd || sessionId" class="elune-filter-scope" :title="listState.cwd">{{ listState.cwd || sessionId }}<button v-if="listState.cwd" type="button" @click="setListState({ cwd: '', page: 1 })">Clear project</button></span>
      </div>
      <div v-else class="elune-run-picker">
        <label><span class="elune-run-label">Session run</span><span class="elune-run-select"><select :value="selection.traceId || ''" :disabled="!enabled || !traces.length && !trace" aria-label="Session run" @change="chooseTrace($event.target.value)"><option v-if="!selection.traceId" value="">{{ listLoading ? 'Loading runs…' : 'Select a run' }}</option><option v-if="selection.traceId && !selectedListed" :value="selection.traceId">{{ trace?.name || selection.traceId }} · selected run</option><option v-for="run in traces" :key="run.id" :value="run.id">{{ date(run.timestamp) }} · {{ run.name || 'Untitled trace' }} · {{ status(run) }}</option></select><EluneIcon name="chevron"/></span></label>
        <PageControls :page="listState.page" :limit="listState.limit" :total="total" :disabled="!enabled || listLoading" label="runs" @update:page="setListState({ page: $event })"/>
      </div>
      <div v-if="listError" class="elune-error" role="alert"><span>{{ listError }}</span><button type="button" :disabled="!enabled" @click="refresh">Retry</button></div>
      <div v-if="liveError" class="elune-error" role="alert"><span>{{ liveError }}</span><button type="button" :disabled="!enabled" @click="refresh">Retry live updates</button></div>
      <p v-if="mode === 'inspector' && !sessionId" class="elune-empty">A session ID is required.</p>
      <nav v-if="mode === 'explorer'" class="elune-explorer-switch" aria-label="Explorer panels"><button type="button" :aria-pressed="explorerPane === 'list'" data-panel="list" @click="switchExplorer('list')">Traces ({{ total }})</button><button type="button" :aria-pressed="explorerPane === 'preview'" data-panel="preview" @click="switchExplorer('preview')">Selected preview</button></nav>
      <div class="elune-body" :data-pane="explorerPane">
        <section v-if="mode === 'explorer'" class="elune-trace-list" aria-label="Trace results">
          <div class="elune-table-scroll">
            <table class="elune-table"><thead><tr><th>Trace</th><th>Project</th><th>Session</th><th>Status</th><th>Duration / cost</th></tr></thead><tbody><tr v-for="run in traces" :key="run.id" :class="{ chosen: selection.traceId === run.id }" @click="chooseTrace(run.id)"><td><button type="button" :aria-pressed="selection.traceId === run.id" :title="run.name" :data-trace-id="run.id" @click.stop="chooseTrace(run.id)"><EluneIcon v-if="run.bookmarked" name="bookmark"/>{{ run.name || 'Untitled trace' }}</button><small>{{ date(run.timestamp) }}</small></td><td :title="run.metadata?.cwd">{{ projectLabel(run) }}</td><td :title="sessionLabel(run)">{{ sessionLabel(run) }}</td><td><span class="elune-status" :class="status(run)">{{ status(run) }}</span></td><td>{{ seconds(run.latency) }}<small>{{ money(run.cost) }}</small></td></tr></tbody></table>
            <p v-if="!traces.length" class="elune-empty" role="status">{{ listLoading ? 'Loading traces…' : listError ? 'Trace results are unavailable.' : 'No matching traces.' }}</p>
          </div>
          <PageControls :page="listState.page" :limit="listState.limit" :total="total" :disabled="!enabled || listLoading" label="traces" @update:page="setListState({ page: $event })"/>
        </section>
        <section class="elune-selected" aria-label="Selected trace">
          <div v-if="traceError" class="elune-error" role="alert"><span>{{ traceError }}</span><button type="button" :disabled="!enabled" @click="refresh">Retry</button></div>
          <template v-if="trace">
            <TraceSummary :trace="trace"/>
            <div class="elune-trace-actions"><button v-if="canBookmark" type="button" class="elune-button" :aria-pressed="Boolean(trace.bookmarked)" :disabled="!enabled || saving" @click="bookmark"><EluneIcon name="bookmark"/>{{ saving ? 'Saving…' : trace.bookmarked ? 'Bookmarked' : 'Bookmark' }}</button><button v-if="mode !== 'workspace'" type="button" class="elune-button elune-open-workspace" :disabled="!enabled" @click="openWorkspace"><EluneIcon name="expand"/>Open workspace</button><span v-if="traceLoading" role="status">Updating…</span></div>
            <p v-if="bookmarkError" class="elune-error" role="alert">{{ bookmarkError }}</p>
            <TraceViewer :trace="trace" :selection="selection" :timeline="mode === 'workspace'" :preview-visible="previewVisible" :paging-disabled="!enabled || !previewVisible || traceLoading || saving" :previous-offset="previousObservationOffset" @load-page="loadObservationPage" @update:selection="select" @open-session="openSession" @open-child-session="emit('open-session', $event)"/>
          </template>
          <p v-else class="elune-empty" role="status">{{ traceLoading ? 'Loading trace…' : selection.traceId ? 'Trace unavailable or removed.' : mode === 'workspace' && !scope ? 'Select a trace or provide a session ID.' : 'Select a run to inspect its observations.' }}</p>
        </section>
      </div>
    </div>
  </section>
</template>
