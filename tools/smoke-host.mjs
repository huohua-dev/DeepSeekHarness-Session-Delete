// Smoke test for the host half: drive /status, /precheck and /delete through
// the registered route against a FAKE Host — fake workspace registry, live
// store, agents, persistence, schedule, jobs and storage domains that follow
// the 0.2.1-rc.3 contracts. Every file lives under a throwaway temp dir; the
// real DSH home is never read or written.
//
// Pinned behaviours (numbers follow the 1.7.0 audit list):
//   1  busy gate = `workspace/session-activity` waterfall + agent.status
//   2  subagent subtree (nested, seeded) deleted; user forks kept + counted
//   3  registry touched only through archive/unarchive/pin/unpin/detachSession
//   4  POST precheck, no 200 cap, 5000 hard limit, malformed/empty rejected
//   5  route disposer owned by ctx.effect → re-apply after dispose works
//   6  reminders (active via stop, inactive via delete) removed, others kept
//   7  flush before detach, leaf first; bounded removal retry
//   8  (client — see smoke-client.mjs)
//   9  persistence root from the backend; startup prune guarded + via registry
//   10 trust check fails closed; POST requires application/json
//   11 degraded unload → stays archived (hidden) via the registry, cache re-purged
//   12 async log, rotation past 1 MiB, no titles
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAKE_HOME = join(tmpdir(), `dsh-session-clean-smoke-${process.pid}`)
rmSync(FAKE_HOME, { recursive: true, force: true })
const ROOT = join(FAKE_HOME, 'sessions')
const FAKE_TMP = join(FAKE_HOME, 'tmp')
const PROJCACHE = join(FAKE_HOME, 'storages', 'session_projcache', 'sessions')
mkdirSync(ROOT, { recursive: true })
mkdirSync(PROJCACHE, { recursive: true })
mkdirSync(join(FAKE_TMP, 'dsh-spill-abc123'), { recursive: true })
mkdirSync(join(FAKE_TMP, 'dsh-spill-test-fixture'), { recursive: true })
process.env.DSH_SESSION_DELETE_HOME = FAKE_HOME
process.env.DSH_SESSION_DELETE_TMP = FAKE_TMP
const LOG = join(FAKE_HOME, 'logs', 'session-delete.log')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const top = () => `session-${randomUUID()}`
const bare = () => randomUUID()
const spillDirName = (id) => `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
const projectKey = (cwd) => `--${cwd.replace(/[\\/]+/g, '-').replace(/^-+/, '')}--`

/* ------------------------------------------------------------------------ *
 * The fake world
 * ------------------------------------------------------------------------ */

const WORK = join(FAKE_HOME, 'work', 'a')
mkdirSync(WORK, { recursive: true })
const headers = new Map()
const projcache = new Map()
const resident = new Map()
const agents = new Map()
const jobs = new Map()
const tasks = new Map()
const calls = []
const directWrites = []
let listCalls = 0

const dirOf = (id, cwd = WORK) => join(ROOT, projectKey(cwd), id)
const spillOf = (id) => join(FAKE_TMP, 'dsh-spill-abc123', spillDirName(id))

/** Create one stored session with every durable artefact the plugin removes. */
function addSession(id, { parentSession, origin, isSeeded = false, workspace = true, live = false } = {}) {
  const header = {
    type: 'session', version: 4, id, cwd: WORK, createdAt: Date.now(), isSeeded,
    ...(parentSession ? { parentSession } : {}),
    ...(origin ? { origin, delegationDepth: 1 } : {}),
  }
  headers.set(id, header)
  mkdirSync(dirOf(id), { recursive: true })
  writeFileSync(join(dirOf(id), 'session.v4.jsonl.zstd'), 'payload')
  writeFileSync(join(PROJCACHE, `${id}.json`), '{}')
  projcache.set(id, {})
  mkdirSync(spillOf(id), { recursive: true })
  writeFileSync(join(spillOf(id), 'r.txt'), 'spilled')
  if (workspace) wsRecord().sessionIds.unshift(id)
  if (live) resident.set(id, { id, header })
  return id
}

/** Every durable artefact of one session is gone. */
const goneOnDisk = (id) =>
  !existsSync(dirOf(id)) && !existsSync(join(PROJCACHE, `${id}.json`)) && !projcache.has(id) && !existsSync(spillOf(id))
const intactOnDisk = (id) =>
  existsSync(dirOf(id)) && existsSync(join(PROJCACHE, `${id}.json`)) && projcache.has(id) && existsSync(spillOf(id))

// ---- events: waterfall / parallel, as the cordis context exposes them ------
const listeners = { 'workspace/session-activity': [], 'workspace/session-stop': [] }
const on = (name, fn) => listeners[name].push(fn)
async function waterfall(name, arg, fallback) {
  const chain = listeners[name] ?? []
  const run = (index) => (index < chain.length ? chain[index](arg, () => run(index + 1)) : fallback())
  return run(0)
}
async function parallel(name, arg) {
  await Promise.all((listeners[name] ?? []).map((fn) => fn(arg)))
}

// turn family (dsh-agent): agent.status === 'running'
on('workspace/session-activity', async ({ sessionId }, next) => {
  const running = agents.get(sessionId)?.status === 'running'
  const rest = await next()
  return running ? [{ kind: 'turn' }, ...rest] : rest
})
on('workspace/session-stop', ({ sessionId }) => {
  const agent = agents.get(sessionId)
  if (agent?.status === 'running') agent.cancel()
})
// subagent family: running descendants by header lineage
const runningDescendants = (rootId) => {
  const out = []
  const walk = (id) => {
    for (const header of headers.values()) {
      if (header.parentSession !== id || header.origin !== 'subagent') continue
      if (agents.get(header.id)?.status === 'running') out.push(header.id)
      walk(header.id)
    }
  }
  walk(rootId)
  return out
}
on('workspace/session-activity', async ({ sessionId }, next) => {
  const running = runningDescendants(sessionId)
  const rest = await next()
  return running.length ? [{ kind: 'subagent', items: running.map((id) => ({ id, label: 'child' })) }, ...rest] : rest
})
on('workspace/session-stop', ({ sessionId }) => {
  for (const id of runningDescendants(sessionId)) agents.get(id).cancel()
})
// job family
on('workspace/session-activity', async ({ sessionId }, next) => {
  const running = (jobs.get(sessionId) ?? []).filter((job) => job.status === 'running' || job.status === 'stopping')
  const rest = await next()
  return running.length ? [{ kind: 'job', items: running.map((job) => ({ id: job.id, label: 'sleep' })) }, ...rest] : rest
})
on('workspace/session-stop', ({ sessionId }) => {
  for (const job of jobs.get(sessionId) ?? []) job.kill()
})
// schedule family: active rows; stop DELETES active rows only
on('workspace/session-activity', async ({ sessionId }, next) => {
  const active = [...tasks.values()].filter((task) => task.sessionId === sessionId && task.status === 'active')
  const rest = await next()
  return active.length ? [{ kind: 'schedule', items: active.map((task) => ({ id: task.id, label: task.title })) }, ...rest] : rest
})
on('workspace/session-stop', async ({ sessionId }) => {
  for (const task of [...tasks.values()]) if (task.sessionId === sessionId && task.status === 'active') tasks.delete(task.id)
})

const runningAgent = (id, { stoppable = true } = {}) => {
  const agent = {
    status: 'running',
    // 0.2.0-era shape the old probe read; it must not matter any more.
    getSnapshot: () => ({ running: false, pendingInteraction: null }),
    cancel() { if (stoppable) setTimeout(() => { agent.status = 'idle' }, 30) },
  }
  agents.set(id, agent)
  return agent
}
const runningJob = (sessionId, { stoppable = true } = {}) => {
  const job = { id: `job-${randomUUID().slice(0, 8)}`, status: 'running', kill() { if (!stoppable) return; job.status = 'stopping'; setTimeout(() => { job.status = 'killed' }, 40) } }
  jobs.set(sessionId, [...(jobs.get(sessionId) ?? []), job])
  return job
}
const addTask = (sessionId, status, title = 'SECRET-REMINDER-TITLE') => {
  const id = `task-${randomUUID().slice(0, 8)}`
  tasks.set(id, { id, sessionId, status, title, scheduledAt: new Date().toISOString() })
  return id
}

// ---- schedule service -------------------------------------------------------
const schedule = {
  async catalog() { return [...tasks.values()].map((task) => ({ ...task })) },
  async delete({ sessionId, id }) {
    const task = tasks.get(id)
    if (!task || task.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
    tasks.delete(id)
    calls.push(`schedule.delete:${id}`)
    return { id, deleted: true }
  },
}

// ---- live store -------------------------------------------------------------
let unloadSupported = true
const sessionStore = {
  get: (id) => resident.get(id),
  list: () => [...resident.values()],
  async flush(session) { calls.push(`flush:${session.id}`); return true },
  liveEntryFor(session) {
    for (const [id, s] of resident) if (s === session) return { id, session }
    throw new Error(`session "${session?.id}" is not live in this store`)
  },
  detachEntered(entry) { resident.delete(entry.id); calls.push(`detach:${entry.id}`) },
}
const strippedStore = { get: sessionStore.get, list: sessionStore.list, flush: sessionStore.flush }

// ---- persistence -------------------------------------------------------------
const persistence = {
  root: ROOT,
  emptyListing: false,
  async list() {
    listCalls += 1
    return this.emptyListing ? [] : [...headers.values()].map((header) => ({ header }))
  },
  locate(header) { return { kind: 'jsonl', path: join(ROOT, projectKey(header.cwd), header.id, 'session.v4.jsonl.zstd') } },
}

// ---- workspace registry (public surface of dsh-workspace 0.2.1) ----------------
class ActiveError extends Error {
  constructor(sessionId, activity) { super(`active ${sessionId}`); this.name = 'WorkspaceActiveSessionError'; this.sessionId = sessionId; this.activity = activity }
}
const registry = {
  state: { archivedSessionIds: [], pinnedSessionIds: [] },
  tail: Promise.resolve(),
  entities: new Map(),
  queue(fn) { const result = this.tail.then(fn); this.tail = result.then(() => {}, () => {}); return result },
  get archivedSessionIds() { return this.state.archivedSessionIds },
  get pinnedSessionIds() { return this.state.pinnedSessionIds },
  list() { return [...this.entities.values()] },
  get(id) { return this.entities.get(id) },
  known: (id) => resident.has(id) || headers.has(id),
  archiveSession(id, options = {}) {
    return this.queue(async () => {
      calls.push(`archive:${id}:${options.stopActivity === true}`)
      if (this.state.archivedSessionIds.includes(id)) return
      if (!this.known(id)) throw Object.assign(new Error('unknown'), { name: 'WorkspaceUnknownSessionError' })
      if (options.stopActivity !== true) {
        const activity = await waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
        if (activity.length > 0) throw new ActiveError(id, activity)
      }
      this.state = { ...this.state, archivedSessionIds: [...this.state.archivedSessionIds, id], pinnedSessionIds: this.state.pinnedSessionIds.filter((x) => x !== id) }
      if (options.stopActivity === true) await parallel('workspace/session-stop', { sessionId: id })
    })
  },
  unarchiveSession(id) {
    return this.queue(async () => {
      calls.push(`unarchive:${id}`)
      this.state = { ...this.state, archivedSessionIds: this.state.archivedSessionIds.filter((x) => x !== id) }
    })
  },
  pinSession(id) {
    return this.queue(async () => {
      if (this.state.pinnedSessionIds.includes(id)) return
      if (this.state.archivedSessionIds.includes(id)) throw new Error('archived')
      this.state = { ...this.state, pinnedSessionIds: [id, ...this.state.pinnedSessionIds] }
    })
  },
  unpinSession(id) {
    return this.queue(async () => {
      calls.push(`unpin:${id}`)
      this.state = { ...this.state, pinnedSessionIds: this.state.pinnedSessionIds.filter((x) => x !== id) }
    })
  },
}
const makeEntity = (id, title) => {
  const entity = {
    id,
    record: { path: WORK, title, sessionIds: [] },
    get sessionIds() { return [...entity.record.sessionIds] },
    async detachSession(sessionId) {
      calls.push(`detachSession:${id}:${sessionId}`)
      entity.record = { ...entity.record, sessionIds: entity.record.sessionIds.filter((x) => x !== sessionId) }
    },
  }
  registry.entities.set(id, entity)
  return entity
}
makeEntity('ws-1', 'SECRET-WORKSPACE-TITLE')
makeEntity('ws-2', 'other')
const wsRecord = (id = 'ws-1') => registry.entities.get(id).record

// ---- storage domains: projcache is real; the workspace domain must never be written
const storageDomain = {
  get(name) {
    if (name === 'workspace') {
      return {
        global: { get: () => ({ ...registry.state }), async set(v) { directWrites.push(['global.set', v]) } },
        table: () => ({ entries: () => [], async update(k) { directWrites.push(['table.update', k]) }, async put(k) { directWrites.push(['table.put', k]) } }),
      }
    }
    if (name === 'session_projcache') {
      return {
        table(t) {
          if (t !== 'sessions') throw new Error('no table ' + t)
          return { async delete(k) { const had = projcache.delete(k); return had } }
        },
      }
    }
    return undefined
  },
}

// ---- web server with the real duplicate-path rule ------------------------------
const routes = new Map()
const webServer = {
  register(route) {
    if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

let trust = 'ok'
const connection = {
  requestRejection() {
    if (trust === 'ok') return undefined
    if (trust === 'throw') throw new Error('fence exploded')
    return 401
  },
}

function makeCtx(overrides = {}) {
  const disposers = []
  const services = () => ({
    webServer, connection, storageDomain, agents: { get: (id) => agents.get(id) },
    sessions: unloadSupported ? sessionStore : strippedStore,
    sessionPersistence: persistence, workspaceRegistry: registry, schedule, ...overrides,
  })
  return {
    get: (key) => services()[key],
    waterfall, parallel,
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
    dispose() { while (disposers.length) disposers.pop()() },
  }
}

const OPTIONS = { stopTimeoutMs: 400, stopPollMs: 20, removeAttempts: 5, removeRetryMs: 60, residualPurgeMs: 120, headerCacheMs: 0 }
const mod = await import('../index.js')

function call(method, url, body, { contentType = 'application/json' } = {}) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = {
      method, url,
      headers: contentType ? { 'content-type': contentType } : {},
      async *[Symbol.asyncIterator]() { for (const c of chunks) yield c },
    }
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null }) },
    }
    Promise.resolve(routes.get('/_dsh-session-clean')?.handler(req, res)).catch((error) => resolve({ status: -1, body: { error: String(error) } }))
  })
}
const del = (sessionId, extra = {}) => call('POST', '/_dsh-session-clean/delete', { sessionId, ...extra })

const checks = []
const check = (label, ok, detail) => {
  checks.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined || ok ? '' : `  (${detail})`}`)
}

