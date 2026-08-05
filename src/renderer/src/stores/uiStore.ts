// UI 全局状态（SPEC-001）。导航、壳体、平台信息、Modal 开关。

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { IPC_CONTRACT_VERSION, type PlatformInfo } from '@shared/ipc-contract'
import type { ThemePreference } from '../lib/theme'
import type { LanguagePreference } from '@shared/i18n'

export type PageKey =
  | 'workbench'
  | 'board'
  | 'schedule'
  | 'compare'
  | 'memory'
  | 'stats'
  | 'webagg'
  | 'overview'

/** 工作台镜头模式（SPEC-005 v2）。会话 = 结构化对话；cli = 原生终端。 */
export type WorkbenchMode = 'chat' | 'cli'

interface UiState {
  activePage: PageKey
  platform: PlatformInfo | null
  onboardingCompleted: boolean
  ipcContractMismatch: boolean
  workbenchMode: WorkbenchMode
  themePreference: ThemePreference
  /** SPEC-036：界面语言偏好（跟随系统/中文/英文）；实际生效语言由 useT/V3App effect 解析。 */
  languagePreference: LanguagePreference
  searchModalOpen: boolean
  settingsModalOpen: boolean
  dockCollapsed: boolean
  /** Web 镜头没有选中站点时默认打开的书签。 */
  webDefaultHomeId: string | null
  /** 最近使用过的项目路径（最多 5 条，最近在前），供新建会话/CLI 选择器回显。 */
  recentProjects: string[]
  /** 远程节点最近使用过的项目路径，按 runtime host 隔离。 */
  recentRemoteProjects: Record<string, string[]>
  addRecentProject(path: string): void
  addRecentRemoteProject(hostId: string, path: string): void
  setActivePage(page: PageKey): void
  setPlatform(info: PlatformInfo): void
  setOnboardingCompleted(value: boolean): void
  setWorkbenchMode(mode: WorkbenchMode): void
  setThemePreference(pref: ThemePreference): void
  setLanguagePreference(pref: LanguagePreference): void
  openSearchModal(): void
  closeSearchModal(): void
  openSettingsModal(): void
  closeSettingsModal(): void
  setDockCollapsed(collapsed: boolean): void
  setWebDefaultHomeId(id: string | null): void
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activePage: 'workbench',
      platform: null,
      onboardingCompleted: false,
      ipcContractMismatch: false,
      workbenchMode: 'chat',
      themePreference: 'system',
      languagePreference: 'system',
      searchModalOpen: false,
      settingsModalOpen: false,
      dockCollapsed: false,
      webDefaultHomeId: 'bm-agent-life',
      recentProjects: [],
      recentRemoteProjects: {},
      addRecentProject: (path) =>
        set((state) => {
          const trimmed = path.trim()
          if (!trimmed) return state
          const next = [trimmed, ...state.recentProjects.filter((p) => p !== trimmed)].slice(0, 5)
          return { recentProjects: next }
        }),
      addRecentRemoteProject: (hostId, path) =>
        set((state) => {
          const trimmed = path.trim()
          if (!hostId || !trimmed) return state
          const prev = state.recentRemoteProjects[hostId] ?? []
          return {
            recentRemoteProjects: {
              ...state.recentRemoteProjects,
              [hostId]: [trimmed, ...prev.filter((p) => p !== trimmed)].slice(0, 5)
            }
          }
        }),
      setActivePage: (page) => set({ activePage: page }),
      setPlatform: (info) =>
        set({
          platform: info,
          onboardingCompleted: info.onboardingCompleted,
          ipcContractMismatch: info.ipcContractVersion !== IPC_CONTRACT_VERSION
        }),
      setOnboardingCompleted: (value) => set({ onboardingCompleted: value }),
      setWorkbenchMode: (mode) => set({ workbenchMode: mode }),
      setThemePreference: (pref) => set({ themePreference: pref }),
      setLanguagePreference: (pref) => set({ languagePreference: pref }),
      openSearchModal: () => set({ searchModalOpen: true }),
      closeSearchModal: () => set({ searchModalOpen: false }),
      openSettingsModal: () => set({ settingsModalOpen: true }),
      closeSettingsModal: () => set({ settingsModalOpen: false }),
      setDockCollapsed: (collapsed) => set({ dockCollapsed: collapsed }),
      setWebDefaultHomeId: (id) => set({ webDefaultHomeId: id })
    }),
    {
      name: 'agent-os.ui',
      storage: createJSONStorage(() => localStorage),
      // 持久化 dockCollapsed 与 workbenchMode；其余仅会话内
      partialize: (state) => ({
        dockCollapsed: state.dockCollapsed,
        workbenchMode: state.workbenchMode,
        themePreference: state.themePreference,
        languagePreference: state.languagePreference,
        webDefaultHomeId: state.webDefaultHomeId,
        recentProjects: state.recentProjects,
        recentRemoteProjects: state.recentRemoteProjects
      })
    }
  )
)
