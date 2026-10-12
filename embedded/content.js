const omitted = /^(headers|authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|thinking|reasoning|reasoning_content|encrypted_content|.*signature|base64|image_url|image_data|inlineData)$/i
const blobs = /^(image|input_image|output_image|image_url|thinking|redacted_thinking|reasoning)$/i

export function clip(value, limit = 32768) {
  if (typeof value !== 'string') return ''
  const prefix = value.slice(0, limit)
  const bytes = Buffer.from(prefix)
  if (bytes.length <= limit && value.length <= limit) return prefix
  return bytes.subarray(0, Math.max(0, limit - 16)).toString('utf8').replace(/\uFFFD$/, '') + '\n[truncated]'
}

export function clean(value, limit = 16384) {
  let remaining = limit
  let nodes = 1024
  const seen = new WeakSet()
  function visit(item, depth) {
    if (--nodes < 0 || remaining <= 0 || depth > 8) return '[omitted]'
    if (typeof item === 'string') {
      const result = clip(item, Math.min(remaining, 32768))
      remaining -= Buffer.byteLength(result)
      return result
    }
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'number') return Number.isFinite(item) ? item : 0
    if (typeof item !== 'object') return null
    if (seen.has(item)) return '[circular]'
    if (blobs.test(item.type || '') || item.type === 'image' || item.source?.type === 'base64') return { type: item.type || 'image', omitted: true }
    seen.add(item)
    const result = Array.isArray(item) ? [] : Object.create(null)
    let count = 0
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue
      if (++count > 128 || nodes <= 0 || remaining <= 0) {
        if (Array.isArray(item)) result.push({ omitted: true, reason: 'content limit' })
        else result.contentOmitted = '[omitted: content limit]'
        break
      }
      if (key === '__proto__' || key === 'constructor') { result.contentOmitted = '[omitted: unsafe key]'; continue }
      if (omitted.test(key)) { result[key] = '[omitted]'; continue }
      remaining -= Math.min(key.length, 160) + 8
      result[Array.isArray(item) ? result.length : clip(key, 160)] = visit(item[key], depth + 1)
    }
    return result
  }
  return visit(value, 0)
}

export function text(value, limit = 32768) {
  return typeof value === 'string' ? clip(value, limit) : clip(JSON.stringify(clean(value, limit)), limit)
}

export function contentText(content, limit = 32768) {
  if (!Array.isArray(content)) return text(content, limit)
  let result = ''
  let index = 0
  for (; index < Math.min(content.length, 128) && result.length < limit; index++) {
    const part = content[index]
    if (part?.type === 'thinking' || part?.type === 'reasoning') { result += (result ? '\n' : '') + '[omitted: reasoning]'; continue }
    const value = part?.type === 'text' ? clip(part.text, limit - result.length) : text(part?.type === 'toolCall' ? { toolCallId: part.id, name: part.name, arguments: part.arguments } : { type: part?.type, omitted: true }, limit - result.length)
    result += (result ? '\n' : '') + value
  }
  if (index < content.length) result = clip(result, Math.max(16, limit - 32)) + '\n[omitted: remaining content]'
  return clip(result, limit)
}

const labels = ['id', 'source', 'status', 'name', 'timestamp', 'environment', 'userId', 'sessionId', 'level', 'model', 'version', 'parentId', 'type']
const numbers = ['latency', 'totalTokens', 'inputTokens', 'outputTokens', 'cost', 'startTime', 'duration', 'position']

export function record(value, observation = false) {
  if (!value || typeof value !== 'object') throw new TypeError('A trace or observation object is required')
  const result = {}
  for (const key of labels) {
    if (Object.hasOwn(value, key)) result[key] = value[key] === null ? null : clip(value[key], key === 'name' || key === 'model' || key === 'userId' ? 512 : 160)
  }
  for (const key of numbers) if (Object.hasOwn(value, key)) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) throw new TypeError('Numeric fields must be finite numbers')
    result[key] = value[key]
  }
  for (const key of ['input', 'output']) if (Object.hasOwn(value, key)) result[key] = text(value[key], 32768)
  if (Object.hasOwn(value, 'metadata')) {
    if (value.metadata != null && (typeof value.metadata !== 'object' || Array.isArray(value.metadata))) throw new TypeError('Metadata must be an object')
    const metadata = {}
    for (const key of ['branchId', 'startEntryId', 'endEntryId', 'userEntryId', 'messageEntryId', 'toolResultEntryId', 'entryParentId', 'lastErrorMessage', 'lastToolError', 'cacheReadTokens', 'cacheWriteTokens', 'cwd', 'sessionName', 'sessionFile', 'parent']) if (Object.hasOwn(value.metadata || {}, key)) metadata[key] = value.metadata[key]
    result.metadata = clean({ ...metadata, ...clean(value.metadata, 8192) }, 8192)
  }
  if (Object.hasOwn(value, 'tags')) {
    result.tags = Array.isArray(value.tags) ? value.tags.slice(0, 64).map(tag => clip(tag, 160)) : []
    if (value.tags?.length > 64) result.tags.push('[omitted: remaining tags]')
  }
  if (Object.hasOwn(value, 'scores')) result.scores = clean(value.scores, 16384)
  return result
}
