<script setup>
import { computed, ref, watch } from 'vue'
import EluneIcon from './EluneIcon.vue'
import PageControls from './PageControls.vue'
import { childSessionTargets, content, contentLimited, money, number, seconds, status } from './format.js'
const props = defineProps({ trace: { type: Object, required: true }, observation: Object, tab: { type: String, default: 'output' } })
const emit = defineEmits(['update:tab', 'open-session', 'open-child-session'])
const item = computed(() => props.observation || props.trace)
const children = computed(() => childSessionTargets(props.observation))
const chunk = ref(1)
const chunkSize = 24000
const payloadValue = computed(() => item.value[props.tab])
const recordedLimited = computed(() => item.value.metadata?.contentTruncated || contentLimited(item.value.metadata) || contentLimited(payloadValue.value))
const readFields = computed(() => item.value.readTruncation?.fields || [])
const payload = computed(() => content(payloadValue.value ?? (props.tab === 'metadata' ? {} : null)))
const text = computed(() => payload.value.slice((chunk.value - 1) * chunkSize, chunk.value * chunkSize))
watch([() => item.value.id, () => props.tab], () => { chunk.value = 1 })
watch(() => payload.value.length, length => { chunk.value = Math.min(chunk.value, Math.max(1, Math.ceil(length / chunkSize))) })
</script>

<template>
  <section class="elune-detail" aria-label="Observation detail">
    <header class="elune-detail-heading">
      <div class="elune-detail-kind"><EluneIcon :name="item.type?.toLowerCase()" :class="item.type?.toLowerCase()"/>{{ item.type || 'TRACE' }}<span class="elune-status" :class="status(item)">{{ status(item) }}</span></div>
      <h3 :title="item.name">{{ item.name || 'Untitled observation' }}</h3>
      <div class="elune-detail-facts"><span>{{ seconds(observation ? item.duration : trace.latency) }}</span><span v-if="observation">+{{ seconds(item.startTime) }} from start</span><span v-if="item.model">{{ item.model }}</span><span>{{ number(item.inputTokens) }} in / {{ number(item.outputTokens) }} out</span><span>{{ money(item.cost) }}</span></div>
    </header>
    <nav class="elune-tabs" aria-label="Observation content">
      <button v-for="name in ['input', 'output', 'metadata']" :key="name" type="button" :aria-pressed="tab === name" @click="emit('update:tab', name)">{{ name }}</button>
      <button v-if="trace.sessionId" class="elune-session-link" type="button" @click="emit('open-session', observation)">Open session</button>
    </nav>
    <div class="elune-payload-scroll">
      <nav v-if="children.length" class="elune-child-sessions" aria-label="Child sessions"><span>Child sessions</span><button v-for="child in children" :key="child.sessionId" type="button" class="elune-button" :title="child.sessionFile || child.sessionId" @click="emit('open-child-session', child)">{{ child.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || child.sessionId }}</button></nav>
      <p v-if="readFields.length" class="elune-limitation" role="note">Fields clipped on read: {{ readFields.join(', ') }}. Stored content is unchanged.</p>
      <p v-if="recordedLimited" class="elune-limitation" role="note">Content was omitted or truncated during recording. Payload markers show the limits.</p>
      <dl v-if="tab === 'metadata'" class="elune-properties"><dt>ID</dt><dd>{{ item.id }}</dd><dt>Trace revision</dt><dd>{{ trace.revision ?? 'Not recorded' }}</dd><dt>Session</dt><dd>{{ trace.sessionId || 'Not recorded' }}</dd><dt>Level</dt><dd>{{ item.level || 'DEFAULT' }}</dd><dt>Project</dt><dd>{{ trace.metadata?.cwd || 'Not recorded' }}</dd></dl>
      <pre class="elune-payload">{{ text }}</pre>
    </div>
    <PageControls v-if="payload.length > chunkSize" :page="chunk" :limit="chunkSize" :total="payload.length" label="characters" @update:page="chunk = $event"/>
  </section>
</template>
