// 应用持久化（SPEC-000/005/017）。electron-store 单实例，保存于用户数据目录。
// 仅存元数据（会话、引导状态），不存终端缓冲（缓冲在内存，进程退出即弃）。
// SPEC-017：存储从 sessions[] 升级为 conversations[]，带一次性迁移。

import Store from 'electron-store'
import { app } from 'electron'
import { chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  CardexState,
  ChannelAccount,
  ChannelAcl,
  ChannelBinding,
  ChannelPairingRequest,
  CompareScenario,
  CompareRun,
  Conversation,
  ConversationSegment,
  MirrorSettings,
  ManagedDeviceAuthorizationRecord,
  ManagedDeviceIdentityRecord,
  ManagedDeviceConnectionRecord,
  ManagedSessionOwnership,
  PermissionPreset,
  ProviderConfig,
  RemoteNode,
  WebBookmark,
  WorkbenchSession
} from '@shared/types'
import type { Lang, LanguagePreference } from '@shared/i18n'

const DEFAULT_BOOKMARKS: WebBookmark[] = [
  { id: 'bm-github', name: 'GitHub', url: 'https://www.github.com', color: '#24292f', pinned: true },
  { id: 'bm-skills', name: 'Skills', url: 'https://www.skills.sh', color: '#3b82f6', pinned: true },
  { id: 'bm-agent-life', name: 'Agent Life', url: 'https://agentos.aiutil.com/', color: '#8b5cf6', pinned: true }
]
const LEGACY_DEFAULT_BOOKMARK_IDS = new Set(['bm-vercel', 'bm-linear', 'bm-npm'])

interface LegacySession {
  id: string
  name: string
  toolId: string
  workspacePath: string
  terminalSessionId: string | null
  nativeSessionId: string | null
  surface?: 'terminal' | 'chat'
  permissionPreset?: PermissionPreset
  favorite: boolean
  createdAt: string
  updatedAt: string
}

interface AppStoreSchema {
  onboardingCompleted: boolean
  /** Mixpanel 匿名 identity；不包含用户名、邮箱、设备名或业务记录 id。 */
  analyticsInstallId: string
  /** 用户行为分析总开关；关闭时主进程不排队事件、renderer 不初始化 SDK。 */
  analyticsEnabled: boolean
  /** 旧版只保存解析后的界面语言；保留用于无损迁移。 */
  language?: Lang
  /** 0.4.0 起保存用户选择，system 会在每次启动时重新解析系统 locale。 */
  languagePreference?: LanguagePreference
  /** @deprecated Use conversations instead. Kept for one-time migration. */
  sessions: LegacySession[]
  conversations: Conversation[]
  compareRuns: CompareRun[]
  compareScenarios: CompareScenario[]
  webAggActiveProviders: string[]
  webBookmarks: WebBookmark[]
  gamificationEnabled: boolean
  cardexState: CardexState
  mirrorSettings: MirrorSettings
  providerConfigs: Record<string, ProviderConfig>
  /** 已配对的局域网远程 agent 节点。 */
  remoteNodes: RemoteNode[]
  /** SPEC-032：是否开启「远程托管」网关（接受节点反向接入）。 */
  nodeGatewayEnabled: boolean
  /** SPEC-032：节点接入命令对外公布的局域网 IPv4；空值使用自动推荐。 */
  nodeGatewayAdvertiseHost: string
  /** SPEC-032 v2：本机 GUI 稳定设备身份（含主进程专用私钥）。 */
  managedDeviceIdentity: ManagedDeviceIdentityRecord | null
  /** SPEC-032 v2：本机作为受托管端时批准的单向授权（含凭证摘要，不含明文）。 */
  managedDeviceAuthorizations: ManagedDeviceAuthorizationRecord[]
  /** SPEC-032 v2：远程授权创建的会话与 PTY 所有权。 */
  managedSessionOwnerships: ManagedSessionOwnership[]
  /** SPEC-032 v2：本机作为控制端时保存的出站授权（含长期凭证，仅主进程读取）。 */
  managedDeviceConnections: ManagedDeviceConnectionRecord[]
  /** SPEC-032 v2：是否通过 mDNS 允许附近设备发现并发起 GUI 单向配对。 */
  managedDiscoveryEnabled: boolean
  /** SPEC-034：消息网关总开关（关闭后停止所有渠道处理）。 */
  channelsGatewayEnabled: boolean
  /** SPEC-034：已配置的渠道账号（飞书应用等）。 */
  channelAccounts: ChannelAccount[]
  /** SPEC-034：外部会话↔Conversation 绑定。 */
  channelBindings: ChannelBinding[]
  /** SPEC-034：每账号的访问白名单（accountId → allowlist）。 */
  channelAcls: Record<string, ChannelAcl>
  /** SPEC-034：等待桌面端批准的消息渠道 owner pairing 请求。 */
  channelPairingRequests: ChannelPairingRequest[]
}

