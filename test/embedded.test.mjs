import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createElune } from '@elune/embedded'

const windows = process.platform === 'win32'
const requireWindowsChecks = process.env.ELUNE_TEST_REQUIRE_WINDOWS_CHECKS === '1' || ['true', '1'].includes(process.env.CI)
const suffixes = ['', '-wal', '-shm']
const unusualName = "space 雪 O'Brien [trace] $name `tick"
const windowsDirectoryFailure = /Database directory must have private Windows permissions/
const symlinkFailure = /symlink|reparse/i
const testOptions = { timeout: 90000 }
const windowsOptions = { ...testOptions, skip: !windows && 'Windows ACL check' }

function powershell(script, data) {
  assert.equal(windows, true)
  const code = readFileSync(new URL(script, import.meta.url), 'utf8')
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const output = execFileSync(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64'),
  ], {
    input: Buffer.from(JSON.stringify(data)).toString('base64'),
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 256 * 1024,
  })
  return JSON.parse(output.trim())
}

function setAcl(path, mode) {
  assert.equal(powershell('windows-acl.ps1', { action: 'set', path, mode }).ok, true)
}

function inspectAcl(paths) {
  return powershell('windows-acl.ps1', { action: 'inspect', paths })
}

async function fixture(t, base = tmpdir()) {
  const root = await mkdtemp(join(base, 'elune-embedded-'))
  const directory = join(root, unusualName)
  const databasePath = join(directory, `${unusualName}.db`)
  const stores = []
  t.after(async () => {
    const results = await Promise.allSettled(stores.map(store => store.close()))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Fixture stores did not close')
  })
  return {
    root, directory, databasePath,
    open() {
      const store = createElune({ databasePath })
      stores.push(store)
      return store
    },
  }
}

function sample(id = 'sample-trace') {
  return {
    trace: {
      id, sessionId: 'sample-session', name: 'Sample trace 雪', source: 'pi',
      timestamp: '2026-01-01T12:00:00Z', status: 'completed', input: 'Sample input', output: 'Sample output',
    },
    observations: [{ id: 'sample-step', parentId: null, name: 'Sample step', type: 'SPAN', status: 'completed', output: 'Sample result' }],
  }
}

async function privateDirectory(path) {
  await mkdir(path, { mode: 0o700 })
  if (windows) setAcl(path, 'private')
  else await chmod(path, 0o700)
}

async function snapshot(directory) {
  return Promise.all((await readdir(directory)).sort().map(async name => {
    const path = join(directory, name)
    return [name, (await lstat(path)).isSymbolicLink() ? await readlink(path) : await readFile(path)]
  }))
}

async function rejectWrite(databasePath, pattern) {
  const store = createElune({ databasePath })
  try {
    await assert.rejects(store.writeTrace(sample('blocked-trace')), pattern)
    await assert.rejects(store.flush())
  } finally {
    await store.close().catch(() => {})
  }
}

function assertPrivateAcl(item, currentSid, directory, protectedDirectory = true) {
  const trusted = [currentSid, 'S-1-5-18', 'S-1-5-32-544'].sort()
  assert.ok(trusted.includes(item.owner), `Untrusted owner: ${item.path}`)
  assert.equal(item.daclPresent, true, item.path)
  assert.equal(item.nullDacl, false, item.path)
  assert.deepEqual(item.rules.map(rule => rule.sid).sort(), trusted, item.path)
  assert.deepEqual(item.aceTypes, item.rules.map(() => 'AccessAllowed'), item.path)
  if (directory && protectedDirectory) assert.equal(item.protected, true, item.path)
  for (const rule of item.rules) {
    assert.equal(rule.type, 'Allow', item.path)
    assert.equal(rule.rights, 0x1f01ff, item.path)
    assert.equal(rule.inheritance, directory ? 3 : 0, item.path)
    assert.equal(rule.propagation, 0, item.path)
    if (item.protected) assert.equal(rule.inherited, false, item.path)
  }
}

async function assertPrivateStore(f) {
  const files = suffixes.map(suffix => f.databasePath + suffix)
  assert.equal((await lstat(f.directory)).isDirectory(), true)
  for (const path of files) {
    const info = await lstat(path)
    assert.equal(info.isFile(), true, path)
    assert.ok(info.size > 0, `Live SQLite file is empty: ${path}`)
  }
  if (windows) {
    const { currentSid, items } = inspectAcl([f.directory, ...files])
    assert.equal(items.length, 4)
    items.forEach((item, index) => assertPrivateAcl(item, currentSid, index === 0))
  } else {
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700)
    for (const path of files) assert.equal((await lstat(path)).mode & 0o777, 0o600, path)
  }
}

