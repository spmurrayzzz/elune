import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { record, clean } from './content.js'
import { prepareWindowsStorage } from './windows-storage.js'

let db
const statuses = new Set(['running', 'completed', 'error', 'aborted'])
const levels = new Set(['DEBUG', 'DEFAULT', 'WARNING', 'ERROR'])
const types = new Set(['AGENT', 'SPAN', 'GENERATION', 'TOOL', 'EVENT', 'RETRIEVER', 'EMBEDDING', 'EVALUATOR', 'GUARDRAIL', 'CHAIN'])
const traceFields = { id: 'id', source: 'source', status: 'status', revision: 'revision', name: 'name', timestamp: 'timestamp', timestampMs: 'timestamp_ms', environment: 'environment', userId: 'user_id', sessionId: 'session_id', latency: 'latency', totalTokens: 'total_tokens', inputTokens: 'input_tokens', outputTokens: 'output_tokens', cost: 'cost', level: 'level', tags: 'tags', bookmarked: 'bookmarked', input: 'input', output: 'output', metadata: 'metadata', model: 'model', version: 'version' }
const observationFields = { traceId: 'trace_id', id: 'id', position: 'position', parentId: 'parent_id', name: 'name', type: 'type', startTime: 'start_time', duration: 'duration', level: 'level', status: 'status', model: 'model', input: 'input', output: 'output', inputTokens: 'input_tokens', outputTokens: 'output_tokens', cost: 'cost', metadata: 'metadata' }
const scoreFields = { id: 'id', traceId: 'trace_id', traceName: 'trace_name', name: 'name', value: 'value', comment: 'comment', source: 'source', timestamp: 'timestamp', dataType: 'data_type' }
const schema = `
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS traces (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL, revision TEXT NOT NULL,
 name TEXT NOT NULL, timestamp TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
 environment TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
 latency REAL NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
 output_tokens INTEGER NOT NULL, cost REAL NOT NULL, level TEXT NOT NULL,
 tags TEXT NOT NULL, bookmarked INTEGER NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL,
 metadata TEXT NOT NULL, model TEXT NOT NULL, version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
 trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE, id TEXT NOT NULL,
 position INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL,
 start_time REAL NOT NULL, duration REAL NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL,
 model TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL, input_tokens INTEGER NOT NULL,
 output_tokens INTEGER NOT NULL, cost REAL NOT NULL, metadata TEXT NOT NULL,
 PRIMARY KEY (trace_id, id)
);
CREATE TABLE IF NOT EXISTS scores (
 id TEXT PRIMARY KEY, trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
 trace_name TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, comment TEXT NOT NULL,
 source TEXT NOT NULL, timestamp TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, data_type TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_timestamp ON traces(timestamp_ms DESC, id);
CREATE INDEX IF NOT EXISTS traces_session_time ON traces(session_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS scores_trace ON scores(trace_id, position);
CREATE INDEX IF NOT EXISTS embedded_observations_position ON observations(trace_id, position, id);
CREATE INDEX IF NOT EXISTS embedded_cwd_time ON traces(json_extract(metadata, '$.cwd'), timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS embedded_status_time ON traces(status, timestamp_ms DESC);
`

function permissions() {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const path = workerData.databasePath + suffix
      if (!lstatSync(path).isFile()) throw new Error('Database files must be regular files without symlinks')
      if (process.platform !== 'win32') chmodSync(path, 0o600)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function initialize() {
  const path = workerData.databasePath
  const directory = dirname(path)
  if (process.platform === 'win32') prepareWindowsStorage(path)
  else mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory()) throw new Error('Database directory must be a directory without a symlink')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Database directory must have private permissions (0700)')
  try { if (!lstatSync(path).isFile()) throw new Error('Database path must be a regular file without a symlink') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  closeSync(fd)
  permissions()
  db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;')
  if (db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') throw new Error('SQLite WAL mode is required')
  db.function('unicode_lower', { deterministic: true }, value => typeof value === 'string' ? value.toLowerCase() : value)
  transaction(() => {
    db.exec(schema)
    const version = db.prepare("SELECT value FROM store_meta WHERE key='version'").get()?.value
    if (version !== undefined && version !== '1') throw new Error('Unsupported database version')
    db.prepare("INSERT OR IGNORE INTO store_meta(key,value) VALUES('version','1')").run()
  })
  permissions()
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)) throw new TypeError('Invalid identifier')
  return value
}

