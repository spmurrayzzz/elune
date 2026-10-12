export function status(item) {
  return item?.status || (item?.level === 'ERROR' ? 'error' : item?.level === 'WARNING' ? 'warning' : 'completed')
}

export function seconds(value) {
  const amount = Math.max(0, Number(value) || 0)
  return amount < 1 ? `${Math.round(amount * 1000)} ms` : `${amount.toFixed(2)} s`
}

export function number(value) {
  return (Number(value) || 0).toLocaleString('en-US')
}

export function money(value) {
  return `$${(Number(value) || 0).toFixed(5)}`
}

export function date(value) {
  const time = new Date(value)
  return Number.isNaN(time.getTime()) ? 'Time not recorded' : time.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function projectLabel(trace) {
  const cwd = trace?.metadata?.cwd
  return cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd : 'Unknown project'
}

export function sessionLabel(trace) {
  return trace?.metadata?.sessionName || trace?.sessionId || 'Unknown session'
}

export function sessionTarget(trace, observation) {
  if (!trace?.sessionId) return null
  const anchors = [observation?.metadata?.toolResultEntryId, observation?.metadata?.messageEntryId, observation?.metadata?.compactionId, trace.metadata?.endEntryId, trace.metadata?.userEntryId, trace.metadata?.startEntryId]
  const entryId = anchors.find(value => typeof value === 'string' && value)
  const sessionFile = trace.metadata?.sessionFile
  return { sessionId: trace.sessionId, ...(entryId ? { entryId } : {}), ...(typeof sessionFile === 'string' && sessionFile ? { sessionFile } : {}) }
}

export function childSessionTargets(observation) {
  const children = observation?.metadata?.childSessions
  if (!Array.isArray(children)) return []
  const seen = new Set()
  return children.filter(child => {
    if (!child || typeof child.sessionId !== 'string' || !child.sessionId || seen.has(child.sessionId)) return false
    seen.add(child.sessionId)
    return true
  }).map(child => ({ sessionId: child.sessionId, ...(typeof child.sessionFile === 'string' && child.sessionFile ? { sessionFile: child.sessionFile } : {}), ...(typeof child.cwd === 'string' && child.cwd ? { cwd: child.cwd } : {}) }))
}

export function observationRows(observations) {
  const nodes = new Map()
  for (const item of observations) if (!nodes.has(item.id)) nodes.set(item.id, { item, children: [] })
  const roots = []
  for (const node of nodes.values()) {
    const parent = nodes.get(node.item.parentId)
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const rows = []
  const seen = new Set()
  function visit(root) {
    const stack = [{ node: root, depth: 0 }]
    while (stack.length) {
      const { node, depth } = stack.pop()
      if (seen.has(node.item.id)) continue
      seen.add(node.item.id)
      rows.push({ item: node.item, depth })
      for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1 })
    }
  }
  roots.forEach(visit)
  for (const node of nodes.values()) if (!seen.has(node.item.id)) visit(node)
  return rows
}

export function spanStyle(item, duration) {
  const total = Math.max(Number(duration) || 0, 0.001)
  const start = Math.max(0, Math.min(total, Number(item.startTime) || 0))
  const width = Math.max(0, Math.min(total - start, Number(item.duration) || 0))
  return { left: `${start / total * 100}%`, width: `${width / total * 100}%` }
}

export function contentLimited(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return /\[(?:omitted[^\]]*|truncated)\]|"omitted"\s*:\s*true/.test(text)
}

export function content(value) {
  if (value == null || value === '') return 'No data recorded.'
  if (typeof value !== 'string') return JSON.stringify(value, null, 2)
  if (value.length > 100000) return value
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}
