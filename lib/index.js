/**
 * Host half of the DSH “delete conversation” plugin.
 *
 * Deleting a conversation is not a first-class DSH operation (sessions can be
 * archived, never removed), so this plugin performs the out-of-band cleanup
 * the storage README calls “backend maintenance”. Instead of destroying the
 * log, it moves the conversation into a small recycle bin under
 * `$DSH_HOME/trash/session-delete/`, from which the browser half can restore
 * or permanently purge it.
 *
 * Authenticated routes (all through the browser-connection `/api` fence):
 *
 *   POST /api/session-delete                 { sessionId, title? }
 *   GET  /api/session-delete/trash           list recycle-bin entries
 *   POST /api/session-delete/trash/restore   { entryId }
 *   POST /api/session-delete/trash/purge     { entryId }
 *   POST /api/session-delete/trash/empty     purge every entry
 *   POST /api/session-delete/ping            client-load handshake
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 'session-delete'

/** Exact route paths owned by this plugin. */
const ROUTE_PATH = '/api/session-delete'
const PING_PATH = '/api/session-delete/ping'
const TRASH_PATH = '/api/session-delete/trash'
const RESTORE_PATH = '/api/session-delete/trash/restore'
const PURGE_PATH = '/api/session-delete/trash/purge'
const EMPTY_PATH = '/api/session-delete/trash/empty'

/** Version stamped into trash metadata and the installation marker. */
const VERSION = 1

/** Session ids are the only session path segments accepted from the wire. */
const SESSION_ID_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Trash entry ids are generated here and validated before any path use. */
const ENTRY_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}(?:-\d+)?$/

/** A user-facing refusal carrying the wire code and HTTP status. */
class DeletionError extends Error {
  /**
   * @param {string} code stable machine-readable reason
   * @param {string} message human-readable explanation
   * @param {number} status HTTP status to answer with
   */
  constructor(code, message, status) {
    super(message)
    this.name = 'SessionDeletionError'
    this.code = code
    this.status = status
  }
}

/** Resolve the harness home exactly as the persistence plugins do. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Root of persisted session artifacts. */
function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/** Root of this plugin's recycle bin. */
function trashRoot() {
  return join(dshHome(), 'trash', 'session-delete')
}

/** Path of one recycle-bin entry. */
function entryDir(entryId) {
  return join(trashRoot(), entryId)
}

/** This package's root (…/plugins/session-delete), reached through the profile junction too. */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Path of the small diagnostics marker kept beside the plugin payload on S:. */
function markerPath() {
  return join(PLUGIN_ROOT, 'session-delete-plugin.json')
}

/**
 * Find every session directory carrying this id.
 * @param {string} root configured session root
 * @param {string} sessionId validated session id
 * @returns {Promise<string[]>} existing session directories
 */
async function findSessionDirs(root, sessionId) {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const dirs = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, sessionId)
    try {
      if ((await stat(candidate)).isDirectory()) dirs.push(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  return dirs
}

/** Recursively measure one directory. */
async function dirSize(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    try {
      total += entry.isDirectory() ? await dirSize(path) : (await stat(path)).size
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return total
}

/**
 * Move projection-cache documents for one session into the trash entry.
 * @param {string} sessionId validated session id
 * @param {string} dest directory receiving the cache files
 * @returns {Promise<string[]>} moved file names
 */
async function takeProjectionCache(sessionId, dest) {
  const dir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const moved = []
  for (const entry of names) {
    if (entry !== `${sessionId}.json` && !entry.startsWith(`${sessionId}.json.bak.`)) continue
    await mkdir(dest, { recursive: true })
    await renameWithRetry(join(dir, entry), join(dest, entry))
    moved.push(entry)
  }
  return moved
}

/** Move projection-cache documents back out of one trash entry. */
async function restoreProjectionCache(entryId) {
  const source = join(entryDir(entryId), 'projcache')
  let names
  try {
    names = await readdir(source)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const dest = join(dshHome(), 'storages', 'session_projcache', 'sessions')
  await mkdir(dest, { recursive: true })
  for (const entry of names) {
    const target = join(dest, entry)
    await rm(target, { force: true })
    await renameWithRetry(join(source, entry), target)
  }
  return names
}

/** Whether the workspace registry still mentions this id anywhere. */
function registryMentions(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return false
  if (registry.archivedSessionIds.includes(sessionId)) return true
  if (registry.pinnedSessionIds.includes(sessionId)) return true
  return registry.list().some((workspace) => workspace.sessionIds.includes(sessionId))
}

/**
 * Drop workspace membership, pin and archive references. Cleanup is
 * best-effort: the log files are already in the trash, so a stale reference
 * can only be an inert id that every projection filters out.
 */
async function detachFromRegistries(ctx, sessionId, warn) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId)
  } catch (error) {
    warn(`unarchive reference cleanup failed: ${String(error)}`)
  }
  try {
    if (registry.pinnedSessionIds.includes(sessionId)) await registry.unpinSession(sessionId)
  } catch (error) {
    warn(`pin reference cleanup failed: ${String(error)}`)
  }
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      warn(`workspace membership cleanup failed for ${workspace.id}: ${String(error)}`)
    }
  }
}

