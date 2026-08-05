import type { NormalizedTranscript } from './transcript'

export interface MemoryDateRange {
  from?: string
  to?: string
}

export interface MemorySearchInput {
  query: string
  scope?: 'global' | 'session'
  sessionId?: string
  deep?: boolean
  toolIds?: string[]
  workspacePath?: string
  dateRange?: MemoryDateRange
  limit: number
}

export interface MemoryInSessionSearchInput {
  sessionId: string
  query: string
  limit?: number
}

export interface MemorySearchHit {
  sessionId: string
  nativeSessionId: string
  toolId: string
  title: string
  cwd: string | null
  snippetHtml: string
  lastActivityAt: string
  /** 创建时间（仅 agent 会话命中可用；CLI 历史命中无此字段，排序时 fallback 到 lastActivityAt）。SPEC-031。 */
  createdAt?: string
  score: number
  messageCount: number
  /** 命中来源：自建 agent 对话 vs CLI 历史。统一搜索时用于分组与打开策略。 */
  source?: 'agent' | 'cli'
}

export interface MemoryIndexStatus {
  filesTotal: number
  filesIndexed: number
  building: boolean
  optimizing?: boolean
  hotIndexedMessages?: number
  hotTotalMessages?: number
  failedFiles: Array<{ path: string; reason: string }>
}

export interface MemoryTranscriptMeta {
  sessionId: string
  nativeSessionId: string
  toolId: string
  cwd: string | null
  title: string
  startedAt: string | null
  lastActivityAt: string
  parseErrors: number
  messageCount: number
}

export interface MemoryTranscriptPageInput {
  sessionId: string
  cursor?: number
  limit?: number
  direction?: 'latest' | 'before' | 'after'
}

export interface MemoryTranscriptPage {
  meta: MemoryTranscriptMeta
  messages: NormalizedTranscript['messages']
  hasMoreBefore: boolean
  hasMoreAfter: boolean
}

export interface IndexedFileState {
  path: string
  byteOffset: number
  mtime: number
  size: number
  status: 'indexed' | 'failed'
  error: string | null
}

