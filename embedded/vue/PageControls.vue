<script setup>
import { computed } from 'vue'
import { number } from './format.js'
const props = defineProps({ page: { type: Number, required: true }, limit: { type: Number, required: true }, total: { type: Number, required: true }, disabled: Boolean, label: { type: String, default: 'items' } })
const emit = defineEmits(['update:page'])
const pages = computed(() => Math.max(1, Math.ceil(props.total / props.limit)))
</script>

<template>
  <div class="elune-pagination">
    <span>{{ total ? number((page - 1) * limit + 1) : 0 }}–{{ number(Math.min(page * limit, total)) }} of {{ number(total) }} {{ label }}</span>
    <div><button type="button" :disabled="disabled || page <= 1" :aria-label="`Previous ${label} page`" @click="emit('update:page', page - 1)">Previous</button><span>{{ page }} / {{ pages }}</span><button type="button" :disabled="disabled || page >= pages" :aria-label="`Next ${label} page`" @click="emit('update:page', page + 1)">Next</button></div>
  </div>
</template>
