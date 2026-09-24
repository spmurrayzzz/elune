import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const work = join(repo, 'work/pi-integration');
const baseURL = (process.env.PI_TRACE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const model = process.env.PI_TEST_MODEL || 'openai-codex/gpt-6-sol';
const timeout = Number(process.env.PI_TEST_TIMEOUT_MS || 120000);
assert(Number.isFinite(timeout) && timeout > 0, 'PI_TEST_TIMEOUT_MS must be positive');
await mkdir(work, { recursive: true });
const runPath = await mkdtemp(join(work, 'run-'));
const fixture = join(runPath, 'fixture');
await mkdir(fixture);
await writeFile(join(fixture, 'package.json'), '{"type":"module"}\n');
await writeFile(join(fixture, 'add.js'), 'export const add = (a, b) => a - b;\n');
await mkdir(join(fixture, '.pi'));
await writeFile(join(fixture, '.pi/settings.json'), JSON.stringify({ compaction: { enabled: true, reserveTokens: 1000000000, keepRecentTokens: 128 } }));
const triggerExtension = join(runPath, 'trigger.ts');
await writeFile(triggerExtension, `export default function (pi) {
  let compact = false;
  pi.on('session_before_compact', () => compact ? undefined : { cancel: true });
  pi.registerCommand('elune-test-run', {
    handler: async (marker, ctx) => {
      if (!ctx.isIdle()) throw new Error('Extension test requires an idle agent');
      compact = true;
      pi.sendMessage({ customType: 'elune-integration', content: marker + ': Reply with one short sentence. Do not use tools.', display: false }, { triggerTurn: true });
    },
  });
}
`);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = new Map();
const liveTraceIds = new Set();
const notices = new Set();
const streamController = new AbortController();
const summary = { passed: false, model, cwd: fixture, sessionId: '', traceIds: [], checks: [] };
let child;
let childExited = false;
let stopping = false;
let currentRun;
let stderrBytes = 0;
let streamTask;
let streamError;
let nextRequest = 0;

async function getJSON(path) {
  const response = await fetch(`${baseURL}${path}`, { signal: AbortSignal.timeout(5000) });
  assert(response.ok, `GET ${path} returned ${response.status}`);
  return response.json();
}

async function startStream() {
  const response = await fetch(`${baseURL}/api/events`, { signal: streamController.signal });
  assert(response.ok && response.headers.get('content-type')?.includes('text/event-stream'), 'Trace events must use SSE');
  streamTask = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!block.split('\n').includes('event: traces')) continue;
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        const notice = JSON.parse(data);
        const pending = getJSON(`/api/traces/${encodeURIComponent(notice.traceId)}`).then(trace => {
          if (trace.status === 'running') liveTraceIds.add(trace.id);
        }).catch(error => { streamError = error; }).finally(() => notices.delete(pending));
        notices.add(pending);
      }
    }
  })().catch(error => {
    if (!streamController.signal.aborted) streamError = error;
  });
}

function failPending(error) {
  for (const pending of requests.values()) pending.reject(error);
  requests.clear();
  currentRun?.reject(error);
}

function request(type, fields = {}) {
  return new Promise((resolve, reject) => {
    if (childExited || !child?.stdin.writable) return reject(new Error('Pi is not running'));
    const id = `integration-${++nextRequest}`;
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error(`Pi ${type} response timed out`));
    }, timeout);
    requests.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  });
}

function receive(event) {
  if (event.type === 'response') {
    const pending = requests.get(event.id);
    requests.delete(event.id);
    if (event.success) pending?.resolve(event.data);
    else pending?.reject(new Error(`Pi rejected ${event.command}`));
    return;
  }
  const run = currentRun;
  if (!run) return;
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    run.messages.push({ usage: event.message.usage, stopReason: event.message.stopReason });
  }
  if (event.type === 'compaction_end' && event.result) run.compactions.push({ reason: event.reason, usage: event.result.usage });
  if (event.type === 'tool_execution_start') {
    run.tools.set(event.toolCallId, { name: event.toolName, args: event.args });
    if (run.abort && event.toolName === 'bash' && event.args?.command.includes('sleep 5')) {
      run.abort = false;
      run.abortTask = pause(200).then(() => request('abort')).catch(run.reject);
    }
  }
  if (event.type === 'tool_execution_end') {
    Object.assign(run.tools.get(event.toolCallId) || {}, { result: event.result, isError: event.isError });
  }
  if (event.type === 'agent_settled') run.resolve();
}