export interface ExperienceEntry {
  id: string
  title: string
  contentMd: string
  sourceSessionId?: string
  toolId?: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

export type CreateExperienceInput = Omit<
  ExperienceEntry,
  'id' | 'createdAt' | 'updatedAt'
>

export type UpdateExperiencePatch = Partial<
  Pick<ExperienceEntry, 'title' | 'contentMd' | 'tags'>
>

/**
 * 长期记忆与会话历史分离：历史是可回溯证据，只有确认后的条目才会进入 agent 上下文。
 * `knowledge` 用于无损迁移原经验库中的自由文本条目。
 */
export type MemoryKind =
  | 'preference'
  | 'convention'
  | 'decision'
  | 'fact'
  | 'procedure'
  | 'pitfall'
  | 'knowledge'

export type MemoryScope = 'user' | 'project' | 'repo' | 'path' | 'agent'
export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'archived'
export type MemoryConfidence = 'confirmed' | 'inferred'
export type MemorySensitivity = 'normal' | 'private'
export type MemoryEvidenceSource = 'session' | 'file' | 'manual' | 'agent'
export type MemoryFeedbackOutcome = 'useful' | 'stale' | 'wrong'
/** 记忆的认知类别，和原有 kind（内容形态）正交。 */
export type MemoryClass = 'identity' | 'semantic' | 'episodic' | 'procedural'
/** turn/session 只用于工作态；Vault 中可注入条目均为 durable。 */
export type MemoryLifetime = 'turn' | 'session' | 'durable'

export interface MemoryEvidence {
  sourceType: MemoryEvidenceSource
  sourceId: string
}

export interface DurableMemory {
  id: string
  kind: MemoryKind
  title: string
  content: string
  scope: MemoryScope
  scopeRef?: string
  status: MemoryStatus
  confidence: MemoryConfidence
  sensitivity: MemorySensitivity
  tags: string[]
  evidence: MemoryEvidence[]
  pinned: boolean
  createdAt: string
  updatedAt: string
  expiresAt?: string
  rejectionReason?: string
  /** SPEC-045：和 kind 解耦的认知类别；旧数据在打开 Vault 时惰性迁移。 */
  memoryClass?: MemoryClass
  lifetime?: 'durable'
  /** 迁移前已存在的条目，仅用于审阅标识，绝不改变正文。 */
  legacy?: boolean
  lastAccessedAt?: string
  accessCount?: number
  validFrom?: string
  validUntil?: string
}

export interface ListDurableMemoriesInput {
  query?: string
  statuses?: MemoryStatus[]
  scopes?: MemoryScope[]
  /** 按标签筛选（命中任一即返回），如 ['feishu'] 看飞书渠道记忆。 */
  tags?: string[]
  limit?: number
}

export interface ProposeMemoryInput {
  kind: MemoryKind
  title: string
  content: string
  scope: MemoryScope
  scopeRef?: string
  confidence?: MemoryConfidence
  sensitivity?: MemorySensitivity
  tags?: string[]
  evidence?: MemoryEvidence[]
}

export interface UpdateDurableMemoryPatch {
  kind?: MemoryKind
  title?: string
  content?: string
  scope?: MemoryScope
  scopeRef?: string | null
  confidence?: MemoryConfidence
  sensitivity?: MemorySensitivity
  tags?: string[]
  pinned?: boolean
  expiresAt?: string | null
  memoryClass?: MemoryClass
  validUntil?: string | null
}

export interface MemoryFeedbackInput {
  memoryId: string
  outcome: MemoryFeedbackOutcome
  agentId?: string
}

export interface WorkingMemoryState {
  sessionId: string
  goal?: string
  constraints: string[]
  decisions: string[]
  openQuestions: string[]
  artifacts: string[]
  updatedAt: string
  expiresAt: string
}

export interface UpdateWorkingMemoryInput {
  sessionId: string
  goal?: string | null
  constraints?: string[]
  decisions?: string[]
  openQuestions?: string[]
  artifacts?: string[]
}

export interface MemorySettings {
  enabled: boolean
  useMemories: boolean
  generateMemories: boolean
  /** 允许使用共享提炼 CLI 把会话生成 Markdown 知识草稿；默认开启。 */
  knowledgeCurationEnabled: boolean
  /** 默认拒绝包含 Web/MCP 等外部上下文的会话自动提炼。 */
  allowExternalContext: boolean
  /** 留空时由系统自动挑选一个支持隔离 headless 提炼的 CLI（优先 isolated 能力）。 */
  curatorAgentId?: string
  /** 为提炼单独指定模型；未设置时才回退到对应 CLI 的 Provider 默认模型。 */
  curatorModel?: string
  contextTokenBudget: number
  /** 记忆候选的用户可编辑提炼策略；修改只影响后续提炼。 */
  memoryCurationPrompt: string
  /** Markdown 知识草稿的用户可编辑提炼策略；修改只影响后续提炼。 */
  knowledgeCurationPrompt: string
  /**
   * 旧版记忆提炼字段，仅用于备份和本机设置迁移。
   * @deprecated 使用 memoryCurationPrompt。
   */
  curationInstructions?: string
  /**
   * 自动提炼纪元：generateMemories 首次开启的时间。后台只对该时间点之后仍有
   * 活动的历史会话自动提炼，避免开启瞬间回溯churn 整个会话历史。
   */
  curationEpoch?: string
}

/** 单条会话自动提炼的水位线，用于去重与增量判断（避免反复提炼同一会话）。 */
export interface CurationWatermark {
  sourceId: string
  /** 上次提炼时该会话的索引消息数（best-effort；跨链路可能为 null）。 */
  messageCount: number | null
  lastCuratedAt: string
}

/** 后台提炼候选：来自搜索索引的、已空闲且在纪元之后的会话。 */
export interface CurationCandidate {
  sessionId: string
  toolId: string
  cwd: string | null
  title: string
  messageCount: number
  lastActivityAt: string
}

export interface CurationCandidateInput {
  /** 仅返回 lastActivityAt 早于此刻（即已空闲）的会话。 */
  idleBeforeIso: string
  /** 仅返回 lastActivityAt 不早于此刻（提炼纪元）的会话。 */
  sinceIso: string
  limit: number
}

/** 一轮对话实际注入的记忆引用（回传渲染端做"参考了哪些记忆"提示）。 */
export interface ReferencedMemory {
  id: string
  title: string
  kind: MemoryKind
  scope: MemoryScope
  memoryClass?: MemoryClass
}

/** controller 生成并通过 daemon/远程节点传递的只读上下文快照。 */
export interface TurnContextPack {
  version: 1
  text: string
  referencedMemories: ReferencedMemory[]
  generatedAt: string
  estimatedTokens: number
}

export interface MemoryContextInput {
  cwd: string
  task: string
  agentId?: string
  sessionId?: string
  tokenBudget?: number
}

export interface MemoryContextItem {
  memory: DurableMemory
  estimatedTokens: number
}

export interface MemoryContextPack extends TurnContextPack {
  text: string
  items: MemoryContextItem[]
  tokenBudget: number
  estimatedTokens: number
  truncated: boolean
}

export type GraphEntityType =
  | 'memory'
  | 'persona'
  | 'scope'
  | 'article'
  | 'topic'
  | 'tag'
  | 'source-session'

export type GraphRelation =
  | 'belongs_to'
  | 'evidenced_by'
  | 'supersedes'
  | 'derived_from'
  | 'related_to'
  | 'tagged_with'
  | 'sourced_from'
  | 'follows'
  | 'references'

export interface GraphNode {
  id: string
  type: GraphEntityType
  label: string
  group?: string
  status?: string
  weight: number
  muted?: boolean
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  relation: GraphRelation
  weight?: number
}

export interface GraphSnapshot {
  nodes: GraphNode[]
  edges: GraphEdge[]
  truncated: boolean
}

/** 图谱域共享的查询选项；服务端决定关系，renderer 不自行推断业务连接。 */
export interface GraphQuery {
  relations?: GraphRelation[]
}

export interface MemoryGraphInput extends GraphQuery {
  query?: string
  statuses?: MemoryStatus[]
  scopes?: MemoryScope[]
  includeSources?: boolean
  limit?: number
}

export interface MemoryGatewayCapability {
  agentId: string
  transport: 'mcp' | 'cli' | 'wrapper'
  automaticContext: boolean
  detail: string
}

/**
 * 记忆提炼 Agent 候选：仅返回声明 `supportsIsolatedCuration` 的 CLI，并附带当前发现状态。
 * 供设置弹窗的下拉选择使用，避免在渲染层硬编码 "pi"。
 */
export interface CuratorCandidate {
  toolId: string
  displayName: string
  /** 当前是否已安装可执行。 */
  ready: boolean
  version?: string
  /** 未安装时的修复建议。 */
  installHint?: string
}

export interface CurateMemoryInput {
  /** evidence source id，通常为 toolId:nativeSessionId。 */
  sourceId: string
  cwd: string
  /** 仅允许传入已脱敏的 user/assistant 文本，不传入原始工具输出。 */
  text: string
  hasExternalContext?: boolean
  /**
   * 渠道标记（如 'feishu'）。来自 IM 渠道会话的提炼带上它：
   * 强制 scope='user'（全渠道 agent 共享）并打上该 tag（记忆 UI 可按渠道筛选）。
   */
  channelTag?: string
  /**
   * 提炼时该会话的消息数（best-effort）。成功后写入水位线，供后台增量去重。
   * 来自后台索引候选时为索引消息数；来自实时对话时为对话消息数。
   */
  messageCount?: number
}

export interface MemoryApi {
  search(input: MemorySearchInput): Promise<MemorySearchHit[]>
  searchInSession(input: MemoryInSessionSearchInput): Promise<NormalizedTranscript['messages']>
  getTranscript(sessionId: string): Promise<NormalizedTranscript | null>
  getTranscriptMeta(sessionId: string): Promise<MemoryTranscriptMeta | null>
  getTranscriptPage(input: MemoryTranscriptPageInput): Promise<MemoryTranscriptPage | null>
  indexStatus(): Promise<MemoryIndexStatus>
  listDurable(input?: ListDurableMemoriesInput): Promise<DurableMemory[]>
  /** 按 id 直取单条（详情视图用，避免全量拉取后再 find）。 */
  getDurable(id: string): Promise<DurableMemory | null>
  /** 用户手动新建：直接落 active 并标记 manual 来源。 */
  createManual(input: ProposeMemoryInput): Promise<DurableMemory>
  propose(input: ProposeMemoryInput): Promise<DurableMemory>
  confirm(id: string, patch?: UpdateDurableMemoryPatch): Promise<DurableMemory | null>
  reject(id: string, reason?: string): Promise<DurableMemory | null>
  updateDurable(id: string, patch: UpdateDurableMemoryPatch): Promise<DurableMemory | null>
  forget(id: string): Promise<void>
  feedback(input: MemoryFeedbackInput): Promise<void>
  context(input: MemoryContextInput): Promise<MemoryContextPack>
  graph(input?: MemoryGraphInput): Promise<GraphSnapshot>
  working(sessionId: string): Promise<WorkingMemoryState | null>
  updateWorking(input: UpdateWorkingMemoryInput): Promise<WorkingMemoryState>
  clearWorking(sessionId: string): Promise<void>
  settings(): Promise<MemorySettings>
  updateSettings(patch: Partial<MemorySettings>): Promise<MemorySettings>
  /** 全局用户画像（人格）：单份、手动维护；context() 会作为最高优先级 preamble 注入。 */
  getPersona(): Promise<string>
  updatePersona(text: string): Promise<string>
  curatorCandidates(): Promise<CuratorCandidate[]>
  gatewayCapabilities(): Promise<MemoryGatewayCapability[]>
  curate(input: CurateMemoryInput): Promise<DurableMemory[]>
}
