// 强类型 IPC 契约（SPEC-000）。
// 主进程按 CHANNELS 注册 handler；preload 据此构造 window.agentOs；
// 渲染端通过 AgentOsApi 类型安全调用。channel 名集中定义，避免字符串散落。

import type {
  DiscoveryResult,
  TerminalRunState,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalStateChangedEvent,
  WorkbenchSession,
  WorkbenchSessionView,
  CreateSessionInput,
  UpdateSessionPatch,
  CompareStartInput,
  CompareRun,
  CompareRunView,
  CompareAdoptResult,
  CompareScenario,
  SaveCompareScenarioInput,
  WebProviderView,
  WebAggBroadcastResult,
  ViewBounds,
  WebSiteState,
  DataPlaneHealth,
  MemorySearchInput,
  MemoryInSessionSearchInput,
  MemorySearchHit,
  AnnotationTargetRef,
  Annotation,
  AnnotationEntry,
  AnnotationBrowseEntry,
  AnnotationListFilter,
  AnnotationTagCount,
  AnnotationSetFavoriteInput,
  AnnotationSetTagsInput,
  AnnotationTagInput,
  MemoryIndexStatus,
  MemoryTranscriptMeta,
  MemoryTranscriptPage,
  MemoryTranscriptPageInput,
  NormalizedTranscript,
  ExperienceEntry,
  CreateExperienceInput,
  UpdateExperiencePatch,
  DurableMemory,
  ListDurableMemoriesInput,
  ProposeMemoryInput,
  UpdateDurableMemoryPatch,
  MemoryFeedbackInput,
  MemoryContextInput,
  MemoryContextPack,
  MemorySettings,
  MemoryGatewayCapability,
  CuratorCandidate,
  CurateMemoryInput,
  RuntimeHostStatus,
  ManagedChatTimelineItem,
  StatsActivity,
  StatsDashboard,
  StatsExportCsvInput,
  StatsExportCsvResult,
  StatsModels,
  StatsProjectOption,
  StatsGrowth,
  StatsQuery,
  StatsSummary,
  CardexState,
  LifecycleJob,
  LifecycleJobKind,
  MirrorSettings,
  ProviderConfig,
  ProviderConfigView,
  AgentEventEnvelope,
  ChatTurnState,
  PermissionDecision,
  RuntimeSessionHandle,
  ListRuntimeDirectoriesInput,
  RuntimeDirectoryListing,
  RelayTarget,
  StartRelayPayload,
  StartRelayResult,
  RelayContextReport,
  SessionRelayRef,
  AgentTask,
  CreateTaskInput,
  TaskChangedEvent,
  TaskRun,
  UpdateTaskPatch,
  AnalyticsConfig,
  AnalyticsEventEnvelope
} from './types'
import type { Lang } from './i18n'

export const IPC_CONTRACT_VERSION = 15

/** 平台信息（用于 titlebar 安全区等）。 */
export interface PlatformInfo {
  platform: NodeJS.Platform
  /** 当前系统登录用户名。 */
  userName: string
  /** macOS traffic-light 预留高度。 */
  titlebarHeight: number
  /** 首次启动引导是否已完成。 */
  onboardingCompleted: boolean
  ipcContractVersion: number
}

