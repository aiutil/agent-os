// 会话/CLI 启动的共享功能逻辑（供 Hero 与 新建CLI 弹窗复用）。
// 仅功能层：sessionsStore + toolsStore + uiStore + selectDirectory IPC。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkbenchMode } from '../../../stores/uiStore'
import type { RemoteNodeStatus, RuntimeDirectoryListing, WorkbenchSessionView } from '@shared/types'
import { useSessionsStore } from '../../../stores/sessionsStore'
import { useToolsStore } from '../../../stores/toolsStore'
import { useUiStore } from '../../../stores/uiStore'
import { BRAND_COLORS } from '../../../lib/toolIcons'
import type { ToolOption } from '../../shared/ToolSelector'
import type { WorkspaceOption } from '../../shared/WorkspaceSelector'
import { tr } from '@shared/i18n'
import { buildRemoteWorkspaceChoices } from '@shared/workspace-selector-behavior'

function basename(path: string): string {
  if (!path) return tr('chat.folder.home')
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

export interface HostOption {
  id: string
  label: string
  online: boolean
  /** 是否远程节点（本机为 false）。 */
  remote: boolean
}

/** SPEC-033：统一后端选择器里的一次选择——host+tool 原子绑定。 */
export interface BackendSelection {
  hostId: string
  toolId: string
}

/** 统一选择器的一节（本机或某远程节点）。 */
export interface BackendSection {
  hostId: string
  label: string
  connection: 'local' | RemoteNodeStatus['connection']
  /** 节点状态副标题（在线·N 个 CLI / 连接中… / 已禁用…）。 */
  sub: string
  /** 是否可选（禁用节点仍列出但不可选）。 */
  selectable: boolean
  options: ToolOption[]
}

export interface SessionLaunch {
  engineId: string
  setEngineId(id: string): void
  modelId: string
  setModelId(id: string): void
  reasoningEffort: string
  setReasoningEffort(id: string): void
  toolOptions: ToolOption[]
  workspaceOptions: WorkspaceOption[]
  workspacePath: string
  selectProject(path: string | null): void
  pickFolder(): Promise<void>
  launch(
    firstMessage?: string,
    attachments?: InitialLaunchAttachment[]
  ): Promise<WorkbenchSessionView | null>
  loading: boolean
  /** 运行位置：本机 + 各已配对远程节点。仅 length>1 时 UI 才需展示选择器。 */
  hostOptions: HostOption[]
  runtimeHostId: string
  setRuntimeHostId(id: string): void
  /** SPEC-033：统一后端选择器的分组（本机 + 各节点）；0 节点时仅一节「本机」。 */
  backendSections: BackendSection[]
  /** 当前后端（hostId+toolId，单一事实源）。 */
  backendSelection: BackendSelection
  /** 原子切换后端：一个 tick 同时定 host+tool。 */
  setBackend(sel: BackendSelection): void
}

export interface InitialLaunchAttachment {
  displayName: string
  path?: string
  bytes?: Uint8Array
}

export function useSessionLaunch(mode: WorkbenchMode): SessionLaunch {
  const views = useSessionsStore((s) => s.views)
  const create = useSessionsStore((s) => s.create)
  const remove = useSessionsStore((s) => s.remove)
  const setPendingPrompt = useSessionsStore((s) => s.setPendingPrompt)
  const selectedProjectPath = useSessionsStore((s) => s.selectedProjectPath)
  const selectProject = useSessionsStore((s) => s.selectProject)
  const loading = useSessionsStore((s) => s.loading)
  const setNotice = useSessionsStore((s) => s.setNotice)
  const tools = useToolsStore((s) => s.results)
  const runtimes = useToolsStore((s) => s.runtimes)
  const scan = useToolsStore((s) => s.scan)
  const recentProjects = useUiStore((s) => s.recentProjects)
  const recentRemoteProjects = useUiStore((s) => s.recentRemoteProjects)
  const addRecentProject = useUiStore((s) => s.addRecentProject)
  const addRecentRemoteProject = useUiStore((s) => s.addRecentRemoteProject)

  const [engineId, setEngineId] = useState('')
  const [modelId, setModelId] = useState('')
  const [reasoningEffort, setReasoningEffort] = useState('')
  const [runtimeHostId, setRuntimeHostId] = useState('local')
  const [remoteStatuses, setRemoteStatuses] = useState<RemoteNodeStatus[]>([])
  const [remoteWorkspaceByHost, setRemoteWorkspaceByHost] = useState<Record<string, string>>({})
  const [remoteListings, setRemoteListings] = useState<Record<string, RuntimeDirectoryListing>>({})
  // SPEC-033：离线重置的 2s 粘性窗 + toast 去重（避免 connecting 抖动把用户弹回本机）。
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticedAtRef = useRef<Map<string, number>>(new Map())

  // 运行位置：本机 + 已配对远程节点（实时跟踪连接状态）。
  useEffect(() => {
    void window.agentOs.runtime.remoteNodeStatuses().then(setRemoteStatuses).catch(() => {})
    const off = window.agentOs.events.onRemoteNodeStateChanged((s) =>
      setRemoteStatuses((prev) => {
        const next = prev.filter((p) => p.id !== s.id)
        next.push(s)
        return next
      })
    )
    return off
  }, [])
  const hostOptions: HostOption[] = [
    { id: 'local', label: tr('chat.node.local'), online: true, remote: false },
    ...remoteStatuses
      .filter((s) => s.enabled !== false)
      .map((s) => ({
        id: s.id,
        label: s.label,
        online: s.connection === 'connected',
        remote: true
      }))
  ]
  // 节点掉线/被禁用后，不保留不可用的远程选择，避免新会话落到离线 host。
  // 禁用/未知 host 立即重置；connecting/disconnected/error 走 2s 粘性窗吸收抖动。
  useEffect(() => {
    if (runtimeHostId === 'local') return
    const status = remoteStatuses.find((s) => s.id === runtimeHostId)
    if (!status || status.enabled === false) {
      if (offlineTimerRef.current) {
        clearTimeout(offlineTimerRef.current)
        offlineTimerRef.current = null
      }
      const label = status?.label ?? tr('chat.node.remoteNode')
      setRuntimeHostId('local')
      const now = Date.now()
      if (now - (noticedAtRef.current.get(runtimeHostId) ?? 0) > 5000) {
        noticedAtRef.current.set(runtimeHostId, now)
        setNotice(tr('chat.node.offlineFallback', { label }), 'warning')
      }
      return
    }
    if (status.connection === 'connected') {
      if (offlineTimerRef.current) {
        clearTimeout(offlineTimerRef.current)
        offlineTimerRef.current = null
      }
      return
    }
    // connecting / disconnected / error：2s 粘性后再重置（期间恢复在线则取消）。
    if (offlineTimerRef.current) return
    const hostId = runtimeHostId
    const label = status.label
    offlineTimerRef.current = setTimeout(() => {
      offlineTimerRef.current = null
      const cur = remoteStatuses.find((s) => s.id === hostId)
      if (cur && cur.connection !== 'connected') {
        setRuntimeHostId('local')
        const now = Date.now()
        if (now - (noticedAtRef.current.get(hostId) ?? 0) > 5000) {
          noticedAtRef.current.set(hostId, now)
          setNotice(tr('chat.node.offlineFallback', { label }), 'warning')
        }
      }
    }, 2000)
  }, [runtimeHostId, remoteStatuses, setNotice])

  const runtimeByTool = new Map(runtimes.map((r) => [r.toolId, r]))
  const localEngineList = tools.filter(
    (t) =>
      (t.health === 'ready' || t.health === 'updatable') &&
      (mode === 'cli' || (t.toolId !== 'shell' && runtimeByTool.get(t.toolId)?.capabilities.chat === true))
  )
  // 远程节点：engine 列表来自该节点上报的 agent（已禁用的不在内），带「远程·别名」标识。
  const selectedRemote =
    runtimeHostId !== 'local' ? remoteStatuses.find((s) => s.id === runtimeHostId) : undefined
  const toolOptions: ToolOption[] = selectedRemote
    ? (selectedRemote.agents ?? [])
        .filter((a) => a.enabled)
        .map((a) => ({
          key: a.id,
          label: a.alias || a.name,
          sub: tr('chat.node.remotePrefix', { label: selectedRemote.label }),
          color: BRAND_COLORS[a.id] ?? 'var(--text-muted)'
        }))
    : localEngineList.map((t) => ({
        key: t.toolId,
        label: t.displayName,
        sub: t.version ? `v${t.version}` : t.toolId,
        color: BRAND_COLORS[t.toolId] ?? 'var(--text-muted)'
      }))
  const engineKeys = toolOptions.map((t) => t.key)

  // SPEC-033：统一后端选择器的分组数据（本机 + 各已配对节点）。
  const backendSections: BackendSection[] = useMemo(() => {
    const localOptions: ToolOption[] = localEngineList.map((t) => ({
      key: `local/${t.toolId}`,
      label: t.displayName,
      sub: t.version ? `v${t.version}` : t.toolId,
      color: BRAND_COLORS[t.toolId] ?? 'var(--text-muted)'
    }))
    const remoteSections: BackendSection[] = remoteStatuses
      .filter((s) => s.enabled !== false)
      .map((s) => {
        const agents = (s.agents ?? []).filter((a) => a.enabled)
        let sub: string
        if (s.connection === 'connected') {
          sub = agents.length ? tr('chat.node.onlineWithCli', { count: agents.length }) : tr('chat.node.onlineDiscovering')
        } else if (s.connection === 'connecting') {
          sub = tr('common.state.connecting')
        } else if (s.connection === 'disabled') {
          sub = tr('chat.node.disabledHint')
        } else {
          sub = tr('common.state.offline')
        }
        return {
          hostId: s.id,
          label: s.label,
          connection: s.connection,
          sub,
          selectable: s.connection === 'connected',
          options: agents.map((a) => ({
            key: `${s.id}/${a.id}`,
            label: a.alias || a.name,
            sub: tr('chat.node.remotePrefix', { label: s.label }),
            color: BRAND_COLORS[a.id] ?? 'var(--text-muted)'
          }))
        }
      })
    return [
      {
        hostId: 'local',
        label: tr('chat.node.local'),
        connection: 'local' as const,
        sub: '',
        selectable: true,
        options: localOptions
      },
      ...remoteSections
    ]
  }, [tools, runtimes, mode, remoteStatuses])

  const backendSelection: BackendSelection = { hostId: runtimeHostId, toolId: engineId }

  // 原子切换：一个 tick 同时定 host+tool；仅当工具或主机真变才清 model（保留同工具本机重选）。
  const setBackend = useCallback(
    (sel: BackendSelection) => {
      setRuntimeHostId(sel.hostId)
      setEngineId(sel.toolId)
      if (sel.toolId !== engineId || sel.hostId !== 'local') {
        setModelId('')
        setReasoningEffort('')
      }
    },
    [engineId]
  )

  const isRemoteHost = runtimeHostId !== 'local' && Boolean(selectedRemote)
  const localSessionPaths = views
    .filter((v) => !v.runtimeHostId || v.runtimeHostId === 'local')
    .map((v) => v.workspacePath)
    .filter(Boolean)
  const remoteSessionPaths = isRemoteHost
    ? views
        .filter((v) => v.runtimeHostId === runtimeHostId)
        .map((v) => v.workspacePath)
        .filter(Boolean)
    : []
  const remoteRecent = isRemoteHost ? (recentRemoteProjects[runtimeHostId] ?? []) : []
  const remoteListing = isRemoteHost ? remoteListings[runtimeHostId] : undefined
  const remoteChoices = isRemoteHost
    ? buildRemoteWorkspaceChoices({
        selectedPath: remoteWorkspaceByHost[runtimeHostId],
        recentPaths: remoteRecent,
        sessionPaths: remoteSessionPaths,
        listing: remoteListing
      })
    : { paths: [] as string[], workspacePath: '' }
  const projectPaths = isRemoteHost
    ? remoteChoices.paths.slice(0, 12)
    : Array.from(new Set([...recentProjects, ...localSessionPaths])).slice(0, 5)
  const workspaceOptions: WorkspaceOption[] = projectPaths.map((p) => ({
    key: p,
    label: remoteListing?.parent === p ? `../${basename(p)}` : basename(p),
    git: false
  }))
  const workspacePath = isRemoteHost
    ? remoteChoices.workspacePath
    : (selectedProjectPath ?? localSessionPaths[0] ?? '')

  const browseRemoteDirectory = useCallback(
    async (path?: string): Promise<void> => {
      if (!isRemoteHost) return
      try {
        const listing = await window.agentOs.runtime.listDirectories({
          hostId: runtimeHostId,
          ...(path ? { path } : {})
        })
        setRemoteListings((prev) => ({ ...prev, [runtimeHostId]: listing }))
        setRemoteWorkspaceByHost((prev) => {
          if (prev[runtimeHostId] || path) return prev
          return { ...prev, [runtimeHostId]: listing.path || listing.home }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message || tr('chat.launch.createFailed'), 'error')
      }
    },
    [isRemoteHost, runtimeHostId, setNotice]
  )

  useEffect(() => {
    if (!isRemoteHost || selectedRemote?.connection !== 'connected') return
    void browseRemoteDirectory(remoteWorkspaceByHost[runtimeHostId])
  }, [isRemoteHost, selectedRemote?.connection, runtimeHostId])

  useEffect(() => {
    if (tools.length === 0) void scan()
  }, [tools.length, scan])
  useEffect(() => {
    if (engineKeys.length === 0) return
    if (!engineId || !engineKeys.includes(engineId)) {
      setEngineId(engineKeys[0])
    }
  }, [engineKeys, engineId])

  // 切换工具时清空覆盖 model（让 provider 配置的默认值生效）。
  useEffect(() => {
    setModelId('')
    setReasoningEffort('')
  }, [engineId])

  const selectWorkspace = (path: string | null): void => {
    if (isRemoteHost) {
      const next = path ?? ''
      setRemoteWorkspaceByHost((prev) => ({ ...prev, [runtimeHostId]: next }))
      if (next) {
        addRecentRemoteProject(runtimeHostId, next)
        void browseRemoteDirectory(next)
      }
      return
    }
    selectProject(path)
  }

  const pickFolder = async (): Promise<void> => {
    if (isRemoteHost) {
      await browseRemoteDirectory(workspacePath || undefined)
      return
    }
    const picked = await window.agentOs.app.selectDirectory(
      workspacePath ? { defaultPath: workspacePath } : undefined
    )
    if (picked) {
      selectWorkspace(picked)
      addRecentProject(picked)
    }
  }

  const launch = async (
    firstMessage?: string,
    attachments: InitialLaunchAttachment[] = []
  ): Promise<WorkbenchSessionView | null> => {
    if (!engineId) return null
    if (isRemoteHost && workspacePath.trim()) {
      try {
        const listing = await window.agentOs.runtime.listDirectories({
          hostId: runtimeHostId,
          path: workspacePath
        })
        setRemoteListings((prev) => ({ ...prev, [runtimeHostId]: listing }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message || tr('chat.launch.createFailed'), 'error')
        return null
      }
    }
    // 使用工作目录名作为通用名称，让 V3App 的自动重命名逻辑生效（transcript 或首条消息摘要）
    const name = workspacePath
      ? (mode === 'cli' ? tr('chat.launch.nameTerminal', { base: basename(workspacePath) }) : tr('chat.launch.nameChat', { base: basename(workspacePath) }))
      : tr('chat.launch.newSession')
    const created = await create({
      name,
      // SPEC-035：工作目录派生名是占位名，首回合后由真实标题覆盖。
      nameProvisional: true,
      toolId: engineId,
      workspacePath,
      surface: mode === 'cli' ? 'terminal' : 'chat',
      permissionPreset: 'safe',
      model: modelId || undefined,
      reasoningEffort: reasoningEffort || undefined,
      // 仅非本机时传，保持本机链路行为完全不变。
      runtimeHostId: runtimeHostId !== 'local' ? runtimeHostId : undefined
    })
    if (!created) {
      setNotice(tr('chat.launch.createFailed'), 'error')
      return null
    }
    if (workspacePath) {
      if (isRemoteHost) addRecentRemoteProject(runtimeHostId, workspacePath)
      else addRecentProject(workspacePath)
    }
    if (firstMessage?.trim()) {
      try {
        const files: string[] = []
        for (const attachment of attachments) {
          if (attachment.path) {
            files.push(attachment.path)
            continue
          }
          if (!attachment.bytes) throw new Error('附件内容为空')
          const staged = await window.agentOs.attachments.stage(
            created.id,
            attachment.displayName,
            attachment.bytes
          )
          files.push(staged.path)
        }
        setPendingPrompt(created.id, {
          text: firstMessage.trim(),
          ...(files.length ? { files } : {})
        })
      } catch (error) {
        await remove(created.id)
        const message = error instanceof Error ? error.message : String(error)
        setNotice(message || tr('chat.attach.pasteFailed'), 'error')
        return null
      }
    }
    return created
  }

  return {
    engineId,
    setEngineId,
    modelId,
    setModelId,
    reasoningEffort,
    setReasoningEffort,
    toolOptions,
    workspaceOptions,
    workspacePath,
    selectProject: selectWorkspace,
    pickFolder,
    launch,
    loading,
    hostOptions,
    runtimeHostId,
    setRuntimeHostId,
    backendSections,
    backendSelection,
    setBackend
  }
}