async function runPrompt(message, abort = false) {
  let resolveRun;
  let rejectRun;
  const settled = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
  settled.catch(() => {});
  const run = { messages: [], compactions: [], tools: new Map(), abort, resolve: resolveRun, reject: rejectRun };
  currentRun = run;
  const timer = setTimeout(() => rejectRun(new Error('Pi did not emit agent_settled before the timeout')), timeout);
  try {
    await request('prompt', { message });
    await settled;
    await run.abortTask;
    return run;
  } finally {
    clearTimeout(timer);
    currentRun = undefined;
  }
}

async function waitForTrace(marker) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { data } = await getJSON('/api/traces');
    const matches = data.filter(trace => trace.source === 'pi' && trace.sessionId === summary.sessionId && trace.input.includes(marker));
    assert(matches.length <= 1, 'One request must produce one trace');
    if (matches[0] && matches[0].status !== 'running') return matches[0];
    await pause(100);
  }
  throw new Error('Completed Pi trace was not persisted within 10 seconds');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function verifyUsage(trace, run) {
  const generations = trace.observations.filter(observation => observation.type === 'GENERATION');
  const calls = [...run.messages, ...run.compactions];
  assert.equal(generations.length, calls.length, 'Each model response and compaction must create a generation');
  const actualUsage = calls.map(message => JSON.stringify(canonical(message.usage))).sort();
  const tracedUsage = generations.map(generation => JSON.stringify(canonical(generation.metadata.usage))).sort();
  assert.deepEqual(tracedUsage, actualUsage, 'Generation metadata must preserve all Pi usage fields');
  const inputTokens = calls.reduce((sum, { usage }) => sum + usage.input + usage.cacheRead + usage.cacheWrite, 0);
  const outputTokens = calls.reduce((sum, { usage }) => sum + usage.output, 0);
  const cost = calls.reduce((sum, { usage }) => sum + usage.cost.total, 0);
  assert.equal(trace.inputTokens, inputTokens, 'Trace input tokens must include cached input');
  assert.equal(trace.outputTokens, outputTokens, 'Trace output tokens must count reasoning only once');
  assert.equal(trace.totalTokens, inputTokens + outputTokens, 'Trace token total must match Pi');
  assert(Math.abs(trace.cost - cost) < 1e-9, 'Trace cost must match Pi');
  assert.equal(generations.reduce((sum, generation) => sum + generation.inputTokens, 0), inputTokens);
  assert.equal(generations.reduce((sum, generation) => sum + generation.outputTokens, 0), outputTokens);
  assert(Math.abs(generations.reduce((sum, generation) => sum + generation.cost, 0) - cost) < 1e-9);
  return { generations: generations.length, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cost };
}

