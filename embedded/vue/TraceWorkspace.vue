<script setup>
import TraceSurface from './TraceSurface.vue'
import { surfaceEvents, surfaceProps } from './props.js'
defineProps(surfaceProps)
const emit = defineEmits(surfaceEvents)
</script>

<template>
  <TraceSurface v-bind="$props" mode="workspace" @update:selection="emit('update:selection', $event)" @update:list-state="emit('update:listState', $event)" @open-workspace="emit('open-workspace', $event)" @open-session="emit('open-session', $event)" @close="emit('close')"/>
</template>
