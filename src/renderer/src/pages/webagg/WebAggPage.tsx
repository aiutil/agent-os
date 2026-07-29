// Web 聚合页（SPEC-011）。多 Web AI 并排 + 广播输入。
// WebContentsView 由 Electron 主进程管理，渲染端仅维护 bounds + 广播输入。

import type { FC } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Refresh } from '@icon-park/react'
import type { ViewBounds, WebAggBroadcastResult, WebProviderView } from '@shared/types'
import { IpIcon } from '../../lib/toolIcons'
import { useT } from '@renderer/lib/i18n'
import './webagg.css'

type IpIconFC = FC<{ theme: string; size: number; strokeWidth: number; fill?: string[] }>

const HEADER_HEIGHT = 28 // px

export function WebAggPage(): React.JSX.Element {
  const { t } = useT()
  const [providers, setProviders] = useState<WebProviderView[]>([])
  const [activeIds, setActiveIds] = useState<string[]>([])
  const [broadcastText, setBroadcastText] = useState('')
  const [broadcastResults, setBroadcastResults] = useState<WebAggBroadcastResult[]>([])
  const [broadcasting, setBroadcasting] = useState(false)
  const viewsRef = useRef<HTMLDivElement | null>(null)
  // Ref 保存最新值，供 unmount 清理用（避免闭包捕获旧值）
  const activeIdsRef = useRef<string[]>([])
  activeIdsRef.current = activeIds

  // 组件卸载时向主进程发送 visible:false，从 contentView 移除所有 WebContentsView
  useEffect(() => {
    return () => {
      const ids = activeIdsRef.current
      if (ids.length === 0) return
      const hidden: Record<string, ViewBounds> = {}
      for (const id of ids) {
        hidden[id] = { x: 0, y: 0, width: 0, height: 0, visible: false }
      }
      void window.agentOs.webagg.updateBounds(hidden)
    }
  }, [])

  // 加载 providers
  useEffect(() => {
    void window.agentOs.webagg.listProviders().then(setProviders)
  }, [])

  // 登录状态实时更新
  useEffect(() => {
    const off = window.agentOs.events.onWebaggLoginStateChanged(({ providerId, state }) => {
      setProviders((prev) =>
        prev.map((p) => (p.id === providerId ? { ...p, loginState: state } : p))
      )
    })
    return off
  }, [])

  // 激活/切换 provider
  const toggleProvider = async (id: string): Promise<void> => {
    const next = activeIds.includes(id) ? activeIds.filter((x) => x !== id) : [...activeIds, id]
    setActiveIds(next)
    await window.agentOs.webagg.setActive(next)
  }

  // 上报 bounds（让主进程知道在哪里显示 WebContentsView）
  const reportBounds = useCallback(() => {
    if (!viewsRef.current || activeIds.length === 0) return
    const container = viewsRef.current
    const rect = container.getBoundingClientRect()
    const colWidth = rect.width / activeIds.length
    const bounds: Record<string, ViewBounds> = {}

    for (let i = 0; i < activeIds.length; i++) {
      const id = activeIds[i]
      bounds[id] = {
        x: Math.round(rect.left + i * colWidth),
        y: Math.round(rect.top + HEADER_HEIGHT),
        width: Math.round(colWidth),
        height: Math.round(rect.height - HEADER_HEIGHT),
        visible: true
      }
    }

    // 隐藏非活跃 providers
    for (const p of providers) {
      if (!activeIds.includes(p.id)) {
        bounds[p.id] = { x: 0, y: 0, width: 0, height: 0, visible: false }
      }
    }

    void window.agentOs.webagg.updateBounds(bounds)
  }, [activeIds, providers])

  useEffect(() => {
    reportBounds()
    const observer = new ResizeObserver(reportBounds)
    if (viewsRef.current) observer.observe(viewsRef.current)
    return () => observer.disconnect()
  }, [reportBounds])

  // 广播
  const handleBroadcast = async (): Promise<void> => {
    if (!broadcastText.trim() || activeIds.length === 0) return
    setBroadcasting(true)
    try {
      const results = await window.agentOs.webagg.broadcast(broadcastText.trim())
      setBroadcastResults(results)
      setBroadcastText('')
    } finally {
      setBroadcasting(false)
    }
  }

  const activeProviders = providers.filter((p) => activeIds.includes(p.id))
  const failedIds = new Set(broadcastResults.filter((r) => !r.ok).map((r) => r.providerId))

  return (
    <div className="webagg-page">
      {/* 配置栏 */}
      <div className="webagg-toolbar">
        <span className="webagg-toolbar__title">{t('web.toolbar.selectPrompt')}</span>
        <div className="webagg-provider-chips">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={activeIds.includes(p.id)}
              className={`webagg-provider-chip${activeIds.includes(p.id) ? ' is-active' : ''}`}
              onClick={() => void toggleProvider(p.id)}
            >
              <span
                className={`webagg-provider-chip__dot${
                  p.loginState === 'logged-in'
                    ? ' is-logged-in'
                    : p.loginState === 'logged-out'
                      ? ' is-logged-out'
                      : ''
                }`}
              />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* View 区域 */}
      {activeProviders.length > 0 ? (
        <div className="webagg-views" ref={viewsRef}>
          {activeProviders.map((p) => (
            <div key={p.id} className="webagg-column">
              <div className="webagg-col-header">
                <span>{p.name}</span>
                {p.loginState === 'logged-out' && (
                  <span style={{ color: 'var(--status-waiting)', fontSize: 'var(--text-xs)' }}>
                    {t('web.login.notLoggedIn')}
                  </span>
                )}
                {failedIds.has(p.id) && (
                  <span className="webagg-col-header__warn" role="status">{t('web.inject.failedHint')}</span>
                )}
                <button
                  type="button"
                  className="webagg-col-header__reload"
                  aria-label={t('web.action.reload')}
                  title={t('web.action.reload')}
                  onClick={() => void window.agentOs.webagg.reload(p.id)}
                >
                  <IpIcon icon={Refresh as IpIconFC} size={13} />
                </button>
              </div>
              {/* 占位 — WebContentsView 会覆盖此区域 */}
              <div className="webagg-col-body" />
            </div>
          ))}
        </div>
      ) : (
        <div className="webagg-empty">
          <div className="webagg-empty__title">{t('web.empty.title')}</div>
          <p>{t('web.empty.hint')}</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {t('web.empty.cookieHint')}
          </p>
        </div>
      )}

      {/* 广播输入 */}
      <div className="webagg-broadcast">
        <input
          type="text"
          className="webagg-broadcast__input"
          aria-label={t('web.broadcast.ariaLabel')}
          name="webagg-broadcast"
          autoComplete="off"
          placeholder={t('web.broadcast.placeholder')}
          value={broadcastText}
          onChange={(e) => setBroadcastText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void handleBroadcast()
            }
          }}
          disabled={activeProviders.length === 0 || broadcasting}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!broadcastText.trim() || activeProviders.length === 0 || broadcasting}
          onClick={() => void handleBroadcast()}
        >
          {broadcasting ? t('web.broadcast.buttonDoing') : t('web.broadcast.button')}
        </button>
        {broadcastResults.length > 0 && (
          <span
            className={`webagg-broadcast__hint${failedIds.size > 0 ? ' is-failed' : ''}`}
            role="status"
            aria-live="polite"
          >
            {t('web.broadcast.successCount', {
              ok: broadcastResults.filter((r) => r.ok).length,
              total: broadcastResults.length,
              count: broadcastResults.length
            })}
            {failedIds.size > 0 ? t('web.inject.failedColumns', { count: failedIds.size }) : ''}
          </span>
        )}
      </div>
    </div>
  )
}
