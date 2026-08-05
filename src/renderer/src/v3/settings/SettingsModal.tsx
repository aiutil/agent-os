// 设置弹窗（接活）。UI 复刻原型 SettingsModal 四栏（通用/CLI 管理/诊断/关于），接真实 IPC。

import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type {
  ChannelAccount,
  ChannelAcl,
  ChannelPairingRequest,
  ChannelPlatform,
  CreateEnrollmentResult,
  CuratorCandidate,
  DataPlaneHealth,
  LifecycleJob,
  ManagedPairingSnapshot,
  MemorySettings,
  NodeAgentInfo,
  NodeGatewayStatus,
  NodePlatform,
  NodeReleaseReadiness,
  RemoteNode,
  RemoteNodeStatus,
  RuntimeHostStatus,
  UpdateState,
  WorkbenchSession
} from '@shared/types'
import { sessionDisplayTitle } from '../../lib/sessionTitle'

const MANAGED_READ_CAPABILITIES = [
  'runtime:status',
  'runtime:list-agents',
  'directory:list'
] as const
const MANAGED_SESSION_CAPABILITIES = [
  'session:create',
  'session:read',
  'session:write',
  'session:terminate'
] as const
import { useUiStore } from '../../stores/uiStore'
import { useToolsStore } from '../../stores/toolsStore'
import { healthColor, healthLabel } from '../../lib/status'
import { ToolIcon } from '../../lib/toolIcons'
import { ToolSelector, type ToolOption } from '../shared/ToolSelector'
import { ModelPicker } from '../shared/ModelPicker'
import { useT } from '../../lib/i18n'
import { localeFor } from '@shared/i18n'
import { defaultCurationPrompt } from '@shared/curation-prompts'
import { buildRemoteAgentTiles } from '@shared/remote-agent-tiles'
import agentOsLogo from '../../assets/agentos-logo.png'
import { resetAnalyticsIdentity, updateAnalyticsTracking } from '../../analytics/mixpanel'
import {
  aggregateChannelExperience,
  channelAccountExperience,
  channelHeaderExperience,
  selectChannelAccount,
  type ChannelExperienceState
} from '@shared/channel-account-health'

const IcClose = (): React.JSX.Element => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
    <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

const SHORTCUTS = [
  { keys: '⌘N', tkey: 'settings.shortcut.newChat' },
  { keys: '⌘,', tkey: 'settings.shortcut.openSettings' },
  { keys: '⌘K', tkey: 'settings.shortcut.commandPalette' },
  { keys: '⌘W', tkey: 'settings.shortcut.closeTab' },
  { keys: '⌘/', tkey: 'settings.shortcut.toggleSidebar' },
  { keys: 'Esc', tkey: 'settings.shortcut.exitChat' }
] as const

function SToggle({
  value,
  onChange,
  label
}: {
  value: boolean
  onChange(v: boolean): void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        cursor: 'pointer',
        flexShrink: 0,
        position: 'relative',
        padding: 0,
        background: value ? 'var(--accent)' : 'var(--bg-active)',
        border: '1px solid',
        borderColor: value ? 'var(--accent)' : 'var(--border-medium)',
        transition: 'background 200ms,border-color 200ms'
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 2,
          left: value ? 20 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: value ? 'var(--accent-fg)' : 'var(--text-muted)',
          transition: 'left 200ms',
          boxShadow: 'var(--shadow-card)'
        }}
      />
    </button>
  )
}

function SegCtrl<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ v: T; l: string }>
  value: T
  onChange(v: T): void
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        background: 'var(--bg-panel)',
        borderRadius: 8,
        padding: 2,
        gap: 1
      }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            padding: '4px 12px',
            borderRadius: 6,
            border: 'none',
            font: 'inherit',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: value === o.v ? 500 : 400,
            background: value === o.v ? 'var(--bg-card)' : 'transparent',
            color: value === o.v ? 'var(--text-primary)' : 'var(--text-muted)'
          }}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

// ─── 通用 ─────────────────────────────────────────────────────────────────────