/* ------------------------------------------------------------------------ *
 * 5. route disposer
 * ------------------------------------------------------------------------ */
{
  const first = makeCtx()
  mod.apply(first, OPTIONS)
  check('[5] apply registers the prefix route', routes.has('/_dsh-session-clean'))
  let threw = false
  try { webServer.register({ path: '/_dsh-session-clean' }) } catch { threw = true }
  check('[5] the fake server rejects duplicate paths like the real one', threw)
  first.dispose()
  check('[5] disposing the plugin context removes the route', !routes.has('/_dsh-session-clean'))
  let reapplied = true
  try { mod.apply(makeCtx(), OPTIONS) } catch { reapplied = false }
  check('[5] re-applying after dispose does not throw', reapplied && routes.has('/_dsh-session-clean'))
  await sleep(50) // startup prune of the empty registry
}

/* ------------------------------------------------------------------------ *
 * 10. trust + wire hygiene
 * ------------------------------------------------------------------------ */
{
  const id = top()
  trust = 'reject'
  check('[10] a rejecting fence answers its status', (await call('GET', `/_dsh-session-clean/status?sessionId=${id}`)).status === 401)
  trust = 'throw'
  check('[10] a throwing fence fails CLOSED with 403', (await call('GET', `/_dsh-session-clean/status?sessionId=${id}`)).status === 403)
  trust = 'ok'
  const noFence = makeCtx({ connection: {} })
  routes.clear()
  mod.apply(noFence, OPTIONS)
  check('[10] a connection without a fence API fails CLOSED', (await call('GET', `/_dsh-session-clean/status?sessionId=${id}`)).status === 403)
  noFence.dispose()
  mod.apply(makeCtx(), OPTIONS)
  check('[10] POST without application/json → 415', (await call('POST', '/_dsh-session-clean/delete', { sessionId: id }, { contentType: 'text/plain' })).status === 415)
  check('[10] POST with a non-object JSON body → 400', (await call('POST', '/_dsh-session-clean/delete', '[1]')).status === 400)
  check('[10] a bare uuid is not accepted over HTTP', (await del(bare())).status === 400)
  check('[10] a malformed id is rejected', (await del('rm -rf /')).status === 400)
  check('[4] GET precheck is gone (405)', (await call('GET', `/_dsh-session-clean/precheck?sessionIds=${id}`)).status === 405)
}