const store = new Store<AppStoreSchema>({
  name: 'agent-os',
  // 同一文件同时保存设备私钥、渠道凭据和远程 token。Conf 每次原子写都会
  // 重新创建文件，必须在构造级固定 0600，不能只在敏感 setter 后 chmod。
  configFileMode: 0o600,
  defaults: {
    onboardingCompleted: false,
    analyticsInstallId: '',
    analyticsEnabled: true,
    sessions: [],
    conversations: [],
    compareRuns: [],
    compareScenarios: [],
    webAggActiveProviders: [],
    webBookmarks: [],
    gamificationEnabled: true,
    cardexState: { equipped: [], seenUnlocked: [] },
    mirrorSettings: {},
    providerConfigs: {},
    remoteNodes: [],
    nodeGatewayEnabled: false,
    nodeGatewayAdvertiseHost: '',
    managedDeviceIdentity: null,
    managedDeviceAuthorizations: [],
    managedSessionOwnerships: [],
    managedDeviceConnections: [],
    managedDiscoveryEnabled: false,
    channelsGatewayEnabled: false,
    channelAccounts: [],
    channelBindings: [],
    channelAcls: {},
    channelPairingRequests: []
  }
})

function migrateSessionsToConversations(): void {
  const conversations = store.get('conversations')
  if (conversations.length > 0) return
  const sessions = store.get('sessions')
  if (sessions.length === 0) return
  const migrated: Conversation[] = sessions.map((s) => {
    const segment: ConversationSegment = {
      id: randomUUID(),
      toolId: s.toolId,
      nativeSessionId: s.nativeSessionId,
      startedAt: s.createdAt,
      endedAt: null
    }
    return {
      id: s.id,
      name: s.name,
      workspacePath: s.workspacePath,
      favorite: s.favorite,
      pinned: false,
      segments: [segment],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      // 运行时兼容字段
      terminalSessionId: s.terminalSessionId,
      surface: s.surface ?? 'terminal',
      permissionPreset: s.permissionPreset ?? 'safe'
    }
  })
  store.set('conversations', migrated)
}

migrateSessionsToConversations()
// 升级已有安装时，即使本次启动尚未触发写入，也立即收紧历史配置文件。
secureStoreFile()

export function getOnboardingCompleted(): boolean {
  return store.get('onboardingCompleted')
}

export function setOnboardingCompleted(value: boolean): void {
  store.set('onboardingCompleted', value)
}

export function getAnalyticsInstallId(): string {
  const current = store.get('analyticsInstallId').trim()
  if (current) return current
  const created = randomUUID()
  store.set('analyticsInstallId', created)
  secureStoreFile()
  return created
}

export function resetAnalyticsInstallId(): string {
  const created = randomUUID()
  store.set('analyticsInstallId', created)
  secureStoreFile()
  return created
}

export function getAnalyticsEnabled(): boolean {
  return store.get('analyticsEnabled')
}

export function setAnalyticsEnabled(value: boolean): void {
  store.set('analyticsEnabled', value)
  secureStoreFile()
}

export function getConversations(): Conversation[] {
  return store.get('conversations').map((conv) => ({
    ...conv,
    surface: conv.surface ?? 'terminal',
    permissionPreset: conv.permissionPreset ?? 'safe',
    terminalSessionId: conv.terminalSessionId ?? null,
    pinned: conv.pinned ?? false,
    segments: (conv.segments ?? []).map((seg) => ({
      ...seg,
      nativeSessionId: seg.nativeSessionId ?? null,
      endedAt: seg.endedAt ?? null
    }))
  }))
}

export function setConversations(conversations: Conversation[]): void {
  store.set('conversations', conversations)
}

/** @deprecated 仅供向后兼容，内部从 conversations 派生。 */
export function getSessions(): WorkbenchSession[] {
  return getConversations().map(conversationToSession)
}