/** Generate a time-ordered, path-safe entry id. */
function newEntryId(sessionId) {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${sessionId.slice('session-'.length, 'session-'.length + 8)}`
}

/** Query the workspace that currently accounts for a session. */
function workspaceOf(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  return registry.list().find((workspace) => workspace.sessionIds.includes(sessionId))
}

/**
 * Validate and return the original session directory recorded in metadata.
 * The path must be `$DSH_HOME/sessions/<project>/<sessionId>` exactly.
 */
function safeOriginalDir(meta) {
  if (typeof meta.originalDir !== 'string' || typeof meta.sessionId !== 'string') {
    throw new DeletionError('trash-corrupt', '回收站记录已损坏。', 500)
  }
  if (!SESSION_ID_PATTERN.test(meta.sessionId)) {
    throw new DeletionError('trash-corrupt', '回收站记录中的会话 ID 无效。', 500)
  }
  const root = resolve(sessionsRoot())
  const target = resolve(meta.originalDir)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new DeletionError('trash-corrupt', '回收站记录中的原始路径无效。', 500)
  }
  const parts = rel.split(sep)
  if (parts.length !== 2 || parts[1] !== meta.sessionId) {
    throw new DeletionError('trash-corrupt', '回收站记录中的原始路径不符合会话布局。', 500)
  }
  return target
}

/** Read one ready trash entry's metadata. */
async function readEntryMeta(entryId) {
  assertEntryId(entryId)
  let text
  try {
    text = await readFile(join(entryDir(entryId), 'meta.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new DeletionError('trash-not-found', '回收站里找不到这条记录。', 404)
    throw error
  }
  let meta
  try {
    meta = JSON.parse(text)
  } catch {
    throw new DeletionError('trash-corrupt', '回收站记录已损坏。', 500)
  }
  if (meta.sessionId === undefined || meta.originalDir === undefined) {
    throw new DeletionError('trash-corrupt', '回收站记录缺少必要字段。', 500)
  }
  if (meta.status !== 'ready') {
    throw new DeletionError('trash-not-ready', '这条回收站记录尚未完成移动，暂不能操作。', 409)
  }
  return meta
}

/** Allocate an entry id that does not collide with an existing folder. */
async function allocateEntryId(sessionId) {
  const base = newEntryId(sessionId)
  let candidate = base
  let suffix = 0
  for (;;) {
    try {
      await stat(entryDir(candidate))
    } catch (error) {
      if (error.code === 'ENOENT') return candidate
      throw error
    }
    suffix++
    candidate = `${base}-${suffix}`
  }
}

/**
 * Rename with a short retry budget. Windows can report EBUSY/EPERM while a
 * reader or antivirus briefly holds a handle; a few delayed retries make
 * deletion work without weakening the “refuse a running turn” rule.
 */
async function renameWithRetry(from, to, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const retryable = error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES'
      if (!retryable || attempt === attempts - 1) throw error
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)))
    }
  }
}

/**
 * Close an idle, still-attached session before moving its directory.
 *
 * The persistence backend keeps a write handle open for a live session and
 * closes it asynchronously on `session/disposed`. Detaching an idle session
 * emits that edge, which releases the Windows file handle that would otherwise
 * make `rename` fail with EPERM. Running turns are refused before this point.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx injected context
 * @param {string} sessionId validated session id
 * @returns {Promise<boolean>} whether a live entry was detached
 */
async function releaseIdleSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const session = sessions?.get?.(sessionId)
  if (session === undefined) return false
  try {
    const entry = sessions.liveEntryFor(session)
    entry.detach()
    // The writer closes in a promise chain on session/disposed; give it a
    // moment, then the rename retry loop absorbs any remaining contention.
    await new Promise((resolve) => setTimeout(resolve, 150))
    return true
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: could not detach idle session ${sessionId}: ${String(error)}`)
    return false
  }
}

