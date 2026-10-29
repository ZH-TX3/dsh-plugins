/**
 * dsh-session-continuity — browser half.
 *
 * 在 `conversation.input.dock`（输入卡片上方，hero 与 active 两个阶段都会渲染）
 * 画一条横幅，提示「检测到待加载的 Handoff」。
 *
 * 为什么不是 `conversation.composer.dock`：
 *   宿主只在 `variant === "composer"` 时渲染该槽位
 *   （client-ui-conversation: `variant === "composer" && ...`），
 *   而新会话处于 hero 阶段 → variant 为 "hero" → 槽位根本不存在。
 *   新对话不弹提示的直接原因就在这里。
 *
 * 为什么 cwd 不在 register 的 inject 里取：
 *   inject 结果按 (entry × 会话绑定) 缓存，会话列表后到时不会重算，
 *   新会话首帧拿到的 `cwd: undefined` 会永久冻结。
 *   改用槽位标准属性里的 `useSessions` 选择器，订阅最小切片。
 *
 * 动作：
 *   加载 → 只发送「加载」两个字；hooks/user-prompt-submit.py 识别后
 *              注入指令，由模型读取 .dsh/HANDOFF.md 并归档到 history/。
 *   跳过     → 按 Handoff 版本记一次忽略（项目级），不再打扰
 *   归档     → 把 HANDOFF 移入 history/，横幅消失
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-continuity',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/dsh-session-continuity/api/handoff'
    /** 载入按钮只发送这两个字；读取/展示/归档由 UserPromptSubmit hook + 模型完成。 */
    const HANDOFF_LOAD_TOKEN = '加载'
    /**
     * 客户端调试输出：默认关闭。
     * 开启：控制台执行
     *   localStorage.setItem('dsh-session-continuity:debug', '1')
     * 后刷新页面；移除该键即恢复静默。
     */
    const DEBUG = (() => {
      try { return window.localStorage.getItem('dsh-session-continuity:debug') === '1' } catch { return false }
    })()

    /** 组件级样式，随卸载一起移除，不污染宿主样式表。 */
    const styles = {
      /**
       * 零高度锚点：仍留在 composer stack 里（拿到正确的槽位坐标），
       * 但自身不占高度；负 margin 抵消 flex gap，避免把输入框顶下去。
       */
      anchor: {
        boxSizing: 'border-box',
        position: 'relative',
        width: '100%',
        height: 0,
        // flex gap 会在前后各加一份；各抵消一半，输入框位置保持不变。
        marginTop: 'calc(var(--dsh-composer-stack-gap, 6px) * -0.5)',
        marginBottom: 'calc(var(--dsh-composer-stack-gap, 6px) * -0.5)',
        pointerEvents: 'none',
      },
      /** 真正可见的横幅：绝对定位、脱离文档流，悬在输入卡片上方。 */
      card: {
        boxSizing: 'border-box',
        position: 'absolute',
        left: '50%',
        bottom: '8px',
        transform: 'translateX(-50%)',
        width: '360px',
        maxWidth: 'calc(100vw - 32px)',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        padding: '8px 10px',
        borderRadius: '8px',
        border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
        background: 'var(--dsw-alias-bg-layer-1, #2a2a2a)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
        lineHeight: '1.5',
        boxShadow: '0 6px 20px rgba(0,0,0,.18)',
        zIndex: 20,
        pointerEvents: 'auto',
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%' },
      title: {
        flex: '0 1 auto',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: 600,
      },
      meta: {
        display: 'block',
        color: 'var(--dsw-alias-label-tertiary, inherit)',
        fontSize: '12px',
        overflowWrap: 'anywhere',
      },
      spacer: { flex: '1 1 auto' },
      footer: { display: 'flex', gap: '8px', marginTop: '2px' },
      btn: {
        cursor: 'pointer',
        border: '0.5px solid var(--dsw-alias-border-l3, rgba(127,127,127,.45))',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        padding: '3px 10px',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      primary: {
        cursor: 'pointer',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-state-business-primary, #247bbf)',
        color: '#fff',
        borderRadius: '6px',
        padding: '3px 10px',
        fontSize: '12px',
        fontFamily: 'inherit',
      },
      body: {
        width: '100%',
        margin: '4px 0 0',
        padding: '8px 10px',
        borderRadius: '6px',
        border: '0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-base, transparent)',
        maxHeight: '260px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
      },
      error: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere', color: 'var(--dsw-alias-state-error-primary, #c0392b)', fontSize: '12px' },
    }

    function Banner(props) {
      const { sessionId, session, inputActions } = props
      // 槽位标准属性（SessionStandardProps / GlobalStandardProps）。
      // 兜底成普通函数：宿主版本变化时宁可横幅不显示，也不要整条槽位崩掉。
      const useSession = props.useSession ?? (() => undefined)
      const useSessions = props.useSessions ?? (() => undefined)

      // 会话列表是异步到达的：订阅 byId 里的这一行，行到了就重渲染。
      const row = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]))
      // DSH 官方「新会话」定义：从未出现过 turn/start。
      const liveBlank = useSession((state) => state?.blank)
      const blank = liveBlank === undefined ? session?.blank === true : liveBlank === true

      const cwd = typeof row?.cwd === 'string' && row.cwd !== '' ? row.cwd : null
      const isSubagent = session?.subagent != null || row?.origin === 'subagent'

      const [snap, setSnap] = React.useState(null)
      const [body, setBody] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // 一旦在本会话里确认过「该提示」，即使随后发出第一条消息（blank 变 false）
      // 也继续显示，直到用户跳过/归档。
      const [sticky, setSticky] = React.useState(false)
      // 已经点过「加载」的那份 Handoff（path@mtime）。模型归档成功后文件消失；
      // 若模型没归档，轮询超时后会清空它，让横幅重新出现以便重试。
      const [loadedKey, setLoadedKey] = React.useState(null)
      const pollRef = React.useRef(null)

      React.useEffect(() => () => {
        if (pollRef.current !== null) clearInterval(pollRef.current)
      }, [])

      React.useEffect(() => {
        setSnap(null)
        setBody(null)
        setError(null)
        setSticky(false)
        setLoadedKey(null)
        if (pollRef.current !== null) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, [sessionId])

      React.useEffect(() => {
        if (!cwd || sessionId === undefined || isSubagent) return
        let cancelled = false
        let timer = null

        const load = (attempt) => {
          const q = new URLSearchParams({ cwd })
          q.set('sessionId', sessionId)
          if (blank) q.set('blank', '1')
          fetch(`${API}?${q.toString()}`, { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              if (cancelled) return
              setSnap(data)
              setError(null)
              if (data?.relevant) setSticky(true)
              if (DEBUG) {
                console.log('[session-continuity/client] state', JSON.stringify({
                  sessionId, blank, present: data?.present, relevant: data?.relevant, handled: data?.handled,
                }))
              }
            })
            .catch((e) => {
              if (cancelled) return
              // 宿主路由可能还没挂好（页面先于插件 boot），退避重试。
              if (attempt < 3) {
                timer = setTimeout(() => load(attempt + 1), 800 * 2 ** attempt)
                return
              }
              setError(String(e?.message ?? e))
            })
        }

        load(0)
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [cwd, sessionId, blank, isSubagent])

      /** 发一个 POST 动作，返回宿主 JSON。 */
      const request = (action) => {
        const q = new URLSearchParams({ cwd, action })
        if (sessionId !== undefined) q.set('sessionId', sessionId)
        if (blank) q.set('blank', '1')
        return fetch(`${API}?${q.toString()}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      }

      /** 跳过 / 归档：只更新宿主状态。 */
      const post = (action) => {
        if (!cwd) return
        setBusy(true)
        request(action)
          .then((data) => { setError(null); setBody(null); setSnap(data) })
          .catch((e) => setError(String(e?.message ?? e)))
          .finally(() => setBusy(false))
      }

      /** 当前快照对应的 Handoff 版本标识。 */
      const snapKey = (data) => (data?.present ? `${data.path}@${data.mtimeLabel}` : null)

      /**
       * 轮询宿主状态，等模型把 HANDOFF.md 归档掉。
       * 归档后 present 变 false；60 秒仍未归档则把横幅放回来，允许重试。
       */
      const watchArchived = () => {
        if (pollRef.current !== null) clearInterval(pollRef.current)
        let tries = 0
        pollRef.current = setInterval(() => {
          tries += 1
          const q = new URLSearchParams({ cwd })
          if (sessionId !== undefined) q.set('sessionId', sessionId)
          if (blank) q.set('blank', '1')
          fetch(`${API}?${q.toString()}`, { credentials: 'same-origin', cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((data) => {
              setSnap(data)
              if (!data?.present) {
                clearInterval(pollRef.current)
                pollRef.current = null
              } else if (tries >= 24) {
                clearInterval(pollRef.current)
                pollRef.current = null
                // 模型没有完成归档：恢复横幅，用户可以重试。
                setLoadedKey(null)
              }
            })
            .catch(() => {
              if (tries < 6) return
              clearInterval(pollRef.current)
              pollRef.current = null
              setLoadedKey(null)
            })
        }, 2500)
      }

      /**
       * 加载：只发送「加载」两个字。
       *
       * 读取正文、展示、归档都不在客户端做 —— 交给
       * `hooks/user-prompt-submit.py`（DSH 的 UserPromptSubmit 桥接）：
       * 它识别到「加载」后注入 additionalContext，让模型读取
       * <项目>/.dsh/HANDOFF.md 并移动到 .dsh/session-continuity/history/。
       * 这样输入框里只有两个字，正文不经过前端，也不会被复制一遍。
       */
      const loadIntoConversation = () => {
        if (!cwd) return
        if (typeof inputActions?.setDraft !== 'function' || typeof inputActions?.submit !== 'function') {
          // 宿主没暴露输入动作时退化为预览，至少不丢内容。
          setBusy(true)
          request('read')
            .then((data) => { setError(null); setBody(String(data.body ?? '')) })
            .catch((e) => setError(String(e?.message ?? e)))
            .finally(() => setBusy(false))
          return
        }
        setError(null)
        setBody(null)
        setLoadedKey(snapKey(snap))
        inputActions.setDraft(HANDOFF_LOAD_TOKEN)
        inputActions.submit()
        watchArchived()
      }

      if (!cwd || isSubagent) return null
      if (error) {
        return h('div', { style: styles.anchor },
          h('div', { style: styles.card, role: 'status' },
            h('span', { style: styles.error }, `Session Continuity: ${error}`),
            h('button', { style: styles.btn, onClick: () => setError(null) }, '关闭')))
      }
      const visible = Boolean(snap?.present) && !snap.handled
        && (snap.relevant === true || sticky)
        && snapKey(snap) !== loadedKey
      if (!visible) return null

      const staleHint = snap.stale
        ? `已超过 ${snap.staleDays} 天，建议忽略`
        : null
      const metaText = [
        snap.relative,
        `${snap.size} bytes`,
        snap.source === 'save-state' ? '手动保存' : '旧版格式',
        staleHint,
      ].filter(Boolean).join(' · ')

      return h('div', { style: styles.anchor },
        h('div', { style: styles.card, role: 'status' },
          h('div', { style: styles.head },
            h('span', { style: styles.title }, '检测到待加载的 Handoff'),
            h('span', { style: styles.spacer }),
            h('button', {
              style: styles.primary,
              disabled: busy,
              onClick: loadIntoConversation,
              title: '发送「加载」，由模型读取 Handoff 并归档',
            }, '加载'),
            h('button', {
              style: styles.btn,
              disabled: busy,
              onClick: () => post('dismiss'),
              title: '不读取正文，这份 Handoff 不再提示',
            }, '跳过')),
          h('span', { style: styles.meta }, metaText),
          body !== null ? h('div', { style: styles.body }, body) : null,
          body !== null
            ? h('div', { style: styles.footer },
                h('button', {
                  style: styles.btn,
                  disabled: busy,
                  onClick: () => post('archive'),
                  title: '已加载完成，归档到 history/',
                }, '归档并关闭'),
                h('button', { style: styles.btn, onClick: () => setBody(null) }, '收起'))
            : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // hero（新会话）与 active 两个阶段都渲染该槽位，见文件头说明。
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'session-continuity-handoff',
          order: 10,
        }, Banner))
      },
    }
  },
})
