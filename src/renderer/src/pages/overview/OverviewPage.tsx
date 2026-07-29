// 总览页（SPEC-012）。纯聚合，零新后端 IPC。
// 运行中会话订阅 terminalStateChanged，其余 30s 轮询。

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DataPlaneHealth,
  DiscoveryResult,
  RuntimeHostStatus,
  StatsActivity,
  WorkbenchSessionView
} from '@shared/types'
import { localeFor } from '@shared/i18n'
import { useUiStore } from '../../stores/uiStore'
import { useSessionsStore } from '../../stores/sessionsStore'
import { useT } from '../../lib/i18n'
import { healthColor } from '../../lib/status'
import './overview.css'
import { navigateToPage, openWorkspaceTab } from '../../workspace-tabs/navigation'
import { sessionDisplayTitle } from '../../lib/sessionTitle'

const POLL_MS = 30_000

type CardState<T> = { loading: boolean; error: boolean; data: T | null }

function useCardData<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = []
): [CardState<T>, () => void] {
  const [state, setState] = useState<CardState<T>>({ loading: true, error: false, data: null })

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: false }))
    try {
      const data = await fetcher()
      setState({ loading: false, error: false, data })
    } catch {
      setState({ loading: false, error: true, data: null })
    }
  }, deps)

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  return [state, load]
}

// ── 运行中会话卡 ─────────────────────────────────────────────────────────────