/** @deprecated */
export function setSessions(_sessions: WorkbenchSession[]): void {
  // 已由 conversation store 接管，不再直接写 sessions
}

function conversationToSession(conv: Conversation): WorkbenchSession {
  const lastSeg = conv.segments[conv.segments.length - 1]
  return {
    id: conv.id,
    name: conv.name,
    toolId: lastSeg?.toolId ?? '',
    workspacePath: conv.workspacePath,
    terminalSessionId: conv.terminalSessionId ?? null,
    nativeSessionId: lastSeg?.nativeSessionId ?? null,
    surface: conv.surface ?? 'terminal',
    permissionPreset: conv.permissionPreset ?? 'safe',
    favorite: conv.favorite,
    pinned: conv.pinned ?? false,
    ...(conv.relaySource ? { relaySource: conv.relaySource } : {}),
    ...(conv.relayTarget ? { relayTarget: conv.relayTarget } : {}),
    ...(conv.rootTitle ? { rootTitle: conv.rootTitle } : {}),
    segments: conv.segments,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt
  }
}

export function getGamificationEnabled(): boolean {
  return store.get('gamificationEnabled')
}

export function setGamificationEnabled(value: boolean): void {
  store.set('gamificationEnabled', value)
}

/** SPEC-036：界面语言（持久化真相源，跨重启存活；主进程 tr() 读取）。 */
export function getLanguage(): Lang {
  return store.get('language') ?? 'zh'
}

export function setLanguage(lang: Lang): void {
  store.set('language', lang)
}

export function getLanguagePreference(): LanguagePreference {
  const preference = store.get('languagePreference')
  if (preference === 'system' || preference === 'zh' || preference === 'en') return preference
  const legacy = store.get('language')
  return legacy === 'zh' || legacy === 'en' ? legacy : 'system'
}

export function setLanguagePreference(preference: LanguagePreference): void {
  store.set('languagePreference', preference)
}

export function getCardexState(): CardexState {
  return store.get('cardexState')
}

export function setCardexState(state: CardexState): void {
  store.set('cardexState', {
    equipped: state.equipped.slice(0, 3),
    seenUnlocked: state.seenUnlocked
  })
}

function secureStoreFile(): void {
  try {
    chmodSync(store.path, 0o600)
  } catch {
    // electron-store may not have created the file yet; the next write retries.
  }
}

export function getMirrorSettings(): MirrorSettings {
  return { ...store.get('mirrorSettings') }
}

export function setMirrorSettings(settings: MirrorSettings): void {
  store.set('mirrorSettings', settings)
  secureStoreFile()
}

export function getProviderConfig(toolId: string): ProviderConfig {
  const stored = store.get('providerConfigs')[toolId]
  return stored ? { ...stored } : { toolId }
}

export function setProviderConfig(config: ProviderConfig): void {
  store.set(`providerConfigs.${config.toolId}`, config)
  secureStoreFile()
}

export function getCompareRuns(): CompareRun[] {
  return store.get('compareRuns') ?? []
}

export function setCompareRuns(runs: CompareRun[]): void {
  store.set('compareRuns', runs)
}

export function getCompareScenarios(): CompareScenario[] {
  return store.get('compareScenarios') ?? []
}

export function setCompareScenarios(scenarios: CompareScenario[]): void {
  store.set('compareScenarios', scenarios)
}

export function getWebAggActiveProviders(): string[] {
  return store.get('webAggActiveProviders') ?? []
}

export function setWebAggActiveProviders(ids: string[]): void {
  store.set('webAggActiveProviders', ids)
}

export function getWebBookmarks(): WebBookmark[] {
  const saved = store.get('webBookmarks')
  const filtered = !saved || saved.length === 0
    ? []
    : saved.filter((bookmark) => !LEGACY_DEFAULT_BOOKMARK_IDS.has(bookmark.id))

  // 合并默认书签（用ID去重）
  const ids = new Set(filtered.map(b => b.id))
  const merged = [
    ...filtered,
    ...DEFAULT_BOOKMARKS.filter(b => !ids.has(b.id))
  ]

  // 如果有过滤或合并，保存更新
  if (merged.length !== saved?.length) {
    store.set('webBookmarks', merged)
  }

  return merged.length > 0 ? merged : DEFAULT_BOOKMARKS
}

