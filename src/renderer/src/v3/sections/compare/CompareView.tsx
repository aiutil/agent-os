// 对比镜头（批量广播）。复刻 V3 静态：每个面板可选类型 CLI/会话/网页，
// 一个 prompt 并行发给所有面板。CLI/会话 面板走真实 chat 会话；网页面板待 Web 镜头接入。

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { CompareScenario, CompareScenarioPane } from '@shared/types'
import { useToolsStore } from '../../../stores/toolsStore'
import { useSessionsStore } from '../../../stores/sessionsStore'
import { useUiStore } from '../../../stores/uiStore'
import { appendUserMessage, applyAgentEvent, managedItems, type ChatItem } from '../../../pages/workbench/chat-model'
import { ToolSelector, type ToolOption } from '../../shared/ToolSelector'
import { PortalMenu } from '../../shared/PortalMenu'
import { BRAND_COLORS } from '../../../lib/toolIcons'
import { useT } from '../../../lib/i18n'

type PaneType = 'cli' | 'chat' | 'webchat'
type PaneStatus = 'idle' | 'thinking' | 'done' | 'error'
interface Pane {
  id: string
  type: PaneType
  toolId: string
  webService: string
  sessionId?: string | null
  lastUrl?: string | null
}
interface PaneHandle {
  send(prompt: string): Promise<PaneSendResult>
}
interface PaneSendResult {
  paneId: string
  ok: boolean
  sessionId?: string | null
  lastUrl?: string | null
}

const PANE_TYPES: PaneType[] = ['cli', 'chat', 'webchat']

const WEB_SERVICES = [
  { key: 'chatgpt', label: 'ChatGPT', color: '#10a37f', sub: 'GPT-4o', url: 'https://chatgpt.com/' },
  { key: 'gemini', label: 'Gemini', color: '#4285f4', sub: 'Gemini 2.0', url: 'https://gemini.google.com/' },
  { key: 'claude', label: 'Claude', color: '#c96442', sub: 'claude', url: 'https://claude.ai/' },
  { key: 'doubao', label: '豆包', color: '#4e6ef2', sub: 'Doubao', url: 'https://www.doubao.com/chat/' },
  { key: 'yuanbao', label: '元宝', color: '#3b6cff', sub: 'Yuanbao', url: 'https://yuanbao.tencent.com/' },
  { key: 'kimi', label: 'Kimi', color: '#10b981', sub: 'moonshot', url: 'https://kimi.moonshot.cn/' },
  { key: 'deepseek', label: 'DeepSeek', color: '#0ea5e9', sub: 'DeepSeek-V3', url: 'https://chat.deepseek.com/' },
  { key: 'grok', label: 'Grok', color: '#1d1d1f', sub: 'Grok-3', url: 'https://x.com/i/grok' }
]

function scenarioTitle(prompt: string, fallback: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  return compact.length > 18 ? `${compact.slice(0, 18)}…` : compact || fallback
}

const IcCompare = (): React.JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="4.5" width="5.5" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <rect x="9" y="2.5" width="5.5" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
  </svg>
)

function itemId(): string {
  return crypto.randomUUID()
}

function ThinkingDots(): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span className="thinking-dot" />
      <span className="thinking-dot" />
      <span className="thinking-dot" />
    </span>
  )
}

// ─── 选择器（PortalMenu，不被裁切） ───────────────────────────────────────────

