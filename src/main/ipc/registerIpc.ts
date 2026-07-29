// IPC 注册（SPEC-000/017）。按 CHANNELS 契约把各域能力暴露给渲染端。
// handler 保持薄：仅做参数透传与组合，业务逻辑在各 domain。

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { CHANNELS, IPC_CONTRACT_VERSION, type PlatformInfo } from '@shared/ipc-contract'
import type {
  CreateSessionInput,
  CreateTaskInput,
  LifecycleJobKind,
  MirrorSettings,
  ProviderConfig,
  PermissionDecision,
  UpdateSessionPatch,
  UpdateTaskPatch,
  AnalyticsConfig,
  AnalyticsEventEnvelope
} from '@shared/types'
import { listAdapters } from '../domains/adapters/registry'
import { stageAttachment, deleteAttachments } from '../domains/attachments/store'
import { readClipboardFilePaths } from '../domains/attachments/clipboard'
import { AttachmentPreviewRegistry } from '../domains/attachments/preview'
import { loadNativeAttachmentPreview } from '../domains/attachments/native-preview'
import { scanAll, scanOne } from '../domains/discovery/discovery'
import { listToolModels } from '../domains/discovery/models'
import { refreshDataPlaneHealth } from '../domains/diagnostics/data-plane-health'
import {
  getOnboardingCompleted,
  getGamificationEnabled,
  setGamificationEnabled,
  getCardexState,
  setCardexState,
  setOnboardingCompleted,
  setNodeGatewayEnabled,
  setNodeGatewayAdvertiseHost,
  setManagedDiscoveryEnabled,
  getLanguage,
  setLanguage
} from '../store/app-store'
import { setCurrentLang, tr, type Lang } from '@shared/i18n'
import type { MemoryWorkerClient } from '../domains/memory/worker-client'
import type { VaultExperienceStore } from '../domains/memory/vault-experience-store'
import type { MemoryVault } from '../domains/memory/vault'
import type { MemoryCurationService } from '../domains/memory/curation'
import type { AnnotationsStore } from '../domains/annotations/store'
import type {
  AnnotationListFilter,
  AnnotationSetFavoriteInput,
  AnnotationSetTagsInput,
  AnnotationTagInput,
  AnnotationTargetRef,
  CardexState,
  CreateExperienceInput,
  MemoryInSessionSearchInput,
  MemorySearchInput,
  MemoryContextInput,
  MemoryFeedbackInput,
  ProposeMemoryInput,
  UpdateDurableMemoryPatch,
  ListDurableMemoriesInput,
  MemorySettings,
  CuratorCandidate,
  CurateMemoryInput,
  UpdateExperiencePatch,
  StatsExportCsvInput,
  StatsQuery
} from '@shared/types'
import type { RuntimeHost } from '../domains/runtime/protocol'
import type { LifecycleService } from '../domains/lifecycle/service'
import type { CompareService } from '../domains/compare/service'
import type { WebAggService } from '../domains/webagg/service'
import type { UpdateService } from '../domains/update/service'
import type { RemoteNodeRegistry } from '../domains/runtime/remote-registry'
import type { CreateEnrollmentInput } from '@shared/types'
import type { ManagedDeviceAuthorizationStatus } from '@shared/types'
import type { ApproveManagedPairingInput } from '@shared/types'
import type { ManagedDevicePairingService } from '../domains/runtime/managed-device-pairing'
import {
  mergeRemoteNodeStatuses,
  type ManagedDeviceControllerRegistry
} from '../domains/runtime/managed-device-controller-registry'
import { sendTurnWithSemanticAutomation } from '../domains/tasks/semantic-task-automation'
import {
  searchAgentChats,
  mergeSessionHits,
  type AgentChatSearchDeps
} from '../domains/sessions/session-search'
import type { ViewBounds } from '@shared/types'
import type { ChannelManager } from '../domains/channels/manager'
import type { AddChannelAccountInput, ChannelBinding, ChannelAcl } from '@shared/types'
import { RelayService } from '../domains/relay/service'
import { PortableBackupService } from '../domains/backup/service'
import { buildStatsCsvArtifact } from '../domains/stats/export'

// macOS traffic-light 在 Dock 列上方所需的安全垂直间距。
const MAC_TITLEBAR_HEIGHT = 28

function getLoginUserName(): string {
  const osUser = userInfo().username.trim()
  return (
    osUser || process.env['USER'] || process.env['USERNAME'] || process.env['LOGNAME'] || 'Agent OS'
  )
}