/* ------------------------------------------------------------------------ *
 * 2 + 1. subtree status and the busy gate
 * ------------------------------------------------------------------------ */
const A = addSession(top(), { live: true })
const A_CHILD = addSession(bare(), { parentSession: A, origin: 'subagent', isSeeded: true, live: true })
const A_GRAND = addSession(bare(), { parentSession: A_CHILD, origin: 'subagent' })
const A_FRESH = addSession(bare(), { parentSession: A, origin: 'subagent', workspace: false })
const A_FORK = addSession(top(), { parentSession: A, isSeeded: true })
const UNRELATED = addSession(top())
{
  const st = await call('GET', `/_dsh-session-clean/status?sessionId=${A}`)
  check('[2] status counts 3 subagent descendants (nested + seeded)', st.body?.subagents === 3, JSON.stringify(st.body))
  check('[2] status counts 1 kept fork', st.body?.forks === 1)
  check('[1] idle subtree reports busy=false', st.body?.busy === false)

  const agent = runningAgent(A)
  const busy = await del(A)
  check('[1] agent.status=running → 409 even though getSnapshot says idle', busy.status === 409 && busy.body?.active?.[0]?.activity?.[0]?.kind === 'turn', JSON.stringify(busy.body))
  agent.status = 'idle'

  const job = runningJob(A_GRAND)
  const jobBusy = await del(A)
  check('[1] a job owned by a grandchild blocks the root (409)', jobBusy.status === 409 && jobBusy.body.active.some((entry) => entry.sessionId === A_GRAND && entry.activity[0].kind === 'job'))
  job.status = 'done'

  const child = runningAgent(A_CHILD)
  const childBusy = await call('GET', `/_dsh-session-clean/status?sessionId=${A}`)
  check('[1] a running subagent shows up on the root status', childBusy.body?.busy === true && childBusy.body.active.some((entry) => entry.activity.some((a) => a.kind === 'subagent')))
  child.status = 'idle'
  check('[1] refused deletes archived nothing and deleted nothing', registry.archivedSessionIds.length === 0 && intactOnDisk(A) && intactOnDisk(A_GRAND))
}