function SettingsGeneral(): React.JSX.Element {
  const { t } = useT()
  const theme = useUiStore((s) => s.themePreference)
  const setTheme = useUiStore((s) => s.setThemePreference)
  const lang = useUiStore((s) => s.languagePreference)
  const setLang = useUiStore((s) => s.setLanguagePreference)
  const setOnboardingCompleted = useUiStore((s) => s.setOnboardingCompleted)
  const [growth, setGrowth] = useState(true)
  const [analyticsTracking, setAnalyticsTrackingState] = useState(true)
  const [analyticsReset, setAnalyticsReset] = useState(false)
  const [backupBusy, setBackupBusy] = useState<'export' | 'import' | null>(null)
  const [backupMessage, setBackupMessage] = useState('')

  useEffect(() => {
    void window.agentOs.stats
      .getGamificationEnabled()
      .then(setGrowth)
      .catch(() => {})
    void window.agentOs.app
      .getAnalyticsConfig()
      .then((config) => setAnalyticsTrackingState(config.trackingEnabled))
      .catch(() => {})
  }, [])

  const exportBackup = async (): Promise<void> => {
    setBackupBusy('export')
    setBackupMessage('')
    try {
      const result = await window.agentOs.backup.export()
      if (!result.cancelled) setBackupMessage(t('settings.general.exportDone'))
    } catch (error) {
      setBackupMessage(
        t('settings.general.migrationFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setBackupBusy(null)
    }
  }

  const importBackup = async (): Promise<void> => {
    setBackupBusy('import')
    setBackupMessage('')
    try {
      const preview = await window.agentOs.backup.previewImport()
      if (preview.cancelled || !preview.approvalToken || !preview.summary) return
      const confirmed = window.confirm(
        t('settings.general.importPreview', {
          version: preview.summary.sourceVersion,
          memories: preview.summary.memories,
          tasks: preview.summary.tasks,
          providers: preview.summary.providers,
          paused: preview.summary.schedulesWillBePaused
        })
      )
      if (!confirmed) return
      const result = await window.agentOs.backup.import(preview.approvalToken)
      setGrowth(await window.agentOs.stats.getGamificationEnabled())
      setBackupMessage(
        t('settings.general.importDone', {
          memories: result.importedMemories,
          tasks: result.importedTasks,
          paused: result.schedulesPaused
        })
      )
    } catch (error) {
      setBackupMessage(
        t('settings.general.migrationFailed', {
          error: error instanceof Error ? error.message : String(error)
        })
      )
    } finally {
      setBackupBusy(null)
    }
  }

  return (
    <div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--text-primary)',
          letterSpacing: '-.02em',
          marginBottom: 3
        }}
      >
        {t('settings.nav.general')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 22 }}>
        {t('settings.general.subtitle')}
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.general.migration')}</div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.general.migrationTitle')}
            </div>
            <div
              style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}
            >
              {t('settings.general.migrationDesc')}
            </div>
            {backupMessage && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 7 }}>
                {backupMessage}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              style={miniBtn}
              disabled={backupBusy !== null}
              onClick={() => void exportBackup()}
            >
              {backupBusy === 'export'
                ? t('settings.general.exportingBackup')
                : t('settings.general.exportBackup')}
            </button>
            <button
              style={miniBtn}
              disabled={backupBusy !== null}
              onClick={() => void importBackup()}
            >
              {backupBusy === 'import'
                ? t('settings.general.importingBackup')
                : t('settings.general.importBackup')}
            </button>
          </div>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.general.privacy')}</div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.general.analyticsTitle')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.general.analyticsDesc')}
            </div>
          </div>
          <SToggle
            label={t('settings.general.analyticsTitle')}
            value={analyticsTracking}
            onChange={(enabled) => {
              setAnalyticsTrackingState(enabled)
              setAnalyticsReset(false)
              void updateAnalyticsTracking(enabled).catch(() => {
                setAnalyticsTrackingState(!enabled)
              })
            }}
          />
        </div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.general.analyticsIdentityTitle')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.general.analyticsIdentityDesc')}
            </div>
          </div>
          <button
            style={miniBtn}
            onClick={() => {
              void resetAnalyticsIdentity()
                .then(() => setAnalyticsReset(true))
                .catch(() => setAnalyticsReset(false))
            }}
          >
            {analyticsReset
              ? t('settings.general.analyticsIdentityResetDone')
              : t('settings.general.analyticsIdentityReset')}
          </button>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.general.appearance')}</div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.theme.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.theme.modalDesc')}
            </div>
          </div>
          <SegCtrl
            options={[
              { v: 'system', l: t('settings.theme.options.system') },
              { v: 'light', l: t('settings.theme.options.light') },
              { v: 'dark', l: t('settings.theme.options.dark') }
            ]}
            value={theme}
            onChange={setTheme}
          />
        </div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.language.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.language.desc')}
            </div>
          </div>
          <SegCtrl
            options={[
              { v: 'system', l: t('settings.language.options.system') },
              { v: 'zh', l: t('settings.language.options.zh') },
              { v: 'en', l: t('settings.language.options.en') }
            ]}
            value={lang}
            onChange={setLang}
          />
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.general.features')}</div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.general.growthTitle')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.general.growthDesc')}
            </div>
          </div>
          <SToggle
            label={t('settings.general.growthTitle')}
            value={growth}
            onChange={(v) => {
              setGrowth(v)
              void window.agentOs.stats.setGamificationEnabled(v)
            }}
          />
        </div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.general.restartGuideTitle')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.general.restartGuideDesc')}
            </div>
          </div>
          <button
            style={miniBtn}
            onClick={() => {
              void window.agentOs.app.resetOnboarding().then(() => setOnboardingCompleted(false))
            }}
          >
            {t('settings.general.restartGuide')}
          </button>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.shortcut.title')}</div>
        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 10,
            overflow: 'hidden'
          }}
        >
          {SHORTCUTS.map((s, i) => (
            <div
              key={s.keys}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '9px 16px',
                borderBottom: i < SHORTCUTS.length - 1 ? '1px solid var(--border-subtle)' : 'none'
              }}
            >
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-secondary)' }}>
                {t(s.tkey)}
              </span>
              <kbd
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-medium)',
                  borderRadius: 5,
                  fontSize: 11.5,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)'
                }}
              >
                {s.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── 记忆 ─────────────────────────────────────────────────────────────────────

function SettingsMemory(): React.JSX.Element {
  const { t, lang } = useT()
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const [candidates, setCandidates] = useState<CuratorCandidate[]>([])
  const [budget, setBudget] = useState('')
  const [promptKind, setPromptKind] = useState<'memory' | 'knowledge'>('memory')
  const [memoryPrompt, setMemoryPrompt] = useState(() => defaultCurationPrompt('memory', lang))
  const [knowledgePrompt, setKnowledgePrompt] = useState(() => defaultCurationPrompt('knowledge', lang))
  const [promptStatus, setPromptStatus] = useState('')
  const [manualSessionId, setManualSessionId] = useState('')
  const [manualStatus, setManualStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [manualMessage, setManualMessage] = useState('')

  useEffect(() => {
    void window.agentOs.memory
      .settings()
      .then((next) => {
        setSettings(next)
        setMemoryPrompt(
          next.memoryCurationPromptMode === 'custom'
            ? next.memoryCurationPrompt
            : defaultCurationPrompt('memory', lang)
        )
        setKnowledgePrompt(
          next.knowledgeCurationPromptMode === 'custom'
            ? next.knowledgeCurationPrompt
            : defaultCurationPrompt('knowledge', lang)
        )
      })
      .catch(() => {})
    void window.agentOs.memory
      .curatorCandidates()
      .then(setCandidates)
      .catch(() => {})
  }, [lang])

  const update = (patch: Partial<MemorySettings>): void => {
    void window.agentOs.memory
      .updateSettings(patch)
      .then(setSettings)
      .catch(() => {})
  }

  const commitBudget = (): void => {
    const clamped = Math.max(200, Math.min(8000, Math.round(Number(budget) || 1200)))
    setBudget(String(clamped))
    update({ contextTokenBudget: clamped })
  }

  const savePrompt = (): void => {
    const value = (promptKind === 'memory' ? memoryPrompt : knowledgePrompt).trim()
    if (!value) {
      setPromptStatus(t('settings.memory.promptRequired'))
      return
    }
    setPromptStatus(t('settings.memory.promptSaving'))
    const patch: Partial<MemorySettings> = promptKind === 'memory'
      ? { memoryCurationPrompt: value, memoryCurationPromptMode: 'custom' }
      : { knowledgeCurationPrompt: value, knowledgeCurationPromptMode: 'custom' }
    void window.agentOs.memory.updateSettings(patch).then((next) => {
      setSettings(next)
      setMemoryPrompt(next.memoryCurationPrompt)
      setKnowledgePrompt(next.knowledgeCurationPrompt)
      setPromptStatus(t('settings.memory.promptSaved'))
    }).catch((cause: Error) => setPromptStatus(cause.message))
  }

  const resetPrompt = (): void => {
    const value = defaultCurationPrompt(promptKind, lang)
    if (promptKind === 'memory') setMemoryPrompt(value)
    else setKnowledgePrompt(value)
    const patch: Partial<MemorySettings> = promptKind === 'memory'
      ? { memoryCurationPrompt: value, memoryCurationPromptMode: 'default' }
      : { knowledgeCurationPrompt: value, knowledgeCurationPromptMode: 'default' }
    setPromptStatus(t('settings.memory.promptSaving'))
    void window.agentOs.memory.updateSettings(patch).then((next) => {
      setSettings(next)
      setPromptStatus(t('settings.memory.promptResetDone'))
    }).catch((cause: Error) => setPromptStatus(cause.message))
  }

  const extractKnowledgeNow = (): void => {
    const sourceId = manualSessionId.trim()
    if (!sourceId || manualStatus === 'running') return
    setManualStatus('running')
    setManualMessage(t('settings.memory.manualExtractRunning'))
    void window.agentOs.memory.getTranscript(sourceId).then((transcript) => {
      if (!transcript) throw new Error(t('settings.memory.manualSessionNotFound'))
      if (!transcript.cwd) throw new Error(t('settings.memory.manualSessionNoCwd'))
      const text = transcript.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n\n')
      if (!text.trim()) throw new Error(t('settings.memory.manualSessionEmpty'))
      return window.agentOs.knowledge.extractDraft({
        source: { sourceType: 'session', sourceId, toolId: transcript.toolId },
        cwd: transcript.cwd,
        text
      })
    }).then((article) => {
      setManualStatus('success')
      setManualMessage(t('settings.memory.manualExtractSuccess', { title: article.title }))
    }).catch((cause: Error) => {
      setManualStatus('error')
      setManualMessage(cause.message)
    })
  }

  const curatorToolId = settings?.curatorAgentId ?? ''
  const toolOptions: ToolOption[] = candidates.map((c) => ({
    key: c.toolId,
    label: c.displayName,
    sub: c.version ? `v${c.version}` : c.ready ? c.toolId : t('common.state.notInstalled'),
    color: 'var(--text-muted)'
  }))
  const selectedCandidate = candidates.find((c) => c.toolId === curatorToolId)

  return (
    <div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--text-primary)',
          letterSpacing: '-.02em',
          marginBottom: 3
        }}
      >
        {t('settings.memory.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 22 }}>
        {t('settings.memory.subtitle')}
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.memory.masterSwitch')}</div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.memory.enableLocal')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.memory.enableLocalDesc')}
            </div>
          </div>
          <SToggle
            label={t('settings.memory.enableLocal')}
            value={settings?.enabled ?? false}
            onChange={(enabled) => update({ enabled })}
          />
        </div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.memory.useMemories')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.memory.useMemoriesDesc')}
            </div>
          </div>
          <SToggle
            label={t('settings.memory.useMemories')}
            value={settings?.useMemories ?? false}
            onChange={(useMemories) => update({ useMemories })}
          />
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.memory.sharedCuration')}</div>
        <div className="settings-curation-flow" aria-label={t('settings.memory.curationFlowAria')}>
          <span>{t('settings.memory.curationSource')}</span>
          <i aria-hidden="true">→</i>
          <strong>{t('settings.memory.curationEngine')}</strong>
          <i aria-hidden="true">→</i>
          <span>{t('settings.memory.curationMemoryOutput')} · {t('settings.memory.curationKnowledgeOutput')}</span>
        </div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.memory.memoryCuration')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.memory.memoryCurationDesc')}
            </div>
          </div>
          <SToggle
            label={t('settings.memory.memoryCuration')}
            value={settings?.generateMemories ?? false}
            onChange={(generateMemories) => update({ generateMemories })}
          />
        </div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.memory.knowledgeCuration')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.memory.knowledgeCurationDesc')}
            </div>
          </div>
          <SToggle
            label={t('settings.memory.knowledgeCuration')}
            value={settings?.knowledgeCurationEnabled ?? true}
            onChange={(knowledgeCurationEnabled) => update({ knowledgeCurationEnabled })}
          />
        </div>
        <div className="settings-row" style={{ alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.memory.cliAndModel')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.memory.cliAndModelDesc')}
            </div>
          </div>
          <ToolSelector
            value={curatorToolId}
            onChange={(toolId) =>
              update({ curatorAgentId: toolId || undefined, curatorModel: undefined })
            }
            tools={toolOptions}
            placement="up"
          />
          <ModelPicker
            toolId={curatorToolId}
            value={settings?.curatorModel ?? ''}
            onChange={(model) => update({ curatorModel: model || undefined })}
            placement="up"
          />
        </div>
        {candidates.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--status-error)', marginTop: 6 }}>
            {t('settings.memory.curatorNotFound')}
          </div>
        )}
        {selectedCandidate && !selectedCandidate.ready && (
          <div style={{ fontSize: 11, color: 'var(--status-waiting)', marginTop: 6 }}>
            {t('settings.memory.curatorNotReady', { name: selectedCandidate.displayName })}
            {selectedCandidate.installHint
              ? t('settings.memory.installHintPrefix', { hint: selectedCandidate.installHint })
              : ''}
          </div>
        )}
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.memory.promptPolicies')}</div>
        <div className="settings-prompt-tabs" role="tablist" aria-label={t('settings.memory.promptPolicies')}>
          <button
            type="button"
            role="tab"
            aria-selected={promptKind === 'memory'}
            className={promptKind === 'memory' ? 'is-active' : ''}
            onClick={() => { setPromptKind('memory'); setPromptStatus('') }}
          >{t('settings.memory.memoryPrompt')}</button>
          <button
            type="button"
            role="tab"
            aria-selected={promptKind === 'knowledge'}
            className={promptKind === 'knowledge' ? 'is-active' : ''}
            onClick={() => { setPromptKind('knowledge'); setPromptStatus('') }}
          >{t('settings.memory.knowledgePrompt')}</button>
        </div>
        <textarea
          className="settings-prompt-editor"
          aria-label={promptKind === 'memory' ? t('settings.memory.memoryPrompt') : t('settings.memory.knowledgePrompt')}
          value={promptKind === 'memory' ? memoryPrompt : knowledgePrompt}
          onChange={(event) => {
            if (promptKind === 'memory') setMemoryPrompt(event.target.value)
            else setKnowledgePrompt(event.target.value)
            setPromptStatus('')
          }}
        />
        <div className="settings-prompt-footer">
          <span>
            {t(
              (promptKind === 'memory'
                ? settings?.memoryCurationPromptMode
                : settings?.knowledgeCurationPromptMode) === 'custom'
                ? 'settings.memory.promptCustomMode'
                : 'settings.memory.promptDefaultMode'
            )}
            {' · '}
            {promptStatus || t('settings.memory.promptFutureOnly')}
          </span>
          <button type="button" onClick={resetPrompt}>{t('settings.memory.promptReset')}</button>
          <button type="button" className="is-primary" onClick={savePrompt}>{t('settings.memory.promptSave')}</button>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.memory.manualExtract')}</div>
        <div className="settings-manual-extract">
          <div>
            <strong>{t('settings.memory.manualExtractTitle')}</strong>
            <span>{t('settings.memory.manualExtractDesc')}</span>
          </div>
          <div className="settings-manual-extract__action">
            <input
              value={manualSessionId}
              onChange={(event) => { setManualSessionId(event.target.value); setManualStatus('idle'); setManualMessage('') }}
              placeholder={t('settings.memory.manualSessionPlaceholder')}
              aria-label={t('settings.memory.manualSessionLabel')}
            />
            <button
              type="button"
              className="is-primary"
              disabled={!manualSessionId.trim() || manualStatus === 'running' || !settings?.knowledgeCurationEnabled}
              onClick={extractKnowledgeNow}
            >{manualStatus === 'running' ? t('settings.memory.manualExtracting') : t('settings.memory.manualExtractButton')}</button>
          </div>
          {manualMessage && <p className={`settings-manual-extract__status is-${manualStatus}`} role="status">{manualMessage}</p>}
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.memory.privacy')}</div>
        <div className="settings-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.memory.allowExternal')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.memory.allowExternalDesc')}
            </div>
          </div>
          <SToggle
            label={t('settings.memory.allowExternal')}
            value={settings?.allowExternalContext ?? false}
            onChange={(allowExternalContext) => update({ allowExternalContext })}
          />
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.memory.budget')}</div>
        <div className="settings-row" style={{ alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
              {t('settings.memory.budgetTitle')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.memory.budgetDesc')}
            </div>
          </div>
          <input
            type="number"
            min={200}
            max={8000}
            step={100}
            value={budget || String(settings?.contextTokenBudget ?? 1200)}
            onChange={(event) => setBudget(event.target.value)}
            onBlur={commitBudget}
            style={{ ...fieldStyle, width: 96, textAlign: 'right' }}
          />
        </div>
      </div>
    </div>
  )
}

function archivedAtLabel(iso: string, locale: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(locale, { hour12: false })
}

function SettingsArchive(): React.JSX.Element {
  const { t, lang } = useT()
  const [sessions, setSessions] = useState<WorkbenchSession[]>([])
  const [loading, setLoading] = useState(true)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    void window.agentOs.session
      .list()
      .then((items) => setSessions(items.filter((item) => item.archivedAt)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => load(), [load])

  const restore = (id: string): void => {
    setRestoringId(id)
    void window.agentOs.session
      .update(id, { archived: false })
      .then(load)
      .finally(() => setRestoringId(null))
  }

  return (
    <div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--text-primary)',
          letterSpacing: '-.02em',
          marginBottom: 3
        }}
      >
        {t('settings.archive.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 22 }}>
        {t('settings.archive.subtitle')}
      </div>
      <div className="settings-group">
        <div className="settings-group-label">{t('settings.archive.archivedSessions')}</div>
        {loading ? (
          <div className="settings-archive-empty">{t('common.state.loading')}</div>
        ) : sessions.length === 0 ? (
          <div className="settings-archive-empty">{t('settings.archive.empty')}</div>
        ) : (
          <div className="settings-archive-list">
            {sessions
              .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
              .map((session) => (
                <div className="settings-archive-row" key={session.id}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="settings-archive-row__title">
                      {sessionDisplayTitle(session)}
                    </div>
                    <div className="settings-archive-row__meta">
                      {session.surface === 'terminal' ? 'CLI' : t('settings.archive.session')} ·{' '}
                      {session.toolId || t('settings.archive.unknownCli')} ·{' '}
                      {session.workspacePath || '~'} ·{' '}
                      {archivedAtLabel(session.archivedAt ?? '', localeFor(lang))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="cli-card__action"
                    disabled={restoringId === session.id}
                    onClick={() => restore(session.id)}
                  >
                    {restoringId === session.id
                      ? t('settings.archive.restoring')
                      : t('settings.archive.restore')}
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── CLI 管理 ─────────────────────────────────────────────────────────────────

function SettingsCLI(): React.JSX.Element {
  const { t } = useT()
  const { results: allResults, scanning, scan } = useToolsStore()
  // Shell 是系统内置，不在此管理
  const results = allResults.filter((cli) => cli.toolId !== 'shell')
  const [jobs, setJobs] = useState<Record<string, LifecycleJob>>({})
  const [expand, setExpand] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (allResults.length === 0) void scan()
    const off = window.agentOs.events.onToolJobProgress((job) => {
      setJobs((prev) => ({ ...prev, [job.toolId]: job }))
      if (job.status === 'succeeded') void scan()
    })
    return () => off()
  }, [])

  const startJob = (toolId: string, kind: 'install' | 'update'): void => {
    void window.agentOs.tool.startJob({ toolId, kind })
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 2 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--text-primary)',
              letterSpacing: '-.02em',
              marginBottom: 3
            }}
          >
            {t('settings.cli.title')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            {t('settings.cli.subtitle')}
          </div>
        </div>
        <button
          onClick={() => void scan()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            height: 32,
            padding: '0 14px',
            borderRadius: 8,
            border: '1px solid var(--border-medium)',
            background: 'var(--bg-card)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            font: 'inherit',
            flexShrink: 0,
            marginTop: 2
          }}
        >
          {scanning ? t('settings.cli.scanning') : t('settings.cli.rescan')}
        </button>
      </div>
      <div className="cli-grid">
        {results.map((cli) => {
          const job = jobs[cli.toolId]
          const running = job?.status === 'running' || job?.status === 'queued'
          const dOpen = expand[cli.toolId]
          return (
            <div key={cli.toolId} className="cli-card">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 9,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0
                  }}
                >
                  <ToolIcon toolId={cli.toolId} size={18} brandColor />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: 'var(--text-primary)',
                        flex: 1
                      }}
                    >
                      {cli.displayName}
                    </span>
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: healthColor(cli.health),
                        flexShrink: 0
                      }}
                    />
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                    {healthLabel(cli.health)}
                    {cli.version ? ` · v${cli.version}` : ''}
                  </div>
                </div>
              </div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {cli.executable || t('common.state.notInstalled')}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                {cli.health !== 'ready' && (
                  <button
                    className="cli-card__action"
                    disabled={running}
                    onClick={() =>
                      startJob(cli.toolId, cli.health === 'missing' ? 'install' : 'update')
                    }
                  >
                    {running
                      ? t('settings.cli.running')
                      : cli.health === 'missing'
                        ? t('common.action.install')
                        : cli.health === 'updatable'
                          ? t('settings.cli.upgrade')
                          : t('settings.cli.fixInstall')}
                  </button>
                )}
                {cli.health === 'ready' && (
                  <span
                    style={{ fontSize: 11, color: 'var(--status-working)', alignSelf: 'center' }}
                  >
                    {t('settings.cli.upToDate')}
                  </span>
                )}
              </div>
              {job?.logTail && running && (
                <pre
                  style={{
                    background: 'var(--bg-surface)',
                    borderRadius: 6,
                    padding: '6px 8px',
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-muted)',
                    maxHeight: 60,
                    overflow: 'auto',
                    margin: 0
                  }}
                >
                  {job.logTail}
                </pre>
              )}
              {(cli.evidence?.length ?? 0) > 0 && (
                <button
                  onClick={() => setExpand((p) => ({ ...p, [cli.toolId]: !p[cli.toolId] }))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    border: 'none',
                    background: 'transparent',
                    font: 'inherit',
                    color: 'var(--text-muted)',
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: 0
                  }}
                >
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 8 8"
                    fill="none"
                    style={{ transform: dOpen ? 'rotate(90deg)' : 'none' }}
                  >
                    <path
                      d="M2 1.5l3 2.5-3 2.5"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {t('settings.cli.diagnosis')}
                </button>
              )}
              {dOpen && (
                <div
                  style={{
                    background: 'var(--bg-surface)',
                    borderRadius: 6,
                    padding: '8px 10px',
                    fontSize: 10.5,
                    fontFamily: 'var(--font-mono)',
                    lineHeight: 1.7
                  }}
                >
                  {cli.evidence.map((ev, i) => (
                    <div
                      key={i}
                      style={{
                        color: ev.matchedPath ? 'var(--status-working)' : 'var(--text-muted)'
                      }}
                    >
                      {ev.matchedPath ? '✓' : '·'} {ev.provider}
                      {ev.error ? ` — ${ev.error}` : ev.matchedPath ? ` — ${ev.matchedPath}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── 诊断 ─────────────────────────────────────────────────────────────────────

function SettingsDiag(): React.JSX.Element {
  const { t } = useT()
  const [status, setStatus] = useState<RuntimeHostStatus | null>(null)
  const [health, setHealth] = useState<DataPlaneHealth[]>([])
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    void window.agentOs.runtime
      .hostStatus()
      .then(setStatus)
      .catch(() => {})
    void window.agentOs.diagnostics
      .dataPlaneHealth()
      .then(setHealth)
      .catch(() => {})
  }, [])

  const restart = (): void => {
    setRestarting(true)
    void window.agentOs.runtime
      .restartDaemon()
      .then(setStatus)
      .finally(() => setRestarting(false))
  }

  const statusColor = (s: DataPlaneHealth['status']): string =>
    s === 'ok'
      ? 'var(--status-working)'
      : s === 'partial'
        ? 'var(--status-waiting)'
        : s === 'drifted'
          ? 'var(--danger)'
          : 'var(--text-muted)'
  const statusLabel = (s: DataPlaneHealth['status']): string =>
    s === 'ok'
      ? t('settings.diag.status.ok')
      : s === 'partial'
        ? t('settings.diag.status.partial')
        : s === 'drifted'
          ? t('settings.diag.status.driftedModal')
          : t('settings.diag.status.untested')

  const cells = status
    ? [
        {
          l: t('settings.diag.cell.connection'),
          v: status.connection,
          hi: status.connection === 'connected'
        },
        { l: t('settings.diag.cell.mode'), v: status.mode },
        { l: t('settings.diag.cell.pid'), v: status.pid ? String(status.pid) : '—', mono: true },
        { l: t('settings.diag.cell.version'), v: status.hostVersion, mono: true },
        { l: t('settings.diag.cell.sessionCount'), v: String(status.sessionCount) }
      ]
    : []

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: 'var(--text-primary)',
              letterSpacing: '-.02em',
              marginBottom: 3
            }}
          >
            {t('settings.diag.daemonTitle')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('settings.diag.daemonDesc')}
          </div>
        </div>
        <button
          onClick={restart}
          disabled={restarting}
          style={{
            height: 32,
            padding: '0 14px',
            borderRadius: 8,
            border: '1px solid var(--border-medium)',
            background: 'var(--bg-card)',
            fontSize: 12,
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            font: 'inherit',
            flexShrink: 0,
            marginTop: 2
          }}
        >
          {restarting ? t('settings.diag.restarting') : t('settings.diag.restart')}
        </button>
      </div>
      <div className="diag-stat-row">
        {cells.map((c) => (
          <div key={c.l} className="diag-stat-cell">
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 5 }}>{c.l}</div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: c.hi ? 'var(--status-working)' : 'var(--text-primary)',
                fontFamily: c.mono ? 'var(--font-mono)' : 'inherit'
              }}
            >
              {c.v}
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>
        {t('settings.diag.title')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        {t('settings.diag.subtitle')}
      </div>
      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 10,
          overflow: 'hidden'
        }}
      >
        {health.length === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>
            {t('settings.diag.noResults')}
          </div>
        )}
        {health.map((d) => (
          <div key={d.toolId} className="diag-cli-row">
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusColor(d.status),
                flexShrink: 0,
                marginTop: 3
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                {d.toolId}
              </div>
              <div
                style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
              >
                {d.cliVersion || 'unknown'}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: statusColor(d.status) }}>
                {statusLabel(d.status)}
              </div>
              {d.sampleErrors?.[0] && (
                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-muted)',
                    maxWidth: 220,
                    textAlign: 'right',
                    lineHeight: 1.4,
                    marginTop: 2
                  }}
                >
                  {d.sampleErrors[0]}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── 关于 ─────────────────────────────────────────────────────────────────────

function SettingsAbout(): React.JSX.Element {
  const { t } = useT()
  const [checking, setChecking] = useState(false)
  const [info, setInfo] = useState<{
    hasUpdate: boolean
    currentVersion: string
    latestVersion: string | null
  } | null>(null)
  const [live, setLive] = useState<UpdateState | null>(null)

  useEffect(() => {
    const off = window.agentOs.events.onUpdateState(setLive)
    void window.agentOs.runtime.updateState().then((s) => s && setLive(s))
    void window.agentOs.runtime
      .checkUpdate()
      .then(setInfo)
      .catch(() => {})
    return off
  }, [])

  const check = (): void => {
    setChecking(true)
    void window.agentOs.runtime
      // 手动点击：实时拉取，绕过自动检查的节流缓存。
      .checkUpdate({ force: true })
      .then(setInfo)
      .finally(() => setChecking(false))
  }

  const status = live?.status ?? 'idle'
  const downloading = status === 'downloading'
  const downloaded = status === 'downloaded'
  const installing = status === 'installing'

  const startDownload = (): void => {
    void window.agentOs.runtime.downloadUpdate()
  }
  const startInstall = (): void => {
    void window.agentOs.runtime.installUpdate({ quitAfterOpen: true })
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '28px 0 24px',
          gap: 14
        }}
      >
        <img
          src={agentOsLogo}
          alt="Agent OS"
          width={72}
          height={72}
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            boxShadow: '0 4px 20px rgba(0,0,0,.2)',
            display: 'block',
            userSelect: 'none'
          }}
        />
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--text-primary)',
              letterSpacing: '-.02em'
            }}
          >
            Agent OS
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-muted)',
              marginTop: 3,
              fontFamily: 'var(--font-mono)'
            }}
          >
            {t('settings.about.versionLine', {
              version: info?.currentVersion ?? live?.currentVersion ?? '—'
            })}
          </div>
        </div>
      </div>
      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 20px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('settings.about.softwareUpdate')}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              {status === 'error'
                ? live?.error || t('settings.about.updateFailed')
                : downloaded
                  ? t('settings.about.downloadedReady')
                  : downloading
                    ? t('settings.about.downloading', { progress: live?.progress ?? 0 })
                    : info
                      ? info.hasUpdate
                        ? t('settings.about.updateAvailable', { version: info.latestVersion ?? '' })
                        : t('settings.about.upToDateVersion', {
                            version: info.currentVersion ?? ''
                          })
                      : t('settings.about.clickToCheck')}
            </div>
          </div>
          {downloaded ? (
            <button
              onClick={startInstall}
              disabled={installing}
              style={{
                height: 32,
                padding: '0 16px',
                borderRadius: 8,
                background: 'var(--text-primary)',
                color: 'var(--bg-surface)',
                border: 'none',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit'
              }}
            >
              {installing ? t('settings.about.installing') : t('settings.about.installUpdate')}
            </button>
          ) : downloading ? (
            <button
              disabled
              style={{
                height: 32,
                padding: '0 16px',
                borderRadius: 8,
                background: 'var(--bg-active)',
                color: 'var(--text-muted)',
                border: '1px solid var(--border-medium)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'default',
                font: 'inherit'
              }}
            >
              {live?.progress ?? 0}%
            </button>
          ) : info?.hasUpdate ? (
            <button
              onClick={startDownload}
              style={{
                height: 32,
                padding: '0 16px',
                borderRadius: 8,
                background: 'var(--text-primary)',
                color: 'var(--bg-surface)',
                border: 'none',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit'
              }}
            >
              {t('settings.about.updateNow')}
            </button>
          ) : (
            <button
              onClick={check}
              disabled={checking}
              style={{
                height: 32,
                padding: '0 16px',
                borderRadius: 8,
                background: 'var(--bg-active)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-medium)',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit'
              }}
            >
              {checking ? t('settings.about.checking') : t('settings.about.checkUpdate')}
            </button>
          )}
        </div>
        {downloading && (
          <div
            style={{
              marginTop: 12,
              height: 6,
              borderRadius: 3,
              background: 'var(--bg-active)',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                width: `${live?.progress ?? 0}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: 'width .2s ease'
              }}
            />
          </div>
        )}
      </div>
      <div
        style={{
          marginTop: 14,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 20px'
        }}
      >
        <div
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            color: 'var(--text-primary)',
            marginBottom: 10
          }}
        >
          {t('settings.about.releaseCatalog')}
        </div>
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            display: 'grid',
            gap: 7,
            color: 'var(--text-secondary)',
            fontSize: 11.5,
            lineHeight: 1.55
          }}
        >
          <li>{t('settings.about.releaseRemote')}</li>
          <li>{t('settings.about.releaseChannels')}</li>
          <li>{t('settings.about.releaseTasks')}</li>
          <li>{t('settings.about.releaseReliability')}</li>
        </ul>
      </div>
      <div
        style={{
          marginTop: 14,
          display: 'grid',
          gap: 8,
          fontSize: 12,
          color: 'var(--text-secondary)'
        }}
      >
        <div>
          {t('settings.about.contactAuthor')}：{' '}
          <a
            href="mailto:days365le@gmail.com"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', fontWeight: 600 }}
          >
            days365le@gmail.com
          </a>
        </div>
        <div>
          {t('settings.about.more')}：{' '}
          <a
            href="https://aiutil.com"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', fontWeight: 600 }}
          >
            aiutil.com
          </a>
        </div>
      </div>
    </div>
  )
}

