// Smoke test for the client half's plain HTTP helpers (audit items 4 and 8):
// load client.js with a stub module loader, take the pure helpers it exposes
// as `__internals`, and run them against a scripted fetch. No browser, no
// React rendering.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let registration
globalThis.window = { __ModuleLoader__: { load(entry) { registration = entry } } }
new Function(readFileSync(join(ROOT, 'client.js'), 'utf8'))()
const exportsOf = registration.factory((name) => {
  if (name === 'react') return { createElement: () => null, Fragment: 'fragment' }
  throw new Error(`unexpected require ${name}`)
})
const { precheckBatch, deleteSerially, shouldRemoveGroup, describeFailures, describeActivity, TOP_LEVEL_RE } = exportsOf.__internals

const checks = []
const check = (label, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined || ok ? '' : `  (${detail})`}`)
}
const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
const ids = (n) => Array.from({ length: n }, (_, i) => `session-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`)

check('client exposes the helpers and keeps inject/apply', typeof exportsOf.apply === 'function' && Array.isArray(exportsOf.inject))

{
  const seen = []
  const result = await precheckBatch(async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) })
    return reply(200, { ok: true, busy: [], total: JSON.parse(init.body).sessionIds.length })
  }, ids(2500))
  check('[4] pre-flight is a POST with a JSON body', seen.every((entry) => entry.init.method === 'POST' && entry.init.headers['content-type'] === 'application/json' && entry.url === '/_dsh-session-clean/precheck'))
  check('[4] 2500 ids go in 3 chunks, nothing in the query string', seen.length === 3 && seen.reduce((n, e) => n + e.body.sessionIds.length, 0) === 2500 && seen.every((e) => !e.url.includes('?')))
  check('[4] all idle → ok', result.kind === 'ok')
}
{
  const result = await precheckBatch(async () => reply(400, { error: '一次最多预检 200 个会话' }), ids(3))
  check('[4] an HTTP error is "pre-flight failed", NOT "N running"', result.kind === 'failed' && result.message.includes('200'), JSON.stringify(result))
  const network = await precheckBatch(async () => { throw new Error('network down') }, ids(3))
  check('[4] a transport error is "pre-flight failed"', network.kind === 'failed' && network.message === 'network down')
  const garbage = await precheckBatch(async () => reply(200, {}), ids(3))
  check('[4] a malformed answer is "pre-flight failed"', garbage.kind === 'failed')
  const busy = await precheckBatch(async () => reply(200, { ok: false, busy: [{ sessionId: 'a', active: [] }] }), ids(3))
  check('[4] a busy member is "busy" with its entries', busy.kind === 'busy' && busy.busy.length === 1)
}
{
  const outcome = new Map([[ids(3)[1], reply(200, { ok: false, deleted: [], error: 'session-dir: EBUSY' })], [ids(3)[2], reply(409, { ok: false, error: 'active' })]])
  const progress = []
  const result = await deleteSerially(async (url, init) => outcome.get(JSON.parse(init.body).sessionId) ?? reply(200, { ok: true, deleted: [], hidden: false }), ids(3), (done, total) => progress.push(`${done}/${total}`))
  check('[8] serial delete counts successes and collects each failure', result.ok === 1 && result.failed.length === 2 && result.failed[0].error === 'session-dir: EBUSY')
  check('[8] progress reported per session', progress.join(',') === '1/3,2/3,3/3')
  check('[8] any failure keeps the group (no removal)', shouldRemoveGroup(result) === false)
  check('[8] a clean batch allows removal', shouldRemoveGroup({ ok: 3, failed: [] }) === true && shouldRemoveGroup(null) === false)
  check('[8] failures are listed for the user', describeFailures(result.failed).includes('EBUSY'))
}
{
  const t = (key) => key
  check('activity kinds are named', describeActivity([{ activity: [{ kind: 'turn' }, { kind: 'job' }] }, { activity: [{ kind: 'schedule' }] }], t) === 'kindTurn、kindJob、kindSchedule')
  check('only top-level ids are sent; subagent uuids ride with their root', TOP_LEVEL_RE.test(ids(1)[0]) && !TOP_LEVEL_RE.test('8a7bf4fb-cc0d-4f2c-a11c-164ad20a71c4'))
}

const failed = checks.filter((ok) => !ok).length
console.log(`\nclient: ${checks.length - failed}/${checks.length} checks passed`)
process.exitCode = failed === 0 ? 0 : 1
