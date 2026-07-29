// 消息渠道接入领域模型（SPEC-034）。
// 把 IM 渠道（飞书/Discord/Telegram…）作为「第 3 种 surface」接入：外部消息驱动
// 现有 ChatManager.sendTurn()，agent 的 AgentEvent 流再渲染回渠道。
// OneBot v12 在此仅作「内部消息段数据契约」——不依赖 onebots 运行时，不对外暴露服务端端口。

/** OneBot v12 风格的消息段（内部统一表示，与平台无关）。 */
export type OneBotSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file_id?: string; url?: string; path?: string } }
  | { type: 'mention'; data: { user_id: string } }
  | { type: 'reply'; data: { message_id: string } }
  | { type: 'file'; data: { file_id?: string; path?: string } }
  | { type: 'voice'; data: { file_id?: string; path?: string } }
  | { type: 'video'; data: { file_id?: string; path?: string } }

/** 支持接入的平台。WhatsApp 仅允许在官方政策与公网 webhook 条件满足时启用。 */
export type ChannelPlatform = 'feishu' | 'wechat' | 'wecom' | 'telegram' | 'whatsapp' | 'discord' | 'qq'

/** 渠道会话类型：私聊 / 群聊。 */
export type ChannelChatType = 'private' | 'group'

/** 渠道账号连接状态。 */
export type ChannelAccountStatus = 'disconnected' | 'connecting' | 'online' | 'error'

/** 传输层与真实 agent 回合分层健康度，避免把“WebSocket 在线”误报成“机器人可用”。 */
export interface ChannelAccountHealth {
  transportConnectedAt?: string
  lastInboundAt?: string
  lastOutboundAt?: string
  lastTurnCompletedAt?: string
  lastErrorAt?: string
}

/** 一个已配置的渠道账号（如一个飞书机器人应用）。 */
export interface ChannelAccount {
  id: string
  platform: ChannelPlatform
  alias: string
  enabled: boolean
  /** 平台凭证，按 platform 分支：feishu → app_id/app_secret；wechat → bot_id/token/base_url；存于 electron-store。 */
  credentials: Record<string, string>
  status?: ChannelAccountStatus
  error?: string
  /** 可安全下发渲染端的脱敏凭证标识（例如 cli_xx…1234）。 */
  credentialHint?: string
  health?: ChannelAccountHealth
}

/** 一个外部会话（私聊/群）与一个 Conversation 的持久绑定，保证多轮连续。 */
export interface ChannelBinding {
  platform: ChannelPlatform
  accountId: string
  chatType: ChannelChatType
  /** 飞书 chat_id / 群 id / DM 对端 user_id。 */
  chatId: string
  /** 当前活跃的 Conversation id。 */
  conversationId: string
  /** 当前活跃 agent（CLI toolId）。 */
  toolId: string
  /** 绑定的工作目录。 */
  workspacePath: string
  /**
   * 各 CLI 的持久会话映射（toolId → conversationId）。
   * /use <agent> 切换时查此表复用已有会话，不存在则建新会话并写入。
   * 向后兼容：字段缺失时退化为仅 conversationId。
   */
  sessions?: Record<string, string>
}

/** 渠道访问控制。缺少 mode 的存量数据按 legacy-open 迁移展示。 */
export interface ChannelAcl {
  mode?: 'owner' | 'allowlist' | 'open'
  ownerId?: string
  allowlist: string[]
}

/** 未知私聊用户申请成为账号 owner；原消息在批准前不得进入 agent。 */
export interface ChannelPairingRequest {
  id: string
  accountId: string
  platform: ChannelPlatform
  userId: string
  userName?: string
  /** 原始私聊会话；审批完成后只用于回传结果，不用于重放原请求。 */
  chatId: string
  code: string
  createdAt: string
  expiresAt: string
}

/** Conversation/WorkbenchSession 上标注渠道归属的字段。 */
export interface ChannelBindingRef {
  platform: ChannelPlatform
  accountId: string
  chatType: ChannelChatType
  chatId: string
}

/** 新增渠道账号入参。 */
export interface AddChannelAccountInput {
  platform: ChannelPlatform
  alias: string
  credentials: Record<string, string>
  enabled?: boolean
}

/** 扫码建应用：二维码就绪事件（主控 → 渲染端展示）。 */
export interface ChannelScanQr {
  url: string
  expireIn: number
  platform?: ChannelPlatform
}
/** 扫码过程中平台要求输入手机端数字验证码。 */
export interface ChannelScanVerification {
  platform: ChannelPlatform
  prompt: string
}
/** 扫码建应用：结果事件（成功带 accountId/alias；失败带 error）。 */
export interface ChannelScanResult {
  ok: boolean
  accountId?: string
  alias?: string
  error?: string
  platform?: ChannelPlatform
}

/** 渠道会话来源标记：desktop=桌面 UI 驱动；channel=IM 渠道驱动。 */
export type ConversationSource = 'desktop' | 'channel' | 'task'
