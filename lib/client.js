/**
 * Browser half of the DSH “delete conversation” plugin.
 *
 * It contributes:
 *   - a red 删除 row to every conversation's “…” menu (moves the conversation
 *     into the Host recycle bin);
 *   - a 回收站 button in the sidebar footer that opens the recycle-bin modal,
 *     where entries can be restored or permanently purged.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createRoot } = require('react-dom/client')
    const { Button, IconTrashOutlineRegular, MenuItemButton, Modal } = require(
      '@deepseek-ai/dsh-client-ui-primitives',
    )

    const h = React.createElement
    const { useEffect, useState } = React
    const DANGER = 'var(--dsw-alias-state-error-primary)'
    const TRASH_EVENT = 'dsh-session-delete:trash-changed'
    const STYLE_ID = 'dsh-plugin-session-delete/styles'

    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-session-delete'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = `
        .dsh-sd-footer {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          box-sizing: border-box;
          width: 100%;
          min-height: 36px;
          margin: 0 2px;
          padding: 7px 8px;
          border: 0;
          border-radius: var(--dsw-radius-md, 8px);
          background: transparent;
          color: var(--dsw-alias-label-primary, #e6e6e6);
          font: inherit;
          font-size: 14px;
          line-height: 22px;
          text-align: left;
          cursor: pointer;
        }
        .dsh-sd-footer:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
        .dsh-sd-footer:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4d6bfe); outline-offset: -2px; }
        .dsh-sd-footer[data-wide="false"] { width: 36px; height: 36px; min-height: 36px; justify-content: center; margin: 0; padding: 0; }
        .dsh-sd-footer svg { flex: none; }
        .dsh-sd-footer-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-sd-badge {
          position: absolute;
          top: 2px;
          right: 4px;
          min-width: 16px;
          height: 16px;
          padding: 0 4px;
          border-radius: 8px;
          background: var(--dsw-alias-state-business-primary, #4d6bfe);
          color: #fff;
          font-size: 10px;
          line-height: 16px;
          text-align: center;
        }
        .dsh-sd-footer[data-wide="false"] .dsh-sd-badge { top: 0; right: 0; }
        .dsh-sd-trash-list { display: flex; flex-direction: column; gap: 6px; max-height: 46vh; margin: 0; padding: 0; overflow: auto; list-style: none; }
        .dsh-sd-trash-row { display: flex; gap: 8px; align-items: center; justify-content: space-between; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(255,255,255,.14)); border-radius: var(--dsw-radius-md, 8px); }
        .dsh-sd-trash-main { min-width: 0; }
        .dsh-sd-trash-title { overflow: hidden; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 13px; line-height: 19px; text-overflow: ellipsis; white-space: nowrap; }
        .dsh-sd-trash-meta { color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 11px; line-height: 17px; }
        .dsh-sd-trash-actions { display: flex; flex: none; gap: 4px; }
        .dsh-sd-link { padding: 3px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-link, #6f9bff); font-size: 12px; line-height: 18px; cursor: pointer; }
        .dsh-sd-link:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08)); }
        .dsh-sd-link:disabled { color: var(--dsw-alias-label-dimmed, #666); cursor: default; }
        .dsh-sd-link.dsh-sd-danger { color: ${DANGER}; }
        .dsh-sd-status { color: var(--dsw-alias-label-secondary, #b0b0b0); font-size: 12px; line-height: 18px; }
        .dsh-sd-error { color: ${DANGER}; font-size: 12px; line-height: 18px; }
        .dsh-sd-empty { padding: 24px 8px; color: var(--dsw-alias-label-tertiary, #8a8a8a); font-size: 13px; line-height: 20px; text-align: center; }
      `
      document.head.append(style)
    }

    /**
     * The DSH locale service is authoritative once available; the browser
     * languages are only a fallback for the first paint. Reading the document
     * `<html lang>` first is wrong: the shell ships `lang="en"` and sets it to
     * the real locale asynchronously, which made an early-loaded plugin stick
     * to English after a restart.
     */
    let localeService
    function isChinese() {
      try {
        const snapshot = localeService?.getLocale?.() ?? localeService?.getSnapshot?.()
        const active = snapshot?.active
        const id = typeof active?.id === 'string'
          ? active.id
          : typeof snapshot?.id === 'string' ? snapshot.id : undefined
        if (id !== undefined) return id.toLowerCase().startsWith('zh')
      } catch {
        // Fall through to the browser language.
      }
      const candidates = []
      if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
      if (navigator.language) candidates.push(navigator.language)
      if (document.documentElement.lang) candidates.push(document.documentElement.lang)
      return candidates.some((value) => String(value).toLowerCase().startsWith('zh'))
    }

    const zh = {
      menu: '删除',
      title: '删除对话',
      description: '“{title}”将被移入回收站，可随时恢复或彻底删除。已安装的插件、S 盘插件目录和安装脚本不受影响。',
      cancel: '取消',
      confirm: '移入回收站',
      deleting: '正在移动…',
      fallbackTitle: '未命名对话',
      live: '该对话仍在 Harness 中打开或运行。请先切换到其他对话，或停止正在进行的回答后再删除。',
      busy: '无法移动：该对话的文件仍被 Harness 占用。请重启 Harness 后重试。',
      notFound: '找不到该对话，它可能已被删除。',
      failed: '操作失败，请稍后重试。',
      close: '关闭',
      trash: '回收站',
      trashTitle: '回收站',
      trashDescription: '已删除的对话会暂时保留在这里；可以恢复，也可以彻底删除。',
      restore: '恢复',
      purge: '彻底删除',
      confirmPurge: '确认彻底删除',
      empty: '清空回收站',
      confirmEmpty: '确认清空',
      loading: '正在读取回收站…',
      emptyTrash: '回收站是空的。',
      restored: '已恢复，正在刷新页面…',
      restoreExists: '原会话目录已存在，无法恢复。',
      trashCorrupt: '这条回收站记录已损坏。',
      trashNoPayload: '这条记录没有可恢复的会话文件。',
      trashNotFound: '回收站里找不到这条记录。',
      sizeUnknown: '大小未知',
      count: '共 {n} 条，合计 {size}',
      closeTrash: '关闭',
    }

    const en = {
      menu: 'Delete',
      title: 'Delete conversation',
      description: '“{title}” will be moved to the recycle bin, where it can be restored or permanently deleted. Installed plugins, the S: plugin folder, and installer scripts are not affected.',
      cancel: 'Cancel',
      confirm: 'Move to recycle bin',
      deleting: 'Moving…',
      fallbackTitle: 'Untitled conversation',
      live: 'This conversation is still open or running in Harness. Switch to another conversation or stop the reply first.',
      busy: 'Cannot move: Harness still holds this conversation’s files. Restart Harness and try again.',
      notFound: 'This conversation could not be found; it may already be deleted.',
      failed: 'The operation failed. Try again.',
      close: 'Close',
      trash: 'Recycle bin',
      trashTitle: 'Recycle bin',
      trashDescription: 'Deleted conversations stay here for a while. Restore one or delete it permanently.',
      restore: 'Restore',
      purge: 'Delete permanently',
      confirmPurge: 'Confirm permanent delete',
      empty: 'Empty recycle bin',
      confirmEmpty: 'Confirm empty',
      loading: 'Loading recycle bin…',
      emptyTrash: 'The recycle bin is empty.',
      restored: 'Restored. Reloading…',
      restoreExists: 'The original session folder already exists; cannot restore.',
      trashCorrupt: 'This recycle-bin record is corrupt.',
      trashNoPayload: 'This record has no restorable session files.',
      trashNotFound: 'This record is no longer in the recycle bin.',
      sizeUnknown: 'Unknown size',
      count: '{n} entries, {size} total',
      closeTrash: 'Close',
    }

    /** Property access resolves against the current locale at render time. */
    const t = new Proxy({}, {
      get(_target, key) {
        return (isChinese() ? zh : en)[key]
      },
    })

    /** Re-render one component when the DSH locale changes. */
    function useLocaleTick() {
      const [, setTick] = useState(0)
      useEffect(() => {
        if (typeof localeService?.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setTick((value) => value + 1))
      }, [])
    }

    /** Map the Host's stable failure codes onto localized copy. */
    function failureText(code) {
      if (code === 'session-live') return t.live
      if (code === 'session-busy') return t.busy
      if (code === 'session-not-found') return t.notFound
      if (code === 'restore-target-exists') return t.restoreExists
      if (code === 'trash-corrupt') return t.trashCorrupt
      if (code === 'trash-no-payload') return t.trashNoPayload
      if (code === 'trash-not-found') return t.trashNotFound
      return t.failed
    }

    /** Format a byte count compactly. */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return t.sizeUnknown
      if (bytes < 1024) return `${String(bytes)} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /** Format a timestamp with the page locale. */
    function formatTime(value) {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
    }

    /** Read the Host recycle-bin list. */
    async function fetchTrash() {
      const response = await fetch('/api/session-delete/trash', { method: 'GET' })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || payload?.ok !== true) throw new Error(failureText(payload?.code))
      return payload
    }

    /** Post one recycle-bin action. */
    async function postTrash(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || payload?.ok !== true) throw new Error(failureText(payload?.code))
      return payload
    }

    /** Notify the footer badge that the recycle bin changed. */
    function announceTrashChange() {
      window.dispatchEvent(new Event(TRASH_EVENT))
    }

    /** The delete confirmation; a successful move closes the dialog and reloads. */
    function DeleteDialog({ sessionId, displayTitle, onDone }) {
      useLocaleTick()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const close = () => {
        if (!busy) onDone(false)
      }
      const confirm = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const response = await fetch('/api/session-delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, title: displayTitle }),
          })
          let payload
          try {
            payload = await response.json()
          } catch {
            payload = undefined
          }
          if (!response.ok || payload?.ok !== true) {
            setBusy(false)
            setError(failureText(payload?.code))
            return
          }
          announceTrashChange()
          onDone(true)
        } catch (reason) {
          setBusy(false)
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }
      return h(
        Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t.close,
          title: t.title,
          description: t.description.replace('{title}', displayTitle || t.fallbackTitle),
          footer: [
            h(Button, { key: 'cancel', variant: 'outline', disabled: busy, onClick: close }, t.cancel),
            h(
              Button,
              { key: 'delete', variant: 'outline', disabled: busy, onClick: confirm },
              h('span', { style: { color: DANGER } }, busy ? t.deleting : t.confirm),
            ),
          ],
        },
        error === null
          ? null
          : h('div', { role: 'alert', className: 'dsh-sd-error' }, error),
      )
    }

    /** One recycle-bin row: title/time/size plus restore and purge actions. */
    function TrashRow({ entry, busy, confirming, onRestore, onPurge }) {
      return h(
        'li',
        { className: 'dsh-sd-trash-row' },
        h(
          'div',
          { className: 'dsh-sd-trash-main' },
          h('div', { className: 'dsh-sd-trash-title', title: entry.title }, entry.title),
          h(
            'div',
            { className: 'dsh-sd-trash-meta' },
            `${formatTime(entry.deletedAt)} · ${formatSize(entry.sizeBytes)}`,
          ),
        ),
        h(
          'div',
          { className: 'dsh-sd-trash-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-sd-link',
              disabled: busy !== null,
              onClick: () => onRestore(entry.entryId),
            },
            t.restore,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-sd-link dsh-sd-danger',
              disabled: busy !== null,
              onClick: () => onPurge(entry.entryId),
            },
            confirming ? t.confirmPurge : t.purge,
          ),
        ),
      )
    }

    /** The recycle-bin modal: list, restore, purge one, or empty everything. */
    function TrashDialog({ onClose }) {
      useLocaleTick()
      const [state, setState] = useState({
        loading: true,
        entries: [],
        totalBytes: 0,
        error: null,
        notice: null,
        busy: null,
        confirmPurge: null,
        confirmEmpty: false,
      })

      const load = async () => {
        setState((current) => ({ ...current, loading: true, error: null }))
        try {
          const data = await fetchTrash()
          setState((current) => ({
            ...current,
            loading: false,
            entries: data.entries,
            totalBytes: data.totalBytes,
          }))
        } catch (reason) {
          setState((current) => ({
            ...current,
            loading: false,
            error: reason instanceof Error ? reason.message : String(reason),
          }))
        }
      }

      useEffect(() => {
        void load()
      }, [])

      const restore = async (entryId) => {
        setState((current) => ({ ...current, busy: entryId, error: null, confirmPurge: null }))
        try {
          await postTrash('/api/session-delete/trash/restore', { entryId })
          announceTrashChange()
          setState((current) => ({ ...current, busy: null, notice: t.restored }))
          setTimeout(() => location.reload(), 600)
        } catch (reason) {
          setState((current) => ({
            ...current,
            busy: null,
            error: reason instanceof Error ? reason.message : String(reason),
          }))
        }
      }

      const purge = async (entryId) => {
        if (state.confirmPurge !== entryId) {
          setState((current) => ({ ...current, confirmPurge: entryId, error: null }))
          return
        }
        setState((current) => ({ ...current, busy: entryId, error: null }))
        try {
          await postTrash('/api/session-delete/trash/purge', { entryId })
          announceTrashChange()
          setState((current) => ({
            ...current,
            busy: null,
            confirmPurge: null,
            entries: current.entries.filter((entry) => entry.entryId !== entryId),
          }))
        } catch (reason) {
          setState((current) => ({
            ...current,
            busy: null,
            error: reason instanceof Error ? reason.message : String(reason),
          }))
        }
      }

      const empty = async () => {
        if (!state.confirmEmpty) {
          setState((current) => ({ ...current, confirmEmpty: true, error: null }))
          return
        }
        setState((current) => ({ ...current, busy: 'empty', error: null }))
        try {
          await postTrash('/api/session-delete/trash/empty')
          announceTrashChange()
          setState((current) => ({
            ...current,
            busy: null,
            confirmEmpty: false,
            entries: [],
            totalBytes: 0,
          }))
        } catch (reason) {
          setState((current) => ({
            ...current,
            busy: null,
            error: reason instanceof Error ? reason.message : String(reason),
          }))
        }
      }

      const close = () => {
        if (state.busy === null) onClose()
      }

      const body = []
      if (state.loading) {
        body.push(h('div', { key: 'loading', className: 'dsh-sd-status' }, t.loading))
      } else if (state.error !== null && state.entries.length === 0) {
        body.push(h('div', { key: 'error', className: 'dsh-sd-error', role: 'alert' }, state.error))
      } else if (state.entries.length === 0) {
        body.push(h('div', { key: 'empty', className: 'dsh-sd-empty' }, t.emptyTrash))
      } else {
        body.push(
          h(
            'div',
            { key: 'count', className: 'dsh-sd-status' },
            t.count.replace('{n}', String(state.entries.length)).replace('{size}', formatSize(state.totalBytes)),
          ),
        )
        body.push(
          h(
            'ul',
            { key: 'list', className: 'dsh-sd-trash-list' },
            state.entries.map((entry) =>
              h(TrashRow, {
                key: entry.entryId,
                entry,
                busy: state.busy,
                confirming: state.confirmPurge === entry.entryId,
                onRestore: restore,
                onPurge: purge,
              }),
            ),
          ),
        )
      }
      if (state.notice !== null) {
        body.push(h('div', { key: 'notice', className: 'dsh-sd-status', role: 'status' }, state.notice))
      }
      if (state.error !== null && state.entries.length > 0) {
        body.push(h('div', { key: 'error-row', className: 'dsh-sd-error', role: 'alert' }, state.error))
      }

      return h(
        Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t.closeTrash,
          title: t.trashTitle,
          description: t.trashDescription,
          footer: [
            h(Button, { key: 'close', variant: 'outline', disabled: state.busy !== null, onClick: close }, t.closeTrash),
            h(
              Button,
              {
                key: 'empty',
                variant: 'outline',
                disabled: state.entries.length === 0 || state.busy !== null,
                onClick: empty,
              },
              h('span', { style: { color: DANGER } }, state.confirmEmpty ? t.confirmEmpty : t.empty),
            ),
          ],
        },
        body,
      )
    }

    /** Mount any dialog into its own React root so menu closure cannot take it away. */
    function mountDialog(attribute, component) {
      if (document.querySelector(`[${attribute}]`) !== null) return
      const container = document.createElement('div')
      container.setAttribute(attribute, '')
      document.body.append(container)
      const root = createRoot(container)
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        try {
          root.unmount()
        } catch {
          // The root may already be gone while the page is unloading.
        }
        container.remove()
      }
      root.render(component(dispose))
    }

    /** Open the confirmation for one conversation. */
    function openDeleteDialog(sessionId, displayTitle) {
      mountDialog('data-dsh-session-delete-dialog', (dispose) =>
        h(DeleteDialog, {
          sessionId,
          displayTitle,
          onDone: (deleted) => {
            dispose()
            if (deleted) setTimeout(() => location.reload(), 150)
          },
        }),
      )
    }

    /** Open the recycle-bin modal. */
    function openTrashDialog() {
      mountDialog('data-dsh-session-delete-trash', (dispose) => h(TrashDialog, { onClose: dispose }))
    }

    /** Sidebar footer entry, with a live count badge. */
    function TrashFooterButton({ wide }) {
      useLocaleTick()
      const [count, setCount] = useState(0)
      useEffect(() => {
        let alive = true
        const refresh = () => {
          fetchTrash()
            .then((data) => {
              if (alive) setCount(data.entries.length)
            })
            .catch(() => {})
        }
        refresh()
        window.addEventListener(TRASH_EVENT, refresh)
        return () => {
          alive = false
          window.removeEventListener(TRASH_EVENT, refresh)
        }
      }, [])
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-sd-footer',
          'data-wide': wide ? 'true' : 'false',
          title: t.trash,
          'aria-label': t.trash,
          onClick: openTrashDialog,
        },
        h(IconTrashOutlineRegular, { size: 16 }),
        wide ? h('span', { className: 'dsh-sd-footer-label' }, t.trash) : null,
        count > 0 ? h('span', { className: 'dsh-sd-badge' }, String(count)) : null,
      )
    }

    /** The trailing red menu row. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      useLocaleTick()
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        MenuItemButton,
        {
          separatorBefore: true,
          icon: h(IconTrashOutlineRegular, { size: 14, style: { color: DANGER } }),
          onSelect: () => {
            setMenuOpen(false)
            openDeleteDialog(sessionId, displayTitle)
          },
        },
        h('span', { style: { color: DANGER } }, t.menu),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      localeService = ctx.locale
      // Handshake with the Host half: it records that this bundle executed, so
      // an installation can be diagnosed without opening DevTools.
      fetch('/api/session-delete/ping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: '1.1.1' }),
      }).catch(() => {})

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-delete',
            order: 500,
          },
          DeleteSessionMenuItem,
        ),
      )

      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'session-delete.trash',
            order: 100,
          },
          TrashFooterButton,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
