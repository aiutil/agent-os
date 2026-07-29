// 工作区主区（SPEC-005/017）。会话 Header + 终端/对话镜头；无会话时 Hero 空态。

import type { FC } from 'react'
import { useEffect, useRef, useState } from 'react'
import { More, Export, Star, DeleteOne } from '@icon-park/react'
import { useSessionsStore } from '../../stores/sessionsStore'
import { useUiStore } from '../../stores/uiStore'
import { useToolsStore } from '../../stores/toolsStore'
import { useT } from '../../lib/i18n'
import { TerminalPane } from '../../components/TerminalPane'
import { sessionStatusColor, sessionStatusLabel } from '../../lib/status'
import { ToolIcon, IpIcon } from '../../lib/toolIcons'
import { ChatPane } from './ChatPane'
import { ConfirmDialog } from '../../lib/ui'
import {
  closeWorkspaceTabView,
  navigateToPage,
  openWorkspaceTab
} from '../../workspace-tabs/navigation'
import { workspaceTabId } from '@shared/workspace-tabs'
import type { RelayTarget, WorkbenchSessionView } from '@shared/types'
import { sessionDisplayTitle } from '../../lib/sessionTitle'

type IpFC = FC<{ theme: string; size: number; strokeWidth: number; fill?: string[] }>

// ─── Hero 空态（无会话选中时） ────────────────────────────────────────────────

function projectBasename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

