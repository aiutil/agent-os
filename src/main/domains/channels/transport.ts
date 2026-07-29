// SPEC-034 消息渠道 —— 平台传输抽象层。
// 把 onebots 适配器 / 平台官方 SDK 的差异收敛到这一层；上层 ChannelManager / router /
// renderer 只与 OneBot v12 段打交道，不感知具体平台。
//   Path B：onebots App + @onebots/adapter-feishu 实现本接口（飞书长连接）。
//   Path A：@larksuiteoapi/node-sdk 实现本接口（飞书长连接，Node 20/22 兼容降级）。

import type {
  ChannelAccount,
  ChannelAccountStatus,
  ChannelChatType,
  ChannelPlatform,
  OneBotSegment
} from '@shared/types'
import type { MaterializedAttachments } from './attachments'

/** 入站渠道消息，已归一为 OneBot v12 段（与平台无关）。 */
export interface InboundChannelMessage {
  /** 平台稳定消息/事件 id；与 platform + accountId 组成跨重启幂等键。 */
  deliveryId: string
  accountId: string
  platform: ChannelPlatform
  chatType: ChannelChatType
  chatId: string
  userId: string
  userName?: string
  /** 群聊里是否被 @机器人（仅 group 有意义；私聊恒为 true 语义）。 */
  mentioned?: boolean
  segments: OneBotSegment[]
  /** 纯文本快捷抽取（所有 text 段拼接）。 */
  text: string
  /** 原始平台事件，调试用。 */
  raw?: unknown
  /** 重启后继续回复/下载附件所需的最小平台上下文；只进入 0600 inbox，不对渲染端暴露。 */
  resumeContext?: unknown
}

/** 扫码一键创建应用的回调（飞书 registerApp，RFC 8628）。signal 用于取消。 */
export interface OnboardingCallbacks {
  signal: AbortSignal
  onQrCode(info: { url: string; expireIn: number }): void
  onStatus?(info: { status: string }): void
  /** 某些官方扫码流程会要求输入手机端显示的数字验证码。 */
  requestVerificationCode?(prompt: string): Promise<string>
}

export interface OnboardingResult {
  appId: string
  appSecret: string
  userOpenId?: string
  /** 平台特有且必须随账号持久化的附加凭证。 */
  extraCredentials?: Record<string, string>
  alias?: string
}

/** 平台传输接口：每个平台一份实现（feishu / discord / ...）。 */
export interface ChannelTransport {
  /** 启动某账号的长连接，开始接收消息。重复 start 同一账号应是幂等的。 */
  start(account: ChannelAccount): Promise<void>
  /** 停止某账号的连接。 */
  stop(accountId: string): Promise<void>
  /** 向某会话发送消息段；返回该消息 id（跟随气泡需要，平台不支持时可不返回）。 */
  send(input: {
    accountId: string
    chatType: ChannelChatType
    chatId: string
    segments: OneBotSegment[]
    /** true 表示这是可更新回合的首个占位消息。 */
    streaming?: boolean
  }): Promise<{ messageId?: string }>
  /** 订阅入站消息（ChannelManager 注册一次）。 */
  /** Promise resolve 表示上层已 durable enqueue，此前 transport 不得 ACK/推进游标。 */
  onMessage(cb: (msg: InboundChannelMessage) => void | Promise<void>): void
  /** 订阅账号连接状态变化（ChannelManager 注册一次）。 */
  onStatus(cb: (accountId: string, status: ChannelAccountStatus, error?: string) => void): void
  /** 扫码一键创建应用（飞书 registerApp，RFC 8628）。平台不支持则缺省——UI 据此决定是否展示扫码入口。 */
  startOnboarding?(callbacks: OnboardingCallbacks, platform?: ChannelPlatform): Promise<OnboardingResult>
  /**
   * 单气泡流式更新（Hermes 式）：更新已发送的文本消息内容，全程一个气泡、默认样式。
   * 平台用 im.message.update（text）实现；不支持文本更新的平台可不实现，上层降级为多条文本。
   * 注意飞书限流 ~5QPS，上层需节流（≥200ms）。
   */
  updateMessage?(input: {
    accountId: string
    chatType: ChannelChatType
    chatId: string
    /** 要更新的机器人消息 id。 */
    messageId: string
    /** 覆盖后的完整文本。 */
    content: string
    /** true 表示该消息已进入成功/失败/取消/超时终态。 */
    final?: boolean
  }): Promise<void>
  /** 多 transport 场景按账号判断是否支持更新，避免用接口方法存在性误判具体平台。 */
  canUpdate?(accountId: string): boolean
  /**
   * 取用户展示名（欢迎语个性化用）。平台不支持或取不到时返回 null，上层用兜底称呼。
   */
  getUserDisplayName?(accountId: string, userId: string): Promise<string | null>
  /** 把当前入站消息中的平台资源鉴权下载为受限临时文件；cleanup 由 ChannelManager 在回合终态调用。 */
  materializeInboundAttachments?(message: InboundChannelMessage): Promise<MaterializedAttachments | null>
  /** durable inbox 重放前恢复平台临时回复上下文（如微信 context_token、企业微信 frame）。 */
  restoreInboundContext?(message: InboundChannelMessage): void | Promise<void>
}

/** 把 OneBot v12 段数组里的 text 段拼成纯文本（路由/命令解析用）。 */
export function segmentsToText(segments: OneBotSegment[]): string {
  return segments
    .filter((s): s is Extract<OneBotSegment, { type: 'text' }> => s.type === 'text')
    .map((s) => s.data.text)
    .join('')
}

function preferredSplitAt(text: string, hardLimit: number): number {
  const floor = Math.floor(hardLimit * 0.6)
  const newline = text.lastIndexOf('\n', hardLimit - 1)
  const space = text.lastIndexOf(' ', hardLimit - 1)
  let splitAt = newline >= floor ? newline + 1 : space >= floor ? space + 1 : hardLimit
  const before = text.charCodeAt(splitAt - 1)
  const after = text.charCodeAt(splitAt)
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) splitAt -= 1
  return Math.max(1, splitAt)
}

/** 按 UTF-16 code unit 上限完整分片，优先在换行/空格处分界。 */
export function splitTextByLength(text: string, maxLength: number): string[] {
  if (!text) return []
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('maxLength 必须是正整数')
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const splitAt = preferredSplitAt(remaining, maxLength)
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** 按 UTF-8 字节上限完整分片，适配企业微信等以 payload bytes 计限的平台。 */
export function splitTextByUtf8Bytes(text: string, maxBytes: number): string[] {
  if (!text) return []
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('maxBytes 必须是不小于 4 的整数')
  const chunks: string[] = []
  let remaining = text
  while (Buffer.byteLength(remaining, 'utf8') > maxBytes) {
    let low = 1
    let high = remaining.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(remaining.slice(0, mid), 'utf8') <= maxBytes) low = mid
      else high = mid - 1
    }
    const splitAt = preferredSplitAt(remaining, low)
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt)
  }
  if (remaining) chunks.push(remaining)
  return chunks
}