export function registerIpc(
  runtime: RuntimeHost,
  memory: MemoryWorkerClient,
  vault: MemoryVault,
  curation: MemoryCurationService,
  experiences: VaultExperienceStore,
  lifecycle: LifecycleService,
  restartDaemon: () => Promise<unknown>,
  compare: CompareService,
  webagg: WebAggService,
  sessionSearch: AgentChatSearchDeps,
  annotations: AnnotationsStore,
  updateService: UpdateService,
  remoteRegistry: RemoteNodeRegistry,
  managedControllers: ManagedDeviceControllerRegistry,
  managedPairing: ManagedDevicePairingService,
  channelManager: ChannelManager,
  analytics: {
    config(): AnalyticsConfig
    setEnabled(enabled: boolean): AnalyticsConfig
    resetIdentity(): AnalyticsConfig
    drain(): AnalyticsEventEnvelope[]
  }
): void {
  // SPEC-036：启动时把持久化语言播种到运行时变量（主进程 tr() 用；默认 'zh'）。
  setCurrentLang(getLanguage())

  // SPEC-038：附件暂存根目录（粘贴/拖拽文件物化到此；session 删除时清理）。
  const attachmentsRoot = join(app.getPath('userData'), 'attachments')
  const attachmentPreviews = new AttachmentPreviewRegistry()
  const portableBackup = new PortableBackupService(runtime, vault, app.getVersion())
  const approvedBackupImports = new Map<
    string,
    { filePath: string; fingerprint: string; expiresAt: number }
  >()

  // --- app ---
  ipcMain.handle(CHANNELS.app.getPlatformInfo, (): PlatformInfo => {
    return {
      platform: process.platform,
      userName: getLoginUserName(),
      titlebarHeight: process.platform === 'darwin' ? MAC_TITLEBAR_HEIGHT : 0,
      onboardingCompleted: getOnboardingCompleted(),
      ipcContractVersion: IPC_CONTRACT_VERSION
    }
  })

  ipcMain.handle(CHANNELS.app.getAnalyticsConfig, () => analytics.config())
  ipcMain.handle(CHANNELS.app.setAnalyticsEnabled, (_event, enabled: boolean) =>
    analytics.setEnabled(enabled)
  )
  ipcMain.handle(CHANNELS.app.resetAnalyticsIdentity, () => analytics.resetIdentity())
  ipcMain.handle(CHANNELS.app.drainAnalyticsEvents, () => analytics.drain())

  ipcMain.handle(CHANNELS.app.completeOnboarding, () => {
    setOnboardingCompleted(true)
  })

  ipcMain.handle(CHANNELS.app.resetOnboarding, () => {
    setOnboardingCompleted(false)
  })

  ipcMain.handle(
    CHANNELS.app.selectDirectory,
    async (event, options?: { defaultPath?: string }): Promise<string | null> => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const defaultPath =
        options?.defaultPath && existsSync(options.defaultPath) ? options.defaultPath : undefined
      const result = await dialog.showOpenDialog(owner ?? undefined!, {
        title: tr('system.dialog.selectDirectory'),
        properties: ['openDirectory', 'createDirectory'],
        ...(defaultPath ? { defaultPath } : {})
      })
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    }
  )

  ipcMain.handle(
    CHANNELS.app.selectFile,
    async (event, options?: { allowedExtensions?: string[] }): Promise<string | null> => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const filters = options?.allowedExtensions?.length
        ? [{ name: tr('system.dialog.file'), extensions: options.allowedExtensions }]
        : [{ name: tr('system.dialog.allFiles'), extensions: ['*'] }]
      const result = await dialog.showOpenDialog(owner ?? undefined!, {
        title: tr('system.dialog.selectFile'),
        properties: ['openFile'],
        filters
      })
      const path = result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
      if (path) attachmentPreviews.approve(path)
      return path
    }
  )

  // SPEC-038：附件暂存（粘贴图片/拖拽文件的字节 → 本地绝对路径）。
  ipcMain.handle(
    CHANNELS.attachments.stage,
    (_event, sessionId: string, filename: string, bytes: Uint8Array) => {
      const staged = stageAttachment(attachmentsRoot, sessionId, filename, bytes)
      attachmentPreviews.approve(staged.path)
      return staged
    }
  )

  // SPEC-038：读剪贴板里「复制的文件」的绝对路径（Finder/资源管理器 → 渲染层拿不到磁盘路径）。
  ipcMain.handle(CHANNELS.attachments.readClipboardFiles, async () => {
    const paths = await readClipboardFilePaths()
    attachmentPreviews.approveMany(paths)
    return paths
  })

  // SPEC-043：只为已授权本地路径返回缩放后的图片 data URL。
  ipcMain.handle(CHANNELS.attachments.preview, (_event, path: string) =>
    attachmentPreviews.preview(path, loadNativeAttachmentPreview)
  )

  ipcMain.handle(CHANNELS.app.openExternal, async (_event, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  // SPEC-036：渲染端改语言 → 持久化 + 即时更新主进程 tr()。
  ipcMain.handle(CHANNELS.app.setLanguage, (_event, lang: Lang): void => {
    setLanguage(lang)
    setCurrentLang(lang)
  })

  ipcMain.handle(CHANNELS.backup.export, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const date = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(owner ?? undefined!, {
      title: tr('system.dialog.exportBackup'),
      defaultPath: `Agent-OS-${date}.agentos-backup.json`,
      filters: [{ name: 'Agent OS Backup', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { cancelled: true }
    const summary = await portableBackup.exportTo(result.filePath)
    return { cancelled: false, path: result.filePath, summary }
  })

  ipcMain.handle(CHANNELS.backup.previewImport, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(owner ?? undefined!, {
      title: tr('system.dialog.importBackup'),
      properties: ['openFile'],
      filters: [{ name: 'Agent OS Backup', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return { cancelled: true }
    const filePath = result.filePaths[0]
    const fingerprintBefore = portableBackup.fingerprint(filePath)
    const summary = portableBackup.preview(filePath)
    const fingerprint = portableBackup.fingerprint(filePath)
    if (fingerprint !== fingerprintBefore) throw new Error('备份文件在预览期间发生变化，请重新选择')
    const approvalToken = randomUUID()
    const expiresAt = Date.now() + 5 * 60_000
    for (const [token, approval] of approvedBackupImports) {
      if (approval.expiresAt <= Date.now()) approvedBackupImports.delete(token)
    }
    approvedBackupImports.set(approvalToken, { filePath, fingerprint, expiresAt })
    return { cancelled: false, approvalToken, summary }
  })

  ipcMain.handle(CHANNELS.backup.import, async (_event, approvalToken: string) => {
    const approval = approvedBackupImports.get(approvalToken)
    approvedBackupImports.delete(approvalToken)
    if (!approval || approval.expiresAt <= Date.now()) {
      throw new Error('请先通过系统文件选择器预览备份')
    }
    const result = await portableBackup.importFrom(approval.filePath, approval.fingerprint)
    setCurrentLang(getLanguage())
    return result
  })

  // --- discovery ---
  ipcMain.handle(CHANNELS.discovery.scan, () => scanAll())
  ipcMain.handle(CHANNELS.discovery.get, (_event, toolId: string) => scanOne(toolId))
  ipcMain.handle(CHANNELS.discovery.listModels, async (_event, toolId: string) => {
    const found = await scanOne(toolId)
    return listToolModels(toolId, found?.executablePath)
  })
  // SPEC-033：按 host 取模型（本机或缺省走本机；远程节点经联邦 RPC）。
  ipcMain.handle(
    CHANNELS.discovery.listModelsOn,
    (_event, input: { toolId: string; hostId?: string }) =>
      runtime.listModels(input.toolId, input.hostId)
  )

  // --- CLI lifecycle / provider ---
  ipcMain.handle(
    CHANNELS.tool.startJob,
    (_event, input: { toolId: string; kind: LifecycleJobKind }) =>
      lifecycle.startJob(input.toolId, input.kind)
  )
  ipcMain.handle(CHANNELS.tool.job, (_event, jobId: string) => lifecycle.getJob(jobId))
  ipcMain.handle(CHANNELS.tool.cancelJob, (_event, jobId: string) => lifecycle.cancelJob(jobId))
  ipcMain.handle(CHANNELS.provider.get, (_event, toolId: string) => lifecycle.getProvider(toolId))
  ipcMain.handle(CHANNELS.provider.set, (_event, config: ProviderConfig) =>
    lifecycle.setProvider(config)
  )
  ipcMain.handle(CHANNELS.settings.getMirror, () => lifecycle.getMirrorSettings())
  ipcMain.handle(CHANNELS.settings.setMirror, (_event, settings: MirrorSettings) => {
    lifecycle.setMirrorSettings(settings)
  })

  // --- runtime ---
  ipcMain.handle(CHANNELS.runtime.listRuntimes, () => runtime.listRuntimes())
  ipcMain.handle(CHANNELS.runtime.listDirectories, (_event, input) =>
    runtime.listDirectories(input)
  )
  ipcMain.handle(CHANNELS.runtime.hostStatus, () => runtime.hostStatus())
  ipcMain.handle(CHANNELS.runtime.restartDaemon, () => restartDaemon())
  ipcMain.handle(
    CHANNELS.runtime.checkUpdate,
    (_event, opts?: { silent?: boolean; force?: boolean }) => updateService.check(opts ?? {})
  )
  // 兼容旧入口：applyUpdate 触发下载，下载完成后由 UI 调 installUpdate。
  ipcMain.handle(CHANNELS.runtime.applyUpdate, () => updateService.startDownload())
  ipcMain.handle(CHANNELS.runtime.downloadUpdate, () => updateService.startDownload())
  ipcMain.handle(CHANNELS.runtime.installUpdate, (_event, opts?: { quitAfterOpen?: boolean }) =>
    updateService.install(opts ?? {})
  )
  ipcMain.handle(CHANNELS.runtime.updateState, () => updateService.getState())

  // --- 局域网远程节点（SPEC-032：反向接入 + 远程托管）---
  ipcMain.handle(CHANNELS.runtime.listRemoteNodes, () => remoteRegistry.list())
  ipcMain.handle(CHANNELS.runtime.removeRemoteNode, (_event, id: string) =>
    remoteRegistry.remove(id)
  )
  ipcMain.handle(CHANNELS.runtime.remoteNodeStatuses, () => {
    // GUI 方向性授权和旧 node enroll 使用不同的持久化仓储，但对会话创建都是
    // FederatedRuntimeHost 的远程 host；在 IPC 边界统一，避免“配对成功却不可选”。
    return mergeRemoteNodeStatuses(remoteRegistry.statuses(), managedControllers.statuses())
  })
  ipcMain.handle(CHANNELS.runtime.nodeGatewayStatus, () => remoteRegistry.gatewayStatus())
  ipcMain.handle(CHANNELS.runtime.nodeReleaseReadiness, () => remoteRegistry.releaseReadiness())
  ipcMain.handle(CHANNELS.runtime.setNodeGatewayAdvertiseHost, async (_event, host: string) => {
    const result = await remoteRegistry.setAdvertiseHost(host)
    if (result.ok) {
      setNodeGatewayAdvertiseHost(host)
      if (managedPairing.snapshot().discoverable) {
        managedPairing.setDiscoverable(false)
        managedPairing.setDiscoverable(true)
      }
    }
    return result
  })
  ipcMain.handle(CHANNELS.runtime.setNodeGatewayEnabled, async (_event, enabled: boolean) => {
    if (!enabled && managedPairing.snapshot().discoverable) {
      managedPairing.setDiscoverable(false)
      setManagedDiscoveryEnabled(false)
    }
    const res = await remoteRegistry.setGatewayEnabled(enabled)
    if (res.ok) setNodeGatewayEnabled(enabled)
    return res
  })
  ipcMain.handle(CHANNELS.runtime.createNodeEnrollment, (_event, input: CreateEnrollmentInput) => {
    if (!input?.platform) throw new Error('请先选择目标节点平台')
    return remoteRegistry.createEnrollment(input.label, input.platform)
  })
  ipcMain.handle(CHANNELS.runtime.setRemoteNodeEnabled, (_event, id: string, enabled: boolean) =>
    remoteRegistry.setNodeEnabled(id, enabled)
  )
  ipcMain.handle(CHANNELS.runtime.setRemoteNodeLabel, (_event, id: string, label: string) =>
    remoteRegistry.setNodeLabel(id, label)
  )
  ipcMain.handle(
    CHANNELS.runtime.setNodeAgentEnabled,
    (_event, nodeId: string, agentId: string, enabled: boolean) =>
      remoteRegistry.setAgentEnabled(nodeId, agentId, enabled)
  )
  ipcMain.handle(
    CHANNELS.runtime.setNodeAgentAlias,
    (_event, nodeId: string, agentId: string, alias: string) =>
      remoteRegistry.setAgentAlias(nodeId, agentId, alias)
  )
  ipcMain.handle(CHANNELS.runtime.managedDeviceIdentity, () =>
    remoteRegistry.managedDeviceIdentity()
  )
  ipcMain.handle(CHANNELS.runtime.managedDeviceAuthorizations, () =>
    remoteRegistry.managedDeviceAuthorizations()
  )
  ipcMain.handle(
    CHANNELS.runtime.setManagedDeviceAuthorizationStatus,
    (_event, id: string, status: ManagedDeviceAuthorizationStatus) => {
      managedPairing.assertAuthorizationStatusChangeAllowed(id)
      return remoteRegistry.setManagedDeviceAuthorizationStatus(id, status)
    }
  )
  ipcMain.handle(CHANNELS.runtime.managedPairingSnapshot, () => managedPairing.snapshot())
  ipcMain.handle(CHANNELS.runtime.setManagedDiscoveryEnabled, async (_event, enabled: boolean) => {
    try {
      if (enabled) {
        const gateway = await remoteRegistry.setGatewayEnabled(true)
        if (!gateway.ok) return gateway
        setNodeGatewayEnabled(true)
      }
      managedPairing.setDiscoverable(enabled)
      setManagedDiscoveryEnabled(enabled)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(CHANNELS.runtime.requestManagedPairing, (_event, discoveryId: string) =>
    managedPairing.request(discoveryId)
  )
  ipcMain.handle(CHANNELS.runtime.requestManagedPairingManual, (_event, endpoint: string) =>
    managedPairing.requestManual(endpoint)
  )
  ipcMain.handle(CHANNELS.runtime.confirmManagedPairing, (_event, sessionId: string) =>
    managedPairing.confirm(sessionId)
  )
  ipcMain.handle(
    CHANNELS.runtime.approveManagedPairing,
    (_event, sessionId: string, input: ApproveManagedPairingInput) =>
      managedPairing.approve(sessionId, input)
  )
  ipcMain.handle(CHANNELS.runtime.rejectManagedPairing, (_event, sessionId: string) =>
    managedPairing.reject(sessionId)
  )
  ipcMain.handle(
    CHANNELS.runtime.setManagedConnectionEnabled,
    (_event, id: string, enabled: boolean) => managedPairing.setConnectionEnabled(id, enabled)
  )
  ipcMain.handle(CHANNELS.runtime.removeManagedConnection, (_event, id: string) =>
    managedPairing.removeConnection(id)
  )

  // --- session ---
  ipcMain.handle(CHANNELS.session.list, () => runtime.listSessions())
  ipcMain.handle(CHANNELS.session.listViews, () => runtime.listSessionViews())
  // 统一会话搜索：合并 CLI 历史 FTS（memory）与自建 agent 对话正文检索。
  ipcMain.handle(CHANNELS.session.search, async (_event, input: MemorySearchInput) => {
    const [cli, agent] = await Promise.all([
      memory.search(input),
      Promise.resolve().then(() => searchAgentChats(sessionSearch, input))
    ])
    return mergeSessionHits(cli, agent, input.limit)
  })
  ipcMain.handle(CHANNELS.session.create, (_event, input: CreateSessionInput) =>
    runtime.createSession(input)
  )
  ipcMain.handle(CHANNELS.session.resume, (_event, id: string) => runtime.resumeSession(id))
  ipcMain.handle(CHANNELS.session.openLinkedTerminal, (_event, id: string) =>
    runtime.openLinkedTerminal(id)
  )

  ipcMain.handle(CHANNELS.session.update, (_event, id: string, patch: UpdateSessionPatch) =>
    runtime.updateSession(id, patch)
  )
  ipcMain.handle(CHANNELS.session.remove, async (_event, id: string) => {
    await runtime.removeSession(id)
    // SPEC-038：session 删除同步清理暂存附件（in-process/daemon/remote 的单一 IPC 入口）。
    attachmentPreviews.revokeUnder(join(attachmentsRoot, id))
    deleteAttachments(attachmentsRoot, id)
  })

  // --- relay ---
  const relay = new RelayService({
    runtime,
    getTranscript: (sessionId) => memory.getTranscript(sessionId),
    openRepair: async () => undefined
  })
  ipcMain.handle(CHANNELS.relay.listTargets, (_event, sourceSessionId: string) =>
    relay.listTargets(sourceSessionId)
  )
  ipcMain.handle(CHANNELS.relay.start, (_event, payload) => relay.start(payload))
  ipcMain.handle(CHANNELS.relay.getContextReport, (_event, linkId: string) =>
    relay.getContextReport(linkId)
  )
  ipcMain.handle(CHANNELS.relay.getLink, (_event, sessionId: string) => relay.getLink(sessionId))
  ipcMain.handle(CHANNELS.relay.openRepair, (_event, toolId: string) => relay.openRepair(toolId))

  // --- terminal ---
  ipcMain.handle(CHANNELS.terminal.write, (_event, payload: { sessionId: string; data: string }) =>
    runtime.write(payload.sessionId, payload.data)
  )
  ipcMain.handle(
    CHANNELS.terminal.resize,
    (_event, payload: { sessionId: string; cols: number; rows: number }) =>
      runtime.resize(payload.sessionId, payload.cols, payload.rows)
  )
  ipcMain.handle(CHANNELS.terminal.history, (_event, sessionId: string) =>
    runtime.history(sessionId)
  )
  ipcMain.handle(CHANNELS.terminal.state, (_event, sessionId: string) => runtime.state(sessionId))
  ipcMain.handle(CHANNELS.terminal.states, () => runtime.states())
  ipcMain.handle(CHANNELS.terminal.close, (_event, sessionId: string) => runtime.kill(sessionId))

  // --- structured chat ---
  ipcMain.handle(CHANNELS.chat.history, (_event, sessionId: string) =>
    runtime.chatHistory(sessionId)
  )
  ipcMain.handle(CHANNELS.chat.timeline, (_event, sessionId: string) =>
    runtime.chatTimeline(sessionId)
  )
  ipcMain.handle(
    CHANNELS.chat.sendTurn,
    (_event, sessionId: string, text: string, files?: string[]) =>
      sendTurnWithSemanticAutomation(runtime, sessionId, text, files)
  )
  ipcMain.handle(
    CHANNELS.chat.steerTurn,
    (_event, sessionId: string, text: string, files?: string[]) =>
      runtime.steerTurn(sessionId, text, files)
  )
  ipcMain.handle(
    CHANNELS.chat.queueTurn,
    (_event, sessionId: string, text: string, files?: string[]) =>
      runtime.queueTurn(sessionId, text, files)
  )
  ipcMain.handle(CHANNELS.chat.listQueuedTurns, (_event, sessionId: string) =>
    runtime.listQueuedTurns(sessionId)
  )
  ipcMain.handle(
    CHANNELS.chat.cancelQueuedTurn,
    (_event, sessionId: string, queuedTurnId: string) =>
      runtime.cancelQueuedTurn(sessionId, queuedTurnId)
  )
  ipcMain.handle(CHANNELS.chat.interrupt, (_event, sessionId: string) =>
    runtime.interruptTurn(sessionId)
  )
  ipcMain.handle(
    CHANNELS.chat.respondPermission,
    (_event, sessionId: string, requestId: string, decision: PermissionDecision) =>
      runtime.respondPermission(sessionId, requestId, decision)
  )
  ipcMain.handle(CHANNELS.chat.state, (_event, sessionId: string) => runtime.chatState(sessionId))

  // --- scheduled tasks / kanban (SPEC-039) ---
  ipcMain.handle(CHANNELS.tasks.list, () => runtime.listTasks())
  ipcMain.handle(CHANNELS.tasks.listRuns, (_event, taskId: string) => runtime.listTaskRuns(taskId))
  ipcMain.handle(CHANNELS.tasks.create, (_event, input: CreateTaskInput) => {
    const { portableId: _portableId, ...userInput } = input
    return runtime.createTask(userInput)
  })
  ipcMain.handle(CHANNELS.tasks.update, (_event, id: string, patch: UpdateTaskPatch) =>
    runtime.updateTask(id, patch)
  )
  ipcMain.handle(CHANNELS.tasks.remove, (_event, id: string) => runtime.removeTask(id))
  ipcMain.handle(CHANNELS.tasks.runNow, (_event, id: string) => runtime.runTaskNow(id))

  // --- diagnostics ---
  ipcMain.handle(CHANNELS.diagnostics.dataPlaneHealth, async () => {
    const discovery = await scanAll()
    const versions = new Map(
      discovery.flatMap((item) => (item.version ? [[item.toolId, item.version] as const] : []))
    )
    return refreshDataPlaneHealth(versions)
  })

  // --- memory ---
  ipcMain.handle(CHANNELS.memory.search, (_event, input: MemorySearchInput) => memory.search(input))
  ipcMain.handle(CHANNELS.memory.searchInSession, (_event, input: MemoryInSessionSearchInput) =>
    memory.searchInSession(input)
  )
  ipcMain.handle(CHANNELS.memory.getTranscript, (_event, sessionId: string) =>
    memory.getTranscript(sessionId)
  )
  ipcMain.handle(CHANNELS.memory.getTranscriptMeta, (_event, sessionId: string) =>
    memory.getTranscriptMeta(sessionId)
  )
  ipcMain.handle(CHANNELS.memory.getTranscriptPage, (_event, input) =>
    memory.getTranscriptPage(input)
  )
  ipcMain.handle(CHANNELS.memory.indexStatus, () => memory.indexStatus())
  ipcMain.handle(CHANNELS.memory.listDurable, (_event, input?: ListDurableMemoriesInput) =>
    vault.list(input)
  )
  ipcMain.handle(CHANNELS.memory.getDurable, (_event, id: string) => vault.get(id))
  // 手动新建：直接落 active（confidence=confirmed），evidence 标记为 manual 以便来源归类为「手动」。
  ipcMain.handle(CHANNELS.memory.createManual, (_event, input: ProposeMemoryInput) =>
    vault.addActive({ ...input, evidence: [{ sourceType: 'manual', sourceId: 'manual' }] })
  )
  ipcMain.handle(CHANNELS.memory.propose, (_event, input: ProposeMemoryInput) =>
    vault.propose(input)
  )
  ipcMain.handle(CHANNELS.memory.confirm, (_event, id: string, patch?: UpdateDurableMemoryPatch) =>
    vault.confirm(id, patch)
  )
  ipcMain.handle(CHANNELS.memory.reject, (_event, id: string, reason?: string) =>
    vault.reject(id, reason)
  )
  ipcMain.handle(
    CHANNELS.memory.updateDurable,
    (_event, id: string, patch: UpdateDurableMemoryPatch) => vault.update(id, patch)
  )
  ipcMain.handle(CHANNELS.memory.forget, (_event, id: string) => vault.forget(id))
  ipcMain.handle(CHANNELS.memory.feedback, (_event, input: MemoryFeedbackInput) =>
    vault.feedback(input)
  )
  ipcMain.handle(CHANNELS.memory.context, (_event, input: MemoryContextInput) =>
    vault.context(input)
  )
  ipcMain.handle(CHANNELS.memory.settings, () => vault.getSettings())
  ipcMain.handle(CHANNELS.memory.updateSettings, (_event, patch: Partial<MemorySettings>) =>
    vault.updateSettings(patch)
  )
  ipcMain.handle(CHANNELS.memory.getPersona, () => vault.getPersona())
  ipcMain.handle(CHANNELS.memory.updatePersona, (_event, text: string) => vault.setPersona(text))
  ipcMain.handle(CHANNELS.memory.curatorCandidates, async (): Promise<CuratorCandidate[]> => {
    const adapters = listAdapters().filter((a) => a.headlessJson?.supportsIsolatedCuration)
    const discovery = await scanAll()
    const byTool = new Map(discovery.map((d) => [d.toolId, d]))
    return adapters.map((a) => {
      const found = byTool.get(a.id)
      return {
        toolId: a.id,
        displayName: a.displayName,
        ready: found?.health === 'ready' || found?.health === 'updatable',
        version: found?.version,
        installHint: a.installHint || undefined
      }
    })
  })
  ipcMain.handle(CHANNELS.memory.gatewayCapabilities, () => vault.gatewayCapabilities())
  ipcMain.handle(CHANNELS.memory.curate, (_event, input: CurateMemoryInput) =>
    curation.curate(input)
  )

  // --- stats ---
  ipcMain.handle(CHANNELS.stats.summary, (_event, input: StatsQuery) => memory.statsSummary(input))
  ipcMain.handle(CHANNELS.stats.activity, (_event, input: StatsQuery) =>
    memory.statsActivity(input)
  )
  ipcMain.handle(CHANNELS.stats.dashboard, (_event, input: StatsQuery) =>
    memory.statsDashboard(input)
  )
  ipcMain.handle(CHANNELS.stats.models, (_event, input: StatsQuery) => memory.statsModels(input))
  ipcMain.handle(CHANNELS.stats.exportCsv, async (event, input: StatsExportCsvInput) => {
    const artifact = await buildStatsCsvArtifact(input, memory)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(owner ?? undefined!, {
      title: tr('stats.export.dialogTitle'),
      defaultPath: artifact.defaultFileName,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return { cancelled: true }
    await writeFile(result.filePath, artifact.content, { encoding: 'utf8', mode: 0o600 })
    return { cancelled: false, path: result.filePath }
  })
  ipcMain.handle(CHANNELS.stats.projects, () => memory.statsProjects())
  ipcMain.handle(CHANNELS.stats.growth, () => memory.statsGrowth(experiences.list().length))
  ipcMain.handle(CHANNELS.stats.getGamificationEnabled, () => getGamificationEnabled())
  ipcMain.handle(CHANNELS.stats.setGamificationEnabled, (_event, value: boolean) => {
    setGamificationEnabled(value)
  })
  ipcMain.handle(CHANNELS.stats.getCardexState, () => getCardexState())
  ipcMain.handle(CHANNELS.stats.setCardexState, (_event, state: CardexState) => {
    setCardexState(state)
  })

  // --- experience ---
  ipcMain.handle(CHANNELS.experience.list, (_event, query?: string) => experiences.list(query))
  ipcMain.handle(CHANNELS.experience.create, (_event, input: CreateExperienceInput) =>
    experiences.create(input)
  )
  ipcMain.handle(CHANNELS.experience.update, (_event, id: string, patch: UpdateExperiencePatch) =>
    experiences.update(id, patch)
  )
  ipcMain.handle(CHANNELS.experience.remove, (_event, id: string) => {
    experiences.remove(id)
  })

  // --- compare（SPEC-009）---
  ipcMain.handle(CHANNELS.compare.start, (_event, input: Parameters<CompareService['start']>[0]) =>
    compare.start(input)
  )
  ipcMain.handle(CHANNELS.compare.adopt, (_event, runId: string, toolId: string) =>
    compare.adopt(runId, toolId)
  )
  ipcMain.handle(CHANNELS.compare.discard, (_event, runId: string) => compare.discard(runId))
  ipcMain.handle(CHANNELS.compare.list, () => compare.list())
  ipcMain.handle(CHANNELS.compare.listScenarios, () => compare.listScenarios())
  ipcMain.handle(CHANNELS.compare.getScenario, (_event, id: string) => compare.getScenario(id))
  ipcMain.handle(
    CHANNELS.compare.saveScenario,
    (_event, input: Parameters<CompareService['saveScenario']>[0]) => compare.saveScenario(input)
  )
  ipcMain.handle(CHANNELS.compare.deleteScenario, (_event, id: string) =>
    compare.deleteScenario(id)
  )

  // --- webagg（SPEC-011）---
  ipcMain.handle(CHANNELS.webagg.listProviders, () => webagg.listProviders())
  ipcMain.handle(CHANNELS.webagg.setActive, (_event, providerIds: string[]) =>
    webagg.setActive(providerIds)
  )
  ipcMain.handle(CHANNELS.webagg.broadcast, (_event, text: string) => webagg.broadcast(text))
  ipcMain.handle(CHANNELS.webagg.reload, (_event, providerId: string) => webagg.reload(providerId))
  ipcMain.handle(CHANNELS.webagg.getSiteState, (_event, id: string) => webagg.getSiteState(id))
  ipcMain.handle(CHANNELS.webagg.updateBounds, (_event, bounds: Record<string, ViewBounds>) =>
    webagg.updateBounds(bounds)
  )
  // --- Web 镜头：书签 + 任意 URL 站点视图 ---
  ipcMain.handle(CHANNELS.webagg.listBookmarks, () => webagg.listBookmarks())
  ipcMain.handle(
    CHANNELS.webagg.addBookmark,
    (_event, input: { name: string; url: string; color?: string }) => webagg.addBookmark(input)
  )
  ipcMain.handle(
    CHANNELS.webagg.updateBookmark,
    (_event, id: string, input: { name?: string; url?: string; color?: string }) =>
      webagg.updateBookmark(id, input)
  )
  ipcMain.handle(CHANNELS.webagg.removeBookmark, (_event, id: string) => webagg.removeBookmark(id))
  ipcMain.handle(CHANNELS.webagg.openSite, (_event, input: { id: string; url: string }) =>
    webagg.openSite(input.id, input.url)
  )
  ipcMain.handle(
    CHANNELS.webagg.siteAction,
    (_event, input: { id: string; action: 'back' | 'forward' | 'reload' }) =>
      webagg.siteAction(input.id, input.action)
  )
  ipcMain.handle(CHANNELS.webagg.updateSiteBounds, (_event, bounds: Record<string, ViewBounds>) =>
    webagg.updateSiteBounds(bounds)
  )
  ipcMain.handle(CHANNELS.webagg.closeSite, (_event, id: string) => webagg.closeSite(id))
  ipcMain.handle(CHANNELS.webagg.injectSite, (_event, input: { id: string; text: string }) =>
    webagg.injectSite(input.id, input.text)
  )

  // --- annotations（SPEC-025：收藏 + 标签）---
  ipcMain.handle(CHANNELS.annotations.getMany, (_event, refs: AnnotationTargetRef[]) =>
    annotations.getMany(refs)
  )
  ipcMain.handle(CHANNELS.annotations.setFavorite, (_event, input: AnnotationSetFavoriteInput) =>
    annotations.setFavorite(input.ref, input.favorite, input.meta)
  )
  ipcMain.handle(CHANNELS.annotations.setTags, (_event, input: AnnotationSetTagsInput) =>
    annotations.setTags(input.ref, input.tags, input.meta)
  )
  ipcMain.handle(CHANNELS.annotations.addTag, (_event, input: AnnotationTagInput) =>
    annotations.addTag(input.ref, input.tag, input.meta)
  )
  ipcMain.handle(CHANNELS.annotations.removeTag, (_event, input: AnnotationTagInput) =>
    annotations.removeTag(input.ref, input.tag, input.meta)
  )
  ipcMain.handle(CHANNELS.annotations.listTags, () => annotations.listTags())
  ipcMain.handle(CHANNELS.annotations.listAnnotated, (_event, filter?: AnnotationListFilter) =>
    annotations.listAnnotated(filter)
  )

  // --- channels（SPEC-034 消息网关）---
  ipcMain.handle(CHANNELS.channels.listAccounts, () => channelManager.listAccounts())
  ipcMain.handle(CHANNELS.channels.addAccount, (_event, input: AddChannelAccountInput) =>
    channelManager.addAccount(input)
  )
  ipcMain.handle(CHANNELS.channels.removeAccount, (_event, id: string) =>
    channelManager.removeAccount(id)
  )
  ipcMain.handle(CHANNELS.channels.setAccountEnabled, (_event, id: string, enabled: boolean) =>
    channelManager.setAccountEnabled(id, enabled)
  )
  ipcMain.handle(CHANNELS.channels.testConnection, (_event, id: string) =>
    channelManager.testConnection(id)
  )
  ipcMain.handle(CHANNELS.channels.listBindings, () => channelManager.listBindings())
  ipcMain.handle(CHANNELS.channels.setBinding, (_event, binding: ChannelBinding) =>
    channelManager.setBinding(binding)
  )
  ipcMain.handle(
    CHANNELS.channels.removeBinding,
    (_event, platform: string, accountId: string, chatId: string) =>
      channelManager.removeBinding(platform, accountId, chatId)
  )
  ipcMain.handle(CHANNELS.channels.getAcl, (_event, accountId: string) =>
    channelManager.getAcl(accountId)
  )
  ipcMain.handle(CHANNELS.channels.setAcl, (_event, accountId: string, acl: ChannelAcl) =>
    channelManager.setAcl(accountId, acl)
  )
  ipcMain.handle(CHANNELS.channels.listPairingRequests, (_event, accountId: string) =>
    channelManager.listPairingRequests(accountId)
  )
  ipcMain.handle(CHANNELS.channels.approvePairingRequest, (_event, requestId: string) =>
    channelManager.approvePairingRequest(requestId)
  )
  ipcMain.handle(CHANNELS.channels.rejectPairingRequest, (_event, requestId: string) =>
    channelManager.rejectPairingRequest(requestId)
  )
  ipcMain.handle(CHANNELS.channels.setGatewayEnabled, (_event, enabled: boolean) =>
    channelManager.setGatewayEnabled(enabled)
  )
  // SPEC-034 扫码接入飞书 registerApp / 微信 iLink。
  ipcMain.handle(
    CHANNELS.channels.startFeishuScan,
    (_event, platform: 'feishu' | 'wechat' = 'feishu') => channelManager.startChannelScan(platform)
  )
  ipcMain.handle(CHANNELS.channels.submitScanVerificationCode, (_event, code: string) =>
    channelManager.submitScanVerificationCode(code)
  )
  ipcMain.handle(CHANNELS.channels.cancelFeishuScan, () => channelManager.cancelChannelScan())
}
