// 对比工作台（SPEC-009）。多 CLI 同任务 worktree 隔离齐发，采纳最优列合并回主分支。

import { useEffect, useState } from 'react'
import type { CompareAdoptResult, CompareColumnView, CompareRunView, DiscoveryResult } from '@shared/types'
import { TerminalPane } from '../../components/TerminalPane'
import { WebAggPage } from '../webagg/WebAggPage'
import { useCompareStore } from './CompareStore'
import { useSessionsStore } from '../../stores/sessionsStore'
import {
  closeWorkspaceTabView,
  openWorkspaceTab
} from '../../workspace-tabs/navigation'
import { workspaceTabId } from '@shared/workspace-tabs'
import { ConfirmDialog } from '../../lib/ui'
import { useT } from '../../lib/i18n'
import './compare.css'

// ─── Column header ────────────────────────────────────────────────────────

function ColHeader({
  col,
  runStatus,
  onAdopt,
  adoptDisabled
}: {
  col: CompareColumnView
  runStatus: CompareRunView['status']
  onAdopt(): void
  adoptDisabled: boolean
}): React.JSX.Element {
  const { t } = useT()
  const dotClass =
    col.status === 'running' || col.status === 'starting'
      ? 'is-running'
      : col.status === 'failed'
        ? 'is-failed'
        : col.status === 'completed' || col.status === 'waiting_input' || col.status === 'disconnected'
          ? 'is-done'
          : ''

  const elapsedLabel = col.elapsedMs != null
    ? `${(col.elapsedMs / 1000).toFixed(1)}s`
    : col.endedAt
      ? `${((new Date(col.endedAt).getTime() - new Date(col.startedAt).getTime()) / 1000).toFixed(1)}s`
      : ''

  return (
    <div className="compare-col-header">
      <span className={`compare-col-header__dot ${dotClass}`} />
      <span className="compare-col-header__name">{col.toolId}</span>
      {elapsedLabel && (
        <span className="compare-col-header__elapsed">{elapsedLabel}</span>
      )}
      {(runStatus === 'running' || runStatus === 'reviewing') && (
        <button
          type="button"
          className="compare-col-header__adopt"
          disabled={adoptDisabled}
          onClick={onAdopt}
        >
          {t('compare.page.adoptColumn')}
        </button>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────

export function ComparePage(): React.JSX.Element {
  const { t } = useT()
  const runs = useCompareStore((s) => s.runs)
  const activeRunId = useCompareStore((s) => s.activeRunId)
  const loading = useCompareStore((s) => s.loading)
  const error = useCompareStore((s) => s.error)
  const refresh = useCompareStore((s) => s.refresh)
  const start = useCompareStore((s) => s.start)
  const adopt = useCompareStore((s) => s.adopt)
  const discard = useCompareStore((s) => s.discard)
  const clearError = useCompareStore((s) => s.clearError)
  const refreshSessions = useSessionsStore((s) => s.refresh)

  const [surface, setSurface] = useState<'cli' | 'web'>('cli')
  const [tools, setTools] = useState<DiscoveryResult[]>([])
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [adoptTarget, setAdoptTarget] = useState<{ runId: string; toolId: string } | null>(null)
  const [adoptResult, setAdoptResult] = useState<CompareAdoptResult | null>(null)

  useEffect(() => {
    void refresh()
    void window.agentOs.discovery.scan().then((results) => {
      const available = results.filter((r) => r.health !== 'missing')
      setTools(available)
      if (available.length >= 2) {
        setSelectedToolIds(available.slice(0, 2).map((t) => t.toolId))
      }
    })
  }, [refresh])

  const activeRun = runs.find((r) => r.id === activeRunId) ?? null

  const openRun = (run: CompareRunView): void => {
    openWorkspaceTab({
      kind: 'compare',
      resourceId: run.id,
      title: run.prompt || t('compare.page.runTabTitle', { id: run.id })
    })
  }

  const toggleTool = (toolId: string): void => {
    setSelectedToolIds((prev) =>
      prev.includes(toolId)
        ? prev.filter((id) => id !== toolId)
        : prev.length < 4
          ? [...prev, toolId]
          : prev
    )
  }

  const handleStart = async (): Promise<void> => {
    if (!prompt.trim() || selectedToolIds.length < 2 || !workspacePath.trim()) return
    await start(workspacePath.trim(), prompt.trim(), selectedToolIds)
    const created = useCompareStore.getState().runs.find(
      (run) => run.id === useCompareStore.getState().activeRunId
    )
    if (created) openRun(created)
    void refreshSessions()
    setPrompt('')
  }

  const handleAdoptConfirm = async (): Promise<void> => {
    if (!adoptTarget) return
    const result = await adopt(adoptTarget.runId, adoptTarget.toolId)
    setAdoptResult(result)
    if (result.merged) {
      setAdoptTarget(null)
      void refreshSessions()
    }
  }

  const canStart =
    prompt.trim().length > 0 &&
    workspacePath.trim().length > 0 &&
    selectedToolIds.length >= 2 &&
    !loading

  return (
    <main className="compare-page">
      {/* CLI 对比 / Web 对比 子镜头切换（点 10） */}
      <div
        className="compare-surface-tabs"
        role="tablist"
        aria-label={t('compare.page.surfaceAria')}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault()
            setSurface((prev) => (prev === 'cli' ? 'web' : 'cli'))
          }
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'cli'}
          tabIndex={surface === 'cli' ? 0 : -1}
          className={`compare-surface-tab ${surface === 'cli' ? 'is-active' : ''}`}
          onClick={() => setSurface('cli')}
        >
          {t('compare.page.cliSurface')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'web'}
          tabIndex={surface === 'web' ? 0 : -1}
          className={`compare-surface-tab ${surface === 'web' ? 'is-active' : ''}`}
          onClick={() => setSurface('web')}
        >
          {t('compare.page.webSurface')}
        </button>
      </div>

      {surface === 'web' ? (
        <WebAggPage />
      ) : (
        <>
      {/* 配置栏 */}
      <div className="compare-setup">
        <div className="compare-setup__row">
          <input
            className="compare-setup__prompt"
            type="text"
            name="compare-prompt"
            autoComplete="off"
            placeholder={t('compare.page.promptPlaceholder')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canStart) void handleStart()
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canStart}
            onClick={() => void handleStart()}
          >
            {loading ? t('compare.page.starting') : t('compare.page.launch')}
          </button>
        </div>

        <div className="compare-setup__row">
          <div className="compare-setup__path">
            <label className="compare-setup__path-label" htmlFor="compare-workspace-path">{t('compare.page.workdir')}</label>
            <input
              id="compare-workspace-path"
              className="compare-setup__path-input"
              type="text"
              name="compare-workspace-path"
              autoComplete="off"
              spellCheck={false}
              placeholder="/path/to/git/repo"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
            />
          </div>

          <div className="compare-setup__tools">
            <span className="compare-setup__tool-label">{t('compare.page.cliLabel')}</span>
            {tools.map((tool) => (
              <button
                key={tool.toolId}
                type="button"
                aria-pressed={selectedToolIds.includes(tool.toolId)}
                className={`compare-tool-chip${selectedToolIds.includes(tool.toolId) ? ' is-selected' : ''}`}
                onClick={() => toggleTool(tool.toolId)}
              >
                {tool.displayName}
              </button>
            ))}
            {selectedToolIds.length < 2 && (
              <span className="compare-setup__limit-hint">{t('compare.page.selectHint')}</span>
            )}
          </div>
        </div>
      </div>

      {/* 错误横幅 */}
      {error && (
        <div className="compare-error-banner" role="alert">
          <span>{error}</span>
          <button type="button" onClick={clearError}>{t('common.action.close')}</button>
        </div>
      )}

      {/* 历史运行选项条 */}
      {runs.length > 0 && (
        <div className="compare-runs">
          <span className="compare-runs__label">{t('compare.page.history')}</span>
          {runs.slice(0, 10).map((run) => (
            <button
              key={run.id}
              type="button"
              aria-pressed={activeRun?.id === run.id}
              className={`compare-run-chip${(activeRun?.id === run.id) ? ' is-active' : ''}`}
              onClick={() => openRun(run)}
            >
              {run.id} · {run.status}
            </button>
          ))}
          {activeRun && (
            <button
              type="button"
              className="btn"
              style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)' }}
              onClick={() => {
                const id = activeRun.id
                void discard(id).then(() => closeWorkspaceTabView(workspaceTabId('compare', id)))
              }}
              disabled={loading || activeRun.status === 'discarded'}
            >
              {t('compare.page.cleanupRun')}
            </button>
          )}
        </div>
      )}

      {/* 列区域或空态 */}
      {activeRun ? (
        <>
          {adoptResult && !adoptResult.merged && (
            <div className="compare-conflict-banner" role="status" aria-live="polite">
              {t('compare.page.conflictBanner', { conflict: adoptResult.conflict ?? '' })}
              <br />
              {t('compare.page.conflictHint')}
              <button
                type="button"
                style={{ marginLeft: 8, textDecoration: 'underline', background: 'none' }}
                onClick={() => setAdoptResult(null)}
              >
                {t('common.action.close')}
              </button>
            </div>
          )}
          <div className="compare-columns">
            {activeRun.columns.map((col) => (
              <div key={col.toolId} className="compare-column">
                <ColHeader
                  col={col}
                  runStatus={activeRun.status}
                  adoptDisabled={loading || activeRun.status === 'adopted' || activeRun.status === 'discarded'}
                  onAdopt={() => setAdoptTarget({ runId: activeRun.id, toolId: col.toolId })}
                />
                {col.sessionId ? (
                  <TerminalSessionByWorkbenchId sessionId={col.sessionId} />
                ) : (
                  <div className="compare-empty" style={{ flex: 1 }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('compare.page.waitingStart')}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="compare-empty">
          <div className="compare-empty__title">{t('compare.page.emptyTitle')}</div>
          <p>{t('compare.page.emptyHint')}</p>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {t('compare.page.emptySub')}
          </p>
        </div>
      )}

      {/* 采纳确认对话框（复用 lib/ui/ConfirmDialog：焦点契约/ESC/aria/loading 锁定） */}
      <ConfirmDialog
        open={adoptTarget !== null}
        danger
        title={t('compare.page.adoptDialogTitle')}
        confirmText={t('compare.page.adoptConfirm')}
        loading={loading}
        message={
          adoptTarget ? (
            <>
              {t('compare.page.adoptMessagePrefix')}<strong>{adoptTarget.toolId}</strong>{t('compare.page.adoptMessageSuffix')}
              <br />
              {t('compare.page.adoptWorkdir')}<code>{activeRun?.workspacePath}</code>
            </>
          ) : (
            ''
          )
        }
        onConfirm={() => void handleAdoptConfirm()}
        onCancel={() => setAdoptTarget(null)}
      />
        </>
      )}
    </main>
  )
}

/** 通过 workbench session id 渲染终端（需找到其 terminalSessionId）。 */
function TerminalSessionByWorkbenchId({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useT()
  const views = useSessionsStore((s) => s.views)
  const view = views.find((v) => v.id === sessionId)

  if (!view?.terminalSessionId) {
    return (
      <div className="compare-empty" style={{ flex: 1 }}>
        <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
          {t('compare.page.terminalInit')}
        </span>
      </div>
    )
  }
  return <TerminalPane sessionId={view.terminalSessionId} />
}