/** invoke 类（请求-响应）channel。 */
export const CHANNELS = {
  app: {
    getPlatformInfo: 'app:getPlatformInfo',
    getAnalyticsConfig: 'app:getAnalyticsConfig',
    setAnalyticsEnabled: 'app:setAnalyticsEnabled',
    resetAnalyticsIdentity: 'app:resetAnalyticsIdentity',
    drainAnalyticsEvents: 'app:drainAnalyticsEvents',
    completeOnboarding: 'app:completeOnboarding',
    resetOnboarding: 'app:resetOnboarding',
    selectDirectory: 'app:selectDirectory',
    selectFile: 'app:selectFile',
    openExternal: 'app:openExternal',
    setLanguage: 'app:setLanguage'
  },
  discovery: {
    scan: 'discovery:scan',
    get: 'discovery:get',
    listModels: 'discovery:listModels',
    listModelsOn: 'discovery:listModelsOn'
  },
  tool: {
    startJob: 'tool:startJob',
    job: 'tool:job',
    cancelJob: 'tool:cancelJob'
  },
  provider: {
    get: 'provider:get',
    set: 'provider:set'
  },
  settings: {
    getMirror: 'settings:getMirror',
    setMirror: 'settings:setMirror'
  },
  backup: {
    export: 'backup:export',
    previewImport: 'backup:previewImport',
    import: 'backup:import'
  },
  runtime: {
    listRuntimes: 'runtime:listRuntimes',
    listDirectories: 'runtime:listDirectories',
    hostStatus: 'runtime:hostStatus',
    restartDaemon: 'runtime:restartDaemon',
    checkUpdate: 'runtime:checkUpdate',
    applyUpdate: 'runtime:applyUpdate',
    downloadUpdate: 'runtime:downloadUpdate',
    installUpdate: 'runtime:installUpdate',
    updateState: 'runtime:updateState',
    listRemoteNodes: 'runtime:listRemoteNodes',
    removeRemoteNode: 'runtime:removeRemoteNode',
    remoteNodeStatuses: 'runtime:remoteNodeStatuses',
    // SPEC-032 远程托管
    nodeGatewayStatus: 'runtime:nodeGatewayStatus',
    nodeReleaseReadiness: 'runtime:nodeReleaseReadiness',
    setNodeGatewayAdvertiseHost: 'runtime:setNodeGatewayAdvertiseHost',
    setNodeGatewayEnabled: 'runtime:setNodeGatewayEnabled',
    createNodeEnrollment: 'runtime:createNodeEnrollment',
    setRemoteNodeEnabled: 'runtime:setRemoteNodeEnabled',
    setRemoteNodeLabel: 'runtime:setRemoteNodeLabel',
    setNodeAgentEnabled: 'runtime:setNodeAgentEnabled',
    setNodeAgentAlias: 'runtime:setNodeAgentAlias',
    managedDeviceIdentity: 'runtime:managedDeviceIdentity',
    managedDeviceAuthorizations: 'runtime:managedDeviceAuthorizations',
    setManagedDeviceAuthorizationStatus: 'runtime:setManagedDeviceAuthorizationStatus',
    managedPairingSnapshot: 'runtime:managedPairingSnapshot',
    setManagedDiscoveryEnabled: 'runtime:setManagedDiscoveryEnabled',
    requestManagedPairing: 'runtime:requestManagedPairing',
    requestManagedPairingManual: 'runtime:requestManagedPairingManual',
    confirmManagedPairing: 'runtime:confirmManagedPairing',
    approveManagedPairing: 'runtime:approveManagedPairing',
    rejectManagedPairing: 'runtime:rejectManagedPairing',
    setManagedConnectionEnabled: 'runtime:setManagedConnectionEnabled',
    removeManagedConnection: 'runtime:removeManagedConnection'
  },
  // SPEC-034 消息网关
  channels: {
    listAccounts: 'channels:listAccounts',
    addAccount: 'channels:addAccount',
    removeAccount: 'channels:removeAccount',
    setAccountEnabled: 'channels:setAccountEnabled',
    testConnection: 'channels:testConnection',
    listBindings: 'channels:listBindings',
    setBinding: 'channels:setBinding',
    removeBinding: 'channels:removeBinding',
    getAcl: 'channels:getAcl',
    setAcl: 'channels:setAcl',
    listPairingRequests: 'channels:listPairingRequests',
    approvePairingRequest: 'channels:approvePairingRequest',
    rejectPairingRequest: 'channels:rejectPairingRequest',
    setGatewayEnabled: 'channels:setGatewayEnabled',
    startFeishuScan: 'channels:startFeishuScan',
    submitScanVerificationCode: 'channels:submitScanVerificationCode',
    cancelFeishuScan: 'channels:cancelFeishuScan'
  },
  session: {
    list: 'session:list',
    listViews: 'session:listViews',
    search: 'session:search',
    create: 'session:create',
    resume: 'session:resume',
    openLinkedTerminal: 'session:openLinkedTerminal',
    update: 'session:update',
    remove: 'session:remove'
  },
  attachments: {
    stage: 'attachments:stage',
    readClipboardFiles: 'attachments:readClipboardFiles',
    preview: 'attachments:preview'
  },
  relay: {
    listTargets: 'relay:listTargets',
    start: 'relay:start',
    getContextReport: 'relay:getContextReport',
    getLink: 'relay:getLink',
    openRepair: 'relay:openRepair'
  },
  terminal: {
    write: 'terminal:write',
    resize: 'terminal:resize',
    history: 'terminal:history',
    state: 'terminal:state',
    states: 'terminal:states',
    close: 'terminal:close'
  },
  chat: {
    history: 'chat:history',
    timeline: 'chat:timeline',
    sendTurn: 'chat:sendTurn',
    steerTurn: 'chat:steerTurn',
    queueTurn: 'chat:queueTurn',
    listQueuedTurns: 'chat:listQueuedTurns',
    cancelQueuedTurn: 'chat:cancelQueuedTurn',
    interrupt: 'chat:interrupt',
    respondPermission: 'chat:respondPermission',
    state: 'chat:state'
  },
  tasks: {
    list: 'task:list',
    listRuns: 'task:listRuns',
    create: 'task:create',
    update: 'task:update',
    remove: 'task:remove',
    runNow: 'task:runNow'
  },
  diagnostics: {
    dataPlaneHealth: 'diagnostics:dataPlaneHealth'
  },
  memory: {
    search: 'memory:search',
    searchInSession: 'memory:searchInSession',
    getTranscript: 'memory:getTranscript',
    getTranscriptMeta: 'memory:getTranscriptMeta',
    getTranscriptPage: 'memory:getTranscriptPage',
    indexStatus: 'memory:indexStatus',
    listDurable: 'memory:listDurable',
    getDurable: 'memory:getDurable',
    createManual: 'memory:createManual',
    propose: 'memory:propose',
    confirm: 'memory:confirm',
    reject: 'memory:reject',
    updateDurable: 'memory:updateDurable',
    forget: 'memory:forget',
    feedback: 'memory:feedback',
    context: 'memory:context',
    settings: 'memory:settings',
    updateSettings: 'memory:updateSettings',
    getPersona: 'memory:getPersona',
    updatePersona: 'memory:updatePersona',
    curatorCandidates: 'memory:curatorCandidates',
    gatewayCapabilities: 'memory:gatewayCapabilities',
    curate: 'memory:curate'
  },
  stats: {
    summary: 'stats:summary',
    activity: 'stats:activity',
    dashboard: 'stats:dashboard',
    models: 'stats:models',
    exportCsv: 'stats:exportCsv',
    projects: 'stats:projects',
    growth: 'stats:growth',
    getGamificationEnabled: 'stats:getGamificationEnabled',
    setGamificationEnabled: 'stats:setGamificationEnabled',
    getCardexState: 'stats:getCardexState',
    setCardexState: 'stats:setCardexState'
  },
  experience: {
    list: 'experience:list',
    create: 'experience:create',
    update: 'experience:update',
    remove: 'experience:remove'
  },
  compare: {
    start: 'compare:start',
    adopt: 'compare:adopt',
    discard: 'compare:discard',
    list: 'compare:list',
    listScenarios: 'compare:listScenarios',
    getScenario: 'compare:getScenario',
    saveScenario: 'compare:saveScenario',
    deleteScenario: 'compare:deleteScenario'
  },
  webagg: {
    listProviders: 'webagg:listProviders',
    setActive: 'webagg:setActive',
    broadcast: 'webagg:broadcast',
    reload: 'webagg:reload',
    updateBounds: 'webagg:updateBounds',
    listBookmarks: 'webagg:listBookmarks',
    addBookmark: 'webagg:addBookmark',
    updateBookmark: 'webagg:updateBookmark',
    removeBookmark: 'webagg:removeBookmark',
    openSite: 'webagg:openSite',
    siteAction: 'webagg:siteAction',
    getSiteState: 'webagg:getSiteState',
    updateSiteBounds: 'webagg:updateSiteBounds',
    closeSite: 'webagg:closeSite',
    injectSite: 'webagg:injectSite'
  },
  annotations: {
    getMany: 'annotations:getMany',
    setFavorite: 'annotations:setFavorite',
    setTags: 'annotations:setTags',
    addTag: 'annotations:addTag',
    removeTag: 'annotations:removeTag',
    listTags: 'annotations:listTags',
    listAnnotated: 'annotations:listAnnotated'
  }
} as const