function timestamp(value) {
  if (typeof value !== 'string') return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!parts) return false
  const [, y, m, d, h, minute, second, offsetHour = 0, offsetMinute = 0] = parts.map((part, index) => index ? Number(part || 0) : part)
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] && h < 24 && minute < 60 && second < 60 && offsetHour <= 24 && offsetMinute <= 60 && Number.isFinite(Date.parse(value))
}

function number(value, max = 1e12) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new TypeError('Invalid numeric field')
  return value
}

function decode(row, fields) {
  const result = {}
  for (const [key, column] of Object.entries(fields)) if (Object.hasOwn(row, column)) result[key] = row[column]
  for (const key of ['tags', 'metadata']) if (Object.hasOwn(result, key)) result[key] = JSON.parse(result[key] || 'null')
  if (Object.hasOwn(result, 'revision')) result.revision = Number(result.revision)
  if (Object.hasOwn(result, 'bookmarked')) result.bookmarked = Boolean(result.bookmarked)
  delete result.timestampMs
  delete result.position
  return result
}

const readTextLimit = 32768
const readByteLimit = 8 * 1024 * 1024
const textColumns = new Set(['id', 'trace_id', 'source', 'status', 'revision', 'name', 'timestamp', 'environment', 'user_id', 'session_id', 'level', 'tags', 'input', 'output', 'metadata', 'model', 'version', 'parent_id', 'type', 'trace_name', 'comment', 'data_type'])

function projection(fields, limit = readTextLimit) {
  return Object.values(fields).map(column => {
    const bytes = column === 'name' ? readTextLimit : limit
    return textColumns.has(column) ? `CAST(substr(CAST(${column} AS BLOB),1,${bytes}) AS TEXT) AS ${column},length(CAST(${column} AS BLOB)) AS read_bytes_${column},${bytes} AS read_limit_${column}` : column
  }).join(',')
}

function boundedDecode(row, fields) {
  const truncated = []
  for (const [key, column] of Object.entries(fields)) {
    if (row[`read_bytes_${column}`] > row[`read_limit_${column}`]) {
      truncated.push(key)
      if (key === 'metadata') row[column] = JSON.stringify({ contentOmitted: '[truncated on read]' })
      else if (key === 'tags') row[column] = JSON.stringify(['[truncated on read]'])
      else row[column] = row[column].replace(/\uFFFD$/, '') + '\n[truncated on read]'
    }
  }
  const result = decode(row, fields)
  if (truncated.length) result.readTruncation = { fields: truncated, fieldBytes: Object.fromEntries(truncated.map(key => [key, row[`read_limit_${fields[key]}`]])) }
  return result
}

