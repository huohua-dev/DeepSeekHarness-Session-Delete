/**
 * Host half of the `dsh-session-clean` bundle.
 *
 * DSH ships archive/pin/rename/fork for sidebar sessions but no way to delete
 * one. This plugin adds exactly that, behind a small private HTTP surface the
 * client half calls:
 *
 *   GET  /_dsh-session-clean/status?sessionId=…      → one session's activity,
 *        residency, subagent subtree size and kept-fork count;
 *   POST /_dsh-session-clean/precheck {sessionIds}   → bulk pre-flight, one
 *        activity report per id (no 200 cap; 5000 hard limit);
 *   POST /_dsh-session-clean/delete {sessionId, stopActivity?}
 *        → { ok, deleted, removedPaths, workspaces, unloaded, hidden,
 *            forksKept, errors }.
 *
 * A deletion covers one top-level session AND its subagent subtree (every
 * descendant whose header says `origin: 'subagent'`, at any depth — a
 * `subagent_fork` child carries a full copy of its parent's history). A user
 * fork (`parentSession` without the subagent origin) is an independent
 * conversation and is never deleted; it is only counted.
 *
 * The delete path, in order:
 *
 *   1. busy gate — the official archive admission
 *      (`workspace/session-activity` waterfall: turn / subagent / job /
 *      schedule) plus `agent.status === 'running'`, for every subtree member.
 *      Active work answers 409 unless the request says `stopActivity: true`;
 *   2. `workspaceRegistry.archiveSession(id, { stopActivity })` for every
 *      member — the official flow stops activity, drops pins, and freezes the
 *      session (archived sessions refuse `agent/pre-step`, so nothing can wake
 *      them mid-deletion). With `stopActivity` the plugin then waits for the
 *      activity report to drain;
 *   3. every reminder bound to a member (active AND inactive) is removed
 *      through the schedule service;
 *   4. resident members are flushed and then detached from the live store
 *      (leaf first) — the one step resting on internals, see
 *      {@link unloadLiveSession};
 *   5. members leave every workspace account through `WorkspaceEntity
 *      .detachSession` — never a raw storage-domain write, so the registry's
 *      cached state can never resurrect an id later;
 *   6. durable payload: the session directory (from the persistence backend's
 *      own `locate`/`root`), the `session_projcache` record, the spill
 *      directory — each removal retried a bounded number of times;
 *   7. fully removed members are unarchived again (the registry tolerates
 *      gone ids); a member that is still resident stays archived as an honest
 *      "hidden until restart" fallback, and the response says `hidden: true`.
 *
 * Runtime contracts verified against app.asar 0.2.1-rc.3.
 */

