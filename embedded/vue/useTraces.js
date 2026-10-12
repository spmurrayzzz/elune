import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { normalizeListState, normalizeSelection } from './props.js'

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || !value.id) throw new Error('Invalid trace record.')
  for (const key of ['name', 'type', 'model', 'status', 'level', 'sessionId', 'timestamp', 'parentId']) {
    if (value[key] != null && typeof value[key] !== 'string') throw new Error('Invalid trace record.')
  }
  if (value.metadata != null && (typeof value.metadata !== 'object' || Array.isArray(value.metadata))) throw new Error('Invalid trace metadata.')
  for (const key of ['cwd', 'sessionFile', 'sessionName']) {
    if (value.metadata?.[key] != null && typeof value.metadata[key] !== 'string') throw new Error('Invalid trace metadata.')
  }
  if (value.revision != null && (!Number.isSafeInteger(Number(value.revision)) || Number(value.revision) < 0)) throw new Error('Invalid trace revision.')
  if (value.bookmarked != null && typeof value.bookmarked !== 'boolean') throw new Error('Invalid bookmark status.')
  if (value.readTruncation != null && (typeof value.readTruncation !== 'object' || Array.isArray(value.readTruncation))) throw new Error('Invalid read truncation metadata.')
  if (value.readTruncation?.fields != null && (!Array.isArray(value.readTruncation.fields) || value.readTruncation.fields.some(field => typeof field !== 'string'))) throw new Error('Invalid read truncation fields.')
  if (value.observations !== undefined && !Array.isArray(value.observations)) throw new Error('Invalid trace observations.')
  for (const item of value.observations || []) validateRecord(item)
  return value
}

function validateTrace(value, id, sessionId) {
  if (value === null) return null
  validateRecord(value)
  if (value.id !== id) throw new Error('The returned trace does not match the requested trace.')
  if (sessionId && value.sessionId !== sessionId) throw new Error('This trace belongs to another session.')
  return value
}

function validatePage(trace, offset, limit) {
  if (!trace) return
  const items = trace.observations || []
  const page = trace.pagination?.observations
  if (!page) {
    if (offset || items.length > limit) throw new Error('The trace client must support observation pagination.')
    return
  }
  if (!Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > limit || items.length > page.limit || items.length > Math.max(0, page.total - offset) || page.nextOffset !== (offset + items.length < page.total ? offset + items.length : null) || (page.nextOffset !== null && !items.length)) throw new Error('Invalid observation page response.')
}

function summary(trace) {
  const { id, name, timestamp, sessionId, revision, status, level, latency, totalTokens, cost, bookmarked } = trace
  return { id, name, timestamp, sessionId, revision, status, level, latency, totalTokens, cost, bookmarked, metadata: { cwd: trace.metadata?.cwd, sessionName: trace.metadata?.sessionName } }
}

function newer(candidate, current) {
  return candidate?.revision != null && (current?.revision == null || Number(candidate.revision) > Number(current.revision))
}