function pageRows(table, fields, traceId, options = {}, budget = readByteLimit) {
  id(traceId)
  const offset = options.offset ?? 0
  const limit = Math.min(options.limit ?? (table === 'observations' ? 4096 : 1024), 4096)
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid read pagination')
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE trace_id=?`).get(traceId).n
  const items = []
  let bytes = 0
  for (const row of db.prepare(`SELECT ${projection(fields)} FROM ${table} WHERE trace_id=? ORDER BY position,id LIMIT ? OFFSET ?`).iterate(traceId, limit, offset)) {
    const item = boundedDecode(row, fields)
    delete item.traceId
    const size = Buffer.byteLength(JSON.stringify(item)) + 64
    if (items.length && bytes + size > budget) break
    items.push(item)
    bytes += size
  }
  const nextOffset = offset + items.length < total ? offset + items.length : null
  return { items, total, offset, limit, nextOffset, bytes, truncated: nextOffset !== null || items.some(item => item.readTruncation) }
}

function full(traceId, options = {}) {
  const row = db.prepare(`SELECT ${projection(traceFields)} FROM traces WHERE id=?`).get(id(traceId))
  if (!row) return null
  const trace = boundedDecode(row, traceFields)
  const scores = pageRows('scores', scoreFields, traceId, { offset: options.scoreOffset, limit: options.scoreLimit }, readByteLimit / 4)
  const observations = pageRows('observations', observationFields, traceId, { offset: options.observationOffset, limit: options.observationLimit }, readByteLimit - scores.bytes)
  trace.scores = scores.items
  trace.observations = observations.items
  trace.pagination = {}
  for (const [key, result] of Object.entries({ scores, observations })) {
    const { items, bytes, ...pagination } = result
    trace.pagination[key] = pagination
    if (result.truncated) trace.readTruncation = { ...trace.readTruncation, [key]: true }
  }
  return trace
}

function upsert(table, fields, value, conflict, excluded = []) {
  const keys = Object.keys(fields)
  const columns = keys.map(key => fields[key])
  const updates = columns.filter(column => !conflict.includes(column) && !excluded.includes(column)).map(column => `${column}=excluded.${column}`)
  const args = keys.map(key => {
    const item = value[key]
    if (key === 'metadata' || key === 'tags') return JSON.stringify(item ?? (key === 'tags' ? [] : {}))
    if (key === 'bookmarked') return item ? 1 : 0
    if (key === 'revision') return String(item)
    return item ?? null
  })
  db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT (${conflict.join(',')}) DO UPDATE SET ${updates.join(',')}`).run(...args)
}

function validate(value, observation = false) {
  id(value.id)
  if (!value.name?.trim() || !levels.has(value.level) || !statuses.has(value.status)) throw new TypeError('Invalid name, level, or status')
  for (const key of observation ? ['startTime', 'duration'] : ['latency']) number(value[key], 31536000)
  for (const key of observation ? ['inputTokens', 'outputTokens'] : ['totalTokens', 'inputTokens', 'outputTokens']) {
    number(value[key])
    if (!Number.isSafeInteger(value[key])) throw new TypeError('Token counts must be integers')
  }
  number(value.cost, 1e9)
  if (Buffer.byteLength(JSON.stringify(value.metadata || {})) > 32768) throw new TypeError('Metadata limit exceeded')
  if (observation) {
    if (!types.has(value.type)) throw new TypeError('Invalid observation type')
    if (value.parentId !== null) id(value.parentId)
  } else {
    id(value.sessionId)
    if (value.source !== 'pi' || !timestamp(value.timestamp)) throw new TypeError('Invalid trace source or timestamp')
  }
}

