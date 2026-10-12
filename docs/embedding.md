# Embed elune

Use `@elune/embedded` to record and inspect traces inside a host application. The package comes from the independent [elune repository](https://github.com/spmurrayzzz/elune). It needs Node.js 22.19 or later.

The core has no UI framework dependency. The Pi adapter records agent activity. Optional Vue 3 components provide an inspector, a session workspace, and a trace explorer.

## Choose a tracing path

| Path | Storage and runtime | Use it for |
| --- | --- | --- |
| Standalone app | Go HTTP server, SQLite, and Vue frontend | A separate local trace browser |
| `integrations/pi/` | Pi extension with a persistent delivery queue and `PI_TRACE_URL` | Export to the standalone HTTP app |
| `@elune/embedded` | Node.js facade with a SQLite worker in the host process | Capture without a separate service |

The embedded package does not need Go, `PI_TRACE_URL`, or a running elune server. The standalone app still uses its Go backend. It does not use the new JavaScript core. See the [standalone instructions](../README.md#start-the-standalone-app) for startup, configuration, and JSON import behavior.

## Install

From the host application, run:

```sh
npm install spmurrayzzz/elune
```

Alternatively, add this dependency to the host's `package.json`:

```json
{
  "dependencies": {
    "@elune/embedded": "spmurrayzzz/elune"
  }
}
```

These forms install directly from GitHub. They do not require npm publication or a sibling elune checkout.

| Import | Purpose |
| --- | --- |
| `@elune/embedded` | Framework-neutral Node.js store |
| `@elune/embedded/pi` | Pi capture factory |
| `@elune/embedded/vue` | Optional Vue 3 source components |
| `@elune/embedded/vue/style.css` | Explicit stylesheet import for the Vue components |

Vue is an optional peer dependency. Install Vue 3 only if the host uses these components. The `/vue` export contains source `.vue` single-file components (SFCs), not precompiled browser code. Use Vue with Vite and its Vue plugin, or another build system with a Vue SFC compiler. Other frameworks can build their own UI against the core API.

## Create and own the store

This example creates a store facade. Its first operation starts the worker and opens SQLite.

```js
import { createElune } from '@elune/embedded'

const store = createElune({
  databasePath: './private-traces/elune.db',
  onError: error => console.error('Trace storage:', error)
})
```

`databasePath` is required. Relative paths resolve against the host's working directory. The worker uses Node's `node:sqlite`, WAL mode, transactions, and `synchronous=FULL`.

Use a dedicated private directory. The worker creates directories with mode `0700` and requires a private immediate parent directory. It sets the database, WAL, and shared-memory files to `0600`. It rejects symlinks for the immediate directory and database files. These checks do not replace the host's storage security policy.

The host owns the store lifetime. Share one store between capture factories and UI clients as needed. Stop capture before `store.close()`. Both `flush()` and `close()` can reject. Handle those errors instead of reporting success after a failed commit.

### Facade API

All operations below return promises except `subscribe()`.

| Method | Result and contract |
| --- | --- |
| `list({ sessionId, cwd, q, status, page, limit })` | `{ traces, total, page, limit }`. Filters run in SQLite. Defaults: page 1, limit 50. Maximum limit: 200. Summaries omit input and output and contain selected metadata. |
| `get(traceId, options)` | A trace with observations, scores, and pagination, or `null` when absent. Options: `observationOffset`, `observationLimit`, `scoreOffset`, `scoreLimit`. |
| `observations(traceId, { offset, limit })` | A page of observations. Default limit: 4096. |
| `scores(traceId, { offset, limit })` | A page of existing scores. Default limit: 1024. |
| `setBookmarked(traceId, boolean)` | The updated trace. It increments the revision. |
| `subscribe(listener)` | Returns an unsubscribe function. Notices contain `{ traceId, sessionId, revision }` after successful commits through this facade. |
| `writeTrace({ trace, observations })` | Writes a trace patch and changed observation rows. Resolves with a commit notice. |
| `flush()` | Waits for queued writes. Rejects if unresolved write failures remain. |
| `close()` | Idempotent shutdown that attempts a flush and closes the worker. |

Offsets start at zero. Limits must be positive integers. Observation and score page limits cap at 4096, and byte budgets can shorten a page.

A page contains `{ items, total, offset, limit, nextOffset, bytes, truncated }`. `get()` places page details under `pagination.observations` and `pagination.scores`, without `items` or `bytes`. Follow `nextOffset` until it is `null`. Do not assume that a requested limit equals the returned row count.

Reads attempt to flush queued writes first. After nonfatal write failures, reads can still return committed data. A successful read does not prove that all writes succeeded. Subscriptions do not watch changes from other processes or other store instances.

### Write trace patches

The compact example below writes illustrative sample data. It does not invoke a model.

```js
await store.writeTrace({
  trace: {
    id: 'sample-run-1',
    sessionId: 'sample-session-1',
    source: 'pi',
    name: 'Sample run',
    timestamp: '2026-01-01T12:00:00Z',
    status: 'completed',
    version: 'sample-v1'
  },
  observations: [{
    id: 'sample-observation-1',
    parentId: null,
    name: 'Sample step',
    type: 'SPAN',
    status: 'completed',
    output: 'Illustrative result'
  }]
})
```

A new trace needs `id` and `sessionId`. Defaults include source `pi`, status `running`, the current timestamp, zero usage, and version `0.1.0`. The current writer accepts only source `pi`. The framework-neutral API does not imply unrestricted trace sources.

`version` is a trace label. The store owns `revision` and increments it for committed patches. Callers do not supply an HTTP-style revision. SQLite schema version `1` is a separate value.

Trace fields include identity, name, status, timestamp, environment, user, model, version, input, output, tags, metadata, latency, tokens, and cost. Observation fields include `id`, `parentId`, name, type, status, level, model, input, output, metadata, start time, duration, tokens, and cost. Times and durations use seconds. `startTime` is relative to the trace start. Input and output accept text or values that the recorder converts to bounded JSON text.

Identifiers use 1 to 160 ASCII letters, digits, periods, colons, underscores, or hyphens. Status values are `running`, `completed`, `error`, and `aborted`. Levels are `DEBUG`, `DEFAULT`, `WARNING`, and `ERROR`. Types include `AGENT`, `SPAN`, `GENERATION`, `TOOL`, `EVENT`, `RETRIEVER`, `EMBEDDING`, `EVALUATOR`, `GUARDRAIL`, and `CHAIN`.

Supply only changed observations on later writes. Rows merge by ID, and metadata merges by key. Omitted rows remain in the database. Parent links must reference observations in the same trace and must not form cycles. Session identity and timestamp cannot change. A settled trace or observation cannot return to `running`.

`writeTrace()` ignores `trace.bookmarked` on creation and later writes. After the trace exists, call `setBookmarked(id, boolean)` to set or clear its bookmark. Capture writes preserve that state. Existing scores remain readable. Initial trace creation can include bounded `trace.scores`, but the facade has no `addScore()` method. Do not treat `writeTrace()` as a general score editor or delete API.

### Storage errors and bounds

`onError` reports failures. It does not consume promise rejections or prove durability. Await writes and handle rejections. `flush()` reports unresolved commit failures with an `AggregateError`. A fatal worker error makes the store unusable.

The core coalesces pending patches by trace and observation ID. Pending content has a 16 MiB bound and a 128-trace bound. The worker request limit is 64, with a 10-second timeout. Large writes split into smaller transactions, so a failed write can leave an earlier portion committed.

The core keeps a bounded ledger of unresolved writes. It is not a persistent retry queue. Resubmit the required changes if recovery is possible. A successful unrelated patch does not clear the failure. These limits control resource use, not lossless-capture guarantees.

## Attach Pi capture before prompting

Create one `createPiTracingExtension()` factory per agent runtime. Do not share a factory between concurrent sessions. The adapter registers event handlers and subscribes through public session APIs. It does not register model-callable capture tools.

| Option | Contract |
| --- | --- |
| `getStore()` | Required. Returns a sink, or a promise for one, with `writeTrace({ trace, observations })`. The sink can also provide `flush()`. |
| `enabled` | Enabled by default. Use `false` to disable new traces, or a synchronous `(ctx) => boolean` predicate. It does not stop an already active trace. |
| `getContext(ctx)` | Synchronous callback for extra session context and metadata. Pi session-manager values take precedence for known session fields. |
| `getParent(ctx)` | Synchronous callback for parent context. Supply this from the host's child-session relationship. |
| `isChildCaptured(link)` | Synchronous callback for child capture and usage state. See the child-session contract below. |
| `environment` | Trace environment label. Default: `local`. |
| `onError(error)` | Reports capture or storage failures. |

### Public SDK factory example

This setup example follows the Pi SDK 0.99.1 [extension example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts) and [SDK guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md). It assumes that the host also installs `@earendil-works/pi-coding-agent` and supplies its normal model, credentials, and resource policy. The example creates the attachment only. It does not send a prompt.

```js
import { createAgentSession, DefaultResourceLoader } from '@earendil-works/pi-coding-agent'
import { createPiTracingExtension } from '@elune/embedded/pi'

const tracing = createPiTracingExtension({
  getStore: () => store,
  onError: error => console.error('Trace capture:', error)
})
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  extensionFactories: [tracing]
})
await resourceLoader.reload()
const { session } = await createAgentSession({ resourceLoader })
tracing.bindSession(session)
await session.bindExtensions({})
```

The factory must load through the resource loader. `bindSession(session)` adds the public session subscription for authoritative results, retries, and compaction events. Binding alone does not install all extension lifecycle handlers.

Attach both paths before the host calls `session.prompt()`. Capture covers live agent runs, nested tools, usage, retries, cancellation, settlement, and compaction. Available event data determines what it can record.

After a runtime replaces its `AgentSession`, rebind with `tracing.bindSession(runtime.session)` and bind extensions on the new session. The replacement's resource loader must also include the factory. `bindSession()` detaches its previous subscription and returns an unsubscribe function. See Pi's [runtime example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/13-session-runtime.ts).

Do not modify SDK private event handlers. Keep trace management in the host, outside the model's tool set.

At shutdown, stop or await agent work, then await `tracing.close()`. It finalizes an active trace as aborted, detaches handlers, and attempts to flush. Close the shared store after all factories finish. Dispose the Pi session or runtime through its public API. Use cleanup paths that still close resources if an earlier operation rejects.

`tracing.flush()` waits for pending capture and child reconciliation. It does not end an active run. Capture event handlers fail open so tracing errors do not stop agent work. The adapter retains changed rows in bounded memory and retries eligible write failures, up to four attempts. It has no persistent disk queue like `integrations/pi/`.

Permanent failures stop further capture. `tracing.getDurability()` returns pending state, retained bytes, dirty and queued row counts, pending reconciliations, failed record count, and an error. Permanent capture errors carry `durable: false` and `retainedBytes`. Capture has 16 MiB content and accounting bounds, up to 128 retained traces, and bounded tool and reconciliation state. Overload, timeouts, process exit, and storage failure can cause incomplete capture. Handle `flush()` and `close()` rejection explicitly.

### Child sessions and late usage

The host owns parent-child relationships and must identify each captured child. The core cannot infer a parent from independent sessions.

Before starting a child, obtain `parentTracing.getParentContext(toolCallId)`. It returns `null` without an active parent trace. Otherwise, it returns `{ traceId, sessionId, sessionFile, toolCallId, observationId, entryId }`. Some anchors can be `null`. Pass this plain context through the child's `getParent()` callback.

Tool result `details` can identify children with `childSession: { id, path, cwd }` or recognized nested child descriptors. The adapter supplies `isChildCaptured(link)` with `{ sessionId, sessionFile, cwd }`.

Return one of these states:

- `false` or `{ captured: false }` when the child has no independent capture.
- `{ captured: true, usage }` when independent capture finished durably and usage is known.
- `{ captured: false, completion }` when capture is pending. `completion` must resolve to `{ captured: true, usage }` after durable capture.

Usage has `{ input, output, cacheRead, cacheWrite, cost }`. The adapter also accepts token aliases `inputTokens` and `outputTokens`. Prefer its native snapshot shape. A bare `true` lacks usage and cannot support accurate deduction. Missing or unknown state can mark `usageAttributionUnknown`.

`childTracing.getCapturedUsage()` returns `{ captured, usage }` synchronously. `childTracing.whenCaptured()` resolves with the same shape after the active trace ends, queued writes commit, and child reconciliations finish. It rejects on permanent capture failure. Usage accumulates across the factory lifetime. An unused factory can report `captured: true` with zero usage, so the host must separately track capture participation.

When child capture finishes after the tool result, the completion contract lets the adapter revise parent accounting after parent settlement. Reconciliation has a 15-second timeout. The host must supply completion and the corresponding usage for each child, without duplicate or overlapping attribution. Do not use a combined factory total as one child's usage. Do not subtract child usage twice. The adapter can deduct known, independently captured child contributions from inclusive parent tool usage, but it cannot invent missing usage or relationships.

## Embed the Vue views

The three views share the same client and selection contract:

| View | Role | Scope |
| --- | --- | --- |
| A: `TraceInspector` | Compact inspector beside host content | Requires `sessionId` |
| B: `TraceWorkspace` | Wider session view with a timeline | Uses `sessionId`, or infers it from the selected trace |
| C: `TraceExplorer` | Trace list across projects with a selected preview | All traces by default, with optional session and project filters |

Sample embedded views: [inspector](screenshots/embedded-inspector.png), [workspace](screenshots/embedded-workspace.png), [explorer](screenshots/embedded-explorer.png).

This illustrative host SFC mounts only the selected view. `client`, `sessionId`, `currentSurface`, `panelActive`, and navigation handlers come from the host.

```vue
<script setup>
import { ref } from 'vue'
import { TraceInspector, TraceWorkspace, TraceExplorer } from '@elune/embedded/vue'
import '@elune/embedded/vue/style.css'

const views = { inspector: TraceInspector, workspace: TraceWorkspace, explorer: TraceExplorer }
const selection = ref({ traceId: null, observationId: null, tab: 'output', observationOffset: 0, observationLimit: 200 })
const listState = ref({ q: '', status: '', cwd: '', page: 1, limit: 20 })
</script>

<template>
  <component
    :is="views[currentSurface]"
    :client="client"
    :session-id="sessionId"
    :active="panelActive"
    v-model:selection="selection"
    v-model:list-state="listState"
    @open-workspace="openWorkspace"
    @open-session="openSession"
    @close="closePanel"
  />
</template>
```

`selection` contains `traceId`, `observationId`, `tab`, `observationOffset`, and `observationLimit`. Tabs are `input`, `output`, and `metadata`. Defaults are null IDs, output tab, offset 0, and limit 200. The views cap observation batches at 200.

`listState` contains `q`, `status`, `cwd`, `page`, and `limit`. Defaults are empty filters, page 1, and limit 20. The views cap list pages at 50. Explorer applies search, status, and project filters. Inspector and workspace list runs for their session.

Keep selection when moving between A, B, and C. Keep explorer filters and page state in the host when returning from a workspace. Changing trace selection normally resets the observation anchor and batch offset.

### Client contract

The renderer client provides these methods:

| Method | Contract |
| --- | --- |
| `list(filters, { signal })` | Returns `{ traces, total, page, limit }` with the core's summary shape. |
| `get(id, { signal, observationOffset, observationLimit })` | Returns a trace or `null`, including the requested observation page and its pagination. |
| `setBookmarked(id, boolean, { signal })` | Optional. Returns the updated trace. Without it, the view hides bookmark controls. |
| `subscribe(listener)` | Optional. Returns an unsubscribe function. Delivers commit notices or `{ type: 'reconnect' }` to request a refresh. |

A same-process Node/Vue host can use the store as its client. The core ignores signal arguments and does not cancel worker operations. A transported client should honor abort signals where possible. Views discard stale responses, but that does not undo a committed bookmark write.

Browser or sandboxed Electron renderers need a host-owned transport, such as a narrow IPC bridge. Keep SQLite and Node imports in the Node process. Do not expose arbitrary file paths or database operations to the renderer. Return the core response shapes and preserve pagination and revision fields.

### Navigation and focus

The views emit `update:selection`, `update:listState`, `open-workspace`, `open-session`, and `close`.

`open-workspace` carries `{ selection, sessionId, cwd }`. Use it to activate the workspace with the same trace, observation, tab, and batch. The view does not perform host navigation.

`open-session` carries `{ sessionId, entryId?, sessionFile? }` for the current session. It chooses the first available anchor: tool-result entry, message entry, compaction entry, trace end, user entry, then trace start. Child links carry `{ sessionId, sessionFile?, cwd? }` and do not invent an entry anchor.

The host validates targets, opens its session view, moves focus, and restores focus after close or back. Internal narrow-layout controls manage their own panel focus. They do not manage application-wide focus or history.

### Visibility, layout, and CSS

Capture runs independently of UI mounting and visibility. Keep capture active even when no trace panel is open.

Prefer one active view. Unmount closed views or set `active` to `false`. CSS hiding alone does not deactivate a component. Inactive views detach subscriptions, clear timers, and abort client requests. The explorer avoids new detail requests while its narrow-layout preview is hidden.

The components also pause when `document.visibilityState` is `hidden`, then refresh on return. Native hidden Electron windows do not always map to that browser state. Pass host visibility through `active`. Do not assume every hidden window stops requests. An already dispatched core worker operation can still finish.

Give the containing panel a defined height and allow flex or grid children to shrink. The stylesheet uses container queries for compact layouts. Rules stay under `.elune-ui`, with a dark default and the elune lunar symbol.

The root derives `--elune-bg`, `--elune-panel`, `--elune-border`, `--elune-text`, and `--elune-muted` from host tokens `--bg`, `--panel`, `--border`, `--text`, and `--muted`. It also defines `--elune-model`, `--elune-tool`, and `--elune-selected`. Apply scoped host overrides after the explicit CSS import.

For Electron ASAR packaging, unpack the core, worker, and local module files, for example `node_modules/@elune/embedded/embedded/**`. Preserve all module-relative paths. The host must import the core from its physical `app.asar.unpacked` location. The core resolves `./worker.js` relative to `import.meta.url` for `new Worker()`. Copying worker files outside the archive alone is insufficient. Do not rely on a normal package import to redirect the worker.

The host can resolve the package export, replace the archive path, and dynamically import the unpacked core:

```js
const coreUrl = import.meta.resolve('@elune/embedded').replace(/\.asar\//, '.asar.unpacked/')
const { createElune } = await import(coreUrl)
```

Alternatively, package the core and its local module files without an ASAR archive. Neither approach requires a separate service.

## Understand content limits

Recording limits differ from read limits and UI pagination:

- Recording caps each input and output field at 32 KiB. Labels and metadata have smaller bounds. Structured payloads omit selected headers, credentials, image blobs, and reasoning fields.
- Markers such as `[truncated]`, `[omitted]`, and `omitted: true` identify content that the recorder did not retain. Another page cannot recover it.
- Reads clip oversized stored fields without changing the database. `readTruncation.fields` and `[truncated on read]` identify that clipping. Reads also enforce byte budgets, so follow pagination even when fewer rows arrive than requested.
- An observation batch contains only part of the recorded trace. Batch totals count recorded observations, not necessarily every step in an incomplete capture.
- Observation search matches names, types, models, and status in the loaded batch only. It does not search all observations or payloads. Load another batch to search that batch.
- Payload paging splits the returned text for display. It does not retrieve content that recording or read clipping omitted.

## Privacy and existing data

Prompts, tool arguments, results, metadata, and session paths can contain secrets. Structured-field filtering is not guaranteed redaction. Plain text can retain credentials even when a similarly named structured field would be omitted.

The package provides no encryption, authentication, remote access control, retention scheduler, or general delete API. The host owns storage location, data access, transport security, retention, backups, exports, and screenshot review. Keep private data out of version control. Pi still sends model requests to the selected provider.

A new embedded store starts empty. It does not import Pi JSONL sessions, old JSON trace stores, or HTTP exporter queues. Adding the adapter captures subsequent activity. It does not backfill existing session history.

The embedded worker and Go store currently share SQLite schema version `1` and the trace, observation, and score table shapes. This permits reads of compatible existing databases, subject to permissions, read limits, and revision bounds. It does not promise every legacy database or standalone HTTP ingestion behavior.

The embedded writer uses patches and store-owned revisions. Go HTTP ingestion has its own validation and revision contract. Prefer separate storage unless the host explicitly manages shared access. Local subscription notices do not synchronize external writers.

## Source references

- [Package exports and requirements](https://github.com/spmurrayzzz/elune/blob/master/package.json)
- [Store facade](https://github.com/spmurrayzzz/elune/blob/master/embedded/index.js), [SQLite worker](https://github.com/spmurrayzzz/elune/blob/master/embedded/worker.js), and [content bounds](https://github.com/spmurrayzzz/elune/blob/master/embedded/content.js)
- [Pi adapter](https://github.com/spmurrayzzz/elune/blob/master/embedded/pi.js)
- [Vue props](https://github.com/spmurrayzzz/elune/blob/master/embedded/vue/props.js), [client lifecycle](https://github.com/spmurrayzzz/elune/blob/master/embedded/vue/useTraces.js), and [navigation anchors](https://github.com/spmurrayzzz/elune/blob/master/embedded/vue/format.js)
- [Standalone Go store](https://github.com/spmurrayzzz/elune/blob/master/backend/store.go)