/* ------------------------------------------------------------------------ *
 * 2 + 3 + 7. full delete of an idle subtree
 * ------------------------------------------------------------------------ */
{
  wsRecord('ws-2').sessionIds.push(A_GRAND) // a stray second accounting
  registry.state.pinnedSessionIds = [A, UNRELATED]
  calls.length = 0
  const res = await del(A)
  const body = res.body
  check('[2] delete succeeds', res.status === 200 && body?.ok === true, JSON.stringify(body))
  check('[2] every subtree member is reported deleted', [A, A_CHILD, A_GRAND, A_FRESH].every((id) => body.deleted.includes(id)) && body.deleted.length === 4)
  check('[2] root + subagent dirs, projcache (domain+file), spill all gone', [A, A_CHILD, A_GRAND, A_FRESH].every(goneOnDisk))
  check('[2] the user fork survives and is counted', intactOnDisk(A_FORK) && body.forksKept === 1)
  check('[2] unrelated session untouched', intactOnDisk(UNRELATED))
  check('[3] archive went through registry.archiveSession for every member', [A, A_CHILD, A_GRAND, A_FRESH].every((id) => calls.includes(`archive:${id}:false`)))
  check('[3] membership removed via entity.detachSession', calls.includes(`detachSession:ws-1:${A}`) && calls.includes(`detachSession:ws-1:${A_CHILD}`) && calls.includes(`detachSession:ws-2:${A_GRAND}`))
  check('[3] no workspace account still names a member', registry.list().every((entity) => entity.record.sessionIds.every((id) => ![A, A_CHILD, A_GRAND, A_FRESH].includes(id))))
  check('[3] pin dropped (by archive) and archive marker cleared again', !registry.pinnedSessionIds.includes(A) && registry.pinnedSessionIds.includes(UNRELATED) && registry.archivedSessionIds.length === 0)
  check('[3] ZERO direct writes to the workspace storage domain', directWrites.length === 0, JSON.stringify(directWrites))
  await registry.pinSession(UNRELATED) // an official op after us must not resurrect anything
  check('[3] a later official registry write keeps the deleted ids gone', !registry.archivedSessionIds.includes(A) && !registry.pinnedSessionIds.includes(A))
  const flushChild = calls.indexOf(`flush:${A_CHILD}`)
  const detachChild = calls.indexOf(`detach:${A_CHILD}`)
  const detachRoot = calls.indexOf(`detach:${A}`)
  check('[7] resident members flushed before detach', flushChild >= 0 && flushChild < detachChild && calls.indexOf(`flush:${A}`) < detachRoot)
  check('[7] detach runs leaf first', detachChild >= 0 && detachChild < detachRoot)
  check('[7] response reports the unloaded members, hidden=false', body.unloaded.includes(A) && body.unloaded.includes(A_CHILD) && body.hidden === false && body.live === false)
  check('response shape', ['ok', 'deleted', 'removedPaths', 'workspaces', 'unloaded', 'hidden', 'forksKept', 'errors'].every((key) => key in body) && body.errors.length === 0)
  check('[2] foreign dsh-spill-* roots are never swept', existsSync(join(FAKE_TMP, 'dsh-spill-abc123')))
}

