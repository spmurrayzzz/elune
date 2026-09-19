import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Pending = { id: string; revision: number; body: string; file: string }

export class TraceExporter {
  private endpoint: string
  private directory: string
  private pending = new Map<string, Pending>()
  private writing: Promise<void> = Promise.resolve()
  private sending: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private failures = 0
  private retryAt = 0
  private report: (state: string) => void

  constructor(url: string, directory: string, report: (state: string) => void = () => {}) {
    const base = new URL(url)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('PI_TRACE_URL must be an HTTP URL without credentials')
    this.endpoint = new URL('/api/ingest', base).href
    this.directory = join(directory, createHash('sha256').update(this.endpoint).digest('hex').slice(0, 16))
    this.report = report
  }

  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const obsolete: string[] = []
    for (const name of await readdir(this.directory)) {
      if (!/^[a-zA-Z0-9_-]+\.\d+\.json$/.test(name)) continue
      try {
        const body = await readFile(join(this.directory, name), 'utf8')
        const { trace } = JSON.parse(body)
        if (trace?.source === 'pi' && `${trace.id}.${trace.revision}.json` === name && Number.isSafeInteger(trace.revision) && trace.revision > 0) {
          const previous = this.pending.get(trace.id)
          if (previous && previous.revision >= trace.revision) obsolete.push(name)
          else {
            this.pending.set(trace.id, { id: trace.id, revision: trace.revision, body, file: name })
            if (previous) obsolete.push(previous.file)
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report('Could not read a queued trace')
      }
    }
    await Promise.all(obsolete.map(name => unlink(join(this.directory, name)).catch(() => {})))
    this.schedule()
  }

  enqueue(trace: { id: string; revision: number }) {
    if (this.stopped) return
    const item = { id: trace.id, revision: trace.revision, body: JSON.stringify({ trace }), file: `${trace.id}.${trace.revision}.json` }
    this.writing = this.writing.then(async () => {
      const previous = this.pending.get(item.id)
      if (previous && previous.revision >= item.revision) return
      const file = join(this.directory, item.file)
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, item.body, { mode: 0o600 })
        await rename(temporary, file)
        this.pending.set(item.id, item)
        if (previous) await unlink(join(this.directory, previous.file)).catch(() => {})
        this.schedule()
      } finally {
        await unlink(temporary).catch(() => {})
      }
    }).catch(() => this.report('Could not save the trace queue'))
  }

  private schedule(delay = 150) {
    if (this.stopped || this.timer || !this.pending.size) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, Math.max(delay, this.retryAt - Date.now()))
    this.timer.unref()
  }

  private drain(): Promise<void> {
    if (this.sending) return this.sending
    this.sending = this.send().finally(() => {
      this.sending = undefined
      this.schedule()
    })
    return this.sending
  }

  private async send() {
    for (const item of this.pending.values()) {
      if (this.stopped || Date.now() < this.retryAt) break
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: item.body,
          signal: AbortSignal.timeout(2000),
        })
        await response.body?.cancel()
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
            this.writing = this.writing.then(async () => {
              if (this.pending.get(item.id) !== item) return
              await rename(join(this.directory, item.file), join(this.directory, item.file.replace(/\.json$/, '.rejected'))).catch(() => {})
              this.pending.delete(item.id)
            })
            await this.writing
            this.report(`Trace rejected (${response.status}); kept in local queue`)
            continue
          }
          throw new Error(`HTTP ${response.status}`)
        }
        this.failures = 0
        this.retryAt = 0
        this.writing = this.writing.then(async () => {
          if (this.pending.get(item.id) !== item) return
          await unlink(join(this.directory, item.file)).catch(() => {})
          this.pending.delete(item.id)
        })
        await this.writing
        this.report(this.pending.size ? 'Sending traces' : '')
      } catch {
        this.failures++
        this.retryAt = Date.now() + Math.min(15000, 500 * 2 ** Math.min(this.failures, 5))
        this.report('Traces queued; backend unavailable')
        break
      }
    }
  }

  async flush() {
    await this.writing
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.retryAt = 0
    do {
      await this.drain()
      await this.writing
    } while (!this.stopped && this.pending.size > 0 && this.retryAt === 0)
  }

  async close() {
    await this.flush()
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}