function write({ trace: patch, observations = [] }) {
  patch = record(patch)
  id(patch.id)
  if (!Array.isArray(observations) || observations.length > 512) throw new TypeError('Too many changed observations')
  const row = db.prepare('SELECT * FROM traces WHERE id=?').get(patch.id)
  const previous = row ? decode(row, traceFields) : null
  if (previous && (previous.source !== 'pi' || (patch.sessionId !== undefined && patch.sessionId !== previous.sessionId) || (patch.timestamp !== undefined && patch.timestamp !== previous.timestamp))) throw new Error('Trace source, session, and timestamp cannot change')
  const trace = { source: 'pi', status: 'running', name: 'pi-agent', timestamp: new Date().toISOString(), environment: 'local', userId: '', latency: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cost: 0, level: 'DEFAULT', tags: [], bookmarked: false, input: '', output: '', model: '', version: '0.1.0', ...previous, ...patch, metadata: { ...previous?.metadata, ...patch.metadata }, revision: (previous?.revision || 0) + 1 }
  if (previous?.status !== undefined && previous.status !== 'running' && trace.status === 'running') throw new Error('A settled trace cannot resume')
  if (!Number.isSafeInteger(trace.revision)) throw new Error('Trace revision limit exceeded')
  validate(trace)
  trace.timestampMs = Date.parse(trace.timestamp)
  upsert('traces', traceFields, trace, ['id'], ['bookmarked'])
  const nextPosition = db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM observations WHERE trace_id=?').get(trace.id).n
  let position = nextPosition
  for (const change of observations) {
    const item = record(change, true)
    id(item.id)
    const prior = db.prepare('SELECT * FROM observations WHERE trace_id=? AND id=?').get(trace.id, item.id)
    if (prior?.status && prior.status !== 'running' && item.status === 'running') throw new Error('A finalized observation cannot resume')
    const observation = { parentId: null, name: 'Observation', type: 'SPAN', startTime: 0, duration: 0, level: 'DEFAULT', status: 'running', model: '', input: '', output: '', inputTokens: 0, outputTokens: 0, cost: 0, ...(prior ? decode(prior, observationFields) : {}), ...item, metadata: { ...(prior ? JSON.parse(prior.metadata || '{}') : {}), ...item.metadata }, traceId: trace.id, position: prior?.position ?? position++ }
    validate(observation, true)
    upsert('observations', observationFields, observation, ['trace_id', 'id'], ['position'])
  }
  const visited = new Set()
  const parent = db.prepare('SELECT parent_id FROM observations WHERE trace_id=? AND id=?')
  for (const item of observations) {
    const path = new Set()
    let current = item.id
    while (current && !visited.has(current)) {
      if (path.has(current)) throw new Error('Invalid observation parent linkage')
      const row = parent.get(trace.id, current)
      if (!row) throw new Error('Invalid observation parent linkage')
      path.add(current)
      current = row.parent_id
    }
    for (const entry of path) visited.add(entry)
  }
  if (!previous && patch.scores?.length) {
    if (!Array.isArray(patch.scores) || patch.scores.length > 64) throw new TypeError('Invalid scores')
    let scorePosition = 0
    for (const score of patch.scores) {
      id(score.id)
      if (score.traceId !== trace.id || !Number.isFinite(score.value) || !timestamp(score.timestamp)) throw new TypeError('Invalid score')
      if (db.prepare('SELECT id FROM scores WHERE id=?').get(score.id)) throw new Error('Score identifier already exists')
      const fields = { ...scoreFields, timestampMs: 'timestamp_ms', position: 'position' }
      upsert('scores', fields, { ...clean(score), timestampMs: Date.parse(score.timestamp), position: scorePosition++ }, ['id'])
    }
  }
  return { traceId: trace.id, sessionId: trace.sessionId, revision: trace.revision }
}