/** 主进程 → 渲染端推送事件 channel。 */
export const EVENTS = {
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit',
  terminalStateChanged: 'terminal:stateChanged',
  discoveryRefresh: 'discovery:refresh',
  memoryIndexProgress: 'memory:indexProgress',
  toolJobProgress: 'tool:jobProgress',
  agentEvent: 'chat:agentEvent',
  taskChanged: 'task:changed',
  webaggLoginStateChanged: 'webagg:loginStateChanged',
  webaggSiteStateChanged: 'webagg:siteStateChanged',
  updateState: 'update:stateChanged',
  updateProgress: 'update:progress',
  remoteNodeStateChanged: 'remote:nodeStateChanged',
  channelAccountStateChanged: 'channels:accountStateChanged',
  channelsOpenSession: 'channels:openSession',
  channelsScanQr: 'channels:scanQr',
  channelsScanVerification: 'channels:scanVerification',
  channelsScanResult: 'channels:scanResult',
  analyticsEvent: 'analytics:event'
} as const

/** 渲染端可用的强类型 API（preload 通过 contextBridge 暴露为 window.agentOs）。 */
export interface AgentOsApi {
  app: {
    getPlatformInfo(): Promise<PlatformInfo>
    getAnalyticsConfig(): Promise<AnalyticsConfig>
    setAnalyticsEnabled(enabled: boolean): Promise<AnalyticsConfig>
    resetAnalyticsIdentity(): Promise<AnalyticsConfig>
    drainAnalyticsEvents(): Promise<AnalyticsEventEnvelope[]>
    completeOnboarding(): Promise<void>
    resetOnboarding(): Promise<void>
    /** 打开系统文件夹选择对话框；取消返回 null。 */
    selectDirectory(options?: { defaultPath?: string }): Promise<string | null>
    /** 打开系统文件选择对话框（图片、文档等）；取消返回 null。 */
    selectFile(options?: { allowedExtensions?: string[] }): Promise<string | null>
    /** 用系统默认浏览器打开外部链接（仅 http/https）。 */
    openExternal(url: string): Promise<void>
    /** SPEC-036：持久化界面语言到主进程并即时更新主进程 tr()。 */
    setLanguage(lang: Lang): Promise<void>
  }
  discovery: {
    scan(): Promise<DiscoveryResult[]>
    get(toolId: string): Promise<DiscoveryResult | null>
    /** 读取当前安装 Agent 的原生模型目录；绝不补源码静态模型。 */
    listModels(toolId: string): Promise<import('./types').ToolModelCatalog>
    /** SPEC-033：按运行位置取模型——hostId 缺省/为 'local' 走本机；远程节点经联邦 RPC。 */
    listModelsOn(input: {
      toolId: string
      hostId?: string
    }): Promise<import('./types').ToolModelCatalog>
  }
  tool: {
    startJob(input: { toolId: string; kind: LifecycleJobKind }): Promise<string>
    job(jobId: string): Promise<LifecycleJob | null>
    cancelJob(jobId: string): Promise<boolean>
  }
  provider: {
    get(toolId: string): Promise<ProviderConfigView>
    set(config: ProviderConfig): Promise<ProviderConfigView>
  }
  settings: {
    getMirror(): Promise<MirrorSettings>
    setMirror(settings: MirrorSettings): Promise<void>
  }
  backup: {
    export(): Promise<import('./types').PortableBackupExportResult>
    previewImport(): Promise<import('./types').PortableBackupPreviewResult>
    import(approvalToken: string): Promise<import('./types').PortableBackupImportResult>
  }
  runtime: {
    listRuntimes(): Promise<import('./types').RuntimeInfo[]>
    /** 浏览某 runtime 主机目录；远程 hostId 时返回远程节点目录。 */
    listDirectories(input?: ListRuntimeDirectoriesInput): Promise<RuntimeDirectoryListing>
    hostStatus(): Promise<RuntimeHostStatus>
    restartDaemon(): Promise<RuntimeHostStatus>
    /** 检查更新（命中 GitHub Releases API）。 */
    checkUpdate(opts?: {
      silent?: boolean
      force?: boolean
    }): Promise<import('./types').UpdateCheckResult>
    /** 兼容旧入口：触发下载（下载完成后由 UI 驱动安装）。 */
    applyUpdate(): Promise<{ started: boolean; error?: string }>
    /** 下载最新安装包，进度经 onUpdateProgress 推送。 */
    downloadUpdate(): Promise<{ started: boolean; error?: string }>
    /** 安装已下载的更新包；quitAfterOpen 默认 true。 */
    installUpdate(opts?: {
      quitAfterOpen?: boolean
    }): Promise<{ ok: boolean; error?: string; quit?: boolean }>
    /** 获取当前更新状态快照（用于渲染端水合）。 */
    updateState(): Promise<import('./types').UpdateState>
    /** 列出已配对的局域网远程节点（不含 token）。 */
    listRemoteNodes(): Promise<import('./types').RemoteNode[]>
    /** 移除一个远程节点。 */
    removeRemoteNode(id: string): Promise<void>
    /** 各远程节点的连接状态快照。 */
    remoteNodeStatuses(): Promise<import('./types').RemoteNodeStatus[]>
    // SPEC-032 远程托管
    /** 远程托管网关状态（开关 + 本机监听 + 证书指纹）。 */
    nodeGatewayStatus(): Promise<import('./types').NodeGatewayStatus>
    /** 检查当前桌面 exact-version 的节点制品与完整性清单。 */
    nodeReleaseReadiness(): Promise<import('./types').NodeReleaseReadiness>
    /** 选择接入命令向目标机公布的局域网地址，并安全重启网关。 */
    setNodeGatewayAdvertiseHost(host: string): Promise<{ ok: boolean; error?: string }>
    /** 开/关远程托管网关。 */
    setNodeGatewayEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>
    /** 生成一次性接入：token + 三系统一行命令。 */
    createNodeEnrollment(
      input: import('./types').CreateEnrollmentInput
    ): Promise<import('./types').CreateEnrollmentResult>
    /** 启用/禁用某节点。 */
    setRemoteNodeEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>
    /** 改节点别名。 */
    setRemoteNodeLabel(id: string, label: string): Promise<{ ok: boolean; error?: string }>
    /** 启用/禁用某节点上的某 agent。 */
    setNodeAgentEnabled(
      nodeId: string,
      agentId: string,
      enabled: boolean
    ): Promise<{ ok: boolean; error?: string }>
    /** 改远程 agent 显示别名。 */
    setNodeAgentAlias(
      nodeId: string,
      agentId: string,
      alias: string
    ): Promise<{ ok: boolean; error?: string }>
    /** 本机 GUI 的稳定公开设备身份；不包含私钥。 */
    managedDeviceIdentity(): Promise<import('./types').ManagedDeviceIdentity>
    /** 本机作为受托管端时批准的单向授权；不包含任何凭证明文/摘要。 */
    managedDeviceAuthorizations(): Promise<import('./types').ManagedDeviceAuthorization[]>
    /** 暂停、恢复或永久撤销一条入站方向性授权。 */
    setManagedDeviceAuthorizationStatus(
      id: string,
      status: import('./types').ManagedDeviceAuthorizationStatus
    ): Promise<import('./types').ManagedDeviceAuthorization>
    /** 附近设备、短期配对会话及双向授权的公开快照；不含凭证。 */
    managedPairingSnapshot(): Promise<import('./types').ManagedPairingSnapshot>
    /** 开关 mDNS 可发现性；开启时会确保 TLS 网关已运行。 */
    setManagedDiscoveryEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>
    requestManagedPairing(discoveryId: string): Promise<import('./types').ManagedPairingSession>
    requestManagedPairingManual(endpoint: string): Promise<import('./types').ManagedPairingSession>
    confirmManagedPairing(sessionId: string): Promise<import('./types').ManagedPairingSession>
    approveManagedPairing(
      sessionId: string,
      input: import('./types').ApproveManagedPairingInput
    ): Promise<import('./types').ManagedPairingSession>
    rejectManagedPairing(sessionId: string): Promise<import('./types').ManagedPairingSession>
    setManagedConnectionEnabled(id: string, enabled: boolean): Promise<void>
    removeManagedConnection(id: string): Promise<void>
  }
  // SPEC-034 消息网关
  channels: {
    listAccounts(): Promise<import('./types').ChannelAccount[]>
    addAccount(
      input: import('./types').AddChannelAccountInput
    ): Promise<import('./types').ChannelAccount>
    removeAccount(id: string): Promise<void>
    setAccountEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>
    testConnection(
      id: string
    ): Promise<{ ok: boolean; status?: import('./types').ChannelAccountStatus; error?: string }>
    listBindings(): Promise<import('./types').ChannelBinding[]>
    setBinding(binding: import('./types').ChannelBinding): Promise<import('./types').ChannelBinding>
    removeBinding(platform: string, accountId: string, chatId: string): Promise<void>
    getAcl(accountId: string): Promise<import('./types').ChannelAcl>
    setAcl(accountId: string, acl: import('./types').ChannelAcl): Promise<void>
    listPairingRequests(accountId: string): Promise<import('./types').ChannelPairingRequest[]>
    approvePairingRequest(requestId: string): Promise<import('./types').ChannelAcl>
    rejectPairingRequest(requestId: string): Promise<void>
    setGatewayEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>
    /** 飞书 registerApp / 微信 iLink 扫码；进度经扫码事件推送。 */
    startFeishuScan(platform?: 'feishu' | 'wechat'): Promise<void>
    submitScanVerificationCode(code: string): Promise<void>
    cancelFeishuScan(): Promise<void>
  }
  session: {
    list(): Promise<WorkbenchSession[]>
    listViews(): Promise<WorkbenchSessionView[]>
    search(input: MemorySearchInput): Promise<MemorySearchHit[]>
    create(input: CreateSessionInput): Promise<RuntimeSessionHandle>
    resume(id: string): Promise<RuntimeSessionHandle>
    openLinkedTerminal(id: string): Promise<RuntimeSessionHandle>
    update(id: string, patch: UpdateSessionPatch): Promise<WorkbenchSession | null>
    remove(id: string): Promise<void>
  }
  attachments: {
    /** 把粘贴/拖拽的文件字节物化到本地暂存目录，返回绝对路径 + 展示名 + 字节数。 */
    stage(
      sessionId: string,
      filename: string,
      bytes: Uint8Array
    ): Promise<{ path: string; displayName: string; bytes: number }>
    /** 读剪贴板里「复制的文件」的绝对路径（Finder/资源管理器）；无文件返回空数组。 */
    readClipboardFiles(): Promise<string[]>
    /** 返回经主进程授权与缩放的本地图片缩略图；未授权、非图片或解码失败返回 null。 */
    preview(path: string): Promise<import('./attachment-preview').AttachmentPreview | null>
  }
  relay: {
    listTargets(sourceSessionId: string): Promise<RelayTarget[]>
    start(payload: StartRelayPayload): Promise<StartRelayResult>
    getContextReport(linkId: string): Promise<RelayContextReport | null>
    getLink(sessionId: string): Promise<{ source?: SessionRelayRef; target?: SessionRelayRef }>
    openRepair(toolId: string): Promise<void>
  }
  terminal: {
    write(payload: { sessionId: string; data: string }): Promise<boolean>
    resize(payload: { sessionId: string; cols: number; rows: number }): Promise<boolean>
    history(sessionId: string): Promise<string>
    state(sessionId: string): Promise<TerminalRunState | null>
    states(): Promise<TerminalRunState[]>
    close(sessionId: string): Promise<boolean>
  }
  chat: {
    history(sessionId: string): Promise<import('./types').ManagedChatMessage[]>
    timeline(sessionId: string): Promise<ManagedChatTimelineItem[]>
    sendTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState>
    steerTurn(sessionId: string, text: string, files?: string[]): Promise<ChatTurnState>
    queueTurn(
      sessionId: string,
      text: string,
      files?: string[]
    ): Promise<import('./types').ManagedQueuedTurn>
    listQueuedTurns(sessionId: string): Promise<import('./types').ManagedQueuedTurn[]>
    cancelQueuedTurn(sessionId: string, queuedTurnId: string): Promise<boolean>
    interrupt(sessionId: string): Promise<boolean>
    respondPermission(
      sessionId: string,
      requestId: string,
      decision: PermissionDecision
    ): Promise<ChatTurnState>
    state(sessionId: string): Promise<ChatTurnState>
  }
  tasks: {
    list(): Promise<AgentTask[]>
    listRuns(taskId: string): Promise<TaskRun[]>
    create(input: CreateTaskInput): Promise<AgentTask>
    update(id: string, patch: UpdateTaskPatch): Promise<AgentTask | null>
    remove(id: string): Promise<void>
    runNow(id: string): Promise<TaskRun>
  }
  diagnostics: {
    dataPlaneHealth(): Promise<DataPlaneHealth[]>
  }
  memory: {
    search(input: MemorySearchInput): Promise<MemorySearchHit[]>
    searchInSession(input: MemoryInSessionSearchInput): Promise<NormalizedTranscript['messages']>
    getTranscript(sessionId: string): Promise<NormalizedTranscript | null>
    getTranscriptMeta(sessionId: string): Promise<MemoryTranscriptMeta | null>
    getTranscriptPage(input: MemoryTranscriptPageInput): Promise<MemoryTranscriptPage | null>
    indexStatus(): Promise<MemoryIndexStatus>
    listDurable(input?: ListDurableMemoriesInput): Promise<DurableMemory[]>
    getDurable(id: string): Promise<DurableMemory | null>
    createManual(input: ProposeMemoryInput): Promise<DurableMemory>
    propose(input: ProposeMemoryInput): Promise<DurableMemory>
    confirm(id: string, patch?: UpdateDurableMemoryPatch): Promise<DurableMemory | null>
    reject(id: string, reason?: string): Promise<DurableMemory | null>
    updateDurable(id: string, patch: UpdateDurableMemoryPatch): Promise<DurableMemory | null>
    forget(id: string): Promise<void>
    feedback(input: MemoryFeedbackInput): Promise<void>
    context(input: MemoryContextInput): Promise<MemoryContextPack>
    settings(): Promise<MemorySettings>
    updateSettings(patch: Partial<MemorySettings>): Promise<MemorySettings>
    getPersona(): Promise<string>
    updatePersona(text: string): Promise<string>
    curatorCandidates(): Promise<CuratorCandidate[]>
    gatewayCapabilities(): Promise<MemoryGatewayCapability[]>
    curate(input: CurateMemoryInput): Promise<DurableMemory[]>
  }
  stats: {
    summary(input: StatsQuery): Promise<StatsSummary>
    activity(input: StatsQuery): Promise<StatsActivity>
    dashboard(input: StatsQuery): Promise<StatsDashboard>
    models(input: StatsQuery): Promise<StatsModels>
    exportCsv(input: StatsExportCsvInput): Promise<StatsExportCsvResult>
    projects(): Promise<StatsProjectOption[]>
    growth(): Promise<StatsGrowth>
    getGamificationEnabled(): Promise<boolean>
    setGamificationEnabled(value: boolean): Promise<void>
    getCardexState(): Promise<CardexState>
    setCardexState(state: CardexState): Promise<void>
  }
  experience: {
    list(query?: string): Promise<ExperienceEntry[]>
    create(input: CreateExperienceInput): Promise<ExperienceEntry>
    update(id: string, patch: UpdateExperiencePatch): Promise<ExperienceEntry | null>
    remove(id: string): Promise<void>
  }
  compare: {
    start(input: CompareStartInput): Promise<CompareRun>
    adopt(runId: string, toolId: string): Promise<CompareAdoptResult>
    discard(runId: string): Promise<void>
    list(): Promise<CompareRunView[]>
    listScenarios(): Promise<CompareScenario[]>
    getScenario(id: string): Promise<CompareScenario | null>
    saveScenario(input: SaveCompareScenarioInput): Promise<CompareScenario>
    deleteScenario(id: string): Promise<void>
  }
  webagg: {
    listProviders(): Promise<WebProviderView[]>
    setActive(providerIds: string[]): Promise<void>
    broadcast(text: string): Promise<WebAggBroadcastResult[]>
    reload(providerId: string): Promise<void>
    updateBounds(bounds: Record<string, ViewBounds>): Promise<void>
    listBookmarks(): Promise<import('./types').WebBookmark[]>
    addBookmark(input: {
      name: string
      url: string
      color?: string
    }): Promise<import('./types').WebBookmark[]>
    updateBookmark(
      id: string,
      input: { name?: string; url?: string; color?: string }
    ): Promise<import('./types').WebBookmark[]>
    removeBookmark(id: string): Promise<import('./types').WebBookmark[]>
    openSite(input: { id: string; url: string }): Promise<void>
    siteAction(input: { id: string; action: 'back' | 'forward' | 'reload' }): Promise<void>
    getSiteState(id: string): Promise<WebSiteState | null>
    updateSiteBounds(bounds: Record<string, ViewBounds>): Promise<void>
    closeSite(id: string): Promise<void>
    /** 向站点视图注入文本并按 Enter 提交（对比镜头批量发送）。 */
    injectSite(input: { id: string; text: string }): Promise<boolean>
  }
  annotations: {
    getMany(refs: AnnotationTargetRef[]): Promise<AnnotationEntry[]>
    setFavorite(input: AnnotationSetFavoriteInput): Promise<Annotation>
    setTags(input: AnnotationSetTagsInput): Promise<Annotation>
    addTag(input: AnnotationTagInput): Promise<Annotation>
    removeTag(input: AnnotationTagInput): Promise<Annotation>
    listTags(): Promise<AnnotationTagCount[]>
    listAnnotated(filter?: AnnotationListFilter): Promise<AnnotationBrowseEntry[]>
  }
  events: {
    onTerminalData(handler: (event: TerminalDataEvent) => void): () => void
    onTerminalExit(handler: (event: TerminalExitEvent) => void): () => void
    onTerminalStateChanged(handler: (event: TerminalStateChangedEvent) => void): () => void
    onDiscoveryRefresh(handler: (results: DiscoveryResult[]) => void): () => void
    onMemoryIndexProgress(handler: (status: MemoryIndexStatus) => void): () => void
    onToolJobProgress(handler: (job: LifecycleJob) => void): () => void
    onAgentEvent(handler: (event: AgentEventEnvelope) => void): () => void
    onTaskChanged(handler: (event: TaskChangedEvent) => void): () => void
    onWebaggLoginStateChanged(
      handler: (event: { providerId: string; state: import('./types').WebAggLoginState }) => void
    ): () => void
    onWebaggSiteStateChanged(handler: (event: WebSiteState) => void): () => void
    onUpdateState(handler: (state: import('./types').UpdateState) => void): () => void
    onUpdateProgress(handler: (event: import('./types').UpdateProgressEvent) => void): () => void
    onRemoteNodeStateChanged(
      handler: (status: import('./types').RemoteNodeStatus) => void
    ): () => void
    onChannelAccountStateChanged(
      handler: (account: import('./types').ChannelAccount) => void
    ): () => void
    onChannelsOpenSession(handler: (event: { sessionId: string }) => void): () => void
    onChannelsScanQr(handler: (qr: import('./types').ChannelScanQr) => void): () => void
    onChannelsScanVerification(
      handler: (verification: import('./types').ChannelScanVerification) => void
    ): () => void
    onChannelsScanResult(handler: (result: import('./types').ChannelScanResult) => void): () => void
    onAnalyticsEvent(handler: (event: AnalyticsEventEnvelope) => void): () => void
  }
}

declare global {
  interface Window {
    agentOs: AgentOsApi
  }
}
