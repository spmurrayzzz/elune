<script setup>
import { computed, ref } from 'vue'
import { Activity, ArrowUpRight, Clock3, Coins, Hash, ListTree } from 'lucide-vue-next'

const props = defineProps({ overview: { type: Object, default: () => ({}) }, traces: { type: Array, default: () => [] } })
const emit = defineEmits(['navigate-traces', 'inspect'])
const metric = ref('count')
const metrics = [{ key: 'count', label: 'Count' }, { key: 'cost', label: 'Cost' }, { key: 'latency', label: 'Latency' }]
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
const integer = value => number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
const compact = value => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number(value))
const money = (value, digits = 2) => number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
const duration = value => `${number(value).toFixed(2)}s`
const traceStatus = trace => trace.status || (trace.level === 'ERROR' ? 'error' : trace.level === 'WARNING' ? 'warning' : 'completed')
const statusLabel = trace => ({running:'Running',completed:'Completed',error:'Error',aborted:'Aborted',warning:'Warning'}[traceStatus(trace)])
const date = value => {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
const timestamp = value => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
const series = computed(() => props.overview.series || [])
const models = computed(() => [...(props.overview.models || [])].sort((a, b) => number(b.tokens) - number(a.tokens)))
const modelMaximum = computed(() => Math.max(1, ...models.value.map(model => number(model.tokens))))
const recentTraces = computed(() => [...props.traces].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 5))
const chartMaximum = computed(() => {
  const maximum = Math.max(0, ...series.value.map(point => number(point[metric.value])))
  if (!maximum) return 1
  const unit = 10 ** Math.floor(Math.log10(maximum))
  return Math.ceil(maximum / unit) * unit
})
const chartPoints = computed(() => series.value.map((point, index) => ({
  ...point,
  value: number(point[metric.value]),
  x: 54 + (index + 0.5) * 674 / Math.max(series.value.length, 1),
  y: 204 - number(point[metric.value]) / chartMaximum.value * 172,
})))
const barWidth = computed(() => Math.max(2, Math.min(52, 674 / Math.max(series.value.length, 1) * 0.52)))
const chartTicks = computed(() => Array.from({ length: 5 }, (_, index) => ({ y: 32 + index * 43, value: chartMaximum.value * (4 - index) / 4 })))
const visibleLabel = index => index === series.value.length - 1 || index % Math.max(1, Math.ceil(series.value.length / 7)) === 0
const chartValue = value => metric.value === 'cost' ? money(value) : metric.value === 'latency' ? duration(value) : compact(value)
const chartTotal = computed(() => metric.value === 'count' ? integer(props.overview.totalTraces) : metric.value === 'cost' ? money(props.overview.totalCost) : duration(props.overview.avgLatency))
const latencyMaximum = computed(() => Math.max(0.01, ...series.value.map(point => number(point.latency))))
const errorRate = computed(() => `${number(props.overview.errorRate).toFixed(1)}%`)
</script>

