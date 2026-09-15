<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Bookmark, Bot, Braces, Check, ChevronDown, ChevronRight, Clock3, Copy, Database, Hash, Layers, ListTree, MessageSquare, Plus, Search, Sparkles, Tag, Terminal, User, Workflow, Wrench, X } from 'lucide-vue-next'

const props = defineProps({ trace: { type: Object, required: true } })
const emit = defineEmits(['close', 'bookmark', 'scored', 'navigate-session'])
const selectedId = ref(null)
const activeTab = ref('Preview')
const pretty = ref(true)
const search = ref('')
const collapsed = ref(new Set())
const copied = ref(false)
const copyFailed = ref(false)
const showScore = ref(false)
const scoreName = ref('quality')
const scoreValue = ref('1')
const scoreComment = ref('')
const scoreError = ref('')
const saving = ref(false)
const inspector = ref(null)
const closeButton = ref(null)
const scoreDialog = ref(null)
const scoreNameInput = ref(null)
let copyTimeout
let previousFocus
let scoreOpener

const observations = computed(() => props.trace.observations || [])
const selected = computed(() => observations.value.find(item => item.id === selectedId.value) || props.trace)
const isRoot = computed(() => selected.value === props.trace)
const duration = computed(() => isRoot.value ? props.trace.latency : selected.value.duration)
const selectedTokens = computed(() => selected.value.totalTokens ?? selected.value.metadata?.usage?.totalTokens ?? (Number(selected.value.inputTokens || 0) + Number(selected.value.outputTokens || 0)))
const cacheRead = computed(() => selected.value.metadata?.usage?.cacheRead ?? selected.value.metadata?.cacheReadTokens ?? 0)
const cacheWrite = computed(() => selected.value.metadata?.usage?.cacheWrite ?? selected.value.metadata?.cacheWriteTokens ?? 0)
const scores = computed(() => props.trace.scores || [])
const rows = computed(() => {
  const all = observations.value
  const ids = new Set(all.map(item => item.id))
  const result = []
  const seen = new Set()
  const visit = (item, depth) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    const children = all.filter(child => child.parentId === item.id)
    result.push({ ...item, depth, hasChildren: children.length > 0 })
    if (!collapsed.value.has(item.id) || search.value) children.forEach(child => visit(child, depth + 1))
  }
  all.filter(item => !item.parentId || !ids.has(item.parentId)).forEach(item => visit(item, 0))
  return search.value ? result.filter(item => item.name.toLowerCase().includes(search.value.toLowerCase())) : result
})

function status(item) {
  return item.status || (item.level === 'ERROR' ? 'error' : item.level === 'WARNING' ? 'warning' : 'completed')
}

function statusLabel(item) {
  return { running: 'Running', completed: 'Completed', error: 'Error', aborted: 'Aborted', warning: 'Warning' }[status(item)]
}

function iconFor(type) {
  return { AGENT: Bot, GENERATION: Sparkles, TOOL: Wrench, RETRIEVER: Database, SPAN: Layers }[type] || Layers
}

function number(value) {
  return Number(value || 0).toLocaleString('en-US')
}

function seconds(value) {
  const amount = Number(value || 0)
  return amount < 1 ? `${Math.round(amount * 1000)}ms` : `${amount.toFixed(2)}s`
}

function money(value) {
  return `$${Number(value || 0).toFixed(5)}`
}

function date(value) {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function content(value) {
  if (value == null || value === '') return 'No data recorded.'
  if (!pretty.value) return typeof value === 'string' ? value : JSON.stringify(value)
  try {
    return JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2)
  } catch {
    return String(value)
  }
}

function toggleNode(id) {
  const next = new Set(collapsed.value)
  next.has(id) ? next.delete(id) : next.add(id)
  collapsed.value = next
}

async function copyId() {
  try {
    await navigator.clipboard.writeText(props.trace.id)
    copied.value = true
    copyFailed.value = false
  } catch {
    copyFailed.value = true
  }
  clearTimeout(copyTimeout)
  copyTimeout = setTimeout(() => { copied.value = false; copyFailed.value = false }, 2200)
}

function openScore() {
  scoreOpener = document.activeElement
  scoreError.value = ''
  showScore.value = true
}