function list(options = {}) {
  const { sessionId, cwd, status, q = '' } = options
  if (!Number.isSafeInteger(options.page ?? 1) || (options.page ?? 1) < 1 || !Number.isSafeInteger(options.limit ?? 50) || (options.limit ?? 50) < 1) throw new TypeError('Page and limit must be positive integers')
  const page = options.page ?? 1
  const limit = Math.min(200, options.limit ?? 50)
  const offset = (page - 1) * limit
  if (!Number.isSafeInteger(offset)) throw new TypeError('Page offset exceeds the safe integer range')
  const parts = ['1=1']
  const args = []
  for (const [value, column] of [[sessionId, 't.session_id'], [cwd, "json_extract(t.metadata,'$.cwd')"], [status, 't.status']]) {
    if (value === undefined || value === '') continue
    if (typeof value !== 'string' || value.length > 4096) throw new TypeError('Invalid filter')
    parts.push(`${column}=?`)
    args.push(value)
  }
  if (typeof q !== 'string' || q.length > 2048) throw new TypeError('Invalid search text')
  const terms = q.trim().split(/\s+/).filter(Boolean)
  if (terms.length > 32) throw new TypeError('Too many search terms')
  for (const term of terms) {
    const columns = ['t.id', 't.name', 't.user_id', 't.session_id', 't.input', 't.output', 't.model', "json_extract(t.metadata,'$.sessionName')", "json_extract(t.metadata,'$.cwd')"]
    parts.push(`(${columns.map(column => `instr(unicode_lower(substr(${column},1,32768)),unicode_lower(?))>0`).join(' OR ')} OR EXISTS (SELECT 1 FROM json_each(t.tags) WHERE instr(unicode_lower(substr(value,1,2048)),unicode_lower(?))>0))`)
    args.push(...Array(columns.length + 1).fill(term))
  }
  const where = parts.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) AS n FROM traces t WHERE ${where}`).get(...args).n
  const fields = Object.fromEntries(Object.entries(traceFields).filter(([, column]) => !['input', 'output', 'metadata'].includes(column)))
  const columns = projection(fields, 2048)
  const summaryKeys = ['cwd', 'sessionName', 'sessionFile', 'branchId', 'startEntryId', 'endEntryId', 'userEntryId', 'parentSessionFile']
  const summary = (path, size) => {
    const value = `json_extract(t.metadata,'$.${path}')`
    return `CASE WHEN length(${value})>${size} THEN substr(${value},1,${size})||char(10)||'[truncated on read]' ELSE ${value} END`
  }
  const metadata = summaryKeys.map(key => `'${key}',${summary(key, 2048)}`).join(',')
  const rows = db.prepare(`SELECT ${columns},json_object(${metadata},'parent',json(json_object('traceId',${summary('parent.traceId', 160)},'sessionId',${summary('parent.sessionId', 160)},'toolCallId',${summary('parent.toolCallId', 512)}))) AS metadata FROM traces t WHERE ${where} ORDER BY t.timestamp_ms DESC,t.id LIMIT ? OFFSET ?`).all(...args, limit, offset)
  return { traces: rows.map(row => boundedDecode(row, traceFields)), total, page, limit }
}

function read(fn) {
  db.exec('BEGIN')
  try { const result = fn(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
}

const operations = {
  list: options => read(() => list(options)),
  get: ({ traceId, options }) => read(() => full(traceId, options)),
  observations: ({ traceId, options }) => read(() => pageRows('observations', observationFields, traceId, options)),
  scores: ({ traceId, options }) => read(() => pageRows('scores', scoreFields, traceId, options)),
  writeBatch: batch => {
    if (!Array.isArray(batch) || batch.length > 16) throw new TypeError('Invalid write batch')
    permissions()
    const results = transaction(() => batch.map(patch => {
      db.exec('SAVEPOINT capture_write')
      try {
        const notice = write(patch)
        db.exec('RELEASE capture_write')
        return { notice }
      } catch (error) {
        db.exec('ROLLBACK TO capture_write; RELEASE capture_write')
        return { error: { message: error.message, name: error.name } }
      }
    }))
    return { results, notices: results.flatMap(result => result.notice ? [result.notice] : []) }
  },
  bookmark: ({ traceId, bookmarked }) => {
    if (typeof bookmarked !== 'boolean') throw new TypeError('Bookmark must be a boolean')
    const result = transaction(() => {
      const trace = full(traceId)
      if (!trace) throw new Error('Trace not found')
      trace.revision++
      if (!Number.isSafeInteger(trace.revision)) throw new Error('Trace revision limit exceeded')
      db.prepare('UPDATE traces SET bookmarked=?,revision=? WHERE id=?').run(bookmarked ? 1 : 0, String(trace.revision), traceId)
      trace.bookmarked = bookmarked
      return trace
    })
    return { trace: result, notices: [{ traceId, sessionId: result.sessionId, revision: result.revision }] }
  },
  close: () => { db.close(); db = undefined; return null },
}

try {
  initialize()
  parentPort.on('message', ({ requestId, operation, value }) => {
    try {
      if (!Object.hasOwn(operations, operation)) throw new Error('Unknown operation')
      const result = operations[operation](value)
      parentPort.postMessage({ requestId, result })
      if (operation === 'close') parentPort.close()
    } catch (error) {
      parentPort.postMessage({ requestId, error: { message: error.message, name: error.name } })
    }
  })
} catch (error) {
  try { db?.close() } catch {}
  parentPort.postMessage({ fatal: error.message })
  parentPort.close()
}
