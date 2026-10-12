<script setup>
import { computed, ref, watch } from 'vue'
import EluneIcon from './EluneIcon.vue'
import PageControls from './PageControls.vue'
import { number, observationRows, seconds, spanStyle, status } from './format.js'
const props = defineProps({ trace: { type: Object, required: true }, selectedId: { type: String, default: null }, timeline: Boolean, disabled: Boolean, previousOffset: { type: Number, default: 0 } })
const emit = defineEmits(['select', 'load-page'])
const q = ref('')
const page = ref(1)
const limit = 50
const batch = computed(() => props.trace.pagination?.observations || { total: props.trace.observations?.length || 0, offset: 0, nextOffset: null })
const loaded = computed(() => props.trace.observations?.length || 0)
const partial = computed(() => batch.value.offset > 0 || batch.value.nextOffset !== null)
const tree = computed(() => observationRows(props.trace.observations || []))
const rows = computed(() => {
  const query = q.value.trim().toLocaleLowerCase()
  return query ? tree.value.filter(({ item }) => `${item.name || ''} ${item.type || ''} ${item.model || ''} ${status(item)}`.toLocaleLowerCase().includes(query)) : tree.value
})
const shown = computed(() => rows.value.slice((page.value - 1) * limit, page.value * limit))
const extent = computed(() => {
  let total = Number(props.trace.latency) || 0
  for (const { item } of tree.value) total = Math.max(total, (Number(item.startTime) || 0) + (Number(item.duration) || 0))
  return Math.max(0.001, total)
})
function reveal() {
  const index = rows.value.findIndex(({ item }) => item.id === props.selectedId)
  if (index >= 0) page.value = Math.floor(index / limit) + 1
}
watch(q, () => { page.value = 1 })
watch(() => props.trace.id, () => { q.value = ''; page.value = 1; reveal() })
watch(() => props.trace.pagination?.observations?.offset, () => { page.value = 1; reveal() })
watch(() => props.trace.observations, reveal)
watch(() => props.selectedId, reveal, { immediate: true })
watch(() => rows.value.length, length => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / limit))) })
</script>

<template>
  <section class="elune-observations" :class="{ 'elune-timeline': timeline }" aria-label="Trace observations">
    <div class="elune-observation-tools"><strong>{{ timeline ? 'Timeline' : 'Observations' }}</strong><span>{{ number(batch.total) }} recorded observations{{ trace.metadata?.observationsTruncated ? ' · incomplete' : '' }}</span><label><input v-model="q" type="search" placeholder="Find in loaded batch" aria-label="Search loaded observations"/></label></div>
    <div class="elune-observation-scroll">
      <p v-if="trace.metadata?.observationsTruncated" class="elune-limitation" role="note">Some observations were not recorded. This count is not the complete run total.</p>
      <p v-if="partial" class="elune-limitation" role="note">Only this batch is loaded. Search applies to loaded observations.</p>
      <div v-if="timeline" class="elune-axis"><span>Observation</span><div><span>0 s</span><span>{{ seconds(extent / 2) }}</span><span>{{ seconds(extent) }}</span></div></div>
      <button type="button" class="elune-observation-row elune-root-row" :class="{ chosen: !selectedId }" :aria-pressed="!selectedId" data-observation-id="" @click="emit('select', null)"><span class="elune-node"><EluneIcon name="agent"/><span>Run summary</span><small>{{ seconds(trace.latency) }}</small></span><span v-if="timeline" class="elune-track"><i class="elune-span agent" :style="spanStyle({ startTime: 0, duration: trace.latency }, extent)"></i></span><span v-else class="elune-mini-track"><i class="elune-span agent" :style="spanStyle({ startTime: 0, duration: trace.latency }, extent)"></i></span></button>
      <button v-for="{ item, depth } in shown" :key="item.id" type="button" class="elune-observation-row" :class="{ chosen: item.id === selectedId }" :aria-pressed="item.id === selectedId" :title="`${item.name} · ${status(item)} · ${seconds(item.duration)}`" :data-observation-id="item.id" @click="emit('select', item.id)">
        <span class="elune-node" :style="{ paddingLeft: `${10 + Math.min(depth + 1, 7) * 10}px` }"><EluneIcon :name="item.type?.toLowerCase()" :class="[item.type?.toLowerCase(), { error: status(item) === 'error' }]"/><span>{{ item.name || 'Untitled observation' }}</span><small>{{ seconds(item.duration) }}</small></span>
        <span :class="timeline ? 'elune-track' : 'elune-mini-track'"><i class="elune-span" :class="[item.type?.toLowerCase(), { error: status(item) === 'error' }]" :style="spanStyle(item, extent)"></i></span>
      </button>
      <p v-if="!rows.length" class="elune-empty">{{ q ? 'No matching observations in this loaded batch.' : batch.total ? 'No observations in this loaded batch.' : 'No observations recorded.' }}</p>
      <nav v-if="partial" class="elune-pagination elune-batch-controls" aria-label="Observation batches">
        <span>Loaded {{ loaded ? number(batch.offset + 1) : 0 }}–{{ loaded ? number(batch.offset + loaded) : 0 }} of {{ number(batch.total) }} observations</span>
        <div><button type="button" :disabled="disabled || batch.offset === 0" @click="emit('load-page', previousOffset)">Previous batch</button><button type="button" :disabled="disabled || batch.nextOffset === null" @click="emit('load-page', batch.nextOffset)">Next batch</button></div>
      </nav>
    </div>
    <PageControls :page="page" :limit="limit" :total="rows.length" label="loaded observations" @update:page="page = $event"/>
  </section>
</template>
