export type WorkspaceTabKind =
  | 'session'
  | 'compare'
  | 'memory'
  | 'memory-detail'
  | 'memory-new'
  | 'persona'
  | 'knowledge'
  | 'web'
  | 'terminal'
  | 'cli-history'

/** 全部合法标签种类，供恢复/校验复用，避免散落字面量。 */
export const WORKSPACE_TAB_KINDS: readonly WorkspaceTabKind[] = [
  'session',
  'compare',
  'memory',
  'memory-detail',
  'memory-new',
  'persona',
  'knowledge',
  'web',
  'terminal',
  'cli-history'
]

export interface WorkspaceTab {
  id: string
  kind: WorkspaceTabKind
  resourceId: string
  title: string
  toolId?: string
  pinned?: boolean
  openedAt: number
  lastActiveAt: number
  /** 从全局搜索跳转携带的搜索词；目标视图渲染时高亮并滚动到首个匹配，消费后清空。不持久化。 */
  highlight?: string
}

export interface WorkspaceTabInput {
  kind: WorkspaceTabKind
  resourceId: string
  title: string
  toolId?: string
  /** 从全局搜索跳转时携带，用于跳转后在内容里高亮该词。 */
  highlight?: string
}

export interface WorkspaceTabsSnapshot {
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

export function workspaceTabId(kind: WorkspaceTabKind, resourceId: string): string {
  return `${kind}:${resourceId}`
}

export function orderWorkspaceTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return [
    ...tabs.filter((tab) => tab.pinned),
    ...tabs.filter((tab) => !tab.pinned)
  ]
}

export function openOrFocusWorkspaceTab(
  snapshot: WorkspaceTabsSnapshot,
  input: WorkspaceTabInput,
  now = Date.now()
): WorkspaceTabsSnapshot {
  const id = workspaceTabId(input.kind, input.resourceId)
  const existing = snapshot.tabs.find((tab) => tab.id === id)

  if (existing) {
    return {
      tabs: orderWorkspaceTabs(
        snapshot.tabs.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                title: input.title,
                toolId: input.toolId,
                highlight: input.highlight,
                lastActiveAt: now
              }
            : tab
        )
      ),
      activeTabId: id
    }
  }

  return {
    tabs: orderWorkspaceTabs([
      ...snapshot.tabs,
      {
        id,
        kind: input.kind,
        resourceId: input.resourceId,
        title: input.title,
        toolId: input.toolId,
        highlight: input.highlight,
        openedAt: now,
        lastActiveAt: now
      }
    ]),
    activeTabId: id
  }
}

export function activateWorkspaceTab(
  snapshot: WorkspaceTabsSnapshot,
  id: string,
  now = Date.now()
): WorkspaceTabsSnapshot {
  if (!snapshot.tabs.some((tab) => tab.id === id)) return snapshot
  return {
    tabs: orderWorkspaceTabs(
      snapshot.tabs.map((tab) =>
        tab.id === id ? { ...tab, lastActiveAt: now } : tab
      )
    ),
    activeTabId: id
  }
}

export function clearWorkspaceTabHighlight(
  snapshot: WorkspaceTabsSnapshot,
  id: string
): WorkspaceTabsSnapshot {
  if (!snapshot.tabs.some((tab) => tab.id === id && tab.highlight)) return snapshot
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => (tab.id === id ? { ...tab, highlight: undefined } : tab))
  }
}

/** 更新已打开会话标签的展示标题，不改变激活态、顺序或最近访问时间。 */
export function syncWorkspaceSessionTabTitles(
  snapshot: WorkspaceTabsSnapshot,
  titles: Readonly<Record<string, string>>
): WorkspaceTabsSnapshot {
  let changed = false
  const tabs = snapshot.tabs.map((tab) => {
    if (tab.kind !== 'session') return tab
    const title = titles[tab.resourceId]
    if (!title || title === tab.title) return tab
    changed = true
    return { ...tab, title }
  })
  return changed ? { ...snapshot, tabs } : snapshot
}