<template>
  <div class="overview">
    <section class="kpi-grid" aria-label="Project metrics">
      <article class="panel kpi-card">
        <div class="kpi-label"><span>Total traces</span><ListTree :size="15" /></div>
        <strong>{{ integer(overview.totalTraces) }}</strong>
        <span class="kpi-caption"><span class="metric-dot purple"></span> Across all applications</span>
      </article>
      <article class="panel kpi-card">
        <div class="kpi-label"><span>Total model cost</span><Coins :size="15" /></div>
        <strong>{{ money(overview.totalCost) }}</strong>
        <span class="kpi-caption">Input and output token cost</span>
      </article>
      <article class="panel kpi-card">
        <div class="kpi-label"><span>Average latency</span><Clock3 :size="15" /></div>
        <strong>{{ duration(overview.avgLatency) }}</strong>
        <span class="kpi-caption">End-to-end trace duration</span>
      </article>
      <article class="panel kpi-card">
        <div class="kpi-label"><span>Total tokens</span><Hash :size="15" /></div>
        <strong :title="integer(overview.totalTokens)">{{ compact(overview.totalTokens) }}</strong>
        <span class="kpi-caption">{{ integer(overview.totalTokens) }} tokens processed</span>
      </article>
    </section>

    <div class="dashboard-grid">
      <section class="panel volume-card">
        <header class="card-header">
          <div><h2>Trace activity</h2><p>Requests over time</p></div>
          <div class="segmented" aria-label="Chart metric">
            <button v-for="item in metrics" :key="item.key" :class="{ selected: metric === item.key }" :aria-pressed="metric === item.key" @click="metric = item.key">{{ item.label }}</button>
          </div>
        </header>
        <div class="chart-summary"><strong>{{ chartTotal }}</strong><span>{{ metric === 'latency' ? 'average latency' : metric === 'cost' ? 'total cost' : 'traces in this period' }}</span></div>
        <div v-if="series.length" class="chart-container">
          <svg viewBox="0 0 756 246" role="img" :aria-label="`${metric} by day`" class="volume-chart">
            <defs><linearGradient id="overview-bar-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--accent)" stop-opacity="0.88" /><stop offset="100%" stop-color="var(--accent)" stop-opacity="0.56" /></linearGradient></defs>
            <g v-for="tick in chartTicks" :key="tick.y"><line x1="54" x2="738" :y1="tick.y" :y2="tick.y" class="gridline" /><text x="43" :y="tick.y + 4" text-anchor="end" class="axis-label">{{ chartValue(tick.value) }}</text></g>
            <g v-for="(point, index) in chartPoints" :key="`${point.date}-${index}`">
              <rect :x="point.x - barWidth / 2" :y="point.y" :width="barWidth" :height="Math.max(0, 204 - point.y)" rx="3" fill="url(#overview-bar-fill)" class="volume-bar"><title>{{ date(point.date) }}: {{ chartValue(point.value) }}</title></rect>
              <text v-if="visibleLabel(index)" :x="point.x" y="230" text-anchor="middle" class="axis-label">{{ date(point.date) }}</text>
            </g>
          </svg>
        </div>
        <div v-else class="empty-chart">No activity in this period.</div>
        <footer class="chart-footer"><span class="metric-dot purple"></span>{{ metrics.find(item => item.key === metric)?.label }}<span class="footer-spacer"></span><span>Daily aggregation</span></footer>
      </section>

      <section class="panel model-card">
        <header class="card-header"><div><h2>Model usage</h2><p>Token consumption by model</p></div><Hash :size="15" class="muted-icon" /></header>
        <div class="model-list">
          <div v-for="(model, index) in models.slice(0, 5)" :key="model.name" class="model-row">
            <div class="model-row-label"><span :title="model.name">{{ model.name }}</span><strong>{{ compact(model.tokens) }}</strong></div>
            <div class="model-track"><div :style="{ width: `${number(model.tokens) / modelMaximum * 100}%`, opacity: 1 - index * 0.12 }"></div></div>
            <div class="model-meta"><span>{{ integer(model.count) }} calls</span><span>{{ money(model.cost) }}</span></div>
          </div>
          <div v-if="!models.length" class="empty-models">No model usage in this period.</div>
        </div>
        <footer class="model-total"><span>Total tokens</span><strong>{{ compact(overview.totalTokens) }}</strong></footer>
      </section>

      <section class="panel recent-card">
        <header class="card-header"><div><h2>Recent traces</h2><p>The latest activity in your project</p></div><button class="text-button" @click="emit('navigate-traces')">View all <ArrowUpRight :size="13" /></button></header>
        <div class="recent-table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Timestamp</th><th class="numeric">Latency</th><th class="numeric">Cost</th><th>Status</th></tr></thead>
            <tbody>
              <tr v-for="trace in recentTraces" :key="trace.id" tabindex="0" :aria-label="`Open trace ${trace.name}`" @click="emit('inspect', trace)" @keydown.enter="emit('inspect', trace)" @keydown.space.prevent="emit('inspect', trace)">
                <td><div class="trace-name"><ListTree :size="13" /><span>{{ trace.name }}</span></div></td>
                <td class="timestamp">{{ timestamp(trace.timestamp) }}</td>
                <td class="numeric">{{ duration(trace.latency) }}</td>
                <td class="numeric">{{ money(trace.cost, 4) }}</td>
                <td><span class="status" :class="traceStatus(trace)"><span class="metric-dot"></span>{{ statusLabel(trace) }}</span></td>
              </tr>
              <tr v-if="!recentTraces.length"><td colspan="5" class="empty-table">No traces in this period.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel latency-card">
        <header class="card-header"><div><h2>Latency & quality</h2><p>Application health at a glance</p></div><Activity :size="15" class="muted-icon" /></header>
        <div class="latency-summary"><strong>{{ duration(overview.avgLatency) }}</strong><span>Average trace latency</span></div>
        <div class="latency-bars" role="img" aria-label="Average daily latency">
          <div v-for="(point, index) in series" :key="`${point.date}-${index}`" class="latency-bar" :style="{ height: `${Math.max(3, number(point.latency) / latencyMaximum * 100)}%` }" :title="`${date(point.date)}: ${duration(point.latency)}`"></div>
          <span v-if="!series.length" class="muted-icon">No latency data</span>
        </div>
        <div class="latency-labels"><span>{{ series.length ? date(series[0].date) : '' }}</span><span>{{ series.length > 1 ? date(series[series.length - 1].date) : '' }}</span></div>
        <div class="health-stat"><span><span class="metric-dot" :class="number(overview.errorRate) > 0 ? 'amber' : 'green'"></span>Error rate</span><strong>{{ errorRate }}</strong></div>
        <div class="health-stat"><span><span class="metric-dot purple"></span>Average score</span><strong>{{ overview.scoreAverage == null ? '—' : number(overview.scoreAverage).toFixed(2) }}</strong></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.overview { padding: 0 0 20px; margin: 0; width: 100%; min-height: 0; overflow: auto; flex: 1; color: var(--text); }
