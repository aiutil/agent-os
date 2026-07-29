// 对比工作台状态（SPEC-009）。

import { create } from 'zustand'
import type { CompareAdoptResult, CompareRunView } from '@shared/types'

interface CompareState {
  runs: CompareRunView[]
  activeRunId: string | null
  loading: boolean
  error: string | null
  refresh(): Promise<void>
  start(workspacePath: string, prompt: string, toolIds: string[]): Promise<void>
  adopt(runId: string, toolId: string): Promise<CompareAdoptResult>
  discard(runId: string): Promise<void>
  setActiveRun(id: string | null): void
  clearError(): void
}

export const useCompareStore = create<CompareState>((set, get) => ({
  runs: [],
  activeRunId: null,
  loading: false,
  error: null,

  refresh: async () => {
    const runs = await window.agentOs.compare.list()
    set({ runs })
  },

  start: async (workspacePath, prompt, toolIds) => {
    set({ loading: true, error: null })
    try {
      await window.agentOs.compare.start({ workspacePath, prompt, toolIds })
      await get().refresh()
      const runs = get().runs
      if (runs[0]) set({ activeRunId: runs[0].id })
    } catch (error) {
      set({ error: (error as Error).message ?? String(error) })
    } finally {
      set({ loading: false })
    }
  },

  adopt: async (runId, toolId) => {
    set({ loading: true, error: null })
    try {
      const result = await window.agentOs.compare.adopt(runId, toolId)
      await get().refresh()
      return result
    } catch (error) {
      set({ error: (error as Error).message ?? String(error) })
      return { merged: false, conflict: String(error) }
    } finally {
      set({ loading: false })
    }
  },

  discard: async (runId) => {
    set({ loading: true, error: null })
    try {
      await window.agentOs.compare.discard(runId)
      await get().refresh()
      if (get().activeRunId === runId) set({ activeRunId: null })
    } catch (error) {
      set({ error: (error as Error).message ?? String(error) })
    } finally {
      set({ loading: false })
    }
  },

  setActiveRun: (id) => set({ activeRunId: id }),
  clearError: () => set({ error: null })
}))