/* ------------------------------------------------------------------------ *
 * 6 + 1. stop-and-delete with turn, subagent, job and reminders
 * ------------------------------------------------------------------------ */
{
  const B = addSession(top(), { live: true })
  const B_CHILD = addSession(bare(), { parentSession: B, origin: 'subagent', live: true })
  registry.state.pinnedSessionIds = [B, ...registry.state.pinnedSessionIds]
  runningAgent(B)
  runningAgent(B_CHILD)
  const job = runningJob(B)
  const active = addTask(B, 'active')
  const ended = addTask(B, 'inactive')
  const foreign = addTask(UNRELATED, 'active')
  const refused = await del(B)
  check('[6] an active reminder alone is activity: plain delete refused', refused.status === 409 && refused.body.active.some((entry) => entry.activity.some((a) => a.kind === 'schedule')))
  check('[6] refusal leaves pin and data intact', registry.pinnedSessionIds.includes(B) && intactOnDisk(B))
  const res = await del(B, { stopActivity: true })
  check('[1] stopActivity=true stops and deletes', res.status === 200 && res.body.ok === true, JSON.stringify(res.body))
  check('[1] turn, subagent and job were stopped first', agents.get(B).status === 'idle' && agents.get(B_CHILD).status === 'idle' && job.status === 'killed')
  check('[6] the active reminder is gone (archive stop)', !tasks.has(active))
  check('[6] the inactive reminder is gone (schedule.delete)', !tasks.has(ended) && calls.includes(`schedule.delete:${ended}`))
  check('[6] another session’s reminder survives', tasks.has(foreign))
  check('[6] subtree data gone, pin gone, not archived', goneOnDisk(B) && goneOnDisk(B_CHILD) && !registry.pinnedSessionIds.includes(B) && !registry.archivedSessionIds.includes(B))
  tasks.delete(foreign)
}

