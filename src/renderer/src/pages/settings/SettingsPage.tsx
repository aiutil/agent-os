import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  DataPlaneHealth,
  DiscoveryResult,
  LifecycleJob,
  MirrorSettings,
  ProviderConfigView,
  RuntimeHostStatus
} from '@shared/types'
import { useToolsStore } from '../../stores/toolsStore'
import { useSessionsStore } from '../../stores/sessionsStore'
import { useUiStore } from '../../stores/uiStore'
import { ToolIcon } from '../../lib/toolIcons'
import { CloseIcon, ConfirmDialog, IconButton, useDialogFocus, useScrollLock } from '../../lib/ui'
import { useT } from '../../lib/i18n'
import { openWorkspaceTab } from '../../workspace-tabs/navigation'
import agentOsLogo from '../../assets/agentos-logo.png'
import { sessionDisplayTitle } from '../../lib/sessionTitle'
import './settings.css'

type SettingsTab = 'general' | 'cli' | 'provider' | 'diagnostics' | 'appearance' | 'updates' | 'about'

function ProviderCard({ tool }: { tool: DiscoveryResult }): React.JSX.Element {
  const { t } = useT()
  const [view, setView] = useState<ProviderConfigView | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    void window.agentOs.provider.get(tool.toolId).then((config) => {
      setView(config)
      setBaseUrl(config.baseUrl ?? '')
      setModel(config.model ?? '')
    })
  }, [tool.toolId])

  const save = async (clearKey = false): Promise<void> => {
    setSaving(true)
    setSaved(false)
    setSaveError(null)
    try {
      const next = await window.agentOs.provider.set({
        toolId: tool.toolId,
        ...(clearKey ? { apiKey: '' } : apiKey.trim() ? { apiKey } : {}),
        baseUrl,
        model
      })
      setView(next)
      setApiKey('')
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <article className="settings-provider-card">
      <header className="settings-provider-card__header">
        <div>
          <h2>{tool.displayName}</h2>
          <p>
            {view?.hasApiKey ? t('settings.provider.hasKeyLocal') : t('settings.provider.noKey')}
            {view?.injectedEnvNames.length
              ? t('settings.provider.injectedEnv', { names: view.injectedEnvNames.join(' / ') })
              : t('settings.provider.noInject')}
          </p>
        </div>
        <span className={`settings-provider-state ${view?.hasApiKey ? 'is-ready' : ''}`}>
          {view?.hasApiKey ? t('settings.provider.configured') : t('settings.provider.notConfigured')}
        </span>
      </header>
      <div className="settings-form-grid">
        <label className="settings-field settings-field--wide">
          <span>API Key</span>
          <input
            type="password"
            autoComplete="off"
            name={`apikey-${tool.toolId}`}
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={view?.hasApiKey ? t('settings.provider.apiKeySavedPlaceholder') : t('settings.provider.apiKeyPlaceholder')}
          />
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={t('settings.provider.optionalPlaceholder')}
          />
        </label>
        <label className="settings-field">
          <span>{t('settings.provider.defaultModel')}</span>
          <input
            value={model}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setModel(event.target.value)}
            placeholder={t('settings.provider.modelPlaceholder')}
          />
        </label>
      </div>
      <footer className="settings-provider-card__actions">
        {saved && (
          <span className="settings-saved" role="status" aria-live="polite">
            {t('settings.cli.saved')}
          </span>
        )}
        {saveError && (
          <span className="settings-provider-error" role="alert">
            {t('settings.provider.saveFailed', { error: saveError })}
          </span>
        )}
        {view?.hasApiKey && (
          <button type="button" className="settings-button" onClick={() => setConfirmClear(true)}>
            {t('settings.provider.clearKey')}
          </button>
        )}
        <button
          type="button"
          className="settings-button settings-button--primary"
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? t('common.state.saving') : t('settings.provider.saveConfig')}
        </button>
      </footer>

      <ConfirmDialog
        open={confirmClear}
        danger
        title={t('settings.provider.clearTitle')}
        message={<>{t('settings.provider.clearMessage')}</>}
        confirmText={t('settings.provider.clearConfirm')}
        loading={saving}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void save(true)
          setConfirmClear(false)
        }}
      />
    </article>
  )
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useT()
  const [tab, setTab] = useState<SettingsTab>('general')
  const NAV_TABS: { key: SettingsTab; label: string }[] = [
    { key: 'general',     label: t('settings.nav.general') },
    { key: 'cli',         label: t('settings.nav.cli') },
    { key: 'provider',    label: t('settings.nav.provider') },
    { key: 'diagnostics', label: t('settings.nav.diagnostics') },
    { key: 'appearance',  label: t('settings.nav.appearance') },
    { key: 'updates',     label: t('settings.nav.updates') },
    { key: 'about',       label: t('settings.nav.about') }
  ]
  const statusLabel = (s: DataPlaneHealth['status']): string =>
    s === 'ok' ? t('settings.diag.status.ok')
      : s === 'partial' ? t('settings.diag.status.partial')
        : s === 'drifted' ? t('settings.diag.status.driftedPage')
          : t('settings.diag.status.untested')
  const diagnosisLabel = (cat: string): string =>
    cat === 'network' ? t('settings.diag.diagnosis.network')
      : cat === 'permission' ? t('settings.diag.diagnosis.permission')
        : cat === 'path' ? t('settings.diag.diagnosis.path')
          : cat === 'runtime' ? t('settings.diag.diagnosis.runtime')
            : t('settings.diag.diagnosis.unknown')
  const themeMode = useUiStore((s) => s.themePreference)
  const setThemeMode = useUiStore((s) => s.setThemePreference)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateMsg, setUpdateMsg] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const platform = useUiStore((s) => s.platform)
  const closeSettingsModal = useUiStore((s) => s.closeSettingsModal)
  const dialogRef = useRef<HTMLElement>(null)
  // 焦点契约：打开聚焦首个可聚焦元素、Tab 循环、ESC 关闭、关闭恢复触发元素焦点；锁定背景滚动。
  useDialogFocus(dialogRef, true, { onEscape: closeSettingsModal })
  useScrollLock(true)
  const [health, setHealth] = useState<DataPlaneHealth[]>([])
  const [healthLoading, setHealthLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [gamificationEnabled, setGamificationEnabled] = useState(true)
  const [jobs, setJobs] = useState<Record<string, LifecycleJob>>({})
  const [mirror, setMirror] = useState<MirrorSettings>({})
  const [mirrorSaved, setMirrorSaved] = useState(false)
  const [mirrorSaving, setMirrorSaving] = useState(false)
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeHostStatus | null>(null)
  const [restartingDaemon, setRestartingDaemon] = useState(false)
  const { results, scanning, scan, replace } = useToolsStore()
  const createSession = useSessionsStore((state) => state.create)

  const activeJobs = useMemo(
    () => new Map(Object.values(jobs).map((job) => [job.toolId, job])),
    [jobs]
  )

  const refreshHealth = (): void => {
    setHealthLoading(true)
    setLoadError(null)
    void window.agentOs.diagnostics
      .dataPlaneHealth()
      .then(setHealth)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setHealthLoading(false))
  }

  useEffect(() => {
    if (results.length === 0) void scan()
    void window.agentOs.settings.getMirror().then(setMirror)
    void window.agentOs.stats.getGamificationEnabled().then(setGamificationEnabled)
    void window.agentOs.runtime.checkUpdate().then((info) => setAppVersion(info.currentVersion))
    const offJob = window.agentOs.events.onToolJobProgress((job) => {
      setJobs((current) => ({ ...current, [job.toolId]: job }))
    })
    const offDiscovery = window.agentOs.events.onDiscoveryRefresh(replace)
    return () => {
      offJob()
      offDiscovery()
    }
  }, [replace, results.length, scan])

  useEffect(() => {
    if (tab !== 'diagnostics') return
    const refreshRuntime = (): void => {
      void window.agentOs.runtime.hostStatus().then(setRuntimeStatus)
    }
    refreshRuntime()
    const timer = window.setInterval(refreshRuntime, 2_000)
    return () => window.clearInterval(timer)
  }, [tab])

  useEffect(() => {
    if (tab === 'diagnostics' && health.length === 0) refreshHealth()
  }, [tab, health.length])

  // 主题应用与「跟随系统」实时监听集中在 App（watchTheme），此处仅切换偏好。

  const startJob = async (
    toolId: string,
    kind: 'install' | 'update'
  ): Promise<void> => {
    setLoadError(null)
    try {
      await window.agentOs.tool.startJob({ toolId, kind })
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }

  const openLoginSession = async (tool: DiscoveryResult): Promise<void> => {
    const created = await createSession({
      name: `${tool.displayName} 登录`,
      toolId: tool.toolId,
      workspacePath: ''
    })
    if (created) {
      openWorkspaceTab({
        kind: 'session',
        resourceId: created.id,
        title: sessionDisplayTitle(created),
        toolId: created.toolId
      })
    }
  }

  const saveMirror = async (): Promise<void> => {
    setMirrorSaving(true)
    try {
      await window.agentOs.settings.setMirror(mirror)
      setMirrorSaved(true)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setMirrorSaving(false)
    }
  }

  return (
    <div
      className="settings-modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSettingsModal()
      }}
    >
      <main
        ref={dialogRef}
        className="settings-page"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.header.title')}
      >
        <header className="settings-page__topbar">
          <div>
            <strong>{t('settings.header.title')}</strong>
            <span>{t('settings.header.subtitle')}</span>
          </div>
          <IconButton label={t('settings.header.closeSettings')} onClick={closeSettingsModal}>
            <CloseIcon />
          </IconButton>
        </header>

        <div className="settings-page__body">
          <aside className="settings-page__nav" aria-label={t('settings.header.categories')}>
            {NAV_TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`settings-page__nav-item ${tab === key ? 'is-active' : ''}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </aside>

          <div className="settings-page__content">
        {loadError && (
          <div className="settings-diagnostic-error" role="alert">
            {t('settings.provider.operationFailed', { error: loadError })}
          </div>
        )}

        {tab === 'general' && (
          <>
            <section className="settings-section">
              <header className="settings-section__header">
                <div><h1>{t('settings.nav.general')}</h1><p>{t('settings.general.pageSubtitle')}</p></div>
              </header>
              <label className="settings-toggle-row">
                <div>
                  <strong>{t('settings.general.growthPageTitle')}</strong>
                  <span>{t('settings.general.growthPageDesc')}</span>
                </div>
                <input
                  type="checkbox"
                  checked={gamificationEnabled}
                  onChange={(e) => {
                    setGamificationEnabled(e.target.checked)
                    void window.agentOs.stats.setGamificationEnabled(e.target.checked)
                  }}
                />
              </label>
            </section>
            <section className="settings-section">
              <header className="settings-section__header">
                <div><h1>{t('settings.shortcut.title')}</h1></div>
              </header>
              <table className="settings-kb-table">
                <thead>
                  <tr><th>{t('settings.shortcut.action')}</th><th>{t('settings.shortcut.key')}</th></tr>
                </thead>
                <tbody>
                  {[
                    { action: t('settings.shortcut.globalSearch'), key: '⌘K' },
                    { action: t('settings.shortcut.sendMessage'), key: '⌘↵' },
                    { action: t('settings.shortcut.newSession'), key: '⌘N' },
                    { action: t('settings.shortcut.closeCurrentTab'), key: '⌘W' },
                    { action: t('settings.shortcut.cycleTabs'), key: '⌃Tab / ⇧⌃Tab' },
                    { action: t('settings.shortcut.switchByPosition'), key: '⌘1 – ⌘9' },
                    { action: t('settings.shortcut.openSettings'), key: '⌘,' }
                  ].map(({ action, key }) => (
                    <tr key={action}>
                      <td>{action}</td>
                      <td><span className="settings-kbd">{key}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}

        {tab === 'cli' && (
          <>
            <section className="settings-section settings-section--spaced">
              <header className="settings-section__header">
                <div>
                  <h1>{t('settings.cli.title')}</h1>
                  <p>{t('settings.cli.subtitle')}</p>
                </div>
                <button
                  type="button"
                  className="settings-refresh"
                  onClick={() => void scan()}
                  disabled={scanning}
                >
                  {scanning ? t('settings.cli.scanning') : t('settings.cli.rescan')}
                </button>
              </header>
              <div className="settings-cli-grid">
                {results
                  .filter((tool) => tool.toolId !== 'shell')
                  .map((tool) => {
                    const job = activeJobs.get(tool.toolId)
                    const running = job?.status === 'queued' || job?.status === 'running'
                    return (
                      <article className="settings-cli-card" key={tool.toolId}>
                        <header className="settings-cli-card__header">
                          <div className="settings-cli-card__title-row">
                            <span className="settings-cli-card__brand-icon">
                              <ToolIcon toolId={tool.toolId} size={20} brandColor />
                            </span>
                            <div>
                              <h2>{tool.displayName}</h2>
                              <p>
                                {tool.health === 'missing'
                                  ? t('common.state.notInstalled')
                                  : `${t('settings.cli.installed')}${tool.version ? t('settings.cli.versionSuffix', { version: tool.version }) : ''}`}
                              </p>
                            </div>
                          </div>
                          <span
                            className={`settings-cli-status is-${tool.health}`}
                            aria-hidden="true"
                          />
                        </header>
                        <div className="settings-cli-card__meta">
                          <span>{tool.runtime ?? t('settings.cli.unknownSource')}</span>
                          <span className="settings-cli-card__path">
                            {tool.executablePath ?? tool.suggestedFixes?.[0] ?? t('settings.cli.waitingDiscovery')}
                          </span>
                        </div>
                        <div className="settings-cli-card__actions">
                          {tool.health === 'missing' ? (
                            <button
                              type="button"
                              className="settings-button settings-button--primary"
                              disabled={running}
                              onClick={() => void startJob(tool.toolId, 'install')}
                            >
                              {running ? t('settings.cli.installing') : t('common.action.install')}
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="settings-button"
                                disabled={running}
                                onClick={() => void openLoginSession(tool)}
                              >
                                {t('settings.cli.openLogin')}
                              </button>
                              <button
                                type="button"
                                className="settings-button settings-button--primary"
                                disabled={running}
                                onClick={() => void startJob(tool.toolId, 'update')}
                              >
                                {running ? t('settings.cli.upgrading') : t('settings.cli.upgrade')}
                              </button>
                            </>
                          )}
                        </div>
                        <details className="settings-tool-diagnosis">
                          <summary>{t('settings.cli.diagnosis')}</summary>
                          <div>
                            <strong>{t('settings.cli.currentStatus', { status: tool.health })}</strong>
                            {tool.evidence.flatMap((item) =>
                              item.error
                                ? [t('settings.cli.providerError', { provider: item.provider, error: item.error })]
                                : item.matchedPath
                                  ? [t('settings.cli.providerHit', { provider: item.provider, path: item.matchedPath })]
                                  : []
                            ).map((line) => (
                              <span key={line}>{line}</span>
                            ))}
                            {tool.suggestedFixes?.map((fix) => (
                              <span key={fix}>{t('settings.cli.suggestFix', { fix })}</span>
                            ))}
                          </div>
                        </details>
                        {job && (
                          <details className="settings-job" open={job.status === 'failed'}>
                            <summary>
                              {job.status === 'running'
                                ? t('settings.cli.jobRunning')
                                : job.status === 'succeeded'
                                  ? t('settings.cli.jobSucceeded')
                                  : job.status === 'cancelled'
                                    ? t('settings.cli.jobCancelled')
                                    : t('settings.cli.jobFailed')}
                            </summary>
                            {job.diagnosis && (
                              <div className="settings-job__diagnosis">
                                <strong>
                                  {t('settings.cli.diagnosisIssue', { category: diagnosisLabel(job.diagnosis.category) })}
                                </strong>
                                <span>{job.diagnosis.evidence}</span>
                                <span>{job.diagnosis.suggestion}</span>
                              </div>
                            )}
                            {running && (
                              <div
                                className="settings-job__progress"
                                role="progressbar"
                                aria-label={t('settings.cli.installProgress', { name: tool.displayName, kind: job.kind === 'install' ? t('common.action.install') : t('settings.cli.upgrade') })}
                              >
                                <span />
                              </div>
                            )}
                            <pre>{job.logTail}</pre>
                            <div className="settings-job__actions">
                              {job.status === 'failed' && (
                                <button
                                  type="button"
                                  className="settings-button"
                                  onClick={() => void navigator.clipboard.writeText(job.command)}
                                >
                                  {t('settings.cli.copyCommand')}
                                </button>
                              )}
                              {running && (
                                <button
                                  type="button"
                                  className="settings-button"
                                  onClick={() => void window.agentOs.tool.cancelJob(job.id)}
                                >
                                  {t('settings.cli.cancelTask')}
                                </button>
                              )}
                            </div>
                          </details>
                        )}
                      </article>
                    )
                  })}
              </div>
            </section>

            <section className="settings-section">
              <header className="settings-section__header">
                <div>
                  <h1>{t('settings.cli.mirrorTitle')}</h1>
                  <p>{t('settings.cli.mirrorDesc')}</p>
                </div>
              </header>
              <div className="settings-mirror-card">
                <div className="settings-preset-row">
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() =>
                      setMirror((current) => ({
                        ...current,
                        npmRegistry: 'https://registry.npmjs.org'
                      }))
                    }
                  >
                    {t('settings.cli.npmOfficial')}
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    onClick={() =>
                      setMirror((current) => ({
                        ...current,
                        npmRegistry: 'https://registry.npmmirror.com'
                      }))
                    }
                  >
                    {t('settings.cli.chinaMirror')}
                  </button>
                </div>
                <label className="settings-field">
                  <span>npm Registry</span>
                  <input
                    value={mirror.npmRegistry ?? ''}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                    onChange={(event) =>
                      setMirror((current) => ({
                        ...current,
                        npmRegistry: event.target.value
                      }))
                    }
                    placeholder="https://registry.npmjs.org"
                  />
                </label>
                <label className="settings-field">
                  <span>HTTPS Proxy</span>
                  <input
                    value={mirror.httpsProxy ?? ''}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                    onChange={(event) =>
                      setMirror((current) => ({
                        ...current,
                        httpsProxy: event.target.value
                      }))
                    }
                    placeholder="http://127.0.0.1:7890"
                  />
                </label>
                <div className="settings-provider-card__actions">
                  {mirrorSaved && (
                    <span className="settings-saved" role="status" aria-live="polite">
                      {t('settings.cli.saved')}
                    </span>
                  )}
                  <button
                    type="button"
                    className="settings-button settings-button--primary"
                    disabled={mirrorSaving}
                    onClick={() => void saveMirror()}
                  >
                    {mirrorSaving ? t('common.state.saving') : t('settings.cli.saveMirror')}
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {tab === 'provider' && (
          <section className="settings-section">
            <header className="settings-section__header">
              <div>
                <h1>{t('settings.provider.title')}</h1>
                <p>{t('settings.provider.desc')}</p>
              </div>
            </header>
            <div className="settings-provider-list">
              {results
                .filter((tool) => tool.toolId !== 'shell')
                .map((tool) => (
                  <ProviderCard key={tool.toolId} tool={tool} />
                ))}
            </div>
          </section>
        )}

        {tab === 'diagnostics' && (
          <>
            <section className="settings-section settings-section--spaced">
              <header className="settings-section__header">
                <div>
                  <h1>{t('settings.diag.daemonTitle')}</h1>
                  <p>{t('settings.diag.daemonDesc')}</p>
                </div>
                <button
                  type="button"
                  className="settings-refresh"
                  disabled={restartingDaemon}
                  onClick={() => {
                    setRestartingDaemon(true)
                    void window.agentOs.runtime
                      .restartDaemon()
                      .then(setRuntimeStatus)
                      .finally(() => setRestartingDaemon(false))
                  }}
                >
                  {restartingDaemon ? t('settings.diag.restarting') : t('settings.diag.restart')}
                </button>
              </header>
              <div className="settings-runtime-card">
                <div>
                  <span>{t('settings.diag.cell.connection')}</span>
                  <strong className={`is-${runtimeStatus?.connection ?? 'spawning'}`}>
                    {runtimeStatus?.connection ?? 'spawning'}
                  </strong>
                </div>
                <div>
                  <span>{t('settings.diag.cell.mode')}</span>
                  <strong>{runtimeStatus?.mode ?? 'daemon'}</strong>
                </div>
                <div>
                  <span>{t('settings.diag.cell.pid')}</span>
                  <strong>{runtimeStatus?.pid ?? '—'}</strong>
                </div>
                <div>
                  <span>{t('settings.diag.cell.version')}</span>
                  <strong>{runtimeStatus?.hostVersion ?? '—'}</strong>
                </div>
                <div>
                  <span>{t('settings.diag.cell.sessionCount')}</span>
                  <strong>{runtimeStatus?.sessionCount ?? '—'}</strong>
                </div>
              </div>
              {runtimeStatus?.fallbackReason && (
                <div className="settings-runtime-warning">
                  {t('settings.diag.daemonUnavailable', { reason: runtimeStatus.fallbackReason })}
                </div>
              )}
            </section>
            <section className="settings-section">
              <header className="settings-section__header">
                <div>
                  <h1>{t('settings.diag.title')}</h1>
                  <p>{t('settings.diag.pageSubtitle')}</p>
                </div>
                <button
                  type="button"
                  className="settings-refresh"
                  onClick={refreshHealth}
                  disabled={healthLoading}
                >
                  {healthLoading ? t('settings.diag.checking') : t('settings.diag.recheck')}
                </button>
              </header>
              <div className="settings-health-list" aria-busy={healthLoading}>
                {health.map((item) => (
                  <article
                    className="settings-health-card"
                    key={`${item.toolId}:${item.cliVersion}`}
                  >
                    <div className="settings-health-card__main">
                      <span
                        className={`settings-health-dot is-${item.status}`}
                        aria-hidden="true"
                      />
                      <div>
                        <div className="settings-health-card__name">{item.toolId}</div>
                        <div className="settings-health-card__version">{item.cliVersion}</div>
                      </div>
                    </div>
                    <div className="settings-health-card__result">
                      <span className={`settings-health-status is-${item.status}`}>
                        {statusLabel(item.status)}
                      </span>
                      {item.sampleErrors.map((error) => (
                        <div className="settings-health-card__detail" key={error}>
                          {error}
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
              {!healthLoading && health.length === 0 && (
                <div className="settings-health-empty">{t('settings.diag.emptyAdapters')}</div>
              )}
            </section>
          </>
        )}

        {tab === 'appearance' && (
          <section className="settings-section">
            <header className="settings-section__header">
              <div><h1>{t('settings.nav.appearance')}</h1><p>{t('settings.theme.appearanceSubtitle')}</p></div>
            </header>
            <div className="settings-toggle-row">
              <div>
                <strong>{t('settings.theme.title')}</strong>
                <span>{t('settings.theme.pageDesc')}</span>
              </div>
              <div className="settings-seg" role="group" aria-label={t('settings.theme.title')}>
                {(['system', 'light', 'dark'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={themeMode === mode}
                    className={`settings-seg-btn ${themeMode === mode ? 'is-active' : ''}`}
                    onClick={() => setThemeMode(mode)}
                  >
                    {mode === 'system' ? t('settings.theme.options.system') : mode === 'light' ? t('settings.theme.options.light') : t('settings.theme.options.dark')}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {tab === 'updates' && (
          <section className="settings-section">
            <header className="settings-section__header">
              <div><h1>{t('settings.about.softwareUpdate')}</h1><p>{t('settings.about.updatesSubtitle')}</p></div>
            </header>
            <div className="settings-update-card">
              <div className="settings-update-card__info">
                <strong>Agent OS</strong>
                <span className="settings-update-card__ver">v{appVersion || '…'}</span>
              </div>
              {updateMsg && <p className="settings-update-card__msg">{updateMsg}</p>}
              <button
                type="button"
                className="settings-button settings-button--primary"
                disabled={checkingUpdate}
                onClick={async () => {
                  setCheckingUpdate(true)
                  setUpdateMsg('')
                  try {
                    // 手动点击：实时拉取，绕过自动检查的节流缓存。
                    const info = await window.agentOs.runtime.checkUpdate({ force: true })
                    if (info.hasUpdate) {
                      setUpdateMsg(t('settings.about.foundNew', { version: info.latestVersion ?? '' }))
                      await window.agentOs.runtime.applyUpdate()
                      setUpdateMsg(t('settings.about.updateStarted'))
                    } else {
                      setUpdateMsg(t('settings.about.latestAlready'))
                    }
                  } catch (e) {
                    setUpdateMsg(t('settings.about.checkFailed', { error: e instanceof Error ? e.message : String(e) }))
                  } finally {
                    setCheckingUpdate(false)
                  }
                }}
              >
                {checkingUpdate ? t('settings.about.checking') : t('settings.about.checkUpdate')}
              </button>
            </div>
          </section>
        )}

        {tab === 'about' && (
          <section className="settings-section">
            <header className="settings-section__header">
              <div><h1>{t('settings.about.aboutTitle')}</h1></div>
            </header>
            <div className="settings-about-card">
              <div className="settings-about-card__logo">
                <img src={agentOsLogo} alt="Agent OS" width={64} height={64} />
              </div>
              <div className="settings-about-card__name">Agent OS</div>
              <div className="settings-about-card__ver">
                {t('settings.about.versionLine', { version: appVersion || '…' })}
                {platform && ` · ${platform.platform}`}
              </div>
              <div className="settings-about-card__desc">
                {t('settings.about.desc')}
              </div>
            </div>
          </section>
        )}
          </div>
        </div>
      </main>
    </div>
  )
}