// ─── 远程节点 ─────────────────────────────────────────────────────────────────

function nodeStatusColor(c: RemoteNodeStatus['connection'] | undefined): string {
  if (c === 'connected') return 'var(--status-ok)'
  if (c === 'error') return 'var(--danger)'
  if (c === 'connecting') return 'var(--accent-gold)'
  return 'var(--text-muted)'
}

const codeBox: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 7,
  padding: '8px 10px',
  color: 'var(--text-secondary)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  lineHeight: 1.6
}
const fieldStyle: React.CSSProperties = {
  height: 32,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid var(--border-medium)',
  background: 'var(--bg-card)',
  color: 'var(--text-primary)',
  fontSize: 12.5,
  font: 'inherit',
  outline: 'none'
}

function CopyRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <div style={{ ...codeBox, flex: 1 }}>{value}</div>
        <button
          onClick={copy}
          style={{
            flexShrink: 0,
            padding: '0 14px',
            borderRadius: 7,
            background: 'var(--text-primary)',
            color: 'var(--bg-surface)',
            border: 'none',
            fontSize: 11.5,
            fontWeight: 600,
            cursor: 'pointer',
            font: 'inherit'
          }}
        >
          {copied ? t('settings.nodes.copied') : t('common.action.copy')}
        </button>
      </div>
    </div>
  )
}