function verifyTrace(trace, run, requiredTools = []) {
  assert.equal(trace.metadata.cwd, fixture, 'Trace must preserve the coding directory');
  assert(trace.sessionId, 'Trace must have a session ID');
  assert(trace.observations.some(observation => observation.type === 'AGENT'), 'Trace must have an agent observation');
  assert(trace.observations.every(observation => Number.isFinite(observation.duration) && observation.duration >= 0), 'Observation durations must be nonnegative');
  const observations = trace.observations.filter(observation => observation.type === 'TOOL');
  for (const toolName of requiredTools) {
    assert([...run.tools.values()].some(tool => tool.name === toolName), `Pi must execute ${toolName}`);
  }
  for (const [toolCallId, tool] of run.tools) {
    const observation = observations.find(item => item.metadata.toolCallId === toolCallId);
    assert(observation, `Missing ${tool.name} observation`);
    assert.equal(typeof observation.input, 'string');
    assert(observation.input.length > 0, `${tool.name} input must be captured`);
    assert.equal(typeof observation.output, 'string');
    if (tool.result) {
      assert(observation.output.length > 0, `${tool.name} output must be captured`);
      for (const content of tool.result.content || []) {
        if (content.type === 'text' && content.text) {
          const output = observation.output.replace(/\\n/g, '\n').replace(/\\"/g, '"');
          assert(output.includes(content.text.slice(0, 100)), `${tool.name} output must preserve the tool result`);
        }
      }
    }
    if (tool.isError) assert.equal(observation.level, 'ERROR', 'Tool errors must remain visible');
  }
  return verifyUsage(trace, run);
}

async function stopPi() {
  if (!child || childExited) return;
  stopping = true;
  child.stdin.end();
  for (let i = 0; i < 50 && !childExited; i++) await pause(100);
  if (!childExited) child.kill('SIGTERM');
  for (let i = 0; i < 20 && !childExited; i++) await pause(100);
  if (!childExited) child.kill('SIGKILL');
}

try {
  await getJSON('/api/health');
  await startStream();
  child = spawn(process.env.PI_TEST_EXECUTABLE || 'pi', [
    '--mode', 'rpc', '--offline', '--no-extensions', '-e', join(repo, 'integrations/pi'),
    '-e', triggerExtension, '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--approve',
    '--session-dir', join(work, 'sessions'), '--model', model, '--thinking', 'low', '--tools', 'read,edit,write,bash',
  ], {
    cwd: fixture,
    env: { ...process.env, PI_TRACE_URL: baseURL, PI_TRACE_QUEUE_DIR: join(runPath, 'queue') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  child.on('error', error => failPending(new Error(`Pi could not start (${error.code || 'spawn error'})`)));
  child.on('exit', (code, signal) => {
    childExited = true;
    if (!stopping) failPending(new Error(`Pi exited unexpectedly (${signal || code}; ${stderrBytes} stderr bytes)`));
  });
  child.stdin.on('error', () => failPending(new Error('Pi input stream closed')));
  createInterface({ input: child.stdout }).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    receive(event);
  });
  const state = await request('get_state');
  summary.sessionId = state.sessionId;
  assert(summary.sessionId, 'Pi must provide its session ID');
  const marker = `pi-integration-${randomUUID()}`;
  const coding = await runPrompt(`${marker}: Use the read tool to inspect add.js. Use the edit tool to fix add(a, b) so it adds instead of subtracting. Then use the bash tool to run exactly: node --input-type=module -e "import { add } from './add.js'; if (add(17, 25) !== 42) throw new Error('wrong sum'); console.log('pi-integration-ok:42')". Finish with one short sentence.`);
  const codingTrace = await waitForTrace(marker);
  assert.equal(codingTrace.status, 'completed', 'Successful coding trace must be completed');
  summary.coding = verifyTrace(codingTrace, coding, ['read', 'edit', 'bash']);
  assert(summary.coding.generations >= 2, 'Coding trace must include multiple model calls');
  assert.equal((await import(pathToFileURL(join(fixture, 'add.js')))).add(17, 25), 42, 'Pi must fix the real file');
  await Promise.all([...notices]);
  assert(liveTraceIds.has(codingTrace.id), 'SSE must expose the trace while it is running');
  summary.traceIds.push(codingTrace.id);
  summary.checks.push('real file edited and verified', 'read/edit/bash inputs and outputs', 'exact model usage and costs', 'live SSE trace');

  const errorMarker = `pi-integration-error-${randomUUID()}`;
  const failure = await runPrompt(`${errorMarker}: Use the bash tool to run exactly: printf pi-integration-error >&2; exit 7. This is an intentional integration check. Do not retry or change the command. Finish with one sentence stating that it failed.`);
  const failureTrace = await waitForTrace(errorMarker);
  summary.failure = verifyTrace(failureTrace, failure, ['bash']);
  assert([...failure.tools.values()].some(tool => tool.isError), 'Pi must observe the intentional tool error');
  assert(failureTrace.observations.some(observation => observation.type === 'TOOL' && observation.level === 'ERROR' && observation.output.includes('pi-integration-error')), 'Trace must preserve failed tool output');
  assert.equal(failureTrace.sessionId, codingTrace.sessionId, 'Consecutive requests must share a Pi session');
  assert.notEqual(failureTrace.id, codingTrace.id, 'Consecutive requests must have separate traces');
  summary.traceIds.push(failureTrace.id);
  summary.checks.push('failed tool preserved', 'session groups separate requests');

  const abortMarker = `pi-integration-abort-${randomUUID()}`;
  const aborted = await runPrompt(`${abortMarker}: Use the bash tool to run exactly: sleep 5. Do not run any other tools. Then reply done.`, true);
  const abortedTrace = await waitForTrace(abortMarker);
  assert.equal(abortedTrace.status, 'aborted', 'Aborted Pi request must be marked aborted');
  summary.aborted = verifyTrace(abortedTrace, aborted, ['bash']);
  summary.traceIds.push(abortedTrace.id);
  summary.checks.push('abort during tool execution');

  const previousTraces = await Promise.all(summary.traceIds.map(id => getJSON(`/api/traces/${encodeURIComponent(id)}`)));
  const extensionMarker = `pi-integration-extension-${randomUUID()}`;
  const extension = await runPrompt(`/elune-test-run ${extensionMarker}`);
  const extensionTrace = await waitForTrace(extensionMarker);
  assert.equal(extensionTrace.status, 'completed', 'Extension-triggered run must complete');
  assert.equal(extensionTrace.sessionId, codingTrace.sessionId, 'Extension-triggered run must keep the Pi session');
  assert(!summary.traceIds.includes(extensionTrace.id), 'Extension-triggered run must create a new trace');
  assert.equal(extension.compactions.length, 1, 'Extension-triggered run must perform one automatic compaction');
  assert.equal(extension.compactions[0].reason, 'threshold', 'Compaction must use the automatic threshold');
  const finalState = await request('get_state');
  const sessionEntries = (await readFile(finalState.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const compactions = sessionEntries.filter(entry => entry.type === 'compaction');
  assert.equal(compactions.length, 1, 'Pi must save the automatic compaction in its session');
  const compaction = compactions[0];
  assert(compaction.usage.totalTokens > 0, 'Real compaction must report token usage');
  assert.deepEqual(compaction.usage, extension.compactions[0].usage, 'RPC compaction usage must match the saved session entry');
  const compactGeneration = extensionTrace.observations.find(observation => observation.metadata.compactionId === compaction.id);
  assert(compactGeneration, 'Compaction generation must refer to the saved session entry');
  assert.equal(compactGeneration.type, 'GENERATION');
  assert.deepEqual(compactGeneration.metadata.usage, compaction.usage, 'Compaction generation must preserve the session usage');
  summary.extension = verifyTrace(extensionTrace, extension);
  summary.compaction = compaction.usage;
  for (const trace of previousTraces) {
    assert.deepEqual(await getJSON(`/api/traces/${encodeURIComponent(trace.id)}`), trace, 'Extension-triggered run must not change a previous trace');
  }
  summary.traceIds.push(extensionTrace.id);
  summary.checks.push('idle extension run creates a separate trace', 'previous traces remain unchanged', 'automatic compaction preserves exact tokens and costs');
  await stopPi();
  for (const id of summary.traceIds) {
    assert.notEqual((await getJSON(`/api/traces/${encodeURIComponent(id)}`)).status, 'running', 'Trace must remain complete after Pi exits');
  }
  if (streamError) throw new Error(`SSE verification failed: ${streamError.message}`);
  summary.checks.push('traces persist after Pi exits');
  summary.passed = true;
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  await stopPi();
  streamController.abort();
  await streamTask;
  await Promise.all([...notices]);
  await writeFile(join(work, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