async function makeSymlink(t, target, path, directory = false) {
  try {
    await symlink(target, path, directory ? (windows ? 'junction' : 'dir') : 'file')
    return true
  } catch (error) {
    if (!windows || !['EPERM', 'EACCES'].includes(error.code) || requireWindowsChecks) throw error
    t.skip(`Windows symlink privilege is unavailable (${error.code}); CI requires this check`)
    return false
  }
}

test('new private storage writes, reads, lists, flushes, and reopens unusual paths', testOptions, async t => {
  const f = await fixture(t)
  if (windows) setAcl(f.root, 'public')
  await assert.rejects(lstat(f.directory), { code: 'ENOENT' })
  const store = f.open()
  assert.deepEqual(await store.list(), { traces: [], total: 0, page: 1, limit: 50 })
  assert.equal(await store.get('missing-trace'), null)
  const notice = await store.writeTrace(sample())
  assert.deepEqual(notice, { traceId: 'sample-trace', sessionId: 'sample-session', revision: 1 })
  await store.flush()
  const trace = await store.get('sample-trace')
  assert.equal(trace.name, 'Sample trace 雪')
  assert.equal(trace.input, 'Sample input')
  assert.equal(trace.output, 'Sample output')
  assert.equal(trace.observations.length, 1)
  assert.equal(trace.observations[0].output, 'Sample result')
  const page = await store.list({ sessionId: 'sample-session', q: '雪', limit: 1 })
  assert.equal(page.total, 1)
  assert.deepEqual(page.traces.map(item => item.id), ['sample-trace'])
  assert.equal(Object.hasOwn(page.traces[0], 'input'), false)
  assert.equal(Object.hasOwn(page.traces[0], 'output'), false)
  await assertPrivateStore(f)
  await store.close()
  await store.close()
  const reopened = f.open()
  assert.deepEqual(await reopened.get('sample-trace'), trace)
  await reopened.writeTrace({ trace: { id: 'sample-trace', output: 'Updated sample output' } })
  await reopened.flush()
  assert.equal((await reopened.get('sample-trace')).output, 'Updated sample output')
  assert.equal((await reopened.list()).total, 1)
  await assertPrivateStore(f)
  await reopened.close()
})

test('an existing private directory is reusable', testOptions, async t => {
  const f = await fixture(t)
  await privateDirectory(f.directory)
  const store = f.open()
  await store.writeTrace(sample())
  await store.flush()
  await assertPrivateStore(f)
})

test('an unsafe existing directory is rejected without creating database files', testOptions, async t => {
  const f = await fixture(t)
  await mkdir(f.directory, { mode: 0o755 })
  if (windows) {
    setAcl(f.directory, 'broad')
    assert.ok(inspectAcl([f.directory]).items[0].rules.some(rule => rule.sid === 'S-1-1-0'))
  } else {
    await chmod(f.directory, 0o755)
  }
  const before = windows ? inspectAcl([f.directory]).items[0].sddl : (await lstat(f.directory)).mode
  await rejectWrite(f.databasePath, windows ? windowsDirectoryFailure : /Database directory must have private permissions/)
  assert.deepEqual(await readdir(f.directory), [])
  const after = windows ? inspectAcl([f.directory]).items[0].sddl : (await lstat(f.directory)).mode
  assert.equal(after, before)
})

test('a directory symlink or Windows junction is rejected without writing its target', testOptions, async t => {
  const f = await fixture(t)
  const target = join(f.root, 'directory-target')
  await privateDirectory(target)
  if (!await makeSymlink(t, target, f.directory, true)) return
  await rejectWrite(f.databasePath, symlinkFailure)
  assert.equal((await lstat(f.directory)).isSymbolicLink(), true)
  assert.deepEqual(await readdir(target), [])
})