/* ------------------------------------------------------------------------ *
 * stop timeout → rollback
 * ------------------------------------------------------------------------ */
{
  const T = addSession(top())
  registry.state.pinnedSessionIds = [T, ...registry.state.pinnedSessionIds]
  runningJob(T, { stoppable: false })
  const res = await del(T, { stopActivity: true })
  check('[1] work that never stops → 409 stop-timeout', res.status === 409 && res.body.code === 'stop-timeout', JSON.stringify(res.body))
  check('[1] timeout rolls back: unarchived, pin restored, data intact', !registry.archivedSessionIds.includes(T) && registry.pinnedSessionIds.includes(T) && intactOnDisk(T))
  jobs.delete(T)
}

/* ------------------------------------------------------------------------ *
 * race: activity appears between the gate and the archive
 * ------------------------------------------------------------------------ */
{
  const R = addSession(top())
  const original = registry.archiveSession.bind(registry)
  registry.archiveSession = (id, options) => { runningAgent(R); return original(id, options) }
  const res = await del(R)
  registry.archiveSession = original
  check('[1] archive-time activity (WorkspaceActiveSessionError) → 409, nothing deleted', res.status === 409 && intactOnDisk(R) && !registry.archivedSessionIds.includes(R), JSON.stringify(res.body))
  agents.get(R).status = 'idle'
}

