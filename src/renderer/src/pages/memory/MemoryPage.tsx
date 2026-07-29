import { useEffect, useMemo, useRef, useState } from 'react'
import { getDataPlaneDegradationNotice } from '@shared/data-plane-notice'
import type {
  CuratorCandidate,
  DurableMemory,
  ExperienceEntry,
  MemoryGatewayCapability,
  MemoryIndexStatus,
  MemorySearchHit,
  RelayTarget,
  MemorySettings
} from '@shared/types'
import { useSessionsStore } from '../../stores/sessionsStore'
import { useMemoryViewStore } from '../../stores/memoryViewStore'
import { useNotificationStore, type NotificationTone } from '../../stores/notificationStore'
import {
  closeWorkspaceTabView,
  navigateToPage,
  openWorkspaceTab
} from '../../workspace-tabs/navigation'
import { workspaceTabId } from '@shared/workspace-tabs'
import { CloseIcon, ConfirmDialog, IconButton, useDialogFocus, useScrollLock } from '../../lib/ui'
import { ToolSelector, type ToolOption } from '../../v3/shared/ToolSelector'
import { ModelPicker } from '../../v3/shared/ModelPicker'
import { useT } from '../../lib/i18n'
import { tr } from '@shared/i18n'
import { toolDisplayName } from '@shared/tool-display'
import { sessionDisplayTitle } from '../../lib/sessionTitle'
import './memory.css'

type MemoryTab = 'sessions' | 'experience' | 'candidates' | 'policy'
type DatePreset = 'all' | 'today' | '7days' | '30days'
type CustomDateRange = { from: string; to: string; label: string }

function dateRangeOf(preset: DatePreset): { from?: string } | undefined {
  if (preset === 'all') return undefined
  const date = new Date()
  if (preset === 'today') date.setHours(0, 0, 0, 0)
  else date.setDate(date.getDate() - (preset === '7days' ? 7 : 30))
  return { from: date.toISOString() }
}