/** Validate a wire entry id before it reaches the filesystem. */
function assertEntryId(entryId) {
  if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) {
    throw new DeletionError('bad-request', 'entryId 无效。', 400)
  }
}

/** List every ready recycle-bin entry, newest first. */
export async function listTrash() {
  let names
  try {
    names = await readdir(trashRoot(), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], totalBytes: 0 }
    throw error
  }
  const entries = []
  for (const name of names) {
    if (!name.isDirectory() || !ENTRY_ID_PATTERN.test(name.name)) continue
    let meta
    try {
      meta = await readEntryMeta(name.name)
    } catch {
      continue
    }
    if (meta.status !== 'ready') continue
    entries.push({
      entryId: name.name,
      sessionId: meta.sessionId,
      title: typeof meta.title === 'string' && meta.title.trim() !== '' ? meta.title : meta.sessionId,
      deletedAt: typeof meta.deletedAt === 'string' ? meta.deletedAt : '',
      sizeBytes: Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : 0,
      wasArchived: meta.wasArchived === true,
      wasPinned: meta.wasPinned === true,
    })
  }
  entries.sort((left, right) => right.deletedAt.localeCompare(left.deletedAt))
  return { entries, totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0) }
}

/**
 * Move one conversation into the recycle bin.
 * @param {import('@deepseek-ai/cordis').Context} ctx injected context
 * @param {string} sessionId validated session id
 * @param {string} [title] display title supplied by the browser
 * @returns {Promise<{sessionId: string, entryId: string, sizeBytes: number}>}
 */
export async function deleteSession(ctx, sessionId, title) {
  const agent = ctx.get('agents')?.get(sessionId)
  // Only a running turn is unsafe to move. An attached-but-idle session is
  // common after switching conversations; refusing it made deleting another
  // conversation fail while some other turn was running. Rename retries below
  // handle the remaining file-handle contention.
  if (agent?.status === 'running') {
    throw new DeletionError(
      'session-live',
      '该对话正在运行。请先停止正在进行的回答，或等待它结束后再删除。',
      409,
    )
  }

  const dirs = await findSessionDirs(sessionsRoot(), sessionId)
  if (dirs.length > 1) {
    throw new DeletionError('session-ambiguous', '找到多个同名会话目录，已中止以免误删。', 409)
  }
  const originalDir = dirs[0]
  if (originalDir === undefined && !registryMentions(ctx, sessionId)) {
    throw new DeletionError('session-not-found', '找不到该对话，它可能已被删除。', 404)
  }
  // A live-but-idle session holds a persistence write handle; detach it so the
  // backend closes that handle before the directory is renamed.
  if (originalDir !== undefined) await releaseIdleSession(ctx, sessionId)

  const workspace = workspaceOf(ctx, sessionId)
  const registry = ctx.get('workspaceRegistry')
  const wasArchived = registry?.archivedSessionIds.includes(sessionId) === true
  const wasPinned = registry?.pinnedSessionIds.includes(sessionId) === true
  const sizeBytes = originalDir === undefined ? 0 : await dirSize(originalDir)
  const entryId = await allocateEntryId(sessionId)
  const target = entryDir(entryId)

  if (originalDir === undefined) {
    // Only stale registry references remain; keep a metadata-only record so a
    // restore attempt can explain why there is nothing to restore.
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'meta.json'), JSON.stringify({
      version: VERSION,
      status: 'ready',
      entryId,
      sessionId,
      title: title ?? sessionId,
      deletedAt: new Date().toISOString(),
      originalDir: join(sessionsRoot(), '_no-cwd', sessionId),
      sizeBytes: 0,
      workspaceId: workspace?.id,
      wasArchived,
      wasPinned,
      missingPayload: true,
    }, null, 2))
  } else {
    await mkdir(target, { recursive: true })
    const meta = {
      version: VERSION,
      status: 'moving',
      entryId,
      sessionId,
      title: title ?? sessionId,
      deletedAt: new Date().toISOString(),
      originalDir,
      sizeBytes,
      workspaceId: workspace?.id,
      wasArchived,
      wasPinned,
    }
    await writeFile(join(target, 'meta.json'), JSON.stringify(meta, null, 2))
    let movedSession = false
    try {
      await renameWithRetry(originalDir, join(target, 'session'))
      movedSession = true
      await takeProjectionCache(sessionId, join(target, 'projcache'))
      meta.status = 'ready'
      await writeFile(join(target, 'meta.json'), JSON.stringify(meta, null, 2))
    } catch (error) {
      // Roll back a partially moved session so a failed delete never destroys
      // the log. If rollback itself fails, leave the trash entry in place: the
      // files are safer there than deleted.
      let rolledBack = !movedSession
      if (movedSession) {
        try {
          await restoreProjectionCache(entryId)
          await renameWithRetry(join(target, 'session'), originalDir)
          rolledBack = true
        } catch (rollbackError) {
          ctx.logger?.warn?.(`session-delete: rollback failed for ${sessionId}: ${String(rollbackError)}`)
        }
      }
      if (rolledBack) await rm(target, { recursive: true, force: true }).catch(() => {})
      const busy = error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES'
      throw new DeletionError(
        busy ? 'session-busy' : 'session-delete-failed',
        busy
          ? '无法移动：该对话的文件仍被 Harness 占用。请重启 Harness 后重试。'
          : rolledBack
            ? `把对话移入回收站失败：${error.message}`
            : `把对话移入回收站时中断，文件已保留在 ${target}，请勿手动删除。`,
        busy ? 409 : 500,
      )
    }
  }

  await detachFromRegistries(ctx, sessionId, (message) => {
    ctx.logger?.warn?.(`session-delete: ${message}`)
  })

  return { sessionId, entryId, sizeBytes }
}

