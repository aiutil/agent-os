// Electron 主进程入口（SPEC-000/001）。
// 创建窗口、注册 IPC、桥接终端事件到渲染端。

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, Menu, net, protocol, shell } from 'electron'
import { EVENTS } from '@shared/ipc-contract'
import { TerminalManager } from './domains/terminal/manager'
import { registerIpc } from './ipc/registerIpc'
import { createMemoryService } from './domains/memory/service'
import { createExperienceStore } from './domains/memory/experience-persistence'
import { MemoryVault } from './domains/memory/vault'
import { VaultExperienceStore } from './domains/memory/vault-experience-store'
import { memoryVaultPath } from './domains/memory/paths'
import { MemoryCurationService } from './domains/memory/curation'
import { MemoryCurationScheduler } from './domains/memory/curation-scheduler'
import { MemoryBackgroundCurator } from './domains/memory/background-curator'
import type { MemoryWorkerClient } from './domains/memory/worker-client'
import { createInProcessRuntimeHost } from './domains/runtime/create-in-process-runtime-host'
import type { ChannelAccount, HostEvent, RemoteNodeStatus } from '@shared/types'
import { LifecycleService } from './domains/lifecycle/service'
import { scanAll } from './domains/discovery/discovery'
import { augmentProcessPathWithNode } from './domains/discovery/fix-path'
import { FileSessionRepository } from './domains/sessions/file-repository'
import { ChatSqliteStore } from './domains/sessions/chat-sqlite-store'
import { AnnotationsStore } from './domains/annotations/store'
import {
  getAppStorePath,
  getAnalyticsInstallId,
  getAnalyticsEnabled,
  getChannelAccounts,
  resetAnalyticsInstallId,
  setAnalyticsEnabled,
  getSessions,
  getRemoteNodes,
  setRemoteNodes,
  getNodeGatewayEnabled,
  getNodeGatewayAdvertiseHost,
  getManagedDeviceIdentity,
  setManagedDeviceIdentity,
  getManagedDeviceAuthorizations,
  setManagedDeviceAuthorizations,
  getManagedSessionOwnerships,
  setManagedSessionOwnerships,
  getManagedDeviceConnections,
  setManagedDeviceConnections,
  getManagedDiscoveryEnabled,
  setManagedDiscoveryEnabled,
  setNodeGatewayEnabled
} from './store/app-store'
import { SupervisedRuntimeHost } from './domains/runtime/supervised-runtime-host'
import { runtimeBuildIdFor } from './domains/runtime/daemon-config'
import { ChatManager } from './domains/chat/manager'
import { getAdapter, listAdapters } from './domains/adapters/registry'
import { pruneOrphanedAttachments } from './domains/attachments/store'
import { backfillManagedNativeSessions } from './domains/sessions/native-session-binding'
import type { InProcessRuntimeHost } from './domains/runtime/in-process-runtime-host'
import { CompareService } from './domains/compare/service'
import { WebAggService } from './domains/webagg/service'
import { UpdateService } from './domains/update/service'
import { FederatedRuntimeHost } from './domains/runtime/federated-runtime-host'
import { RemoteNodeRegistry, type GatewayMaterial } from './domains/runtime/remote-registry'
import { DeviceAuthorizationRegistry } from './domains/runtime/device-authorization'
import { ManagedSessionOwnershipRegistry } from './domains/runtime/authorized-runtime-host'
import { ManagedDeviceControllerRegistry } from './domains/runtime/managed-device-controller-registry'
import { ManagedDevicePairingService } from './domains/runtime/managed-device-pairing'
import { generateNodeTls, certFingerprint } from './domains/runtime/node-tls'
import { ChannelManager } from './domains/channels/manager'
import { FeishuTransport } from './domains/channels/feishu-transport'
import { TelegramTransport } from './domains/channels/telegram-transport'
import { WeComTransport } from './domains/channels/wecom-transport'
import { WhatsAppTransport } from './domains/channels/whatsapp-transport'
import { WeChatTransport } from './domains/channels/wechat-transport'
import { MultiplexChannelTransport } from './domains/channels/multiplex-transport'
import { ChannelInboundInbox } from './domains/channels/inbound-inbox'
import { TaskRepository } from './domains/tasks/repository'
import { TaskService } from './domains/tasks/service'
import { createGracefulBeforeQuitHandler } from './graceful-shutdown'
import { enforceSecureTlsEnvironment } from './secure-tls-environment'
import { installCrashReporting } from './crash-reporting'
import { extractPackagedCliArgs, runRealAgentOsCli } from './cli'
import { AnalyticsEventBus } from './domains/analytics/event-bus'
import { AgentTurnAnalyticsObserver } from './domains/analytics/agent-turn-observer'
import { buildAnalyticsConfig } from './domains/analytics/config'
import {
  remoteConnectedAnalyticsEvent,
  sessionCreatedAnalyticsEvent,
  taskCreatedAnalyticsEvent,
  taskRunCompletedAnalyticsEvent,
  analyticsCountBucket
} from './domains/analytics/events'
import {
  consumePendingCrashSignal,
  recordVersionUpgrade,
  writePendingCrashSignal
} from './domains/analytics/lifecycle-signals'
import {
  PACKAGED_RENDERER_SCHEME,
  PACKAGED_RENDERER_URL,
  resolveRendererAssetPath
} from './renderer-asset-path'