function PaneTypeSelector({ value, onChange, onOpenChange }: { value: PaneType; onChange(v: PaneType): void; onOpenChange?(o: boolean): void }): React.JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const labelOf = (k: PaneType): string => k === 'cli' ? 'CLI' : k === 'chat' ? t('compare.paneType.chat') : t('compare.paneType.web')
  const toggle = (o: boolean): void => { setOpen(o); onOpenChange?.(o) }
  return (
    <>
      <button ref={ref} className="cp-type-btn" onClick={() => toggle(!open)}>
        {labelOf(value)}
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.5 }}>
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <PortalMenu anchorRef={ref} open={open} onClose={() => toggle(false)} width={130} placement="down" align="left">
        {PANE_TYPES.map((k) => (
          <button
            key={k}
            onClick={() => {
              onChange(k)
              toggle(false)
            }}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderRadius: 6, border: 'none', background: value === k ? 'var(--bg-active)' : 'transparent', cursor: 'pointer', textAlign: 'left', fontSize: 12, color: 'var(--text-primary)', font: 'inherit' }}
          >
            {labelOf(k)}
            {value === k && (
              <svg style={{ marginLeft: 'auto' }} width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2 5l2 2.5 4-4.5" stroke="var(--text-primary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        ))}
      </PortalMenu>
    </>
  )
}

function WebServiceSelector({ value, onChange, onOpenChange }: { value: string; onChange(v: string): void; onOpenChange?(o: boolean): void }): React.JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const svc = WEB_SERVICES.find((s) => s.key === value) ?? WEB_SERVICES[0]
  const toggle = (o: boolean): void => { setOpen(o); onOpenChange?.(o) }
  return (
    <>
      <button
        ref={ref}
        onClick={() => toggle(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', height: 22, borderRadius: 5, background: open ? 'var(--bg-active)' : 'transparent', fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer', border: 'none', font: 'inherit' }}
      >
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: svc.color }} />
        {svc.label}
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" style={{ opacity: 0.5 }}>
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <PortalMenu anchorRef={ref} open={open} onClose={() => toggle(false)} width={190} placement="down" align="left">
        <div style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '4px 9px 3px' }}>{t('compare.webServiceHeader')}</div>
        {WEB_SERVICES.map((s) => (
          <button
            key={s.key}
            onClick={() => {
              onChange(s.key)
              toggle(false)
            }}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '5px 9px', borderRadius: 6, border: 'none', background: value === s.key ? 'var(--bg-active)' : 'transparent', cursor: 'pointer', textAlign: 'left', font: 'inherit' }}
          >
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: s.color }} />
            <span style={{ fontSize: 11.5, color: 'var(--text-primary)', flex: 1 }}>{s.label}</span>
            <span style={{ fontSize: 9.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{s.sub}</span>
          </button>
        ))}
      </PortalMenu>
    </>
  )
}

// ─── 面板 ─────────────────────────────────────────────────────────────────────

const ComparePane = forwardRef<
  PaneHandle,
  {
    pane: Pane
    workspacePath: string
    toolOptions: ToolOption[]
    canClose: boolean
    onClose(): void
    onChangeType(t: PaneType): void
    onChangeTool(toolId: string): void
    onChangeWeb(svc: string): void
    onPaneMeta(patch: Pick<Pane, 'sessionId' | 'lastUrl'>): void
    onStatus(status: PaneStatus): void
  }
