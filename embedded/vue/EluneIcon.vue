<script setup>
defineProps({ name: { type: String, default: 'trace' } })
const paths = {
  trace: 'M4 5h5M4 12h11M4 19h17M9 3v4M15 10v4M21 17v4',
  close: 'm6 6 12 12M6 18 18 6',
  chevron: 'm6 9 6 6 6-6',
  back: 'm14 5-7 7 7 7',
  expand: 'M14 4h6v6M10 20H4v-6m0 6 6-6M20 4l-6 6',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  generation: 'm12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3z',
  tool: 'm4 7 5 5-5 5m8 0h7',
  agent: 'M4 7h16v13H4zM12 7V3M8 12h2M14 12h2M9 16h6'
}
</script>

<template>
  <svg class="elune-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'elune'"><path d="M3 5C1 15 6 22 12 22S23 15 21 5C20 13 16 17 12 19C7 17 4 13 3 5Z" fill="currentColor" stroke="none"/><path d="m12 1 2.6 5.6L12 13l-2.6-6.4Z" fill="currentColor" stroke="none"/></template>
    <path v-else :d="paths[name] || paths.trace"/>
  </svg>
</template>
