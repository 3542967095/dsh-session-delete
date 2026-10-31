/**
 * Isolated tests for the Host half's recycle-bin routine.
 * Run with the bundled Node binary:
 *   node test-host.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteSession,
  emptyTrash,
  listTrash,
  purgeSession,
  restoreSession,
} from './lib/index.js'

const SESSION = 'session-11111111-2222-4333-8444-555555555555'
const SESSION_2 = 'session-99999999-8888-4777-8666-555555555555'

function fakeRegistry(workspaces = [], archived = [], pinned = []) {
  const calls = []
  const registry = {
    calls,
    archivedSessionIds: archived,
    pinnedSessionIds: pinned,
    list: () => workspaces.map((workspace) => ({
      id: workspace.id,
      sessionIds: workspace.sessionIds,
      detachSession: async (id) => {
        calls.push(`detach:${workspace.id}:${id}`)
        workspace.sessionIds = workspace.sessionIds.filter((entry) => entry !== id)
      },
      attachSession: async (id) => {
        calls.push(`attach:${workspace.id}:${id}`)
        workspace.sessionIds.unshift(id)
      },
    })),
    get: (id) => registry.list().find((workspace) => workspace.id === id),
    unarchiveSession: async (id) => {
      calls.push(`unarchive:${id}`)
    },
    unpinSession: async (id) => {
      calls.push(`unpin:${id}`)
    },
    pinSession: async (id) => {
      calls.push(`pin:${id}`)
    },
    archiveSession: async (id) => {
      calls.push(`archive:${id}`)
    },
  }
  return registry
}

function fakeContext({ registry, live = false, agent = false, agentStatus = 'running' } = {}) {
  const detached = []
  return {
    detached,
    logger: { warn: (message) => console.warn('[warn]', message) },
    get(name) {
      if (name === 'sessions') {
        return {
          get: () => (live ? {} : undefined),
          liveEntryFor: () => ({ detach: () => detached.push('detach') }),
        }
      }
      if (name === 'agents') return { get: () => (agent ? { status: agentStatus } : undefined) }
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
}

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-trash-test-'))
  const sessionDir = join(home, 'sessions', '--D-project--', SESSION)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x'.repeat(64))
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${SESSION}.json`), '{}')
  await writeFile(join(cacheDir, `${SESSION}.json.bak.1`), '{}')
  await writeFile(join(cacheDir, `${SESSION_2}.json`), '{}')
  return { home, sessionDir, cacheDir }
}

const previousHome = process.env.DSH_HOME
try {
  // 1. Delete moves files and cache into the trash, and records title/size.
  {
    const { home, sessionDir, cacheDir } = await makeHome()
    process.env.DSH_HOME = home
    const registry = fakeRegistry([{ id: 'w1', sessionIds: [SESSION, SESSION_2] }], [SESSION], [SESSION])
    const result = await deleteSession(fakeContext({ registry }), SESSION, '测试对话')
    assert.equal(result.sessionId, SESSION)
    assert.ok(result.entryId)
    assert.equal(existsSync(sessionDir), false)
    const trash = await listTrash()
    assert.equal(trash.entries.length, 1)
    assert.equal(trash.entries[0].title, '测试对话')
    assert.ok(trash.entries[0].sizeBytes > 0)
    assert.equal(trash.entries[0].wasArchived, true)
    assert.equal(trash.entries[0].wasPinned, true)
    assert.deepEqual((await readdir(cacheDir)).sort(), [`${SESSION_2}.json`])
    assert.ok(registry.calls.includes(`detach:w1:${SESSION}`))
    assert.ok(registry.calls.includes(`unarchive:${SESSION}`))
    assert.ok(registry.calls.includes(`unpin:${SESSION}`))

    // 2. Restore puts the log and cache back and re-attaches the workspace.
    const restored = await restoreSession(fakeContext({ registry }), result.entryId)
    assert.equal(restored.sessionId, SESSION)
    assert.equal(existsSync(sessionDir), true)
    assert.equal(existsSync(join(cacheDir, `${SESSION}.json`)), true)
    assert.ok(registry.calls.includes(`attach:w1:${SESSION}`))
    assert.deepEqual((await listTrash()).entries, [])
    await rm(home, { recursive: true, force: true })
  }

  // 3. Purge permanently removes only the trash entry.
  {
    const { home, sessionDir } = await makeHome()
    process.env.DSH_HOME = home
    const registry = fakeRegistry([{ id: 'w1', sessionIds: [SESSION] }])
    const deleted = await deleteSession(fakeContext({ registry }), SESSION)
    await purgeSession(deleted.entryId)
    assert.deepEqual((await listTrash()).entries, [])
    assert.equal(existsSync(sessionDir), false)
    await rm(home, { recursive: true, force: true })
  }

  // 4. Empty removes every entry.
  {
    const { home } = await makeHome()
    process.env.DSH_HOME = home
    const secondDir = join(home, 'sessions', '--D-project--', SESSION_2)
    await mkdir(secondDir, { recursive: true })
    await writeFile(join(secondDir, 'session.v4.jsonl.zstd'), 'y')
    const registry = fakeRegistry([{ id: 'w1', sessionIds: [SESSION, SESSION_2] }])
    await deleteSession(fakeContext({ registry }), SESSION)
    await deleteSession(fakeContext({ registry }), SESSION_2)
    assert.equal((await listTrash()).entries.length, 2)
    const emptied = await emptyTrash()
    assert.equal(emptied.removed, 2)
    assert.equal((await listTrash()).entries.length, 0)
    await rm(home, { recursive: true, force: true })
  }

  // 5. A running agent is refused; an attached but idle session may be moved.
  {
    const { home, sessionDir } = await makeHome()
    process.env.DSH_HOME = home
    await assert.rejects(
      () => deleteSession(fakeContext({ registry: fakeRegistry(), agent: true }), SESSION),
      (error) => error.code === 'session-live' && error.status === 409,
    )
    assert.equal(existsSync(sessionDir), true)
    assert.equal((await listTrash()).entries.length, 0)
    const idleCtx = fakeContext({ registry: fakeRegistry(), live: true, agent: true, agentStatus: 'idle' })
    const moved = await deleteSession(idleCtx, SESSION)
    assert.ok(moved.entryId)
    assert.deepEqual(idleCtx.detached, ['detach'])
    assert.equal(existsSync(sessionDir), false)
    assert.equal((await listTrash()).entries.length, 1)
    await rm(home, { recursive: true, force: true })
  }

  // 6. Unknown ids report not-found.
  {
    const { home } = await makeHome()
    process.env.DSH_HOME = home
    await assert.rejects(
      () => deleteSession(fakeContext({ registry: fakeRegistry() }), SESSION_2),
      (error) => error.code === 'session-not-found' && error.status === 404,
    )
    await rm(home, { recursive: true, force: true })
  }

  // 7. A tampered metadata path cannot restore outside the session root.
  {
    const { home } = await makeHome()
    process.env.DSH_HOME = home
    const registry = fakeRegistry([{ id: 'w1', sessionIds: [SESSION] }])
    const deleted = await deleteSession(fakeContext({ registry }), SESSION)
    const metaPath = join(home, 'trash', 'session-delete', deleted.entryId, 'meta.json')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    meta.originalDir = join(home, 'sessions', '--D-project--', '..', 'outside')
    await writeFile(metaPath, JSON.stringify(meta))
    await assert.rejects(
      () => restoreSession(fakeContext({ registry }), deleted.entryId),
      (error) => error.code === 'trash-corrupt',
    )
    await rm(home, { recursive: true, force: true })
  }

  console.log('host recycle-bin tests passed')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
}
