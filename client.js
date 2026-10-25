/**
 * Client half of the `dsh-session-clean` bundle.
 *
 * Registers one row in the shipped `sidebar.workspaces.session.menu.item`
 * list — the same list the built-in pin / rename / fork / archive rows live
 * in — so "Delete session" appears in every session's "…" menu at order 500
 * (after archive), including archived rows.
 *
 * The row dims itself while the session owns live work (the host-provided
 * `useSessionStatus` snapshot, the same store the sidebar's "进行中" status
 * uses) but stays clickable: the dialog asks the Host what is running and
 * offers a second-confirmed "stop and delete". The Host enforces the gate.
 *
 * Structure note (the lesson from the first cut): a menu row unmounts with
 * its menu, so the confirm dialog and the result toast must NOT live inside
 * the row component. Like the shipped archive flow, they hang off the
 * frame-wide `shell.overlay` slot and talk to the row through a tiny
 * module-level request store — closing the menu cannot kill a pending dialog.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-clean',
  factory(require) {
    // Human-synced copy of package.json#version: client bundles cannot read
    // package.json at runtime. Bump together with `npm version`.
    const VERSION = '1.7.1'

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-session-clean'
    const DICT = {
      zh: {
        menu: '删除会话',
        menuBusy: '会话运行中：确认框里可以先停止再删除',
        confirmTitle: '删除此会话？',
        confirmDesc: '将永久删除「{title}」的对话记录与本地数据，删除后无法恢复。',
        confirmNote: '子代理会话会一并删除；分叉出去的会话和附件不会删除。\n删掉你正在看的会话也可以，界面会自动切到同工作区的新会话。\n万一删不彻底，会先隐藏并直接告诉你。',
        confirmSubtree: '连同它的 {n} 个子代理会话一起删除。',
        confirmForks: '由此分叉的 {n} 个会话不会被删除。',
        confirmActive: '会话还有进行中的工作：{kinds}。可以先停止再删除。',
        stopAndDelete: '停止并删除',
        stopConfirm: '确定要停止并删除吗？会取消运行中的回合、子代理和后台任务，并删除它的提醒。',
        stopTimeout: '已请求停止，但工作没能及时结束，本次没有删除，请稍后再试。',
        kindTurn: '运行中的回合', kindSubagent: '子代理', kindJob: '后台任务', kindSchedule: '提醒', kindUnknown: '无法确认的活动',
        confirmBusy: '会话仍有进行中的工作，无法删除。',
        confirmAction: '永久删除',
        cancel: '取消',
        deleting: '正在删除…',
        done: '会话已删除',
        doneUnloaded: '会话已删除：数据已清除，列表里也不会再出现',
        doneLive: '数据已删除，但这次没能把会话彻底移除：先临时藏了起来（切到「显示已归档」能看到），重启 DSH 后彻底消失',
        donePartial: '只删除了一部分：{message}',
        failed: '删除失败：{message}',
        cleanupFooter: '清理分组',
        cleanupTitle: '清理会话分组',
        cleanupDesc: '选择一个分组，删除它下面的全部会话。此操作不可恢复，运行中的会话会被整批拦下。',
        cleanupEmpty: '还没有任何带会话的分组',
        cleanupCount: '{n} 个会话',
        cleanupCountTotal: '共 {n} 个会话',
        cleanupBusyTag: '{n} 个运行中',
        cleanupAction: '清空',
        cleanupConfirmTitle: '清空「{title}」的全部会话？',
        cleanupConfirmDesc: '将永久删除该分组下的 {n} 个会话及其本地数据，删除后无法恢复。',
        cleanupBusyBlocked: '有 {n} 个会话正在运行，已整批取消：请等它们结束再来',
        cleanupBusyStop: '有 {n} 个会话仍有进行中的工作（{kinds}），整批没有删除。可以停止它们再删。',
        stopAndRemove: '停止并移除分组',
        cleanupPrecheckFailed: '预检请求失败，未删除任何会话：{message}',
        cleanupFailedItems: '失败的会话：{items}',
        cleanupRemoveSkipped: '有 {m} 个会话没删成功，分组先保留，没有移除。',
        cleanupWorking: '正在删除 {done}/{total}…',
        cleanupDone: '已删除 {n} 个会话',
        cleanupPartial: '已删除 {n} 个，失败 {m} 个',
        cleanupClose: '关闭',
        cleanupActionRemove: '清空并移除分组',
        cleanupButtonHints: '「永久删除」：只删会话，分组保留\n「清空并移除分组」：会话和分组一起删',
        cleanupRemoveDone: '已清空并移除「{title}」',
        cleanupRemoveUnavailable: '当前 DSH 版本不支持移除分组，会话已清空。',
        cleanupUngrouped: '未分组',
        cleanupUngroupedHint: '不属于任何分组的会话（删掉的分组留下的、或新建时没选分组）',
        cleanupArchivedTag: '{m} 个不在列表',
        cleanupArchivedNote: '其中 {m} 个在默认视图里看不到（已归档 / 子代理等），也会一并删除。',
      },
      en: {
        menu: 'Delete session',
        menuBusy: 'Session is running: the dialog can stop it first',
        confirmTitle: 'Delete this session?',
        confirmDesc: 'This permanently deletes “{title}” — its chat history and local data. It cannot be undone.',
        confirmNote: 'Subagent sessions go with it; forked sessions and attachments are kept.\nDeleting the session you are viewing is fine: the view moves to a fresh session in the same workspace.\nIf a full delete is not possible, it is hidden and you are told right away.',
        confirmSubtree: 'Its {n} subagent session(s) are deleted with it.',
        confirmForks: '{n} session(s) forked from it will be kept.',
        confirmActive: 'The session still has work in progress: {kinds}. You can stop it and delete.',
        stopAndDelete: 'Stop and delete',
        stopConfirm: 'Stop and delete? This cancels the running turn, subagents and background jobs, and removes its reminders.',
        stopTimeout: 'Stop was requested but the work did not finish in time; nothing was deleted. Try again shortly.',
        kindTurn: 'running turn', kindSubagent: 'subagents', kindJob: 'background jobs', kindSchedule: 'reminders', kindUnknown: 'unverifiable activity',
        confirmBusy: 'The session still has work in progress and cannot be deleted.',
        confirmAction: 'Delete permanently',
        cancel: 'Cancel',
        deleting: 'Deleting…',
        done: 'Session deleted',
        doneUnloaded: 'Session deleted: the data is gone and it will not come back in the list',
        doneLive: 'The data is deleted, but the session itself could not be fully removed this time: it is hidden for now (visible under “show archived”) and disappears for good after a DSH restart',
        donePartial: 'Only partly deleted: {message}',
        failed: 'Delete failed: {message}',
        cleanupFooter: 'Clean workspace',
        cleanupTitle: 'Clean a workspace',
        cleanupDesc: 'Pick a workspace and delete every session it owns. This cannot be undone; a batch containing any running session is refused as a whole.',
        cleanupEmpty: 'No workspace has any session yet',
        cleanupCount: '{n} sessions',
        cleanupCountTotal: '{n} sessions in total',
        cleanupBusyTag: '{n} running',
        cleanupAction: 'Clean',
        cleanupConfirmTitle: 'Delete every session in “{title}”?',
        cleanupConfirmDesc: 'This permanently deletes the {n} session(s) in that workspace and their local data. It cannot be undone.',
        cleanupBusyBlocked: '{n} session(s) are running, so the whole batch was cancelled — try again once they finish',
        cleanupBusyStop: '{n} session(s) still have work in progress ({kinds}); nothing was deleted. You can stop them and delete.',
        stopAndRemove: 'Stop and remove group',
        cleanupPrecheckFailed: 'The pre-flight request failed; nothing was deleted: {message}',
        cleanupFailedItems: 'Failed sessions: {items}',
        cleanupRemoveSkipped: '{m} session(s) could not be deleted, so the group was kept.',
        cleanupWorking: 'Deleting {done}/{total}…',
        cleanupDone: 'Deleted {n} session(s)',
        cleanupPartial: 'Deleted {n}, {m} failed',
        cleanupClose: 'Close',
        cleanupActionRemove: 'Clean and remove group',
        cleanupButtonHints: '“Delete permanently”: sessions only, the group stays.\n“Clean and remove group”: sessions and the group go together.',
        cleanupRemoveDone: 'Cleaned and removed “{title}”',
        cleanupRemoveUnavailable: 'This DSH build cannot unregister a workspace; the sessions were cleaned.',
        cleanupUngrouped: 'Ungrouped',
        cleanupUngroupedHint: 'Sessions no workspace owns (left by a deleted group, or started without one)',
        cleanupArchivedTag: '{m} hidden',
        cleanupArchivedNote: 'This also deletes {m} entry(ies) the default view hides (archived / subagent etc.).',
      },
    }

    const STYLE_ID = 'dsh-session-clean-style'

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-sd-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.45); }
.dsh-sd-dialog { width: min(440px, calc(100vw - 48px)); border-radius: 12px; border: .5px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-layer-2, #1f1f1f); color: var(--dsw-alias-label-primary, #eee); padding: 18px; box-shadow: 0 12px 40px rgba(0,0,0,.4); }
.dsh-sd-title { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.dsh-sd-desc { margin: 0 0 14px; font-size: 15.5px; line-height: 23px; color: var(--dsw-alias-label-secondary, #aaa); word-break: break-all; }
.dsh-sd-note { margin: -6px 0 14px; font-size: 15px; line-height: 21px; color: var(--dsw-alias-label-secondary, #999); white-space: pre-line; }
.dsh-sd-warn { margin: 0 0 14px; font-size: 15.5px; color: var(--dsw-alias-state-error-primary, #f85149); white-space: pre-line; word-break: break-all; }
.dsh-sd-footer { display: flex; justify-content: flex-end; gap: 8px; }
.dsh-sd-btn { padding: 7px 16px; border-radius: 8px; border: .5px solid var(--dsw-alias-border-l2, #444); background: transparent; color: inherit; font: inherit; font-size: 15.5px; cursor: pointer; }
.dsh-sd-btn:disabled { opacity: .55; cursor: default; }
.dsh-sd-btn[data-danger="true"] { border-color: transparent; background: var(--dsw-alias-state-error-primary, #d1242f); color: #fff; }
.dsh-sd-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 10000; padding: 10px 18px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #1f1f1f); border: .5px solid var(--dsw-alias-border-l2, #333); color: var(--dsw-alias-label-primary, #eee); font-size: 15.5px; box-shadow: 0 6px 24px rgba(0,0,0,.35); }
.dsh-sd-toast[data-ok="false"] { color: var(--dsw-alias-state-error-primary, #f85149); }
.dsh-sd-foot { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary, #bbb); font: inherit; font-size: 14.5px; cursor: pointer; }
.dsh-sd-foot:hover { background: var(--dsw-alias-bg-layer-1, #2a2a2a); color: var(--dsw-alias-label-primary, #eee); }
.dsh-sd-panel { width: min(520px, calc(100vw - 48px)); max-height: min(70vh, 560px); display: flex; flex-direction: column; }
.dsh-sd-groups { overflow: auto; margin: 4px 0 12px; border-top: .5px solid var(--dsw-alias-border-l2, #333); }
.dsh-sd-group { display: flex; align-items: center; gap: 10px; padding: 9px 2px; border-bottom: .5px solid var(--dsw-alias-border-l2, #2c2c2c); }
.dsh-sd-group-main { min-width: 0; flex: 1; }
.dsh-sd-group-title { font-size: 16px; color: var(--dsw-alias-label-primary, #eee); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sd-group-meta { font-size: 14.5px; color: var(--dsw-alias-label-secondary, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-sd-count { font-size: 15px; color: var(--dsw-alias-label-secondary, #aaa); white-space: nowrap; }
.dsh-sd-mini { padding: 5px 12px; border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2, #444); background: transparent; color: var(--dsw-alias-state-error-primary, #f85149); font: inherit; font-size: 15px; cursor: pointer; white-space: nowrap; }
.dsh-sd-mini:disabled { opacity: .45; cursor: default; color: var(--dsw-alias-label-secondary, #888); }
.dsh-sd-empty { padding: 14px 2px; color: var(--dsw-alias-label-secondary, #999); font-size: 15.5px; }
`
      document.head.appendChild(style)
    }

    /**
     * Register one locale namespace and return its translator.
     * @param {object} ctx - the client plugin context.
     * @returns {(key: string, params?: object) => string} the translator.
     */
    function bindLocale(ctx) {
      ctx.locale.register(NS, 'zh', DICT.zh)
      ctx.locale.register(NS, 'en', DICT.en)
      return ctx.locale.bind(NS)
    }

    /* ------------------------------------------------------------------ *
     * Plain HTTP helpers (no React) — shared by the single and the batch
     * flows, and exercised directly by tools/smoke-client.mjs.
     * ------------------------------------------------------------------ */

    const API = '/_dsh-session-clean'
    /** Ids per pre-flight request; the Host accepts up to 5000. */
    const PRECHECK_CHUNK = 1000
    const messageOf = (reason) => (reason instanceof Error ? reason.message : String(reason))

    /** POST one JSON body; never throws for HTTP errors, only for transport failures. */
    async function postJson(fetchImpl, path, body) {
      const response = await fetchImpl(`${API}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      return { status: response.status, ok: response.ok, payload }
    }

    /**
     * Bulk pre-flight. Keeps "some member is running" apart from "the
     * pre-flight itself failed" — the old build reported both as running.
     * @returns {Promise<{kind: 'ok'} | {kind: 'busy', busy: object[]} | {kind: 'failed', message: string}>}
     */
    async function precheckBatch(fetchImpl, sessionIds) {
      const busy = []
      for (let start = 0; start < sessionIds.length; start += PRECHECK_CHUNK) {
        const chunk = sessionIds.slice(start, start + PRECHECK_CHUNK)
        let result
        try {
          result = await postJson(fetchImpl, '/precheck', { sessionIds: chunk })
        } catch (reason) {
          return { kind: 'failed', message: messageOf(reason) }
        }
        if (!result.ok || typeof result.payload?.ok !== 'boolean') {
          return { kind: 'failed', message: result.payload?.error ?? `HTTP ${result.status}` }
        }
        if (Array.isArray(result.payload.busy)) busy.push(...result.payload.busy)
      }
      return busy.length === 0 ? { kind: 'ok' } : { kind: 'busy', busy }
    }

    /**
     * Delete a batch one session at a time, collecting every failure.
     * @returns {Promise<{ok: number, hidden: number, failed: Array<{sessionId: string, error: string}>}>}
     */
    async function deleteSerially(fetchImpl, sessionIds, onProgress, { stopActivity = false } = {}) {
      let ok = 0
      let hidden = 0
      const failed = []
      for (let index = 0; index < sessionIds.length; index += 1) {
        const sessionId = sessionIds[index]
        try {
          const result = await postJson(fetchImpl, '/delete', stopActivity ? { sessionId, stopActivity: true } : { sessionId })
          if (result.ok && result.payload?.ok === true) {
            ok += 1
            if (result.payload.hidden === true) hidden += 1
          } else {
            failed.push({ sessionId, error: result.payload?.error ?? `HTTP ${result.status}` })
          }
        } catch (reason) {
          failed.push({ sessionId, error: messageOf(reason) })
        }
        onProgress?.(index + 1, sessionIds.length)
      }
      return { ok, hidden, failed }
    }

    /**
     * Only top-level ids cross the wire: a subagent child is deleted with its
     * root. Which ids are children comes from the session list itself
     * (`origin === 'subagent'`), NEVER from the id's shape — DSH stores any
     * explicit id verbatim (e.g. connector sessions named `od-<uuid>`).
     * @param {string[]} sessionIds - a group's members.
     * @param {Iterable<string>} subagentIds - ids the sidebar marks as subagent children.
     * @returns {string[]} the members to send.
     */
    const selectTopLevel = (sessionIds, subagentIds) => {
      const children = new Set(subagentIds ?? [])
      return (sessionIds ?? []).filter((sessionId) => typeof sessionId === 'string' && sessionId !== '' && !children.has(sessionId))
    }

    /** "Clean and remove group" may only unregister a group that is really empty now. */
    const shouldRemoveGroup = (result) => result !== null && Array.isArray(result.failed) && result.failed.length === 0

    /** Short human list of failed entries for the panel. */
    function describeFailures(failed, limit = 3) {
      const head = failed.slice(0, limit).map((entry) => `${entry.sessionId.slice(0, 17)}…（${entry.error}）`)
      return head.join('；') + (failed.length > limit ? ` +${failed.length - limit}` : '')
    }

    /** Activity kinds → readable words. */
    function describeActivity(active, t) {
      const kinds = new Set()
      for (const member of Array.isArray(active) ? active : []) {
        for (const entry of member?.activity ?? []) kinds.add(entry?.kind)
      }
      const word = { turn: 'kindTurn', subagent: 'kindSubagent', job: 'kindJob', schedule: 'kindSchedule' }
      return [...kinds].map((kind) => t(word[kind] ?? 'kindUnknown')).join('、')
    }

    /* ------------------------------------------------------------------ *
     * Module-level request store: the menu row files a delete request here,
     * the shell.overlay occupant renders it. Outliving the menu is the
     * whole point.
     * ------------------------------------------------------------------ */

    /**
     * @typedef {{ sessionId: string, displayTitle: string, workspaceId?: string, wasOpen: boolean }} DeleteRequest
     */

    /** @type {DeleteRequest | null} */
    let pendingRequest = null
    const pendingListeners = new Set()

    /**
     * File one delete request. `workspaceId`/`wasOpen` are captured by the row
     * BEFORE the Host deletes: once the session is unloaded the main-view
     * retain count is gone, so the "was it the open one?" answer has to be
     * read on the way in, not after.
     * @param {string} sessionId - the session to delete.
     * @param {string} displayTitle - row title for the dialog.
     * @param {{ workspaceId?: string, wasOpen: boolean }} capture - pre-delete facts.
     */
    function requestDelete(sessionId, displayTitle, capture) {
      pendingRequest = { sessionId, displayTitle, ...capture }
      for (const listener of pendingListeners) listener()
    }

    function settleRequest() {
      pendingRequest = null
      for (const listener of pendingListeners) listener()
    }

    function usePendingRequest() {
      const [request, setRequest] = React.useState(pendingRequest)
      React.useEffect(() => {
        const listener = () => setRequest(pendingRequest)
        pendingListeners.add(listener)
        return () => pendingListeners.delete(listener)
      }, [])
      return request
    }

    /** Minimal trash glyph; inline so no icon package is required. */
    function TrashIcon() {
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M6.5 2h3l.5 1h3v1.5H3V3h3l.5-1ZM4 5.5h8l-.6 8a1.5 1.5 0 0 1-1.5 1.4H6.1a1.5 1.5 0 0 1-1.5-1.4L4 5.5Z',
          fill: 'currentColor',
        }))
    }

    /**
     * The menu row: "Delete session" at order 500, shown for every session —
     * running sessions get a disabled row, archived rows stay deletable.
     * It only files a request; the dialog lives in the shell overlay.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, useSessionStatus, useWorkspaces, ctx, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const status = useSessionStatus((snapshot) =>
        snapshot instanceof Map ? snapshot.get(sessionId) : snapshot?.[sessionId],
      )
      const busy =
        status?.running === true ||
        (status?.pendingInteraction !== undefined && status?.pendingInteraction !== null)
      // Owning workspace, so the post-delete jump lands in the same group.
      const workspaceId = typeof useWorkspaces === 'function'
        ? useWorkspaces((state) => {
          const items = Array.isArray(state?.items) ? state.items : []
          return items.find((workspace) => (workspace?.sessionIds ?? []).includes(sessionId))?.workspaceId
        })
        : undefined

      /** @returns {boolean} whether the main view currently shows this session. */
      const isMainViewOpen = () => {
        try {
          const sessions = ctx?.get?.('sessions')
          const info = sessions?.retainInfo?.(sessionId)?.getSnapshot?.()
          return (info?.retainedBy?.mainView ?? 0) > 0
        } catch {
          return false
        }
      }

      return h('button', {
        type: 'button',
        role: 'menuitem',
        // A running session stays reachable: the dialog shows what runs and
        // offers a confirmed stop-and-delete; the Host enforces either way.
        title: busy ? t('menuBusy') : undefined,
        style: busy
          ? { opacity: 0.7, cursor: 'pointer', color: 'var(--dsw-alias-state-error-primary, #f85149)' }
          : { color: 'var(--dsw-alias-state-error-primary, #f85149)', cursor: 'pointer' },
        onClick: () => {
          setMenuOpen(false)
          requestDelete(sessionId, displayTitle, { workspaceId, wasOpen: isMainViewOpen() })
        },
      },
        h(TrashIcon),
        h('span', { style: { marginLeft: 8 } }, t('menu')),
      )
    }

    /**
     * The shell.overlay occupant: nothing while no request is pending, then
     * one confirm dialog per request plus the result toast. Survives the
     * menu closing because this seat is frame-wide.
     */
    function DeleteSessionOverlay({ t, ctx }) {
      const request = usePendingRequest()
      const [deleting, setDeleting] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      // Host facts for the open request: subtree size, kept forks, activity.
      const [info, setInfo] = React.useState(null)
      // Second confirmation for "stop and delete".
      const [stopStage, setStopStage] = React.useState(false)

      React.useEffect(() => {
        if (toast === null) return
        const timer = window.setTimeout(() => setToast(null), 3600)
        return () => window.clearTimeout(timer)
      }, [toast])

      // A fresh request opens with clean state and asks the Host what the
      // deletion covers (subagents go with it, forks stay) and whether it
      // still owns work.
      React.useEffect(() => {
        setError(null)
        setDeleting(false)
        setInfo(null)
        setStopStage(false)
        const sessionId = request?.sessionId
        if (typeof sessionId !== 'string') return
        let alive = true
        fetch(`${API}/status?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
          .then((response) => response.json())
          .then((payload) => {
            if (!alive || typeof payload?.busy !== 'boolean') return
            setInfo({
              subagents: Number(payload.subagents) || 0,
              forks: Number(payload.forks) || 0,
              active: payload.busy ? payload.active ?? [] : [],
            })
          })
          .catch(() => {})
        return () => { alive = false }
      }, [request?.sessionId])

      /**
       * Leave the dead conversation: if the session that was just deleted is
       * the one the main view was showing, start a fresh session in the same
       * workspace so the user is not left staring at a removed transcript.
       * Best effort only.
       * @param {string | undefined} workspaceId - owning workspace, when known.
       */
      const leaveDeletedConversation = (workspaceId) => {
        try {
          const uiWorkspace = ctx?.get?.('uiWorkspace')
          if (typeof uiWorkspace?.startSession !== 'function') return
          if (typeof workspaceId === 'string' && workspaceId !== '') uiWorkspace.startSession(workspaceId)
          else uiWorkspace.startSession()
        } catch {
          // Navigation is a convenience; the delete already succeeded.
        }
      }

      /** Re-pull the session baseline: a cold delete leaves no unload event behind. */
      const refreshSessions = () => {
        try {
          const refreshed = ctx?.get?.('sessions')?.refresh?.()
          if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => {})
        } catch {
          // Refresh is a convenience.
        }
      }

      const callDelete = async (sessionId, stopActivity) => {
        setDeleting(true)
        setError(null)
        const wasOpen = pendingRequest?.wasOpen === true
        const workspaceId = pendingRequest?.workspaceId
        try {
          const { status, ok, payload } = await postJson(fetch, '/delete', stopActivity ? { sessionId, stopActivity: true } : { sessionId })
          if (status === 409) {
            // The Host found work the menu did not know about (or a stop did
            // not finish): show what is running and offer stop-and-delete.
            setInfo((current) => ({ subagents: 0, forks: 0, ...(current ?? {}), active: payload?.active ?? [] }))
            setStopStage(false)
            if (payload?.code === 'stop-timeout') setError(t('stopTimeout'))
            return
          }
          if (!ok || !Array.isArray(payload?.deleted)) throw new Error(payload?.error ?? `HTTP ${status}`)
          settleRequest()
          refreshSessions()
          if (payload.ok !== true) {
            setToast({ ok: false, text: t('donePartial', { message: payload.error ?? '' }) })
            return
          }
          // Three honest outcomes, never one blanket "deleted": unloaded for
          // real / still resident and only hidden / already cold.
          const hidden = payload.hidden === true
          const unloaded = Array.isArray(payload.unloaded) && payload.unloaded.length > 0
          setToast({ ok: true, text: t(hidden ? 'doneLive' : unloaded ? 'doneUnloaded' : 'done') })
          // Only when the main view showed the deleted session AND its row is
          // really gone (a "hidden for now" session stays open).
          if (wasOpen && payload.live !== true) window.setTimeout(() => leaveDeletedConversation(workspaceId), 0)
        } catch (reason) {
          setError(messageOf(reason))
        } finally {
          setDeleting(false)
        }
      }

      const active = info?.active ?? []
      const busy = active.length > 0
      return h(React.Fragment, null,
        request !== null && h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
          h('div', { className: 'dsh-sd-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': t('confirmTitle') },
            h('h2', { className: 'dsh-sd-title' }, t('confirmTitle')),
            h('p', { className: 'dsh-sd-desc' },
              t('confirmDesc', { title: request.displayTitle || request.sessionId })),
            (info?.subagents ?? 0) > 0 && h('p', { className: 'dsh-sd-note' }, t('confirmSubtree', { n: info.subagents })),
            (info?.forks ?? 0) > 0 && h('p', { className: 'dsh-sd-note' }, t('confirmForks', { n: info.forks })),
            h('p', { className: 'dsh-sd-note' }, t('confirmNote')),
            busy && h('p', { className: 'dsh-sd-warn' },
              stopStage ? t('stopConfirm') : t('confirmActive', { kinds: describeActivity(active, t) })),
            error !== null && h('p', { className: 'dsh-sd-warn' }, t('failed', { message: error })),
            h('div', { className: 'dsh-sd-footer' },
              h('button', {
                type: 'button', className: 'dsh-sd-btn', disabled: deleting,
                onClick: () => { if (!deleting) settleRequest() },
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'dsh-sd-btn', 'data-danger': true,
                disabled: deleting,
                onClick: () => {
                  if (!busy) void callDelete(request.sessionId, false)
                  else if (!stopStage) setStopStage(true)
                  else void callDelete(request.sessionId, true)
                },
              }, deleting ? t('deleting') : busy ? t('stopAndDelete') : t('confirmAction')),
            ),
          ),
        ),
        toast !== null && h('div', { className: 'dsh-sd-toast', 'data-ok': String(toast.ok) }, toast.text),
      )
    }

    /* ------------------------------------------------------------------ *
     * Group cleanup (bulk delete) + the "group I just deleted" follow-up.
     *
     * Two facts shape this design:
     *   1. This DSH version has no injectable workspace-row menu, so a
     *      "delete the whole group" action cannot sit on the group header.
     *      We also never hijack the shipped Delete-workspace dialog, whose
     *      contract is "sessions stay and move to Ungrouped".
     *   2. The shell.overlay occupant does NOT receive the workspace/status
     *      hooks (only the sidebar footer action does), so the footer action
     *      is the single producer: it publishes the live workspace list and
     *      the session statuses into a tiny module bridge, and the overlay
     *      panel is a pure consumer of that bridge.
     * ------------------------------------------------------------------ */

    const cleanupBridge = {
      /** @type {boolean} manual panel visibility */
      open: false,
      /** @type {Array<{workspaceId: string, title?: string, path?: string, sessionIds: string[]}>} */
      workspaces: [],
      /** @type {Map<string, object> | Record<string, object> | null} */
      statuses: null,
      /** @type {string[]} sessions owned by no workspace (the "Ungrouped" bucket) */
      ungroupedSessionIds: [],
      /** @type {string[]} ids the sidebar reports as subagent children */
      subagentSessionIds: [],
    }
    const cleanupBridgeListeners = new Set()

    /** @param {Partial<typeof cleanupBridge>} patch - fields to merge. */
    function publishCleanup(patch) {
      Object.assign(cleanupBridge, patch)
      for (const listener of cleanupBridgeListeners) listener()
    }

    function useCleanupBridge() {
      const [value, setValue] = React.useState(cleanupBridge)
      React.useEffect(() => {
        const listener = () => setValue({ ...cleanupBridge })
        cleanupBridgeListeners.add(listener)
        return () => cleanupBridgeListeners.delete(listener)
      }, [])
      return value
    }

    /** Minimal broom glyph; inline so no icon package is required. */
    function BroomIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M9.6 1.7 14.3 6.4 12.6 8.1 7.9 3.4 9.6 1.7ZM6.9 4.4l4.7 4.7-1.2 1.2-1.2-.3-3.5 3.5c-.9.9-2.4.9-3.3 0-.9-.9-.9-2.4 0-3.3l3.5-3.5-.3-1.2 1.3-1.1Z',
          fill: 'currentColor',
        }))
    }

    /**
     * Sidebar-footer action. It is the only seat with the workspace/status
     * hooks, so it (a) opens the manual panel, (b) publishes the data that
     * panel renders, and (c) notices a workspace that disappeared and files
     * the "clean the spilled sessions?" follow-up.
     */
    function CleanupFooterAction({ wide, useWorkspaces, useSessionStatus, useSessions, ctx, t }) {
      const workspaces = useWorkspaces((state) => (Array.isArray(state?.items) ? state.items : []))
      const archivedSessionIds = useWorkspaces((state) => state?.archivedSessionIds)
      const archivedSet = new Set(Array.isArray(archivedSessionIds) ? archivedSessionIds : [])
      const statuses = useSessionStatus((snapshot) => snapshot)
      const summaries = typeof useSessions === 'function'
        ? useSessions((state) => state?.byId)
        : undefined
      // Sessions owned by no workspace are what the sidebar shows as
      // "Ungrouped"; subagent children never belong in that bucket.
      const owned = new Set()
      for (const workspace of workspaces) for (const id of workspace?.sessionIds ?? []) owned.add(id)
      const ungroupedSessionIds = Object.values(summaries ?? {})
        .filter((summary) => summary !== null && typeof summary === 'object' &&
          summary.origin !== 'subagent' && owned.has(summary.sessionId) === false)
        .map((summary) => summary.sessionId)
      /** @param {string} sessionId - id to classify. @returns {boolean} hidden inside a workspace row. */
      const isArchived = (sessionId) => archivedSet.has(sessionId)
      /** @param {string} sessionId - id to classify. @returns {boolean} a subagent child, not a user row. */
      const isSubagent = (sessionId) => summaries?.[sessionId]?.origin === 'subagent'
      /** @param {string[]} sessionIds - a group's members. @returns {{visible: number, archived: number}} */
      const splitCount = (sessionIds) => {
        let visible = 0
        let archived = 0
        for (const sessionId of sessionIds) {
          if (isArchived(sessionId)) archived += 1
          else if (isSubagent(sessionId)) archived += 1
          else visible += 1
        }
        return { visible, archived }
      }
      const ungroupedSplit = splitCount(ungroupedSessionIds)
      const total = workspaces.reduce((count, workspace) => count + (workspace?.sessionIds?.length ?? 0), 0) +
        ungroupedSessionIds.length

      const subagentSessionIds = Object.values(summaries ?? {})
        .filter((summary) => summary !== null && typeof summary === 'object' && summary.origin === 'subagent')
        .map((summary) => summary.sessionId)

      // Publish the live view for the overlay panel (it has no hooks).
      React.useEffect(() => {
        publishCleanup({
          subagentSessionIds,
          workspaces: workspaces.map((workspace) => {
            const sessionIds = [...(workspace.sessionIds ?? [])]
            return {
              workspaceId: workspace.workspaceId,
              title: workspace.title,
              path: workspace.path,
              sessionIds,
              ...splitCount(sessionIds),
            }
          }),
          statuses,
          ungroupedSessionIds,
          ungroupedVisible: ungroupedSplit.visible,
          ungroupedArchived: ungroupedSplit.archived,
        })
      }, [workspaces, statuses, summaries])

      if (total === 0) return null
      return h('button', {
        type: 'button',
        className: 'dsh-sd-foot',
        title: t('cleanupFooter'),
        'aria-label': t('cleanupFooter'),
        onClick: () => publishCleanup({ open: true }),
      },
        h(BroomIcon),
        wide ? h('span', null, t('cleanupFooter')) : null,
      )
    }

    /**
     * Overlay side of the group cleanup: the manual group list, the
     * "the group you deleted left N sessions behind" follow-up, one shared
     * serial runner (with the whole-batch idle gate), and the result toast.
     */
    function CleanupPanel({ t, ctx }) {
      const bridge = useCleanupBridge()
      const [target, setTarget] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [toast, setToast] = React.useState(null)
      // Activity the pre-flight found: the second click stops it and deletes.
      const [busy, setBusy] = React.useState(null)

      React.useEffect(() => {
        if (toast === null) return
        const timer = window.setTimeout(() => setToast(null), 3600)
        return () => window.clearTimeout(timer)
      }, [toast])

      React.useEffect(() => {
        if (!bridge.open) {
          setTarget(null)
          setProgress(null)
          setError(null)
          setBusy(null)
        }
      }, [bridge.open])

      /** @param {string} sessionId - id to classify. @returns {boolean} busy. */
      const isBusy = (sessionId) => {
        const statuses = bridge.statuses
        const status = statuses instanceof Map ? statuses.get(sessionId) : statuses?.[sessionId]
        return status?.running === true ||
          (status?.pendingInteraction !== undefined && status?.pendingInteraction !== null)
      }

      /** Refresh the client session list so deleted rows cannot linger. */
      const refreshSessions = () => {
        try {
          const sessions = ctx?.get?.('sessions')
          const refreshed = sessions?.refresh?.()
          if (refreshed && typeof refreshed.catch === 'function') refreshed.catch(() => {})
        } catch {
          // Refresh is a convenience.
        }
      }

      /**
       * Land in the first remaining workspace after its group got deleted.
       * `openWorkspace` reuses/creates a blank session there and switches the
       * main view, which is what "进入第一个还活着的分组" means.
       * @param {string} removedWorkspaceId - the group that just vanished.
       */
      const openFirstAliveWorkspace = (removedWorkspaceId) => {
        const alive = (bridge.workspaces ?? []).filter((workspace) => workspace.workspaceId !== removedWorkspaceId)
        const first = alive[0]
        if (first === undefined) return
        try {
          const uiWorkspace = ctx?.get?.('uiWorkspace')
          if (typeof uiWorkspace?.openWorkspace === 'function') uiWorkspace.openWorkspace(first.workspaceId)
        } catch {
          // Navigation is best effort.
        }
      }

      /**
       * Delete one batch serially behind the whole-batch idle gate. Only
       * top-level ids are sent: subagent children go with their root.
       * @param {string[]} sessionIds - every member to delete.
       * @param {string[]} sessionIds - every member to delete.
       * @param {{ stopActivity?: boolean }} options - stop the members' work first (second confirmation).
       * @returns {Promise<{ok: number, failed: Array<{sessionId: string, error: string}>, openDeleted: boolean} | {refused: true} | null>} null when the pre-flight itself failed.
       */
      const deleteBatch = async (sessionIds, { stopActivity = false } = {}) => {
        setError(null)
        const ids = selectTopLevel(sessionIds, bridge.subagentSessionIds)
        // Read the main-view retain counts BEFORE deleting: an unload clears
        // them, so afterwards there is no way to tell whether the conversation
        // on screen was part of this batch.
        const openDeleted = sessionIds.some((sessionId) => {
          try {
            const sessions = ctx?.get?.('sessions')
            return (sessions?.retainInfo?.(sessionId)?.getSnapshot?.()?.retainedBy?.mainView ?? 0) > 0
          } catch {
            return false
          }
        })
        const precheck = await precheckBatch(fetch, ids)
        if (precheck.kind === 'failed') {
          setError(t('cleanupPrecheckFailed', { message: precheck.message }))
          return null
        }
        if (precheck.kind === 'busy' && !stopActivity) {
          // Grounded refusal: name what is running and offer the stopping run
          // (a pending reminder would otherwise block a group forever).
          setBusy(precheck.busy)
          const members = precheck.busy.flatMap((entry) => (Array.isArray(entry?.active) ? entry.active : []))
          setError(t('cleanupBusyStop', { n: precheck.busy.length, kinds: describeActivity(members, t) }))
          return { refused: true }
        }
        if (precheck.kind === 'busy') setBusy(precheck.busy)
        setProgress({ done: 0, total: ids.length })
        const result = await deleteSerially(fetch, ids, (done, total) => setProgress({ done, total }), { stopActivity })
        refreshSessions()
        setProgress(null)
        if (result.failed.length === 0) setToast(t('cleanupDone', { n: result.ok }))
        else {
          setToast(t('cleanupPartial', { n: result.ok, m: result.failed.length }))
          setError(t('cleanupFailedItems', { items: describeFailures(result.failed) }))
        }
        return { ok: result.ok, failed: result.failed, openDeleted }
      }

      /** Manual panel: clean one live workspace. */
      const cleanWorkspace = async (workspace, stopActivity = false) => {
        const result = await deleteBatch([...(workspace?.sessionIds ?? [])], { stopActivity })
        if (result === null || result.refused === true) return
        if (result.failed.length === 0) {
          setTarget(null)
          publishCleanup({ open: false })
        }
        // The workspace still exists, so land in a fresh session of it rather
        // than staying on the transcript we just deleted.
        if (result.openDeleted) {
          try {
            const uiWorkspace = ctx?.get?.('uiWorkspace')
            if (typeof uiWorkspace?.startSession === 'function') uiWorkspace.startSession(workspace.workspaceId)
          } catch {
            // Navigation is best effort.
          }
        }
      }

      /**
       * Manual panel: clean the Ungrouped bucket (sessions no workspace owns).
       * There is no workspace to land in, so the view falls back to the first
       * remaining workspace.
       */
      const cleanUngrouped = async (sessionIds, stopActivity = false) => {
        const result = await deleteBatch([...sessionIds], { stopActivity })
        if (result === null || result.refused === true) return
        if (result.failed.length === 0) {
          setTarget(null)
          publishCleanup({ open: false })
        }
        if (result.openDeleted) openFirstAliveWorkspace('')
      }

      /**
       * Clean one workspace AND unregister the group in one pass — the panel's
       * "thorough" action. The group removal reuses the shipped
       * workspaces.delete. When any session failed to delete the group is
       * KEPT: removing it would spill the survivors into Ungrouped.
       * @param {{workspaceId: string, title?: string, path?: string, sessionIds: string[]}} workspace - target group.
       */
      const cleanWorkspaceAndRemove = async (workspace, stopActivity = false) => {
        const result = await deleteBatch([...(workspace?.sessionIds ?? [])], { stopActivity })
        if (result === null || result.refused === true) return
        if (!shouldRemoveGroup(result)) {
          setError(`${t('cleanupRemoveSkipped', { m: result.failed.length })}\n${t('cleanupFailedItems', { items: describeFailures(result.failed) })}`)
          if (result.openDeleted) openFirstAliveWorkspace(workspace.workspaceId)
          return
        }
        let removed = false
        try {
          const workspaces = ctx?.get?.('workspaces')
          if (typeof workspaces?.delete === 'function') {
            await workspaces.delete(workspace.workspaceId)
            removed = true
          } else {
            setError(t('cleanupRemoveUnavailable'))
          }
        } catch (reason) {
          setError(messageOf(reason))
        }
        setTarget(null)
        if (removed) {
          publishCleanup({ open: false })
          setToast(t('cleanupRemoveDone', { title: workspace.title || workspace.path || workspace.workspaceId }))
        }
        if (result.openDeleted || removed) openFirstAliveWorkspace(workspace.workspaceId)
      }

      const groups = (bridge.workspaces ?? []).filter((workspace) => (workspace?.sessionIds?.length ?? 0) > 0)
      const ungroupedIds = (bridge.ungroupedSessionIds ?? []).filter((sessionId) => typeof sessionId === 'string')
      const showUngrouped = ungroupedIds.length > 0
      const toastNode = toast !== null ? h('div', { className: 'dsh-sd-toast' }, toast) : null

      if (!bridge.open) return toastNode

      return h(React.Fragment, null,
        h('div', { className: 'dsh-sd-overlay', role: 'presentation' },
          h('div', {
            className: 'dsh-sd-dialog dsh-sd-panel',
            role: 'dialog', 'aria-modal': true, 'aria-label': t('cleanupTitle'),
          },
            target === null
              ? h(React.Fragment, null,
                h('h2', { className: 'dsh-sd-title' }, t('cleanupTitle')),
                h('p', { className: 'dsh-sd-desc' }, t('cleanupDesc')),
                progress !== null ? h('p', { className: 'dsh-sd-note' }, t('cleanupWorking', progress)) : null,
                error !== null ? h('p', { className: 'dsh-sd-warn' }, error) : null,
                h('div', { className: 'dsh-sd-groups' },
                  groups.length === 0
                    ? h('div', { className: 'dsh-sd-empty' }, t('cleanupEmpty'))
                    : groups.map((workspace) => {
                      const count = workspace?.sessionIds?.length ?? 0
                      const busy = (workspace?.sessionIds ?? []).filter(isBusy).length
                      return h('div', { className: 'dsh-sd-group', key: workspace.workspaceId },
                        h('div', { className: 'dsh-sd-group-main' },
                          h('div', { className: 'dsh-sd-group-title' }, workspace.title || workspace.path || workspace.workspaceId),
                          h('div', { className: 'dsh-sd-group-meta' }, workspace.path ?? ''),
                        ),
                        h('span', { className: 'dsh-sd-count' },
                          // Hidden members are part of the batch the dialog
                          // will delete, so spell out the total instead of
                          // showing "0 sessions" for an archive-only group.
                          (workspace.archived ?? 0) > 0
                            ? t('cleanupCountTotal', { n: count })
                            : t('cleanupCount', { n: workspace.visible ?? count }),
                          (workspace.archived ?? 0) > 0
                            ? ` · ${t('cleanupArchivedTag', { m: workspace.archived })}`
                            : '',
                          busy > 0 ? ` · ${t('cleanupBusyTag', { n: busy })}` : ''),
                        h('button', {
                          type: 'button',
                          className: 'dsh-sd-mini',
                          disabled: busy > 0 || progress !== null,
                          title: busy > 0 ? t('cleanupBusyBlocked', { n: busy }) : undefined,
                          onClick: () => { setError(null); setBusy(null); setTarget(workspace) },
                        }, t('cleanupAction')),
                      )
                    }),
                ),
                // "Ungrouped" is a sidebar bucket, not a workspace: sessions
                // spilled from a deleted group (or created outside any
                // workspace) live there and nothing else can clear them.
                showUngrouped
                  ? h('div', { className: 'dsh-sd-groups' },
                    h('div', { className: 'dsh-sd-group', key: 'dsh-sd-ungrouped' },
                      h('div', { className: 'dsh-sd-group-main' },
                        h('div', { className: 'dsh-sd-group-title' }, t('cleanupUngrouped')),
                        h('div', { className: 'dsh-sd-group-meta' }, t('cleanupUngroupedHint')),
                      ),
                      h('span', { className: 'dsh-sd-count' },
                        (bridge.ungroupedArchived ?? 0) > 0
                          ? t('cleanupCountTotal', { n: ungroupedIds.length })
                          : t('cleanupCount', { n: bridge.ungroupedVisible ?? ungroupedIds.length }),
                        (bridge.ungroupedArchived ?? 0) > 0
                          ? ` · ${t('cleanupArchivedTag', { m: bridge.ungroupedArchived })}`
                          : '',
                        (() => {
                          const busy = ungroupedIds.filter(isBusy).length
                          return busy > 0 ? ` · ${t('cleanupBusyTag', { n: busy })}` : ''
                        })()),
                      h('button', {
                        type: 'button',
                        className: 'dsh-sd-mini',
                        disabled: ungroupedIds.filter(isBusy).length > 0 || progress !== null,
                        title: ungroupedIds.filter(isBusy).length > 0
                          ? t('cleanupBusyBlocked', { n: ungroupedIds.filter(isBusy).length })
                          : undefined,
                        onClick: () => {
                          setError(null)
                          setBusy(null)
                          setTarget({ ungrouped: true, title: t('cleanupUngrouped'), sessionIds: ungroupedIds })
                        },
                      }, t('cleanupAction')),
                    ),
                  )
                  : null,
                h('div', { className: 'dsh-sd-footer' },
                  h('button', {
                    type: 'button', className: 'dsh-sd-btn',
                    onClick: () => publishCleanup({ open: false }),
                  }, t('cleanupClose')),
                ),
              )
              : h(React.Fragment, null,
                h('h2', { className: 'dsh-sd-title' },
                  t('cleanupConfirmTitle', { title: target.title || target.path || target.workspaceId || '' })),
                h('p', { className: 'dsh-sd-desc' }, t('cleanupConfirmDesc', { n: target?.sessionIds?.length ?? 0 })),
                target?.ungrouped === true
                  ? ((bridge.ungroupedArchived ?? 0) > 0
                    ? h('p', { className: 'dsh-sd-note' }, t('cleanupArchivedNote', { m: bridge.ungroupedArchived }))
                    : null)
                  : ((target?.archived ?? 0) > 0
                    ? h('p', { className: 'dsh-sd-note' }, t('cleanupArchivedNote', { m: target.archived }))
                    : null),
                progress !== null ? h('p', { className: 'dsh-sd-note' }, t('cleanupWorking', progress)) : null,
                error !== null ? h('p', { className: 'dsh-sd-warn' }, error) : null,
                target?.ungrouped === true
                  ? null
                  : h('p', { className: 'dsh-sd-note' }, t('cleanupButtonHints')),
                h('div', { className: 'dsh-sd-footer' },
                  h('button', {
                    type: 'button', className: 'dsh-sd-btn', disabled: progress !== null,
                    onClick: () => { if (progress === null) { setTarget(null); setError(null) } },
                  }, t('cancel')),
                  target?.ungrouped === true
                    ? null
                    : h('button', {
                      type: 'button', className: 'dsh-sd-btn', disabled: progress !== null,
                      onClick: () => {
                        if (progress === null) void cleanWorkspaceAndRemove(target, busy !== null)
                      },
                    }, progress !== null ? t('deleting') : busy !== null ? t('stopAndRemove') : t('cleanupActionRemove')),
                  h('button', {
                    type: 'button', className: 'dsh-sd-btn', 'data-danger': true, disabled: progress !== null,
                    onClick: () => {
                      if (progress !== null) return
                      if (target?.ungrouped === true) void cleanUngrouped(target.sessionIds ?? [], busy !== null)
                      else void cleanWorkspace(target, busy !== null)
                    },
                  }, progress !== null ? t('deleting') : busy !== null ? t('stopAndDelete') : t('confirmAction')),
                ),
              ),
          ),
        ),
        toastNode,
      )
    }

    return {
      // Pure helpers for tools/smoke-client.mjs; the plugin loader reads only inject/apply.
      __internals: { precheckBatch, deleteSerially, shouldRemoveGroup, describeFailures, describeActivity, selectTopLevel },
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        const t = bindLocale(ctx)

        // The stylesheet has to go away with the plugin (same contract the
        // shipped checkers enforce on every dynamic client half).
        ctx.effect(() => () => {
          document.getElementById(STYLE_ID)?.remove()
        })

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-session-clean', order: 20, label: () => t('cleanupFooter') },
            (props) => h(CleanupFooterAction, { ...props, t }),
          ),
        )

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
          ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'dsh-session-clean', order: 500 },
            (props) => h(DeleteSessionMenuItem, { ...props, ctx, t }),
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-clean' },
            () => h(DeleteSessionOverlay, { t, ctx }),
          ),
        )

        // Cleanup panel rides its own overlay cell (order 10) so it sits above
        // the per-session dialog layer and reads as a separate surface.
        // NOTE: the owner passes the standard hooks (`useWorkspaces`,
        // `useSessionStatus`, …) as props — they must be forwarded.
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-session-clean-cleanup', order: 10 },
            (props) => h(CleanupPanel, { ...props, t, ctx }),
          ),
        )
      },
    }
  },
})