function relativeTime(iso: string): string {
  const timestamp = new Date(iso).getTime()
  if (!Number.isFinite(timestamp)) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return tr('memory.time.justNow')
  if (minutes < 60) return tr('memory.time.minutesAgoShort', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return tr('memory.time.hoursAgo', { count: hours })
  return tr('memory.time.daysAgoShort', { count: Math.floor(hours / 24) })
}

function toolLabel(toolId: string): string {
  return toolDisplayName(toolId)
}

export function MemoryPage(): React.JSX.Element {
  const { t } = useT()
  const createSession = useSessionsStore((state) => state.create)
  const relaySession = useSessionsStore((state) => state.relay)
  const transcript = useMemoryViewStore((state) => state.transcript)
  const selectedSessionId = useMemoryViewStore((state) => state.selectedSessionId)
  const transcriptLoading = useMemoryViewStore((state) => state.loading)
  const transcriptError = useMemoryViewStore((state) => state.error)
  const closeMemoryView = useMemoryViewStore((state) => state.close)
  const [tab, setTab] = useState<MemoryTab>('sessions')
  const [query, setQuery] = useState('')
  const [toolId, setToolId] = useState('all')
  const [workspacePath, setWorkspacePath] = useState('all')
  const [datePreset, setDatePreset] = useState<DatePreset>('all')
  const [customDateRange, setCustomDateRange] = useState<CustomDateRange | null>(null)
  const [hits, setHits] = useState<MemorySearchHit[]>([])
  const [indexStatus, setIndexStatus] = useState<MemoryIndexStatus | null>(null)
  const [experiences, setExperiences] = useState<ExperienceEntry[]>([])
  const [durableMemories, setDurableMemories] = useState<DurableMemory[]>([])
  const [candidates, setCandidates] = useState<DurableMemory[]>([])
  const [memorySettings, setMemorySettings] = useState<MemorySettings | null>(null)
  const [curatorCandidates, setCuratorCandidates] = useState<CuratorCandidate[]>([])
  const [gatewayCapabilities, setGatewayCapabilities] = useState<MemoryGatewayCapability[]>([])
  const [degraded, setDegraded] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [relayTargets, setRelayTargets] = useState<RelayTarget[]>([])
  const [showRelayTargets, setShowRelayTargets] = useState(false)
  const [relayLoading, setRelayLoading] = useState(false)
  const [curating, setCurating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const showNotification = useNotificationStore((s) => s.show)
  const notify = (message: string, tone: NotificationTone = 'info'): void => {
    showNotification({ message, tone })
  }

  const workspaces = useMemo(
    () =>
      Array.from(
        new Set([
          ...hits.map((hit) => hit.cwd).filter((cwd): cwd is string => Boolean(cwd)),
          ...(workspacePath === 'all' ? [] : [workspacePath])
        ])
      ).sort(),
    [hits, workspacePath]
  )

  const refreshExperiences = async (): Promise<void> => {
    setExperiences(await window.agentOs.experience.list())
  }
  const refreshVault = async (): Promise<void> => {
    const [active, pending, settings, capabilities, curators] = await Promise.all([
      window.agentOs.memory.listDurable({ statuses: ['active'] }),
      window.agentOs.memory.listDurable({ statuses: ['candidate'] }),
      window.agentOs.memory.settings(),
      window.agentOs.memory.gatewayCapabilities(),
      window.agentOs.memory.curatorCandidates()
    ])
    setDurableMemories(active)
    setCandidates(pending)
    setMemorySettings(settings)
    setGatewayCapabilities(capabilities)
    setCuratorCandidates(curators)
  }

  useEffect(() => {
    void window.agentOs.diagnostics.dataPlaneHealth().then((items) => {
      setDegraded(getDataPlaneDegradationNotice(items))
    })
    void window.agentOs.memory
      .indexStatus()
      .then(setIndexStatus)
      .catch((error) =>
        notify(t('memory.notice.indexStatusFailed', { message: String((error as Error).message ?? error) }), 'error')
      )
    void refreshExperiences().catch((error) =>
      notify(t('memory.notice.experienceFailed', { message: String((error as Error).message ?? error) }), 'error')
    )
    void refreshVault().catch((error) =>
      notify(t('memory.notice.vaultFailed', { message: String((error as Error).message ?? error) }), 'error')
    )

    // 从 Stats 热力图跳转过来时，读取 hash 中的日期并设置精确日期范围过滤
    const hash = window.location.hash
    const match = hash.match(/#memory-date=(\d{4}-\d{2}-\d{2})/)
    if (match?.[1]) {
      const date = match[1]
      const from = new Date(`${date}T00:00:00`).toISOString()
      const to = new Date(`${date}T23:59:59.999`).toISOString()
      setTab('sessions')
      setCustomDateRange({ from, to, label: date })
      history.replaceState(null, '', window.location.pathname)
    }

    return window.agentOs.events.onMemoryIndexProgress((status) => {
      setIndexStatus(status)
    })
  }, [])

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setLoading(true)
      const effectiveDateRange = customDateRange ?? dateRangeOf(datePreset)
      void window.agentOs.memory
        .search({
          query,
          ...(toolId === 'all' ? {} : { toolIds: [toolId] }),
          ...(workspacePath === 'all' ? {} : { workspacePath }),
          ...(effectiveDateRange ? { dateRange: effectiveDateRange } : {}),
          limit: 100
        })
        .then(setHits)
        .catch((error) => notify(t('memory.notice.searchFailed', { message: String((error as Error).message ?? error) }), 'error'))
        .finally(() => setLoading(false))
    }, 150)
    return () => window.clearTimeout(handle)
  }, [query, toolId, workspacePath, datePreset, customDateRange, indexStatus?.filesIndexed])

  const closeTranscript = (): void => {
    if (selectedSessionId) {
      closeWorkspaceTabView(workspaceTabId('memory', selectedSessionId))
    } else {
      closeMemoryView()
    }
  }

  const detailRef = useRef<HTMLElement>(null)
  const detailOpen = Boolean(selectedSessionId)
  // 详情面板焦点契约：打开聚焦关闭按钮、Tab 循环、ESC 关闭、关闭恢复焦点；锁定背景滚动。
  useDialogFocus(detailRef, detailOpen, { onEscape: closeTranscript })
  useScrollLock(detailOpen)

  const openNewSession = async (): Promise<void> => {
    if (!transcript?.cwd) {
      notify(t('memory.notice.noCwd'), 'warning')
      return
    }
    setCreating(true)
    try {
      const created = await createSession({
        name: transcript.title,
        toolId: transcript.toolId,
        workspacePath: transcript.cwd
      })
      if (created) {
        openWorkspaceTab({
          kind: 'session',
          resourceId: created.id,
          title: sessionDisplayTitle(created),
          toolId: created.toolId
        })
      }
    } catch (error) {
      notify(t('memory.notice.createSessionFailed', { message: String((error as Error).message ?? error) }), 'error')
    } finally {
      setCreating(false)
    }
  }

  const toggleRelayTargets = async (): Promise<void> => {
    if (!selectedSessionId) return
    if (showRelayTargets) {
      setShowRelayTargets(false)
      return
    }
    setRelayLoading(true)
    try {
      setRelayTargets(await window.agentOs.relay.listTargets(selectedSessionId))
      setShowRelayTargets(true)
    } catch (error) {
      notify(`读取接力目标失败：${String((error as Error).message ?? error)}`, 'error')
    } finally {
      setRelayLoading(false)
    }
  }

  const startHistoryRelay = async (target: RelayTarget): Promise<void> => {
    if (!selectedSessionId) return
    if (target.availability !== 'available') {
      notify(`${target.displayName} 暂不可接力：${target.reason ?? '请先检查 CLI 状态'}`, 'warning')
      await window.agentOs.relay.openRepair(target.toolId).catch(() => undefined)
      return
    }
    setShowRelayTargets(false)
    const created = await relaySession(
      {
        sourceSessionId: selectedSessionId,
        sourceSurface: 'history',
        targetToolId: target.toolId
      },
      target.displayName
    )
    if (!created) return
    openWorkspaceTab({
      kind: 'session',
      resourceId: created.id,
      title: sessionDisplayTitle(created),
      toolId: created.toolId
    })
  }

  const createExperience = async (): Promise<void> => {
    if (!transcript || !selectedSessionId) return
    setCreating(true)
    try {
      const conclusion =
        [...transcript.messages]
          .reverse()
          .find((message) => message.role === 'assistant')?.text ?? transcript.title
      await window.agentOs.experience.create({
        title: transcript.title,
        contentMd: conclusion,
        sourceSessionId: selectedSessionId,
        toolId: transcript.toolId,
        tags: [toolLabel(transcript.toolId)]
      })
      await refreshExperiences()
      await refreshVault()
      setTab('experience')
      closeTranscript()
      navigateToPage('memory')
      notify(t('memory.notice.curatedToExperience'), 'success')
    } catch (error) {
      notify(t('memory.notice.curateFailed', { message: String((error as Error).message ?? error) }), 'error')
    } finally {
      setCreating(false)
    }
  }

  const removeExperience = async (id: string): Promise<void> => {
    await window.agentOs.experience.remove(id)
    await refreshExperiences()
    await refreshVault()
  }

  const curateTranscript = async (): Promise<void> => {
    if (!transcript || !selectedSessionId) return
    if (!transcript.cwd) {
      notify(t('memory.notice.curateNoCwd'), 'warning')
      return
    }
    const text = transcript.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => `## ${message.role}\n${message.text}`)
      .join('\n\n')
    const hasExternalContext = transcript.messages.some((message) =>
      /web|browser|mcp|fetch|http/iu.test(`${message.toolName ?? ''} ${message.raw?.kind ?? ''}`)
    )
    if (!text.trim()) {
      notify(t('memory.notice.curateNoText'), 'warning')
      return
    }
    setCurating(true)
    try {
      const candidates = await window.agentOs.memory.curate({
        sourceId: selectedSessionId,
        cwd: transcript.cwd,
        text,
        hasExternalContext
      })
      await refreshVault()
      setTab('candidates')
      closeTranscript()
      notify(candidates.length > 0 ? t('memory.notice.curated', { count: candidates.length }) : t('memory.notice.curateEmpty'), 'success')
    } catch (error) {
      notify(t('memory.notice.curateRunFailed', { message: String((error as Error).message ?? error) }), 'error')
    } finally {
      setCurating(false)
    }
  }

  const confirmCandidate = async (id: string): Promise<void> => {
    await window.agentOs.memory.confirm(id)
    await refreshVault()
    notify(t('memory.notice.confirmed'), 'success')
  }

  const rejectCandidate = async (id: string): Promise<void> => {
    await window.agentOs.memory.reject(id)
    await refreshVault()
    notify(t('memory.notice.rejected'), 'info')
  }

  const toggleMemorySetting = async (key: 'enabled' | 'useMemories' | 'generateMemories' | 'allowExternalContext'): Promise<void> => {
    if (!memorySettings) return
    const next = await window.agentOs.memory.updateSettings({ [key]: !memorySettings[key] })
    setMemorySettings(next)
  }

  const saveMemorySetting = async (patch: Partial<MemorySettings>): Promise<void> => {
    const next = await window.agentOs.memory.updateSettings(patch)
    setMemorySettings(next)
  }

  return (
    <main className="app-main memory-page">
      {degraded.length > 0 && (
        <div className="memory-data-plane-notice" role="status">
          <strong>{t('memory.dataPlane.degradedTitle')}</strong>
          <span>{degraded.join('；')}</span>
        </div>
      )}
      {(indexStatus?.failedFiles.length ?? 0) > 0 && (
        <div className="memory-data-plane-notice" role="status">
          <strong>{t('memory.dataPlane.failedFiles', { count: indexStatus?.failedFiles.length ?? 0 })}</strong>
          <span>{t('memory.dataPlane.failedFilesHint')}</span>
        </div>
      )}

      <header className="memory-topbar">
        <div className="memory-tabs">
          <button
            type="button"
            className={`memory-tab ${tab === 'sessions' ? 'is-active' : ''}`}
            aria-pressed={tab === 'sessions'}
            onClick={() => setTab('sessions')}
          >
            {t('memory.tab.sessions')}
          </button>
          <button
            type="button"
            className={`memory-tab ${tab === 'experience' ? 'is-active' : ''}`}
            aria-pressed={tab === 'experience'}
            onClick={() => setTab('experience')}
          >
            {t('memory.tab.experience')}
          </button>
          <button
            type="button"
            className={`memory-tab ${tab === 'candidates' ? 'is-active' : ''}`}
            aria-pressed={tab === 'candidates'}
            onClick={() => setTab('candidates')}
          >
            {t('memory.tab.candidates')}{candidates.length > 0 ? ` (${candidates.length})` : ''}
          </button>
          <button
            type="button"
            className={`memory-tab ${tab === 'policy' ? 'is-active' : ''}`}
            aria-pressed={tab === 'policy'}
            onClick={() => setTab('policy')}
          >
            {t('memory.tab.policy')}
          </button>
        </div>
        {indexStatus?.building && (
          <span className="memory-index-progress" role="status" aria-live="polite">
            {t('memory.index.building', { indexed: indexStatus.filesIndexed, total: indexStatus.filesTotal })}
          </span>
        )}
      </header>

      {tab === 'sessions' ? (
        <>
          <div className="memory-search-row">
            <label className="memory-search-box">
              <span aria-hidden="true">⌕</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t('memory.search.aria')}
                name="memory-query"
                autoComplete="off"
                spellCheck={false}
                placeholder={t('memory.search.placeholder')}
              />
            </label>
            <select
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
              aria-label={t('memory.filter.workspaceAria')}
            >
              <option value="all">{t('memory.filter.allWorkspaces')}</option>
              {workspaces.map((workspace) => (
                <option key={workspace} value={workspace}>
                  {workspace}
                </option>
              ))}
            </select>
            {customDateRange ? (
              <button
                type="button"
                className="memory-date-chip"
                onClick={() => setCustomDateRange(null)}
                title={t('memory.filter.clearDateAria')}
              >
                {customDateRange.label} ×
              </button>
            ) : (
              <select
                value={datePreset}
                onChange={(event) => setDatePreset(event.target.value as DatePreset)}
                aria-label={t('memory.filter.dateAria')}
              >
                <option value="all">{t('memory.filter.dateAll')}</option>
                <option value="today">{t('memory.filter.dateToday')}</option>
                <option value="7days">{t('memory.filter.date7d')}</option>
                <option value="30days">{t('memory.filter.date30d')}</option>
              </select>
            )}
            <span className="memory-result-count">{loading ? t('memory.search.searching') : t('memory.search.resultCount', { count: hits.length })}</span>
          </div>

          <div className="memory-tool-filters">
            {['all', 'claude', 'codex', 'gemini', 'opencode'].map((id) => (
              <button
                key={id}
                type="button"
                className={toolId === id ? 'is-active' : ''}
                aria-pressed={toolId === id}
                onClick={() => setToolId(id)}
              >
                {id === 'all' ? t('common.label.all') : toolLabel(id)}
              </button>
            ))}
          </div>

          <div className="memory-content">
            <div className="memory-list">
              {hits.length === 0 && !loading ? (
                <div className="memory-empty">
                  <strong>
                    {indexStatus?.building
                      ? t('memory.empty.buildingTitle')
                      : indexStatus?.filesTotal === 0
                        ? t('memory.empty.noHistoryTitle')
                        : t('memory.empty.noMatchTitle')}
                  </strong>
                  <span>
                    {indexStatus?.building
                      ? t('memory.empty.buildingHint')
                      : indexStatus?.filesTotal === 0
                        ? t('memory.empty.noHistoryHint')
                        : t('memory.empty.noMatchHint')}
                  </span>
                </div>
              ) : (
                hits.map((hit) => (
                  <button
                    key={hit.sessionId}
                    type="button"
                    className={`memory-card ${
                      selectedSessionId === hit.sessionId ? 'is-selected' : ''
                    }`}
                    onClick={() =>
                      openWorkspaceTab({
                        kind: 'memory',
                        resourceId: hit.sessionId,
                        title: hit.title,
                        toolId: hit.toolId
                      })
                    }
                  >
                    <span className={`memory-tool-icon is-${hit.toolId}`}>
                      {toolLabel(hit.toolId).slice(0, 1)}
                    </span>
                    <span className="memory-card-body">
                      <span className="memory-card-tool">{toolLabel(hit.toolId)}</span>
                      <strong>{hit.title}</strong>
                      <span
                        className="memory-card-snippet"
                        dangerouslySetInnerHTML={{ __html: hit.snippetHtml }}
                      />
                      <span className="memory-card-meta">
                        <span className="mono">{hit.cwd ?? t('memory.hit.unknownCwd')}</span>
                        <span>{t('memory.hit.messageCount', { count: hit.messageCount })}</span>
                      </span>
                    </span>
                    <span className="memory-card-time">{relativeTime(hit.lastActivityAt)}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* 右侧滑出详情面板（覆盖式，不挤压列表） */}
          {selectedSessionId && (
            <div
              className="memory-detail-backdrop"
              role="presentation"
              onClick={closeTranscript}
            >
              <aside
                ref={detailRef}
                className="memory-detail-panel"
                role="dialog"
                aria-modal="true"
                aria-label={t('memory.detail.aria')}
                onClick={(e) => e.stopPropagation()}
              >
                <header className="memory-detail-panel-header">
                  <div className="memory-detail-panel-agent">
                    <span className={`memory-tool-icon is-${transcript?.toolId ?? 'unknown'}`}>
                      {transcript ? toolLabel(transcript.toolId).slice(0, 1) : 'M'}
                    </span>
                    <div>
                      <strong>{transcript?.title ?? t('memory.detail.defaultTitle')}</strong>
                      <span className="memory-detail-panel-tool-name">
                        {transcript ? toolLabel(transcript.toolId) : t('memory.detail.defaultTool')}
                      </span>
                    </div>
                  </div>
                  <IconButton label={t('memory.detail.closeAria')} onClick={closeTranscript}>
                    <CloseIcon />
                  </IconButton>
                </header>

                <div className="memory-detail-panel-meta">
                  {transcript?.cwd && (
                    <span className="memory-detail-panel-path" title={transcript.cwd}>
                      {transcript.cwd}
                    </span>
                  )}
                </div>

                <div className="memory-detail-panel-body">
                  {transcriptLoading && (
                    <div className="memory-detail-state">{t('memory.detail.loadingTranscript')}</div>
                  )}
                  {transcriptError && (
                    <div className="memory-detail-state is-error">
                      <strong>{t('memory.detail.errorTitle')}</strong>
                      <span>{transcriptError}</span>
                    </div>
                  )}
                  {transcript?.messages.map((message) => (
                    <article
                      key={`${message.seq}-${message.ts ?? ''}`}
                      className={`memory-detail-msg is-${message.role}`}
                    >
                      <span className="memory-detail-msg-role">
                        {message.role === 'user'
                          ? t('memory.detail.roleUser')
                          : message.role === 'assistant'
                            ? toolLabel(transcript.toolId)
                            : message.toolName ?? message.role}
                      </span>
                      <div className="memory-detail-msg-text">{message.text}</div>
                    </article>
                  ))}
                </div>

                <footer className="memory-detail-panel-footer">
                  {transcript && (
                    <>
	                      <button
	                        type="button"
	                        className="memory-detail-panel-btn is-primary"
                        disabled={creating}
                        onClick={() => void openNewSession()}
                      >
	                        {creating ? t('memory.detail.creating') : t('memory.detail.openNew')}
	                      </button>
                      <button
                        type="button"
                        className="memory-detail-panel-btn is-secondary"
                        disabled={relayLoading}
                        onClick={() => void toggleRelayTargets()}
                      >
                        {relayLoading ? '读取接力目标…' : '接力给...'}
                      </button>
                      {showRelayTargets && (
                        <div className="memory-relay-targets">
                          {relayTargets.map((target) => (
                            <button
                              key={target.toolId}
                              type="button"
                              className={target.availability !== 'available' ? 'is-disabled' : ''}
                              onClick={() => void startHistoryRelay(target)}
                            >
                              <span>{target.displayName}</span>
                              <span>{target.availability === 'available' ? '可用' : target.reason ?? '不可用'}</span>
                            </button>
                          ))}
                        </div>
                      )}
	                      <button
                        type="button"
                        className="memory-detail-panel-btn is-secondary"
                        disabled={creating}
                        onClick={() => void createExperience()}
                      >
                        {creating ? t('memory.detail.curatingExp') : t('memory.detail.curateExp')}
                      </button>
                      <button
                        type="button"
                        className="memory-detail-panel-btn is-secondary"
                        disabled={creating || curating}
                        onClick={() => void curateTranscript()}
                      >
                        {curating ? t('memory.detail.curating') : t('memory.detail.curateCandidate')}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="memory-detail-panel-btn is-ghost"
                    onClick={closeTranscript}
                  >
                    {t('common.action.close')}
                  </button>
                </footer>
              </aside>
            </div>
          )}
        </>
      ) : tab === 'experience' ? (
        <section className="experience-section">
          <header>
            <strong>{t('memory.experience.title')}</strong>
            <span>{t('memory.experience.subtitle', { count: durableMemories.length })}</span>
          </header>
          <div className="experience-list">
            {experiences.length === 0 ? (
              <div className="memory-empty">
                <strong>{t('memory.experience.emptyTitle')}</strong>
                <span>{t('memory.experience.emptyHint')}</span>
              </div>
            ) : (
              experiences.map((entry) => (
                <article key={entry.id} className="experience-card">
                  <span className={`memory-tool-icon is-${entry.toolId ?? 'unknown'}`}>
                    {toolLabel(entry.toolId ?? 'E').slice(0, 1)}
                  </span>
                  <div>
                    <strong>{entry.title}</strong>
                    <pre>{entry.contentMd}</pre>
                    <span>
                      {entry.toolId ? t('memory.experience.fromTool', { tool: toolLabel(entry.toolId) }) : t('memory.experience.confirmed')}
                      {' · '}
                      {relativeTime(entry.updatedAt)}
                      {entry.tags.length > 0 ? ` · ${entry.tags.join(' / ')}` : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(entry.id)}
                    aria-label={t('memory.experience.deleteAria', { title: entry.title })}
                  >
                    {t('common.action.delete')}
                  </button>
                </article>
              ))
            )}
          </div>
        </section>
      ) : tab === 'candidates' ? (
        <section className="experience-section">
          <header>
            <strong>{t('memory.candidates.title')}</strong>
            <span>{t('memory.candidates.subtitle')}</span>
          </header>
          <div className="experience-list">
            {candidates.length === 0 ? (
              <div className="memory-empty">
                <strong>{t('memory.candidates.emptyTitle')}</strong>
                <span>{t('memory.candidates.emptyHint')}</span>
              </div>
            ) : (
              candidates.map((memory) => (
                <article key={memory.id} className="experience-card memory-candidate-card">
                  <span className="memory-tool-icon">M</span>
                  <div>
                    <strong>{memory.title}</strong>
                    <pre>{memory.content}</pre>
                    <span>
                      {memory.kind} · {memory.scope}
                      {memory.scopeRef ? ` · ${memory.scopeRef}` : ''}
                      {memory.evidence.length > 0
                        ? ` · ${memory.evidence.map((item) => `${item.sourceType}:${item.sourceId}`).join(' / ')}`
                        : ''}
                    </span>
                  </div>
                  <div className="memory-candidate-actions">
                    <button type="button" onClick={() => void confirmCandidate(memory.id)}>{t('common.action.confirm')}</button>
                    <button type="button" onClick={() => void rejectCandidate(memory.id)}>{t('memory.candidates.reject')}</button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      ) : (
        <section className="experience-section memory-policy-section">
          <header>
            <strong>{t('memory.policy.title')}</strong>
            <span>{t('memory.policy.subtitle')}</span>
          </header>
          <div className="memory-policy-list">
            {([
              ['enabled', t('memory.policy.setting.enabledTitle'), t('memory.policy.setting.enabledDesc')],
              ['useMemories', t('memory.policy.setting.useMemoriesTitle'), t('memory.policy.setting.useMemoriesDesc')],
              ['generateMemories', t('memory.policy.setting.generateMemoriesTitle'), t('memory.policy.setting.generateMemoriesDesc')],
              ['allowExternalContext', t('memory.policy.setting.allowExternalTitle'), t('memory.policy.setting.allowExternalDesc')]
            ] as const).map(([key, title, description]) => (
              <label key={key} className="memory-policy-row">
                <span><strong>{title}</strong><small>{description}</small></span>
                <input
                  type="checkbox"
                  checked={memorySettings?.[key] ?? false}
                  disabled={!memorySettings}
                  onChange={() => void toggleMemorySetting(key)}
                />
              </label>
            ))}
          </div>
          <div className="memory-policy-fields">
            <label className="memory-policy-curator">
              <span>{t('memory.policy.curator')}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <ToolSelector
                  value={memorySettings?.curatorAgentId ?? ''}
                  onChange={(toolId) => void saveMemorySetting({ curatorAgentId: toolId || undefined, curatorModel: undefined })}
                  tools={curatorCandidates.map((c): ToolOption => ({
                    key: c.toolId,
                    label: c.displayName,
                    sub: c.version ? `v${c.version}` : c.ready ? c.toolId : t('common.state.notInstalled'),
                    color: 'var(--text-muted)'
                  }))}
                  placement="up"
                />
                <ModelPicker
                  toolId={memorySettings?.curatorAgentId ?? ''}
                  value={memorySettings?.curatorModel ?? ''}
                  onChange={(model) => void saveMemorySetting({ curatorModel: model || undefined })}
                  placement="up"
                />
              </div>
              {curatorCandidates.length === 0 && (
                <small style={{ color: 'var(--status-error)' }}>{t('memory.policy.noCurator')}</small>
              )}
            </label>
            <label>
              <span>{t('memory.policy.tokenBudget')}</span>
              <input
                type="number"
                min="200"
                max="8000"
                value={memorySettings?.contextTokenBudget ?? 1200}
                onChange={(event) => setMemorySettings((current) => current ? { ...current, contextTokenBudget: Number(event.target.value) || 1200 } : current)}
                onBlur={(event) => void saveMemorySetting({ contextTokenBudget: Number(event.target.value) || 1200 })}
              />
            </label>
          </div>
          <div className="memory-gateway-list">
            <strong>{t('memory.policy.gatewayTitle')}</strong>
            {gatewayCapabilities.map((capability) => (
              <div key={`${capability.agentId}-${capability.transport}`}>
                <span>{capability.agentId}</span>
                <span>{capability.transport.toUpperCase()}</span>
                <small>{capability.detail}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={t('memory.experience.deleteTitle')}
        message={t('memory.experience.deleteMessage')}
        confirmText={t('common.action.delete')}
        onConfirm={() => {
          if (pendingDelete) void removeExperience(pendingDelete)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </main>
  )
}