/* ------------------------------------------------------------------------ *
 * 11. degraded unload: stays archived (hidden) through the registry
 * ------------------------------------------------------------------------ */
{
  unloadSupported = false
  const D = addSession(top(), { live: true })
  directWrites.length = 0
  const res = await del(D)
  check('[11] degraded delete answers hidden=true, unloaded=[]', res.status === 200 && res.body.hidden === true && res.body.unloaded.length === 0 && res.body.live === true, JSON.stringify(res.body))
  check('[11] it stays archived via registry.archiveSession (no direct writes)', registry.archivedSessionIds.includes(D) && directWrites.length === 0)
  check('[11] payload still erased', goneOnDisk(D))
  projcache.set(D, {}) // a pending write-behind rewrites the record once
  await sleep(OPTIONS.residualPurgeMs + 80)
  check('[11] residual purge deletes the rewritten cache record', !projcache.has(D))
  unloadSupported = true
  resident.delete(D)
}

/* ------------------------------------------------------------------------ *
 * 7. bounded removal retry
 * ------------------------------------------------------------------------ */
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.log('SKIP  [7] removal retry (running as root ignores permissions)')
} else {
  const W = addSession(top())
  const project = join(ROOT, projectKey(WORK))
  chmodSync(project, 0o555) // EACCES on the first attempts…
  setTimeout(() => chmodSync(project, 0o755), 150) // …until the "handle" goes away
  const res = await del(W)
  chmodSync(project, 0o755)
  check('[7] a transiently undeletable dir is removed after retries', res.status === 200 && res.body.ok === true && !existsSync(dirOf(W)), JSON.stringify(res.body?.errors))
}

/* ------------------------------------------------------------------------ *
 * ghost entry: registry markers without any stored session
 * ------------------------------------------------------------------------ */
{
  const G = top()
  registry.state = { ...registry.state, archivedSessionIds: [...registry.state.archivedSessionIds, G], pinnedSessionIds: [G, ...registry.state.pinnedSessionIds] }
  wsRecord().sessionIds.push(G)
  const res = await del(G)
  check('ghost id: markers and accounting cleared through the registry', res.status === 200 && !registry.archivedSessionIds.includes(G) && !registry.pinnedSessionIds.includes(G) && !wsRecord().sessionIds.includes(G), JSON.stringify(res.body))
}

/* ------------------------------------------------------------------------ *
 * 4. bulk pre-flight
 * ------------------------------------------------------------------------ */
{
  const many = Array.from({ length: 600 }, top)
  const BUSY = addSession(top())
  runningAgent(BUSY)
  const okRes = await call('POST', '/_dsh-session-clean/precheck', { sessionIds: many })
  check('[4] 600 ids pre-flight fine (old cap was 200)', okRes.status === 200 && okRes.body.ok === true && okRes.body.total === 600, `status=${okRes.status}`)
  const busyRes = await call('POST', '/_dsh-session-clean/precheck', { sessionIds: [...many.slice(0, 5), BUSY] })
  check('[4] a busy member flips ok=false and is reported with its activity', busyRes.body.ok === false && busyRes.body.busy.length === 1 && busyRes.body.busy[0].active[0].activity[0].kind === 'turn')
  for (let i = 0; i < 3000; i += 1) headers.set(`h-${i}`, { id: `h-${i}`, cwd: WORK, parentSession: i % 3 === 0 ? `h-${i - 1}` : undefined, origin: i % 3 === 0 ? 'subagent' : undefined })
  const started = Date.now()
  const full = await call('POST', '/_dsh-session-clean/precheck', { sessionIds: Array.from({ length: 5000 }, top) })
  const elapsed = Date.now() - started
  for (let i = 0; i < 3000; i += 1) headers.delete(`h-${i}`)
  check('[4] 5000 ids over 3000 headers pre-flight in bounded time', full.status === 200 && full.body.total === 5000 && elapsed < 5000, `${elapsed}ms status=${full.status}`)
  check('[4] 5001 ids → 413', (await call('POST', '/_dsh-session-clean/precheck', { sessionIds: Array.from({ length: 5001 }, top) })).status === 413)
  check('[4] empty → 400', (await call('POST', '/_dsh-session-clean/precheck', { sessionIds: [] })).status === 400)
  check('[4] malformed member → 400', (await call('POST', '/_dsh-session-clean/precheck', { sessionIds: ['x'] })).status === 400)
  agents.get(BUSY).status = 'idle'
}