button { font: inherit; cursor: pointer; }
.panel { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; min-width: 0; }
.kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-bottom: 22px; }
.kpi-card { padding: 17px 19px 16px; }
.kpi-label { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; font-weight: 500; }
.kpi-label svg { color: var(--muted); stroke-width: 1.6; }
.kpi-card > strong { display: block; font-size: 29px; letter-spacing: -1px; font-weight: 600; line-height: 1.3; margin: 14px 0 8px; font-variant-numeric: tabular-nums; }
.kpi-caption { color: var(--muted); display: flex; align-items: center; gap: 6px; font-size: 11px; min-height: 16px; }
.metric-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: currentColor; }
.purple { background: var(--accent); }
.green { background: #37a878; }
.amber { background: #ce9638; }
.dashboard-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 22px 20px; }
.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 18px 20px 0; }
.card-header h2 { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; }
.card-header p { color: var(--muted); font-size: 11px; margin: 4px 0 0; line-height: 17px; }
.muted-icon { color: var(--muted); }
.segmented { display: inline-flex; padding: 3px; border: 1px solid var(--border); background: var(--bg); border-radius: 6px; gap: 2px; }
.segmented button { border: 0; color: var(--muted); background: transparent; padding: 3px 9px; border-radius: 4px; font-size: 11px; line-height: 18px; }
.segmented button.selected { color: var(--text); background: var(--surface); box-shadow: 0 1px 3px #00000012; }
.segmented button:hover { color: var(--text); }
.chart-summary { display: flex; align-items: baseline; gap: 9px; margin: 19px 20px 0; }
.chart-summary strong { font-size: 22px; font-weight: 600; letter-spacing: -0.6px; font-variant-numeric: tabular-nums; }
.chart-summary span { font-size: 11px; color: var(--muted); }
.chart-container { padding: 0 12px 0 8px; }
.volume-chart { width: 100%; height: 228px; display: block; overflow: visible; }
.gridline { stroke: var(--border); stroke-width: 1; stroke-dasharray: 3 4; }
.axis-label { fill: var(--muted); font-size: 10px; font-family: inherit; }
.volume-bar { transition: y .2s, height .2s; }
.volume-bar:hover { opacity: .7; }
.chart-footer { margin-top: 3px; border-top: 1px solid var(--border); min-height: 40px; display: flex; align-items: center; gap: 6px; padding: 0 20px; font-size: 10px; color: var(--muted); }
.footer-spacer { flex: 1; }
.model-card { display: flex; flex-direction: column; }
.model-list { padding: 23px 20px 10px; flex: 1; display: flex; flex-direction: column; gap: 17px; }
.model-row-label { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 11px; line-height: 16px; }
.model-row-label > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-row-label > strong { font-weight: 500; font-variant-numeric: tabular-nums; }
.model-track { height: 5px; background: var(--bg); border-radius: 3px; overflow: hidden; margin: 7px 0 5px; }
.model-track > div { height: 100%; background: var(--accent); border-radius: inherit; }
.model-meta { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); }
.model-total { border-top: 1px solid var(--border); padding: 12px 20px; display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.model-total strong { color: var(--text); font-weight: 500; }
.recent-card .card-header { margin-bottom: 20px; }
.text-button { border: 0; padding: 2px 0; display: inline-flex; gap: 5px; align-items: center; background: none; color: var(--muted); font-size: 11px; white-space: nowrap; }
.text-button:hover { color: var(--accent); }
.recent-table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 11px; white-space: nowrap; }
th { padding: 10px 13px; color: var(--muted); font-size: 10px; font-weight: 500; text-align: left; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg); }
th:first-child, td:first-child { padding-left: 20px; }
th:last-child, td:last-child { padding-right: 20px; }
td { padding: 14px 13px; border-bottom: 1px solid var(--border); }
tbody tr:last-child td { border-bottom: 0; }
tbody tr[tabindex] { cursor: pointer; }
tbody tr[tabindex]:hover, tbody tr[tabindex]:focus-visible { background: var(--bg); outline-color: var(--accent); }
.trace-name { display: flex; align-items: center; gap: 7px; }
.trace-name svg { color: var(--accent); flex: 0 0 auto; }
.trace-name > span { max-width: 195px; overflow: hidden; text-overflow: ellipsis; }
.numeric { text-align: right; font-variant-numeric: tabular-nums; }
.timestamp { color: var(--muted); font-size: 10px; }
.status { display: inline-flex; align-items: center; gap: 5px; padding: 2px 5px; border-radius: 4px; color: #26875f; background: #eef9f2; font-size: 10px; }
.status.error { color: #c44949; background: #fef0f0; }
.status.warning, .status.aborted { color: #a77423; background: #fdf7e9; }
.status.running { color: #3873c0; background: #eaf2fd; }
.status .metric-dot { width: 4px; height: 4px; }
.latency-summary { display: flex; flex-direction: column; gap: 4px; margin: 19px 20px 0; }
.latency-summary strong { font-size: 25px; font-weight: 600; letter-spacing: -0.7px; font-variant-numeric: tabular-nums; }
.latency-summary span { color: var(--muted); font-size: 11px; }
.latency-bars { margin: 18px 20px 0; height: 56px; display: flex; align-items: flex-end; gap: 4px; }
.latency-bar { flex: 1; min-width: 1px; background: var(--accent); opacity: .38; border-radius: 2px 2px 0 0; }
.latency-bar:hover { opacity: .9; }
.latency-labels { padding: 6px 20px 13px; display: flex; justify-content: space-between; color: var(--muted); font-size: 10px; }
.health-stat { border-top: 1px solid var(--border); padding: 13px 20px; display: flex; justify-content: space-between; gap: 20px; font-size: 11px; }
.health-stat > span { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.health-stat strong { font-weight: 500; font-variant-numeric: tabular-nums; }
.empty-chart { display: grid; place-items: center; min-height: 228px; color: var(--muted); font-size: 12px; }
.empty-models { color: var(--muted); font-size: 12px; padding: 40px 0; text-align: center; }
.empty-table { text-align: center; color: var(--muted); padding: 55px 20px; }
@media (min-width: 1500px) { .volume-chart { height: 244px; } .model-list { gap: 20px; } }
@media (max-width: 1100px) { .kpi-grid { gap: 12px; } .kpi-card { padding: 15px; } .dashboard-grid { grid-template-columns: minmax(0, 1.65fr) minmax(265px, 1fr); gap: 16px; } .card-header { padding-left: 16px; padding-right: 16px; } .segmented button { padding-left: 6px; padding-right: 6px; } }
@media (max-width: 860px) { .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .dashboard-grid { grid-template-columns: minmax(0, 1fr); } .model-list { display: grid; grid-template-columns: 1fr 1fr; padding-bottom: 20px; } .volume-chart { height: 240px; } }
@media (max-width: 520px) { .kpi-card > strong { font-size: 25px; } .kpi-label { font-size: 11px; } .kpi-caption { font-size: 10px; } .card-header { padding-left: 14px; padding-right: 14px; } .volume-card .card-header { gap: 8px; } .volume-chart { height: 205px; } .segmented button { padding-left: 5px; padding-right: 5px; } .model-list { grid-template-columns: 1fr; } }
</style>
