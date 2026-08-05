// 工作台会话领域模型（SPEC-005/017）。
// WorkbenchSession 是「持久化的会话元数据」，与「实时 PTY」解耦：
// 一个 WorkbenchSession 可关联当前活跃的 terminalSessionId，断开后仍保留元数据以便后续 resume。
// SPEC-017：WorkbenchSession 现在是 Conversation 的视图投影，toolId/nativeSessionId 来自末段。

import type { TerminalRunStatus } from './terminal'
import type { PermissionPreset } from './agent-event'
import type { ChannelBindingRef, ConversationSource } from './channels'
import type { ReferencedMemory } from './memory'
import type { TurnContextPack } from './memory'

// ─── Conversation / Segment（SPEC-017）────────────────────────────────────

/** 会话的一个 CLI 段落。每次切换 CLI 新增一段。 */
export interface ConversationSegment {
  id: string
  toolId: string
  nativeSessionId: string | null
  startedAt: string
  endedAt: string | null
  /** 本段由交接文档开启时，文档写入的路径。 */
  handoffDocPath?: string
}

/** 逻辑会话，包含一或多个 CLI 段落（SPEC-017）。 */
export interface Conversation {
  id: string
  name: string
  /**
   * SPEC-035：name 是否为系统占位/模板名（如「未命名会话」「对比 · X」「飞书 私聊」）。
   * true=允许被首条真实人类消息派生的标题自动覆盖；false/缺省=已是真实标题或用户手改，不再自动覆盖。
   * 缺省时由 isProvisionalSessionName 按模板正则兜底判定（兼容旧记录）。
   */
  nameProvisional?: boolean
  workspacePath: string
  favorite: boolean
  /** 会话置顶，优先显示在各类列表顶部。 */
  pinned?: boolean
  segments: ConversationSegment[]
  /** fork 预留字段。 */
  parentConversationId?: string
  forkPoint?: { segmentId: string; seq: number }
  createdAt: string
  updatedAt: string
  /** 归档时间；存在时不出现在工作台常规列表，数据本身仍保留。 */
  archivedAt?: string
  /** 会话级模型覆盖（用户在新建时选择）；为空时由 CLI/provider 默认解析。 */
  model?: string
  /** 会话级原生思考级别/模型变体覆盖；为空时由 CLI 自行解析。 */
  reasoningEffort?: string
  /** SPEC-017 v2：本会话由另一会话接力创建时的来源。 */
  relaySource?: SessionRelayRef
  /** SPEC-017 v2：本会话已接力出去时的目标。 */
  relayTarget?: SessionRelayRef
  /** 接力链的原始标题，用于避免标题后缀层层堆叠。 */
  rootTitle?: string
  // 运行时字段（不持久化），迁移兼容用
  terminalSessionId?: string | null
  surface?: 'terminal' | 'chat'
  permissionPreset?: PermissionPreset
  /** undefined 代表继承全局 Memory Vault 策略。 */
  memoryUse?: boolean
  /** undefined 代表继承全局 Memory Vault 策略。 */
  memoryGenerate?: boolean
  /** SPEC-034：渠道驱动来源标记；undefined=desktop（兼容旧记录）。 */
  source?: ConversationSource
  /** SPEC-034：渠道绑定（platform/account/chatType/chatId）。 */
  channelBinding?: ChannelBindingRef
}

/** switchCli 状态机。 */
export type HandoffStatus = 'generating' | 'ready' | 'starting' | 'done' | 'failed'

/** previewHandoff 响应。 */
export interface HandoffPreview {
  handoffMd: string
}

// ─── Relay（SPEC-017 v2）────────────────────────────────────────────────

export interface SessionRelayRef {
  linkId: string
  sessionId: string
  toolId: string
  title: string
  contextPackPath?: string | null
}

export type RelayTargetAvailability =
  | 'available'
  | 'unavailable'
  | 'not-installed'
  | 'not-authenticated'

export interface RelayTarget {
  toolId: string
  displayName: string
  availability: RelayTargetAvailability
  /** 目标运行位置。缺省或 local 表示本机；远程节点由联邦 runtime 填充。 */
  runtimeHostId?: string
  /** 目标 CLI 版本或远程节点提供的副标题，用于接力选择器展示。 */
  version?: string
  reason?: string
  lastUsedAt?: string
}

