export const surfaceProps = {
  client: { type: Object, required: true },
  sessionId: { type: String, default: '' },
  selection: { type: Object, default: () => ({}) },
  active: { type: Boolean, default: true },
  listState: { type: Object, default: () => ({}) }
}

export const surfaceEvents = ['update:selection', 'update:listState', 'open-workspace', 'open-session', 'close']

export function normalizeSelection(value = {}) {
  return {
    traceId: value.traceId || null,
    observationId: value.observationId || null,
    observationOffset: Number.isSafeInteger(value.observationOffset) && value.observationOffset >= 0 ? value.observationOffset : 0,
    observationLimit: Number.isSafeInteger(value.observationLimit) && value.observationLimit > 0 ? Math.min(200, value.observationLimit) : 200,
    tab: ['input', 'output', 'metadata'].includes(value.tab) ? value.tab : 'output'
  }
}

export function normalizeListState(value = {}) {
  return {
    q: String(value.q || ''),
    status: String(value.status || ''),
    cwd: String(value.cwd || ''),
    page: Math.max(1, Math.floor(Number(value.page) || 1)),
    limit: Math.max(1, Math.min(50, Math.floor(Number(value.limit) || 20)))
  }
}
