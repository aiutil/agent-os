// 工作台会话状态（SPEC-005/017）。会话视图列表 + 选中 + 新建 + CLI 切换。
// 终端状态变化时由 App 订阅事件触发 refresh，保持 Rail 卡片状态点实时。

import { create } from 'zustand'
import { tr } from '@shared/i18n'
import type { CreateSessionInput, StartRelayPayload, WorkbenchSessionView } from '@shared/types'
import { findTaskSessionView } from '@shared/task-detail'
import { useNotificationStore, type NotificationTone } from './notificationStore'

interface RelayUiState {
  sourceSessionId: string
  targetToolId: string
  targetName: string
  step: 'preparing' | 'failed'
  error?: string
  cancelable: boolean
}

interface SessionsState {
  views: WorkbenchSessionView[]
  selectedId: string | null
  /** 当前选中的项目分组（工作目录），新建会话据此继承路径（SPEC-005 v2）。 */
  selectedProjectPath: string | null
  /** 待发送的首回合消息与附件，按 sessionId 暂存，ChatPane 挂载时消费。 */
  pendingPrompt: Record<string, PendingInitialTurn>
  loading: boolean
  relayUi: RelayUiState | null
  notice: string | null
  refresh(): Promise<void>
  select(id: string | null): void
  selectProject(path: string | null): void
  setPendingPrompt(id: string, turn: PendingInitialTurn): void
  consumePendingPrompt(id: string): PendingInitialTurn | undefined
  create(input: CreateSessionInput): Promise<WorkbenchSessionView | null>
  resume(id: string): Promise<void>
  reopen(id: string): Promise<WorkbenchSessionView | null>
  openExisting(id: string): Promise<WorkbenchSessionView | null>
  openLinkedTerminal(id: string): Promise<WorkbenchSessionView | null>
  relay(payload: StartRelayPayload, targetName: string): Promise<WorkbenchSessionView | null>
  clearRelayUi(): void
  setNotice(msg: string, tone?: NotificationTone): void
  clearNotice(): void
  remove(id: string): Promise<void>
  toggleFavorite(id: string, favorite: boolean): Promise<void>
  togglePinned(id: string, pinned: boolean): Promise<void>
  archive(id: string): Promise<void>
  rename(id: string, name: string): Promise<void>
}

export interface PendingInitialTurn {
  text: string
  files?: string[]
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  views: [],
  selectedId: null,
  selectedProjectPath: null,
  pendingPrompt: {},
  loading: false,
  relayUi: null,
  notice: null,
  refresh: async () => {
    const views = await window.agentOs.session.listViews()
    set((state) => ({
      views,
      // 选中项被删除时回到工作台首页，不隐式打开其他资源。
      selectedId:
        state.selectedId && views.some((v) => v.id === state.selectedId) ? state.selectedId : null
    }))
  },
  select: (id) => set({ selectedId: id }),
  selectProject: (path) => set({ selectedProjectPath: path }),
  setPendingPrompt: (id, turn) =>
    set((state) => ({ pendingPrompt: { ...state.pendingPrompt, [id]: turn } })),
  consumePendingPrompt: (id) => {
    const turn = get().pendingPrompt[id]
    if (turn === undefined) return undefined
    set((state) => {
      const next = { ...state.pendingPrompt }
      delete next[id]
      return { pendingPrompt: next }
    })
    return turn
  },
  create: async (input) => {
    set({ loading: true })
    try {
      const { session } = await window.agentOs.session.create(input)
      await get().refresh()
      set({ selectedId: session.id })
      return get().views.find((v) => v.id === session.id) ?? null
    } finally {
      set({ loading: false })
    }
  },
  resume: async (id) => {
    set({ loading: true, notice: null })
    try {
      const { session } = await window.agentOs.session.resume(id)
      await get().refresh()
      set({ selectedId: session.id })
    } catch (error) {
      const message = String((error as Error).message ?? error)
      const notice = message.includes('[RESUME_FAILED]')
        ? tr('system.sessionNotice.resumeFailed')
        : message.includes('[NO_NATIVE_ID]') || message.includes('[RESUME_UNSUPPORTED]')
          ? tr('system.sessionNotice.resumeUnsupported')
          : tr('system.sessionNotice.startFailed')
      get().setNotice(notice, 'error')
      await get().refresh()
    } finally {
      set({ loading: false })
    }
  },
  reopen: async (id) => {
    const view = get().views.find((item) => item.id === id)
    if (!view) return null
    const created = await get().create({
      name: view.name,
      toolId: view.toolId,
      workspacePath: view.workspacePath,
      surface: view.surface,
      permissionPreset: view.permissionPreset,
      ...(view.model ? { model: view.model } : {}),
      ...(view.reasoningEffort ? { reasoningEffort: view.reasoningEffort } : {})
    })
    if (created) get().setNotice(tr('system.sessionNotice.reopened'), 'success')
    return created
  },
  openExisting: async (id) => {
    set({ loading: true, notice: null })
    try {
      await get().refresh()
      const view = findTaskSessionView(id, get().views)
      if (!view) {
        get().setNotice(tr('system.sessionNotice.taskSessionUnavailable'), 'warning')
        return null
      }
      set({ selectedId: view.id })
      return view
    } catch {
      get().setNotice(tr('system.sessionNotice.taskSessionOpenFailed'), 'error')
      return null
    } finally {
      set({ loading: false })
    }
  },
  openLinkedTerminal: async (id) => {
    set({ loading: true, notice: null })
    try {
      const { session } = await window.agentOs.session.openLinkedTerminal(id)
      await get().refresh()
      set({ selectedId: session.id })
      return get().views.find((view) => view.id === session.id) ?? null
    } catch {
      get().setNotice(tr('system.sessionNotice.noTerminalLink'), 'warning')
      return null
    } finally {
      set({ loading: false })
    }
  },
  relay: async (payload, targetName) => {
    set({
      relayUi: {
        sourceSessionId: payload.sourceSessionId,
        targetToolId: payload.targetToolId,
        targetName,
        step: 'preparing',
        cancelable: true
      }
    })
    try {
      const result = await window.agentOs.relay.start(payload)
      await get().refresh()
      set({ selectedId: result.targetSessionId, relayUi: null })
      return get().views.find((view) => view.id === result.targetSessionId) ?? null
    } catch (error) {
      const message = String((error as Error).message ?? error)
      set((state) => ({
        relayUi: state.relayUi
          ? { ...state.relayUi, step: 'failed', error: message, cancelable: false }
          : null
      }))
      get().setNotice(tr('workbench.relay.failedWithError', { error: message }), 'error')
      await get().refresh()
      return null
    }
  },
  clearRelayUi: () => set({ relayUi: null }),
  setNotice: (msg, tone = 'info') => {
    set({ notice: msg })
    useNotificationStore.getState().show({ message: msg, tone })
  },
  clearNotice: () => set({ notice: null }),
  remove: async (id) => {
    await window.agentOs.session.remove(id)
    await get().refresh()
  },
  toggleFavorite: async (id, favorite) => {
    await window.agentOs.session.update(id, { favorite })
    await get().refresh()
  },
  togglePinned: async (id, pinned) => {
    await window.agentOs.session.update(id, { pinned })
    await get().refresh()
  },
  archive: async (id) => {
    await window.agentOs.session.update(id, { archived: true })
    await get().refresh()
  },
  rename: async (id, name) => {
    // SPEC-035：trim + 非空 + 80 字上限；nameProvisional:false 锁定，5 处自动改名不再覆盖。
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) return
    await window.agentOs.session.update(id, { name: trimmed, nameProvisional: false })
    await get().refresh()
  }
}))