export interface StartRelayPayload {
  sourceSessionId: string
  sourceSurface: 'chat' | 'cli' | 'history'
  targetToolId: string
  /** 接力目标运行位置。缺省走本机；远程节点传 node id。 */
  targetRuntimeHostId?: string
  /** 接力目标模型。空/缺省表示使用目标 CLI 或 provider 默认模型。 */
  targetModel?: string
}

export interface StartRelayResult {
  targetSessionId: string
  relayLinkId: string
}

export interface RelayContextReport {
  linkId: string
  markdown: string
  contextPackPath: string | null
}

// ─── WorkbenchSession（保持兼容，派生自 Conversation 末段）──────────────

export interface WorkbenchSession {
  /** 稳定的会话 id（持久化），不随 PTY 重启变化。 */
  id: string
  /** 用户命名，如 "SPEC-005 工作台首功能"。 */
  name: string
  /** 驱动的 CLI 适配器 id（末段 toolId）。 */
  toolId: string
  /** 工作目录（PATH）。 */
  workspacePath: string
  /** 当前关联的实时 PTY sessionId（无活跃 PTY 时为 null）。 */
  terminalSessionId: string | null
  /** CLI 原生会话 id；用于跨应用重启恢复上下文（末段 nativeSessionId）。 */
  nativeSessionId: string | null
  /** 当前工作台镜头。旧会话迁移为 terminal。 */
  surface: 'terminal' | 'chat'
  /** SPEC-020：明确的会话模式；旧记录由 surface 幂等迁移。 */
  mode?: 'cli' | 'chat'
  /** 对话镜头的会话级权限预设。 */
  permissionPreset: PermissionPreset
  /** false 时此会话绝不自动注入长期记忆；undefined 继承全局策略。 */
  memoryUse?: boolean
  /** false 时此会话完成后不进入自动提炼队列；undefined 继承全局策略。 */
  memoryGenerate?: boolean
  /** 会话级模型覆盖；为空时由 CLI/provider 默认解析。 */
  model?: string
  /** 会话级原生思考级别/模型变体覆盖。 */
  reasoningEffort?: string
  /** SPEC-017 v2：本会话由另一会话接力创建时的来源。 */
  relaySource?: SessionRelayRef
  /** SPEC-017 v2：本会话已接力出去时的目标。 */
  relayTarget?: SessionRelayRef
  /** 接力链的原始标题，用于避免标题后缀层层堆叠。 */
  rootTitle?: string
  /** 收藏标记。 */
  favorite: boolean
  /** 会话置顶，优先显示在各类列表顶部。 */
  pinned: boolean
  /** SPEC-035：name 是否为占位/模板名（允许被首条真实意图自动覆盖）；缺省按模板正则兜底判定。 */
  nameProvisional?: boolean
  /** 运行所在的 runtime 主机 id（'local' 或远程节点 id）；联邦层填充，UI 据此标注来源。 */
  runtimeHostId?: string
  /** SPEC-034：渠道驱动来源；undefined=desktop。 */
  source?: ConversationSource
  /** SPEC-034：渠道绑定（派生自末段或渠道建会话时写入）。 */
  channelBinding?: ChannelBindingRef
  /** 所有 CLI 段落（SPEC-017，单段会话只有 1 个元素；旧记录兼容为 []）。 */
  segments?: ConversationSegment[]
  /** SPEC-020：托管聊天历史，作为 daemon 重启后的连续性来源。 */
  chatHistory?: ManagedChatMessage[]
  /** 从聊天会话显式打开的关联 CLI 会话。 */
  linkedSessionId?: string | null
  createdAt: string
  updatedAt: string
  /** 归档时间；存在时不出现在工作台常规列表，数据本身仍保留。 */
  archivedAt?: string
}

/** 切换 CLI 入参（SPEC-017）。 */
export interface SwitchCliInput {
  conversationId: string
  targetToolId: string
  /** 用户编辑后的交接文档（空则用生成版本）。 */
  editedHandoffMd?: string
}

