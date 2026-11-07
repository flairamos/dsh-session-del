/**
 * Browser half of the session-cleanup bundle.
 *
 * Two seats: one page in Settings that owns the whole inventory, and one row in
 * the Session action menu for deleting a single archived Session. Both call the
 * same Host route, so there is one implementation behind every affordance.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-cleanup',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const RPC_PATH = '/dsh-session-cleanup/rpc'

    // Translated through `ctx.locale` when the page has it; the English table is
    // also the runtime fallback, so an unknown locale shows real words, not keys.
    const DICTIONARIES = {
      en: {
        nav: 'Storage cleanup',
        heading: 'Storage cleanup',
        lead: 'Archived Sessions and stale scratch files leave your disk but stay recoverable in the trash until you empty it.',
        archivedHeading: 'Archived Sessions',
        archivedEmpty: 'No Session is archived right now.',
        selectAll: 'Select all',
        deleteSelected: 'Move to trash',
        confirmDeleteText: 'Move the selected Sessions to the trash? The project files stay untouched.',
        confirm: 'Confirm',
        cancel: 'Cancel',
        trashHeading: 'Trash',
        trashEmpty: 'The trash is empty.',
        restore: 'Restore',
        emptyTrash: 'Empty trash',
        confirmEmpty: 'Permanently delete everything in the trash? This cannot be undone.',
        tempHeading: 'Scratch files',
        tempHintText: 'Harness scratch directories in the OS temp folder that no process touched for a while.',
        tempEmpty: 'Nothing stale was found.',
        purgeTemp: 'Move to trash',
        refresh: 'Refresh',
        loading: 'Reading disk…',
        sessionWord: 'Session(s)',
        itemWord: 'item(s)',
        menuDelete: 'Permanently delete',
        deleting: 'Deleting…',
        failed: 'Failed',
        done: 'Done.',
        roots: 'Locations',
        missingFiles: 'files already gone',
        cleaned: 'Stale registrations cleared.',
        leftoversHeading: 'Rows left behind',
        leftoversHint: 'Sessions whose log is already gone but whose row the page still shows. Removing a row here only hides it; nothing on disk changes.',
        leftoversRemove: 'Remove from the list',
        reasonNotArchived: 'This Session is not archived, so it stays.',
        reasonRunning: 'This Session is running; stop it first.',
        reasonArchiveRecord: 'The archive record could not be cleared; the files were still removed.',
        reasonNoSelection: 'Select at least one Session to delete.',
        reasonInvalidBatch: 'That trash batch id is not valid.',
        errorUnknown: 'The operation failed.',
      },
      zh: {
        nav: '存储清理',
        heading: '存储清理',
        lead: '已归档的会话与过期的临时文件会从磁盘移走，但在清空隔离区之前都还能恢复；项目源码不受影响。',
        archivedHeading: '已归档会话',
        archivedEmpty: '当前没有已归档的会话。',
        selectAll: '全选',
        deleteSelected: '移入隔离区',
        confirmDeleteText: '将所选会话移入隔离区？项目文件不会被动到。',
        confirm: '确认',
        cancel: '取消',
        trashHeading: '隔离区',
        trashEmpty: '隔离区是空的。',
        restore: '恢复',
        emptyTrash: '清空隔离区',
        confirmEmpty: '永久删除隔离区里的全部内容？此操作不可撤销。',
        tempHeading: '临时文件',
        tempHintText: '系统临时目录里长时间未被任何进程改动的 Harness 临时目录。',
        tempEmpty: '没有发现可清理的临时目录。',
        purgeTemp: '移入隔离区',
        refresh: '刷新',
        loading: '正在读取磁盘…',
        sessionWord: '个会话',
        itemWord: '项',
        menuDelete: '永久删除',
        deleting: '删除中…',
        failed: '失败',
        done: '已完成。',
        roots: '位置',
        missingFiles: '文件已不在',
        cleaned: '已清理失效的归档登记。',
        leftoversHeading: '残留的行',
        leftoversHint: '日志已经不在、但页面仍在显示的会话。这里只会把它从列表里去掉，不会改动磁盘。',
        leftoversRemove: '从列表移除',
        reasonNotArchived: '该会话没有归档，因此保持原样。',
        reasonRunning: '该会话正在运行，请先停止。',
        reasonArchiveRecord: '归档登记未能清除，但文件已经移入隔离区。',
        reasonNoSelection: '请至少选择一个要删除的会话。',
        reasonInvalidBatch: '隔离批次 id 无效。',
        errorUnknown: '操作失败。',
      },
    }

    const TOKENS = {      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      error: 'var(--dsw-alias-state-error-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    }

    async function rpc(action, payload) {
      const response = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-cleanup': '1' },
        body: JSON.stringify({ action, payload }),
      })
      if (!response.ok) throw new Error(`The cleanup endpoint answered ${response.status}.`)
      const body = await response.json()
      if (body === null || body.ok !== true) {
        const failure = new Error(body?.error ?? 'The cleanup endpoint failed.')
        failure.code = body?.code
        throw failure
      }
      return body.value
    }

    const FALLBACK = DICTIONARIES.en
    const COMPOSED = new Set(['confirmDelete', 'sessionsUnit', 'itemsUnit', 'tempHint'])

    function createTranslator(ctx) {
      let bound
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          if (typeof locale.register === 'function') {
            try {
              ctx.effect(() => {
                try {
                  return locale.register('session-cleanup', DICTIONARIES)
                } catch {
                  // Plain-JS namespaces may need the per-locale form.
                }
                const disposers = []
                for (const [id, dict] of Object.entries(DICTIONARIES)) {
                  try {
                    const dispose = locale.register('session-cleanup', id, dict)
                    if (typeof dispose === 'function') disposers.push(dispose)
                  } catch {
                    // A locale the runtime refuses simply stays on English.
                  }
                }
                return () => {
                  for (const dispose of disposers) {
                    try {
                      dispose()
                    } catch {
                      // Already gone.
                    }
                  }
                }
              })
            } catch {
              // Registration is optional: the English table below still renders.
            }
          }
          if (typeof locale.bind === 'function') bound = locale.bind('session-cleanup')
        }
      } catch {
        bound = undefined
      }
      const read = (key) => {
        if (bound !== undefined) {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch {
            // Fall through to the English table.
          }
        }
        return FALLBACK[key] ?? key
      }
      const t = {}
      for (const key of Object.keys(FALLBACK)) {
        if (COMPOSED.has(key)) continue
        Object.defineProperty(t, key, { get: () => read(key), enumerable: true })
      }
      t.confirmDelete = count => `${read('confirmDeleteText')} (${count})`
      t.sessionsUnit = count => `${count} ${read('sessionWord')}`
      t.itemsUnit = count => `${count} ${read('itemWord')}`
      t.tempHint = hours => `${read('tempHintText')} (${hours} h)`
      return t
    }

    /** Localized text for one refused Session. */
    function skipText(t, skipped) {
      switch (skipped?.code) {
        case 'not-archived':
          return t.reasonNotArchived
        case 'running':
          return t.reasonRunning
        case 'archive-record':
          return t.reasonArchiveRecord
        default:
          return skipped?.reason ?? t.errorUnknown
      }
    }

    /** Localized text for one failed request. */
    function failureText(t, failure) {
      switch (failure?.code) {
        case 'no-selection':
          return t.reasonNoSelection
        case 'invalid-batch':
          return t.reasonInvalidBatch
        default:
          return String(failure?.message ?? failure)
      }
    }

    function formatBytes(bytes) {
      const value = typeof bytes === 'number' ? bytes : 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
    }

    function formatTime(value, fallback) {
      const ms = typeof value === 'number' ? value : (typeof value === 'string' ? Date.parse(value) : NaN)
      if (!Number.isFinite(ms)) return fallback
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return fallback
      }
    }

    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: 20, padding: '4px 0 24px', color: TOKENS.text },
      heading: { fontSize: 18, fontWeight: 600, margin: 0 },
      lead: { margin: 0, color: TOKENS.muted, fontSize: 13, lineHeight: 1.6, maxWidth: 680 },
      block: { display: 'flex', flexDirection: 'column', gap: 10 },
      blockHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      blockTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
      counter: { color: TOKENS.muted, fontSize: 12 },
      hint: { color: TOKENS.muted, fontSize: 12, margin: 0, lineHeight: 1.6 },
      row: {
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
        border: `1px solid ${TOKENS.border}`, borderRadius: 10, background: TOKENS.layer,
      },
      rowMain: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 },
      rowTitle: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowMeta: { fontSize: 11, color: TOKENS.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      button: {
        appearance: 'none', border: `1px solid ${TOKENS.border}`, background: TOKENS.layer2,
        color: TOKENS.text, borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
        fontFamily: 'inherit',
      },
      buttonPrimary: {
        appearance: 'none', border: `1px solid ${TOKENS.brand}`, background: TOKENS.brand,
        color: '#ffffff', borderRadius: 8, padding: '6px 12px', fontSize: 12, cursor: 'pointer',
        fontFamily: 'inherit',
      },
      buttonSmall: {
        appearance: 'none', border: `1px solid ${TOKENS.border}`, background: 'transparent',
        color: TOKENS.text, borderRadius: 7, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
        fontFamily: 'inherit',
      },
      error: { color: TOKENS.error, fontSize: 12, margin: 0 },
      notice: { color: TOKENS.muted, fontSize: 12, margin: 0 },
      empty: { color: TOKENS.muted, fontSize: 12, margin: 0, padding: '8px 0' },
      confirmBar: {
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 12px', borderRadius: 10, border: `1px solid ${TOKENS.brand}`,
        background: TOKENS.layer2, fontSize: 12,
      },
      roots: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: TOKENS.muted, wordBreak: 'break-all' },
    }

    function Button({ variant, children, ...rest }) {
      const style = variant === 'primary' ? styles.buttonPrimary : (variant === 'small' ? styles.buttonSmall : styles.button)
      return h('button', { type: 'button', style, ...rest }, children)
    }

    function CleanupPage({ dictionary, refreshSessions }) {
      const t = dictionary
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [selected, setSelected] = useState([])
      const [pendingAction, setPendingAction] = useState(null)

      const refresh = useCallback(async () => {
        try {
          const next = await rpc('state')
          setState(next)
          setSelected(previous => previous.filter(id => (next.archived ?? []).some(row => row.id === id)))
          setError('')
        } catch (failure) {
          setError(failureText(t, failure))
        }
      }, [t])

      useEffect(() => {
        refresh()
      }, [refresh])

      const perform = useCallback(async (task, message, options) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const value = await task()
          await refresh()
          if (typeof refreshSessions === 'function') await refreshSessions(options)
          setNotice(typeof message === 'function' ? message(value) : (message ?? t.done))
          return value
        } catch (failure) {
          setError(failureText(t, failure))
          return undefined
        } finally {
          setBusy(false)
          setPendingAction(null)
        }
      }, [refresh, refreshSessions, t])

      const archived = state?.archived ?? []
      const trash = state?.trash ?? []
      const temp = state?.temp ?? []
      const leftovers = state?.leftovers ?? []
      const allSelected = archived.length > 0 && selected.length === archived.length
      const trashBytes = useMemo(() => trash.reduce((sum, batch) => sum + (batch.bytes ?? 0), 0), [trash])
      const tempBytes = useMemo(() => temp.reduce((sum, item) => sum + (item.bytes ?? 0), 0), [temp])

      const toggle = useCallback((id) => {
        setSelected(previous => previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id])
      }, [])

      const requestDelete = () => {
        if (selected.length === 0) return
        setPendingAction({ kind: 'delete', ids: selected })
      }

      const confirmPending = () => {
        if (pendingAction === null) return
        if (pendingAction.kind === 'delete') {
          const ids = pendingAction.ids
          perform(
            () => rpc('deleteSessions', { ids, requireArchived: true }),
            result => {
              const removed = (result?.deleted?.length ?? 0) + (result?.cleaned?.length ?? 0)
              if (removed === 0) return t.done
              if ((result?.deleted?.length ?? 0) === 0) return t.cleaned
              return t.done
            },
            { refresh: false },
          )
          return
        }
        if (pendingAction.kind === 'empty') {
          perform(() => rpc('emptyTrash'), t.done)
          return
        }
        if (pendingAction.kind === 'temp') {
          const names = pendingAction.names
          perform(() => rpc('purgeTemp', { names }), t.done)
        }
      }

      return h('div', { style: styles.section },
        h('div', { style: styles.block },
          h('h2', { style: styles.heading }, t.heading),
          h('p', { style: styles.lead }, t.lead),
        ),

        h('div', { style: styles.blockHead },
          h(Button, { onClick: () => refresh(), disabled: busy }, busy ? t.loading : t.refresh),
          error !== '' ? h('p', { style: styles.error }, error) : null,
          error === '' && notice !== '' ? h('p', { style: styles.notice }, notice) : null,
        ),

        h('div', { style: styles.block },
          h('div', { style: styles.blockHead },
            h('h3', { style: styles.blockTitle }, t.archivedHeading),
            h('span', { style: styles.counter }, t.sessionsUnit(archived.length)),
            archived.length > 0 ? h(Button, {
              variant: 'small',
              onClick: () => setSelected(allSelected ? [] : archived.map(row => row.id)),
              disabled: busy,
            }, t.selectAll) : null,
            selected.length > 0 ? h(Button, {
              variant: 'primary',
              onClick: requestDelete,
              disabled: busy,
            }, `${t.deleteSelected} (${selected.length})`) : null,
          ),
          pendingAction?.kind === 'delete' ? h('div', { style: styles.confirmBar },
            h('span', null, t.confirmDelete(pendingAction.ids.length)),
            h(Button, { variant: 'primary', onClick: confirmPending, disabled: busy }, t.confirm),
            h(Button, { onClick: () => setPendingAction(null), disabled: busy }, t.cancel),
          ) : null,
          archived.length === 0
            ? h('p', { style: styles.empty }, t.archivedEmpty)
            : archived.map(row => h('label', { key: row.id, style: styles.row },
              h('input', {
                type: 'checkbox',
                checked: selected.includes(row.id),
                onChange: () => toggle(row.id),
                disabled: busy,
                style: { marginTop: 2 },
              }),
              h('span', { style: styles.rowMain },
                h('span', { style: styles.rowTitle }, row.title ?? row.id),
                h('span', { style: styles.rowMeta },
                  [row.cwd, formatTime(row.createdAt, ''), row.missing === true ? t.missingFiles : formatBytes(row.bytes)].filter(Boolean).join(' · ')),
                h('span', { style: styles.rowMeta }, row.id),
              ),
            )),
        ),

        h('div', { style: styles.block },
          h('div', { style: styles.blockHead },
            h('h3', { style: styles.blockTitle }, t.trashHeading),
            h('span', { style: styles.counter }, `${trash.length} · ${formatBytes(trashBytes)}`),
            trash.length > 0 ? h(Button, {
              variant: 'small',
              onClick: () => setPendingAction({ kind: 'empty' }),
              disabled: busy,
            }, t.emptyTrash) : null,
          ),
          pendingAction?.kind === 'empty' ? h('div', { style: styles.confirmBar },
            h('span', null, t.confirmEmpty),
            h(Button, { variant: 'primary', onClick: confirmPending, disabled: busy }, t.confirm),
            h(Button, { onClick: () => setPendingAction(null), disabled: busy }, t.cancel),
          ) : null,
          trash.length === 0
            ? h('p', { style: styles.empty }, t.trashEmpty)
            : trash.map(batch => h('div', { key: batch.batchId, style: styles.row },
              h('span', { style: styles.rowMain },
                h('span', { style: styles.rowTitle },
                  batch.kind === 'temp'
                    ? `${t.tempHeading} · ${t.itemsUnit(batch.temp.length)}`
                    : `${t.sessionsUnit(batch.sessions.length)}`),
                h('span', { style: styles.rowMeta },
                  (batch.sessions ?? []).map(entry => entry.id).concat((batch.temp ?? []).map(entry => entry.name)).join(', ')),
                h('span', { style: styles.rowMeta },
                  [formatTime(batch.createdAt, batch.batchId), formatBytes(batch.bytes)].join(' · ')),
              ),
              h(Button, {
                variant: 'small',
                onClick: () => perform(() => rpc('restore', { batchId: batch.batchId }), t.done),
                disabled: busy,
              }, t.restore),
            )),
        ),

        h('div', { style: styles.block },
          h('div', { style: styles.blockHead },
            h('h3', { style: styles.blockTitle }, t.tempHeading),
            h('span', { style: styles.counter }, `${temp.length} · ${formatBytes(tempBytes)}`),
            temp.length > 0 ? h(Button, {
              variant: 'primary',
              onClick: () => setPendingAction({ kind: 'temp', names: temp.map(item => item.name) }),
              disabled: busy,
            }, t.purgeTemp) : null,
          ),
          h('p', { style: styles.hint }, t.tempHint(state?.tempAgeHours ?? 12)),
          pendingAction?.kind === 'temp' ? h('div', { style: styles.confirmBar },
            h('span', null, t.confirmDelete(pendingAction.names.length)),
            h(Button, { variant: 'primary', onClick: confirmPending, disabled: busy }, t.confirm),
            h(Button, { onClick: () => setPendingAction(null), disabled: busy }, t.cancel),
          ) : null,
          temp.length === 0
            ? h('p', { style: styles.empty }, t.tempEmpty)
            : temp.map(item => h('div', { key: item.name, style: styles.row },
              h('span', { style: styles.rowMain },
                h('span', { style: styles.rowTitle }, item.name),
                h('span', { style: styles.rowMeta },
                  [formatBytes(item.bytes), formatTime(item.mtime, '')].filter(Boolean).join(' · ')),
              ),
            )),
        ),

        leftovers.length > 0 ? h('div', { style: styles.block },
          h('div', { style: styles.blockHead },
            h('h3', { style: styles.blockTitle }, t.leftoversHeading),
            h('span', { style: styles.counter }, t.sessionsUnit(leftovers.length)),
            h(Button, {
              variant: 'primary',
              onClick: () => perform(
                () => rpc('announceRemoved', { ids: leftovers.map(row => row.id) }),
                t.done,
                { refresh: false },
              ),
              disabled: busy,
            }, t.leftoversRemove),
          ),
          h('p', { style: styles.hint }, t.leftoversHint),
          leftovers.map(row => h('div', { key: row.id, style: styles.row },
            h('span', { style: styles.rowMain },
              h('span', { style: styles.rowTitle }, row.id),
              h('span', { style: styles.rowMeta }, formatTime(row.createdAt, '') || t.missingFiles),
            ),
          )),
        ) : null,

        state?.roots ? h('div', { style: styles.block },
          h('h3', { style: styles.blockTitle }, t.roots),
          h('div', { style: styles.roots },
            h('span', null, `home · ${state.roots.home}`),
            h('span', null, `sessions · ${state.roots.sessions}`),
            h('span', null, `trash · ${state.roots.trash}`),
            h('span', null, `temp · ${state.roots.temp}`),
          ),
        ) : null,
      )
    }

    function SessionDeleteAction({ sessionId, dictionary, refreshSessions, ...props }) {
      const t = dictionary
      // The row's slot hands us the Workspace snapshot, so the entry can stay
      // hidden on every Session it would refuse. An unreadable snapshot falls
      // back to showing it: the Host still refuses and explains why.
      let archived
      try {
        archived = typeof props.useWorkspaces === 'function' ? props.useWorkspaces(state => state) : undefined
      } catch {
        archived = undefined
      }
      const archivedIds = archived?.archivedSessionIds ?? archived?.archived
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState('')

      const remove = useCallback(async (event) => {
        event?.preventDefault?.()
        event?.stopPropagation?.()
        if (busy || typeof sessionId !== 'string' || sessionId === '') return
        setBusy(true)
        setFailure('')
        try {
          const result = await rpc('deleteSessions', { ids: [sessionId], requireArchived: true })
          // No list pull here: the Host announced the removal, and re-listing a
          // resident Session would bring the row straight back.
          if (typeof refreshSessions === 'function') await refreshSessions({ refresh: false })
          const skipped = Array.isArray(result?.skipped) && result.skipped.length > 0 ? result.skipped[0] : undefined
          if (skipped !== undefined) setFailure(skipText(t, skipped))
        } catch (error) {
          setFailure(failureText(t, error))
        } finally {
          setBusy(false)
        }
      }, [busy, refreshSessions, sessionId, t])
      if (Array.isArray(archivedIds) && !archivedIds.includes(sessionId)) return null

      const label = busy ? t.deleting : (failure !== '' ? `${t.failed}: ${failure}` : t.menuDelete)

      return h('button', {
        type: 'button',
        role: 'menuitem',
        onClick: remove,
        disabled: busy,
        title: failure === '' ? t.menuDelete : failure,
        style: {
          appearance: 'none',
          display: 'block',
          width: '100%',
          textAlign: 'left',
          border: 0,
          background: 'transparent',
          color: TOKENS.error,
          font: 'inherit',
          fontSize: 12,
          padding: '6px 10px',
          borderRadius: 6,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        },
      }, label)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const dictionary = createTranslator(ctx)
        // A deleted Session must not be pulled back: the Host already announced
        // its removal, and re-listing a resident Session would resurrect the row.
        // Everything else re-lists first, then hides whatever is still retired.
        const refreshSessions = async (options = {}) => {
          if (options.refresh !== false) {
            const sessions = ctx.get('sessions')
            if (sessions !== undefined && typeof sessions.refresh === 'function') {
              try {
                await sessions.refresh()
              } catch {
                // The announcement below still drops the rows it can.
              }
            }
          }
          try {
            await rpc('replayRemovals')
          } catch {
            // Older Host halves have no such action.
          }
        }
        // A page that opens later still has to forget rows deleted earlier.
        setTimeout(() => {
          rpc('replayRemovals').catch(() => {})
        }, 2500)

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-cleanup',
          order: 16,
          label: () => dictionary.nav,
        }, props => h(CleanupPage, { ...props, dictionary, refreshSessions })))

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-cleanup-delete',
          order: 90,
          label: () => dictionary.menuDelete,
        }, props => {
          try {
            return h(SessionDeleteAction, { ...props, dictionary, refreshSessions })
          } catch {
            return null
          }
        }))
      },
    }
  },
})