protocol.registerSchemesAsPrivileged([
  {
    scheme: PACKAGED_RENDERER_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

const packagedCliArgs = extractPackagedCliArgs(process.argv)

if (enforceSecureTlsEnvironment()) {
  console.warn(
    '[security] 已移除 NODE_TLS_REJECT_UNAUTHORIZED=0；TLS 证书校验保持启用。企业 CA 请使用 NODE_EXTRA_CA_CERTS。'
  )
}

// GUI 启动补齐 node 所在目录到 PATH：打包 .app 启动时 process.env.PATH 不含
// nvm/homebrew 等 node 目录，会导致 #!/usr/bin/env node 的 CLI（pi/codex/qwen）
// shebang 解析失败。必须在任何 spawn（终端/chat/发现）之前执行。
augmentProcessPathWithNode()

let mainWindow: BrowserWindow | null = null
let memoryService: MemoryWorkerClient | null = null
let fallbackChat: ChatManager | null = null
let channelManager: ChannelManager | null = null
let memoryVault: MemoryVault | null = null
let memoryCurationScheduler: MemoryCurationScheduler | null = null
let memoryBackgroundCurator: MemoryBackgroundCurator | null = null
let fallbackTasks: TaskService | null = null
let remoteRegistryRef: RemoteNodeRegistry | null = null
let managedControllerRegistryRef: ManagedDeviceControllerRegistry | null = null
let managedPairingRef: ManagedDevicePairingService | null = null
let agentTurnAnalyticsObserver: AgentTurnAnalyticsObserver | null = null
const uninstallCrashReporting =
  packagedCliArgs === null
    ? installCrashReporting(
        () => mainWindow,
        (signal) => {
          if (!getAnalyticsEnabled()) return
          writePendingCrashSignal(
            join(app.getPath('userData'), 'analytics', 'pending-crash.json'),
            signal
          )
        }
      )
    : () => undefined
/** 已安装且具备结构化 headless 通道的 CLI（自动挑选 curator 用），由发现扫描刷新。 */
const installedCuratorIds = new Set<string>()

const terminalManager = new TerminalManager(() => undefined)

/** SPEC-032：加载/生成主控网关自签证书（指纹稳定，供节点 pin）。 */
function loadGatewayMaterial(prefix: string): GatewayMaterial {
  const certPath = `${prefix}-cert.pem`
  const keyPath = `${prefix}-key.pem`
  let cert: string
  let key: string
  if (existsSync(certPath) && existsSync(keyPath)) {
    cert = readFileSync(certPath, 'utf8')
    key = readFileSync(keyPath, 'utf8')
  } else {
    const material = generateNodeTls('agent-os-gateway')
    cert = material.cert
    key = material.key
    writeFileSync(certPath, cert, { mode: 0o600 })
    writeFileSync(keyPath, key, { mode: 0o600 })
  }
  return {
    cert,
    key,
    fingerprint: certFingerprint(cert),
    version: app.getVersion(),
    sourceRevision: __AGENT_OS_SOURCE_REVISION__,
    repo: 'aiutil/agent-os',
    advertiseHost: getNodeGatewayAdvertiseHost() || undefined
  }
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

const completedTaskRunAnalyticsIds = new Set<string>()
function forwardRuntimeEvent(event: HostEvent): void {
  agentTurnAnalyticsObserver?.observe(event)
  if (event.kind === 'pty-data') {
    sendToMainWindow(EVENTS.terminalData, {
      sessionId: event.sessionId,
      data: event.bytes
    })
  } else if (event.kind === 'state') {
    sendToMainWindow(EVENTS.terminalStateChanged, {
      sessionId: event.sessionId,
      state: event.state,
      prevStatus: event.prevStatus
    })
  } else if (event.kind === 'exit') {
    sendToMainWindow(EVENTS.terminalExit, {
      sessionId: event.sessionId,
      exitCode: event.code
    })
  } else if (event.kind === 'agent-event') {
    // SPEC-034：渠道会话的回合可能跑在 daemon/远程节点上，其 AgentEvent 经 federation
    // 走到这里（不再经过进程内 ChatManager 的 emit 回调）。与该回调同样的分流：渠道会话
    // 回灌渠道、不推渲染端。hasActiveTurn 在渠道发 turn 前即置位、turn-end 时清除，覆盖整段回合。
    if (channelManager?.hasActiveTurn(event.sessionId)) {
      channelManager.handleAgentEvent(event.sessionId, event.event, event.turnId)
      return
    }
    sendToMainWindow(EVENTS.agentEvent, {
      sessionId: event.sessionId,
      event: event.event,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      ...(event.timelineItem ? { timelineItem: event.timelineItem } : {})
    })
  } else if (event.kind === 'task-changed') {
    const completed = taskRunCompletedAnalyticsEvent(event.event)
    const runId = event.event.run?.id
    if (completed && runId && !completedTaskRunAnalyticsIds.has(runId)) {
      completedTaskRunAnalyticsIds.add(runId)
      if (completedTaskRunAnalyticsIds.size > 500) {
        const oldest = completedTaskRunAnalyticsIds.values().next().value
        if (oldest) completedTaskRunAnalyticsIds.delete(oldest)
      }
      analyticsEventBus.publish(completed)
    }
    sendToMainWindow(EVENTS.taskChanged, event.event)
  }
}

const analyticsEventBus = new AnalyticsEventBus(
  (event) => sendToMainWindow(EVENTS.analyticsEvent, event),
  200,
  getAnalyticsEnabled()
)

const remoteAnalyticsStates = new Map<string, RemoteNodeStatus['connection']>()
function emitRemoteNodeState(
  status: RemoteNodeStatus,
  connectionMethod: 'legacy' | 'managed_pairing'
): void {
  sendToMainWindow(EVENTS.remoteNodeStateChanged, status)
  const key = `${connectionMethod}:${status.id}`
  const previous = remoteAnalyticsStates.get(key)
  remoteAnalyticsStates.set(key, status.connection)
  if (status.connection === 'connected' && previous !== 'connected') {
    analyticsEventBus.publish(remoteConnectedAnalyticsEvent(status, connectionMethod))
  }
}

const onlineChannelAccounts = new Set<string>()
function channelConnectionMethod(
  platform: ChannelAccount['platform']
): 'websocket' | 'polling' | 'qr' | 'webhook' {
  if (platform === 'feishu') return 'websocket'
  if (platform === 'telegram') return 'polling'
  if (platform === 'wechat' || platform === 'whatsapp') return 'qr'
  return 'webhook'
}

function emitChannelAccountState(account: ChannelAccount): void {
  sendToMainWindow(EVENTS.channelAccountStateChanged, account)
  if (account.status !== 'online') {
    onlineChannelAccounts.delete(account.id)
    return
  }
  if (onlineChannelAccounts.has(account.id)) return
  onlineChannelAccounts.add(account.id)
  const onlineCount = getChannelAccounts().filter(
    (candidate) => candidate.platform === account.platform && candidate.status === 'online'
  ).length
  analyticsEventBus.publish({
    name: 'message_channel_connected',
    properties: {
      channel_platform: account.platform,
      connection_method: channelConnectionMethod(account.platform),
      account_count_bucket: analyticsCountBucket(onlineCount)
    }
  })
}

function currentAnalyticsConfig(): ReturnType<typeof buildAnalyticsConfig> {
  return buildAnalyticsConfig({
    isPackaged: app.isPackaged,
    trackingEnabled: getAnalyticsEnabled(),
    productionToken: __MIXPANEL_PRODUCTION_TOKEN__,
    developmentToken: __MIXPANEL_DEVELOPMENT_TOKEN__,
    installId: getAnalyticsInstallId(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#e7e7e9',
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.on('did-start-loading', () => analyticsEventBus.pause())

  // 外链用系统浏览器打开，不在应用内导航。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // electron-vite 注入的 dev server 地址；生产加载打包后的 index.html。
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    void mainWindow.loadURL(PACKAGED_RENDERER_URL)
  }
}

const hasSingleInstanceLock = packagedCliArgs !== null || app.requestSingleInstanceLock()
if (packagedCliArgs === null && !hasSingleInstanceLock) {
  app.quit()
} else if (packagedCliArgs === null) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
  })
}

async function startDesktopApp(): Promise<void> {
  if (!hasSingleInstanceLock) return
  if (!process.env['ELECTRON_RENDERER_URL']) {
    const rendererRoot = join(__dirname, '../renderer')
    await protocol.handle(PACKAGED_RENDERER_SCHEME, (request) => {
      const assetPath = resolveRendererAssetPath(rendererRoot, request.url)
      if (!assetPath) return new Response('Not found', { status: 404 })
      return net.fetch(pathToFileURL(assetPath).toString())
    })
  }
  // Windows/Linux 默认会在标题栏下方渲染一条系统菜单栏，清空以去除该条目；
  // macOS 保留默认系统菜单栏（File/Edit/View/Window/Help 及 Cmd+Q 等）。
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  const pendingCrash = consumePendingCrashSignal(
    join(app.getPath('userData'), 'analytics', 'pending-crash.json')
  )
  if (pendingCrash && getAnalyticsEnabled()) {
    analyticsEventBus.publish({
      name: 'app_crashed',
      properties: {
        crash_kind: pendingCrash.crashKind,
        process_type: pendingCrash.processType,
        app_version: pendingCrash.appVersion
      }
    })
  }
  if (app.isPackaged) {
    const upgrade = recordVersionUpgrade(
      join(app.getPath('userData'), 'analytics', 'last-version.json'),
      app.getVersion()
    )
    if (upgrade && getAnalyticsEnabled()) {
      analyticsEventBus.publish({
        name: 'update_installed',
        properties: {
          from_version: upgrade.fromVersion,
          to_version: upgrade.toVersion,
          platform: process.platform
        }
      })
    }
  }
  const memory = createMemoryService(
    join(app.getPath('userData'), 'search-index.sqlite'),
    (status) => sendToMainWindow(EVENTS.memoryIndexProgress, status)
  )
  memoryService = memory
  const legacyExperiences = createExperienceStore(app.getPath('userData'))
  memoryVault = new MemoryVault(memoryVaultPath())
  memoryVault.migrateExperiences(legacyExperiences.list())
  const experiences = new VaultExperienceStore(memoryVault)
  const refreshInstalledCurators = (results: { toolId: string; health: string }[]): void => {
    installedCuratorIds.clear()
    for (const result of results) {
      if (result.health === 'ready' || result.health === 'updatable') {
        const adapter = getAdapter(result.toolId)
        if (adapter?.headlessJson) installedCuratorIds.add(adapter.id)
      }
    }
  }
  const lifecycle = new LifecycleService({
    onJobProgress: (job) => sendToMainWindow(EVENTS.toolJobProgress, job),
    onDiscoveryRefresh: async () => {
      const results = await scanAll()
      refreshInstalledCurators(results)
      sendToMainWindow(EVENTS.discoveryRefresh, results)
    }
  })
  // 首启异步刷新一次已安装 CLI，供自动挑选 curator（不阻塞窗口创建）。
  void scanAll()
    .then(refreshInstalledCurators)
    .catch(() => undefined)
  const memoryCuration = new MemoryCurationService(
    memoryVault,
    getAdapter,
    (toolId) => lifecycle.providerEnvironment(toolId),
    (toolId) => lifecycle.providerModel(toolId),
    () => listAdapters().filter((adapter) => installedCuratorIds.has(adapter.id))
  )
  memoryCurationScheduler = new MemoryCurationScheduler(memoryCuration)
  memoryBackgroundCurator = new MemoryBackgroundCurator(memory, memoryCuration, memoryVault)
  memoryBackgroundCurator.start()
  const sessionsFile = join(app.getPath('userData'), 'runtime-sessions.json')
  const tasksFile = join(app.getPath('userData'), 'tasks.json')
  const chatStoreFile = join(app.getPath('userData'), 'chat-store.sqlite')
  const sessions = new FileSessionRepository(
    sessionsFile,
    existsSync(sessionsFile) ? [] : getSessions()
  )
  agentTurnAnalyticsObserver = new AgentTurnAnalyticsObserver({
    getSession: (sessionId) => sessions.getSession(sessionId),
    publish: (event) => analyticsEventBus.publish(event)
  })
  const chatStore = new ChatSqliteStore(chatStoreFile)
  const annotationsFile = join(app.getPath('userData'), 'annotations.sqlite')
  const annotationsStore = new AnnotationsStore(annotationsFile)
  annotationsStoreRef = annotationsStore
  sessions.markInterruptedChatMessages()
  chatStore.markInterruptedMessages()
  // SPEC-024：存量原生会话回填是 best-effort 迁移。重度用户可能有上千份 transcript，
  // 不得让完整元数据扫描挡住窗口与 IPC 初始化；daemon 仍会在自己的仓库启动时完成回填。
  void backfillManagedNativeSessions({
    sessions: sessions.listSessions(),
    getAdapter,
    bindNativeSession: (id, nativeSessionId) => sessions.bindNativeSession(id, nativeSessionId)
  }).catch((error) => console.warn('[session-backfill] 存量原生会话回填失败：', error))
  // SPEC-038：清理崩溃残留的孤儿附件目录（sessionId 已不在仓库里的）。
  pruneOrphanedAttachments(
    join(app.getPath('userData'), 'attachments'),
    new Set(sessions.listSessions().map((session) => session.id))
  )
  let fallback: InProcessRuntimeHost | null = null
  fallbackChat = await ChatManager.create({
    approvalToken: randomBytes(32).toString('hex'),
    getSession: (id) => sessions.getSession(id),
    bindNativeSession: (id, nativeSessionId) => sessions.bindNativeSession(id, nativeSessionId),
    listChatHistory: (id) => {
      const messages = chatStore.listMessages(id)
      return messages.length > 0 ? messages : sessions.listChatHistory(id)
    },
    appendChatMessage: (id, message) => chatStore.appendMessage(id, message),
    updateChatMessage: (id, messageId, patch) => chatStore.updateMessage(id, messageId, patch),
    listTimeline: (id) => chatStore.listTimeline(id),
    appendTimelineItem: (item) => chatStore.appendTimelineItem(item),
    listQueuedTurns: (id) => chatStore.listQueuedTurns(id),
    enqueueTurn: (id, input) => chatStore.enqueueTurn(id, input),
    cancelQueuedTurn: (id, queuedTurnId) => chatStore.cancelQueuedTurn(id, queuedTurnId),
    updatePermissionStatus: (sessionId, turnId, toolUseId, status) =>
      chatStore.updatePermissionStatus(sessionId, turnId, toolUseId, status),
    nextTimelineSeq: (sessionId) => chatStore.nextSeq(sessionId),
    getAdapter,
    getProviderEnv: (toolId) => lifecycle.providerEnvironment(toolId),
    getProviderModel: (toolId) => lifecycle.providerModel(toolId),
    memoryContext: (session, prompt) => {
      const pack = memoryVault?.context({
        cwd: session.workspacePath,
        task: prompt,
        agentId: session.toolId
      })
      return {
        text: pack?.text ?? '',
        referencedMemories: (pack?.items ?? []).map((item) => ({
          id: item.memory.id,
          title: item.memory.title,
          kind: item.memory.kind,
          scope: item.memory.scope
        }))
      }
    },
    onStableConversation: (session, messages) =>
      memoryCurationScheduler?.schedule(session, messages),
    emit: (sessionId, event, timelineItem, turnId) => {
      // SPEC-034：渠道驱动的会话，事件回灌渠道（不推渲染端；桌面经深链打开时按需读历史）。
      if (channelManager) {
        const session = sessions.getSession(sessionId)
        // source='channel'（新会话）或当前正有渠道回合在进行（兼容 source 字段缺失的旧会话）。
        if (session?.source === 'channel' || channelManager.hasActiveTurn(sessionId)) {
          channelManager.handleAgentEvent(sessionId, event, turnId)
          return
        }
      }
      fallback?.emitAgentEvent(sessionId, event, timelineItem, turnId)
    }
  })
  const daemonEntry = join(__dirname, 'daemon.js')
  const runtimeBuildId = runtimeBuildIdFor(daemonEntry, `in-process:${app.getVersion()}`)
  fallbackTasks = new TaskService({
    repository: new TaskRepository(tasksFile),
    runtime: () => {
      if (!fallback) throw new Error('进程内 Runtime Host 尚未就绪')
      return fallback
    },
    emit: (event) => fallback?.emitTaskChanged(event)
  })
  fallback = createInProcessRuntimeHost(
    terminalManager,
    app.getVersion(),
    sessions,
    fallbackChat,
    {
      environment: (toolId) => lifecycle.providerEnvironment(toolId),
      model: (toolId) => lifecycle.providerModel(toolId)
    },
    runtimeBuildId,
    fallbackTasks
  )
  const runtime = await SupervisedRuntimeHost.create({
    daemonEntry,
    daemonConfigFile: join(app.getPath('userData'), 'daemon.json'),
    sessionsFile,
    tasksFile,
    chatStoreFile,
    providerStoreFile: getAppStorePath(),
    hostVersion: app.getVersion(),
    runtimeBuildId,
    fallback,
    fallbackTasks
  })
  // 联邦：本机（runtime）+ 局域网远程节点，统一成一个 RuntimeHost 给上层。
  const federation = new FederatedRuntimeHost(runtime, 'local', {
    sessionCreated: (input) => analyticsEventBus.publish(sessionCreatedAnalyticsEvent(input)),
    taskCreated: (input, task) => analyticsEventBus.publish(taskCreatedAnalyticsEvent(input, task))
  })
  const gatewayMaterial = loadGatewayMaterial(join(app.getPath('userData'), 'node-gateway-tls'))
  const deviceAuthorizations = new DeviceAuthorizationRegistry(
    {
      getIdentity: getManagedDeviceIdentity,
      setIdentity: setManagedDeviceIdentity,
      getAuthorizations: getManagedDeviceAuthorizations,
      setAuthorizations: setManagedDeviceAuthorizations
    },
    { displayName: hostname() }
  )
  // 首次启动即建立稳定设备身份；后续附近发现、配对和 GUI 内置受托管 Runtime 共用。
  const deviceIdentity = deviceAuthorizations.identity()
  const managedOwnerships = new ManagedSessionOwnershipRegistry({
    get: getManagedSessionOwnerships,
    set: setManagedSessionOwnerships
  })
  const discoveryEnabled = getManagedDiscoveryEnabled()
  const remoteRegistry = new RemoteNodeRegistry(
    federation,
    { get: getRemoteNodes, set: setRemoteNodes },
    (status) => emitRemoteNodeState(status, 'legacy'),
    gatewayMaterial,
    getNodeGatewayEnabled() || discoveryEnabled,
    deviceAuthorizations,
    managedOwnerships,
    runtime
  )
  await remoteRegistry.init()
  remoteRegistryRef = remoteRegistry
  const managedControllerRegistry = new ManagedDeviceControllerRegistry(
    federation,
    { get: getManagedDeviceConnections, set: setManagedDeviceConnections },
    deviceIdentity.deviceId,
    undefined,
    (status) => emitRemoteNodeState(status, 'managed_pairing')
  )
  managedControllerRegistryRef = managedControllerRegistry
  managedControllerRegistry.init()
  managedPairingRef = new ManagedDevicePairingService({
    authorizations: deviceAuthorizations,
    controllers: managedControllerRegistryRef,
    getEndpoint: () => remoteRegistry.pairingEndpoint()
  })
  remoteRegistry.setPairingService(managedPairingRef)
  try {
    managedPairingRef.init(discoveryEnabled)
    if (discoveryEnabled) setNodeGatewayEnabled(true)
  } catch (error) {
    setManagedDiscoveryEnabled(false)
    console.error('[pairing] 附近发现启动失败：', error)
  }
  federation.subscribe(forwardRuntimeEvent)

  // SPEC-034 消息渠道：IM（飞书等）驱动 agent。渠道会话的 AgentEvent 经 emit 分流到这里。
  let cachedChatAgents: { toolId: string; name: string }[] | null = null
  channelManager = new ChannelManager({
    inboundInbox: new ChannelInboundInbox(join(app.getPath('userData'), 'channel-inbox.json')),
    transport: new MultiplexChannelTransport({
      feishu: new FeishuTransport(),
      wechat: new WeChatTransport(
        join(app.getPath('userData'), 'wechat-channel'),
        app.getVersion()
      ),
      telegram: new TelegramTransport(30_000, join(app.getPath('userData'), 'telegram-channel')),
      wecom: new WeComTransport(),
      whatsapp: new WhatsAppTransport()
    }),
    createChannelSession: async (input) => {
      const handle = await federation.createSession({
        name: input.name,
        // SPEC-035：渠道会话初始名（「飞书 私聊」「<平台> · …」）是占位，首条真实消息后由摘要覆盖。
        nameProvisional: true,
        toolId: input.toolId,
        workspacePath: input.workspacePath,
        surface: 'chat',
        permissionPreset: 'auto',
        source: 'channel',
        channelBinding: input.channelBinding
      })
      return handle.session
    },
    sendTurn: (sessionId, prompt, files) => federation.sendTurn(sessionId, prompt, files),
    steerTurn: (sessionId, prompt, files) => federation.steerTurn(sessionId, prompt, files),
    interruptTurn: (sessionId) => federation.interruptTurn(sessionId),
    getSession: (id) => sessions.getSession(id),
    listSessions: () => federation.listSessions(),
    listTasks: () => federation.listTasks(),
    createTask: (input) => federation.createTask(input),
    updateTask: (id, patch) => federation.updateTask(id, patch),
    removeTask: (id) => federation.removeTask(id),
    updateSession: (id, patch) => sessions.updateSession(id, patch),
    pickDefaultAgent: async () => {
      if (!cachedChatAgents) {
        const list = await scanAll()
        cachedChatAgents = list
          .filter((r) => r.supportsChat && r.health !== 'missing')
          .map((r) => ({ toolId: r.toolId, name: r.displayName }))
      }
      const a = cachedChatAgents[0]
      return a ? { toolId: a.toolId, workspacePath: homedir(), name: a.name } : null
    },
    listAgents: async () => {
      if (!cachedChatAgents) {
        const list = await scanAll()
        cachedChatAgents = list
          .filter((r) => r.supportsChat && r.health !== 'missing')
          .map((r) => ({ toolId: r.toolId, name: r.displayName }))
      }
      return cachedChatAgents.map((a) => ({
        toolId: a.toolId,
        name: a.name,
        workspacePath: homedir()
      }))
    },
    emitAccountState: emitChannelAccountState,
    emitScanQr: (qr) => sendToMainWindow(EVENTS.channelsScanQr, qr),
    emitScanVerification: (verification) =>
      sendToMainWindow(EVENTS.channelsScanVerification, verification),
    emitScanResult: (result) => sendToMainWindow(EVENTS.channelsScanResult, result),
    deepLinkBase: 'agentos://session'
  })
  channelManager.start()

  // SPEC-034 深链：agentos://session/<id> → 聚焦窗口并通知渲染端打开该会话。
  app.setAsDefaultProtocolClient('agentos')
  const openDeepLink = (url: string): void => {
    const m = url?.match(/^agentos:\/\/session\/([\w-]+)/)
    if (!m) return
    const sessionId = m[1]
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
      sendToMainWindow(EVENTS.channelsOpenSession, { sessionId })
    }
  }
  app.on('open-url', (_e, url) => openDeepLink(url))
  // Windows/Linux：通过第二个实例的 argv 传递协议 URL。
  if (process.platform !== 'darwin') {
    const initial = process.argv.find((a) => a.startsWith('agentos://'))
    if (initial) setImmediate(() => openDeepLink(initial))
  }

  const compareService = new CompareService({
    createSession: (input) => runtime.createSession(input),
    writeToSession: (sessionId, data) => runtime.write(sessionId, data)
  })

  const webaggService = new WebAggService({
    getMainWindow: () => mainWindow,
    emit: (channel, payload) => sendToMainWindow(channel, payload)
  })
  webaggServiceRef = webaggService

  const updateService = new UpdateService(() => mainWindow)

  registerIpc(
    federation,
    memoryService,
    memoryVault,
    memoryCuration,
    experiences,
    lifecycle,
    () => runtime.restartDaemon(),
    compareService,
    webaggService,
    {
      listSessions: () => sessions.listSessions(),
      searchChatSessions: (query, limit) => chatStore.searchSessions(query, limit)
    },
    annotationsStore,
    updateService,
    remoteRegistry,
    managedControllerRegistry,
    managedPairingRef,
    channelManager,
    {
      config: currentAnalyticsConfig,
      setEnabled: (enabled) => {
        setAnalyticsEnabled(enabled)
        analyticsEventBus.setEnabled(enabled)
        return currentAnalyticsConfig()
      },
      resetIdentity: () => {
        resetAnalyticsInstallId()
        // 同步 IPC handler 内先进入 pause；renderer 收到新 identity 后 drain。
        // 不能 clear：pause 到 renderer 切换之间的新事件必须保留，且由 envelope id 去重。
        analyticsEventBus.pause()
        return currentAnalyticsConfig()
      },
      drain: () => analyticsEventBus.drain()
    }
  )

  // 孤儿 worktree 审计（崩溃后残留日志提示）
  const orphans = compareService.auditOrphans()
  if (orphans.length > 0) {
    console.warn(`[compare] 发现 ${orphans.length} 个孤儿 worktree，可手动清理：`, orphans)
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

let webaggServiceRef: WebAggService | null = null
let annotationsStoreRef: AnnotationsStore | null = null

const cleanupBeforeQuit = async (): Promise<void> => {
  uninstallCrashReporting()
  // 渠道先行：Telegram offset flush 失败时必须让 before-quit 保持拦截，
  // 不能在其他服务都关闭后才发现需要取消退出。
  await channelManager?.stop()
  const cleanups: Array<() => unknown | Promise<unknown>> = [
    () => agentTurnAnalyticsObserver?.clear(),
    () => completedTaskRunAnalyticsIds.clear(),
    () => memoryService?.close(),
    () => memoryBackgroundCurator?.close(),
    () => memoryVault?.close(),
    () => memoryCurationScheduler?.close(),
    () => fallbackTasks?.close(),
    () => fallbackChat?.close(),
    () => managedPairingRef?.close(),
    () => managedControllerRegistryRef?.close(),
    () => remoteRegistryRef?.close(),
    () => webaggServiceRef?.destroy(),
    () => annotationsStoreRef?.close()
  ]
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => cleanup()))
  for (const result of results) {
    if (result.status === 'rejected') console.error('[shutdown] 异步清理失败：', result.reason)
  }
}

async function writeCliStream(stream: NodeJS.WriteStream, output: string): Promise<void> {
  if (!output) return
  await new Promise<void>((resolve) => stream.write(output, () => resolve()))
}

async function startPackagedCli(args: string[]): Promise<void> {
  const result = await runRealAgentOsCli(args)
  await writeCliStream(process.stdout, result.stdout)
  await writeCliStream(process.stderr, result.stderr)
  app.exit(result.exitCode)
}

if (packagedCliArgs !== null) {
  void app
    .whenReady()
    .then(() => startPackagedCli(packagedCliArgs))
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      await writeCliStream(process.stderr, `agent-os: ${message}\n`)
      app.exit(1)
    })
} else {
  void app.whenReady().then(startDesktopApp)
  app.on(
    'before-quit',
    createGracefulBeforeQuitHandler(
      cleanupBeforeQuit,
      () => app.quit(),
      (error) => console.error('[shutdown] 退出清理异常：', error)
    )
  )

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