import { homedir, tmpdir } from 'node:os'
import { join, dirname, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { rm, readdir, mkdir, appendFile, stat, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const TAG = '[session-delete]'

/** Private route prefix. `/api` and `/plugins` belong to other hosts. */
const ROUTE_PREFIX = '/_dsh-session-clean'

/** Hard ceiling for one bulk pre-flight; the body stays far below MAX_BODY_BYTES. */
const PRECHECK_LIMIT = 5000

/** Pre-flight members probed between two event-loop yields. */
const PRECHECK_CHUNK = 50

/** Request bodies are small JSON objects; 5000 ids fit comfortably. */
const MAX_BODY_BYTES = 1024 * 1024

/** Operation log rotates once past this size (one `.1` generation is kept). */
const LOG_MAX_BYTES = 1024 * 1024

/** Defaults; `apply(ctx, config)` may override them (tests do). */
const DEFAULTS = {
  /** How long a stop-and-delete waits for the activity report to drain. */
  stopTimeoutMs: 15000,
  /** Poll interval while waiting for activity to drain. */
  stopPollMs: 250,
  /** Attempts for one durable removal (EBUSY/ENOTEMPTY/EPERM on Windows). */
  removeAttempts: 5,
  /** Base back-off between removal attempts. */
  removeRetryMs: 120,
  /** Delay before re-purging the cache of a session that stayed resident. */
  residualPurgeMs: 8000,
  /** Lifetime of the cached persistence header listing. */
  headerCacheMs: 30000,
}

/** Top-level session id accepted over HTTP. */
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{36}$/
/** Any id that may appear inside a subtree: top-level, or a subagent's bare uuid. */
const MEMBER_ID_RE = /^(?:session-)?[0-9a-fA-F-]{36}$/

/** DSH home, for the fallback locations only; tests redirect it. */
const dshHome = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return process.env.DSH_SESSION_DELETE_HOME ?? process.env.DSH_HOME ?? join(home, '.dsh')
}

/** Projection-cache per-record documents (`<storages>/session_projcache/sessions/<id>.json`). */
const projcacheSessionsDir = () => join(dshHome(), 'storages', 'session_projcache', 'sessions')

/**
 * Directory holding the spill backend's private per-process roots. The real
 * default is the OS temp dir; tests redirect it.
 */
const spillBase = () => process.env.DSH_SESSION_DELETE_TMP ?? tmpdir()

/**
 * Default spill-root name, as minted by `mkdtempSync(join(tmpdir(),
 * 'dsh-spill-'))`: the prefix plus exactly six random characters — the same
 * shape the backend's own startup sweep matches.
 */
const SPILL_ROOT_RE = /^dsh-spill-[A-Za-z0-9_-]{6}$/

/**
 * Session-scoped spill directory name — byte-for-byte the backend's
 * `sessionDir()`: `session-` plus the first 12 hex digits of
 * `sha256(sessionId)`.
 * @param {string} sessionId - any session id.
 * @returns {string} that session's spill directory name.
 */
const spillSessionDirName = (sessionId) =>
  `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`

const opLogPath = () => join(dshHome(), 'logs', 'session-delete.log')

/** Serialized, asynchronous log writer: diagnostics never block or break a request. */
let logTail = Promise.resolve()

/**
 * Append one timestamped line (ids and outcomes only — never titles).
 * @param {string} line - the message.
 * @returns {Promise<void>} settles once this line was written (or dropped).
 */
function opLog(line) {
  logTail = logTail.then(async () => {
    const path = opLogPath()
    await mkdir(dirname(path), { recursive: true })
    try {
      if ((await stat(path)).size > LOG_MAX_BYTES) await rename(path, `${path}.1`)
    } catch {
      /* absent log: nothing to rotate */
    }
    await appendFile(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
  }).catch(() => {})
  return logTail
}

export const name = 'session-delete'
export const inject = ['webServer', 'connection', 'storageDomain', 'workspaceRegistry', 'sessionPersistence']

/**
 * Resolve one Host service without turning it into a load-time dependency.
 * @param {object} ctx - the Host plugin context.
 * @param {string} key - the service key.
 * @returns {object|undefined} the service when it is mounted.
 */
function serviceOf(ctx, key) {
  try {
    return ctx.get?.(key) ?? ctx[key]
  } catch {
    return undefined
  }
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const httpError = (status, message, extra) => Object.assign(new Error(message), { statusCode: status, extra })

/* ------------------------------------------------------------------------ *
 * Live store
 * ------------------------------------------------------------------------ */

/** @returns {object|undefined} the session the Host still holds in memory. */
function residentSession(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return undefined
  try {
    return sessions.get(sessionId) ?? undefined
  } catch {
    return undefined
  }
}

const isResident = (ctx, sessionId) => residentSession(ctx, sessionId) !== undefined

/**
 * Durability barrier before an unload: the persistence backend drains its
 * routed buffer on `session/flush`, so nothing is still being written when
 * the directory is removed afterwards.
 * @returns {Promise<string|undefined>} an error message, when the flush failed.
 */
async function flushResident(ctx, session) {
  const sessions = serviceOf(ctx, 'sessions')
  if (typeof sessions?.flush !== 'function') return undefined
  try {
    await sessions.flush(session)
    return undefined
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * Make a resident session stop existing for real, instead of faking it.
 *
 * DSH ships no documented unload API (the catalog for `sessions` ends at
 * create/prepare/enter/announce/flush/get/list/fork), so this calls the one
 * framework-owned primitive that removes a live session from memory:
 * `SessionStore.liveEntryFor(session)` + `detachEntered(entry)` — store
 * delete + `session/disposed`. The framework's own reactions follow: the
 * browser gets `api-session/removed` and drops the row, the projection cache
 * runs its detach checkpoint, and the log writer closes.
 *
 * Reach-through caveat: `liveEntryFor`/`detachEntered` are prototype methods,
 * not catalogued API. Every step is probed and contained; a miss returns
 * `{unloaded:false}` and the caller degrades honestly (the member stays
 * archived). The session's Agent stays registered until restart — there is no
 * public detach for it. Call only for a session whose activity has drained.
 *
 * @returns {Promise<{ unloaded: boolean, detail: string }>} what happened.
 */
async function unloadLiveSession(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  if (!sessions || typeof sessions.get !== 'function') return { unloaded: false, detail: 'sessions-unavailable' }
  const session = residentSession(ctx, sessionId)
  if (session === undefined) return { unloaded: false, detail: 'not-resident' }
  if (typeof sessions.liveEntryFor !== 'function') return { unloaded: false, detail: 'no-liveEntryFor' }
  if (typeof sessions.detachEntered !== 'function') return { unloaded: false, detail: 'no-detachEntered' }
  try {
    const entry = sessions.liveEntryFor(session)
    if (entry === undefined || entry === null) return { unloaded: false, detail: 'no-entry' }
    sessions.detachEntered(entry)
  } catch (error) {
    return { unloaded: false, detail: `unload-failed: ${messageOf(error)}` }
  }
  return isResident(ctx, sessionId)
    ? { unloaded: false, detail: 'still-resident' }
    : { unloaded: true, detail: 'detached' }
}

/* ------------------------------------------------------------------------ *
 * Session headers and the subagent subtree
 * ------------------------------------------------------------------------ */

/**
 * Header index over persistence (`sessionPersistence.list()`, the documented
 * listing) unioned with the live store (live wins). The persistence listing is
 * unpaginated, so it is cached briefly; the live union keeps the cache safe —
 * a new session is always live before it can be cold.
 */
function createHeaderIndex(ctx, cacheMs) {
  let cached
  return {
    /** @returns {Promise<Map<string, object>>} id → header. */
    async load({ fresh = false } = {}) {
      const persistence = serviceOf(ctx, 'sessionPersistence')
      if (typeof persistence?.list !== 'function') throw httpError(503, '会话持久化服务不可用，无法确认要删除的范围')
      if (fresh || cached === undefined || Date.now() - cached.at > cacheMs) {
        const snapshots = await persistence.list()
        const stored = new Map()
        for (const snapshot of snapshots ?? []) {
          const header = snapshot?.header
          if (typeof header?.id === 'string') stored.set(header.id, header)
        }
        cached = { at: Date.now(), stored }
      }
      const headers = new Map(cached.stored)
      const sessions = serviceOf(ctx, 'sessions')
      try {
        for (const session of sessions?.list?.() ?? []) {
          const header = session?.header
          if (typeof header?.id === 'string') headers.set(header.id, header)
        }
      } catch {
        /* the live union is an addition, not a requirement */
      }
      return headers
    },
    forget(ids) {
      if (cached === undefined) return
      for (const id of ids) cached.stored.delete(id)
    },
  }
}

const isSubagentHeader = (header) => header?.origin === 'subagent' && typeof header?.parentSession === 'string'

/**
 * The root plus every `origin: 'subagent'` descendant (any depth, loops
 * visited once), root first. Forks — lineage without the subagent origin —
 * are counted, never collected.
 * @param {Map<string, object>} headers - the header index.
 * @param {string} rootId - the top-level session.
 * @returns {{ members: string[], forks: string[] }}
 */
function collectSubtree(headers, rootId) {
  const { children, lineageChildren } = lineageOf(headers)
  const members = []
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const id = queue.shift()
    members.push(id)
    for (const child of children.get(id) ?? []) {
      if (seen.has(child) || !MEMBER_ID_RE.test(child)) continue
      seen.add(child)
      queue.push(child)
    }
  }
  const forks = []
  for (const id of members) {
    for (const header of lineageChildren.get(id) ?? []) {
      if (!isSubagentHeader(header) && !seen.has(header.id)) forks.push(header.id)
    }
  }
  return { members, forks }
}

/** Parent → children indexes, built once per header snapshot (a bulk pre-flight reuses them). */
const lineageCache = new WeakMap()
function lineageOf(headers) {
  let lineage = lineageCache.get(headers)
  if (lineage !== undefined) return lineage
  const children = new Map()
  const lineageChildren = new Map()
  for (const header of headers.values()) {
    if (typeof header?.parentSession !== 'string') continue
    const all = lineageChildren.get(header.parentSession) ?? []
    all.push(header)
    lineageChildren.set(header.parentSession, all)
    if (!isSubagentHeader(header)) continue
    const siblings = children.get(header.parentSession) ?? []
    siblings.push(header.id)
    children.set(header.parentSession, siblings)
  }
  lineage = { children, lineageChildren }
  lineageCache.set(headers, lineage)
  return lineage
}

/* ------------------------------------------------------------------------ *
 * Activity (the official archive admission)
 * ------------------------------------------------------------------------ */

/** Wire-safe copy of one activity family entry. */
function cleanActivity(entry) {
  const out = { kind: typeof entry?.kind === 'string' ? entry.kind : 'unknown' }
  if (Array.isArray(entry?.items)) {
    out.items = entry.items.map((item) => ({
      ...(item?.id === undefined ? {} : { id: String(item.id) }),
      ...(item?.label === undefined ? {} : { label: String(item.label) }),
    }))
  }
  if (typeof entry?.detail === 'string') out.detail = entry.detail
  return out
}

/**
 * Everything that keeps one session active: the `workspace/session-activity`
 * waterfall (turn / subagent / job / schedule families) plus the Agent's own
 * `status === 'running'` (which includes waiting for an approval or answer).
 * A probe that cannot run fails CLOSED: it reports activity.
 * @returns {Promise<object[]>} activity entries; empty means idle.
 */
async function activityOf(ctx, sessionId) {
  const entries = []
  if (typeof ctx.waterfall === 'function') {
    try {
      const reported = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      if (Array.isArray(reported)) entries.push(...reported.map(cleanActivity))
    } catch (error) {
      entries.push({ kind: 'unknown', detail: `activity-probe-failed: ${messageOf(error)}` })
    }
  } else {
    entries.push({ kind: 'unknown', detail: 'activity-probe-unavailable' })
  }
  const agents = serviceOf(ctx, 'agents')
  let agent
  try {
    agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  } catch {
    agent = undefined
  }
  if (agent?.status === 'running' && !entries.some((entry) => entry.kind === 'turn')) entries.unshift({ kind: 'turn' })
  return entries
}

/** @returns {Promise<Array<{sessionId: string, activity: object[]}>>} active members only. */
async function subtreeActivity(ctx, members) {
  const active = []
  for (const sessionId of members) {
    const activity = await activityOf(ctx, sessionId)
    if (activity.length > 0) active.push({ sessionId, activity })
  }
  return active
}

/* ------------------------------------------------------------------------ *
 * Durable payload
 * ------------------------------------------------------------------------ */

/**
 * Remove one path with bounded retries (Windows answers EBUSY/EPERM while a
 * just-closed handle lingers; a late writer can leave ENOTEMPTY), then verify
 * it is really gone.
 * @returns {Promise<boolean>} whether the path no longer exists.
 */
async function removeWithRetry(path, options, recursive) {
  let lastError
  for (let attempt = 0; attempt < options.removeAttempts; attempt += 1) {
    try {
      await rm(path, { recursive, force: true, maxRetries: 2, retryDelay: 50 })
      if (!existsSync(path)) return true
    } catch (error) {
      lastError = error
    }
    await sleep(options.removeRetryMs * (attempt + 1))
  }
  if (!existsSync(path)) return true
  throw lastError ?? new Error(`路径删除后仍存在: ${path}`)
}

/** Whether `child` is a `<root>/<project>/<id>` session directory for `id`. */
function isSessionDirOf(root, child, id) {
  const rel = relative(root, child)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  const parts = rel.split(sep)
  return parts.length === 2 && parts[1] === id
}

/**
 * The persistence root: the JSONL backend's configured `root` when exposed,
 * otherwise `<DSH home>/sessions`.
 */
function sessionsRoot(ctx) {
  const persistence = serviceOf(ctx, 'sessionPersistence')
  const root = persistence?.root
  if (typeof root === 'string' && isAbsolute(root)) return root
  return join(dshHome(), 'sessions')
}

/** Session directories for one id: the backend's own `locate(header)` plus a root scan. */
async function sessionDirsOf(ctx, id, header) {
  const root = sessionsRoot(ctx)
  const dirs = new Set()
  const persistence = serviceOf(ctx, 'sessionPersistence')
  if (header !== undefined && typeof persistence?.locate === 'function') {
    try {
      const located = persistence.locate(header)?.path
      if (typeof located === 'string') {
        const dir = dirname(located)
        if (isSessionDirOf(root, dir, id) && existsSync(dir)) dirs.add(dir)
      }
    } catch {
      /* fall through to the scan */
    }
  }
  let projects = []
  try {
    projects = await readdir(root)
  } catch {
    return [...dirs]
  }
  for (const project of projects) {
    const dir = join(root, project, id)
    if (existsSync(dir)) dirs.add(dir)
  }
  return [...dirs]
}

/** Delete the projection-cache record through its live domain, then its backing file. */
async function eraseProjcache(ctx, sessionId, options, errors) {
  const removed = []
  try {
    const cacheDomain = serviceOf(ctx, 'storageDomain')?.get?.('session_projcache')
    const table = typeof cacheDomain?.table === 'function' ? cacheDomain.table('sessions') : undefined
    if (typeof table?.delete === 'function') {
      // The domain's delete answers false for an absent key; durable first.
      if (await table.delete(sessionId)) removed.push(`session_projcache#sessions:${sessionId}`)
    }
  } catch (error) {
    errors?.push({ sessionId, step: 'projcache', message: messageOf(error) })
  }
  const cacheFile = join(projcacheSessionsDir(), `${sessionId}.json`)
  if (existsSync(cacheFile)) {
    try {
      await removeWithRetry(cacheFile, options, false)
      removed.push(cacheFile)
    } catch (error) {
      errors?.push({ sessionId, step: 'projcache-file', message: messageOf(error) })
    }
  }
  return removed
}

/** Delete the session's spill directory under every backend-shaped spill root. */
async function eraseSpill(sessionId, options, errors) {
  const removed = []
  let entries
  try {
    entries = await readdir(spillBase())
  } catch {
    return removed
  }
  const dirName = spillSessionDirName(sessionId)
  for (const entry of entries) {
    if (!SPILL_ROOT_RE.test(entry)) continue
    const target = join(spillBase(), entry, dirName)
    if (!existsSync(target)) continue
    try {
      await removeWithRetry(target, options, true)
      removed.push(target)
    } catch (error) {
      errors.push({ sessionId, step: 'spill', message: messageOf(error) })
    }
  }
  return removed
}

/* ------------------------------------------------------------------------ *
 * Registry (public methods only)
 * ------------------------------------------------------------------------ */

const registryOf = (ctx) => {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (typeof registry?.archiveSession !== 'function' || typeof registry?.unarchiveSession !== 'function') {
    throw httpError(503, '工作区注册表服务不可用')
  }
  return registry
}

const idsOf = (value) => (Array.isArray(value) ? value : [])

/** Workspace entities in registry order; tolerates a registry without `list`. */
function workspacesOf(registry) {
  try {
    return typeof registry.list === 'function' ? registry.list() : []
  } catch {
    return []
  }
}

/** Whether a workspace accounts for an id (filtered view or raw record). */
const accounts = (entity, id) =>
  idsOf(entity?.sessionIds).includes(id) || idsOf(entity?.record?.sessionIds).includes(id)

/** Detach members from every workspace account through the entity. */
async function detachFromWorkspaces(registry, members, errors) {
  const touched = new Set()
  for (const entity of workspacesOf(registry)) {
    for (const id of members) {
      if (!accounts(entity, id)) continue
      if (typeof entity.detachSession !== 'function') {
        errors.push({ sessionId: id, step: 'workspace', message: 'detachSession unavailable' })
        continue
      }
      try {
        await entity.detachSession(id)
        touched.add(entity.id)
      } catch (error) {
        errors.push({ sessionId: id, step: 'workspace', message: messageOf(error) })
      }
    }
  }
  return [...touched]
}

/* ------------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------------ */

/**
 * Remove every reminder (active and inactive) bound to a member. The archive
 * stop already deletes ACTIVE rows; ended rows stay in the catalog with their
 * delivery history until deleted explicitly.
 */
async function eraseReminders(ctx, members, errors) {
  const schedule = serviceOf(ctx, 'schedule')
  if (typeof schedule?.catalog !== 'function' || typeof schedule?.delete !== 'function') return []
  const memberSet = new Set(members)
  let catalog
  try {
    catalog = await schedule.catalog()
  } catch (error) {
    errors.push({ sessionId: members[0], step: 'schedule', message: messageOf(error) })
    return []
  }
  const removed = []
  for (const task of catalog ?? []) {
    if (!memberSet.has(task?.sessionId)) continue
    try {
      const result = await schedule.delete({ sessionId: task.sessionId, id: task.id })
      if (result?.deleted !== false) removed.push(task.id)
    } catch (error) {
      errors.push({ sessionId: task.sessionId, step: 'schedule', message: messageOf(error) })
    }
  }
  return removed
}

/* ------------------------------------------------------------------------ *
 * The deletion
 * ------------------------------------------------------------------------ */

/**
 * Delete one top-level session and its subagent subtree. See the module
 * comment for the order.
 * @returns {Promise<{status: number, body: object}>}
 */
async function deleteSession(ctx, state, rootId, stopActivity) {
  const { options } = state
  const registry = registryOf(ctx)
  const headers = await state.headers.load()
  const rootKnown = headers.has(rootId) || isResident(ctx, rootId)
  const { members, forks } = collectSubtree(headers, rootId)
  const known = members.filter((id) => headers.has(id) || isResident(ctx, id))
  const errors = []

  // 1. Busy gate over the whole subtree.
  const active = await subtreeActivity(ctx, members)
  void opLog(`delete ${rootId} members=${members.length} forks=${forks.length} active=${active.map((entry) => `${entry.sessionId}:${entry.activity.map((a) => a.kind).join('+')}`).join(',') || '-'} stop=${stopActivity}`)
  if (active.length > 0 && !stopActivity) {
    return { status: 409, body: { ok: false, code: 'active', error: '会话仍有进行中的工作，无法删除', active } }
  }

  // 2. Archive every known member through the registry (stops activity,
  //    drops pins, freezes the session).
  const preArchived = new Set(idsOf(registry.archivedSessionIds))
  const prePinned = idsOf(registry.pinnedSessionIds).filter((id) => members.includes(id))
  const archivedByUs = []
  const rollback = async () => {
    for (const id of archivedByUs.reverse()) {
      try { await registry.unarchiveSession(id) } catch { /* best effort */ }
    }
    for (const id of [...prePinned].reverse()) {
      try { await registry.pinSession?.(id) } catch { /* best effort */ }
    }
  }
  try {
    for (const id of known) {
      await registry.archiveSession(id, { stopActivity })
      if (!preArchived.has(id)) archivedByUs.push(id)
    }
  } catch (error) {
    await rollback()
    if (error?.name === 'WorkspaceActiveSessionError') {
      const activity = idsOf(error.activity).map(cleanActivity)
      return {
        status: 409,
        body: { ok: false, code: 'active', error: '会话仍有进行中的工作，无法删除', active: [{ sessionId: error.sessionId, activity }] },
      }
    }
    throw error
  }

  if (stopActivity) {
    // An id that was already archived resolves without stopping; ask the
    // stop providers for it directly when it still reports work.
    for (const id of known) {
      if (!preArchived.has(id)) continue
      if ((await activityOf(ctx, id)).length === 0) continue
      try {
        await ctx.parallel?.('workspace/session-stop', { sessionId: id })
      } catch (error) {
        void opLog(`session-stop ${id} failed: ${messageOf(error)}`)
      }
    }
    const deadline = Date.now() + options.stopTimeoutMs
    let remaining = await subtreeActivity(ctx, members)
    while (remaining.length > 0 && Date.now() < deadline) {
      await sleep(options.stopPollMs)
      remaining = await subtreeActivity(ctx, members)
    }
    if (remaining.length > 0) {
      await rollback()
      return {
        status: 409,
        body: { ok: false, code: 'stop-timeout', error: '已请求停止，但活动未在时限内结束，本次未删除', active: remaining },
      }
    }
  }

  // 3. Reminders bound to any member, ended ones included.
  const reminders = await eraseReminders(ctx, members, errors)

  // 4. Flush, then unload resident members — leaf first.
  const unloaded = []
  for (const id of [...members].reverse()) {
    const session = residentSession(ctx, id)
    if (session === undefined) continue
    const flushError = await flushResident(ctx, session)
    if (flushError !== undefined) void opLog(`flush ${id} failed: ${flushError}`)
    const unload = await unloadLiveSession(ctx, id)
    void opLog(`unload ${id}: ${unload.unloaded} (${unload.detail})`)
    if (unload.unloaded) unloaded.push(id)
  }

  // 5. Workspace accounts.
  const workspaces = await detachFromWorkspaces(registry, members, errors)
  if (!rootKnown) {
    // A ghost entry (no stored or live session): clear its markers directly.
    try { await registry.unpinSession?.(rootId) } catch (error) { errors.push({ sessionId: rootId, step: 'unpin', message: messageOf(error) }) }
  }

  // 6. Durable payload, per member.
  const removedPaths = []
  const payloadFailed = new Set()
  for (const id of members) {
    for (const dir of await sessionDirsOf(ctx, id, headers.get(id))) {
      try {
        await removeWithRetry(dir, options, true)
        removedPaths.push(dir)
      } catch (error) {
        payloadFailed.add(id)
        errors.push({ sessionId: id, step: 'session-dir', message: messageOf(error) })
      }
    }
    removedPaths.push(...(await eraseProjcache(ctx, id, options, errors)))
    removedPaths.push(...(await eraseSpill(id, options, errors)))
  }

  // 7. Gone members leave the archive set; resident ones stay hidden.
  const stillResident = members.filter((id) => isResident(ctx, id))
  for (const id of members) {
    if (stillResident.includes(id) || payloadFailed.has(id)) continue
    try {
      await registry.unarchiveSession(id)
    } catch (error) {
      errors.push({ sessionId: id, step: 'unarchive', message: messageOf(error) })
    }
  }
  for (const id of stillResident) state.scheduleResidualPurge(id)
  const deleted = members.filter((id) => !payloadFailed.has(id))
  state.headers.forget(deleted)

  const hidden = stillResident.length > 0
  void opLog(`deleted ${rootId}: members=${deleted.length} paths=${removedPaths.length} unloaded=${unloaded.length} hidden=${hidden} reminders=${reminders.length} errors=${errors.map((e) => `${e.sessionId}:${e.step}`).join(',') || '-'}`)
  return {
    status: 200,
    body: {
      ok: errors.length === 0,
      ...(errors.length === 0 ? {} : { error: errors.map((e) => `${e.step}: ${e.message}`).join('; ') }),
      sessionId: rootId,
      deleted,
      removedPaths,
      workspaces,
      reminders,
      unloaded,
      resident: stillResident,
      live: stillResident.includes(rootId),
      hidden,
      forksKept: forks.length,
      errors,
    },
  }
}

/**
 * Startup self-heal: drop archived/pinned ids that no stored or live session
 * backs any more (left by a "hidden until restart" deletion), through the
 * registry's own unarchive/unpin. Does nothing unless the persistence listing
 * is available and non-empty and the root exists — a wrong root must never
 * read as "everything is gone".
 */
async function pruneDanglingIds(ctx, state) {
  const registry = serviceOf(ctx, 'workspaceRegistry')
  if (typeof registry?.unarchiveSession !== 'function') return 0
  const archived = idsOf(registry.archivedSessionIds)
  const pinned = idsOf(registry.pinnedSessionIds)
  if (archived.length === 0 && pinned.length === 0) return 0
  const root = sessionsRoot(ctx)
  if (!existsSync(root)) return 0
  const headers = await state.headers.load({ fresh: true })
  if (headers.size === 0) return 0
  let dropped = 0
  for (const id of archived) {
    if (headers.has(id)) continue
    await registry.unarchiveSession(id)
    dropped += 1
  }
  for (const id of pinned) {
    if (headers.has(id) || typeof registry.unpinSession !== 'function') continue
    await registry.unpinSession(id)
    dropped += 1
  }
  if (dropped > 0) void opLog(`startup prune: dropped ${dropped} dangling markers`)
  return dropped
}

/* ------------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------------ */

/** Read one bounded JSON body; requires `content-type: application/json`. */
async function readJsonBody(req) {
  const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') throw httpError(415, '请求体必须是 application/json')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, '请求体过大')
    chunks.push(Buffer.from(chunk))
  }
  if (chunks.length === 0) return {}
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object')
    return body
  } catch {
    throw httpError(400, '请求体不是合法 JSON 对象')
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

const requireTopLevel = (sessionId) => {
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) throw httpError(400, '非法的 sessionId')
  return sessionId
}

export function apply(ctx, config = {}) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const log = (message, error) => {
    if (error === undefined) console.log(`${TAG} ${message}`)
    else console.warn(`${TAG} ${message}`, error)
  }

  const server = serviceOf(ctx, 'webServer')
  if (!server || typeof server.register !== 'function') {
    log('没有 webServer 服务，删除接口不可用（插件其余部分不受影响）')
    return
  }

  const timers = new Set()
  const state = {
    options,
    headers: createHeaderIndex(ctx, options.headerCacheMs),
    /** Re-purge the cache of a member that stayed resident (its write-behind may rewrite it once). */
    scheduleResidualPurge(sessionId) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        void eraseProjcache(ctx, sessionId, options, [])
          .then((again) => opLog(`residual purge ${sessionId}: ${again.length}`))
      }, options.residualPurgeMs)
      timer.unref?.()
      timers.add(timer)
    },
  }

  /** Same trust fence the shipped routes use. Fails CLOSED. */
  const rejectUntrusted = (req, res) => {
    const connection = serviceOf(ctx, 'connection')
    try {
      if (typeof connection?.requestRejection === 'function') {
        const rejection = connection.requestRejection(req)
        if (rejection === undefined || rejection === null) return false
        sendJson(res, Number(rejection) || 403, { error: '未通过连接信任检查' })
        return true
      }
      if (typeof connection?.admit === 'function') {
        const admission = connection.admit(req)
        if (admission !== null && typeof admission === 'object' && !('rejection' in admission)) return false
        sendJson(res, Number(admission?.rejection) || 403, { error: '未通过连接信任检查' })
        return true
      }
    } catch (error) {
      log('连接信任检查本身出错，拒绝本次请求', error)
    }
    sendJson(res, 403, { error: '无法完成连接信任检查' })
    return true
  }

  const handler = async (req, res) => {
    if (rejectUntrusted(req, res)) {
      void opLog(`REJECTED(trust) ${req.method} ${String(req.url).split('?')[0]}`)
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(ROUTE_PREFIX.length)
    try {
      if (route === '/status') {
        if (req.method !== 'GET') throw httpError(405, '只支持 GET')
        const sessionId = requireTopLevel(url.searchParams.get('sessionId') ?? '')
        const headers = await state.headers.load()
        const { members, forks } = collectSubtree(headers, sessionId)
        const active = await subtreeActivity(ctx, members)
        const rootActivity = active.find((entry) => entry.sessionId === sessionId)?.activity ?? []
        sendJson(res, 200, {
          busy: active.length > 0,
          detail: active.length > 0 ? active[0].activity.map((entry) => entry.kind).join('+') : 'idle',
          activity: rootActivity,
          active,
          resident: isResident(ctx, sessionId),
          subagents: members.length - 1,
          forks: forks.length,
        })
        return
      }
      if (route === '/precheck') {
        if (req.method !== 'POST') throw httpError(405, '只支持 POST')
        const body = await readJsonBody(req)
        const raw = body.sessionIds
        if (!Array.isArray(raw) || raw.length === 0) throw httpError(400, 'sessionIds 不能为空')
        const ids = [...new Set(raw)]
        if (ids.length > PRECHECK_LIMIT) throw httpError(413, `一次最多预检 ${PRECHECK_LIMIT} 个会话`)
        for (const id of ids) requireTopLevel(id)
        const headers = await state.headers.load()
        const sessions = []
        for (let start = 0; start < ids.length; start += PRECHECK_CHUNK) {
          for (const sessionId of ids.slice(start, start + PRECHECK_CHUNK)) {
            const { members } = collectSubtree(headers, sessionId)
            const active = await subtreeActivity(ctx, members)
            sessions.push({ sessionId, busy: active.length > 0, active, subagents: members.length - 1 })
          }
          await new Promise((resolve) => setImmediate(resolve))
        }
        const busy = sessions.filter((entry) => entry.busy)
        void opLog(`precheck ${ids.length}: busy ${busy.length}`)
        sendJson(res, 200, { total: ids.length, ok: busy.length === 0, busy, sessions })
        return
      }
      if (route === '/delete') {
        if (req.method !== 'POST') throw httpError(405, '只支持 POST')
        const body = await readJsonBody(req)
        const sessionId = requireTopLevel(body.sessionId)
        const result = await deleteSession(ctx, state, sessionId, body.stopActivity === true)
        if (result.status === 200) {
          log(`已删除会话 ${sessionId}（成员 ${result.body.deleted.length}，路径 ${result.body.removedPaths.length}，错误 ${result.body.errors.length}）`)
        }
        sendJson(res, result.status, result.body)
        return
      }
      sendJson(res, 404, { error: '未知接口' })
    } catch (error) {
      const status = Number(error?.statusCode) || 500
      void opLog(`ERROR ${req.method} ${url.pathname} → ${status}: ${messageOf(error)}`)
      if (status >= 500) log(`请求失败：${url.pathname}`, error)
      sendJson(res, status, { ok: false, error: messageOf(error), ...(error?.extra ?? {}) })
    }
  }

  // The registration returns a disposer; owning it through ctx.effect lets
  // the plugin be disabled, reloaded and re-enabled without a duplicate-path
  // throw.
  const route = { kind: 'prefix', path: ROUTE_PREFIX, handler }
  if (typeof ctx.effect === 'function') ctx.effect(() => server.register(route), `session-delete: ${ROUTE_PREFIX}`)
  else server.register(route)
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }, 'session-delete: timers')
  }

  log(`删除接口就绪：${ROUTE_PREFIX}/{status,precheck,delete}`)
  void opLog(`plugin activated, routes on ${ROUTE_PREFIX}`)
  void pruneDanglingIds(ctx, state).catch((error) => opLog(`startup prune failed: ${messageOf(error)}`))
}