>(function ComparePane({ pane, workspacePath, toolOptions, canClose, onClose, onChangeType, onChangeTool, onChangeWeb, onPaneMeta, onStatus }, ref) {
  const { t } = useT()
  const tools = useToolsStore((s) => s.results)
  const [sessionId, setSessionId] = useState<string | null>(pane.sessionId ?? null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [status, setStatus] = useState<PaneStatus>('idle')
  const [restoring, setRestoring] = useState(false)
  const [currentUrl, setCurrentUrl] = useState<string | null>(pane.lastUrl ?? null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const cpBodyRef = useRef<HTMLDivElement>(null)
  const lastBoundsRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const isWeb = pane.type === 'webchat'
  const displayName = tools.find((t) => t.toolId === pane.toolId)?.displayName ?? pane.toolId
  const svc = WEB_SERVICES.find((s) => s.key === pane.webService) ?? WEB_SERVICES[0]
  const siteId = `${pane.id}-wv`

  // 设置/搜索弹窗打开时需隐藏 native WebContentsView（否则会盖住 React modal）。
  const settingsModalOpen = useUiStore((s) => s.settingsModalOpen)
  const searchModalOpen = useUiStore((s) => s.searchModalOpen)
  const overlayOpen = settingsModalOpen || searchModalOpen
  const overlayOpenRef = useRef(overlayOpen)
  overlayOpenRef.current = overlayOpen

  // onStatus 为父级内联箭头（每次渲染新引用），用 ref 持有最新值、仅以 status 为依赖，避免死循环。
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  useEffect(() => onStatusRef.current(status), [status])

  // 切换类型/工具时重置（会话失效）。
  useEffect(() => {
    setSessionId(pane.sessionId ?? null)
    setCurrentUrl(pane.lastUrl ?? null)
    setItems([])
    setStatus('idle')
    // 切换 type/tool/webService 才重建本地分栏态；sessionId/lastUrl 更新不应清空过程。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.type, pane.toolId, pane.webService])

  useEffect(() => {
    if (!sessionId) return
    return window.agentOs.events.onAgentEvent(({ sessionId: sid, event }) => {
      if (sid !== sessionId) return
      setItems((cur) => applyAgentEvent(cur, event, itemId()))
      if (event.kind === 'turn-end' || event.kind === 'error') setStatus('done')
    })
  }, [sessionId])

  // 挂载回放：cli/chat 列、已有 sessionId 时读历史（webchat 走 URL 恢复，见改动三）。
  // 用本地 sessionId 作依赖，与上方 onAgentEvent 订阅同步随会话切换重置。
  useEffect(() => {
    if (isWeb) return
    if (!sessionId) { setItems([]); return }
    let cancelled = false
    setRestoring(true)
    void window.agentOs.chat
      .history(sessionId)
      .then((managed) => {
        if (cancelled) return
        const restored = managedItems(managed)
        // 合并非覆盖：恢复期间若有实时增量（随机 UUID id），按 id 去重保留为尾部，避免丢失。
        setItems((cur) => {
          if (cur.length === 0) return restored
          const seen = new Set(restored.map((i) => i.id))
          return [...restored, ...cur.filter((i) => !seen.has(i.id))]
        })
      })
      .catch(() => {
        /* 历史读取失败不阻断，与 ChatContent 一致 */
      })
      .finally(() => {
        if (!cancelled) setRestoring(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isWeb])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [items, status])

  // 网页面板：打开 WebContentsView（URL 变化时就地重载，不销毁视图）。
  // cleanup 不调用 closeSite——销毁由 bounds effect 负责，避免 URL 切换时新视图丢失定位。
  useEffect(() => {
    if (!isWeb) return
    void window.agentOs.webagg.openSite({ id: siteId, url: pane.lastUrl || svc.url })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWeb, siteId, svc.url])

  useEffect(() => {
    if (!isWeb) return
    return window.agentOs.events.onWebaggSiteStateChanged((event) => {
      if (event.id !== siteId) return
      setCurrentUrl(event.url)
      onPaneMeta({ lastUrl: event.url })
    })
  }, [isWeb, onPaneMeta, siteId])

  useEffect(() => {
    if (!isWeb || !cpBodyRef.current) return
    const el = cpBodyRef.current
    const report = (): void => {
      const r = el.getBoundingClientRect()
      lastBoundsRef.current = { x: r.left, y: r.top, width: r.width, height: r.height }
      void window.agentOs.webagg.updateSiteBounds({
        [siteId]: { ...lastBoundsRef.current, visible: !overlayOpenRef.current }
      })
    }
    // 首次用 rAF 确保 flex 布局已完成，之后由 ResizeObserver 跟踪。
    const rafId = window.requestAnimationFrame(report)
    const ro = new ResizeObserver(() => window.requestAnimationFrame(report))
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      window.cancelAnimationFrame(rafId)
      ro.disconnect()
      window.removeEventListener('resize', report)
      lastBoundsRef.current = null
      void window.agentOs.webagg.updateSiteBounds({
        [siteId]: { x: 0, y: 0, width: 0, height: 0, visible: false }
      })
      // 视图生命周期：面板类型切换或面板删除时才销毁。
      void window.agentOs.webagg.closeSite(siteId)
    }
  }, [isWeb, siteId])

  // 设置/搜索弹窗打开时隐藏 WebContentsView（native 层会盖住 React modal），关闭后恢复定位。
  useEffect(() => {
    if (!isWeb) return
    const b = lastBoundsRef.current
    void window.agentOs.webagg.updateSiteBounds({
      [siteId]: b && !overlayOpen
        ? { ...b, visible: true }
        : { x: 0, y: 0, width: 0, height: 0, visible: false }
    })
  }, [overlayOpen, isWeb, siteId])

  // 任意 header 下拉打开时临时隐藏 WebContentsView（native 层遮住 React portal）。
  const onHeaderDropdown = (open: boolean): void => {
    if (!isWeb) return
    const b = lastBoundsRef.current
    void window.agentOs.webagg.updateSiteBounds({
      [siteId]: b && !open
        ? { ...b, visible: true }
        : { x: 0, y: 0, width: 0, height: 0, visible: false }
    })
  }

  const ensureSession = async (): Promise<string> => {
    if (sessionId) return sessionId
    const { session } = await window.agentOs.session.create({
      name: t('compare.scenario.sessionName', { name: displayName }),
      // SPEC-035：广播模板名是占位，首回合后由真实意图覆盖。
      nameProvisional: true,
      toolId: pane.toolId,
      workspacePath,
      surface: 'chat',
      permissionPreset: 'auto'
    })
    setSessionId(session.id)
    onPaneMeta({ sessionId: session.id })
    return session.id
  }

  useImperativeHandle(ref, () => ({
    send: async (prompt: string): Promise<PaneSendResult> => {
      if (isWeb) {
        setStatus('thinking')
        const ok = await window.agentOs.webagg.injectSite({ id: siteId, text: prompt })
        const state = await window.agentOs.webagg.getSiteState(siteId).catch(() => null)
        const lastUrl = state?.url || currentUrl || pane.lastUrl || svc.url
        setCurrentUrl(lastUrl)
        onPaneMeta({ lastUrl })
        setStatus(ok ? 'done' : 'error')
        return { paneId: pane.id, ok, lastUrl }
      }
      setItems((cur) => appendUserMessage(cur, prompt, itemId()))
      setStatus('thinking')
      try {
        const id = await ensureSession()
        await window.agentOs.chat.sendTurn(id, prompt)
        return { paneId: pane.id, ok: true, sessionId: id }
      } catch (e) {
        setItems((cur) => applyAgentEvent(cur, { kind: 'error', message: String(e), retryable: false }, itemId()))
        setStatus('error')
        return { paneId: pane.id, ok: false, sessionId }
      }
    }
  }), [currentUrl, ensureSession, isWeb, onPaneMeta, pane.id, pane.lastUrl, sessionId, siteId, svc.url])

  const headerLabel = isWeb ? svc.label : displayName

  return (
    <div className="compare-pane">
      <div className="cp-header">
        <PaneTypeSelector value={pane.type} onChange={onChangeType} onOpenChange={onHeaderDropdown} />
        {isWeb ? (
          <WebServiceSelector value={pane.webService} onChange={onChangeWeb} onOpenChange={onHeaderDropdown} />
        ) : (
          <ToolSelector value={pane.toolId} onChange={onChangeTool} tools={toolOptions} placement="down" />
        )}
        <span className="cp-path-mini">{workspacePath || '~'}</span>
        {canClose && (
          <button className="cp-close" onClick={onClose}>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {status === 'thinking' && <span className="cp-status">{t('compare.pane.sending')}</span>}
        {status === 'error' && <span className="cp-status is-error">{t('common.state.failed')}</span>}
      </div>
      <div ref={cpBodyRef} className="cp-body">
        {isWeb ? (
          // WebContentsView 原生覆盖此区域，渲染层只保留空占位。
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 11.5 }}>
            {t('compare.pane.loadingSite', { label: svc.label })}
          </div>
        ) : (
          <div ref={bodyRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, scrollbarWidth: 'thin' }}>
            {restoring ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 11.5, textAlign: 'center', marginTop: 20 }}>{t('compare.pane.loadingHistory')}</div>
            ) : items.length === 0 && status === 'idle' ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 11.5, textAlign: 'center', marginTop: 20 }}>{t('compare.pane.inputHint', { label: headerLabel })}</div>
            ) : null}
            {items.map((m) => {
              if (m.kind === 'message') {
                const isUser = m.role === 'user'
                return (
                  <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)' }}>{isUser ? t('compare.pane.youLabel') : headerLabel}</div>
                    <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', fontFamily: pane.type === 'cli' ? 'var(--font-mono)' : 'inherit' }}>{m.text}</div>
                  </div>
                )
              }
              if (m.kind === 'tool') {
                return (
                  <div key={m.id} style={{ fontSize: 10.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>· {m.toolName}</div>
                )
              }
              return null
            })}
            {status === 'thinking' && (
              <div>
                <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)', marginBottom: 4 }}>{headerLabel}</div>
                <ThinkingDots />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
})

function CompareToolbar({ paneCount, onAdd, onReset }: { paneCount: number; onAdd(): void; onReset(n: number): void }): React.JSX.Element {
  const { t } = useT()
  return (
    <div className="compare-toolbar">
      <div className="ct-badge">
        <IcCompare /> {t('compare.toolbar.badge')}
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{t('compare.toolbar.paneCount', { count: paneCount })}</span>
      <div className="ct-sep" />
      {[2, 3, 4].map((n) => (
        <button key={n} className={`ct-btn ${paneCount === n ? 'is-on' : ''}`} onClick={() => onReset(n)}>
          {n}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button className="ct-btn" onClick={onAdd} disabled={paneCount >= 4}>
        {t('compare.toolbar.addPane')}
      </button>
    </div>
  )
}

function BatchBar({ panes, statuses, onSend }: { panes: Pane[]; statuses: PaneStatus[]; onSend(text: string): void }): React.JSX.Element {
  const { t } = useT()
  const [text, setText] = useState('')
  const anySending = statuses.some((s) => s === 'thinking')
  const submit = (): void => {
    if (!text.trim() || anySending) return
    onSend(text)
    setText('')
  }
  return (
    <div className="batch-bar">
      <div className="batch-inner">
        <div className="batch-badge">{t('compare.batch.badge')}</div>
        <input
          className="batch-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={t('compare.batch.placeholder', { count: panes.length })}
          disabled={anySending}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {panes.map((p, i) => {
            const s = statuses[i] ?? 'idle'
            const c =
              p.type === 'webchat'
                ? WEB_SERVICES.find((x) => x.key === p.webService)?.color ?? 'var(--text-muted)'
                : BRAND_COLORS[p.toolId] ?? 'var(--text-muted)'
            return <div key={p.id} style={{ width: 6, height: 6, borderRadius: '50%', background: s === 'error' ? 'var(--status-danger)' : s === 'done' ? 'var(--status-working)' : c, opacity: s === 'idle' ? 0.35 : 1 }} />
          })}
        </div>
        <button className="batch-send-btn" onClick={submit} disabled={anySending || !text.trim()}>
          {anySending ? t('compare.batch.sending') : t('compare.batch.sendAll')}
        </button>
      </div>
    </div>
  )
}

export function CompareView({
  compareId,
  onScenarioSaved
}: {
  compareId: string
  onScenarioSaved?(scenario: CompareScenario): void
}): React.JSX.Element {
  const { t } = useT()
  const tools = useToolsStore((s) => s.results)
  const runtimes = useToolsStore((s) => s.runtimes)
  const scan = useToolsStore((s) => s.scan)
  const views = useSessionsStore((s) => s.views)
  const recentProjects = useUiStore((s) => s.recentProjects)

  const runtimeByTool = useMemo(() => new Map(runtimes.map((r) => [r.toolId, r])), [runtimes])
  const chatTools = tools.filter(
    (t) => t.toolId !== 'shell' && (t.health === 'ready' || t.health === 'updatable') && runtimeByTool.get(t.toolId)?.capabilities.chat === true
  )
  const toolOptions: ToolOption[] = chatTools.map((t) => ({
    key: t.toolId,
    label: t.displayName,
    sub: t.version ? `v${t.version}` : t.toolId,
    color: BRAND_COLORS[t.toolId] ?? 'var(--text-muted)'
  }))
  const workspacePath = recentProjects[0] ?? views[0]?.workspacePath ?? ''
  const defaultTool = chatTools[0]?.toolId ?? ''

  const [panes, setPanes] = useState<Pane[]>([])
  const [statuses, setStatuses] = useState<Record<string, PaneStatus>>({})
  const [scenarioId, setScenarioId] = useState<string | null>(compareId)
  const [layoutDirty, setLayoutDirty] = useState(false)
  const refs = useRef<Record<string, PaneHandle | null>>({})

  useEffect(() => {
    if (tools.length === 0) void scan()
  }, [tools.length, scan])

  useEffect(() => {
    let cancelled = false
    const defaults = chatTools.slice(0, 2)
    const fallbackType: PaneType = defaultTool ? 'chat' : 'webchat'
    const fallbackPanes = (): Pane[] =>
      [0, 1].map((i) => ({
        id: `${compareId}-p${i}-${Date.now()}`,
        type: fallbackType,
        toolId: defaults[i]?.toolId ?? defaults[0]?.toolId ?? '',
        webService: WEB_SERVICES[i]?.key ?? 'chatgpt',
        sessionId: null,
        lastUrl: null
      }))

    void window.agentOs.compare
      .getScenario(compareId)
      .then((scenario) => {
        if (cancelled) return
        if (scenario) {
          setScenarioId(scenario.id)
          setLayoutDirty(false)
          setPanes(
            scenario.panes.map((pane, i) => ({
              id: pane.id,
              type: pane.type,
              toolId: pane.toolId ?? defaults[i]?.toolId ?? defaults[0]?.toolId ?? '',
              webService: pane.webService ?? 'chatgpt',
              sessionId: pane.sessionId ?? null,
              lastUrl: pane.lastUrl ?? null
            }))
          )
        } else {
          setScenarioId(compareId)
          setLayoutDirty(false)
          setPanes(fallbackPanes())
        }
        setStatuses({})
      })
      .catch(() => {
        if (cancelled) return
        setScenarioId(compareId)
        setLayoutDirty(false)
        setPanes(fallbackPanes())
        setStatuses({})
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareId, defaultTool, chatTools.length])

  const setStatus = useCallback((id: string, s: PaneStatus): void => setStatuses((prev) => ({ ...prev, [id]: s })), [])
  const update = (id: string, patch: Partial<Pane>): void => setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const patchPaneMeta = (id: string, patch: Pick<Pane, 'sessionId' | 'lastUrl'>): void => {
    setPanes((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const resetTo = (n: number): void => {
    const next: Pane[] = Array.from({ length: n }, (_, i) => ({
      id: `r${i}-${Date.now()}`,
      type: defaultTool ? 'chat' : 'webchat',
      toolId: chatTools[i % Math.max(1, chatTools.length)]?.toolId ?? defaultTool,
      webService: WEB_SERVICES[i % WEB_SERVICES.length]?.key ?? 'chatgpt',
      sessionId: null,
      lastUrl: null
    }))
    setPanes(next)
    setStatuses({})
    setLayoutDirty(true)
  }
  const addPane = (): void => {
    if (panes.length >= 4) return
    setPanes((prev) => [...prev, { id: `p-${Date.now()}`, type: defaultTool ? 'chat' : 'webchat', toolId: defaultTool, webService: 'chatgpt', sessionId: null, lastUrl: null }])
    setLayoutDirty(true)
  }
  const removePane = (id: string): void => {
    if (panes.length <= 2) return
    setPanes((prev) => prev.filter((p) => p.id !== id))
    setLayoutDirty(true)
  }
  const saveScenario = async (text: string, snapshot: Pane[], results: PaneSendResult[]): Promise<void> => {
    const resultByPane = new Map(results.map((result) => [result.paneId, result]))
    const nextPanes = snapshot.map((pane): Pane => {
      const result = resultByPane.get(pane.id)
      return {
        ...pane,
        sessionId: result?.sessionId ?? pane.sessionId ?? null,
        lastUrl: result?.lastUrl ?? pane.lastUrl ?? null
      }
    })
    setPanes((current) =>
      current.map((pane) => {
        const next = nextPanes.find((item) => item.id === pane.id)
        return next ? { ...pane, sessionId: next.sessionId, lastUrl: next.lastUrl } : pane
      })
    )

    const scenarioPanes: CompareScenarioPane[] = nextPanes.map((pane) => ({
      id: pane.id,
      type: pane.type,
      toolId: pane.type === 'webchat' ? undefined : pane.toolId,
      webService: pane.type === 'webchat' ? pane.webService : undefined,
      sessionId: pane.type === 'webchat' ? null : pane.sessionId ?? null,
      lastUrl: pane.type === 'webchat' ? pane.lastUrl ?? null : null
    }))
    const saved = await window.agentOs.compare.saveScenario({
      id: layoutDirty ? undefined : scenarioId ?? compareId,
      title: scenarioTitle(text, t('compare.scenario.unnamed')),
      workspacePath,
      prompt: text,
      paneCount: nextPanes.length,
      panes: scenarioPanes
    })
    setScenarioId(saved.id)
    setLayoutDirty(false)
    window.dispatchEvent(new CustomEvent('agent-os.compare-scenarios-changed', { detail: saved }))
    onScenarioSaved?.(saved)
  }
  const sendAll = (text: string): void => {
    const prompt = text.trim()
    const snapshot = panes
    void Promise.all(snapshot.map((p) => refs.current[p.id]?.send(prompt) ?? Promise.resolve({ paneId: p.id, ok: false })))
      .then((results) => saveScenario(prompt, snapshot, results))
      .catch(() => saveScenario(prompt, snapshot, []))
  }

  return (
    <div className="compare-view">
      <CompareToolbar paneCount={panes.length} onAdd={addPane} onReset={resetTo} />
      <div className="compare-panes">
        {panes.map((pane) => (
          <ComparePane
            key={pane.id}
            ref={(h) => {
              refs.current[pane.id] = h
            }}
            pane={pane}
            workspacePath={workspacePath}
            toolOptions={toolOptions}
            canClose={panes.length > 2}
            onClose={() => removePane(pane.id)}
            onChangeType={(t) => update(pane.id, { type: t, sessionId: null, lastUrl: null })}
            onChangeTool={(toolId) => update(pane.id, { toolId, sessionId: null })}
            onChangeWeb={(svc) => update(pane.id, { webService: svc, lastUrl: null })}
            onPaneMeta={(patch) => patchPaneMeta(pane.id, patch)}
            onStatus={(s) => setStatus(pane.id, s)}
          />
        ))}
      </div>
      <BatchBar panes={panes} statuses={panes.map((p) => statuses[p.id] ?? 'idle')} onSend={sendAll} />
    </div>
  )
}
