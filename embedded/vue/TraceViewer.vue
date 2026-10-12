<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ObservationList from './ObservationList.vue'
import ObservationDetail from './ObservationDetail.vue'
const props = defineProps({ trace: { type: Object, required: true }, selection: { type: Object, required: true }, timeline: Boolean, pagingDisabled: Boolean, previousOffset: { type: Number, default: 0 }, previewVisible: { type: Boolean, default: true } })
const emit = defineEmits(['update:selection', 'open-session', 'open-child-session', 'load-page'])
const viewer = ref(null)
const pane = ref(props.selection.observationId ? 'detail' : 'observations')
const width = ref(0)
const narrow = computed(() => width.value <= (props.timeline ? 800 : 480))
const detailVisible = computed(() => props.previewVisible && (!narrow.value || pane.value === 'detail'))
let observer
let previousRow = props.selection.observationId || ''
const index = computed(() => new Map((props.trace.observations || []).map(item => [item.id, item])))
const observation = computed(() => index.value.get(props.selection.observationId))
function switchPane(value) {
  pane.value = value
  if (!narrow.value) return
  nextTick(() => {
    const row = value === 'observations' ? [...viewer.value.querySelectorAll('[data-observation-id]')].find(button => button.dataset.observationId === previousRow) : null
    const target = row || viewer.value.querySelector(`.elune-pane-switch button[data-panel="${value}"]`)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  })
}
function select(id) {
  previousRow = id || ''
  emit('update:selection', { observationId: id })
  switchPane('detail')
}
watch(() => props.selection.observationId, id => { if (id) pane.value = 'detail' })
onMounted(() => {
  const wrapper = viewer.value?.closest('.elune-ui')
  if (!wrapper) return
  const measure = () => { width.value = wrapper.clientWidth }
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    observer.observe(wrapper)
  }
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="viewer" class="elune-viewer" :class="{ 'elune-viewer-wide': timeline }" :data-pane="pane">
    <nav class="elune-pane-switch" aria-label="Trace panels"><button type="button" :aria-pressed="pane === 'observations'" data-panel="observations" @click="switchPane('observations')">{{ timeline ? 'Timeline' : 'Observations' }}</button><button type="button" :aria-pressed="pane === 'detail'" data-panel="detail" @click="switchPane('detail')">Selected detail</button></nav>
    <ObservationList :trace="trace" :selected-id="selection.observationId" :timeline="timeline" :disabled="pagingDisabled" :previous-offset="previousOffset" @load-page="emit('load-page', $event)" @select="select"/>
    <section v-if="detailVisible && selection.observationId && !observation" class="elune-detail" aria-label="Observation detail"><p class="elune-empty" role="status">Selected observation {{ selection.observationId }} is not in this loaded batch. Load its batch or select another observation.</p></section>
    <ObservationDetail v-else-if="detailVisible" :trace="trace" :observation="observation" :tab="selection.tab" @update:tab="emit('update:selection', { tab: $event })" @open-session="emit('open-session', $event)" @open-child-session="emit('open-child-session', $event)"/>
  </div>
</template>