for (const [ending, label] of [['.', 'dot'], [' ', 'space']]) {
  for (const component of ['filename', 'parent directory']) {
    test(`a Windows ${component} ending in a ${label} is rejected without changing canonical storage`, windowsOptions, async t => {
      const f = await fixture(t)
      const store = f.open()
      await store.writeTrace(sample('existing-trace'))
      await store.close()
      const path = component === 'filename' ? f.databasePath + ending : join(f.directory + ending, `${unusualName}.db`)
      const before = await snapshot(f.directory)
      const paths = [f.directory, f.databasePath]
      const acl = inspectAcl(paths)
      await rejectWrite(path, /Database path must not contain components ending in a period or space/)
      assert.deepEqual(await snapshot(f.directory), before)
      assert.deepEqual(inspectAcl(paths), acl)
      assert.deepEqual(await readdir(f.root), [unusualName])
    })
  }
}

test('Windows alternate data streams cannot bypass file ACL checks', windowsOptions, async t => {
  const f = await fixture(t)
  await privateDirectory(f.directory)
  const container = join(f.directory, 'public-container.dat')
  await writeFile(container, 'Sample stream container must not change')
  setAcl(container, 'broad')
  const acl = inspectAcl([container])
  assert.ok(acl.items[0].rules.some(rule => rule.sid === 'S-1-1-0'))
  const before = await snapshot(f.directory)
  await rejectWrite(`${container}:traces`, /Database path must not contain alternate data streams/)
  assert.deepEqual(await snapshot(f.directory), before)
  assert.deepEqual(inspectAcl([container]), acl)
})

for (const suffix of suffixes) {
  test(`an existing ${suffix || 'database'} file symlink is rejected without changing files`, testOptions, async t => {
    const f = await fixture(t)
    const store = f.open()
    await store.writeTrace(sample('existing-trace'))
    await store.close()
    const path = f.databasePath + suffix
    await rm(path, { force: true })
    const target = join(f.root, 'file-target')
    const content = Buffer.from('Sample symlink target must not change')
    await writeFile(target, content, { mode: 0o600 })
    if (!await makeSymlink(t, target, path)) return
    const before = await snapshot(f.directory)
    await rejectWrite(f.databasePath, symlinkFailure)
    assert.deepEqual(await snapshot(f.directory), before)
    assert.deepEqual(await readFile(target), content)
  })

  test(`a broad existing ${suffix || 'database'} Windows ACL is rejected before SQLite opens it`, windowsOptions, async t => {
    const f = await fixture(t)
    const store = f.open()
    await store.writeTrace(sample('existing-trace'))
    await store.close()
    const path = f.databasePath + suffix
    if (suffix) await writeFile(path, 'Sample preexisting sidecar must not change')
    setAcl(path, 'broad')
    const acl = inspectAcl([path]).items[0]
    assert.ok(acl.rules.some(rule => rule.sid === 'S-1-1-0'))
    const before = await snapshot(f.directory)
    await rejectWrite(f.databasePath, /Database files must have private Windows permissions/)
    assert.deepEqual(await snapshot(f.directory), before)
    assert.equal(inspectAcl([path]).items[0].sddl, acl.sddl)
  })

  test(`a NULL DACL on an existing Windows ${suffix || 'database'} file is rejected without changing its safe inherited directory`, windowsOptions, async t => {
    const f = await fixture(t)
    setAcl(f.root, 'private')
    await mkdir(f.directory)
    const path = f.databasePath + suffix
    await writeFile(path, 'Sample preexisting file must not change')
    setAcl(path, 'null')
    const paths = [f.directory, path]
    const acl = inspectAcl(paths)
    assert.equal(acl.items[0].protected, false)
    assert.ok(acl.items[0].rules.every(rule => rule.inherited))
    assertPrivateAcl(acl.items[0], acl.currentSid, true, false)
    assert.equal(acl.items[1].nullDacl, true)
    const before = await snapshot(f.directory)
    await rejectWrite(f.databasePath, /Database files must have private Windows permissions/)
    assert.deepEqual(await snapshot(f.directory), before)
    assert.deepEqual(inspectAcl(paths), acl)
  })
}

test('a safe inherited Windows directory is protected when storage opens', windowsOptions, async t => {
  const f = await fixture(t)
  setAcl(f.root, 'private')
  await mkdir(f.directory)
  const before = inspectAcl([f.directory])
  assert.equal(before.items[0].protected, false)
  assert.ok(before.items[0].rules.every(rule => rule.inherited))
  assertPrivateAcl(before.items[0], before.currentSid, true, false)
  const store = f.open()
  await store.writeTrace(sample())
  await store.flush()
  await assertPrivateStore(f)
})