/* ------------------------------------------------------------------------ *
 * 9. startup prune, guarded, through the registry
 * ------------------------------------------------------------------------ */
{
  const GONE = top()
  const GONE_PIN = top()
  registry.state = { ...registry.state, archivedSessionIds: [GONE, UNRELATED], pinnedSessionIds: [GONE_PIN, UNRELATED] }
  persistence.emptyListing = true
  routes.clear()
  mod.apply(makeCtx(), OPTIONS)
  await sleep(60)
  check('[9] empty persistence listing → prune does nothing', registry.archivedSessionIds.includes(GONE) && registry.pinnedSessionIds.includes(GONE_PIN))
  persistence.emptyListing = false
  persistence.root = join(FAKE_HOME, 'nowhere')
  routes.clear()
  mod.apply(makeCtx(), OPTIONS)
  await sleep(60)
  check('[9] missing persistence root → prune does nothing', registry.archivedSessionIds.includes(GONE))
  persistence.root = ROOT
  routes.clear()
  calls.length = 0
  directWrites.length = 0
  mod.apply(makeCtx(), OPTIONS)
  await sleep(60)
  check('[9] dangling markers dropped via unarchive/unpin, live ones kept',
    !registry.archivedSessionIds.includes(GONE) && !registry.pinnedSessionIds.includes(GONE_PIN) &&
    registry.archivedSessionIds.includes(UNRELATED) && registry.pinnedSessionIds.includes(UNRELATED) &&
    calls.includes(`unarchive:${GONE}`) && calls.includes(`unpin:${GONE_PIN}`) && directWrites.length === 0)
  // root from the backend: a session under a non-default root is found
  const altRoot = join(FAKE_HOME, 'alt-sessions')
  const X = top()
  const altDir = join(altRoot, projectKey(WORK), X)
  mkdirSync(altDir, { recursive: true })
  writeFileSync(join(altDir, 'session.v4.jsonl.zstd'), 'x')
  headers.set(X, { id: X, cwd: WORK, isSeeded: false })
  persistence.root = altRoot
  const res = await del(X)
  check('[9] the session dir is resolved from the backend root, not ~/.dsh/sessions', res.status === 200 && !existsSync(altDir), JSON.stringify(res.body))
  persistence.root = ROOT
}

/* ------------------------------------------------------------------------ *
 * 12. log: async, rotated, no titles
 * ------------------------------------------------------------------------ */
{
  await sleep(50)
  const text = readFileSync(LOG, 'utf8')
  check('[12] the log never carries workspace or reminder titles', !text.includes('SECRET-WORKSPACE-TITLE') && !text.includes('SECRET-REMINDER-TITLE'))
  writeFileSync(LOG, 'x'.repeat(1024 * 1024 + 10))
  await call('GET', `/_dsh-session-clean/status?sessionId=${UNRELATED}`)
  await del(top())
  await sleep(80)
  check('[12] past 1 MiB the log rotates to .1', existsSync(`${LOG}.1`) && statSync(LOG).size < 64 * 1024)
}

rmSync(FAKE_HOME, { recursive: true, force: true })
const failed = checks.filter((c) => !c.ok)
console.log(`\nhost: ${checks.length - failed.length}/${checks.length} checks passed`)
process.exitCode = failed.length === 0 ? 0 : 1
