import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import {
  activateWorkspaceTab,
  clearWorkspaceTabHighlight,
  closeWorkspaceTabs,
  closeWorkspaceTab,
  cycleWorkspaceTabId,
  openOrFocusWorkspaceTab,
  pruneWorkspaceTabs,
  reorderWorkspaceTab,
  restoreWorkspaceTabs,
  setWorkspaceTabPinned,
  syncWorkspaceSessionTabTitles,
  workspaceTabIdAtIndex,
  type WorkspaceTab,
  type WorkspaceTabInput
} from '@shared/workspace-tabs'

interface WorkspaceTabsState {
  tabs: WorkspaceTab[]
  activeTabId: string | null
  open(input: WorkspaceTabInput): WorkspaceTab
  activate(id: string): WorkspaceTab | null
  clearHighlight(id: string): void
  syncSessionTitles(titles: Readonly<Record<string, string>>): void
  close(id: string): WorkspaceTab | null
  closeMany(ids: readonly string[]): WorkspaceTab | null
  setPinned(id: string, pinned: boolean): WorkspaceTab | null
  reorder(draggedId: string, targetId: string): void
  clearActive(): void
  cycle(direction: 1 | -1): WorkspaceTab | null
  activateAt(oneBasedIndex: number): WorkspaceTab | null
  prune(validSessionIds: ReadonlySet<string>, validCompareIds: ReadonlySet<string>): void
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeTabId: null,
      open: (input) => {
        const next = openOrFocusWorkspaceTab(get(), input)
        set(next)
        return next.tabs.find((tab) => tab.id === next.activeTabId)!
      },
      activate: (id) => {
        const next = activateWorkspaceTab(get(), id)
        set(next)
        return next.tabs.find((tab) => tab.id === next.activeTabId) ?? null
      },
      clearHighlight: (id) => set((state) => clearWorkspaceTabHighlight(state, id)),
      syncSessionTitles: (titles) =>
        set((state) => syncWorkspaceSessionTabTitles(state, titles)),
      close: (id) => {
        const next = closeWorkspaceTab(get(), id)
        set(next)
        return next.tabs.find((tab) => tab.id === next.activeTabId) ?? null
      },
      closeMany: (ids) => {
        const next = closeWorkspaceTabs(get(), ids)
        set(next)
        return next.tabs.find((tab) => tab.id === next.activeTabId) ?? null
      },
      setPinned: (id, pinned) => {
        const next = setWorkspaceTabPinned(get(), id, pinned)
        set(next)
        return next.tabs.find((tab) => tab.id === id) ?? null
      },
      reorder: (draggedId, targetId) =>
        set((state) => reorderWorkspaceTab(state, draggedId, targetId)),
      clearActive: () => set({ activeTabId: null }),
      cycle: (direction) => {
        const state = get()
        const id = cycleWorkspaceTabId(state.tabs, state.activeTabId, direction)
        if (!id) return null
        const next = activateWorkspaceTab(state, id)
        set(next)
        return next.tabs.find((tab) => tab.id === id) ?? null
      },
      activateAt: (oneBasedIndex) => {
        const state = get()
        const id = workspaceTabIdAtIndex(state.tabs, oneBasedIndex)
        if (!id) return null
        const next = activateWorkspaceTab(state, id)
        set(next)
        return next.tabs.find((tab) => tab.id === id) ?? null
      },
      prune: (validSessionIds, validCompareIds) =>
        set((state) => pruneWorkspaceTabs(state, validSessionIds, validCompareIds))
    }),
    {
      name: 'agent-os.workspace-tabs',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ tabs: state.tabs, activeTabId: state.activeTabId }),
      merge: (persisted, current) => ({
        ...current,
        ...restoreWorkspaceTabs(persisted)
      })
    }
  )
)
