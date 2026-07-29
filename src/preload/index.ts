// Preload（SPEC-000）。通过 contextBridge 暴露强类型 window.agentOs。
// 仅转发 IPC，不含业务逻辑；事件订阅返回 unsubscribe。

import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, EVENTS, type AgentOsApi } from '@shared/ipc-contract'

// SPEC-021：首帧绘制前预设 data-theme，消除深色用户的 FOUC（白屏闪烁）。
// preload 在页面脚本与首绘之前执行、DOM 共享、不受页面 CSP 约束，可安全写 documentElement。
// preload 的 tsconfig 不含 DOM lib，故经 globalThis 访问运行时存在的 localStorage/document/matchMedia。
// 持久化键 'agent-os.ui' 为 Zustand persist JSON（uiStore.ts name）；解析失败时静默，watchTheme 兜底。
try {
  const g = globalThis as unknown as {
    localStorage?: { getItem(k: string): string | null }
    matchMedia?: (q: string) => { matches: boolean }
    document?: { documentElement: { dataset: { theme?: string } } }
  }
  const raw = g.localStorage?.getItem('agent-os.ui') ?? null
  const pref = raw ? (JSON.parse(raw)?.state?.themePreference ?? 'system') : 'system'
  const dark =
    pref === 'dark' ||
    (pref !== 'light' && !!g.matchMedia?.('(prefers-color-scheme: dark)').matches)
  if (g.document) g.document.documentElement.dataset.theme = dark ? 'dark' : 'light'
} catch {
  /* 忽略：App 挂载后 watchTheme 会兜底应用主题 */
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AgentOsApi = {
  app: {
    getPlatformInfo: () => ipcRenderer.invoke(CHANNELS.app.getPlatformInfo),
    getAnalyticsConfig: () => ipcRenderer.invoke(CHANNELS.app.getAnalyticsConfig),
    setAnalyticsEnabled: (enabled) => ipcRenderer.invoke(CHANNELS.app.setAnalyticsEnabled, enabled),
    resetAnalyticsIdentity: () => ipcRenderer.invoke(CHANNELS.app.resetAnalyticsIdentity),
    drainAnalyticsEvents: () => ipcRenderer.invoke(CHANNELS.app.drainAnalyticsEvents),
    completeOnboarding: () => ipcRenderer.invoke(CHANNELS.app.completeOnboarding),
    resetOnboarding: () => ipcRenderer.invoke(CHANNELS.app.resetOnboarding),
    selectDirectory: (options) => ipcRenderer.invoke(CHANNELS.app.selectDirectory, options),
    selectFile: (options) => ipcRenderer.invoke(CHANNELS.app.selectFile, options),
    openExternal: (url) => ipcRenderer.invoke(CHANNELS.app.openExternal, url),
    setLanguage: (lang) => ipcRenderer.invoke(CHANNELS.app.setLanguage, lang)
  },
  discovery: {
    scan: () => ipcRenderer.invoke(CHANNELS.discovery.scan),
    get: (toolId) => ipcRenderer.invoke(CHANNELS.discovery.get, toolId),
    listModels: (toolId) => ipcRenderer.invoke(CHANNELS.discovery.listModels, toolId),
    listModelsOn: (input) => ipcRenderer.invoke(CHANNELS.discovery.listModelsOn, input)
  },
  tool: {
    startJob: (input) => ipcRenderer.invoke(CHANNELS.tool.startJob, input),
    job: (jobId) => ipcRenderer.invoke(CHANNELS.tool.job, jobId),
    cancelJob: (jobId) => ipcRenderer.invoke(CHANNELS.tool.cancelJob, jobId)
  },
  provider: {
    get: (toolId) => ipcRenderer.invoke(CHANNELS.provider.get, toolId),
    set: (config) => ipcRenderer.invoke(CHANNELS.provider.set, config)
  },
  settings: {
    getMirror: () => ipcRenderer.invoke(CHANNELS.settings.getMirror),
    setMirror: (settings) => ipcRenderer.invoke(CHANNELS.settings.setMirror, settings)
  },
  backup: {
    export: () => ipcRenderer.invoke(CHANNELS.backup.export),
    previewImport: () => ipcRenderer.invoke(CHANNELS.backup.previewImport),
    import: (approvalToken) => ipcRenderer.invoke(CHANNELS.backup.import, approvalToken)
  },
  runtime: {
    listRuntimes: () => ipcRenderer.invoke(CHANNELS.runtime.listRuntimes),
    listDirectories: (input) => ipcRenderer.invoke(CHANNELS.runtime.listDirectories, input),
    hostStatus: () => ipcRenderer.invoke(CHANNELS.runtime.hostStatus),
    restartDaemon: () => ipcRenderer.invoke(CHANNELS.runtime.restartDaemon),
    checkUpdate: (opts) => ipcRenderer.invoke(CHANNELS.runtime.checkUpdate, opts),
    applyUpdate: () => ipcRenderer.invoke(CHANNELS.runtime.applyUpdate),
    downloadUpdate: () => ipcRenderer.invoke(CHANNELS.runtime.downloadUpdate),
    installUpdate: (opts) => ipcRenderer.invoke(CHANNELS.runtime.installUpdate, opts),
    updateState: () => ipcRenderer.invoke(CHANNELS.runtime.updateState),
    listRemoteNodes: () => ipcRenderer.invoke(CHANNELS.runtime.listRemoteNodes),
    removeRemoteNode: (id) => ipcRenderer.invoke(CHANNELS.runtime.removeRemoteNode, id),
    remoteNodeStatuses: () => ipcRenderer.invoke(CHANNELS.runtime.remoteNodeStatuses),
    nodeGatewayStatus: () => ipcRenderer.invoke(CHANNELS.runtime.nodeGatewayStatus),
    nodeReleaseReadiness: () => ipcRenderer.invoke(CHANNELS.runtime.nodeReleaseReadiness),
    setNodeGatewayAdvertiseHost: (host) =>
      ipcRenderer.invoke(CHANNELS.runtime.setNodeGatewayAdvertiseHost, host),
    setNodeGatewayEnabled: (enabled) =>
      ipcRenderer.invoke(CHANNELS.runtime.setNodeGatewayEnabled, enabled),
    createNodeEnrollment: (input) =>
      ipcRenderer.invoke(CHANNELS.runtime.createNodeEnrollment, input),
    setRemoteNodeEnabled: (id, enabled) =>
      ipcRenderer.invoke(CHANNELS.runtime.setRemoteNodeEnabled, id, enabled),
    setRemoteNodeLabel: (id, label) =>
      ipcRenderer.invoke(CHANNELS.runtime.setRemoteNodeLabel, id, label),
    setNodeAgentEnabled: (nodeId, agentId, enabled) =>
      ipcRenderer.invoke(CHANNELS.runtime.setNodeAgentEnabled, nodeId, agentId, enabled),
    setNodeAgentAlias: (nodeId, agentId, alias) =>
      ipcRenderer.invoke(CHANNELS.runtime.setNodeAgentAlias, nodeId, agentId, alias),
    managedDeviceIdentity: () => ipcRenderer.invoke(CHANNELS.runtime.managedDeviceIdentity),
    managedDeviceAuthorizations: () =>
      ipcRenderer.invoke(CHANNELS.runtime.managedDeviceAuthorizations),
    setManagedDeviceAuthorizationStatus: (id, status) =>
      ipcRenderer.invoke(CHANNELS.runtime.setManagedDeviceAuthorizationStatus, id, status),
    managedPairingSnapshot: () => ipcRenderer.invoke(CHANNELS.runtime.managedPairingSnapshot),
    setManagedDiscoveryEnabled: (enabled) =>
      ipcRenderer.invoke(CHANNELS.runtime.setManagedDiscoveryEnabled, enabled),
    requestManagedPairing: (discoveryId) =>
      ipcRenderer.invoke(CHANNELS.runtime.requestManagedPairing, discoveryId),
    requestManagedPairingManual: (endpoint) =>
      ipcRenderer.invoke(CHANNELS.runtime.requestManagedPairingManual, endpoint),
    confirmManagedPairing: (sessionId) =>
      ipcRenderer.invoke(CHANNELS.runtime.confirmManagedPairing, sessionId),
    approveManagedPairing: (sessionId, input) =>
      ipcRenderer.invoke(CHANNELS.runtime.approveManagedPairing, sessionId, input),
    rejectManagedPairing: (sessionId) =>
      ipcRenderer.invoke(CHANNELS.runtime.rejectManagedPairing, sessionId),
    setManagedConnectionEnabled: (id, enabled) =>
      ipcRenderer.invoke(CHANNELS.runtime.setManagedConnectionEnabled, id, enabled),
    removeManagedConnection: (id) =>
      ipcRenderer.invoke(CHANNELS.runtime.removeManagedConnection, id)
  },
  channels: {
    listAccounts: () => ipcRenderer.invoke(CHANNELS.channels.listAccounts),
    addAccount: (input) => ipcRenderer.invoke(CHANNELS.channels.addAccount, input),
    removeAccount: (id) => ipcRenderer.invoke(CHANNELS.channels.removeAccount, id),
    setAccountEnabled: (id, enabled) =>
      ipcRenderer.invoke(CHANNELS.channels.setAccountEnabled, id, enabled),
    testConnection: (id) => ipcRenderer.invoke(CHANNELS.channels.testConnection, id),
    listBindings: () => ipcRenderer.invoke(CHANNELS.channels.listBindings),
    setBinding: (binding) => ipcRenderer.invoke(CHANNELS.channels.setBinding, binding),
    removeBinding: (platform, accountId, chatId) =>
      ipcRenderer.invoke(CHANNELS.channels.removeBinding, platform, accountId, chatId),
    getAcl: (accountId) => ipcRenderer.invoke(CHANNELS.channels.getAcl, accountId),
    setAcl: (accountId, acl) => ipcRenderer.invoke(CHANNELS.channels.setAcl, accountId, acl),
    listPairingRequests: (accountId) =>
      ipcRenderer.invoke(CHANNELS.channels.listPairingRequests, accountId),
    approvePairingRequest: (requestId) =>
      ipcRenderer.invoke(CHANNELS.channels.approvePairingRequest, requestId),
    rejectPairingRequest: (requestId) =>
      ipcRenderer.invoke(CHANNELS.channels.rejectPairingRequest, requestId),
    setGatewayEnabled: (enabled) =>
      ipcRenderer.invoke(CHANNELS.channels.setGatewayEnabled, enabled),
    startFeishuScan: (platform) => ipcRenderer.invoke(CHANNELS.channels.startFeishuScan, platform),
    submitScanVerificationCode: (code) =>
      ipcRenderer.invoke(CHANNELS.channels.submitScanVerificationCode, code),
    cancelFeishuScan: () => ipcRenderer.invoke(CHANNELS.channels.cancelFeishuScan)
  },
  session: {
    list: () => ipcRenderer.invoke(CHANNELS.session.list),
    listViews: () => ipcRenderer.invoke(CHANNELS.session.listViews),
    search: (input) => ipcRenderer.invoke(CHANNELS.session.search, input),
    create: (input) => ipcRenderer.invoke(CHANNELS.session.create, input),
    resume: (id) => ipcRenderer.invoke(CHANNELS.session.resume, id),
    openLinkedTerminal: (id) => ipcRenderer.invoke(CHANNELS.session.openLinkedTerminal, id),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.session.update, id, patch),
    remove: (id) => ipcRenderer.invoke(CHANNELS.session.remove, id)
  },
  attachments: {
    stage: (sessionId, filename, bytes) =>
      ipcRenderer.invoke(CHANNELS.attachments.stage, sessionId, filename, bytes),
    readClipboardFiles: () => ipcRenderer.invoke(CHANNELS.attachments.readClipboardFiles),
    preview: (path) => ipcRenderer.invoke(CHANNELS.attachments.preview, path)
  },
  relay: {
    listTargets: (sourceSessionId) =>
      ipcRenderer.invoke(CHANNELS.relay.listTargets, sourceSessionId),
    start: (payload) => ipcRenderer.invoke(CHANNELS.relay.start, payload),
    getContextReport: (linkId) => ipcRenderer.invoke(CHANNELS.relay.getContextReport, linkId),
    getLink: (sessionId) => ipcRenderer.invoke(CHANNELS.relay.getLink, sessionId),
    openRepair: (toolId) => ipcRenderer.invoke(CHANNELS.relay.openRepair, toolId)
  },
  terminal: {
    write: (payload) => ipcRenderer.invoke(CHANNELS.terminal.write, payload),
    resize: (payload) => ipcRenderer.invoke(CHANNELS.terminal.resize, payload),
    history: (sessionId) => ipcRenderer.invoke(CHANNELS.terminal.history, sessionId),
    state: (sessionId) => ipcRenderer.invoke(CHANNELS.terminal.state, sessionId),
    states: () => ipcRenderer.invoke(CHANNELS.terminal.states),
    close: (sessionId) => ipcRenderer.invoke(CHANNELS.terminal.close, sessionId)
  },
  chat: {
    history: (sessionId) => ipcRenderer.invoke(CHANNELS.chat.history, sessionId),
    timeline: (sessionId) => ipcRenderer.invoke(CHANNELS.chat.timeline, sessionId),
    sendTurn: (sessionId, text, files) =>
      ipcRenderer.invoke(CHANNELS.chat.sendTurn, sessionId, text, files),
    steerTurn: (sessionId, text, files) =>
      ipcRenderer.invoke(CHANNELS.chat.steerTurn, sessionId, text, files),
    queueTurn: (sessionId, text, files) =>
      ipcRenderer.invoke(CHANNELS.chat.queueTurn, sessionId, text, files),
    listQueuedTurns: (sessionId) => ipcRenderer.invoke(CHANNELS.chat.listQueuedTurns, sessionId),
    cancelQueuedTurn: (sessionId, queuedTurnId) =>
      ipcRenderer.invoke(CHANNELS.chat.cancelQueuedTurn, sessionId, queuedTurnId),
    interrupt: (sessionId) => ipcRenderer.invoke(CHANNELS.chat.interrupt, sessionId),
    respondPermission: (sessionId, requestId, decision) =>
      ipcRenderer.invoke(CHANNELS.chat.respondPermission, sessionId, requestId, decision),
    state: (sessionId) => ipcRenderer.invoke(CHANNELS.chat.state, sessionId)
  },
  tasks: {
    list: () => ipcRenderer.invoke(CHANNELS.tasks.list),
    listRuns: (taskId) => ipcRenderer.invoke(CHANNELS.tasks.listRuns, taskId),
    create: (input) => ipcRenderer.invoke(CHANNELS.tasks.create, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.tasks.update, id, patch),
    remove: (id) => ipcRenderer.invoke(CHANNELS.tasks.remove, id),
    runNow: (id) => ipcRenderer.invoke(CHANNELS.tasks.runNow, id)
  },
  diagnostics: {
    dataPlaneHealth: () => ipcRenderer.invoke(CHANNELS.diagnostics.dataPlaneHealth)
  },
  memory: {
    search: (input) => ipcRenderer.invoke(CHANNELS.memory.search, input),
    searchInSession: (input) => ipcRenderer.invoke(CHANNELS.memory.searchInSession, input),
    getTranscript: (sessionId) => ipcRenderer.invoke(CHANNELS.memory.getTranscript, sessionId),
    getTranscriptMeta: (sessionId) =>
      ipcRenderer.invoke(CHANNELS.memory.getTranscriptMeta, sessionId),
    getTranscriptPage: (input) => ipcRenderer.invoke(CHANNELS.memory.getTranscriptPage, input),
    indexStatus: () => ipcRenderer.invoke(CHANNELS.memory.indexStatus),
    listDurable: (input) => ipcRenderer.invoke(CHANNELS.memory.listDurable, input),
    getDurable: (id) => ipcRenderer.invoke(CHANNELS.memory.getDurable, id),
    createManual: (input) => ipcRenderer.invoke(CHANNELS.memory.createManual, input),
    propose: (input) => ipcRenderer.invoke(CHANNELS.memory.propose, input),
    confirm: (id, patch) => ipcRenderer.invoke(CHANNELS.memory.confirm, id, patch),
    reject: (id, reason) => ipcRenderer.invoke(CHANNELS.memory.reject, id, reason),
    updateDurable: (id, patch) => ipcRenderer.invoke(CHANNELS.memory.updateDurable, id, patch),
    forget: (id) => ipcRenderer.invoke(CHANNELS.memory.forget, id),
    feedback: (input) => ipcRenderer.invoke(CHANNELS.memory.feedback, input),
    context: (input) => ipcRenderer.invoke(CHANNELS.memory.context, input),
    settings: () => ipcRenderer.invoke(CHANNELS.memory.settings),
    updateSettings: (patch) => ipcRenderer.invoke(CHANNELS.memory.updateSettings, patch),
    getPersona: () => ipcRenderer.invoke(CHANNELS.memory.getPersona),
    updatePersona: (text) => ipcRenderer.invoke(CHANNELS.memory.updatePersona, text),
    curatorCandidates: () => ipcRenderer.invoke(CHANNELS.memory.curatorCandidates),
    gatewayCapabilities: () => ipcRenderer.invoke(CHANNELS.memory.gatewayCapabilities),
    curate: (input) => ipcRenderer.invoke(CHANNELS.memory.curate, input)
  },
  stats: {
    summary: (input) => ipcRenderer.invoke(CHANNELS.stats.summary, input),
    activity: (input) => ipcRenderer.invoke(CHANNELS.stats.activity, input),
    dashboard: (input) => ipcRenderer.invoke(CHANNELS.stats.dashboard, input),
    models: (input) => ipcRenderer.invoke(CHANNELS.stats.models, input),
    exportCsv: (input) => ipcRenderer.invoke(CHANNELS.stats.exportCsv, input),
    projects: () => ipcRenderer.invoke(CHANNELS.stats.projects),
    growth: () => ipcRenderer.invoke(CHANNELS.stats.growth),
    getGamificationEnabled: () => ipcRenderer.invoke(CHANNELS.stats.getGamificationEnabled),
    setGamificationEnabled: (value) =>
      ipcRenderer.invoke(CHANNELS.stats.setGamificationEnabled, value),
    getCardexState: () => ipcRenderer.invoke(CHANNELS.stats.getCardexState),
    setCardexState: (state) => ipcRenderer.invoke(CHANNELS.stats.setCardexState, state)
  },
  experience: {
    list: (query) => ipcRenderer.invoke(CHANNELS.experience.list, query),
    create: (input) => ipcRenderer.invoke(CHANNELS.experience.create, input),
    update: (id, patch) => ipcRenderer.invoke(CHANNELS.experience.update, id, patch),
    remove: (id) => ipcRenderer.invoke(CHANNELS.experience.remove, id)
  },
  compare: {
    start: (input) => ipcRenderer.invoke(CHANNELS.compare.start, input),
    adopt: (runId, toolId) => ipcRenderer.invoke(CHANNELS.compare.adopt, runId, toolId),
    discard: (runId) => ipcRenderer.invoke(CHANNELS.compare.discard, runId),
    list: () => ipcRenderer.invoke(CHANNELS.compare.list),
    listScenarios: () => ipcRenderer.invoke(CHANNELS.compare.listScenarios),
    getScenario: (id) => ipcRenderer.invoke(CHANNELS.compare.getScenario, id),
    saveScenario: (input) => ipcRenderer.invoke(CHANNELS.compare.saveScenario, input),
    deleteScenario: (id) => ipcRenderer.invoke(CHANNELS.compare.deleteScenario, id)
  },
  webagg: {
    listProviders: () => ipcRenderer.invoke(CHANNELS.webagg.listProviders),
    setActive: (ids) => ipcRenderer.invoke(CHANNELS.webagg.setActive, ids),
    broadcast: (text) => ipcRenderer.invoke(CHANNELS.webagg.broadcast, text),
    reload: (providerId) => ipcRenderer.invoke(CHANNELS.webagg.reload, providerId),
    updateBounds: (bounds) => ipcRenderer.invoke(CHANNELS.webagg.updateBounds, bounds),
    listBookmarks: () => ipcRenderer.invoke(CHANNELS.webagg.listBookmarks),
    addBookmark: (input) => ipcRenderer.invoke(CHANNELS.webagg.addBookmark, input),
    updateBookmark: (id, input) => ipcRenderer.invoke(CHANNELS.webagg.updateBookmark, id, input),
    removeBookmark: (id) => ipcRenderer.invoke(CHANNELS.webagg.removeBookmark, id),
    openSite: (input) => ipcRenderer.invoke(CHANNELS.webagg.openSite, input),
    siteAction: (input) => ipcRenderer.invoke(CHANNELS.webagg.siteAction, input),
    getSiteState: (id) => ipcRenderer.invoke(CHANNELS.webagg.getSiteState, id),
    updateSiteBounds: (bounds) => ipcRenderer.invoke(CHANNELS.webagg.updateSiteBounds, bounds),
    closeSite: (id) => ipcRenderer.invoke(CHANNELS.webagg.closeSite, id),
    injectSite: (input) => ipcRenderer.invoke(CHANNELS.webagg.injectSite, input)
  },
  annotations: {
    getMany: (refs) => ipcRenderer.invoke(CHANNELS.annotations.getMany, refs),
    setFavorite: (input) => ipcRenderer.invoke(CHANNELS.annotations.setFavorite, input),
    setTags: (input) => ipcRenderer.invoke(CHANNELS.annotations.setTags, input),
    addTag: (input) => ipcRenderer.invoke(CHANNELS.annotations.addTag, input),
    removeTag: (input) => ipcRenderer.invoke(CHANNELS.annotations.removeTag, input),
    listTags: () => ipcRenderer.invoke(CHANNELS.annotations.listTags),
    listAnnotated: (filter) => ipcRenderer.invoke(CHANNELS.annotations.listAnnotated, filter)
  },
  events: {
    onTerminalData: (handler) => subscribe(EVENTS.terminalData, handler),
    onTerminalExit: (handler) => subscribe(EVENTS.terminalExit, handler),
    onTerminalStateChanged: (handler) => subscribe(EVENTS.terminalStateChanged, handler),
    onDiscoveryRefresh: (handler) => subscribe(EVENTS.discoveryRefresh, handler),
    onMemoryIndexProgress: (handler) => subscribe(EVENTS.memoryIndexProgress, handler),
    onToolJobProgress: (handler) => subscribe(EVENTS.toolJobProgress, handler),
    onAgentEvent: (handler) => subscribe(EVENTS.agentEvent, handler),
    onTaskChanged: (handler) => subscribe(EVENTS.taskChanged, handler),
    onWebaggLoginStateChanged: (handler) => subscribe(EVENTS.webaggLoginStateChanged, handler),
    onWebaggSiteStateChanged: (handler) => subscribe(EVENTS.webaggSiteStateChanged, handler),
    onUpdateState: (handler) => subscribe(EVENTS.updateState, handler),
    onUpdateProgress: (handler) => subscribe(EVENTS.updateProgress, handler),
    onRemoteNodeStateChanged: (handler) => subscribe(EVENTS.remoteNodeStateChanged, handler),
    onChannelAccountStateChanged: (handler) =>
      subscribe(EVENTS.channelAccountStateChanged, handler),
    onChannelsOpenSession: (handler) => subscribe(EVENTS.channelsOpenSession, handler),
    onChannelsScanQr: (handler) => subscribe(EVENTS.channelsScanQr, handler),
    onChannelsScanVerification: (handler) => subscribe(EVENTS.channelsScanVerification, handler),
    onChannelsScanResult: (handler) => subscribe(EVENTS.channelsScanResult, handler),
    onAnalyticsEvent: (handler) => subscribe(EVENTS.analyticsEvent, handler)
  }
}

contextBridge.exposeInMainWorld('agentOs', api)