// 节点下单个 CLI 的图标瓦片（视觉语言对齐 CLI 管理卡片）：
// 已装且启用 → 品牌色点亮 +「禁用」；已装未启用 → 暗淡 +「启用」；未装 → 灰显、无操作。
function NodeAgentTile({
  nodeId,
  toolId,
  displayName,
  agent,
  nodeActive,
  onChange,
  onError
}: {
  nodeId: string
  toolId: string
  displayName: string
  agent: NodeAgentInfo | undefined
  nodeActive: boolean
  onChange: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useT()
  const installed = !!agent
  const enabled = agent?.enabled === true
  const lit = installed && enabled
  const [editing, setEditing] = useState(false)
  const [alias, setAlias] = useState(agent?.alias ?? '')

  useEffect(() => {
    setAlias(agent?.alias ?? '')
  }, [agent?.alias])

  const saveAlias = (): void => {
    setEditing(false)
    if (!agent) return
    const next = alias.trim()
    if (next === (agent.alias ?? '')) return
    void window.agentOs.runtime
      .setNodeAgentAlias(nodeId, agent.id, next)
      .then((res) =>
        res.ok ? onChange() : onError(res.error || t('settings.nodes.saveAliasFailed'))
      )
      .catch((e) => onError(e instanceof Error ? e.message : t('settings.nodes.saveAliasFailed')))
  }

  const toggle = (on: boolean): void => {
    if (!agent) return
    void window.agentOs.runtime
      .setNodeAgentEnabled(nodeId, agent.id, on)
      .then((res) =>
        res.ok ? onChange() : onError(res.error || t('settings.nodes.updateStatusFailed'))
      )
      .catch((e) =>
        onError(e instanceof Error ? e.message : t('settings.nodes.updateStatusFailed'))
      )
  }

  const iconBox: React.CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: 9,
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: installed ? undefined : 'var(--text-muted)',
    opacity: lit ? 1 : installed ? 0.55 : 0.5,
    transition: 'opacity var(--dur-instant)'
  }

  const subText = !installed
    ? t('common.state.notInstalled')
    : enabled
      ? agent?.version
        ? t('settings.nodes.enabledWithVersion', { version: agent.version })
        : t('common.state.enabled')
      : t('common.state.disabled')

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        borderRadius: 12,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-card)',
        opacity: installed ? 1 : 0.72
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <div style={iconBox}>
          <ToolIcon toolId={toolId} size={18} brandColor={installed} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {installed && editing ? (
            <input
              autoFocus
              style={{ ...fieldStyle, height: 24, padding: '0 8px', fontSize: 12 }}
              value={alias}
              placeholder={displayName}
              onChange={(e) => setAlias(e.target.value)}
              onBlur={saveAlias}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  setAlias(agent?.alias ?? '')
                  setEditing(false)
                }
              }}
            />
          ) : (
            <div
              onClick={installed ? () => setEditing(true) : undefined}
              title={
                installed
                  ? agent && agent.name && agent.name !== displayName
                    ? t('settings.nodes.clickEditAliasOrigin', { name: agent.name })
                    : t('settings.nodes.clickEditAlias')
                  : undefined
              }
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--text-primary)',
                cursor: installed ? 'text' : 'default',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {agent?.alias || displayName}
            </div>
          )}
          <div
            style={{
              fontSize: 10.5,
              color: lit ? 'var(--status-ok)' : 'var(--text-muted)',
              marginTop: 2
            }}
          >
            {subText}
          </div>
        </div>
        <span
          aria-hidden="true"
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: lit ? 'var(--status-ok)' : 'var(--text-muted)',
            opacity: lit ? 1 : 0.6,
            flexShrink: 0,
            marginTop: 4
          }}
        />
      </div>
      {installed && (
        <div style={{ display: 'flex' }}>
          {lit ? (
            <button
              className="cli-card__action"
              style={{ flex: '0 0 auto', padding: '0 12px' }}
              disabled={!nodeActive}
              onClick={() => toggle(false)}
            >
              {t('common.action.disable')}
            </button>
          ) : (
            <button
              className="cli-card__action"
              style={{ flex: '0 0 auto', padding: '0 12px' }}
              disabled={!nodeActive}
              onClick={() => toggle(true)}
            >
              {t('common.action.enable')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function NodeLabel({
  node,
  onChange,
  onError
}: {
  node: RemoteNode
  onChange: () => void
  onError: (message: string) => void
}): React.JSX.Element {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState(node.label)
  const save = (): void => {
    setEditing(false)
    void window.agentOs.runtime
      .setRemoteNodeLabel(node.id, label)
      .then((res) =>
        res.ok ? onChange() : onError(res.error || t('settings.nodes.saveNodeAliasFailed'))
      )
      .catch((e) =>
        onError(e instanceof Error ? e.message : t('settings.nodes.saveNodeAliasFailed'))
      )
  }
  return editing ? (
    <input
      autoFocus
      style={{ ...fieldStyle, height: 26, width: '100%' }}
      value={label}
      onChange={(e) => setLabel(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  ) : (
    <span
      onClick={() => setEditing(true)}
      title={t('settings.nodes.clickEditNodeAlias')}
      style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', cursor: 'text' }}
    >
      {node.label}
    </span>
  )
}

function ManagedGuiPairingPanel({
  onGatewayChanged
}: {
  onGatewayChanged(): void
}): React.JSX.Element {
  const { t } = useT()
  const [snapshot, setSnapshot] = useState<ManagedPairingSnapshot | null>(null)
  const [manualEndpoint, setManualEndpoint] = useState('')
  const [approvalRoots, setApprovalRoots] = useState<Record<string, string>>({})
  const [allowSessions, setAllowSessions] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.agentOs.runtime
      .managedPairingSnapshot()
      .then(setSnapshot)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 1_500)
    return () => window.clearInterval(timer)
  }, [refresh])

  const run = async (operation: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await operation()
      refresh()
      onGatewayChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.nodes.pairingOperationFailed'))
    } finally {
      setBusy(false)
    }
  }

  const chooseRoot = async (sessionId: string): Promise<void> => {
    const root = await window.agentOs.app.selectDirectory()
    if (root) setApprovalRoots((current) => ({ ...current, [sessionId]: root }))
  }

  const buttonStyle = {
    height: 28,
    padding: '0 12px',
    borderRadius: 7,
    background: 'var(--bg-active)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-medium)',
    fontSize: 11.5,
    cursor: 'pointer',
    font: 'inherit'
  } as const

  const liveSessions =
    snapshot?.sessions.filter(
      (session) => !['active', 'rejected', 'expired'].includes(session.state)
    ) ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 20px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('settings.nodes.guiPairingTitle')}
            </div>
            <div
              style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 2 }}
            >
              {t('settings.nodes.guiPairingDesc')}
            </div>
          </div>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.agentOs.runtime.setManagedDiscoveryEnabled(
                  !snapshot?.discoverable
                )
                if (!result.ok)
                  throw new Error(result.error || t('settings.nodes.pairingOperationFailed'))
              })
            }
            style={buttonStyle}
          >
            {snapshot?.discoverable
              ? t('settings.nodes.stopDiscovery')
              : t('settings.nodes.startDiscovery')}
          </button>
        </div>
        {snapshot && (
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              marginTop: 8,
              wordBreak: 'break-all'
            }}
          >
            {t('settings.nodes.deviceFingerprint', {
              fingerprint: snapshot.identity.publicKeyFingerprint
            })}
          </div>
        )}
        {snapshot?.discoverable && snapshot.manualEndpoint && (
          <CopyRow
            label={t('settings.nodes.manualPairingAddress')}
            value={snapshot.manualEndpoint}
          />
        )}
        {error && (
          <div style={{ color: 'var(--danger)', fontSize: 11.5, marginTop: 8 }}>{error}</div>
        )}
      </div>

      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '14px 16px'
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
          {t('settings.nodes.nearbyDevices')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
          {t('settings.nodes.nearbyDevicesDesc')}
        </div>
        {(snapshot?.nearbyDevices.length ?? 0) === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 11.5, padding: '12px 0 6px' }}>
            {t('settings.nodes.noNearbyDevices')}
          </div>
        ) : (
          snapshot?.nearbyDevices.map((device) => (
            <div
              key={device.discoveryId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 0',
                borderBottom: '1px solid var(--border-subtle)'
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {device.displayName}
                </div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)'
                  }}
                >
                  {device.platform} · {device.host}:{device.port}
                </div>
              </div>
              <button
                disabled={busy}
                style={buttonStyle}
                onClick={() =>
                  void run(() => window.agentOs.runtime.requestManagedPairing(device.discoveryId))
                }
              >
                {t('settings.nodes.requestControl')}
              </button>
            </div>
          ))
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            style={{ ...fieldStyle, flex: 1 }}
            value={manualEndpoint}
            onChange={(event) => setManualEndpoint(event.target.value)}
            placeholder={t('settings.nodes.manualEndpointPlaceholder')}
          />
          <button
            disabled={busy || !manualEndpoint.trim()}
            style={buttonStyle}
            onClick={() =>
              void run(async () => {
                await window.agentOs.runtime.requestManagedPairingManual(manualEndpoint)
                setManualEndpoint('')
              })
            }
          >
            {t('settings.nodes.manualConnect')}
          </button>
        </div>
      </div>

      {liveSessions.map((session) => {
        const isManaged = session.role === 'managed'
        const canApprove = isManaged && session.state === 'awaiting_local_approval'
        const root = approvalRoots[session.id] ?? ''
        return (
          <div
            key={session.id}
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--status-waiting)',
              borderRadius: 12,
              padding: '14px 16px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {isManaged
                    ? t('settings.nodes.incomingPairing', { name: session.peerDisplayName })
                    : t('settings.nodes.outgoingPairing', { name: session.peerDisplayName })}
                </div>
                <div
                  style={{
                    fontSize: 26,
                    fontWeight: 700,
                    letterSpacing: '.16em',
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: 6
                  }}
                >
                  {session.shortCode}
                </div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: 4,
                    wordBreak: 'break-all'
                  }}
                >
                  {t('settings.nodes.peerFingerprint', {
                    fingerprint: session.peerPublicKeyFingerprint
                  })}
                </div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--font-mono)',
                    wordBreak: 'break-all'
                  }}
                >
                  TLS · {session.certificateFingerprint}
                </div>
              </div>
              {!isManaged && session.state === 'requested' && (
                <button
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.agentOs.runtime.confirmManagedPairing(session.id))
                  }
                >
                  {t('settings.nodes.codeMatches')}
                </button>
              )}
              {isManaged && !canApprove && (
                <span style={{ fontSize: 11, color: 'var(--status-waiting)' }}>
                  {session.state === 'awaiting_ack'
                    ? t('settings.nodes.waitingPairingAck')
                    : t('settings.nodes.waitingCodeConfirmation')}
                </span>
              )}
            </div>
            {canApprove && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border-subtle)'
                }}
              >
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
                  {t('settings.nodes.approvalScopeDesc')}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input
                    style={{ ...fieldStyle, flex: 1 }}
                    value={root}
                    readOnly
                    placeholder={t('settings.nodes.chooseAllowedRoot')}
                  />
                  <button style={buttonStyle} onClick={() => void chooseRoot(session.id)}>
                    {t('settings.nodes.chooseDirectory')}
                  </button>
                </div>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                    marginTop: 8
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allowSessions[session.id] === true}
                    onChange={(event) =>
                      setAllowSessions((current) => ({
                        ...current,
                        [session.id]: event.target.checked
                      }))
                    }
                  />
                  {t('settings.nodes.allowSessionControl')}
                </label>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                  <button
                    style={buttonStyle}
                    onClick={() =>
                      void run(() => window.agentOs.runtime.rejectManagedPairing(session.id))
                    }
                  >
                    {t('settings.nodes.rejectPairing')}
                  </button>
                  <button
                    style={{
                      ...buttonStyle,
                      background: 'var(--text-primary)',
                      color: 'var(--bg-surface)'
                    }}
                    disabled={busy || !root}
                    onClick={() =>
                      void run(() =>
                        window.agentOs.runtime.approveManagedPairing(session.id, {
                          capabilities: [
                            ...MANAGED_READ_CAPABILITIES,
                            ...(allowSessions[session.id] ? MANAGED_SESSION_CAPABILITIES : [])
                          ],
                          allowedRoots: [root]
                        })
                      )
                    }
                  >
                    {t('settings.nodes.approvePairing')}
                  </button>
                </div>
              </div>
            )}
            {session.error && (
              <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 8 }}>
                {session.error}
              </div>
            )}
          </div>
        )
      })}

      {((snapshot?.outboundConnections.length ?? 0) > 0 ||
        (snapshot?.inboundAuthorizations.length ?? 0) > 0) && (
        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: '14px 16px'
          }}
        >
          <div
            style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}
          >
            {t('settings.nodes.guiAuthorizations')}
          </div>
          {snapshot?.outboundConnections.map((connection) => (
            <div
              key={connection.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--border-subtle)'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  {t('settings.nodes.controlsDevice', { name: connection.managedDisplayName })}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  {connection.connection}
                  {connection.error ? ` · ${connection.error}` : ''}
                </div>
              </div>
              <button
                style={buttonStyle}
                onClick={() =>
                  void run(() =>
                    window.agentOs.runtime.setManagedConnectionEnabled(
                      connection.id,
                      !connection.enabled
                    )
                  )
                }
              >
                {connection.enabled ? t('common.action.disable') : t('common.action.enable')}
              </button>
              <button
                style={buttonStyle}
                onClick={() =>
                  void run(() => window.agentOs.runtime.removeManagedConnection(connection.id))
                }
              >
                {t('common.action.remove')}
              </button>
            </div>
          ))}
          {snapshot?.inboundAuthorizations.map((authorization) => (
            <div
              key={authorization.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px solid var(--border-subtle)'
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
                  {t('settings.nodes.controlledByDevice', {
                    name: authorization.controllerDisplayName
                  })}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  {authorization.status} · {authorization.allowedRoots.join(', ')}
                </div>
              </div>
              {authorization.status !== 'revoked' && (
                <button
                  style={buttonStyle}
                  onClick={() =>
                    void run(() =>
                      window.agentOs.runtime.setManagedDeviceAuthorizationStatus(
                        authorization.id,
                        authorization.status === 'active' ? 'paused' : 'active'
                      )
                    )
                  }
                >
                  {authorization.status === 'active'
                    ? t('settings.nodes.pauseAuthorization')
                    : t('settings.nodes.resumeAuthorization')}
                </button>
              )}
              {authorization.status !== 'revoked' && (
                <button
                  style={buttonStyle}
                  onClick={() =>
                    void run(() =>
                      window.agentOs.runtime.setManagedDeviceAuthorizationStatus(
                        authorization.id,
                        'revoked'
                      )
                    )
                  }
                >
                  {t('settings.nodes.revokeAuthorization')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SettingsNodes(): React.JSX.Element {
  const { t } = useT()
  const [gateway, setGateway] = useState<NodeGatewayStatus | null>(null)
  const [nodes, setNodes] = useState<RemoteNode[]>([])
  const [statuses, setStatuses] = useState<Record<string, RemoteNodeStatus>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [enrollment, setEnrollment] = useState<CreateEnrollmentResult | null>(null)
  const [targetPlatform, setTargetPlatform] = useState<NodePlatform>('mac-arm64')
  const [releaseReadiness, setReleaseReadiness] = useState<NodeReleaseReadiness | null>(null)
  const [clock, setClock] = useState(() => Date.now())

  // 本机已知 CLI 目录：用于在每个节点下展示「已装点亮 / 未装置灰」的图标瓦片
  const { results, scan } = useToolsStore()
  const catalog = results.filter((c) => c.toolId !== 'shell')

  useEffect(() => {
    if (results.length === 0) void scan()
  }, [results.length, scan])

  const refresh = useCallback(() => {
    void window.agentOs.runtime
      .nodeGatewayStatus()
      .then(setGateway)
      .catch(() => {})
    void window.agentOs.runtime
      .nodeReleaseReadiness()
      .then(setReleaseReadiness)
      .catch(() => setReleaseReadiness(null))
    void window.agentOs.runtime
      .listRemoteNodes()
      .then(setNodes)
      .catch(() => {})
    void window.agentOs.runtime
      .remoteNodeStatuses()
      .then((arr) => setStatuses(Object.fromEntries(arr.map((s) => [s.id, s]))))
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const off = window.agentOs.events.onRemoteNodeStateChanged((s) =>
      setStatuses((prev) => ({ ...prev, [s.id]: s }))
    )
    return off
  }, [refresh])

  useEffect(() => {
    if (!enrollment) return
    const timer = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [enrollment])

  const nodeStatusLabel = (c: RemoteNodeStatus['connection'] | undefined): string => {
    if (c === 'connected') return t('settings.nodes.status.online')
    if (c === 'connecting') return t('settings.nodes.status.connecting')
    if (c === 'error') return t('settings.nodes.status.error')
    if (c === 'disabled') return t('settings.nodes.status.disabled')
    return t('settings.nodes.status.offline')
  }

  const toggleGateway = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const res = await window.agentOs.runtime.setNodeGatewayEnabled(enabled)
      if (!res.ok) setError(res.error || t('settings.nodes.operationFailed'))
      if (!enabled) setEnrollment(null)
      refresh()
    } finally {
      setBusy(false)
    }
  }

  const addNode = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const platformState = releaseReadiness?.platforms[targetPlatform]
      if (!platformState?.ready) {
        throw new Error(
          releaseReadiness?.error ||
            t('settings.nodes.releaseNotReady', { version: releaseReadiness?.version ?? '?' })
        )
      }
      const res = await window.agentOs.runtime.createNodeEnrollment({
        label: label.trim() || undefined,
        platform: targetPlatform
      })
      setEnrollment(res)
      setLabel('')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('settings.nodes.generateFailed'))
    } finally {
      setBusy(false)
    }
  }

  const changeGatewayHost = async (host: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.agentOs.runtime.setNodeGatewayAdvertiseHost(host)
      if (!result.ok) setError(result.error || t('settings.nodes.operationFailed'))
      refresh()
      setEnrollment(null)
    } finally {
      setBusy(false)
    }
  }

  const updateNodeEnabled = (id: string, enabled: boolean): void => {
    void window.agentOs.runtime
      .setRemoteNodeEnabled(id, enabled)
      .then((res) =>
        res.ok ? refresh() : setError(res.error || t('settings.nodes.updateNodeFailed'))
      )
      .catch((e) => setError(e instanceof Error ? e.message : t('settings.nodes.updateNodeFailed')))
  }

  const removeNode = (id: string): void => {
    void window.agentOs.runtime
      .removeRemoteNode(id)
      .then(refresh)
      .catch((e) => setError(e instanceof Error ? e.message : t('settings.nodes.removeNodeFailed')))
  }

  const on = gateway?.enabled === true
  const selectedRelease = releaseReadiness?.platforms[targetPlatform]
  const enrollmentRemainingMs = enrollment ? Date.parse(enrollment.expiresAt) - clock : 0
  const enrollmentExpired = Boolean(enrollment && enrollmentRemainingMs <= 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <ManagedGuiPairingPanel onGatewayChanged={refresh} />
      {/* 远程托管开关 */}
      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          padding: '16px 20px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('settings.nodes.title')}
            </div>
            <div
              style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 2 }}
            >
              {t('settings.nodes.desc')}
            </div>
          </div>
          <button
            onClick={() => void toggleGateway(!on)}
            disabled={busy}
            style={{
              height: 32,
              padding: '0 16px',
              borderRadius: 8,
              background: on ? 'var(--bg-active)' : 'var(--text-primary)',
              color: on ? 'var(--text-secondary)' : 'var(--bg-surface)',
              border: on ? '1px solid var(--border-medium)' : 'none',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              font: 'inherit'
            }}
          >
            {on ? t('settings.nodes.turnOff') : t('settings.nodes.turnOn')}
          </button>
        </div>
        {on && gateway && (
          <>
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
                marginTop: 10
              }}
            >
              {t('settings.nodes.listening', {
                hostPort: `${gateway.host}:${gateway.port}`,
                fingerprint: gateway.fingerprint.slice(0, 17)
              })}
            </div>
            {(gateway.hostCandidates?.length ?? 0) > 1 && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 8,
                  fontSize: 11,
                  color: 'var(--text-muted)'
                }}
              >
                {t('settings.nodes.lanInterfaceLabel')}
                <select
                  value={gateway.host}
                  disabled={busy}
                  onChange={(event) => void changeGatewayHost(event.target.value)}
                  style={{ ...fieldStyle, width: 220, height: 28 }}
                >
                  {gateway.hostCandidates?.map((candidate) => (
                    <option
                      key={`${candidate.interfaceName}:${candidate.address}`}
                      value={candidate.address}
                    >
                      {candidate.interfaceName} · {candidate.address}
                      {candidate.recommended ? ` · ${t('settings.nodes.recommended')}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {gateway?.error && (
          <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 8 }}>
            {t('settings.nodes.gatewayDown', { error: gateway.error })}
          </div>
        )}
        {error && (
          <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 8 }}>{error}</div>
        )}
      </div>

      {/* 添加节点：生成一行命令 */}
      {on && (
        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            padding: '16px 20px'
          }}
        >
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--text-primary)',
              marginBottom: 10
            }}
          >
            {t('settings.nodes.addNode')}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              style={{ ...fieldStyle, flex: '1 1 auto' }}
              placeholder={t('settings.nodes.aliasPlaceholder')}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <select
              style={{ ...fieldStyle, flex: '0 0 172px' }}
              value={targetPlatform}
              onChange={(event) => {
                setTargetPlatform(event.target.value as NodePlatform)
                setEnrollment(null)
              }}
            >
              <option value="mac-arm64">macOS · Apple Silicon</option>
              <option value="mac-x64">macOS · Intel</option>
              <option value="linux-arm64">Linux · ARM64</option>
              <option value="linux-x64">Linux · x64</option>
              <option value="win-x64">Windows · x64</option>
            </select>
            <button
              onClick={addNode}
              disabled={busy || !selectedRelease?.ready}
              style={{
                height: 32,
                padding: '0 16px',
                borderRadius: 8,
                background: 'var(--text-primary)',
                color: 'var(--bg-surface)',
                border: 'none',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                font: 'inherit'
              }}
            >
              {t('settings.nodes.generateCommand')}
            </button>
          </div>
          <div
            style={{
              fontSize: 11,
              color: selectedRelease?.ready ? 'var(--status-ok)' : 'var(--danger)',
              marginTop: 8
            }}
          >
            {selectedRelease?.ready
              ? t('settings.nodes.releaseReady', { version: releaseReadiness?.version ?? '' })
              : releaseReadiness?.error ||
                t('settings.nodes.releaseMissing', {
                  files: selectedRelease?.missing.join(', ') || t('settings.nodes.checkingRelease')
                })}
          </div>
          {enrollment && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                {t('settings.nodes.enrollmentHint')}
                <span style={{ color: 'var(--text-muted)' }}>
                  {t('settings.nodes.enrollmentValidity')}
                </span>
                {t('settings.nodes.enrollmentTail')}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: enrollmentExpired ? 'var(--danger)' : 'var(--status-waiting)',
                  marginTop: 6
                }}
              >
                {enrollmentExpired
                  ? t('settings.nodes.enrollmentExpired')
                  : t('settings.nodes.enrollmentWaiting', {
                      minutes: Math.max(1, Math.ceil(enrollmentRemainingMs / 60_000))
                    })}
              </div>
              {!enrollmentExpired &&
                (enrollment.platform === 'win-x64' ? (
                  <CopyRow
                    label={t('settings.nodes.powershellLabel')}
                    value={enrollment.commands.powershell}
                  />
                ) : (
                  <CopyRow label={t('settings.nodes.unixLabel')} value={enrollment.commands.unix} />
                ))}
            </div>
          )}
        </div>
      )}

      {/* 节点列表 */}
      {nodes.length === 0 ? (
        <div
          style={{
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 12,
            fontSize: 12,
            color: 'var(--text-muted)',
            padding: '18px 16px',
            textAlign: 'center'
          }}
        >
          {on ? t('settings.nodes.emptyOn') : t('settings.nodes.emptyOff')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {nodes.map((n) => {
            const st = statuses[n.id]
            const enabled = n.enabled !== false
            const connected = st?.connection === 'connected'
            const agents = st?.agents ?? []
            const agentById = new Map(agents.map((a) => [a.id, a]))
            const tiles = buildRemoteAgentTiles(agents, catalog)
            return (
              <div
                key={n.id}
                style={{
                  background: 'var(--bg-panel)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 12,
                  padding: '14px 16px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: nodeStatusColor(st?.connection),
                      flexShrink: 0
                    }}
                    title={nodeStatusLabel(st?.connection)}
                    aria-label={t('settings.nodes.connectionStatusAria', {
                      status: nodeStatusLabel(st?.connection)
                    })}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <NodeLabel node={n} onChange={refresh} onError={setError} />
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--text-muted)',
                        fontFamily: 'var(--font-mono)'
                      }}
                    >
                      {(st?.platform || n.platform) ?? t('settings.nodes.unknownPlatform')}
                      {n.hostVersion ? ` · v${n.hostVersion}` : ''}
                    </div>
                    {n.hostVersion && gateway?.version && n.hostVersion !== gateway.version && (
                      <div style={{ fontSize: 10.5, color: 'var(--status-waiting)', marginTop: 2 }}>
                        {t('settings.nodes.versionMismatch', {
                          node: n.hostVersion,
                          desktop: gateway.version
                        })}
                      </div>
                    )}
                    {st?.error && (
                      <div style={{ fontSize: 10.5, color: 'var(--danger)', marginTop: 2 }}>
                        {st.error}
                      </div>
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: nodeStatusColor(st?.connection)
                    }}
                    title={
                      st?.connection === 'connected' ? t('settings.nodes.connectedHint') : undefined
                    }
                  >
                    {nodeStatusLabel(st?.connection)}
                  </span>
                  <button
                    onClick={() => updateNodeEnabled(n.id, !enabled)}
                    style={{
                      height: 28,
                      padding: '0 12px',
                      borderRadius: 7,
                      background: 'var(--bg-active)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border-medium)',
                      fontSize: 11.5,
                      cursor: 'pointer',
                      font: 'inherit'
                    }}
                  >
                    {enabled ? t('common.action.disable') : t('common.action.enable')}
                  </button>
                  <button
                    onClick={() => removeNode(n.id)}
                    style={{
                      height: 28,
                      padding: '0 12px',
                      borderRadius: 7,
                      background: 'var(--bg-active)',
                      color: 'var(--text-secondary)',
                      border: '1px solid var(--border-medium)',
                      fontSize: 11.5,
                      cursor: 'pointer',
                      font: 'inherit'
                    }}
                  >
                    {t('common.action.remove')}
                  </button>
                </div>
                {connected ? (
                  tiles.length > 0 ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(158px, 1fr))',
                        gap: 8,
                        marginTop: 12,
                        alignItems: 'start'
                      }}
                    >
                      {tiles.map((t) => (
                        <NodeAgentTile
                          key={t.toolId}
                          nodeId={n.id}
                          toolId={t.toolId}
                          displayName={t.displayName}
                          agent={agentById.get(t.toolId)}
                          nodeActive={enabled && connected}
                          onChange={refresh}
                          onError={setError}
                        />
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
                      {t('settings.nodes.noAgentsReported')}
                    </div>
                  )
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
                    {st?.connection === 'disabled'
                      ? t('settings.nodes.disabledHint')
                      : t('settings.nodes.offlineHint')}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── 消息网关（SPEC-034）─────────────────────────────────────────────────────

// 渠道高清 SVG 徽标。飞书/QQ 用 svglogo.top 官方彩色 SVG；Discord/Telegram 该站未收录，
// 用 simple-icons / IconPark 官方单色路径（白字 glyph 配品牌色砖）。均为真 SVG，非字体图标。
const CHANNEL_TILE: Partial<Record<ChannelPlatform, string>> = {
  discord: 'linear-gradient(135deg,#7b7cff,#4f46e5)',
  telegram: 'linear-gradient(135deg,#56c7ff,#229ed9)',
  wechat: 'var(--status-ok)',
  wecom: 'var(--status-ok)',
  whatsapp: 'var(--bg-active)'
}

function ChannelGlyph({
  platform,
  size
}: {
  platform: ChannelPlatform
  size: number
}): React.JSX.Element {
  switch (platform) {
    case 'feishu':
      return (
        <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
          <path
            d="M10 8c0 1 7 3.5 14.745 16.744 0 0 4.184-4.363 6.255-5.744 1.5-1 2.712-1.332 2.712-1.332C33.712 15.156 29.5 8 28 8z"
            fill="#00d6b9"
          />
          <path
            d="M43.5 18.5c-1-.667-3.65-1.771-6.5-1.5a15 15 0 0 0-3.288.668S32.5 18 31 19c-2.07 1.38-6.255 5.744-6.255 5.744-1.428 1.397-3.05 2.732-5.245 3.756 0 0 7 3 11.5 3 5.063 0 7-3.5 7-3.5 1.5-3.305 3.5-7 5.5-9.5"
            fill="#163c9a"
          />
          <path
            d="M4 17.5v17c0 1 6 5.5 15 5.5 10 0 17.05-7.705 19-12 0 0-1.937 3.5-7 3.5-4.5 0-11.5-3-11.5-3-5.117-2.239-10.03-6.577-12.906-9.117C4.974 17.953 4 17.093 4 17.5"
            fill="#3370ff"
          />
        </svg>
      )
    case 'qq':
      return (
        <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M12 31s-3 4.5-3.5 4c-.803-.803.062-6.622 1.5-11 0 0 2 1 4.5 1.5 0 0-1.74 9.46 4.268 13.242C20.768 40 24 40 24 40s3.232 0 5.232-1.258C35.241 34.96 33.5 25.5 33.5 25.5 36 25 38 24 38 24c1.438 4.378 2.303 10.197 1.5 11-.5.5-3.5-4-3.5-4s.232 4.776-3.392 7.742c0 0-3.376 2.758-8.608 2.758s-8.608-2.758-8.608-2.758C11.768 35.776 12 31 12 31m0-11C12 7 19 4 24 4s12 3 12 16c-4.033.782-7.5 1.5-12 1.5s-7.967-.718-12-1.5m5-2.5c0 1 3.5 2.5 7 2.5s7-1.5 7-2.5-5-1.5-7-1.5-7 .5-7 1.5"
            fill="#1c1c1e"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M35.732 41.5c-1 .5-8.232.5-11.732 0 5.232 0 8.608-2.758 8.608-2.758-.081.066 5.124 1.758 3.124 2.758"
            fill="#ffb800"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M24 41.5c-3.5.5-10.732.5-11.732 0-2-1 3.205-2.692 3.124-2.758 0 0 3.376 2.758 8.608 2.758"
            fill="#ffb800"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M10 24c.564-1.718 1.436-3.014 2-4 4.033.782 7.5 1.5 12 1.5s7.967-.718 12-1.5c.564.986 1.436 2.282 2 4 0 0-2 1-4.5 1.5s-5.5 1-9.5 1q-1.183-.001-2.257-.055c0 1.515 0 2.503.016 4.374a.2.2 0 0 1-.143.192c-1.69.479-3.579.463-4.995-.454a.19.19 0 0 1-.088-.16c-.033-1.885-.032-2.435.002-4.52A65 65 0 0 1 14.5 25.5C12 25 10 24 10 24"
            fill="#ff4f4f"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M17 17.5c0 1 3.5 2.5 7 2.5s7-1.5 7-2.5-5-1.5-7-1.5-7 .5-7 1.5"
            fill="#ffb800"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M14.5 25.5a66 66 0 0 0 2.035.377 102 102 0 0 0-.002 4.52.19.19 0 0 0 .088.16c1.416.917 3.305.933 4.995.454a.2.2 0 0 0 .143-.192c-.016-1.87-.016-2.859-.016-4.374q1.073.054 2.257.055c4 0 7-.5 9.5-1 0 0 1.74 9.46-4.268 13.242C27.232 40 24 40 24 40s-3.232 0-5.232-1.258C12.759 34.96 14.5 25.5 14.5 25.5"
            fill="#ffffff"
          />
          <path
            d="M21 14c1.105 0 2-1.343 2-3s-.895-3-2-3-2 1.343-2 3 .895 3 2 3m6 0c1.105 0 2-1.343 2-3s-.895-3-2-3-2 1.343-2 3 .895 3 2 3"
            fill="#ffffff"
          />
          <path
            d="M21 12.438c.552 0 1-.546 1-1.22 0-.672-.448-1.218-1-1.218s-1 .546-1 1.219.448 1.219 1 1.219m6 0c.552 0 1-.546 1-1.22 0-.672-.448-1.218-1-1.218s-1 .546-1 1.219.448 1.219 1 1.219"
            fill="#1c1c1e"
          />
          <path
            d="M26 11c.5-.5 1.5-.5 2 0"
            stroke="#1c1c1e"
            strokeWidth="0.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'discord':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="#fff" aria-hidden>
          <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.0778.0778 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
        </svg>
      )
    case 'telegram':
      return (
        <svg width={size} height={size} viewBox="0 0 48 48" fill="#fff" aria-hidden>
          <path d="M41.4193 7.30899C41.4193 7.30899 45.3046 5.79399 44.9808 9.47328C44.8729 10.9883 43.9016 16.2908 43.1461 22.0262L40.5559 39.0159C40.5559 39.0159 40.3401 41.5048 38.3974 41.9377C36.4547 42.3705 33.5408 40.4227 33.0011 39.9898C32.5694 39.6652 24.9068 34.7955 22.2086 32.4148C21.4531 31.7655 20.5897 30.4669 22.3165 28.9519L33.6487 18.1305C34.9438 16.8319 36.2389 13.8019 30.8426 17.4812L15.7331 27.7616C15.7331 27.7616 14.0063 28.8437 10.7686 27.8698L3.75342 25.7055C3.75342 25.7055 1.16321 24.0823 5.58815 22.459C16.3807 17.3729 29.6555 12.1786 41.4193 7.30899Z" />
        </svg>
      )
    case 'wecom':
      return (
        <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
          <path
            d="M8 12h25a7 7 0 017 7v8a7 7 0 01-7 7H21l-8 6 2-6H8a7 7 0 01-7-7v-8a7 7 0 017-7z"
            fill="currentColor"
          />
          <circle cx="14" cy="23" r="2" fill="var(--bg-card)" />
          <circle cx="22" cy="23" r="2" fill="var(--bg-card)" />
          <circle cx="30" cy="23" r="2" fill="var(--bg-card)" />
        </svg>
      )
    case 'wechat':
      return (
        <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
          <path
            d="M5 20c0-7 7-12 16-12s16 5 16 12-7 12-16 12c-2 0-4-.3-6-1l-7 4 2-7c-3-2-5-5-5-8Z"
            fill="currentColor"
          />
          <path
            d="M25 29c0-6 5-10 12-10 6 0 10 4 10 9 0 3-1 6-4 7l2 6-6-3h-2c-7 0-12-4-12-9Z"
            fill="var(--bg-card)"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="16" cy="19" r="2" fill="var(--bg-card)" />
          <circle cx="26" cy="19" r="2" fill="var(--bg-card)" />
          <circle cx="34" cy="28" r="1.5" fill="currentColor" />
          <circle cx="40" cy="28" r="1.5" fill="currentColor" />
        </svg>
      )
    case 'whatsapp':
      return (
        <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
          <circle cx="24" cy="22" r="17" stroke="currentColor" strokeWidth="4" />
          <path
            d="M13 39l2-8M18 16c1 8 6 13 14 15"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
      )
  }
}

// logo 砖：飞书/QQ 固定白底承载官方彩色 logo（暗色主题也保持白底，确保 logo 可读）；
// Discord/Telegram 用品牌色渐变砖 + 白色官方 glyph。
function ChannelLogo({
  platform,
  size = 44
}: {
  platform: ChannelPlatform
  size?: number
}): React.JSX.Element {
  const colorOnWhite = platform === 'feishu' || platform === 'qq'
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: Math.min(10, Math.round(size * 0.22)),
        background: colorOnWhite ? '#ffffff' : CHANNEL_TILE[platform],
        color: colorOnWhite ? 'var(--text-primary)' : 'var(--bg-surface)',
        border: colorOnWhite ? '1px solid var(--border-medium)' : 'none',
        boxShadow: colorOnWhite ? 'var(--shadow-card)' : 'var(--shadow-hover-lift)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        overflow: 'hidden'
      }}
    >
      <ChannelGlyph platform={platform} size={Math.round(size * 0.64)} />
    </div>
  )
}

const IcQr = ({ size = 16 }: { size?: number }): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
    <path
      d="M14 14h3.5v3.5H14zM20 14v3.5M14 20.5h3.5M20 18v2.5"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const IcKey = ({ size = 16 }: { size?: number }): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="1.7" />
    <path
      d="M10.9 12.1 20 3M16.8 6.2 19 8.4M13.9 9.1l2.1 2.1"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)
const IcLink = ({ size = 16 }: { size?: number }): React.JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9.5 14.5l5-5" />
    <path d="M8 11l-2.1 2.1a3 3 0 004.2 4.2L12.2 15" />
    <path d="M16 13l2.1-2.1a3 3 0 00-4.2-4.2L12 8.5" />
  </svg>
)
const IcAt = ({ size = 16 }: { size?: number }): React.JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3.5" />
    <path d="M15.5 12v1.2a2 2 0 003.9.6V12a7.4 7.4 0 10-2.6 5.7" />
  </svg>
)
const IcSpark = ({ size = 13 }: { size?: number }): React.JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
  </svg>
)

// 小图标容器（分区图标 / 方法行图标共用），跟随设置页 token。
function IconChip({
  size = 24,
  children
}: {
  size?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--radius-md)',
        background: 'var(--accent-soft)',
        color: 'var(--status-resumable)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0
      }}
    >
      {children}
    </span>
  )
}

// 渠道接入状态徽标。
function StatusBadge({
  kind,
  children
}: {
  kind: 'green' | 'yellow' | 'red' | 'gray'
  children: React.ReactNode
}): React.JSX.Element {
  const color =
    kind === 'green'
      ? 'var(--status-ok)'
      : kind === 'yellow'
        ? 'var(--status-waiting)'
        : kind === 'red'
          ? 'var(--danger)'
          : 'var(--text-secondary)'
  const dotColor = kind === 'gray' ? 'var(--text-muted)' : color
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 22,
        padding: '0 9px',
        borderRadius: 7,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        flexShrink: 0,
        color,
        background:
          kind === 'gray' ? 'var(--bg-active)' : `color-mix(in srgb,${color} 15%,transparent)`,
        border:
          kind === 'gray'
            ? '1px solid var(--border-medium)'
            : `1px solid color-mix(in srgb,${color} 32%,transparent)`
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor }} />
      {children}
    </span>
  )
}

// 连接信息键值行（固定标签宽 + 值）。
function InfoField({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '82px 1fr',
        alignItems: 'center',
        gap: 10,
        fontSize: 12,
        minWidth: 0
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span
        style={{
          color: 'var(--text-primary)',
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0
        }}
      >
        {value}
      </span>
    </div>
  )
}

// 分区标题（图标 + 文字）。
function SectionTitle({
  icon,
  children
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 12,
        fontSize: 13,
        fontWeight: 650,
        color: 'var(--text-primary)'
      }}
    >
      <IconChip size={22}>{icon}</IconChip>
      {children}
    </div>
  )
}

function ChannelCredentialField({
  label,
  requirement,
  children
}: {
  label: string
  requirement: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 6,
          fontSize: 11.5,
          color: 'var(--text-secondary)',
          fontWeight: 600
        }}
      >
        {label}
        <span style={{ color: 'var(--text-muted)', fontSize: 10.5, fontWeight: 400 }}>
          {requirement}
        </span>
      </span>
      {children}
    </label>
  )
}

/** 渠道目录：飞书 / 微信 / 企业微信 / Telegram 已可本地直连；WhatsApp 需官方 Cloud API + 公网 webhook + 政策确认。
 * name/enName 为平台专有名词固定不译；tagline/desc 由 settings.channels.* 在渲染时翻译。 */
const CHANNEL_CATALOG: Array<{
  platform: ChannelPlatform
  name: string
  enName: string
  available: boolean
}> = [
  { platform: 'feishu', name: '飞书', enName: 'Feishu', available: true },
  { platform: 'wechat', name: '微信', enName: 'WeChat', available: true },
  { platform: 'wecom', name: '企业微信', enName: 'WeCom', available: true },
  { platform: 'telegram', name: 'Telegram', enName: 'Telegram', available: true },
  { platform: 'whatsapp', name: 'WhatsApp', enName: 'Business Platform', available: true },
  { platform: 'discord', name: 'Discord', enName: 'Discord', available: false },
  { platform: 'qq', name: 'QQ', enName: 'QQ', available: false }
]

function SettingsChannels(): React.JSX.Element {
  const { t } = useT()
  const [accounts, setAccounts] = useState<ChannelAccount[]>([])
  const [selectedAcl, setSelectedAcl] = useState<ChannelAcl | null>(null)
  const [selectedAclAccountId, setSelectedAclAccountId] = useState<string | null>(null)
  const [aclAllowlistInput, setAclAllowlistInput] = useState('')
  const [aclFeedback, setAclFeedback] = useState<{ text: string; error: boolean } | null>(null)
  const [pairingRequests, setPairingRequests] = useState<ChannelPairingRequest[]>([])

  const experienceLabel = (state: ChannelExperienceState, compact = false): string => {
    switch (state) {
      case 'disabled':
        return t('settings.channels.status.disabled')
      case 'error':
        return t('settings.channels.status.error')
      case 'disconnected':
        return t('settings.channels.status.disconnected')
      case 'connecting':
        return t('settings.channels.status.connecting')
      case 'awaiting-first-message':
        return t(
          compact
            ? 'settings.channels.status.awaitingFirstMessageShort'
            : 'settings.channels.status.awaitingFirstMessage'
        )
      case 'awaiting-completion':
        return t(
          compact
            ? 'settings.channels.status.awaitingCompletionShort'
            : 'settings.channels.status.awaitingCompletion'
        )
      case 'verified':
        return t(
          compact ? 'settings.channels.status.verifiedShort' : 'settings.channels.status.verified'
        )
    }
  }
  const experienceColor = (state: ChannelExperienceState): string => {
    switch (state) {
      case 'verified':
        return 'var(--status-ok)'
      case 'error':
        return 'var(--danger)'
      case 'connecting':
      case 'awaiting-first-message':
      case 'awaiting-completion':
        return 'var(--status-waiting)'
      case 'disabled':
      case 'disconnected':
        return 'var(--text-muted)'
    }
  }
  const experienceBadgeKind = (
    state: ChannelExperienceState
  ): 'green' | 'yellow' | 'red' | 'gray' => {
    switch (state) {
      case 'verified':
        return 'green'
      case 'error':
        return 'red'
      case 'connecting':
      case 'awaiting-first-message':
      case 'awaiting-completion':
        return 'yellow'
      case 'disabled':
      case 'disconnected':
        return 'gray'
    }
  }
  const taglineFor = (p: ChannelPlatform): string =>
    p === 'feishu'
      ? t('settings.channels.tagline.feishu')
      : p === 'wechat'
        ? t('settings.channels.tagline.wechat')
        : p === 'wecom'
          ? t('settings.channels.tagline.wecom')
          : p === 'discord'
            ? t('settings.channels.tagline.discord')
            : p === 'telegram'
              ? t('settings.channels.tagline.telegram')
              : p === 'whatsapp'
                ? t('settings.channels.tagline.whatsapp')
                : t('settings.channels.tagline.qq')
  const descFor = (p: ChannelPlatform): string =>
    p === 'feishu'
      ? t('settings.channels.desc.feishu')
      : p === 'wechat'
        ? t('settings.channels.desc.wechat')
        : p === 'wecom'
          ? t('settings.channels.desc.wecom')
          : p === 'telegram'
            ? t('settings.channels.desc.telegram')
            : p === 'whatsapp'
              ? t('settings.channels.desc.whatsapp')
              : t('settings.channels.desc.comingSoon')
  const [scanning, setScanning] = useState(false)
  const [qr, setQr] = useState<{ url: string; expireIn: number } | null>(null)
  const [qrImg, setQrImg] = useState<string | null>(null)
  const scanCancelRequestedRef = useRef(false)
  const [scanVerificationPrompt, setScanVerificationPrompt] = useState<string | null>(null)
  const [scanVerificationCode, setScanVerificationCode] = useState('')
  const [scanError, setScanError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showManual, setShowManual] = useState(false)
  const manualFormRef = useRef<HTMLDivElement | null>(null)
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null)
  const [selected, setSelected] = useState<ChannelPlatform>('feishu')
  const [selectedAccountId, setSelectedAccountId] = useState<string>()
  const [addingAccount, setAddingAccount] = useState(false)
  const [alias, setAlias] = useState('')
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [whatsappAppSecret, setWhatsappAppSecret] = useState('')
  const [whatsappVerifyToken, setWhatsappVerifyToken] = useState('')
  const [whatsappWebhookUrl, setWhatsappWebhookUrl] = useState('')
  const [whatsappWebhookPort, setWhatsappWebhookPort] = useState('8788')
  const [whatsappPolicyBasis, setWhatsappPolicyBasis] = useState('')
  const [whatsappPolicyConfirmed, setWhatsappPolicyConfirmed] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)

  useEffect(() => {
    if (!showManual) return
    const frame = window.requestAnimationFrame(() => {
      manualFormRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selected, showManual])

  const refresh = useCallback(() => {
    void window.agentOs.channels
      .listAccounts()
      .then(setAccounts)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const offState = window.agentOs.events.onChannelAccountStateChanged((account) => {
      setAccounts((prev) => {
        const idx = prev.findIndex((a) => a.id === account.id)
        if (idx === -1) return [...prev, account]
        const next = [...prev]
        next[idx] = account
        return next
      })
    })
    const offQr = window.agentOs.events.onChannelsScanQr((q) => {
      if (q.platform === 'feishu' || q.platform === 'wechat') setSelected(q.platform)
      setAddingAccount(true)
      setQr(q)
      setScanVerificationPrompt(null)
      setScanVerificationCode('')
      setScanning(true)
    })
    const offVerification = window.agentOs.events.onChannelsScanVerification((verification) => {
      if (verification.platform === 'feishu' || verification.platform === 'wechat') {
        setSelected(verification.platform)
      }
      setAddingAccount(true)
      setScanVerificationPrompt(verification.prompt)
      setScanVerificationCode('')
      setScanning(true)
    })
    const offResult = window.agentOs.events.onChannelsScanResult((r) => {
      const cancelRequested = scanCancelRequestedRef.current
      scanCancelRequestedRef.current = false
      setScanning(false)
      setQr(null)
      setScanVerificationPrompt(null)
      setScanVerificationCode('')
      if (r.ok) {
        setScanError(null)
        setAddingAccount(false)
        if (r.accountId) setSelectedAccountId(r.accountId)
        refresh()
      } else if (cancelRequested) {
        setAddingAccount(false)
        setScanError(null)
      } else {
        setScanError(r.error || t('settings.channels.scanFailed'))
      }
    })
    return () => {
      offState()
      offQr()
      offVerification()
      offResult()
    }
  }, [refresh])

  // 把扫码 URL 渲染成二维码图片（qrcode 库浏览器端可用，离线、URL 不外泄）。
  useEffect(() => {
    if (!qr) {
      setQrImg(null)
      return
    }
    let cancelled = false
    void QRCode.toDataURL(qr.url)
      .then((url) => {
        if (!cancelled) setQrImg(url)
      })
      .catch(() => {
        /* 渲染失败不阻塞：UI 仍可点链接打开 */
      })
    return () => {
      cancelled = true
    }
  }, [qr])

  const startScan = (): void => {
    if (selected !== 'feishu' && selected !== 'wechat') return
    scanCancelRequestedRef.current = false
    setAddingAccount(true)
    setScanning(true)
    setQr(null)
    setQrImg(null)
    setScanVerificationPrompt(null)
    setScanVerificationCode('')
    setScanError(null)
    void window.agentOs.channels.startFeishuScan(selected)
  }
  const cancelScan = (): void => {
    scanCancelRequestedRef.current = true
    setScanning(false)
    setQr(null)
    setQrImg(null)
    setAddingAccount(false)
    setScanVerificationPrompt(null)
    setScanVerificationCode('')
    void window.agentOs.channels.cancelFeishuScan()
  }
  const startManualAdd = (): void => {
    setAddingAccount(true)
    setShowManual(true)
    setScanError(null)
    setRemoveConfirmId(null)
    setShowSecrets(false)
  }
  const chooseAccountMethod = (): void => {
    setAddingAccount(true)
    setScanning(false)
    setQr(null)
    setQrImg(null)
    setScanVerificationPrompt(null)
    setScanVerificationCode('')
    setShowManual(false)
    setScanError(null)
    setRemoveConfirmId(null)
    setShowSecrets(false)
  }
  const cancelAddingAccount = (): void => {
    if (scanning) {
      scanCancelRequestedRef.current = true
      void window.agentOs.channels.cancelFeishuScan()
    }
    setAddingAccount(false)
    setScanning(false)
    setQr(null)
    setQrImg(null)
    setScanVerificationPrompt(null)
    setScanVerificationCode('')
    setShowManual(false)
    setScanError(null)
    setShowSecrets(false)
  }
  const submitScanVerification = (): void => {
    if (!/^\d{4,8}$/.test(scanVerificationCode.trim())) {
      setScanError(t('settings.channels.scanVerificationPlaceholder'))
      return
    }
    setScanError(null)
    void window.agentOs.channels.submitScanVerificationCode(scanVerificationCode.trim())
    setScanVerificationPrompt(null)
    setScanVerificationCode('')
  }
  const disconnect = (id: string): void => {
    setBusy(true)
    void window.agentOs.channels
      .removeAccount(id)
      .then(() => refresh())
      .finally(() => setBusy(false))
  }
  const toggleAccount = (id: string, enabled: boolean): void => {
    setBusy(true)
    setScanError(null)
    setRemoveConfirmId(null)
    void window.agentOs.channels
      .setAccountEnabled(id, enabled)
      .then((result) => {
        if (!result.ok) throw new Error(result.error || t('settings.channels.addFailed'))
        refresh()
      })
      .catch((error) =>
        setScanError(error instanceof Error ? error.message : t('settings.channels.addFailed'))
      )
      .finally(() => setBusy(false))
  }
  const reconnectAccount = (id: string): void => {
    setBusy(true)
    setScanError(null)
    void window.agentOs.channels
      .testConnection(id)
      .then((result) => {
        if (!result.ok) throw new Error(result.error || t('settings.channels.reconnectFailed'))
        refresh()
      })
      .catch((error) =>
        setScanError(
          error instanceof Error ? error.message : t('settings.channels.reconnectFailed')
        )
      )
      .finally(() => setBusy(false))
  }
  const resetManualForm = (): void => {
    setAppId('')
    setAppSecret('')
    setWhatsappAppSecret('')
    setWhatsappVerifyToken('')
    setWhatsappWebhookUrl('')
    setWhatsappWebhookPort('8788')
    setWhatsappPolicyBasis('')
    setWhatsappPolicyConfirmed(false)
    setAlias('')
    setShowSecrets(false)
  }
  const addManual = (): void => {
    const credentials: Record<string, string> =
      selected === 'telegram'
        ? { bot_token: appSecret.trim() }
        : selected === 'wecom'
          ? { bot_id: appId.trim(), secret: appSecret.trim() }
          : selected === 'whatsapp'
            ? {
                phone_number_id: appId.trim(),
                access_token: appSecret.trim(),
                app_secret: whatsappAppSecret.trim(),
                verify_token: whatsappVerifyToken.trim(),
                public_webhook_url: whatsappWebhookUrl.trim(),
                webhook_port: whatsappWebhookPort.trim(),
                graph_version: 'v23.0',
                policy_basis: whatsappPolicyBasis,
                policy_confirmed: whatsappPolicyConfirmed ? 'true' : ''
              }
            : { app_id: appId.trim(), app_secret: appSecret.trim() }
    if (Object.values(credentials).some((value) => !value)) {
      setScanError(
        selected === 'telegram'
          ? t('settings.channels.fillTelegramCredentials')
          : selected === 'wecom'
            ? t('settings.channels.fillWeComCredentials')
            : selected === 'whatsapp'
              ? t('settings.channels.fillWhatsAppCredentials')
              : t('settings.channels.fillCredentials')
      )
      return
    }
    setBusy(true)
    let accountCreated = false
    void window.agentOs.channels
      .addAccount({
        platform: selected,
        alias: alias.trim() || '机器人',
        credentials
      })
      .then(async (account) => {
        accountCreated = true
        setSelectedAccountId(account.id)
        setAccounts((previous) => [...previous.filter((item) => item.id !== account.id), account])
        const result = await window.agentOs.channels.setGatewayEnabled(true)
        if (!result.ok) throw new Error(result.error || t('settings.channels.addFailed'))
      })
      .then(() => {
        resetManualForm()
        setShowManual(false)
        setAddingAccount(false)
        refresh()
      })
      .catch((e) => {
        if (accountCreated) {
          resetManualForm()
          setShowManual(false)
          setAddingAccount(false)
          refresh()
        }
        setScanError(e instanceof Error ? e.message : t('settings.channels.addFailed'))
      })
      .finally(() => setBusy(false))
  }

  const selectedCatalog = CHANNEL_CATALOG.find((c) => c.platform === selected) ?? CHANNEL_CATALOG[0]
  const selectedAccounts = accounts.filter((account) => account.platform === selected)
  const connected = selectChannelAccount(selectedAccounts, selectedAccountId)
  const connectedAccountIdRef = useRef<string | null>(null)
  connectedAccountIdRef.current = connected?.id ?? null
  useEffect(() => {
    let cancelled = false
    setSelectedAcl(null)
    setSelectedAclAccountId(null)
    setAclAllowlistInput('')
    setAclFeedback(null)
    if (!connected) {
      return () => {
        cancelled = true
      }
    }
    const accountId = connected.id
    void window.agentOs.channels
      .getAcl(accountId)
      .then((acl) => {
        if (cancelled || connectedAccountIdRef.current !== accountId) return
        setSelectedAcl(acl)
        setSelectedAclAccountId(accountId)
        setAclAllowlistInput(acl.allowlist.join('\n'))
      })
      .catch(() => {
        if (cancelled || connectedAccountIdRef.current !== accountId) return
        setSelectedAcl(null)
        setSelectedAclAccountId(null)
        setAclAllowlistInput('')
      })
    return () => {
      cancelled = true
    }
  }, [connected?.id])
  useEffect(() => {
    if (!connected) {
      setPairingRequests([])
      return
    }
    let cancelled = false
    const accountId = connected.id
    // 账号切换时先清空旧请求；不能让旧账号内容在新账号首个 IPC 返回前短暂泄漏。
    setPairingRequests([])
    const refreshPairing = (): void => {
      void window.agentOs.channels
        .listPairingRequests(accountId)
        .then((requests) => {
          if (!cancelled && connectedAccountIdRef.current === accountId)
            setPairingRequests(requests)
        })
        .catch(() => {
          if (!cancelled && connectedAccountIdRef.current === accountId) setPairingRequests([])
        })
    }
    refreshPairing()
    const timer = window.setInterval(refreshPairing, 3_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [connected?.id])
  const connMaskedId = connected?.credentialHint ?? ''
  const connectedExperience = connected ? channelAccountExperience(connected) : undefined
  const headerExperience = channelHeaderExperience(connected, addingAccount)
  const onlineColor =
    headerExperience.mode === 'adding'
      ? 'var(--status-waiting)'
      : headerExperience.mode === 'account'
        ? experienceColor(headerExperience.state)
        : 'var(--text-muted)'
  const onlineText =
    headerExperience.mode === 'adding'
      ? t('settings.channels.addingAccountStatus')
      : headerExperience.mode === 'unconfigured'
        ? t('settings.channels.status.disconnected')
        : headerExperience.error
          ? `${experienceLabel(headerExperience.state)} · ${headerExperience.error}`
          : experienceLabel(headerExperience.state)
  const displayTime = (value?: string): string => (value ? new Date(value).toLocaleString() : '—')
  const connectedMethods =
    selected === 'telegram'
      ? [
          t('settings.channels.methodTelegramToken'),
          t('settings.channels.methodTelegramPolling'),
          t('settings.channels.methodTelegramMention')
        ]
      : selected === 'wechat'
        ? [
            t('settings.channels.methodWeChatOfficial'),
            t('settings.channels.methodWeChatPolling'),
            t('settings.channels.methodWeChatDirect')
          ]
        : selected === 'wecom'
          ? [
              t('settings.channels.methodWeComOfficial'),
              t('settings.channels.methodLongConnection'),
              t('settings.channels.methodWeComStream')
            ]
          : selected === 'whatsapp'
            ? [
                t('settings.channels.methodWhatsAppCloud'),
                t('settings.channels.methodWhatsAppWebhook'),
                t('settings.channels.methodWhatsAppSignature')
              ]
            : [
                t('settings.channels.methodScanCreate'),
                t('settings.channels.methodLongConnection'),
                t('settings.channels.methodAtBot')
              ]
  const saveAccessPolicy = (): void => {
    if (!connected || !selectedAcl?.mode || selectedAclAccountId !== connected.id) return
    const accountId = connected.id
    const allowlist = [
      ...new Set(
        aclAllowlistInput
          .split(/[\s,;]+/)
          .map((item) => item.trim())
          .filter(Boolean)
      )
    ]
    const next: ChannelAcl = {
      mode: selectedAcl.mode,
      ...(selectedAcl.ownerId ? { ownerId: selectedAcl.ownerId } : {}),
      allowlist: selectedAcl.mode === 'allowlist' ? allowlist : []
    }
    setBusy(true)
    setAclFeedback(null)
    void window.agentOs.channels
      .setAcl(accountId, next)
      .then(() => {
        if (connectedAccountIdRef.current !== accountId) return
        setSelectedAcl(next)
        setSelectedAclAccountId(accountId)
        setAclAllowlistInput(next.allowlist.join('\n'))
        setAclFeedback({ text: t('settings.channels.accessPolicySaved'), error: false })
      })
      .catch((error) => {
        if (connectedAccountIdRef.current !== accountId) return
        setAclFeedback({
          text:
            error instanceof Error ? error.message : t('settings.channels.accessPolicySaveFailed'),
          error: true
        })
      })
      .finally(() => setBusy(false))
  }
  const decidePairingRequest = (requestId: string, approve: boolean): void => {
    if (!connected) return
    const accountId = connected.id
    setBusy(true)
    setAclFeedback(null)
    const operation = approve
      ? window.agentOs.channels.approvePairingRequest(requestId)
      : window.agentOs.channels.rejectPairingRequest(requestId).then(() => null)
    void operation
      .then((acl) => {
        if (connectedAccountIdRef.current !== accountId) return
        if (acl) {
          setSelectedAcl(acl)
          setSelectedAclAccountId(accountId)
        }
        return window.agentOs.channels.listPairingRequests(accountId).then((requests) => {
          if (connectedAccountIdRef.current === accountId) setPairingRequests(requests)
        })
      })
      .catch((error) => {
        if (connectedAccountIdRef.current !== accountId) return
        setAclFeedback({
          text: error instanceof Error ? error.message : t('settings.channels.pairingActionFailed'),
          error: true
        })
      })
      .finally(() => setBusy(false))
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '248px minmax(0, 1fr)',
        gap: 12,
        alignItems: 'stretch'
      }}
    >
      {/* 左：消息渠道列表 */}
      <div style={channelPanelStyle}>
        <div
          style={{
            padding: '14px 14px 8px',
            fontSize: 13,
            fontWeight: 650,
            color: 'var(--text-secondary)'
          }}
        >
          {t('settings.channels.title')}
        </div>
        <div style={{ padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {CHANNEL_CATALOG.map((c) => {
            const sel = selected === c.platform
            const platformAccounts = accounts.filter((account) => account.platform === c.platform)
            const aggregateExperience = aggregateChannelExperience(platformAccounts)
            const policyRestricted = c.platform === 'whatsapp'
            const badgeText = aggregateExperience
              ? `${experienceLabel(aggregateExperience, true)}${platformAccounts.length > 1 ? ` · ${t('settings.channels.accountCount', { count: platformAccounts.length })}` : ''}`
              : policyRestricted
                ? t('settings.channels.policyRestricted')
                : !c.available
                  ? c.platform === 'qq'
                    ? t('settings.channels.stayTuned')
                    : t('settings.channels.comingSoon')
                  : t('settings.channels.notConnected')
            return (
              <button
                key={c.platform}
                className="channel-catalog-item"
                data-channel-platform={c.platform}
                aria-pressed={sel}
                onClick={() => {
                  if (!c.available) return
                  if (scanning) {
                    scanCancelRequestedRef.current = true
                    void window.agentOs.channels.cancelFeishuScan()
                  }
                  setSelected(c.platform)
                  setSelectedAccountId(undefined)
                  setAddingAccount(false)
                  setScanning(false)
                  setQr(null)
                  setShowManual(false)
                  setScanError(null)
                  setShowSecrets(false)
                }}
                disabled={!c.available}
                onPointerUp={(event) => {
                  // 鼠标/触摸点击不保留浏览器焦点描边；键盘 Tab 的 focus-visible 不受影响。
                  event.currentTarget.blur()
                }}
                style={{
                  ...channelItemStyle,
                  ...(sel ? channelItemActiveStyle : null),
                  ...(!c.available ? { opacity: 0.62, cursor: 'not-allowed' } : null)
                }}
              >
                <ChannelLogo platform={c.platform} size={34} />
                <span style={{ minWidth: 0, overflow: 'hidden' }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13,
                      fontWeight: 650,
                      color: 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {c.name}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      marginTop: 2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {taglineFor(c.platform)}
                  </span>
                </span>
                <StatusBadge
                  kind={aggregateExperience ? experienceBadgeKind(aggregateExperience) : 'gray'}
                >
                  {badgeText}
                </StatusBadge>
              </button>
            )
          })}
        </div>
        <div style={channelFooterStyle}>
          <IcSpark size={13} />
          <span>{t('settings.channels.footer')}</span>
        </div>
      </div>

      {/* 右：渠道详情 */}
      <div style={detailPanelStyle}>
        {!selectedCatalog.available ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              gap: 14
            }}
          >
            <ChannelLogo platform={selectedCatalog.platform} size={76} />
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                {selectedCatalog.name}
                {selectedCatalog.platform === 'whatsapp'
                  ? ` · ${t('settings.channels.policyRestricted')}`
                  : t('settings.channels.comingSoonSuffix')}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--text-muted)',
                  lineHeight: 1.6,
                  marginTop: 6,
                  maxWidth: 300
                }}
              >
                {descFor(selectedCatalog.platform)}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 头部 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <ChannelLogo platform={selectedCatalog.platform} size={42} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 4,
                    overflow: 'hidden'
                  }}
                >
                  <span
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      flexShrink: 0,
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {selectedCatalog.name}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--text-muted)',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    / {selectedCatalog.enName}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: onlineColor,
                    marginBottom: 5
                  }}
                >
                  <span
                    style={{ width: 7, height: 7, borderRadius: '50%', background: onlineColor }}
                  />
                  {onlineText}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {descFor(selectedCatalog.platform)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {addingAccount ? (
                  <button
                    onClick={cancelAddingAccount}
                    disabled={busy}
                    style={{ ...channelDangerBtn }}
                  >
                    {t('common.action.cancel')}
                  </button>
                ) : !connected ? (
                  <button
                    onClick={
                      selected === 'feishu' || selected === 'wechat' ? startScan : startManualAdd
                    }
                    style={{ ...channelsPrimaryBtn }}
                  >
                    {selected === 'feishu' || selected === 'wechat'
                      ? t('settings.channels.scanToConnect')
                      : t('settings.channels.configure')}
                  </button>
                ) : (
                  <button
                    onClick={
                      selected === 'feishu' || selected === 'wechat'
                        ? chooseAccountMethod
                        : startManualAdd
                    }
                    disabled={busy}
                    style={{ ...channelSecondaryBtn }}
                  >
                    {t('settings.channels.addAccount')}
                  </button>
                )}
                {!addingAccount && connected?.enabled && (
                  <>
                    {(!connected.status ||
                      connected.status === 'error' ||
                      connected.status === 'disconnected') && (
                      <button
                        onClick={() => reconnectAccount(connected.id)}
                        disabled={busy}
                        style={{ ...channelsPrimaryBtn }}
                      >
                        {t('settings.channels.reconnect')}
                      </button>
                    )}
                    <button
                      onClick={() => toggleAccount(connected.id, false)}
                      disabled={busy}
                      style={{ ...channelDangerBtn }}
                    >
                      {t('common.action.disable')}
                    </button>
                  </>
                )}
                {!addingAccount && connected && !connected.enabled && (
                  <>
                    <button
                      onClick={() => toggleAccount(connected.id, true)}
                      disabled={busy}
                      style={{ ...channelsPrimaryBtn }}
                    >
                      {t('common.action.enable')}
                    </button>
                    <button
                      onClick={() => {
                        if (removeConfirmId === connected.id) disconnect(connected.id)
                        else setRemoveConfirmId(connected.id)
                      }}
                      disabled={busy}
                      style={{ ...channelDangerBtn }}
                    >
                      {removeConfirmId === connected.id
                        ? t('settings.channels.confirmRemoveConfiguration')
                        : t('settings.channels.removeConfiguration')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {!addingAccount && selectedAccounts.length > 1 && connected && (
              <label
                style={{
                  display: 'grid',
                  gridTemplateColumns: '82px minmax(0, 1fr)',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 12
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>
                  {t('settings.channels.accountSelectorLabel')}
                </span>
                <select
                  style={{ ...fieldStyle, minWidth: 0 }}
                  value={connected.id}
                  onChange={(event) => {
                    setSelectedAccountId(event.target.value)
                    setRemoveConfirmId(null)
                    setScanError(null)
                  }}
                >
                  {selectedAccounts.map((account) => {
                    const state = channelAccountExperience(account)
                    return (
                      <option key={account.id} value={account.id}>
                        {account.alias || account.id} · {experienceLabel(state)}
                      </option>
                    )
                  })}
                </select>
              </label>
            )}

            <div style={detailCardStyle}>
              {!addingAccount && selected === 'feishu' && connected?.status === 'connecting' && (
                <div
                  style={{
                    padding: 10,
                    marginBottom: 14,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-active)',
                    color: 'var(--status-waiting)',
                    fontSize: 11.5,
                    lineHeight: 1.6
                  }}
                >
                  {t('settings.channels.feishuActivationHint')}
                </div>
              )}
              {selected === 'whatsapp' && (
                <div
                  style={{
                    padding: 10,
                    marginBottom: 14,
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--bg-active)',
                    color: 'var(--status-waiting)',
                    fontSize: 11.5,
                    lineHeight: 1.6
                  }}
                >
                  {t('settings.channels.whatsappRequirements')}
                </div>
              )}
              {!addingAccount &&
                connected &&
                selectedAclAccountId === connected.id &&
                selectedAcl &&
                !selectedAcl.mode && (
                  <div
                    style={{
                      padding: 10,
                      marginBottom: 14,
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-active)',
                      color: 'var(--status-waiting)',
                      fontSize: 11.5,
                      lineHeight: 1.6
                    }}
                  >
                    {t('settings.channels.legacyOpenWarning')}
                    <button
                      onClick={() => {
                        const accountId = connected.id
                        void window.agentOs.channels
                          .setAcl(accountId, { mode: 'owner', allowlist: [] })
                          .then(() => {
                            if (connectedAccountIdRef.current !== accountId) return
                            setSelectedAcl({ mode: 'owner', allowlist: [] })
                            setSelectedAclAccountId(accountId)
                          })
                      }}
                      style={{ ...miniBtn, marginLeft: 8 }}
                    >
                      {t('settings.channels.lockToOwner')}
                    </button>
                  </div>
                )}
              {/* 连接信息 */}
              {!addingAccount && (
                <section>
                  <SectionTitle icon={<IcLink size={13} />}>
                    {t('settings.channels.connectionInfo')}
                  </SectionTitle>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <InfoField
                      label={t('settings.channels.botNameLabel')}
                      value={
                        connected ? (
                          connected.alias || t('settings.channels.feishuBotNameFallback')
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>
                            {t('settings.channels.notConfigured')}
                          </span>
                        )
                      }
                    />
                    <InfoField
                      label={t('settings.channels.platformLabel')}
                      value={`${selectedCatalog.name} / ${selectedCatalog.enName}`}
                    />
                    <InfoField
                      label={
                        selected === 'telegram'
                          ? 'Bot Token'
                          : selected === 'wechat'
                            ? 'iLink Bot ID'
                            : selected === 'wecom'
                              ? 'Bot ID'
                              : selected === 'whatsapp'
                                ? 'Phone Number ID'
                                : 'App ID'
                      }
                      value={
                        connected ? (
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>
                            {connMaskedId || '—'}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>—</span>
                        )
                      }
                    />
                    <InfoField
                      label={t('settings.channels.connectionStatusLabel')}
                      value={
                        connected ? (
                          <span
                            style={{
                              color: onlineColor,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6
                            }}
                          >
                            <span
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: '50%',
                                background: onlineColor,
                                flexShrink: 0
                              }}
                            />
                            {experienceLabel(connectedExperience ?? 'disconnected')}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>
                            {t('settings.channels.status.disconnected')}
                          </span>
                        )
                      }
                    />
                    <InfoField
                      label={t('settings.channels.lastInboundLabel')}
                      value={displayTime(connected?.health?.lastInboundAt)}
                    />
                    <InfoField
                      label={t('settings.channels.lastCompletedLabel')}
                      value={displayTime(connected?.health?.lastTurnCompletedAt)}
                    />
                    <InfoField
                      label={t('settings.channels.lastErrorLabel')}
                      value={displayTime(connected?.health?.lastErrorAt)}
                    />
                  </div>
                </section>
              )}

              {!addingAccount &&
                connected &&
                selectedAclAccountId === connected.id &&
                selectedAcl && (
                  <section
                    style={{
                      marginTop: 14,
                      paddingTop: 14,
                      borderTop: '1px solid var(--border-subtle)'
                    }}
                  >
                    <SectionTitle icon={<IcKey size={13} />}>
                      {t('settings.channels.accessControl')}
                    </SectionTitle>
                    <div
                      style={{
                        fontSize: 11.5,
                        color: 'var(--text-secondary)',
                        lineHeight: 1.55,
                        marginBottom: 10
                      }}
                    >
                      {t('settings.channels.accessControlDesc')}
                    </div>
                    {pairingRequests.length > 0 && (
                      <div
                        style={{
                          marginBottom: 10,
                          padding: 10,
                          borderRadius: 'var(--radius-md)',
                          border: '1px solid var(--status-waiting)',
                          background: 'var(--bg-active)'
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 650,
                            color: 'var(--text-primary)',
                            marginBottom: 6
                          }}
                        >
                          {t('settings.channels.pendingPairingRequests', {
                            count: pairingRequests.length
                          })}
                        </div>
                        {pairingRequests.map((request) => (
                          <div
                            key={request.id}
                            data-channel-pairing-request={request.id}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(0, 1fr) auto',
                              gap: 10,
                              padding: '8px 0',
                              borderTop: '1px solid var(--border-subtle)'
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 12,
                                  color: 'var(--text-primary)',
                                  fontWeight: 600
                                }}
                              >
                                {request.userName || request.userId}
                              </div>
                              <div
                                style={{
                                  fontSize: 10.5,
                                  color: 'var(--text-muted)',
                                  fontFamily: 'var(--font-mono)',
                                  wordBreak: 'break-all'
                                }}
                              >
                                {request.userId}
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: 'var(--status-waiting)',
                                  marginTop: 3
                                }}
                              >
                                {t('settings.channels.pairingCode')}{' '}
                                <span
                                  style={{
                                    fontFamily: 'var(--font-mono)',
                                    fontWeight: 700,
                                    letterSpacing: '.08em'
                                  }}
                                >
                                  {request.code}
                                </span>
                                {' · '}
                                {t('settings.channels.pairingExpiresAt', {
                                  time: new Date(request.expiresAt).toLocaleString()
                                })}
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <button
                                disabled={busy}
                                style={miniBtn}
                                onClick={() => decidePairingRequest(request.id, false)}
                              >
                                {t('settings.channels.rejectPairing')}
                              </button>
                              <button
                                disabled={busy}
                                style={{
                                  ...miniBtn,
                                  background: 'var(--text-primary)',
                                  color: 'var(--bg-surface)'
                                }}
                                onClick={() => decidePairingRequest(request.id, true)}
                              >
                                {t('settings.channels.approvePairing')}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <select
                      style={{ ...fieldStyle, width: '100%' }}
                      value={selectedAcl.mode ?? ''}
                      onChange={(event) => {
                        const mode = event.target.value as NonNullable<ChannelAcl['mode']>
                        setSelectedAcl((current) => (current ? { ...current, mode } : current))
                        setAclFeedback(null)
                      }}
                    >
                      {!selectedAcl.mode && (
                        <option value="" disabled>
                          {t('settings.channels.aclLegacyOpen')}
                        </option>
                      )}
                      <option value="owner">{t('settings.channels.aclOwner')}</option>
                      <option value="allowlist">{t('settings.channels.aclAllowlist')}</option>
                      <option value="open">{t('settings.channels.aclOpen')}</option>
                    </select>
                    {selectedAcl.mode === 'owner' && (
                      <div
                        style={{
                          marginTop: 8,
                          fontSize: 11.5,
                          color: 'var(--text-muted)',
                          lineHeight: 1.55
                        }}
                      >
                        {selectedAcl.ownerId
                          ? t('settings.channels.aclOwnerHint', { ownerId: selectedAcl.ownerId })
                          : t('settings.channels.aclOwnerPending')}
                      </div>
                    )}
                    {selectedAcl.mode === 'allowlist' && (
                      <>
                        <textarea
                          style={{
                            ...fieldStyle,
                            width: '100%',
                            minHeight: 82,
                            resize: 'vertical',
                            marginTop: 8
                          }}
                          value={aclAllowlistInput}
                          placeholder={t('settings.channels.aclAllowlistPlaceholder')}
                          onChange={(event) => {
                            setAclAllowlistInput(event.target.value)
                            setAclFeedback(null)
                          }}
                        />
                        <div
                          style={{
                            marginTop: 6,
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            lineHeight: 1.5
                          }}
                        >
                          {t('settings.channels.aclAllowlistHint')}
                        </div>
                      </>
                    )}
                    {selectedAcl.mode === 'open' && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: 8,
                          borderRadius: 'var(--radius-md)',
                          background: 'var(--bg-active)',
                          color: 'var(--danger)',
                          fontSize: 11.5,
                          lineHeight: 1.55
                        }}
                      >
                        {t('settings.channels.aclOpenWarning')}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                      <button
                        onClick={saveAccessPolicy}
                        disabled={busy || !selectedAcl.mode}
                        style={channelsPrimaryBtn}
                      >
                        {t('settings.channels.saveAccessPolicy')}
                      </button>
                      {aclFeedback && (
                        <span
                          style={{
                            fontSize: 11.5,
                            color: aclFeedback.error ? 'var(--danger)' : 'var(--status-ok)'
                          }}
                        >
                          {aclFeedback.text}
                        </span>
                      )}
                    </div>
                  </section>
                )}

              {/* 接入方式 */}
              <section
                style={{
                  marginTop: addingAccount ? 0 : 14,
                  paddingTop: addingAccount ? 0 : 14,
                  borderTop: addingAccount ? 'none' : '1px solid var(--border-subtle)'
                }}
              >
                <SectionTitle icon={<IcQr size={13} />}>
                  {t(
                    addingAccount
                      ? 'settings.channels.addAccount'
                      : 'settings.channels.accessMethod'
                  )}
                </SectionTitle>
                {!addingAccount && connected ? (
                  <ul
                    style={{
                      margin: 0,
                      padding: 0,
                      listStyle: 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 9
                    }}
                  >
                    {connectedMethods.map((text, i) => (
                      <li
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          fontSize: 12,
                          color: 'var(--text-secondary)'
                        }}
                      >
                        <IconChip size={22}>
                          {i === 0 ? (
                            <IcKey size={14} />
                          ) : i === 1 ? (
                            <IcLink size={14} />
                          ) : (
                            <IcAt size={14} />
                          )}
                        </IconChip>
                        {text}
                      </li>
                    ))}
                  </ul>
                ) : scanning ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 10,
                      padding: '6px 0 2px'
                    }}
                  >
                    {qrImg ? (
                      <img
                        src={qrImg}
                        width={168}
                        height={168}
                        alt={t('settings.channels.scanAlt')}
                        style={{ borderRadius: 12, background: 'var(--qr-surface)', padding: 10 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 168,
                          height: 168,
                          borderRadius: 12,
                          background: 'var(--bg-active)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: 'var(--text-muted)',
                          fontSize: 11
                        }}
                      >
                        {t('settings.channels.generatingQr')}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {scanVerificationPrompt ||
                        (qr
                          ? selected === 'wechat'
                            ? t('settings.channels.wechatScanByQrDesc')
                            : t('settings.channels.scanConfirm', { expireIn: qr.expireIn })
                          : t('settings.channels.waitingQr'))}
                    </div>
                    {scanVerificationPrompt && (
                      <div style={{ display: 'flex', gap: 8, width: 'min(280px, 100%)' }}>
                        <input
                          style={{ ...fieldStyle, minWidth: 0 }}
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          placeholder={t('settings.channels.scanVerificationPlaceholder')}
                          value={scanVerificationCode}
                          onChange={(event) =>
                            setScanVerificationCode(
                              event.target.value.replace(/\D/g, '').slice(0, 8)
                            )
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') submitScanVerification()
                          }}
                        />
                        <button onClick={submitScanVerification} style={channelsPrimaryBtn}>
                          {t('settings.channels.scanVerificationSubmit')}
                        </button>
                      </div>
                    )}
                    <button onClick={cancelScan} style={{ ...miniBtn }}>
                      {t('common.action.cancel')}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {(selected === 'feishu' || selected === 'wechat') && (
                      <button onClick={startScan} style={channelMethodRow}>
                        <IconChip size={28}>
                          <IcQr size={16} />
                        </IconChip>
                        <span style={{ flex: 1 }}>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12.5,
                              fontWeight: 600,
                              color: 'var(--text-primary)'
                            }}
                          >
                            {t('settings.channels.scanByQr')}
                          </span>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              marginTop: 2
                            }}
                          >
                            {selected === 'wechat'
                              ? t('settings.channels.wechatScanByQrDesc')
                              : t('settings.channels.scanByQrDesc')}
                          </span>
                        </span>
                      </button>
                    )}
                    {selected !== 'wechat' && (
                      <button onClick={() => setShowManual((s) => !s)} style={channelMethodRow}>
                        <IconChip size={28}>
                          <IcKey size={16} />
                        </IconChip>
                        <span style={{ flex: 1 }}>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 12.5,
                              fontWeight: 600,
                              color: 'var(--text-primary)'
                            }}
                          >
                            {t('settings.channels.manualCredentials')}
                          </span>
                          <span
                            style={{
                              display: 'block',
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              marginTop: 2
                            }}
                          >
                            {selected === 'telegram'
                              ? t('settings.channels.telegramCredentialsDesc')
                              : selected === 'wecom'
                                ? t('settings.channels.wecomCredentialsDesc')
                                : selected === 'whatsapp'
                                  ? t('settings.channels.whatsappCredentialsDesc')
                                  : t('settings.channels.manualCredentialsDesc')}
                          </span>
                        </span>
                      </button>
                    )}
                    {showManual && selected !== 'wechat' && (
                      <div
                        ref={manualFormRef}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          padding: '4px 2px 2px'
                        }}
                      >
                        <ChannelCredentialField
                          label={t('settings.channels.aliasLabel')}
                          requirement={t('settings.channels.optionalField')}
                        >
                          <input
                            style={{ ...fieldStyle }}
                            placeholder={t('settings.channels.aliasPlaceholder')}
                            value={alias}
                            onChange={(e) => setAlias(e.target.value)}
                          />
                        </ChannelCredentialField>
                        {selected !== 'telegram' && (
                          <ChannelCredentialField
                            label={
                              selected === 'wecom'
                                ? t('settings.channels.wecomBotIdLabel')
                                : selected === 'whatsapp'
                                  ? t('settings.channels.whatsappPhoneNumberIdLabel')
                                  : t('settings.channels.appIdLabel')
                            }
                            requirement={t('settings.channels.requiredField')}
                          >
                            <input
                              style={{ ...fieldStyle }}
                              placeholder={
                                selected === 'wecom'
                                  ? 'Bot ID'
                                  : selected === 'whatsapp'
                                    ? 'Phone Number ID'
                                    : t('settings.channels.appIdPlaceholder')
                              }
                              value={appId}
                              onChange={(e) => setAppId(e.target.value)}
                              required
                            />
                          </ChannelCredentialField>
                        )}
                        <ChannelCredentialField
                          label={
                            selected === 'telegram'
                              ? t('settings.channels.telegramBotTokenLabel')
                              : selected === 'wecom'
                                ? t('settings.channels.wecomBotSecretLabel')
                                : selected === 'whatsapp'
                                  ? t('settings.channels.whatsappAccessTokenLabel')
                                  : t('settings.channels.appSecretLabel')
                          }
                          requirement={t('settings.channels.requiredField')}
                        >
                          <input
                            style={{ ...fieldStyle }}
                            type={showSecrets ? 'text' : 'password'}
                            autoComplete="off"
                            placeholder={
                              selected === 'telegram'
                                ? 'Bot Token'
                                : selected === 'wecom'
                                  ? 'Bot Secret'
                                  : selected === 'whatsapp'
                                    ? 'Permanent Access Token'
                                    : 'App Secret'
                            }
                            value={appSecret}
                            onChange={(e) => setAppSecret(e.target.value)}
                            required
                          />
                        </ChannelCredentialField>
                        {selected === 'whatsapp' && (
                          <>
                            <ChannelCredentialField
                              label={t('settings.channels.whatsappAppSecretLabel')}
                              requirement={t('settings.channels.requiredField')}
                            >
                              <input
                                style={{ ...fieldStyle }}
                                type={showSecrets ? 'text' : 'password'}
                                autoComplete="off"
                                placeholder="Meta App Secret"
                                value={whatsappAppSecret}
                                onChange={(e) => setWhatsappAppSecret(e.target.value)}
                                required
                              />
                            </ChannelCredentialField>
                            <ChannelCredentialField
                              label={t('settings.channels.whatsappVerifyTokenLabel')}
                              requirement={t('settings.channels.requiredField')}
                            >
                              <input
                                style={{ ...fieldStyle }}
                                type={showSecrets ? 'text' : 'password'}
                                autoComplete="off"
                                placeholder="Webhook Verify Token"
                                value={whatsappVerifyToken}
                                onChange={(e) => setWhatsappVerifyToken(e.target.value)}
                                required
                              />
                            </ChannelCredentialField>
                            <ChannelCredentialField
                              label={t('settings.channels.whatsappPublicWebhookUrlLabel')}
                              requirement={t('settings.channels.requiredField')}
                            >
                              <input
                                style={{ ...fieldStyle }}
                                placeholder="https://example.com/agent-os/whatsapp"
                                value={whatsappWebhookUrl}
                                onChange={(e) => setWhatsappWebhookUrl(e.target.value)}
                                required
                              />
                            </ChannelCredentialField>
                            <ChannelCredentialField
                              label={t('settings.channels.whatsappLocalPortLabel')}
                              requirement={t('settings.channels.requiredField')}
                            >
                              <input
                                style={{ ...fieldStyle }}
                                inputMode="numeric"
                                placeholder={t('settings.channels.whatsappLocalPortPlaceholder')}
                                value={whatsappWebhookPort}
                                onChange={(e) => setWhatsappWebhookPort(e.target.value)}
                                required
                              />
                            </ChannelCredentialField>
                            <ChannelCredentialField
                              label={t('settings.channels.whatsappPolicyBasisLabel')}
                              requirement={t('settings.channels.requiredField')}
                            >
                              <select
                                style={{ ...fieldStyle }}
                                value={whatsappPolicyBasis}
                                onChange={(e) => setWhatsappPolicyBasis(e.target.value)}
                                required
                              >
                                <option value="">
                                  {t('settings.channels.whatsappPolicyBasisPlaceholder')}
                                </option>
                                <option value="eea_brazil">
                                  {t('settings.channels.whatsappPolicyEeaBrazil')}
                                </option>
                                <option value="ancillary_business">
                                  {t('settings.channels.whatsappPolicyAncillary')}
                                </option>
                              </select>
                            </ChannelCredentialField>
                            <label
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                fontSize: 11.5,
                                color: 'var(--text-secondary)',
                                lineHeight: 1.5
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={whatsappPolicyConfirmed}
                                onChange={(e) => setWhatsappPolicyConfirmed(e.target.checked)}
                                style={{ marginTop: 2 }}
                              />
                              <span>{t('settings.channels.whatsappPolicyConfirm')}</span>
                            </label>
                          </>
                        )}
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 11.5,
                            color: 'var(--text-secondary)'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={showSecrets}
                            onChange={(e) => setShowSecrets(e.target.checked)}
                          />
                          <span>{t('settings.channels.showSensitiveFields')}</span>
                        </label>
                        <button
                          onClick={addManual}
                          disabled={busy}
                          style={{ ...channelsPrimaryBtn, alignSelf: 'flex-start' }}
                        >
                          {t('settings.channels.addAndEnable')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {scanError && (
                  <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 8 }}>
                    {scanError}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const channelsPrimaryBtn: React.CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 'var(--radius-md)',
  border: 'none',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  font: 'inherit',
  boxShadow: 'var(--shadow-card)'
}

const channelSecondaryBtn: React.CSSProperties = {
  ...channelsPrimaryBtn,
  border: '1px solid var(--border-medium)',
  background: 'var(--bg-card)',
  color: 'var(--text-secondary)',
  boxShadow: 'none'
}

const miniBtn: React.CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 6,
  border: '1px solid var(--border-medium)',
  background: 'var(--bg-card)',
  color: 'var(--text-secondary)',
  fontSize: 11.5,
  cursor: 'pointer',
  font: 'inherit'
}

const channelPanelStyle: React.CSSProperties = {
  background: 'var(--bg-panel)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'none',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden'
}
const channelItemStyle: React.CSSProperties = {
  position: 'relative',
  display: 'grid',
  gridTemplateColumns: '34px 1fr auto',
  alignItems: 'center',
  gap: 10,
  padding: '9px 10px',
  borderRadius: 'var(--radius-md)',
  // 与 active style 都使用 longhand；混用 border shorthand + borderColor 时，
  // React 撤销条件样式可能保留上一项的非透明 borderColor。
  borderWidth: 'var(--border-width)',
  borderStyle: 'solid',
  borderColor: 'transparent',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'left',
  width: '100%',
  // 业务选中边框/左侧标记必须原子切换；若对 border/box-shadow 做淡出，
  // 切换瞬间会同时看到旧渠道和新渠道两个边框，像是焦点残留。
  transition: 'background var(--dur)'
}
const channelItemActiveStyle: React.CSSProperties = {
  borderColor: 'var(--border-medium)',
  background: 'var(--bg-card)',
  boxShadow: 'inset 3px 0 0 var(--status-resumable), var(--shadow-card)'
}
const channelFooterStyle: React.CSSProperties = {
  marginTop: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderTop: '1px solid var(--border-subtle)',
  color: 'var(--text-muted)',
  fontSize: 11.5,
  background: 'color-mix(in srgb, var(--bg-panel) 72%, var(--bg-card))'
}
const detailPanelStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)',
  boxShadow: 'var(--shadow-card)',
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14
}
const detailCardStyle: React.CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)',
  padding: '14px',
  background: 'var(--bg-panel)'
}
const channelDangerBtn: React.CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-medium)',
  background: 'var(--bg-card)',
  color: 'var(--danger)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  font: 'inherit'
}
const channelMethodRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-card)',
  cursor: 'pointer',
  font: 'inherit',
  textAlign: 'left',
  color: 'var(--text-primary)',
  transition: 'background var(--dur), border-color var(--dur)'
}

export function SettingsModal({ onClose }: { onClose(): void }): React.JSX.Element {
  const { t } = useT()
  const [tab, setTab] = useState<
    'general' | 'memory' | 'archive' | 'cli' | 'nodes' | 'channels' | 'diag' | 'about'
  >('general')
  const NAV = [
    { k: 'general', l: t('settings.nav.general') },
    { k: 'memory', l: t('settings.nav.memory') },
    { k: 'archive', l: t('settings.nav.archive') },
    { k: 'cli', l: t('settings.nav.cli') },
    { k: 'nodes', l: t('settings.nav.nodes') },
    { k: 'channels', l: t('settings.nav.channels') },
    { k: 'diag', l: t('settings.nav.diagnostics') },
    { k: 'about', l: t('settings.nav.about') }
  ] as const

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 编辑中的输入框：Esc 用于取消编辑，而不是关闭整个设置弹窗
      const ae = document.activeElement
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) return
      onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div
      className="settings-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-modal">
        <div className="settings-header">
          <div>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: 'var(--text-primary)',
                letterSpacing: '-.02em'
              }}
            >
              {t('settings.header.title')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {t('settings.header.subtitle')}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t('common.action.close')}
            title={t('common.action.close')}
            style={{
              marginLeft: 'auto',
              width: 28,
              height: 28,
              borderRadius: 7,
              border: '1px solid var(--border-medium)',
              background: 'var(--bg-card)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--text-muted)'
            }}
          >
            <IcClose />
          </button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {NAV.map((n) => (
              <button
                key={n.k}
                className={`settings-nav-item ${tab === n.k ? 'is-active' : ''}`}
                onClick={() => setTab(n.k)}
              >
                {n.l}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {tab === 'memory' && <SettingsMemory />}
            {tab === 'general' && <SettingsGeneral />}
            {tab === 'archive' && <SettingsArchive />}
            {tab === 'cli' && <SettingsCLI />}
            {tab === 'nodes' && <SettingsNodes />}
            {tab === 'channels' && <SettingsChannels />}
            {tab === 'diag' && <SettingsDiag />}
            {tab === 'about' && <SettingsAbout />}
          </div>
        </div>
      </div>
    </div>
  )
}