async function saveScore() {
  if (!scoreName.value.trim() || String(scoreValue.value).trim() === '' || !Number.isFinite(Number(scoreValue.value))) {
    scoreError.value = 'Enter a name and a valid score value.'
    return
  }
  saving.value = true
  scoreError.value = ''
  try {
    const response = await fetch(`/api/traces/${encodeURIComponent(props.trace.id)}/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: scoreName.value.trim(), value: Number(scoreValue.value), comment: scoreComment.value.trim() })
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw new Error(body.error || 'Could not save the score. Please try again.')
    }
    emit('scored')
    showScore.value = false
    scoreComment.value = ''
    activeTab.value = 'Scores'
  } catch (error) {
    scoreError.value = error.message
  } finally {
    saving.value = false
  }
}

function handleKey(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (showScore.value) showScore.value = false
    else emit('close')
    return
  }
  if (event.key !== 'Tab') return
  const dialog = showScore.value ? scoreDialog.value : inspector.value
  if (!dialog) return
  const focusable = [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')].filter(element => element.tabIndex >= 0 && !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden')
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first) {
    event.preventDefault()
    dialog.focus()
  } else if (!focusable.includes(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
    const target = event.shiftKey ? last : first
    event.preventDefault()
    target.focus()
  }
}

watch(showScore, async open => {
  await nextTick()
  if (open) scoreNameInput.value?.focus()
  else if (scoreOpener?.isConnected) scoreOpener.focus()
  else closeButton.value?.focus()
})

watch(() => props.trace.id, () => {
  selectedId.value = null
  activeTab.value = 'Preview'
  collapsed.value = new Set()
  search.value = ''
  showScore.value = false
})

onMounted(() => {
  previousFocus = document.activeElement
  closeButton.value?.focus()
  window.addEventListener('keydown', handleKey)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKey)
  clearTimeout(copyTimeout)
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <section ref="inspector" class="trace-inspector" role="dialog" aria-modal="true" tabindex="-1" :aria-label="`Trace: ${trace.name}`">
    <header class="inspector-header">
      <div class="header-breadcrumb"><ListTree :size="15" /><span>Traces</span><ChevronRight :size="13" /><strong>Trace details</strong></div>
      <div class="header-actions">
        <button class="inspector-icon" :class="{ bookmarked: trace.bookmarked }" :aria-label="trace.bookmarked ? 'Remove bookmark' : 'Bookmark trace'" :title="trace.bookmarked ? 'Remove bookmark' : 'Bookmark trace'" @click="emit('bookmark', trace)"><Bookmark :size="16" :fill="trace.bookmarked ? 'currentColor' : 'none'" /></button>
        <span class="header-divider"></span>
        <button ref="closeButton" class="inspector-icon" aria-label="Close trace details" title="Close (Esc)" @click="emit('close')"><X :size="18" /></button>
      </div>
    </header>

    <div class="trace-summary">
      <div class="trace-title-row">
        <span class="trace-symbol"><Workflow :size="20" /></span>
        <h2>{{ trace.name }}</h2>
        <span class="status-pill" :class="status(trace)"><span></span>{{ statusLabel(trace) }}</span>
        <button class="small-button annotate-button" @click="openScore"><Plus :size="13" /> Add score</button>
      </div>
      <div class="trace-id-row"><span class="mono">{{ trace.id }}</span><button class="inspector-icon copy-button" :aria-label="copied ? 'Copied trace ID' : 'Copy trace ID'" @click="copyId"><Check v-if="copied" :size="12" /><Copy v-else :size="12" /></button><span v-if="copied || copyFailed" class="copy-feedback">{{ copied ? 'Copied' : 'Could not copy' }}</span><span class="id-dot">·</span><span>{{ date(trace.timestamp) }}</span></div>
      <div class="trace-properties">
        <span class="property-chip">{{ trace.source === 'pi' ? 'Live Pi' : 'Sample data' }}</span>
        <span class="property-chip environment-chip"><span></span>{{ trace.environment }}</span>
        <span class="property-chip"><Clock3 :size="12" />{{ seconds(trace.latency) }}</span>
        <span class="property-chip"><Hash :size="12" />{{ number(trace.totalTokens) }} tokens</span>
        <span class="property-chip cost-chip">{{ money(trace.cost) }}</span>
        <span v-if="trace.userId" class="property-chip"><User :size="12" />{{ trace.userId }}</span>
        <button v-if="trace.sessionId" class="property-chip session-chip" @click="emit('navigate-session', trace.sessionId)"><MessageSquare :size="12" />{{ trace.sessionId }}</button>
        <span v-for="tag in trace.tags" :key="tag" class="property-chip tag-chip"><Tag :size="10" />{{ tag }}</span>
      </div>
    </div>

    <div class="inspector-content">
      <aside class="observation-sidebar">
        <div class="tree-heading"><span>Observations</span><span class="count-pill">{{ observations.length }}</span></div>
        <label class="tree-search"><Search :size="13" /><input v-model="search" placeholder="Search observations..." aria-label="Search observations" /></label>
        <div class="observation-tree">
          <button class="tree-item root-item" :class="{ selected: isRoot }" @click="selectedId = null"><Workflow :size="15" /><span class="tree-name">{{ trace.name }}</span><span class="tree-duration">{{ seconds(trace.latency) }}</span></button>
          <div v-for="item in rows" :key="item.id" class="tree-row" :class="{ selected: selectedId === item.id }" :style="{ paddingLeft: `${12 + Math.min(item.depth, 5) * 15}px` }">
            <button v-if="item.hasChildren" class="tree-expand" :aria-label="`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} ${item.name}`" @click="toggleNode(item.id)"><ChevronRight v-if="collapsed.has(item.id)" :size="12" /><ChevronDown v-else :size="12" /></button>
            <span v-else class="tree-branch"></span>
            <button class="tree-item" @click="selectedId = item.id"><component :is="iconFor(item.type)" :size="14" :class="['type-icon', item.type.toLowerCase()]" /><span class="tree-name" :title="item.name">{{ item.name }}</span><span v-if="['running', 'error', 'aborted'].includes(status(item))" class="observation-status" :class="status(item)" :title="statusLabel(item)" :aria-label="statusLabel(item)"></span><span class="tree-duration">{{ seconds(item.duration) }}</span></button>
          </div>
          <div v-if="rows.length === 0" class="tree-empty">{{ search ? 'No matching observations' : 'No observations recorded' }}</div>
        </div>
        <div class="tree-footer"><span><span class="legend-dot generation"></span>Generation</span><span><span class="legend-dot tool"></span>Tool</span><span><span class="legend-dot agent"></span>Agent</span></div>
      </aside>

      <main class="observation-panel">
        <div class="observation-title"><component :is="isRoot ? Workflow : iconFor(selected.type)" :size="17" :class="['type-icon', selected.type?.toLowerCase()]" /><h3>{{ selected.name }}</h3><span class="type-label">{{ isRoot ? 'TRACE' : selected.type }}</span><span v-if="!isRoot && selected.status" class="status-pill" :class="status(selected)"><span></span>{{ statusLabel(selected) }}</span></div>
        <div class="observation-stats"><span><Clock3 :size="12" />{{ seconds(duration) }}</span><span v-if="selected.model"><Sparkles :size="12" />{{ selected.model }}</span><span><ArrowUp :size="12" />{{ number(selected.inputTokens) }}</span><span><ArrowDown :size="12" />{{ number(selected.outputTokens) }}</span><span v-if="cacheRead" :title="`${number(cacheRead)} tokens read from the prompt cache`">Cache read {{ number(cacheRead) }}</span><span v-if="cacheWrite" :title="`${number(cacheWrite)} tokens written to the prompt cache`">Cache write {{ number(cacheWrite) }}</span><span class="observation-cost">{{ money(selected.cost) }}</span></div>
        <div class="detail-tabs"><button v-for="tab in ['Preview', 'Timeline', 'Scores', 'Metadata']" :key="tab" :class="{ active: activeTab === tab }" @click="activeTab = tab">{{ tab }}<span v-if="tab === 'Scores' && scores.length" class="tab-count">{{ scores.length }}</span></button></div>

        <div class="detail-scroll">
          <template v-if="activeTab === 'Preview'">
            <div class="preview-toolbar"><span>Input & output</span><div class="format-switch"><button :class="{ active: pretty }" @click="pretty = true"><Braces :size="12" />Formatted</button><button :class="{ active: !pretty }" @click="pretty = false">Raw</button></div></div>
            <section class="data-card"><div class="data-card-heading"><ArrowUp :size="13" /><h4>Input</h4><span v-if="selected.inputTokens">{{ number(selected.inputTokens) }} tokens</span></div><pre>{{ content(selected.input) }}</pre></section>
            <section class="data-card output-card"><div class="data-card-heading"><ArrowDown :size="13" /><h4>Output</h4><span v-if="selected.outputTokens">{{ number(selected.outputTokens) }} tokens</span></div><pre>{{ content(selected.output) }}</pre></section>
            <div class="preview-footnote"><Terminal :size="12" />{{ isRoot ? `${observations.length} observations in this trace` : `${number(selectedTokens)} total tokens` }}<span v-if="trace.version">Version {{ trace.version }}</span></div>
          </template>

          <template v-else-if="activeTab === 'Timeline'">
            <div class="section-title"><div><h4>Trace timeline</h4><p>Observation duration and execution order.</p></div><span class="timing-total">{{ seconds(trace.latency) }}</span></div>
            <div class="timeline-axis"><span>0s</span><span>{{ seconds(trace.latency / 2) }}</span><span>{{ seconds(trace.latency) }}</span></div>
            <button v-for="item in observations" :key="item.id" class="timeline-row" :class="{ chosen: selectedId === item.id }" @click="selectedId = item.id"><span class="timeline-label"><component :is="iconFor(item.type)" :size="13" :class="['type-icon', item.type.toLowerCase()]" /><span>{{ item.name }}</span><small>{{ seconds(item.duration) }}</small></span><span class="timeline-track"><span :class="['timeline-bar', item.type.toLowerCase()]" :style="{ left: `${Math.min(98, Math.max(0, Number(item.startTime || 0) / Math.max(trace.latency, 0.001) * 100))}%`, width: `${Math.max(1, Math.min(100 - Math.max(0, Number(item.startTime || 0) / Math.max(trace.latency, 0.001) * 100), Number(item.duration || 0) / Math.max(trace.latency, 0.001) * 100))}%` }"></span></span></button>
            <div v-if="!observations.length" class="empty-state"><Clock3 :size="27" /><h4>No timeline data</h4><p>There are no observations in this trace.</p></div>
          </template>

          <template v-else-if="activeTab === 'Scores'">
            <div class="section-title"><div><h4>Trace scores</h4><p>Evaluate quality and track agent performance.</p></div><button class="small-button" @click="openScore"><Plus :size="13" />Add score</button></div>
            <div v-if="!scores.length" class="empty-state"><MessageSquare :size="28" /><h4>No scores yet</h4><p>Add a score to evaluate this trace.</p><button class="small-button" @click="openScore"><Plus :size="13" />Add score</button></div>
            <article v-for="score in scores" :key="score.id" class="score-card"><div class="score-card-top"><span class="score-name">{{ score.name }}</span><span class="score-value" :class="{ low: Number(score.value) < 0.5 }">{{ Number(score.value).toLocaleString('en-US', { maximumFractionDigits: 4 }) }}</span></div><p v-if="score.comment">{{ score.comment }}</p><div class="score-card-bottom"><span class="score-source">{{ score.source }}</span><span>{{ date(score.timestamp) }}</span></div></article>
          </template>

          <template v-else>
            <div class="section-title"><div><h4>Metadata</h4><p>Properties recorded with this {{ isRoot ? 'trace' : 'observation' }}.</p></div><Braces :size="16" /></div>
            <dl class="metadata-properties"><div><dt>ID</dt><dd class="mono">{{ selected.id }}</dd></div><div><dt>Type</dt><dd>{{ isRoot ? 'TRACE' : selected.type }}</dd></div><div><dt>Status</dt><dd>{{ statusLabel(selected) }}</dd></div><div><dt>Level</dt><dd>{{ selected.level || 'DEFAULT' }}</dd></div><div v-if="selected.model"><dt>Model</dt><dd>{{ selected.model }}</dd></div><div v-if="isRoot && trace.version"><dt>Version</dt><dd>{{ trace.version }}</dd></div><div><dt>Total cost</dt><dd>{{ money(selected.cost) }}</dd></div></dl>
            <section class="data-card"><div class="data-card-heading"><Braces :size="13" /><h4>Custom metadata</h4></div><pre>{{ JSON.stringify(selected.metadata || {}, null, 2) }}</pre></section>
          </template>
        </div>
      </main>
    </div>

    <div v-if="showScore" class="score-modal-backdrop" @click.self="showScore = false">
      <form ref="scoreDialog" class="score-modal" role="dialog" aria-modal="true" aria-label="Add score" tabindex="-1" @submit.prevent="saveScore">
        <div class="modal-heading"><div><h3>Add score</h3><p>Evaluate this trace with a numeric score.</p></div><button class="inspector-icon" type="button" aria-label="Close score form" @click="showScore = false"><X :size="17" /></button></div>
        <label>Score name<input ref="scoreNameInput" v-model="scoreName" required placeholder="e.g. quality, helpfulness" /></label>
        <label>Value<input v-model="scoreValue" required type="number" step="any" placeholder="0.0" /></label>
        <label>Comment <span class="optional">optional</span><textarea v-model="scoreComment" rows="3" placeholder="Add context for this score..."></textarea></label>
        <p v-if="scoreError" class="score-error" role="alert">{{ scoreError }}</p>
        <div class="modal-footer"><button type="button" class="small-button" :disabled="saving" @click="showScore = false">Cancel</button><button type="submit" class="small-button save-score" :disabled="saving">{{ saving ? 'Saving...' : 'Save score' }}</button></div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.trace-inspector { position: fixed; z-index: 40; top: 12px; right: 12px; bottom: 12px; width: min(1080px, calc(100vw - 36px)); display: flex; flex-direction: column; background: var(--bg, #fff); color: var(--text, #18181b); border: 1px solid var(--border, #e4e4e7); border-radius: 9px; box-shadow: 0 24px 80px #0003, 0 0 0 1px #00000003; overflow: hidden; font-size: 12px; text-align: left; }
.trace-inspector button, .trace-inspector input, .trace-inspector textarea { font: inherit; }
.trace-inspector button { cursor: pointer; }
.trace-inspector button:focus-visible, .trace-inspector input:focus-visible, .trace-inspector textarea:focus-visible { outline: 2px solid #a1a1aa; outline-offset: 2px; }
.inspector-header { height: 49px; min-height: 49px; padding: 0 17px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); }
.header-breadcrumb, .header-actions { display: flex; align-items: center; gap: 10px; color: var(--muted); }
.header-breadcrumb strong { color: var(--text); font-weight: 500; }
.header-actions { gap: 8px; }
.header-divider { width: 1px; height: 17px; background: var(--border); }
.inspector-icon { border: 0; background: transparent; color: var(--muted); width: 27px; height: 27px; border-radius: 5px; display: inline-flex; justify-content: center; align-items: center; padding: 0; flex-shrink: 0; }
.inspector-icon:hover { background: var(--surface); color: var(--text); }
.inspector-icon.bookmarked { color: #e99516; }
.trace-summary { padding: 22px 24px 20px; border-bottom: 1px solid var(--border); }
.trace-title-row { display: flex; gap: 10px; align-items: center; }
.trace-symbol { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 7px; border: 1px solid var(--border); background: var(--surface); }
.trace-title-row h2 { font-size: 19px; letter-spacing: -.45px; font-weight: 600; margin: 0; overflow: hidden; text-overflow: ellipsis; }
.status-pill { display: inline-flex; align-items: center; gap: 5px; color: #18875c; background: #10b98110; padding: 3px 7px; font-size: 10px; border-radius: 4px; white-space: nowrap; }
.status-pill > span { height: 5px; width: 5px; border-radius: 50%; background: currentColor; }
.status-pill.error { color: #dc4c4c; background: #ef444410; }
.status-pill.running { color: #60a5fa; background: #3b82f615; }
.status-pill.aborted, .status-pill.warning { color: #c68a17; background: #f59e0b10; }
.small-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 5px; height: 30px; padding: 0 10px; font-size: 11px; font-weight: 500; white-space: nowrap; box-shadow: 0 1px 2px #00000003; }
.small-button:hover { background: var(--surface); border-color: #a1a1aa; }
.small-button:disabled { opacity: .5; cursor: wait; }
.annotate-button { margin-left: auto; }
.trace-id-row { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 10px; margin-top: 6px; min-height: 24px; }
.mono { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; }
.copy-button { width: 19px; height: 20px; }
.copy-feedback { color: #18875c; }
.id-dot { margin: 0 4px; }
.trace-properties { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.property-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 7px; border: 1px solid var(--border); border-radius: 4px; color: var(--muted); background: var(--bg); font-size: 10px; line-height: 13px; }
.environment-chip { color: var(--text); }
.environment-chip > span { width: 5px; height: 5px; background: #22a06b; border-radius: 50%; }
.cost-chip { color: var(--text); font-variant-numeric: tabular-nums; }
.tag-chip { border-color: transparent; background: var(--surface); }
.session-chip:hover { color: var(--text); border-color: #a1a1aa; }
.inspector-content { display: flex; flex: 1; min-height: 0; }
.observation-sidebar { width: 302px; min-width: 240px; flex-shrink: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
.tree-heading { height: 48px; padding: 0 16px; display: flex; align-items: center; gap: 7px; font-weight: 550; }
.count-pill { background: var(--surface); color: var(--muted); font-size: 10px; padding: 1px 5px; font-weight: 400; border: 1px solid var(--border); border-radius: 4px; }
.tree-search { margin: 0 12px 12px; height: 29px; border: 1px solid var(--border); border-radius: 5px; display: flex; align-items: center; gap: 7px; padding: 0 8px; color: var(--muted); }
.tree-search input { width: 100%; min-width: 0; border: 0; background: transparent; color: var(--text); font-size: 11px; outline: none; padding: 0; }
.observation-tree { padding: 0 7px 16px; overflow-y: auto; flex: 1; }
.tree-item { display: flex; align-items: center; gap: 7px; padding: 10px 7px; width: 100%; min-width: 0; border: 0; border-radius: 4px; background: transparent; text-align: left; color: var(--text); font-size: 11px; }
.tree-item > svg { flex-shrink: 0; }
.root-item { padding-left: 10px; font-weight: 500; margin-bottom: 3px; }
.tree-row { display: flex; align-items: center; border-radius: 4px; position: relative; }
.tree-row .tree-item { padding-left: 4px; }
.tree-row:hover, .root-item:hover { background: var(--surface); }
.tree-row.selected, .root-item.selected { background: #f9731610; }
.tree-row.selected .tree-name, .root-item.selected .tree-name { color: #e57820; }
.tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-duration { color: var(--muted); margin-left: auto; font-family: 'SFMono-Regular', Consolas, monospace; font-size: 9px; white-space: nowrap; padding-left: 3px; }
.tree-expand { flex-shrink: 0; width: 16px; height: 23px; padding: 0; display: grid; place-items: center; border: 0; background: transparent; color: var(--muted); }
.tree-branch { width: 16px; height: 11px; flex-shrink: 0; position: relative; }
.tree-branch::before { content: ''; position: absolute; top: -14px; left: 6px; width: 8px; height: 20px; border-left: 1px solid var(--border); border-bottom: 1px solid var(--border); border-bottom-left-radius: 3px; }
.type-icon { color: #7c8595; flex-shrink: 0; }
.type-icon.generation { color: #9961cf; }
.type-icon.agent { color: #4c88d5; }
.type-icon.tool { color: #db9243; }
.type-icon.retriever { color: #2ba99b; }
.observation-status { width: 5px; height: 5px; flex-shrink: 0; border-radius: 50%; background: #ef4444; }
.observation-status.running { background: #60a5fa; }
.observation-status.aborted { background: #c68a17; }
.tree-empty { text-align: center; padding: 25px 8px; color: var(--muted); font-size: 11px; }
.tree-footer { display: flex; gap: 14px; justify-content: center; padding: 13px 9px; border-top: 1px solid var(--border); color: var(--muted); font-size: 9px; }
.tree-footer > span { display: inline-flex; gap: 5px; align-items: center; }
.legend-dot { height: 5px; width: 5px; border-radius: 2px; }
.legend-dot.generation { background: #9961cf; }
.legend-dot.tool { background: #db9243; }
.legend-dot.agent { background: #4c88d5; }
.observation-panel { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.observation-title { padding: 20px 22px 0; display: flex; gap: 8px; align-items: center; }
.observation-title h3 { margin: 0; font-size: 14px; font-weight: 550; letter-spacing: -.2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.type-label { color: var(--muted); font-size: 8px; font-weight: 550; letter-spacing: .35px; background: var(--surface); border: 1px solid var(--border); padding: 2px 4px; border-radius: 3px; margin-left: 2px; }
.observation-stats { display: flex; flex-wrap: wrap; gap: 15px; padding: 11px 22px 17px; color: var(--muted); font-size: 10px; }
.observation-stats > span { display: inline-flex; gap: 4px; align-items: center; }
.observation-stats > .observation-cost { margin-left: auto; color: var(--text); }
.detail-tabs { display: flex; gap: 19px; padding: 0 22px; border-bottom: 1px solid var(--border); }
.detail-tabs > button { position: relative; display: flex; gap: 5px; align-items: center; height: 37px; padding: 0 0 10px; color: var(--muted); border: 0; background: transparent; font-size: 11px; }
.detail-tabs > button.active { color: var(--text); font-weight: 550; }
.detail-tabs > button.active::after { content: ''; position: absolute; height: 2px; background: var(--text); bottom: -1px; left: 0; right: 0; border-radius: 2px; }
.tab-count { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; font-size: 9px; line-height: 14px; font-weight: 400; }
.detail-scroll { overflow-y: auto; flex: 1; min-height: 0; padding: 20px 22px; }
.preview-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.preview-toolbar > span { font-weight: 500; font-size: 11px; }
.format-switch { display: flex; gap: 2px; background: var(--surface); border: 1px solid var(--border); padding: 2px; border-radius: 5px; }
.format-switch > button { height: 24px; display: flex; align-items: center; gap: 5px; border: 1px solid transparent; border-radius: 3px; padding: 0 8px; background: transparent; color: var(--muted); font-size: 9px; }
.format-switch > button.active { color: var(--text); background: var(--bg); border-color: var(--border); box-shadow: 0 1px 2px #00000005; }
.data-card { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; margin-bottom: 17px; }
.data-card-heading { display: flex; align-items: center; gap: 6px; background: var(--surface); min-height: 36px; padding: 0 13px; border-bottom: 1px solid var(--border); color: var(--muted); }
.data-card-heading h4 { color: var(--text); font-size: 11px; font-weight: 500; margin: 0; }
.data-card-heading > span { margin-left: auto; font-size: 9px; }
.data-card pre { font: 11px/1.85 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); padding: 16px; margin: 0; min-height: 65px; max-height: 560px; overflow-y: auto; }
.output-card pre { line-height: 1.9; }
.preview-footnote { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 9px; }
.preview-footnote > span { margin-left: auto; }
.section-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; gap: 12px; }
.section-title h4 { margin: 0; font-size: 12px; font-weight: 550; }
.section-title p { margin: 6px 0 0; color: var(--muted); font-size: 10px; line-height: 1.6; }
.timing-total { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 10px; color: var(--muted); }
.timeline-axis { display: flex; justify-content: space-between; font-size: 9px; color: var(--muted); margin: 0 0 10px; }
.timeline-row { display: block; width: 100%; text-align: left; border: 1px solid transparent; border-bottom-color: var(--border); padding: 11px 7px 13px; background: transparent; color: var(--text); }
.timeline-row:hover, .timeline-row.chosen { background: var(--surface); border-radius: 4px; }
.timeline-label { display: flex; align-items: center; gap: 7px; font-size: 10px; }
.timeline-label > span { text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
.timeline-label small { margin-left: auto; color: var(--muted); font-size: 9px; }
.timeline-track { display: block; position: relative; height: 7px; background: var(--surface); border-radius: 2px; margin-top: 9px; overflow: hidden; }
.timeline-bar { display: block; position: absolute; top: 0; bottom: 0; background: #94a3b8; border-radius: 2px; opacity: .8; }
.timeline-bar.agent { background: #4c88d5; }
.timeline-bar.generation { background: #9961cf; }
.timeline-bar.tool { background: #db9243; }
.timeline-bar.retriever { background: #2ba99b; }
.empty-state { display: flex; align-items: center; flex-direction: column; padding: 50px 16px; color: var(--muted); }
.empty-state h4 { color: var(--text); font-weight: 500; margin: 16px 0 0; }
.empty-state p { font-size: 11px; margin: 7px 0 18px; }
.score-card { border: 1px solid var(--border); border-radius: 6px; padding: 15px; margin-bottom: 11px; }
.score-card-top { display: flex; gap: 12px; align-items: center; }
.score-name { font-weight: 550; font-size: 12px; }
.score-value { margin-left: auto; color: #18875c; background: #10b98110; border: 1px solid #10b98120; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-variant-numeric: tabular-nums; }
.score-value.low { color: #bf8131; background: #f59e0b10; border-color: #f59e0b20; }
.score-card > p { color: var(--muted); font-size: 11px; line-height: 1.7; margin: 11px 0; white-space: pre-wrap; }
.score-card-bottom { display: flex; align-items: center; gap: 10px; font-size: 9px; color: var(--muted); margin-top: 13px; }
.score-source { border: 1px solid var(--border); background: var(--surface); border-radius: 3px; padding: 2px 4px; font-size: 8px; }
.metadata-properties { border: 1px solid var(--border); border-radius: 6px; margin: 0 0 20px; }
.metadata-properties > div { display: grid; grid-template-columns: 105px 1fr; padding: 11px 13px; border-bottom: 1px solid var(--border); font-size: 11px; }
.metadata-properties > div:last-child { border-bottom: 0; }
.metadata-properties dt { color: var(--muted); }
.metadata-properties dd { margin: 0; overflow-wrap: anywhere; }
.score-modal-backdrop { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; background: #09090b59; padding: 20px; backdrop-filter: blur(2px); }
.score-modal { width: min(390px, 100%); background: var(--bg); border: 1px solid var(--border); border-radius: 9px; padding: 22px; box-shadow: 0 20px 80px #0003; }
.modal-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 22px; }
.modal-heading h3 { margin: 0; font-size: 16px; font-weight: 550; }
.modal-heading p { color: var(--muted); font-size: 11px; margin: 7px 0 0; }
.score-modal > label { display: flex; flex-wrap: wrap; gap: 6px; font-weight: 500; font-size: 11px; margin-bottom: 16px; }
.score-modal input, .score-modal textarea { display: block; width: 100%; box-sizing: border-box; border: 1px solid var(--border); background: var(--bg); border-radius: 5px; padding: 9px 10px; color: var(--text); font-weight: 400; resize: vertical; }
.optional { color: var(--muted); font-weight: 400; }
.score-error { color: #dc4c4c; font-size: 11px; line-height: 1.5; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding-top: 6px; }
.small-button.save-score { background: var(--text); color: var(--bg); border-color: var(--text); }
@media (max-width: 800px) { .observation-sidebar { width: 240px; min-width: 210px; } .trace-summary { padding: 17px; } .trace-properties { gap: 5px; } .trace-id-row { flex-wrap: wrap; } .trace-title-row h2 { font-size: 16px; } .detail-scroll { padding: 17px; } .observation-title { padding-left: 17px; padding-right: 17px; } .observation-stats { padding-left: 17px; padding-right: 17px; gap: 9px; } }
@media (max-width: 580px) { .trace-inspector { width: calc(100vw - 16px); top: 8px; bottom: 8px; right: 8px; } .observation-sidebar { width: 145px; min-width: 145px; } .tree-heading { padding: 0 10px; font-size: 10px; } .tree-search { margin: 0 7px 10px; padding: 0 5px; } .tree-search input { font-size: 9px; } .tree-item { font-size: 9px; gap: 5px; } .tree-duration { display: none; } .tree-footer { flex-wrap: wrap; gap: 8px; font-size: 8px; } .trace-title-row { flex-wrap: wrap; gap: 7px; } .trace-title-row h2 { font-size: 15px; } .trace-title-row .annotate-button { height: 27px; } .trace-symbol { width: 28px; height: 28px; } .trace-id-row { font-size: 8px; } .trace-properties { margin-top: 10px; } .property-chip { font-size: 9px; padding: 3px 5px; } .session-chip { max-width: 150px; overflow: hidden; } .observation-title h3 { font-size: 11px; } .type-label { display: none; } .detail-tabs { gap: 11px; padding: 0 12px; } .detail-tabs > button { font-size: 9px; } .detail-scroll { padding: 12px; } .data-card pre { padding: 10px; font-size: 9px; } .preview-toolbar { gap: 6px; flex-wrap: wrap; } .preview-toolbar > span { font-size: 10px; } .preview-footnote { flex-wrap: wrap; font-size: 8px; } .metadata-properties > div { grid-template-columns: 1fr; gap: 5px; font-size: 10px; } .section-title { align-items: flex-start; flex-wrap: wrap; } }
</style>