export function setWebBookmarks(bookmarks: WebBookmark[]): void {
  store.set('webBookmarks', bookmarks)
}

export function getAppStorePath(): string {
  return store.path
}

/** 返回当前应用版本号（读取 package.json）。 */
export function getAppVersion(): string {
  // electron-store 不存版本号，从 Electron app 获取
  try {
    return app.getVersion()
  } catch {
    return '0.1.0'
  }
}

export function getRemoteNodes(): RemoteNode[] {
  return store.get('remoteNodes')
}

export function setRemoteNodes(nodes: RemoteNode[]): void {
  store.set('remoteNodes', nodes)
}

export function getNodeGatewayEnabled(): boolean {
  return store.get('nodeGatewayEnabled')
}

export function setNodeGatewayEnabled(enabled: boolean): void {
  store.set('nodeGatewayEnabled', enabled)
}

export function getNodeGatewayAdvertiseHost(): string {
  return store.get('nodeGatewayAdvertiseHost')
}

export function setNodeGatewayAdvertiseHost(host: string): void {
  store.set('nodeGatewayAdvertiseHost', host)
}

export function getManagedDeviceIdentity(): ManagedDeviceIdentityRecord | null {
  const identity = store.get('managedDeviceIdentity')
  return identity ? { ...identity } : null
}

export function setManagedDeviceIdentity(identity: ManagedDeviceIdentityRecord): void {
  store.set('managedDeviceIdentity', identity)
  secureStoreFile()
}

export function getManagedDeviceAuthorizations(): ManagedDeviceAuthorizationRecord[] {
  return store.get('managedDeviceAuthorizations').map((authorization) => ({
    ...authorization,
    capabilities: [...authorization.capabilities],
    allowedRoots: [...authorization.allowedRoots]
  }))
}

export function setManagedDeviceAuthorizations(authorizations: ManagedDeviceAuthorizationRecord[]): void {
  store.set('managedDeviceAuthorizations', authorizations)
  secureStoreFile()
}

export function getManagedSessionOwnerships(): ManagedSessionOwnership[] {
  return store.get('managedSessionOwnerships').map((ownership) => ({ ...ownership }))
}

export function setManagedSessionOwnerships(ownerships: ManagedSessionOwnership[]): void {
  store.set('managedSessionOwnerships', ownerships)
}

export function getManagedDeviceConnections(): ManagedDeviceConnectionRecord[] {
  const stored: unknown = store.get('managedDeviceConnections')
  // 持久化文件可能被手工改坏；保留单条原始形状交给 registry 严格校验，顶层非数组则安全降级为空。
  return structuredClone(Array.isArray(stored) ? stored : []) as ManagedDeviceConnectionRecord[]
}

export function setManagedDeviceConnections(connections: ManagedDeviceConnectionRecord[]): void {
  store.set('managedDeviceConnections', connections)
  secureStoreFile()
}

export function getManagedDiscoveryEnabled(): boolean {
  return store.get('managedDiscoveryEnabled')
}

export function setManagedDiscoveryEnabled(enabled: boolean): void {
  store.set('managedDiscoveryEnabled', enabled)
}

// ─── SPEC-034 消息网关持久化 ───────────────────────────────────────────────

export function getChannelsGatewayEnabled(): boolean {
  return store.get('channelsGatewayEnabled')
}

export function setChannelsGatewayEnabled(enabled: boolean): void {
  store.set('channelsGatewayEnabled', enabled)
}

export function getChannelAccounts(): ChannelAccount[] {
  return store.get('channelAccounts')
}

export function setChannelAccounts(accounts: ChannelAccount[]): void {
  store.set('channelAccounts', accounts)
  secureStoreFile()
}

export function getChannelBindings(): ChannelBinding[] {
  return store.get('channelBindings')
}

export function setChannelBindings(bindings: ChannelBinding[]): void {
  store.set('channelBindings', bindings)
}

export function getChannelAcls(): Record<string, ChannelAcl> {
  return store.get('channelAcls')
}

export function setChannelAcls(acls: Record<string, ChannelAcl>): void {
  store.set('channelAcls', acls)
}

export function getChannelPairingRequests(): ChannelPairingRequest[] {
  return store.get('channelPairingRequests')
}

export function setChannelPairingRequests(requests: ChannelPairingRequest[]): void {
  store.set('channelPairingRequests', requests)
  secureStoreFile()
}