/**
 * Restore one entry back to its original path and re-attach its workspace.
 * @returns {Promise<{sessionId: string, restoredTo: string}>}
 */
export async function restoreSession(ctx, entryId) {
  const meta = await readEntryMeta(entryId)
  if (meta.missingPayload === true) {
    throw new DeletionError('trash-no-payload', '这条回收站记录没有可恢复的会话文件。', 409)
  }
  const target = safeOriginalDir(meta)
  try {
    await stat(target)
    throw new DeletionError('restore-target-exists', '原会话目录已存在，无法恢复。', 409)
  } catch (error) {
    if (error instanceof DeletionError) throw error
    if (error.code !== 'ENOENT') throw error
  }

  await mkdir(dirname(target), { recursive: true })
  try {
    await renameWithRetry(join(entryDir(entryId), 'session'), target)
  } catch (error) {
    throw new DeletionError('restore-failed', `恢复会话文件失败：${error.message}`, 500)
  }
  try {
    await restoreProjectionCache(entryId)
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: could not restore projection cache for ${meta.sessionId}: ${String(error)}`)
  }

  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    const workspace = typeof meta.workspaceId === 'string' ? registry.get(meta.workspaceId) : undefined
    if (workspace !== undefined) {
      try {
        await workspace.attachSession(meta.sessionId)
      } catch (error) {
        ctx.logger?.warn?.(`session-delete: could not reattach ${meta.sessionId} to workspace ${meta.workspaceId}: ${String(error)}`)
      }
    }
    try {
      if (meta.wasPinned === true) await registry.pinSession(meta.sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`session-delete: could not restore pin for ${meta.sessionId}: ${String(error)}`)
    }
    try {
      if (meta.wasArchived === true) await registry.archiveSession(meta.sessionId)
    } catch (error) {
      ctx.logger?.warn?.(`session-delete: could not restore archive for ${meta.sessionId}: ${String(error)}`)
    }
  }

  await rm(entryDir(entryId), { recursive: true, force: true })
  return { sessionId: meta.sessionId, restoredTo: target }
}

/** Permanently delete one recycle-bin entry. */
export async function purgeSession(entryId) {
  await readEntryMeta(entryId)
  await rm(entryDir(entryId), { recursive: true, force: true })
  return { entryId }
}

/** Permanently delete every recycle-bin entry. */
export async function emptyTrash() {
  let names
  try {
    names = await readdir(trashRoot(), { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: 0 }
    throw error
  }
  let removed = 0
  for (const name of names) {
    if (!name.isDirectory() || !ENTRY_ID_PATTERN.test(name.name)) continue
    await rm(join(trashRoot(), name.name), { recursive: true, force: true })
    removed++
  }
  return { removed }
}

/**
 * Serialize a JSON answer.
 * @param {unknown} body response body
 * @param {number} status HTTP status
 * @returns {Response} JSON response
 */
function json(body, status) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Merge one diagnostic fact into the installation marker. Best effort: a
 * read-only plugin folder must not keep the plugin from loading.
 * @param {Record<string, unknown>} patch fields to update
 * @returns {Promise<void>}
 */
async function writeMarker(patch) {
  const path = markerPath()
  let current = {}
  try {
    current = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    current = {}
  }
  await writeFile(path, JSON.stringify({ ...current, ...patch, version: VERSION }, null, 2), 'utf8')
}

/** Read a JSON request body, or undefined when it is not JSON. */
async function readJsonBody(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/** Map a failure onto the wire response. */
function failure(ctx, error, sessionId) {
  const code = error instanceof DeletionError ? error.code : 'internal'
  void writeMarker({
    lastErrorAt: new Date().toISOString(),
    lastErrorCode: code,
    lastErrorSessionId: sessionId ?? null,
    lastErrorMessage: error instanceof Error ? error.message : String(error),
  }).catch(() => {})
  if (error instanceof DeletionError) {
    return json({ ok: false, code: error.code, message: error.message }, error.status)
  }
  ctx.logger?.warn?.(`session-delete: unexpected failure for ${sessionId ?? 'trash'}: ${String(error)}`)
  return json({ ok: false, code: 'internal', message: '操作失败，请稍后重试。' }, 500)
}

/** Cordis entry point. */
export function apply(ctx) {
  void writeMarker({
    hostLoadedAt: new Date().toISOString(),
    hostPid: process.pid,
    route: ROUTE_PATH,
  }).catch((error) => ctx.logger?.warn?.(`session-delete: could not write marker: ${String(error)}`))

  ctx.inject(['connection'], (injected) => {
    injected.connection.fetch.register({
      path: PING_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readJsonBody(request)
        void writeMarker({
          clientLoadedAt: new Date().toISOString(),
          clientVersion: typeof body?.version === 'string' ? body.version : 'unknown',
        }).catch(() => {})
        return json({ ok: true }, 200)
      },
    })

    injected.connection.fetch.register({
      path: TRASH_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch() {
        try {
          return json({ ok: true, ...await listTrash() }, 200)
        } catch (error) {
          return failure(injected, error)
        }
      },
    })

    injected.connection.fetch.register({
      path: RESTORE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readJsonBody(request)
        try {
          assertEntryId(body?.entryId)
          return json({ ok: true, ...await restoreSession(injected, body.entryId) }, 200)
        } catch (error) {
          return failure(injected, error, body?.entryId)
        }
      },
    })

    injected.connection.fetch.register({
      path: PURGE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readJsonBody(request)
        try {
          assertEntryId(body?.entryId)
          return json({ ok: true, ...await purgeSession(body.entryId) }, 200)
        } catch (error) {
          return failure(injected, error, body?.entryId)
        }
      },
    })

    injected.connection.fetch.register({
      path: EMPTY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch() {
        try {
          return json({ ok: true, ...await emptyTrash() }, 200)
        } catch (error) {
          return failure(injected, error)
        }
      },
    })

    injected.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const body = await readJsonBody(request)
        if (body === undefined) return json({ ok: false, code: 'bad-request', message: '请求体不是 JSON。' }, 400)
        const sessionId = body?.sessionId
        if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
          return json({ ok: false, code: 'bad-request', message: 'sessionId 无效。' }, 400)
        }
        const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 500) : undefined
        try {
          const result = await deleteSession(injected, sessionId, title)
          return json({ ok: true, ...result }, 200)
        } catch (error) {
          return failure(injected, error, sessionId)
        }
      },
    })
  })
}
