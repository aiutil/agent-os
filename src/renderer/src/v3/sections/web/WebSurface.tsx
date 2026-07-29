// Web 镜头内容：原生 WebContentsView（非 iframe）承载任意站点。
// 渲染端只负责工具栏 + 上报内容区 bounds，真正的页面由主进程 WebContentsView 绘制。

import { useEffect, useRef, useState } from 'react'
import type { WebBookmark, WebSiteState } from '@shared/types'
import { useT } from '@renderer/lib/i18n'

export function WebSurface({ siteId, hidden }: { siteId: string; hidden: boolean }): React.JSX.Element {
  const { t } = useT()
  const containerRef = useRef<HTMLDivElement>(null)
  const [bookmark, setBookmark] = useState<WebBookmark | null>(null)
  const [state, setState] = useState<WebSiteState | null>(null)

  // 解析书签 → 打开站点视图。
  useEffect(() => {
    let cancelled = false
    void window.agentOs.webagg.listBookmarks().then((list) => {
      if (cancelled) return
      const bm = list.find((b) => b.id === siteId) ?? list[0] ?? null
      setBookmark(bm)
      if (bm) void window.agentOs.webagg.openSite({ id: bm.id, url: bm.url })
    })
    return () => {
      cancelled = true
    }
  }, [siteId])

  // 订阅站点状态（loading/loaded/failed + 导航能力）。
  useEffect(() => {
    return window.agentOs.events.onWebaggSiteStateChanged((s) => {
      if (s.id === siteId) setState(s)
    })
  }, [siteId])

  // 上报 bounds（容器位置/尺寸 → 主进程定位原生视图）；hidden 时隐藏。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      void window.agentOs.webagg.updateSiteBounds({
        [siteId]: { x: r.left, y: r.top, width: r.width, height: r.height, visible: !hidden }
      })
    }
    report()
    const ro = new ResizeObserver(() => window.requestAnimationFrame(report))
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
      void window.agentOs.webagg.updateSiteBounds({
        [siteId]: { x: 0, y: 0, width: 0, height: 0, visible: false }
      })
    }
  }, [siteId, hidden])

  const act = (action: 'back' | 'forward' | 'reload'): void => {
    void window.agentOs.webagg.siteAction({ id: siteId, action })
  }
  const url = state?.url ?? bookmark?.url ?? ''
  const failed = state?.status === 'failed'

  const navBtn = (
    onClick: () => void,
    disabled: boolean,
    path: string,
    title: string
  ): React.JSX.Element => (
    <button className="web-nav-btn" onClick={onClick} disabled={disabled} title={title}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d={path} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )

  return (
    <div className="web-view">
      <div className="web-toolbar">
        {navBtn(() => act('back'), !state?.canGoBack, 'M8 2L4 6l4 4', t('web.surface.navBack'))}
        {navBtn(() => act('forward'), !state?.canGoForward, 'M4 2l4 4-4 4', t('web.surface.navForward'))}
        {navBtn(() => act('reload'), false, 'M10.5 6a4.5 4.5 0 1 1-1.3-3.2M10.5 2.5v3h-3', t('common.action.refresh'))}
        <div className="web-url-bar">
          {bookmark && <div style={{ width: 7, height: 7, borderRadius: '50%', background: bookmark.color, flexShrink: 0 }} />}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
          {state?.status === 'loading' && (
            <div style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--border-medium)', borderTopColor: 'var(--text-muted)', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
          )}
        </div>
        <button className="web-nav-btn" title={t('web.surface.openExternal')} onClick={() => url && window.agentOs.app.openExternal(url)}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {/* 原生视图绘制区：容器留空，主进程把 WebContentsView 叠加到此 bounds 上。 */}
      <div ref={containerRef} style={{ flex: 1, position: 'relative', background: 'var(--bg-surface)' }}>
        {failed && (
          <div className="web-placeholder" style={{ position: 'absolute', inset: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{bookmark?.name ?? t('web.surface.loadFailed')}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 280, lineHeight: 1.55 }}>
              {state?.failReason
                ? t('web.surface.failMessageWithReason', { reason: state.failReason })
                : t('web.surface.failMessage')}
            </div>
            <button
              onClick={() => url && window.agentOs.app.openExternal(url)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 20px', borderRadius: 9, background: 'var(--text-primary)', color: 'var(--bg-surface)', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              {t('web.surface.openExternal')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