export function useTraces(props, emit, detailVisible = ref(true)) {
  const selection = shallowRef(normalizeSelection(props.selection))
  const listState = shallowRef(normalizeListState(props.listState))
  const traces = shallowRef([])
  const trace = shallowRef(null)
  const total = ref(0)
  const listLoading = ref(false)
  const traceLoading = ref(false)
  const saving = ref(false)
  const listError = ref('')
  const traceError = ref('')
  const bookmarkError = ref('')
  const liveError = ref('')
  const mounted = ref(false)
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
  const enabled = computed(() => mounted.value && props.active && visible.value && (props.mode !== 'inspector' || Boolean(props.sessionId)))
  const detailEnabled = computed(() => enabled.value && detailVisible.value)
  const inferredSession = ref('')
  const scope = computed(() => props.sessionId || (props.mode === 'workspace' ? inferredSession.value : ''))
  const canList = computed(() => props.mode === 'explorer' || Boolean(scope.value))
  let epoch = 0
  let listController
  let traceController
  let bookmarkController
  let unsubscribe
  let refreshTimer
  let searchTimer
  let requestedScope
  let acceptedState
  let dirtyList = true
  let dirtyTrace = true
  let listRevisions = new Map()
  const rowSnapshots = new Map()
  const observationHistory = shallowRef([])
  const previousObservationOffset = computed(() => {
    const offset = trace.value?.pagination?.observations?.offset ?? selection.value.observationOffset
    const previous = observationHistory.value.filter(value => value < offset).at(-1)
    return previous ?? Math.max(0, offset - selection.value.observationLimit)
  })

  function retainSummary(item) {
    const row = summary(item)
    const previous = rowSnapshots.get(row.id)
    if (newer(previous, row)) return previous
    rowSnapshots.delete(row.id)
    rowSnapshots.set(row.id, row)
    if (rowSnapshots.size > 100) rowSnapshots.delete(rowSnapshots.keys().next().value)
    return row
  }

  function select(value) {
    const changedTrace = Object.hasOwn(value, 'traceId') && value.traceId !== selection.value.traceId
    const next = normalizeSelection({ ...selection.value, ...(changedTrace ? { observationOffset: 0, observationId: null } : {}), ...value })
    if (Object.keys(next).some(key => next[key] !== selection.value[key])) {
      selection.value = next
      emit('update:selection', next)
    }
  }

  function loadObservationPage(offset) {
    if (!detailEnabled.value || traceLoading.value || saving.value || !trace.value || !Number.isSafeInteger(offset) || offset < 0) return
    const current = trace.value.pagination?.observations?.offset ?? 0
    if (offset === current) return
    observationHistory.value = offset > current ? [...observationHistory.value.filter(value => value < current), current].slice(-64) : observationHistory.value.filter(value => value < offset)
    select({ observationOffset: offset, observationId: null })
  }

  function setListState(value) {
    listState.value = normalizeListState({ ...listState.value, ...value })
    emit('update:listState', listState.value)
  }

  function stop() {
    epoch++
    clearTimeout(refreshTimer)
    clearTimeout(searchTimer)
    refreshTimer = searchTimer = null
    listController?.abort()
    traceController?.abort()
    bookmarkController?.abort()
    listController = traceController = bookmarkController = null
    const detach = unsubscribe
    unsubscribe = null
    try { detach?.() } catch (error) { liveError.value = error.message || 'Could not detach live updates.' }
    listLoading.value = traceLoading.value = saving.value = false
  }

  function attach() {
    if (!enabled.value || unsubscribe || typeof props.client.subscribe !== 'function') return
    const version = epoch
    try {
      unsubscribe = props.client.subscribe(value => { if (version === epoch) notice(value) })
      liveError.value = ''
    } catch (error) { liveError.value = error.message || 'Live updates are unavailable.' }
  }

  function schedule() {
    const listReady = enabled.value && canList.value && dirtyList && !listLoading.value && !searchTimer
    const traceReady = detailEnabled.value && selection.value.traceId && dirtyTrace && !traceLoading.value && !saving.value
    if (refreshTimer || (!listReady && !traceReady)) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (dirtyList && !listLoading.value && !searchTimer) void loadList()
      if (dirtyTrace && !traceLoading.value && !saving.value) void loadTrace()
    }, 350)
  }

  async function loadList() {
    if (!enabled.value || !canList.value) return
    listController?.abort()
    const controller = new AbortController()
    listController = controller
    const version = epoch
    const client = props.client
    const state = listState.value
    const params = { page: state.page, limit: state.limit }
    requestedScope = scope.value
    if (scope.value) params.sessionId = scope.value
    if (props.mode === 'explorer' && state.cwd) params.cwd = state.cwd
    if (props.mode === 'explorer' && state.q.trim()) params.q = state.q.trim()
    if (props.mode === 'explorer' && state.status) params.status = state.status
    dirtyList = false
    listLoading.value = true
    listError.value = ''
    try {
      const result = await client.list(params, { signal: controller.signal })
      if (version !== epoch || listController !== controller || controller.signal.aborted || !enabled.value || client !== props.client) return
      const page = result?.page ?? state.page
      const limit = result?.limit ?? state.limit
      if (!result || !Array.isArray(result.traces) || !Number.isSafeInteger(result.total) || result.total < 0 || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 || result.traces.length > limit || result.traces.length > result.total) throw new Error('Invalid trace list response.')
      const rows = result.traces.map(item => summary(validateRecord(item)))
      const last = Math.max(1, Math.ceil(result.total / limit))
      if (page > last) { setListState({ page: last, limit }); return }
      if (rows.length !== Math.min(limit, Math.max(0, result.total - (page - 1) * limit))) throw new Error('Invalid trace list range.')
      if (page !== state.page || limit !== state.limit) {
        acceptedState = normalizeListState({ ...state, page, limit })
        listState.value = acceptedState
        emit('update:listState', acceptedState)
      }
      listRevisions = new Map(rows.map(row => [row.id, row.revision]))
      traces.value = rows.map(retainSummary)
      total.value = result.total
      if (!selection.value.traceId && traces.value.length) select({ traceId: traces.value[0].id, observationId: null })
    } catch (error) {
      if (version === epoch && listController === controller && !controller.signal.aborted) listError.value = error.message || 'Could not load traces.'
    } finally {
      if (version === epoch && listController === controller) { listLoading.value = false; schedule() }
    }
  }

  async function loadTrace() {
    if (!detailEnabled.value || !selection.value.traceId || saving.value) return
    traceController?.abort()
    const controller = new AbortController()
    traceController = controller
    const version = epoch
    const client = props.client
    const { traceId: id, observationOffset, observationLimit } = selection.value
    dirtyTrace = false
    traceLoading.value = true
    traceError.value = ''
    try {
      const result = await client.get(id, { signal: controller.signal, observationOffset, observationLimit })
      if (version !== epoch || traceController !== controller || controller.signal.aborted || !detailEnabled.value || client !== props.client || id !== selection.value.traceId || observationOffset !== selection.value.observationOffset || observationLimit !== selection.value.observationLimit) return
      validateTrace(result, id, props.sessionId)
      validatePage(result, observationOffset, observationLimit)
      if (result && trace.value?.id === id && newer(trace.value, result)) return
      if (result && newer(rowSnapshots.get(id), result)) throw new Error('Trace details are older than the latest recorded revision. Refresh to try again.')
      if (result) retainSummary(result)
      trace.value = result
      if (props.mode === 'workspace') inferredSession.value = result?.sessionId || ''
    } catch (error) {
      if (version === epoch && traceController === controller && !controller.signal.aborted) traceError.value = error.message || 'Could not load the trace.'
    } finally {
      if (version === epoch && traceController === controller) { traceLoading.value = false; schedule() }
    }
  }

  function refresh() {
    if (liveError.value) attach()
    dirtyList = true
    dirtyTrace = Boolean(selection.value.traceId)
    schedule()
  }

  function notice(value) {
    if (!enabled.value) return
    if (!value?.traceId || value.type === 'reconnect') { refresh(); return }
    const listedRevision = listRevisions.get(value.traceId)
    const staleList = value.revision != null && listedRevision != null && Number(value.revision) <= Number(listedRevision)
    const staleDetail = value.revision != null && trace.value?.id === value.traceId && trace.value.revision != null && Number(value.revision) <= Number(trace.value.revision)
    if ((!scope.value || !value.sessionId || value.sessionId === scope.value) && !staleList) dirtyList = true
    if (value.traceId === selection.value.traceId && !staleDetail) dirtyTrace = true
    schedule()
  }

  async function bookmark() {
    if (!detailEnabled.value || !trace.value || saving.value || typeof props.client.setBookmarked !== 'function') return
    const item = trace.value
    const controller = new AbortController()
    bookmarkController = controller
    const version = epoch
    const client = props.client
    saving.value = true
    bookmarkError.value = ''
    try {
      const updated = await client.setBookmarked(item.id, !item.bookmarked, { signal: controller.signal })
      if (version !== epoch || bookmarkController !== controller || controller.signal.aborted || client !== props.client || selection.value.traceId !== item.id) return
      validateTrace(updated, item.id, props.sessionId)
      if (!updated) throw new Error('The bookmarked trace is unavailable.')
      traceController?.abort()
      traceLoading.value = false
      if (!newer(trace.value, updated)) {
        const { observations, scores, pagination, readTruncation } = trace.value
        trace.value = { ...updated, observations, scores, pagination, readTruncation: { ...updated.readTruncation, observations: readTruncation?.observations, scores: readTruncation?.scores } }
      }
      dirtyTrace = true
      const row = retainSummary(trace.value)
      traces.value = traces.value.map(current => current.id === item.id ? row : current)
    } catch (error) {
      if (version === epoch && bookmarkController === controller && !controller.signal.aborted) bookmarkError.value = error.message || 'Could not save the bookmark.'
    } finally {
      if (version === epoch && bookmarkController === controller) { saving.value = false; schedule() }
    }
  }

  watch([() => props.selection?.traceId, () => props.selection?.observationId, () => props.selection?.tab, () => props.selection?.observationOffset, () => props.selection?.observationLimit], () => {
    selection.value = normalizeSelection(props.selection)
  })
  watch([() => props.listState?.q, () => props.listState?.status, () => props.listState?.cwd, () => props.listState?.page, () => props.listState?.limit], () => {
    listState.value = normalizeListState(props.listState)
  })
  watch([enabled, () => props.client, () => props.sessionId, () => props.selection?.traceId], (next, previous) => {
    if (previous && next.slice(0, 3).every((value, index) => value === previous[index])) return
    const clientChanged = !previous || next[1] !== previous[1]
    const sessionChanged = !previous || next[2] !== previous[2]
    stop()
    if (clientChanged || sessionChanged) {
      trace.value = null
      inferredSession.value = ''
      traces.value = []
      total.value = 0
      listRevisions.clear()
      rowSnapshots.clear()
      observationHistory.value = []
      listError.value = traceError.value = bookmarkError.value = liveError.value = ''
      if (previous && sessionChanged && next[3] === previous[3]) select({ traceId: null, observationId: null })
    }
    dirtyList = dirtyTrace = true
    if (!enabled.value) return
    attach()
    void loadList()
    void loadTrace()
  })
  watch(scope, () => {
    if (listLoading.value && requestedScope === scope.value) return
    listController?.abort()
    listLoading.value = false
    traces.value = []
    total.value = 0
    listRevisions.clear()
    dirtyList = true
    if (!searchTimer) void loadList()
  })
  watch([() => selection.value.traceId, () => selection.value.observationOffset, () => selection.value.observationLimit], (next, previous) => {
    if (next[0] !== previous[0] || next[2] !== previous[2]) observationHistory.value = []
    traceController?.abort()
    bookmarkController?.abort()
    traceLoading.value = saving.value = false
    if (trace.value?.id !== selection.value.traceId) trace.value = null
    traceError.value = bookmarkError.value = ''
    dirtyTrace = Boolean(selection.value.traceId)
    void loadTrace()
  })
  watch(detailEnabled, value => {
    if (!value) {
      traceController?.abort()
      bookmarkController?.abort()
      traceLoading.value = saving.value = false
      dirtyTrace = Boolean(selection.value.traceId)
    } else if (!traceLoading.value) void loadTrace()
  })
  watch([() => listState.value.q, () => listState.value.status, () => listState.value.cwd, () => listState.value.page, () => listState.value.limit], (next, previous) => {
    if (acceptedState && next.every((value, index) => value === [acceptedState.q, acceptedState.status, acceptedState.cwd, acceptedState.page, acceptedState.limit][index])) { acceptedState = null; return }
    acceptedState = null
    listController?.abort()
    clearTimeout(searchTimer)
    searchTimer = null
    traces.value = []
    total.value = 0
    listRevisions.clear()
    listLoading.value = false
    dirtyList = true
    if (!enabled.value) return
    if (previous && next[0] !== previous[0]) searchTimer = setTimeout(() => { searchTimer = null; void loadList() }, 300)
    else void loadList()
  })

  function visibilityChanged() { visible.value = document.visibilityState !== 'hidden' }
  onMounted(() => {
    visible.value = typeof document === 'undefined' || document.visibilityState !== 'hidden'
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibilityChanged)
    mounted.value = true
  })
  onBeforeUnmount(() => {
    mounted.value = false
    stop()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibilityChanged)
  })

  return { selection, select, listState, setListState, traces, trace, total, listLoading, traceLoading, saving, listError, traceError, bookmarkError, liveError, enabled, scope, refresh, bookmark, loadObservationPage, previousObservationOffset }
}