export function closeWorkspaceTab(
  snapshot: WorkspaceTabsSnapshot,
  id: string
): WorkspaceTabsSnapshot {
  const tabs = snapshot.tabs.filter((tab) => tab.id !== id)
  if (snapshot.activeTabId !== id) {
    return { tabs, activeTabId: snapshot.activeTabId }
  }

  const fallback = [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  return { tabs, activeTabId: fallback?.id ?? null }
}

export function closeWorkspaceTabs(
  snapshot: WorkspaceTabsSnapshot,
  ids: readonly string[]
): WorkspaceTabsSnapshot {
  const closeIds = new Set(ids)
  if (closeIds.size === 0) return snapshot
  const tabs = snapshot.tabs.filter((tab) => !closeIds.has(tab.id))
  if (!closeIds.has(snapshot.activeTabId ?? '')) {
    return { tabs, activeTabId: snapshot.activeTabId }
  }

  const fallback = [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]
  return { tabs, activeTabId: fallback?.id ?? null }
}

export function setWorkspaceTabPinned(
  snapshot: WorkspaceTabsSnapshot,
  id: string,
  pinned: boolean
): WorkspaceTabsSnapshot {
  if (!snapshot.tabs.some((tab) => tab.id === id)) return snapshot
  return {
    tabs: orderWorkspaceTabs(
      snapshot.tabs.map((tab) => (tab.id === id ? { ...tab, pinned } : tab))
    ),
    activeTabId: snapshot.activeTabId
  }
}

export function reorderWorkspaceTab(
  snapshot: WorkspaceTabsSnapshot,
  draggedId: string,
  targetId: string
): WorkspaceTabsSnapshot {
  if (draggedId === targetId) return snapshot
  const dragged = snapshot.tabs.find((tab) => tab.id === draggedId)
  const target = snapshot.tabs.find((tab) => tab.id === targetId)
  if (!dragged || !target || Boolean(dragged.pinned) !== Boolean(target.pinned)) return snapshot

  const group = snapshot.tabs.filter((tab) => Boolean(tab.pinned) === Boolean(dragged.pinned))
  const from = group.findIndex((tab) => tab.id === draggedId)
  const to = group.findIndex((tab) => tab.id === targetId)
  if (from < 0 || to < 0) return snapshot

  const reorderedGroup = [...group]
  const [moved] = reorderedGroup.splice(from, 1)
  reorderedGroup.splice(to, 0, moved)

  const pinned = dragged.pinned
    ? reorderedGroup
    : snapshot.tabs.filter((tab) => tab.pinned)
  const unpinned = dragged.pinned
    ? snapshot.tabs.filter((tab) => !tab.pinned)
    : reorderedGroup

  return {
    tabs: [...pinned, ...unpinned],
    activeTabId: snapshot.activeTabId
  }
}

export type WorkspaceTabCloseMode = 'one' | 'others' | 'all' | 'left' | 'right'

export function workspaceTabIdsForCloseMode(
  tabs: readonly WorkspaceTab[],
  targetId: string,
  mode: WorkspaceTabCloseMode
): string[] {
  if (mode === 'one') return [targetId]
  if (mode === 'all') return tabs.filter((tab) => !tab.pinned).map((tab) => tab.id)

  const idx = tabs.findIndex((tab) => tab.id === targetId)
  if (idx < 0) return []

  const candidates =
    mode === 'others'
      ? tabs.filter((tab) => tab.id !== targetId)
      : mode === 'left'
        ? tabs.slice(0, idx)
        : tabs.slice(idx + 1)
  return candidates.filter((tab) => !tab.pinned).map((tab) => tab.id)
}

export function cycleWorkspaceTabId(
  tabs: WorkspaceTab[],
  activeTabId: string | null,
  direction: 1 | -1
): string | null {
  if (tabs.length === 0) return null
  const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId)
  if (currentIndex < 0) return direction === 1 ? tabs[0].id : tabs[tabs.length - 1].id
  return tabs[(currentIndex + direction + tabs.length) % tabs.length].id
}

export function workspaceTabIdAtIndex(tabs: WorkspaceTab[], oneBasedIndex: number): string | null {
  if (oneBasedIndex < 1 || oneBasedIndex > 9) return null
  return tabs[oneBasedIndex - 1]?.id ?? null
}

export function pruneWorkspaceTabs(
  snapshot: WorkspaceTabsSnapshot,
  validSessionIds: ReadonlySet<string>,
  validCompareIds: ReadonlySet<string>
): WorkspaceTabsSnapshot {
  const tabs = orderWorkspaceTabs(
    snapshot.tabs.filter((tab) => {
      if (tab.kind === 'session') return validSessionIds.has(tab.resourceId)
      if (tab.kind === 'compare') return validCompareIds.has(tab.resourceId)
      // 新建记忆是临时编辑态，不跨重启保留（避免恢复出指向空白的草稿页）。
      if (tab.kind === 'memory-new') return false
      return true
    })
  )
  const activeTabId = tabs.some((tab) => tab.id === snapshot.activeTabId)
    ? snapshot.activeTabId
    : null
  return { tabs, activeTabId }
}

export function restoreWorkspaceTabs(value: unknown): WorkspaceTabsSnapshot {
  if (!value || typeof value !== 'object') return { tabs: [], activeTabId: null }
  const candidate = value as { tabs?: unknown; activeTabId?: unknown }
  if (!Array.isArray(candidate.tabs)) return { tabs: [], activeTabId: null }

  const seen = new Set<string>()
  const tabs = orderWorkspaceTabs(
    candidate.tabs
      .filter((item): item is WorkspaceTab => {
        if (!item || typeof item !== 'object') return false
        const tab = item as Partial<WorkspaceTab>
        if (!tab.kind || !WORKSPACE_TAB_KINDS.includes(tab.kind)) return false
        if (typeof tab.resourceId !== 'string' || typeof tab.title !== 'string') return false
        if (!Number.isFinite(tab.openedAt) || !Number.isFinite(tab.lastActiveAt)) return false
        const expectedId = workspaceTabId(tab.kind, tab.resourceId)
        if (tab.id !== expectedId || seen.has(expectedId)) return false
        if (tab.toolId !== undefined && typeof tab.toolId !== 'string') return false
        if (tab.pinned !== undefined && typeof tab.pinned !== 'boolean') return false
        seen.add(expectedId)
        return true
      })
      // 高亮是一次性跳转态，不跨重启恢复，避免恢复后页面莫名泛黄。
      .map((tab) => (tab.highlight ? { ...tab, highlight: undefined } : tab))
  )

  const activeTabId =
    typeof candidate.activeTabId === 'string' &&
    tabs.some((tab) => tab.id === candidate.activeTabId)
      ? candidate.activeTabId
      : null
  return { tabs, activeTabId }
}