/** 新建会话入参（来自新建会话 Modal）。 */
export interface CreateSessionInput {
  name: string
  /** SPEC-035：name 是否为系统占位/模板名（对比广播、渠道、空白新建传 true，便于后续被真实意图覆盖）。 */
  nameProvisional?: boolean
  toolId: string
  workspacePath: string
  surface?: 'terminal' | 'chat'
  permissionPreset?: PermissionPreset
  memoryUse?: boolean
  memoryGenerate?: boolean
  /** 可选：指定 CLI 启动时使用的模型 id（覆盖 provider 默认）。 */
  model?: string
  /** 可选：指定 Agent 原生思考级别/模型变体。 */
  reasoningEffort?: string
  /** SPEC-017 v2：创建接力目标会话时写入来源关系。 */
  relaySource?: SessionRelayRef
  /** SPEC-017 v2：创建来源会话副本时保留去向关系。 */
  relayTarget?: SessionRelayRef
  /** 接力链原始标题。 */
  rootTitle?: string
  /** 可选：指定在哪个 runtime 主机上运行（'local' 或远程节点 id）；缺省走本机。 */
  runtimeHostId?: string
  /** SPEC-034：渠道驱动来源；'channel'=IM 渠道创建的会话。 */
  source?: ConversationSource
  /** SPEC-034：渠道绑定（渠道建会话时写入，便于回灌与归属）。 */
  channelBinding?: ChannelBindingRef
}

/** 会话元数据可更新字段。 */
export interface UpdateSessionPatch {
  name?: string
  /** SPEC-035：标记 name 是否为占位/模板名。自动重命名成功写 false；用户手改名也应写 false（定稿）。 */
  nameProvisional?: boolean
  /** 会话级模型覆盖；空串/undefined 表示清除覆盖，回退 provider 默认。 */
  model?: string
  /** 会话级原生思考级别；空串/undefined 表示清除覆盖。 */
  reasoningEffort?: string
  relaySource?: SessionRelayRef | null
  relayTarget?: SessionRelayRef | null
  rootTitle?: string | null
  favorite?: boolean
  pinned?: boolean
  surface?: 'terminal' | 'chat'
  permissionPreset?: PermissionPreset
  memoryUse?: boolean
  memoryGenerate?: boolean
  /** true 归档，false 恢复；仅影响工作台列表可见性。 */
  archived?: boolean
}

export type ManagedChatMessageStatus = 'streaming' | 'completed' | 'interrupted' | 'failed'

export interface ManagedChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  status: ManagedChatMessageStatus
  createdAt: string
  updatedAt: string
  /**
   * 本回合注入到 prompt 的长期记忆引用（仅 assistant 消息）。只读展示，
   * 让用户知道"参考了哪些记忆"；不影响对话内容。
   */
  referencedMemories?: ReferencedMemory[]
}

export type ManagedChatTimelineItemType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'error'
  | 'permission'

export type ManagedChatPermissionStatus = 'pending' | 'allowed-once' | 'allowed-always' | 'denied'

export interface ManagedChatTimelineItem {
  id: string
  sessionId: string
  turnId: string
  seq: number
  type: ManagedChatTimelineItemType
  tool?: string
  toolUseId?: string
  content?: string
  input?: unknown
  output?: string
  isError?: boolean
  status?: ManagedChatPermissionStatus
  createdAt: string
}

export interface ManagedQueuedTurn {
  id: string
  sessionId: string
  text: string
  files: string[]
  /** 生成于入队时的 controller 上下文快照；正文仍只保存原始用户任务。 */
  contextPack?: TurnContextPack
  status: 'queued'
  createdAt: string
  updatedAt: string
}

export interface RuntimeSessionFileV2 {
  schemaVersion: 2
  sessions: WorkbenchSession[]
}

export type SessionContinuityState = 'binding' | 'ready' | 'unsupported' | 'missing'

export interface SessionContinuity {
  state: SessionContinuityState
  reason?: string
}

export type SessionResumeErrorCode = 'NO_NATIVE_ID' | 'RESUME_UNSUPPORTED' | 'RESUME_FAILED'

/**
 * Rail 视图模型：会话元数据 + 实时状态合并。
 * 渲染端用它渲染会话卡（状态点颜色由 status 决定）。
 * segments 暴露给 ChatPane 用于多段时间线（SPEC-017）。
 */
export interface WorkbenchSessionView extends WorkbenchSession {
  status: TerminalRunStatus | 'resumable'
  outputTail: string
  lastActivityAt: string
  continuity: SessionContinuity
}

/** 会话按项目（工作目录）分组的视图。 */
export interface SessionProjectGroup {
  /** 远程运行节点；本机项目不设置。 */
  runtimeHostId?: string
  /** 工作目录绝对路径。 */
  workspacePath: string
  /** PATH basename，作为分组标题。 */
  projectName: string
  sessions: WorkbenchSessionView[]
}