for (const mode of ['null', 'deny']) {
  test(`a Windows directory with a ${mode} ACL is rejected without writing traces`, windowsOptions, async t => {
    const f = await fixture(t)
    await mkdir(f.directory)
    setAcl(f.directory, mode)
    const before = inspectAcl([f.directory]).items[0]
    if (mode === 'null') assert.equal(before.nullDacl, true)
    else assert.ok(before.rules.some(rule => rule.type === 'Deny'))
    await rejectWrite(f.databasePath, windowsDirectoryFailure)
    assert.deepEqual(await readdir(f.directory), [])
    assert.equal(inspectAcl([f.directory]).items[0].sddl, before.sddl)
  })
}

test('a non-admin Windows account cannot access live storage and its owned directory is rejected', { timeout: 180000 }, async t => {
  if (!windows) return t.skip('Windows alternate-credential check')
  if (process.env.ELUNE_TEST_WINDOWS_ACCOUNTS !== '1') {
    assert.equal(requireWindowsChecks, false, 'CI must enable ELUNE_TEST_WINDOWS_ACCOUNTS=1')
    return t.skip('Set ELUNE_TEST_WINDOWS_ACCOUNTS=1 to permit a temporary local account')
  }
  assert.ok(process.env.PUBLIC, 'Windows account tests require a public fixture location')
  const f = await fixture(t, process.env.PUBLIC)
  setAcl(f.root, 'public')
  const control = join(f.root, 'public-control.txt')
  const controlContent = 'Public sample control is readable'
  await writeFile(control, controlContent)
  const ownerParent = join(f.root, 'owner-fixture')
  await mkdir(ownerParent)
  setAcl(ownerParent, 'broad')
  const ownedDirectory = join(ownerParent, unusualName)
  const store = f.open()
  await store.writeTrace(sample())
  await store.flush()
  await assertPrivateStore(f)
  const files = suffixes.map(suffix => f.databasePath + suffix)
  const create = join(f.directory, 'unauthorized-create.txt')
  const account = { name: `elune_${randomBytes(6).toString('hex')}`, marker: `elune-${randomUUID()}` }
  assert.ok(account.marker.length <= 48)
  let result
  try {
    result = powershell('windows-accounts.ps1', { ...account, action: 'probe', root: f.root, control, files, create, ownedDirectory })
  } finally {
    assert.equal(powershell('windows-accounts.ps1', { ...account, action: 'cleanup' }).ok, true)
  }
  assert.equal(result.accountRemoved, true)
  assert.equal(result.sid, result.expectedSid)
  assert.notEqual(result.sid, result.parentSid)
  assert.equal(result.admin, false)
  assert.equal(result.groups.includes('S-1-5-32-544'), false)
  assert.equal(result.groups.includes('S-1-5-32-545'), true)
  assert.equal(result.control, controlContent)
  assert.deepEqual(result.reads.map(item => item.path), files)
  assert.equal(result.write.path, create)
  for (const probe of [...result.reads, result.write]) {
    assert.equal(probe.exception, 'System.UnauthorizedAccessException', probe.path)
    assert.equal(probe.win32, 5, probe.path)
  }
  await assert.rejects(lstat(create), { code: 'ENOENT' })
  await assertPrivateStore(f)
  assert.equal((await store.get('sample-trace')).output, 'Sample output')
  const ownedAcl = inspectAcl([ownedDirectory])
  assert.equal(ownedAcl.items[0].owner, result.sid)
  assert.notEqual(ownedAcl.items[0].owner, ownedAcl.currentSid)
  const trustedAcl = inspectAcl([f.directory]).items[0]
  for (const key of ['protected', 'nullDacl', 'daclPresent', 'aceTypes']) {
    assert.deepEqual(ownedAcl.items[0][key], trustedAcl[key])
  }
  const bySid = (a, b) => a.sid.localeCompare(b.sid)
  assert.deepEqual(ownedAcl.items[0].rules.sort(bySid), trustedAcl.rules.sort(bySid))
  await rejectWrite(join(ownedDirectory, 'elune.db'), windowsDirectoryFailure)
  assert.deepEqual(await readdir(ownedDirectory), [])
  assert.equal(inspectAcl([ownedDirectory]).items[0].sddl, ownedAcl.items[0].sddl)
})
