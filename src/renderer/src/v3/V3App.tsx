// V3 应用外壳（重设计）。
// V3 应用外壳（重设计）。
// 导航/标签由真实 store 驱动（uiStore + workspaceTabsStore），各镜头接真实功能层。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PageKey } from '../stores/uiStore'
import { useUiStore } from '../stores/uiStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useToolsStore } from '../stores/toolsStore'
import { useWorkspaceTabsStore } from '../stores/workspaceTabsStore'
import type { WorkspaceTabKind } from '@shared/workspace-tabs'
import {
  isSystemGeneratedSessionName,
  sanitizeTranscriptTitle,
  shouldAutoRenameSessionName
} from '@shared/transcript/title'
import { sessionDisplayTitle } from '../lib/sessionTitle'
import { watchTheme } from '../lib/theme'
import { resolveLang, setCurrentLang } from '@shared/i18n'
import { useT } from '../lib/i18n'
import { SearchModal } from '../components/SearchModal'
import { ToastViewport } from '../components/ToastViewport'
import { OnboardingView } from '../onboarding/OnboardingView'
import type {
  AgentTask,
  CompareScenario,
  KnowledgeArticle,
  UpdateState,
  WebBookmark,
  WorkbenchSessionView
} from '@shared/types'
import { IconRail, SectionHero, TabBar, tabSection, type V3Section } from './Shell'
import { SettingsModal } from './settings/SettingsModal'
import { UpdateToast } from './UpdateToast'
import { CompareView } from './sections/compare/CompareView'
import { CompareSecPanel } from './sections/compare/CompareSecPanel'
import { ChatSecPanel } from './sections/chat/ChatSecPanel'
import { ChatContent } from './sections/chat/ChatContent'
import { StorageSecPanel } from './sections/storage/StorageSecPanel'
import { RecordView } from './sections/storage/RecordView'
import { MemoryDetailView } from './sections/storage/MemoryDetailView'
import { PersonaView } from './sections/storage/PersonaView'
import { KnowledgeHomeView, MemoryHomeView } from './sections/storage/KnowledgeWorkspace'
import { StatsView } from './sections/stats/StatsView'
import { StatsSecPanel } from './sections/stats/StatsSecPanel'
import { prefetchStatsDashboard } from './sections/stats/useStatsData'
import { WebSecPanel } from './sections/web/WebSecPanel'
import { WebSurface } from './sections/web/WebSurface'
import { useTasksStore } from '../stores/tasksStore'
import {
  TaskBoardView,
  TaskComposer,
  TaskScheduleView,
  TasksSecPanel
} from './sections/tasks/TaskWorkspace'
import './v3.css'
import './sections/tasks/tasks.css'

/** IconRail 镜头标识。映射到 uiStore.activePage。 */
type Section = V3Section

const SECTION_TO_PAGE: Record<Section, PageKey> = {
  chat: 'workbench',
  board: 'board',
  schedule: 'schedule',
  compare: 'compare',
  memory: 'memory',
  web: 'webagg',
  stats: 'stats'
}

const PAGE_TO_SECTION: Record<PageKey, Section> = {
  workbench: 'chat',
  board: 'board',
  schedule: 'schedule',
  compare: 'compare',
  memory: 'memory',
  webagg: 'web',
  stats: 'stats',
  overview: 'chat'
}

const KIND_TO_SECTION: Record<WorkspaceTabKind, Section> = {
  session: 'chat',
  terminal: 'chat',
  'cli-history': 'chat',
  compare: 'compare',
  memory: 'memory',
  'memory-detail': 'memory',
  'memory-new': 'memory',
  persona: 'memory',
  knowledge: 'memory',
  web: 'web'
}

const LEGACY_STORAGE_TAB_KINDS = new Set<WorkspaceTabKind>([
  'memory',
  'memory-detail',
  'memory-new',
  'persona',
  'knowledge'
])

type StorageContent =
  | { kind: 'home' }
  | { kind: 'record'; id: string; title: string }
  | { kind: 'memory-detail'; id: string }
  | { kind: 'memory-new' }
  | { kind: 'persona' }
  | { kind: 'knowledge-article'; article: KnowledgeArticle }
  | { kind: 'knowledge-edit'; article?: KnowledgeArticle }