function HeroState(): React.JSX.Element {
  const views = useSessionsStore((s) => s.views)
  const create = useSessionsStore((s) => s.create)
  const setPendingPrompt = useSessionsStore((s) => s.setPendingPrompt)
  const selectedProjectPath = useSessionsStore((s) => s.selectedProjectPath)
  const selectProject = useSessionsStore((s) => s.selectProject)
  const loading = useSessionsStore((s) => s.loading)
  const openSettingsModal = useUiStore((s) => s.openSettingsModal)
  const mode = useUiStore((s) => s.workbenchMode)
  const userName = useUiStore((s) => s.platform?.userName ?? 'Agent OS')
  const tools = useToolsStore((s) => s.results)
  const runtimes = useToolsStore((s) => s.runtimes)
  const scan = useToolsStore((s) => s.scan)
  const scanning = useToolsStore((s) => s.scanning)
  const ipcContractMismatch = useUiStore((s) => s.ipcContractMismatch)
  const { t } = useT()

  const [input, setInput] = useState('')
  const [engineId, setEngineId] = useState<string>('')
  const [showEngineDD, setShowEngineDD] = useState(false)
  const [showDirDD, setShowDirDD] = useState(false)
  const [dirInput, setDirInput] = useState('')
  const engineRef = useRef<HTMLDivElement>(null)
  const dirRef = useRef<HTMLDivElement>(null)

  const continuable = views
    .filter((view) =>
      mode === 'chat'
        ? view.surface === 'chat'
        : view.surface === 'terminal' &&
          (Boolean(view.terminalSessionId) || view.continuity.state === 'ready')
    )
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  const runtimeByTool = new Map(runtimes.map((runtime) => [runtime.toolId, runtime]))

  // 会话模式只列支持结构化对话的 CLI；CLI 模式列全部已就绪 CLI（排除 shell 兜底）。
  const engineList = tools.filter(
    (t) =>
      t.toolId !== 'shell' &&
      (t.health === 'ready' || t.health === 'updatable') &&
      (mode === 'cli' || runtimeByTool.get(t.toolId)?.capabilities.chat === true)
  )

  // 已有会话的不同工作目录，供「目录」选择器继承。
  const projectPaths = Array.from(new Set(views.map((v) => v.workspacePath).filter(Boolean)))
  // 继承顺序：选中项目 → 最近会话项目 → 空（后端回退 home）。
  const workspacePath = selectedProjectPath ?? views[0]?.workspacePath ?? ''

  useEffect(() => {
    if (tools.length === 0) void scan()
  }, [tools.length, scan])
  // 默认引擎：取首个符合当前模式的就绪 CLI；模式切换后失效则重选。
  useEffect(() => {
    if (engineList.length === 0) return
    if (!engineId || !engineList.some((t) => t.toolId === engineId)) {
      setEngineId(engineList[0].toolId)
    }
  }, [engineList, engineId])

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!engineRef.current?.contains(e.target as Node)) setShowEngineDD(false)
      if (!dirRef.current?.contains(e.target as Node)) setShowDirDD(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectedEngine = tools.find((t) => t.toolId === engineId)

  const startSession = async (firstMessage?: string): Promise<void> => {
    if (!engineId) return
    const name =
      firstMessage?.trim().slice(0, 24) ||
      (workspacePath
        ? mode === 'cli'
          ? t('workbench.hero.sessionNameTerminal', { base: projectBasename(workspacePath) })
          : t('workbench.hero.sessionNameChat', { base: projectBasename(workspacePath) })
        : t('workbench.hero.newSessionName'))
    const created = await create({
      name,
      toolId: engineId,
      workspacePath,
      surface: mode === 'cli' ? 'terminal' : 'chat',
      permissionPreset: 'safe'
    })
    if (!created) {
      void useSessionsStore.getState().setNotice(t('workbench.notice.createFailed'), 'error')
      return
    }
    if (firstMessage?.trim()) setPendingPrompt(created.id, { text: firstMessage.trim() })
    openWorkspaceTab({
      kind: 'session',
      resourceId: created.id,
      title: sessionDisplayTitle(created),
      toolId: created.toolId
    })
  }

  const handleSend = (): void => {
    if (!input.trim() || loading) return
    const text = input
    setInput('')
    void startSession(text)
  }

  const handleResume = (): void => {
    if (continuable.length === 0) return
    const view = continuable[0]
    if (mode === 'cli' && !view.terminalSessionId) {
      void useSessionsStore.getState().resume(view.id).then(() => {
        openWorkspaceTab({
          kind: 'session',
          resourceId: view.id,
          title: sessionDisplayTitle(view),
          toolId: view.toolId
        })
      })
      return
    }
    openWorkspaceTab({
      kind: 'session',
      resourceId: view.id,
      title: sessionDisplayTitle(view),
      toolId: view.toolId
    })
  }

  // 系统文件夹选择对话框（SPEC-005 v2：路径输入 + 文件夹选择）。
  const pickFolder = async (): Promise<void> => {
    const picked = await window.agentOs.app.selectDirectory(
      workspacePath ? { defaultPath: workspacePath } : undefined
    )
    if (picked) {
      selectProject(picked)
      setShowDirDD(false)
    }
  }

  const commitDirInput = (): void => {
    const v = dirInput.trim()
    if (!v) return
    selectProject(v)
    setDirInput('')
    setShowDirDD(false)
  }

  const engineSelector = (
    <div className="hero__engine-wrap" ref={engineRef}>
      <button type="button" className="hero__engine-btn" onClick={() => setShowEngineDD((v) => !v)}>
        {selectedEngine && <ToolIcon toolId={selectedEngine.toolId} size={13} brandColor />}
        <span>{selectedEngine?.displayName ?? t('workbench.hero.selectCli')}</span>
        <span className="hero__engine-chevron">▾</span>
      </button>
      {showEngineDD && (
        <div className="hero__engine-dd">
          <div className="hero__engine-dd-label">{mode === 'cli' ? t('workbench.hero.localCli') : t('workbench.hero.chatCli')}</div>
          {ipcContractMismatch ? (
            <div className="hero__engine-dd-empty">{t('workbench.hero.runtimeUpdated')}</div>
          ) : scanning ? (
            <div className="hero__engine-dd-empty">{t('workbench.hero.readingRuntime')}</div>
          ) : engineList.length === 0 ? (
            <div className="hero__engine-dd-empty">
              {mode === 'cli' ? t('workbench.hero.noCli') : t('workbench.hero.noChatCli')}
            </div>
          ) : (
            engineList.map((t) => (
              <button
                key={t.toolId}
                type="button"
                className={`hero__engine-dd-item ${t.toolId === engineId ? 'is-selected' : ''}`}
                onClick={() => {
                  setEngineId(t.toolId)
                  setShowEngineDD(false)
                }}
              >
                <ToolIcon toolId={t.toolId} size={13} brandColor />
                <span className="hero__engine-dd-name">{t.displayName}</span>
                {t.version && <span className="hero__engine-dd-ver">v{t.version}</span>}
                {t.toolId === engineId && <span className="hero__engine-dd-check">✓</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )

  const dirSelector = (
    <div className="hero__engine-wrap" ref={dirRef}>
      <button type="button" className="hero__dir-btn" onClick={() => setShowDirDD((v) => !v)}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path
            d="M1 3.5C1 2.7 1.6 2 2.4 2h2l1 1.3h3.2c.8 0 1.4.6 1.4 1.4V8c0 .8-.6 1.4-1.4 1.4H2.4C1.6 9.4 1 8.8 1 8V3.5Z"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinejoin="round"
          />
        </svg>
        <span className="mono">{workspacePath ? projectBasename(workspacePath) : t('workbench.hero.home')}</span>
        <span className="hero__engine-chevron">▾</span>
      </button>
      {showDirDD && (
        <div className="hero__engine-dd hero__dir-dd">
          <div className="hero__dir-input-row">
            <input
              className="hero__dir-input mono"
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitDirInput()
                }
              }}
              placeholder={t('workbench.hero.pathPlaceholder')}
              spellCheck={false}
            />
            <button
              type="button"
              className="hero__dir-browse"
              onClick={() => void pickFolder()}
              title={t('workbench.hero.selectFolder')}
            >
              {t('workbench.hero.browse')}
            </button>
          </div>
          <div className="hero__engine-dd-label">{t('workbench.hero.workingDir')}</div>
          <button
            type="button"
            className={`hero__engine-dd-item ${!selectedProjectPath ? 'is-selected' : ''}`}
            onClick={() => {
              selectProject(null)
              setShowDirDD(false)
            }}
          >
            <span className="hero__engine-dd-name">{t('workbench.hero.homeDefault')}</span>
          </button>
          {projectPaths.map((path) => (
            <button
              key={path}
              type="button"
              className={`hero__engine-dd-item ${selectedProjectPath === path ? 'is-selected' : ''}`}
              onClick={() => {
                selectProject(path)
                setShowDirDD(false)
              }}
            >
              <span className="hero__engine-dd-name">{projectBasename(path)}</span>
              <span className="hero__engine-dd-ver mono">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <div className="hero">
      <div className="hero__greeting">
        {t('workbench.hero.greeting', { name: userName })}
      </div>

      {continuable.length > 0 && (
        <button type="button" className="hero__nudge" onClick={handleResume}>
          <span className="hero__nudge-dot" />
          <span className="hero__nudge-text">
            <span className="hero__nudge-label">
              {mode === 'cli'
                ? t('workbench.hero.continuableTerminal', { count: continuable.length })
                : t('workbench.hero.continuableChat', { count: continuable.length })}
            </span>
            &nbsp;——&nbsp;{continuable.slice(0, 2).map((item) => sessionDisplayTitle(item)).join('、')}…
          </span>
          <span className="hero__nudge-badge">{t('workbench.hero.resumableBadge', { count: continuable.length })}</span>
        </button>
      )}

      {mode === 'chat' ? (
        <div className="hero__input-wrap">
          <textarea
            className="hero__textarea"
            placeholder={t('workbench.hero.taskPlaceholder')}
            rows={3}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                handleSend()
              }
            }}
          />
          <div className="hero__toolbar">
            {engineSelector}
            {dirSelector}
            <div style={{ flex: 1 }} />
            <button type="button" className="hero__compare-btn" onClick={() => navigateToPage('compare')}>
              {t('workbench.section.compare')}
            </button>
            <button
              type="button"
              className={`hero__send-btn ${input.trim() && engineId ? 'is-active' : ''}`}
              aria-label={t('workbench.hero.sendAria')}
              disabled={!input.trim() || !engineId || loading}
              onClick={handleSend}
            >
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <path d="M6.5 11V2M2.5 6l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      ) : (
        <div className="hero__cli-card">
          <div className="hero__cli-row">
            {engineSelector}
            {dirSelector}
          </div>
          <button
            type="button"
            className="hero__cli-open"
            disabled={!engineId || loading}
            onClick={() => void startSession()}
          >
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
              <rect x="1" y="1.5" width="11" height="10" rx="2" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3.5 5l2 2-2 2M7 9h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t('workbench.hero.openTerminal')}
          </button>
        </div>
      )}

      <div className="hero__chips">
        <button type="button" className="hero__chip" onClick={handleResume} disabled={continuable.length === 0}>
          <span style={{ color: 'var(--status-resumable)' }}>↺</span>{t('workbench.hero.resumeLast')}
        </button>
        <button type="button" className="hero__chip" onClick={() => navigateToPage('compare')}>
          <span style={{ color: 'var(--accent)' }}>⊕</span>{t('workbench.hero.compareMode')}
        </button>
        <button type="button" className="hero__chip" onClick={openSettingsModal}>
          <span>⬇</span>{t('workbench.hero.installCli')}
        </button>
      </div>
    </div>
  )
}

// ─── 更多菜单 ────────────────────────────────────────────────────────────────

function MoreMenu({
  sessionId,
  isFavorite,
  onClose,
  onRequestDelete
}: {
  sessionId: string
  isFavorite: boolean
  onClose(): void
  onRequestDelete(): void
}): React.JSX.Element {
  const toggleFavorite = useSessionsStore((s) => s.toggleFavorite)
  const menuRef = useRef<HTMLDivElement>(null)
  const { t } = useT()

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div className="wb-more-menu" ref={menuRef}>
      <button type="button" className="wb-more-menu__item" onClick={() => {
        void toggleFavorite(sessionId, !isFavorite); onClose()
      }}>
        <IpIcon icon={Star as IpFC} size={12} />
        {isFavorite ? t('workbench.session.unfavorite') : t('workbench.session.favorite')}
      </button>
      <div className="wb-more-menu__sep" />
      <button type="button" className="wb-more-menu__item wb-more-menu__item--danger" onClick={() => {
        onRequestDelete()
        onClose()
      }}>
        <IpIcon icon={DeleteOne as IpFC} size={12} />
        {t('workbench.session.delete')}
      </button>
    </div>
  )
}

function RelayMenu({
  view,
  onClose
}: {
  view: WorkbenchSessionView
  onClose(): void
}): React.JSX.Element {
  const relay = useSessionsStore((s) => s.relay)
  const setNotice = useSessionsStore((s) => s.setNotice)
  const [targets, setTargets] = useState<RelayTarget[]>([])
  const [loading, setLoading] = useState(true)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.agentOs.relay
      .listTargets(view.id)
      .then((items) => {
        if (!cancelled) setTargets(items)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [view.id])

  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const startRelay = async (target: RelayTarget): Promise<void> => {
    if (target.availability !== 'available') {
      setNotice(`${target.displayName} 暂不可接力：${target.reason ?? '请先检查 CLI 状态'}`, 'warning')
      await window.agentOs.relay.openRepair(target.toolId).catch(() => undefined)
      return
    }
    onClose()
    const created = await relay(
      {
        sourceSessionId: view.id,
        sourceSurface: view.surface === 'terminal' ? 'cli' : 'chat',
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

  return (
    <div className="relay-menu" ref={menuRef}>
      <div className="relay-menu__title">接力给</div>
      <div className="relay-menu__current">当前：{view.toolId}</div>
      {loading ? (
        <div className="relay-menu__empty">正在读取 Agent…</div>
      ) : targets.length === 0 ? (
        <div className="relay-menu__empty">没有可接力的 Agent</div>
      ) : (
        targets.map((target) => (
          <button
            key={target.toolId}
            type="button"
            className={`relay-menu__item ${target.availability !== 'available' ? 'is-disabled' : ''}`}
            onClick={() => void startRelay(target)}
          >
            <ToolIcon toolId={target.toolId} size={13} brandColor />
            <span className="relay-menu__name">{target.displayName}</span>
            <span className="relay-menu__status">
              {target.availability === 'available' ? '可用' : target.reason ?? '不可用'}
            </span>
          </button>
        ))
      )}
    </div>
  )
}

function RelayOverlay(): React.JSX.Element | null {
  const relayUi = useSessionsStore((s) => s.relayUi)
  const clearRelayUi = useSessionsStore((s) => s.clearRelayUi)
  if (!relayUi) return null
  if (relayUi.step === 'failed') {
    return (
      <div className="relay-overlay">
        <section className="relay-overlay__panel">
          <h2>接力失败</h2>
          <p>未能创建 {relayUi.targetName} 会话。原会话没有变化。</p>
          <p className="relay-overlay__error">{relayUi.error}</p>
          <div className="relay-overlay__actions">
            <button type="button" className="btn" onClick={clearRelayUi}>
              关闭
            </button>
          </div>
        </section>
      </div>
    )
  }
  return (
    <div className="relay-overlay">
      <section className="relay-overlay__panel">
        <h2>正在接力给 {relayUi.targetName}</h2>
        <ol className="relay-overlay__steps">
          <li>准备标准上下文包</li>
          <li>创建目标 Agent 会话</li>
          <li>注入上下文</li>
          <li>等待接手摘要</li>
          <li>打开新会话</li>
        </ol>
        <button type="button" className="btn" disabled={!relayUi.cancelable} onClick={clearRelayUi}>
          取消
        </button>
      </section>
    </div>
  )
}

// ─── 主区 ────────────────────────────────────────────────────────────────────

export function WorkbenchMain(): React.JSX.Element {
  const views = useSessionsStore((s) => s.views)
  const selectedId = useSessionsStore((s) => s.selectedId)
  const resume = useSessionsStore((s) => s.resume)
  const reopen = useSessionsStore((s) => s.reopen)
  const openLinkedTerminal = useSessionsStore((s) => s.openLinkedTerminal)
  const removeSession = useSessionsStore((s) => s.remove)
  const setNotice = useSessionsStore((s) => s.setNotice)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showRelayMenu, setShowRelayMenu] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { t } = useT()

  const view = views.find((v) => v.id === selectedId) ?? null

  if (!view) {
    return (
      <main className="app-main">
        <HeroState />
      </main>
    )
  }

  const hasMultipleSegments = (view.segments?.length ?? 0) > 1

  const handleReconnect = async (): Promise<void> => {
    if (view.status === 'resumable') {
      await resume(view.id)
      return
    }
    const created = await reopen(view.id)
    if (!created) return
    openWorkspaceTab({
      kind: 'session',
      resourceId: created.id,
      title: sessionDisplayTitle(created),
      toolId: created.toolId
    })
  }

  return (
    <main className="app-main">
      <header className="wb-header">
        <span
          className="wb-header__dot"
          style={{ background: sessionStatusColor(view.status) }}
        />
        <span className="wb-header__name">{sessionDisplayTitle(view)}</span>
        <span className="wb-header__status">{sessionStatusLabel(view.status)}</span>
        {hasMultipleSegments && (
          <span className="wb-header__segment-count" title={t('workbench.session.multiSegment')}>
            {t('workbench.session.segments', { count: view.segments!.length })}
          </span>
        )}
        <span className="wb-header__path mono">{view.workspacePath || '~'}</span>

        <div className="wb-header__relay-wrap">
          <button
            type="button"
            className="wb-header__cli-badge"
            onClick={() => setShowRelayMenu((value) => !value)}
          >
            <ToolIcon toolId={view.toolId} size={13} brandColor />
            {view.toolId} ▾
          </button>
          {showRelayMenu && <RelayMenu view={view} onClose={() => setShowRelayMenu(false)} />}
        </div>

        {view.relaySource && (
          <button type="button" className="wb-header__relay-chip" onClick={() => {
            openWorkspaceTab({
              kind: 'session',
              resourceId: view.relaySource!.sessionId,
              title: view.relaySource!.title,
              toolId: view.relaySource!.toolId
            })
          }}>
            接力自 {view.relaySource.toolId}
          </button>
        )}
        {view.relayTarget && (
          <button type="button" className="wb-header__relay-chip" onClick={() => {
            openWorkspaceTab({
              kind: 'session',
              resourceId: view.relayTarget!.sessionId,
              title: view.relayTarget!.title,
              toolId: view.relayTarget!.toolId
            })
          }}>
            已接力给 {view.relayTarget.toolId}
          </button>
        )}

        <div style={{ flex: 1 }} />

        {view.surface === 'chat' && (
          <button
            type="button"
            className="wb-header__action"
            disabled={view.continuity.state !== 'ready'}
            title={view.continuity.reason ?? t('workbench.session.createLinkedCli')}
            onClick={() => {
              void openLinkedTerminal(view.id).then((created) => {
                if (!created) return
                openWorkspaceTab({
                  kind: 'session',
                  resourceId: created.id,
                  title: sessionDisplayTitle(created),
                  toolId: created.toolId
                })
              })
            }}
          >
            {t('workbench.session.continueInCli')}
          </button>
        )}

        {/* 复制路径 */}
        <button
          type="button"
          className="wb-header__action"
          title={t('workbench.session.copyPathTitle')}
          onClick={() => {
            const path = view.workspacePath || '~'
            void navigator.clipboard
              .writeText(path)
              .then(() => setNotice(t('workbench.notice.pathCopied', { path }), 'success'))
              .catch(() => setNotice(t('workbench.notice.copyFailed'), 'error'))
          }}
        >
          <IpIcon icon={Export as IpFC} size={13} />
          {t('workbench.session.copyPath')}
        </button>

        {/* 更多菜单 */}
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="wb-header__action wb-header__action--icon"
            aria-label={t('workbench.session.moreActions')}
            title={t('workbench.session.moreActions')}
            onClick={() => setShowMoreMenu((v) => !v)}
          >
            <IpIcon icon={More as IpFC} size={14} />
          </button>
          {showMoreMenu && (
            <MoreMenu
              sessionId={view.id}
              isFavorite={view.favorite}
              onClose={() => setShowMoreMenu(false)}
              onRequestDelete={() => setConfirmDelete(true)}
            />
          )}
        </div>
      </header>

      {view.surface === 'chat' ? (
        <ChatPane view={view} />
      ) : view.terminalSessionId ? (
        <TerminalPane sessionId={view.terminalSessionId} />
      ) : (
        <div className="empty-state">
          <div className="empty-state__title">
            {view.status === 'resumable' ? t('workbench.terminal.resumeTitle') : t('workbench.terminal.closedTitle')}
          </div>
          <p className="empty-state__hint">
            {view.status === 'resumable'
              ? t('workbench.terminal.resumeHint')
              : t('workbench.terminal.openNewHint', { base: projectBasename(view.workspacePath || '~') })}
          </p>
          {view.outputTail && (
            <pre className="empty-state__hint mono" style={{ whiteSpace: 'pre-wrap' }}>
              {view.outputTail}
            </pre>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleReconnect()}
          >
            {view.status === 'resumable' ? t('workbench.terminal.resume') : t('workbench.terminal.openNew')}
          </button>
        </div>
      )}

      <RelayOverlay />

      <ConfirmDialog
        open={confirmDelete}
        title={t('workbench.session.deleteTitle')}
        message={
          <>
            {t('workbench.session.deleteConfirm', { name: sessionDisplayTitle(view) })}
          </>
        }
        confirmText={t('common.action.delete')}
        danger
        loading={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setDeleting(true)
          void removeSession(view.id)
            .then(() => closeWorkspaceTabView(workspaceTabId('session', view.id)))
            .finally(() => {
              setDeleting(false)
              setConfirmDelete(false)
            })
        }}
      />
    </main>
  )
}
