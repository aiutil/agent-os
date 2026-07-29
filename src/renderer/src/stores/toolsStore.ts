// CLI 工具发现状态（SPEC-002）。首启动引导与 CLI 选择器共用。

import { create } from 'zustand'
import type { DiscoveryResult, RuntimeInfo } from '@shared/types'

interface ToolsState {
  results: DiscoveryResult[]
  runtimes: RuntimeInfo[]
  scanning: boolean
  scanError: string | null
  scannedAt: string | null
  scan(): Promise<void>
  replace(results: DiscoveryResult[]): void
}

export const useToolsStore = create<ToolsState>((set) => ({
  results: [],
  runtimes: [],
  scanning: false,
  scanError: null,
  scannedAt: null,
  replace: (results) => set({ results, scannedAt: new Date().toISOString() }),
  scan: async () => {
    set({ scanning: true, scanError: null })
    try {
      const [results, runtimes] = await Promise.all([
        window.agentOs.discovery.scan(),
        window.agentOs.runtime.listRuntimes()
      ])
      set({ results, runtimes, scannedAt: new Date().toISOString() })
    } catch (error) {
      set({ scanError: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ scanning: false })
    }
  }
}))