function SessionsCard(): React.JSX.Element {
  const { t } = useT()
  const views = useSessionsStore((s) => s.views)
  const refresh = useSessionsStore((s) => s.refresh)

  const running = (views ?? []).filter(
    (v: WorkbenchSessionView) => v.status === 'running' || v.status === 'starting'
  )

  useEffect(() => {
    const off = window.agentOs.events.onTerminalStateChanged(() => void refresh())
    return off
  }, [refresh])

  const goToSession = (v: WorkbenchSessionView): void => {
    openWorkspaceTab({
      kind: 'session',
      resourceId: v.id,
      title: sessionDisplayTitle(v),
      toolId: v.toolId
    })
  }

  return (
    <div className="ov-card">
      <div className="ov-card__header">
        <span className="ov-card__title">{t('stats.overview.sessions.title')}</span>
        <button type="button" className="ov-card__action" onClick={() => navigateToPage('workbench')}>
          {t('stats.overview.sessions.viewAll')}
        </button>
      </div>
      <div className="ov-card__body">
        {running.length === 0 ? (
          <div className="ov-sessions-empty">{t('stats.overview.sessions.empty')}</div>
        ) : (
          <div className="ov-sessions">
            {running.map((v: WorkbenchSessionView) => (
              <div key={v.id} className="ov-session-row" onClick={() => goToSession(v)}>
                <span
                  className={`ov-session-dot ov-session-dot--${v.status === 'running' ? 'running' : 'starting'}`}
                />
                <span className="ov-session-name">{sessionDisplayTitle(v)}</span>
                <span className="ov-session-tool">{v.toolId}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 今日活跃迷你点阵 ─────────────────────────────────────────────────────────

function ActivityCard(): React.JSX.Element {
  const { t } = useT()
  const [state, reload] = useCardData<StatsActivity>(
    () => window.agentOs.stats.activity({ range: '30d' }),
    []
  )

  if (state.error) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.activity.title')}</span></div>
        <div className="ov-card__body">
          <div className="ov-card__error">
            {t('stats.overview.loadFailed')} <button type="button" onClick={reload}>{t('common.action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }

  if (state.loading || !state.data) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.activity.title')}</span></div>
        <div className="ov-card__body"><div className="ov-card__skeleton" /></div>
      </div>
    )
  }

  const { days, activeDays, currentStreak, totalPrompts } = state.data
  const maxPrompts = Math.max(...days.map((d) => d.prompts), 1)

  function dayClass(prompts: number): string {
    if (prompts === 0) return 'ov-activity-day'
    const pct = prompts / maxPrompts
    if (pct < 0.33) return 'ov-activity-day ov-activity-day--low'
    if (pct < 0.66) return 'ov-activity-day ov-activity-day--mid'
    return 'ov-activity-day ov-activity-day--high'
  }

  return (
    <div className="ov-card">
      <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.activity.title')}</span></div>
      <div className="ov-card__body">
        <div className="ov-activity-grid">
          {days.map((d) => (
            <div key={d.date} className={dayClass(d.prompts)} title={t('stats.overview.activity.cellTitle', { date: d.date, count: d.prompts })} />
          ))}
        </div>
        <div className="ov-activity-meta" style={{ marginTop: 'var(--space-3)' }}>
          <span>{t('stats.overview.activity.activePrefix')} <strong>{activeDays}</strong> {t('stats.overview.activity.dayUnit')}</span>
          <span>{t('stats.overview.activity.streakPrefix')} <strong>{currentStreak}</strong> {t('stats.overview.activity.dayUnit')}</span>
          <span>{t('stats.overview.activity.totalPrefix')} <strong>{totalPrompts}</strong> {t('stats.overview.activity.countUnit')}</span>
        </div>
      </div>
    </div>
  )
}

// ── 工具健康列表 ──────────────────────────────────────────────────────────────

function ToolsCard(): React.JSX.Element {
  const { t } = useT()
  const openSettingsModal = useUiStore((s) => s.openSettingsModal)
  const [state, reload] = useCardData<DiscoveryResult[]>(
    () => window.agentOs.discovery.scan(),
    []
  )

  if (state.error) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.tools.title')}</span></div>
        <div className="ov-card__body">
          <div className="ov-card__error">
            {t('stats.overview.loadFailed')} <button type="button" onClick={reload}>{t('common.action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }

  if (state.loading || !state.data) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.tools.title')}</span></div>
        <div className="ov-card__body"><div className="ov-card__skeleton" /></div>
      </div>
    )
  }

  return (
    <div className="ov-card">
      <div className="ov-card__header">
        <span className="ov-card__title">{t('stats.overview.tools.title')}</span>
        <button type="button" className="ov-card__action" onClick={openSettingsModal}>
          {t('stats.overview.tools.openSettings')}
        </button>
      </div>
      <div className="ov-card__body">
        <div className="ov-tools">
          {state.data.map((tool) => (
            <div key={tool.toolId} className="ov-tool-row">
              <span className="ov-tool-dot" style={{ background: healthColor(tool.health) }} />
              <span className="ov-tool-name">{tool.displayName}</span>
              {tool.version && <span className="ov-tool-version">v{tool.version}</span>}
              {tool.health === 'updatable' && (
                <span className="ov-tool-update">{t('stats.overview.tools.updatable')}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── 数据面健康 ───────────────────────────────────────────────────────────────

function DataHealthCard(): React.JSX.Element {
  const { t } = useT()
  const [state, reload] = useCardData<DataPlaneHealth[]>(
    () => window.agentOs.diagnostics.dataPlaneHealth(),
    []
  )

  if (state.error) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.dataHealth.title')}</span></div>
        <div className="ov-card__body">
          <div className="ov-card__error">
            {t('stats.overview.loadFailed')} <button type="button" onClick={reload}>{t('common.action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }

  if (state.loading || !state.data) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.dataHealth.title')}</span></div>
        <div className="ov-card__body"><div className="ov-card__skeleton" /></div>
      </div>
    )
  }

  const statusLabel = (s: DataPlaneHealth['status']): string => {
    if (s === 'ok') return t('stats.overview.dataHealth.statusOk')
    if (s === 'partial') return t('stats.overview.dataHealth.statusPartial')
    if (s === 'drifted') return t('stats.overview.dataHealth.statusDrifted')
    return t('stats.overview.dataHealth.statusUnknown')
  }

  return (
    <div className="ov-card">
      <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.dataHealth.title')}</span></div>
      <div className="ov-card__body">
        <div className="ov-health">
          {state.data.map((h) => (
            <div key={h.toolId} className="ov-health-row">
              <span className={`ov-health-status ov-health-status--${h.status}`}>
                {statusLabel(h.status)}
              </span>
              <span className="ov-health-tool">{h.toolId}</span>
              {h.cliVersion && (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  v{h.cliVersion}
                </span>
              )}
            </div>
          ))}
          {state.data.length === 0 && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {t('stats.overview.dataHealth.notChecked')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Daemon 状态卡 ─────────────────────────────────────────────────────────────

function DaemonCard(): React.JSX.Element {
  const { t } = useT()
  const [state, reload] = useCardData<RuntimeHostStatus>(
    () => window.agentOs.runtime.hostStatus(),
    []
  )

  if (state.error) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.runtime.title')}</span></div>
        <div className="ov-card__body">
          <div className="ov-card__error">
            {t('stats.overview.loadFailed')} <button type="button" onClick={reload}>{t('common.action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }

  if (state.loading || !state.data) {
    return (
      <div className="ov-card">
        <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.runtime.title')}</span></div>
        <div className="ov-card__body"><div className="ov-card__skeleton" /></div>
      </div>
    )
  }

  const d = state.data
  const connBadge = (c: RuntimeHostStatus['connection']): string => {
    if (c === 'connected') return 'connected'
    if (c === 'degraded') return 'degraded'
    return 'other'
  }
  const connLabel = (c: RuntimeHostStatus['connection']): string => {
    const map: Record<string, string> = {
      connected: t('stats.overview.runtime.connConnected'),
      handshaking: t('stats.overview.runtime.connHandshaking'),
      spawning: t('stats.overview.runtime.connSpawning'),
      degraded: t('stats.overview.runtime.connDegraded')
    }
    return map[c] ?? c
  }

  return (
    <div className="ov-card">
      <div className="ov-card__header"><span className="ov-card__title">{t('stats.overview.runtime.title')}</span></div>
      <div className="ov-card__body">
        <div className="ov-daemon">
          <div className="ov-daemon-row">
            <span className="ov-daemon-label">{t('stats.overview.runtime.modeLabel')}</span>
            <span className="ov-daemon-value">{d.mode === 'daemon' ? t('stats.overview.runtime.modeDaemon') : t('stats.overview.runtime.modeInProcess')}</span>
          </div>
          <div className="ov-daemon-row">
            <span className="ov-daemon-label">{t('stats.overview.runtime.connectionLabel')}</span>
            <span className={`ov-daemon-badge ov-daemon-badge--${connBadge(d.connection)}`}>
              {connLabel(d.connection)}
            </span>
          </div>
          <div className="ov-daemon-row">
            <span className="ov-daemon-label">{t('stats.overview.runtime.sessionCount')}</span>
            <span className="ov-daemon-value">{d.sessionCount}</span>
          </div>
          {d.pid && (
            <div className="ov-daemon-row">
              <span className="ov-daemon-label">PID</span>
              <span className="ov-daemon-value">{d.pid}</span>
            </div>
          )}
          {d.fallbackReason && (
            <div className="ov-daemon-row">
              <span className="ov-daemon-label">{t('stats.overview.runtime.fallbackReason')}</span>
              <span className="ov-daemon-value" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                {d.fallbackReason}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 主页 ─────────────────────────────────────────────────────────────────────

export function OverviewPage(): React.JSX.Element {
  const { t, lang } = useT()
  const tsRef = useRef(new Date().toLocaleTimeString(localeFor(lang)))
  // 每 30s 刷新时间戳（各卡片自己轮询数据，此处仅显示上次刷新时间）
  const [ts, setTs] = useState(tsRef.current)
  useEffect(() => {
    const timer = setInterval(() => setTs(new Date().toLocaleTimeString(localeFor(lang))), POLL_MS)
    return () => clearInterval(timer)
  }, [lang])

  return (
    <div className="overview-page">
      <div className="overview-header">
        <h1 className="overview-header__title">{t('stats.overview.title')}</h1>
        <p className="overview-header__ts">{t('stats.overview.refreshTs', { ts })}</p>
      </div>
      <div className="overview-grid">
        <SessionsCard />
        <ActivityCard />
        <ToolsCard />
        <DataHealthCard />
        <DaemonCard />
      </div>
    </div>
  )
}
