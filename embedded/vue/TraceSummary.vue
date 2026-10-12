<script setup>
import { contentLimited, date, money, number, projectLabel, seconds, sessionLabel, status } from './format.js'
defineProps({ trace: { type: Object, required: true } })
</script>

<template>
  <header class="elune-summary">
    <div class="elune-summary-line"><span>{{ date(trace.timestamp) }}</span><span class="elune-status" :class="status(trace)">{{ status(trace) }}</span></div>
    <h3 :title="trace.name">{{ trace.name || 'Untitled trace' }}</h3>
    <p :title="trace.metadata?.cwd">{{ projectLabel(trace) }} <span> / </span> {{ sessionLabel(trace) }}</p>
    <div class="elune-stats"><span><small>Duration</small>{{ seconds(trace.latency) }}</span><span><small>Tokens</small>{{ number(trace.totalTokens ?? (Number(trace.inputTokens || 0) + Number(trace.outputTokens || 0))) }}</span><span><small>Cost</small>{{ money(trace.cost) }}</span><span><small>Recorded observations</small>{{ number(trace.pagination?.observations?.total ?? trace.observations?.length) }}{{ trace.metadata?.observationsTruncated ? '+' : '' }}</span></div>
    <p v-if="trace.metadata?.observationsTruncated || trace.metadata?.contentTruncated || contentLimited(trace.metadata)" class="elune-limitation" role="note">{{ trace.metadata?.observationsTruncated ? 'Observation count is incomplete. ' : '' }}{{ trace.metadata?.contentTruncated || contentLimited(trace.metadata) ? 'Content was omitted or truncated during recording.' : '' }}</p>
    <p v-if="trace.readTruncation?.fields?.length" class="elune-limitation" role="note">Trace fields clipped on read: {{ trace.readTruncation.fields.join(', ') }}. Stored content is unchanged.</p>
    <p v-if="trace.readTruncation?.scores" class="elune-limitation" role="note">This read does not include all stored score content.</p>
  </header>
</template>
