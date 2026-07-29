import type { PageKey } from '../stores/uiStore'
import type { WorkspaceTab, WorkspaceTabInput } from '@shared/workspace-tabs'
import { useCompareStore } from '../pages/compare/CompareStore'
import { useMemoryViewStore } from '../stores/memoryViewStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUiStore } from '../stores/uiStore'
import { useWorkspaceTabsStore } from '../stores/workspaceTabsStore'

async function synchronizeTab(tab: WorkspaceTab): Promise<void> {
  if (tab.kind === 'session') {
    useSessionsStore.getState().select(tab.resourceId)
    useUiStore.getState().setActivePage('workbench')
    return
  }
  if (tab.kind === 'compare') {
    useCompareStore.getState().setActiveRun(tab.resourceId)
    useUiStore.getState().setActivePage('compare')
    return
  }
  // 记忆详情（长期记忆单条）只在内容页渲染，不触发会话回放加载。
  if (tab.kind === 'memory-detail') {
    useUiStore.getState().setActivePage('memory')
    return
  }

  useUiStore.getState().setActivePage('memory')
  await useMemoryViewStore.getState().open(tab.resourceId)
}

export function openWorkspaceTab(input: WorkspaceTabInput): void {
  const tab = useWorkspaceTabsStore.getState().open(input)
  void synchronizeTab(tab)
}

export function focusWorkspaceTab(id: string): void {
  const tab = useWorkspaceTabsStore.getState().activate(id)
  if (tab) void synchronizeTab(tab)
}

export function closeWorkspaceTabView(id: string): void {
  const closing = useWorkspaceTabsStore.getState().tabs.find((tab) => tab.id === id)
  const fallback = useWorkspaceTabsStore.getState().close(id)
  if (closing?.kind === 'memory' && closing.resourceId === useMemoryViewStore.getState().selectedSessionId) {
    useMemoryViewStore.getState().close()
  }
  if (fallback) void synchronizeTab(fallback)
  else useUiStore.getState().setActivePage('workbench')
}

export function cycleWorkspaceTabs(direction: 1 | -1): void {
  const tab = useWorkspaceTabsStore.getState().cycle(direction)
  if (tab) void synchronizeTab(tab)
}

export function focusWorkspaceTabAt(oneBasedIndex: number): void {
  const tab = useWorkspaceTabsStore.getState().activateAt(oneBasedIndex)
  if (tab) void synchronizeTab(tab)
}

export function navigateToPage(page: PageKey): void {
  useWorkspaceTabsStore.getState().clearActive()
  if (page === 'workbench') useSessionsStore.getState().select(null)
  if (page === 'compare') useCompareStore.getState().setActiveRun(null)
  if (page === 'memory') useMemoryViewStore.getState().close()
  useUiStore.getState().setActivePage(page)
}

export function restoreActiveWorkspaceTab(): void {
  const { tabs, activeTabId } = useWorkspaceTabsStore.getState()
  const tab = tabs.find((item) => item.id === activeTabId)
  if (tab) void synchronizeTab(tab)
}