export function V3App(): React.JSX.Element {
  const platform = useUiStore((s) => s.platform)
  const onboardingCompleted = useUiStore((s) => s.onboardingCompleted)
  const setPlatform = useUiStore((s) => s.setPlatform)
  const activePage = useUiStore((s) => s.activePage)
  const setActivePage = useUiStore((s) => s.setActivePage)
  const themePreference = useUiStore((s) => s.themePreference)
  const languagePreference = useUiStore((s) => s.languagePreference)
  const dockCollapsed = useUiStore((s) => s.dockCollapsed)
  const setDockCollapsed = useUiStore((s) => s.setDockCollapsed)
  const webDefaultHomeId = useUiStore((s) => s.webDefaultHomeId)
  const searchModalOpen = useUiStore((s) => s.searchModalOpen)
  const openSearchModal = useUiStore((s) => s.openSearchModal)
  const settingsModalOpen = useUiStore((s) => s.settingsModalOpen)
  const openSettingsModal = useUiStore((s) => s.openSettingsModal)
  const closeSettingsModal = useUiStore((s) => s.closeSettingsModal)

  const { t } = useT()

  const refreshSessions = useSessionsStore((s) => s.refresh)
  const views = useSessionsStore((s) => s.views)
  const scanTools = useToolsStore((s) => s.scan)

  const tabs = useWorkspaceTabsStore((s) => s.tabs)
  const activeTabId = useWorkspaceTabsStore((s) => s.activeTabId)
  const openTab = useWorkspaceTabsStore((s) => s.open)
  const activateTab = useWorkspaceTabsStore((s) => s.activate)
  const closeTab = useWorkspaceTabsStore((s) => s.close)
  const closeTabs = useWorkspaceTabsStore((s) => s.closeMany)
  const setTabPinned = useWorkspaceTabsStore((s) => s.setPinned)
  const reorderTab = useWorkspaceTabsStore((s) => s.reorder)
  const clearActiveTab = useWorkspaceTabsStore((s) => s.clearActive)
  const clearTabHighlight = useWorkspaceTabsStore((s) => s.clearHighlight)

  const [statsView, setStatsView] = useState<'stats' | 'growth'>('stats')
  const [storageSubView, setStorageSubView] = useState<'history' | 'memory' | 'knowledge'>(
    'history'
  )
  const [storageContent, setStorageContent] = useState<StorageContent>({ kind: 'home' })
  const [webBookmarkDialogOpen, setWebBookmarkDialogOpen] = useState(false)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [taskComposer, setTaskComposer] = useState<{
    kind: 'board' | 'schedule'
    task?: AgentTask
  } | null>(null)

  // 引导页预览开关（非破坏性）：在 DevTools 执行
  //   localStorage.setItem('agent-os.force-onboarding','1') 后刷新即可查看；
  //   点「进入工作台」或下方回调会自动清除该标志。
  const [previewOnboarding, setPreviewOnboarding] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.localStorage.getItem('agent-os.force-onboarding') === '1'
  )

  const section = PAGE_TO_SECTION[activePage]
  const panelOpen = !dockCollapsed

  // 启动：平台信息 + 会话刷新 + CLI 扫描。
  useEffect(() => {
    void window.agentOs.app.getPlatformInfo().then((info) => {
      setPlatform(info)
      document.documentElement.dataset.platform = info.platform
      document.documentElement.style.setProperty('--titlebar-height', `${info.titlebarHeight}px`)
    })
    void refreshSessions()
    void scanTools()
  }, [setPlatform, refreshSessions, scanTools])

  // SPEC-039：任务由 daemon 持有；启动时水合，后续通过 federation 事件实时合并。
  useEffect(() => {
    void useTasksStore.getState().refresh()
    const off = window.agentOs.events.onTaskChanged((event) => {
      useTasksStore.getState().applyEvent(event)
    })
    return off
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      prefetchStatsDashboard({ range: 'all' })
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [])

  // 主题：跟随偏好，「跟随系统」时监听系统外观变化。
  useEffect(() => watchTheme(themePreference, () => {}), [themePreference])

  // SPEC-036：语言——解析生效语言，同步渲染端运行时变量（终端等非 React 点用），
  // 并把解析结果推送到主进程（tr() 用）。挂载与偏好变更时各触发一次。
  useEffect(() => {
    const resolved = resolveLang(languagePreference)
    setCurrentLang(resolved)
    void window.agentOs?.app?.setLanguage?.(resolved)
  }, [languagePreference])

  // 终端状态/退出变化 → 刷新会话视图，保持列表状态点实时。
  useEffect(() => {
    const offState = window.agentOs.events.onTerminalStateChanged(() => void refreshSessions())
    const offExit = window.agentOs.events.onTerminalExit(() => void refreshSessions())
    return () => {
      offState()
      offExit()
    }
  }, [refreshSessions])

  // 自动更新：订阅状态变化 + 水合 + 启动静默检查一次（命中 github.com/aiutil/agent-os）。
  useEffect(() => {
    const off = window.agentOs.events.onUpdateState((s) => {
      // 新一轮「发现新版本」时复位关闭标记，确保 toast 再次出现。
      setUpdateState((prev) => {
        if (s.status === 'available' && prev?.status !== 'available') setUpdateDismissed(false)
        return s
      })
    })
    void window.agentOs.runtime.updateState().then((s) => {
      if (s) setUpdateState(s)
    })
    void window.agentOs.runtime.checkUpdate({ silent: true }).catch(() => {})
    return off
  }, [])

  // ⌘K 打开搜索。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        openSearchModal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSearchModal])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const activeRecordId = storageContent.kind === 'record' ? storageContent.id : null
  const activeMemoryId = storageContent.kind === 'memory-detail' ? storageContent.id : null
  const activePersona = storageContent.kind === 'persona'
  const activeSiteId = activeTab?.kind === 'web' ? activeTab.resourceId : null
  const consumeActiveHighlight = useCallback(() => {
    if (activeTabId) clearTabHighlight(activeTabId)
  }, [activeTabId, clearTabHighlight])

  // 选中态同步：会话标签 → sessionsStore.selectedId；否则清空（回到 Hero）。
  useEffect(() => {
    const active = tabs.find((t) => t.id === activeTabId)
    useSessionsStore.getState().select(active?.kind === 'session' ? active.resourceId : null)
  }, [activeTabId, tabs])

  // SPEC-035 批量回填：会话列表（含未打开的）里所有占位/坏标题会话，一旦绑定 nativeSessionId
  // 即用真实 transcript 标题覆盖，无需逐个打开。涵盖解析 bug 期被锁成文件名标题（prov:false）的坏数据。
  const backfilledRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const view of views) {
      if (
        view.surface !== 'terminal' ||
        !view.nativeSessionId ||
        backfilledRef.current.has(view.id)
      )
        continue
      const base = view.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
      if (
        !shouldAutoRenameSessionName(view.name, {
          nameProvisional: view.nameProvisional,
          workspaceBase: base
        })
      )
        continue
      void window.agentOs.memory
        .getTranscript(`${view.toolId}:${view.nativeSessionId}`)
        .then((t) => {
          // transcript I/O 期间用户可能已经手改标题；写入前必须用最新 view 再做一次门禁。
          const current = useSessionsStore.getState().views.find((item) => item.id === view.id)
          if (!current || current.surface !== 'terminal') return
          const currentBase = current.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? ''
          if (
            !shouldAutoRenameSessionName(current.name, {
              nameProvisional: current.nameProvisional,
              workspaceBase: currentBase
            })
          )
            return
          const title = sanitizeTranscriptTitle(t?.title, 80)
          // 真实标题才覆盖；transcript 本身无人类首句（标题仍是文件名）时不写入，避免坏标题回流。
          if (
            !title ||
            isSystemGeneratedSessionName(title) ||
            (title === current.name && !current.nameProvisional)
          )
            return
          backfilledRef.current.add(current.id)
          void window.agentOs.session
            .update(current.id, { name: title, nameProvisional: false })
            .then(() => useSessionsStore.getState().refresh())
        })
        .catch(() => {})
    }
  }, [views])

  const syncSessionTitles = useWorkspaceTabsStore((s) => s.syncSessionTitles)
  useEffect(() => {
    syncSessionTitles(
      Object.fromEntries(views.map((view) => [view.id, sessionDisplayTitle(view)]))
    )
  }, [syncSessionTitles, views])

  const goSection = (sec: Section): void => {
    setActivePage(SECTION_TO_PAGE[sec])
    if (!activeTab || tabSection(activeTab) !== sec) clearActiveTab()
  }

  // 存储是单一导航上下文；旧版本已持久化的存储标签在恢复后一次性移除。
  useEffect(() => {
    const legacyIds = tabs
      .filter((tab) => LEGACY_STORAGE_TAB_KINDS.has(tab.kind))
      .map((tab) => tab.id)
    if (legacyIds.length === 0) return

    const removedActiveTab = legacyIds.includes(activeTabId ?? '')
    closeTabs(legacyIds)
    if (removedActiveTab) {
      clearActiveTab()
      setActivePage('memory')
      setStorageContent({ kind: 'home' })
    }
  }, [activeTabId, clearActiveTab, closeTabs, setActivePage, tabs])

  const onTabClick = (id: string): void => {
    const tab = tabs.find((t) => t.id === id)
    activateTab(id)
    if (tab) setActivePage(SECTION_TO_PAGE[KIND_TO_SECTION[tab.kind]])
  }

  // 打开/聚焦真实会话标签（chat 与 cli 会话都是 session 种类，由 surface 决定渲染）。
  const openSessionTab = (view: WorkbenchSessionView): void => {
    openTab({
      kind: 'session',
      resourceId: view.id,
      title: sessionDisplayTitle(view),
      toolId: view.toolId
    })
    setActivePage('workbench')
  }

  // SPEC-034 深链：飞书等渠道回复里的「在 Agent OS 打开」(agentos://session/<id>) → 打开会话标签。
  useEffect(() => {
    const off = window.agentOs.events.onChannelsOpenSession(({ sessionId }) => {
      void useSessionsStore
        .getState()
        .reopen(sessionId)
        .then((view) => {
          if (view) openSessionTab(view)
        })
    })
    return () => off()
  }, [])

  // 回到会话 Hero（新建对话/CLI）。
  const onNewChat = (): void => {
    clearActiveTab()
    setActivePage('workbench')
  }

  const openTaskSession = (sessionId: string): void => {
    void useSessionsStore
      .getState()
      .openExisting(sessionId)
      .then((view) => {
        if (view) openSessionTab(view)
      })
  }

  const onArchiveSession = (view: WorkbenchSessionView): void => {
    void useSessionsStore
      .getState()
      .archive(view.id)
      .then(() => {
        const tabIds = useWorkspaceTabsStore
          .getState()
          .tabs.filter((tab) => tab.kind === 'session' && tab.resourceId === view.id)
          .map((tab) => tab.id)
        if (tabIds.length) useWorkspaceTabsStore.getState().closeMany(tabIds)
      })
  }

  const onToggleSessionPinned = (view: WorkbenchSessionView, pinned: boolean): void => {
    void useSessionsStore.getState().togglePinned(view.id, pinned)
  }

  const onNewCompare = (): void => {
    openTab({
      kind: 'compare',
      resourceId: `new-${Date.now()}`,
      title: t('workbench.compare.newTitle')
    })
    setActivePage('compare')
  }

  const onOpenCompare = (scenario: CompareScenario): void => {
    openTab({ kind: 'compare', resourceId: scenario.id, title: scenario.title })
    setActivePage('compare')
  }

  const onDeleteCompareScenario = (scenarioId: string): void => {
    // 删除对比记录时，关闭其对应的 tab（若该 tab 当前激活，关闭后主区自动回到 SectionHero）。
    const ids = tabs
      .filter((t) => t.kind === 'compare' && t.resourceId === scenarioId)
      .map((t) => t.id)
    if (ids.length) closeTabs(ids)
  }

  const onCompareScenarioSaved = (scenario: CompareScenario): void => {
    openTab({ kind: 'compare', resourceId: scenario.id, title: scenario.title })
    setActivePage('compare')
  }

  const onOpenRecord = (rec: { id: string; title: string }): void => {
    clearActiveTab()
    setStorageContent({ kind: 'record', ...rec })
    setActivePage('memory')
  }

  // 存储详情在当前内容区就地切换，避免浏览记录时堆积顶部工作标签。
  const onOpenMemoryDetail = (rec: { id: string; title: string }): void => {
    clearActiveTab()
    setStorageContent({ kind: 'memory-detail', id: rec.id })
    setActivePage('memory')
  }

  // 打开用户画像（人格）编辑器：全局单份、存储区内联展示。
  const onOpenPersona = (): void => {
    clearActiveTab()
    setStorageContent({ kind: 'persona' })
    setActivePage('memory')
  }

  // 手动新建记忆：存储区内联草稿，重复点击复用当前编辑页。
  const onOpenMemoryNew = (): void => {
    clearActiveTab()
    setStorageContent({ kind: 'memory-new' })
    setActivePage('memory')
  }
  // 新建成功后：就地切换到新记忆详情。
  const onMemoryCreated = (rec: { id: string; title: string }): void => {
    onOpenMemoryDetail(rec)
  }
  const onOpenKnowledge = (article: KnowledgeArticle): void => {
    clearActiveTab(); setStorageSubView('knowledge'); setStorageContent({ kind: 'knowledge-article', article }); setActivePage('memory')
  }
  const onSaveKnowledge = (article: KnowledgeArticle): void => {
    setStorageSubView('knowledge'); setStorageContent({ kind: 'knowledge-article', article })
  }

  useEffect(() => {
    const openKnowledge = (event: Event): void => {
      const id = (event as CustomEvent<string>).detail
      if (!id) return
      void window.agentOs.knowledge.get(id).then((article) => {
        if (article) onOpenKnowledge(article)
      })
    }
    window.addEventListener('agent-os:open-knowledge', openKnowledge)
    return () => window.removeEventListener('agent-os:open-knowledge', openKnowledge)
  }, [])

  const onOpenSite = (site: WebBookmark): void => {
    openTab({ kind: 'web', resourceId: site.id, title: site.name })
    setActivePage('webagg')
  }

  if (!platform) {
    return <div className="app" />
  }

  if (!onboardingCompleted || previewOnboarding) {
    return (
      <OnboardingView
        onComplete={() => {
          window.localStorage.removeItem('agent-os.force-onboarding')
          setPreviewOnboarding(false)
        }}
      />
    )
  }

  return (
    <div className="app">
      <TabBar
        section={section}
        tabs={tabs}
        activeTabId={activeTabId}
        onHome={() => {
          clearActiveTab()
          if (section === 'memory') setStorageContent({ kind: 'home' })
        }}
        onTabClick={onTabClick}
        onCloseTab={(id: string) => closeTab(id)}
        onCloseTabs={(ids: string[]) => closeTabs(ids)}
        onSetTabPinned={(id: string, pinned: boolean) => setTabPinned(id, pinned)}
        onReorderTab={(draggedId: string, targetId: string) => reorderTab(draggedId, targetId)}
        onNew={() => {
          if (section === 'board' || section === 'schedule') setTaskComposer({ kind: section })
          else onNewChat()
        }}
        onSearch={() => openSearchModal()}
        panelOpen={panelOpen}
        onTogglePanel={() => setDockCollapsed(panelOpen)}
      />
      <div className="body">
        <IconRail section={section} onSection={goSection} onSettings={openSettingsModal} />
        {section === 'chat' ? (
          <aside className={`sec-panel ${panelOpen ? '' : 'is-closed'}`}>
            <div className="sec-inner">
              <ChatSecPanel
                onNew={onNewChat}
                onOpenSession={openSessionTab}
                onArchiveSession={onArchiveSession}
                onTogglePinned={onToggleSessionPinned}
              />
            </div>
          </aside>
        ) : section === 'board' || section === 'schedule' ? (
          <aside className={`sec-panel ${panelOpen ? '' : 'is-closed'}`}>
            <div className="sec-inner">
              <TasksSecPanel
                section={section}
                onSection={goSection}
                onNew={() => setTaskComposer({ kind: section })}
              />
            </div>
          </aside>
        ) : section === 'memory' ? (
          <aside className={`sec-panel ${panelOpen ? '' : 'is-closed'}`}>
            <div className="sec-inner">
              <StorageSecPanel
                subView={storageSubView}
                onSubView={(view) => { setStorageSubView(view); setStorageContent({ kind: 'home' }) }}
                onOpenRecord={onOpenRecord}
                activeRecordId={activeRecordId}
                onOpenMemoryDetail={onOpenMemoryDetail}
                activeMemoryId={activeMemoryId}
                onOpenMemoryNew={onOpenMemoryNew}
                onOpenPersona={onOpenPersona}
                personaActive={activePersona}
                onOpenKnowledge={onOpenKnowledge}
              />
            </div>
          </aside>
        ) : section === 'stats' ? (
          <aside className={`sec-panel ${panelOpen ? '' : 'is-closed'}`}>
            <div className="sec-inner">
              <StatsSecPanel activeStats={statsView} onNavStats={setStatsView} />
            </div>
          </aside>
        ) : section === 'compare' ? (
          <aside className={`sec-panel ${panelOpen ? '' : 'is-closed'}`}>
            <div className="sec-inner">
              <CompareSecPanel
                onNewCompare={onNewCompare}
                onOpenScenario={onOpenCompare}
                onDeleteScenario={onDeleteCompareScenario}
                activeScenarioId={activeTab?.kind === 'compare' ? activeTab.resourceId : null}
              />
            </div>
          </aside>
        ) : (
          <aside className={`sec-panel ${panelOpen ? '' : 'is-closed'}`}>
            <div className="sec-inner">
              <WebSecPanel
                onOpenSite={onOpenSite}
                activeSiteId={activeSiteId}
                onDialogOpenChange={setWebBookmarkDialogOpen}
              />
            </div>
          </aside>
        )}
        <main className="content">
          {section === 'chat' ? (
            <ChatContent
              onOpenSession={openSessionTab}
              highlight={activeTab?.kind === 'session' ? activeTab.highlight : undefined}
              onHighlightConsumed={consumeActiveHighlight}
            />
          ) : section === 'board' ? (
            <TaskBoardView
              onNew={() => setTaskComposer({ kind: 'board' })}
              onEdit={(task) => setTaskComposer({ kind: 'board', task })}
              onOpenSession={openTaskSession}
            />
          ) : section === 'schedule' ? (
            <TaskScheduleView
              onNew={() => setTaskComposer({ kind: 'schedule' })}
              onEdit={(task) => setTaskComposer({ kind: 'schedule', task })}
              onOpenSession={openTaskSession}
            />
          ) : section === 'stats' ? (
            <StatsView statsView={statsView} />
          ) : section === 'memory' ? (
            storageContent.kind === 'memory-new' ? (
              <MemoryDetailView
                create
                onCreated={onMemoryCreated}
                onCancelCreate={() => setStorageContent({ kind: 'home' })}
              />
            ) : storageContent.kind === 'persona' ? (
              <PersonaView />
            ) : storageContent.kind === 'record' ? (
              <RecordView
                sessionId={storageContent.id}
                title={storageContent.title}
                onRelayed={openSessionTab}
              />
            ) : storageSubView === 'knowledge' ? (
              <KnowledgeHomeView
                selectedArticle={storageContent.kind === 'knowledge-article'
                  ? storageContent.article
                  : storageContent.kind === 'knowledge-edit'
                    ? storageContent.article
                    : undefined}
                editing={storageContent.kind === 'knowledge-edit'}
                creating={storageContent.kind === 'knowledge-edit' && !storageContent.article}
                onSelectArticle={onOpenKnowledge}
                onCloseSelection={() => setStorageContent({ kind: 'home' })}
                onCreate={() => setStorageContent({ kind: 'knowledge-edit' })}
                onEdit={(article) => setStorageContent({ kind: 'knowledge-edit', article })}
                onSave={onSaveKnowledge}
              />
            ) : (
              <MemoryHomeView
                selectedMemoryId={storageContent.kind === 'memory-detail' ? storageContent.id : undefined}
                onSelectMemory={onOpenMemoryDetail}
                onCloseSelection={() => setStorageContent({ kind: 'home' })}
              />
            )
          ) : section === 'compare' ? (
            activeTab?.kind === 'compare' ? (
              <CompareView
                compareId={activeTab.resourceId}
                onScenarioSaved={onCompareScenarioSaved}
              />
            ) : (
              <SectionHero section="compare" />
            )
          ) : activeTab?.kind === 'web' ? (
            <WebSurface
              siteId={activeTab.resourceId}
              hidden={settingsModalOpen || searchModalOpen || webBookmarkDialogOpen}
            />
          ) : (
            <WebSurface
              siteId={webDefaultHomeId ?? 'bm-github'}
              hidden={settingsModalOpen || searchModalOpen || webBookmarkDialogOpen}
            />
          )}
        </main>
      </div>
      {searchModalOpen && <SearchModal />}
      {settingsModalOpen && <SettingsModal onClose={closeSettingsModal} />}
      {taskComposer && (
        <TaskComposer
          kind={taskComposer.kind}
          task={taskComposer.task}
          onClose={() => setTaskComposer(null)}
        />
      )}
      {updateState && !updateDismissed && (
        <UpdateToast state={updateState} onDismiss={() => setUpdateDismissed(true)} />
      )}
      <ToastViewport />
    </div>
  )
}
