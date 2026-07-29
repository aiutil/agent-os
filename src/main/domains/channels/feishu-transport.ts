// SPEC-034 消息渠道 —— 飞书传输（Path A：官方 @larksuiteoapi/node-sdk 长连接）。
// 选 Path A 而非 onebots 内嵌的原因：onebots App 构造有副作用（patch stdout、~/.onebots
// 数据目录、node:sqlite），v1 单平台内嵌不够干净；官方 SDK 专为飞书、长连接原生、Node 22 兼容。
// ChannelTransport 抽象保证 Step 3 批量接入时其他平台仍可用 onebots 适配器或各自 SDK。
// 注：真实连接需用户在「设置→消息网关」填入飞书自建应用的 app_id/app_secret（见 SPEC §7）。

import * as lark from '@larksuiteoapi/node-sdk'
import type {
  ChannelAccount,
  ChannelAccountStatus,
  OneBotSegment
} from '@shared/types'
import {
  splitTextByLength,
  type ChannelTransport,
  type InboundChannelMessage,
  type OnboardingCallbacks
} from './transport'
import {
  filenameFromContentDisposition,
  materializeAttachments,
  nodeStreamToLimitedBuffer,
  type AttachmentCandidate,
  type MaterializedAttachments
} from './attachments'

interface AccountSession {
  client: InstanceType<typeof lark.Client>
  ws: InstanceType<typeof lark.WSClient>
  seenMessageIds: Set<string>
  connectionTimer: NodeJS.Timeout | null
  ready: boolean
}

/** OpenClaw 等成熟实现也把飞书纯文本安全分片设为 4000，给平台封装留出余量。 */
const FEISHU_TEXT_LIMIT = 4_000
export const FEISHU_CONNECTION_DEADLINE_MS = 30_000

export function splitFeishuText(text: string): string[] {
  return splitTextByLength(text, FEISHU_TEXT_LIMIT)
}

function fitFeishuPreview(text: string): string {
  if (text.length <= FEISHU_TEXT_LIMIT) return text
  const [first = ''] = splitTextByLength(text, FEISHU_TEXT_LIMIT - 1)
  return `${first}…`
}

/** 飞书 message_type → OneBot 段；媒体保留 file key，稍后用 messageResource API 鉴权下载。 */
export function feishuContentToSegments(messageType: string, content: string): OneBotSegment[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return [{ type: 'text', data: { text: String(content ?? '') } }]
  }
  const obj = (parsed ?? {}) as Record<string, unknown>
  if (messageType === 'text' && typeof obj.text === 'string') {
    return [{ type: 'text', data: { text: obj.text } }]
  }
  if (messageType === 'post') {
    // post 富文本：title + {tag: text} 列表，平铺成文本。
    const lines: string[] = []
    const media: OneBotSegment[] = []
    const title = (obj as { title?: unknown }).title
    if (typeof title === 'string' && title) lines.push(title)
    const locale = (obj as { content?: Record<string, unknown[]> }).content
    const blocks = locale ? Object.values(locale) : []
    for (const block of blocks) {
      if (!Array.isArray(block)) continue
      for (const node of block) {
        const tag = (node as { tag?: string }).tag
        const text = (node as { text?: string }).text
        if (tag === 'text' && typeof text === 'string') lines.push(text)
        else if (tag === 'at') {
          const name = (node as { user_name?: string }).user_name
          lines.push(name ? `@${name}` : '@user')
        } else if (tag === 'img') {
          const imageKey = (node as { image_key?: string }).image_key
          if (imageKey) media.push({ type: 'image', data: { file_id: imageKey } })
        }
      }
    }
    return [...(lines.length ? [{ type: 'text' as const, data: { text: lines.join(' ') } }] : []), ...media]
  }
  if (messageType === 'image' && typeof obj.image_key === 'string') {
    return [{ type: 'image', data: { file_id: obj.image_key } }]
  }
  if (messageType === 'file' && typeof obj.file_key === 'string') {
    return [{ type: 'file', data: { file_id: obj.file_key } }]
  }
  if (messageType === 'audio' && typeof obj.file_key === 'string') {
    return [{ type: 'voice', data: { file_id: obj.file_key } }]
  }
  if (messageType === 'media' && typeof obj.file_key === 'string') {
    return [{ type: 'video', data: { file_id: obj.file_key } }]
  }
  // 表情包、合并转发等官方资源接口不支持的类型，保留可见提示。
  return [{ type: 'text', data: { text: `[${messageType}]` } }]
}

/** 参考OpenClaw/Hermes：飞书机器人收发消息所需的权限范围（扫码时一次性申请）。 */
const FEISHU_SCOPES = [
  'im:message',
  'im:message:send_as_bot',
  'im:message.p2p_msg:readonly',
  'im:message.group_at_msg:readonly',
  'im:chat',
  'contact:user.id:readonly'
]

export class FeishuTransport implements ChannelTransport {
  private readonly sessions = new Map<string, AccountSession>()
  private messageCb: ((msg: InboundChannelMessage) => void | Promise<void>) | null = null
  private statusCb:
    | ((accountId: string, status: ChannelAccountStatus, error?: string) => void)
    | null = null

  onMessage(cb: (msg: InboundChannelMessage) => void | Promise<void>): void {
    this.messageCb = cb
  }

  onStatus(cb: (accountId: string, status: ChannelAccountStatus, error?: string) => void): void {
    this.statusCb = cb
  }

  private clearConnectionDeadline(
    accountId: string,
    ws: InstanceType<typeof lark.WSClient>
  ): AccountSession | null {
    const session = this.sessions.get(accountId)
    if (!session || session.ws !== ws) return null
    if (session.connectionTimer) clearTimeout(session.connectionTimer)
    session.connectionTimer = null
    return session
  }

  private releaseSession(accountId: string, ws: InstanceType<typeof lark.WSClient>): boolean {
    const session = this.clearConnectionDeadline(accountId, ws)
    if (!session) return false
    this.sessions.delete(accountId)
    try {
      ws.close({ force: true })
    } catch {
      /* SDK 清理失败也不能保留一个可被幂等 start 误认的旧 session。 */
    }
    return true
  }

  private failSession(
    accountId: string,
    ws: InstanceType<typeof lark.WSClient>,
    error: string
  ): void {
    if (this.releaseSession(accountId, ws)) this.statusCb?.(accountId, 'error', error)
  }

  private armConnectionDeadline(
    accountId: string,
    ws: InstanceType<typeof lark.WSClient>,
    error: string
  ): void {
    const session = this.clearConnectionDeadline(accountId, ws)
    if (!session) return
    session.ready = false
    session.connectionTimer = setTimeout(() => {
      const current = this.sessions.get(accountId)
      if (!current || current.ws !== ws || current.ready) return
      this.failSession(accountId, ws, error)
    }, FEISHU_CONNECTION_DEADLINE_MS)
    session.connectionTimer.unref?.()
  }

  /** 扫码一键创建飞书自建应用：registerApp（RFC 8628）→ 返回 appId/appSecret，无需手填。
   *  附带：一次性申请收发消息权限（参考OpenClaw/Hermes 的 scope 集）+ 订阅 im.message.receive_v1。
   *  注：飞书要求在后台把「事件与回调 → 订阅方式」选为「使用长连接接收事件」并发布版本，
   *  WSClient 才会真正收到消息——这一步目前需用户在后台开启（registerApp 仅建应用壳）。 */
  async startOnboarding(callbacks: OnboardingCallbacks): Promise<{
    appId: string
    appSecret: string
    userOpenId?: string
  }> {
    const result = await lark.registerApp({
      appPreset: { name: 'AgentOS' },
      addons: {
        scopes: { tenant: FEISHU_SCOPES },
        events: { items: { tenant: ['im.message.receive_v1'] } }
      },
      onQRCodeReady: (info) => callbacks.onQrCode({ url: info.url, expireIn: info.expireIn }),
      ...(callbacks.onStatus
        ? { onStatusChange: (info) => callbacks.onStatus?.({ status: info.status }) }
        : {}),
      signal: callbacks.signal
    })
    return {
      appId: result.client_id,
      appSecret: result.client_secret,
      userOpenId: result.user_info?.open_id
    }
  }

  async start(account: ChannelAccount): Promise<void> {
    if (this.sessions.has(account.id)) return
    const appId = account.credentials.app_id
    const appSecret = account.credentials.app_secret
    if (!appId || !appSecret) {
      throw new Error('缺少 app_id / app_secret')
    }
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) throw new Error('飞书 App ID 格式无效')
    const client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild
    })
    const seenMessageIds = new Set<string>()
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        const msg = data?.message
        const sender = data?.sender
        if (!msg) return
        if (!msg.message_id) throw new Error('飞书消息缺少 message_id，已拒绝确认')
        if (seenMessageIds.has(msg.message_id)) return
        const chatType = msg.chat_type === 'p2p' ? 'private' : 'group'
        const segments = feishuContentToSegments(msg.message_type, msg.content)
        let text = segments
          .filter((s): s is Extract<OneBotSegment, { type: 'text' }> => s.type === 'text')
          .map((s) => s.data.text)
          .join('')
        for (const mention of msg.mentions ?? []) {
          if (mention.key) text = text.replaceAll(mention.key, '').trim()
        }
        const mentioned =
          chatType === 'private' ? true : (msg.mentions?.length ?? 0) > 0
        const inbound: InboundChannelMessage = {
          deliveryId: msg.message_id,
          accountId: account.id,
          platform: 'feishu',
          chatType,
          chatId: msg.chat_id,
          userId: sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? 'unknown',
          mentioned,
          segments,
          text,
          resumeContext: {
            message: {
              message_id: msg.message_id,
              message_type: msg.message_type,
              content: msg.content
            }
          },
          raw: data
        }
        await this.messageCb?.(inbound)
        seenMessageIds.add(msg.message_id)
        if (seenMessageIds.size > 1_000) {
          const oldest = seenMessageIds.values().next().value
          if (oldest) seenMessageIds.delete(oldest)
        }
      }
    })
    const ws = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      handshakeTimeoutMs: 15_000,
      onReady: () => {
        const session = this.clearConnectionDeadline(account.id, ws)
        if (!session) return
        session.ready = true
        this.statusCb?.(account.id, 'online')
      },
      onError: (error) => {
        this.failSession(account.id, ws, error.message)
      },
      onReconnecting: () => {
        if (this.sessions.get(account.id)?.ws === ws) {
          this.statusCb?.(account.id, 'connecting', '飞书长连接正在重连')
          this.armConnectionDeadline(
            account.id,
            ws,
            '飞书长连接 30 秒内未恢复。请检查网络和飞书应用发布状态，然后点击“重新连接”。'
          )
        }
      },
      onReconnected: () => {
        const session = this.clearConnectionDeadline(account.id, ws)
        if (!session) return
        session.ready = true
        this.statusCb?.(account.id, 'online')
      }
    })
    this.sessions.set(account.id, { client, ws, seenMessageIds, connectionTimer: null, ready: false })
    this.statusCb?.(account.id, 'connecting')
    this.armConnectionDeadline(
      account.id,
      ws,
      '飞书长连接 30 秒内未就绪。请在飞书开放平台启用长连接、订阅 im.message.receive_v1 并发布应用版本，然后点击“重新连接”。'
    )
    // start() 只启动连接/重连循环并立即返回，不能把其 Promise resolve 当成“在线”。
    // 真实握手状态只由 onReady / onReconnected / onError 回调推进。
    try {
      await ws.start({ eventDispatcher: dispatcher })
    } catch (error) {
      this.releaseSession(account.id, ws)
      throw error
    }
  }

  async stop(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session) return
    if (this.releaseSession(accountId, session.ws)) this.statusCb?.(accountId, 'disconnected')
  }

  async send(input: {
    accountId: string
    chatType: 'private' | 'group'
    chatId: string
    segments: OneBotSegment[]
    streaming?: boolean
  }): Promise<{ messageId?: string }> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`飞书账号 ${input.accountId} 未连接`)
    // v1：把段拼接成纯文本发送（富文本/图片 Step 2）。
    const text = input.segments
      .filter((s): s is Extract<OneBotSegment, { type: 'text' }> => s.type === 'text')
      .map((s) => s.data.text)
      .join('')
    if (!text.trim()) return {}
    const chunks = input.streaming ? [fitFeishuPreview(text)] : splitFeishuText(text)
    let firstMessageId: string | undefined
    for (const chunk of chunks) {
      const res = await session.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: input.chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk })
        }
      })
      firstMessageId ??= (res as { data?: { message_id?: string } }).data?.message_id
    }
    return firstMessageId ? { messageId: firstMessageId } : {}
  }

  /**
   * 单气泡流式更新（Hermes 式）：用 im.message.update 覆盖已发送文本消息的完整内容。
   * 全程一个气泡、默认文本样式（无卡片白底/边框），节流由上层负责（飞书 ~5QPS）。
   */
  async updateMessage(input: {
    accountId: string
    chatType: 'private' | 'group'
    chatId: string
    messageId: string
    content: string
    final?: boolean
  }): Promise<void> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`飞书账号 ${input.accountId} 未连接`)
    const chunks = input.final ? splitFeishuText(input.content) : [fitFeishuPreview(input.content)]
    const [first = '', ...continuations] = chunks
    await session.client.im.message.update({
      path: { message_id: input.messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: first }) }
    })
    if (input.final) {
      for (const chunk of continuations) {
        await session.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: input.chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk })
          }
        })
      }
    }
  }

  canUpdate(accountId: string): boolean {
    return this.sessions.has(accountId)
  }

  async materializeInboundAttachments(message: InboundChannelMessage): Promise<MaterializedAttachments | null> {
    const session = this.sessions.get(message.accountId)
    if (!session) throw new Error(`飞书账号 ${message.accountId} 未连接`)
    const raw = (message.raw ?? message.resumeContext) as { message?: { message_id?: string; message_type?: string; content?: string } } | undefined
    const source = raw?.message
    if (!source?.message_id) throw new Error('飞书事件缺少 message_id，无法下载消息资源')
    let content: Record<string, unknown> = {}
    try {
      content = JSON.parse(source.content || '{}') as Record<string, unknown>
    } catch {
      content = {}
    }
    const candidates: AttachmentCandidate[] = []
    for (const segment of message.segments) {
      if (segment.type !== 'image' && segment.type !== 'file' && segment.type !== 'voice' && segment.type !== 'video') continue
      const fileKey = segment.data.file_id
      if (!fileKey) continue
      const kind = segment.type
      const resourceType = kind === 'image' ? 'image' : 'file'
      const sourceFilename = typeof content.file_name === 'string' ? content.file_name : undefined
      candidates.push({
        kind,
        filename: sourceFilename,
        load: async (maxBytes) => {
          const resource = await session.client.im.messageResource.get({
            params: { type: resourceType },
            path: { message_id: source.message_id!, file_key: fileKey }
          })
          const headers = resource.headers as Record<string, unknown>
          const declared = Number(headers['content-length'] ?? headers['Content-Length'])
          if (Number.isFinite(declared) && declared > maxBytes) throw new Error('飞书附件超过允许大小')
          const contentType = headers['content-type'] ?? headers['Content-Type']
          const disposition = headers['content-disposition'] ?? headers['Content-Disposition']
          return {
            buffer: await nodeStreamToLimitedBuffer(resource.getReadableStream(), maxBytes),
            filename: sourceFilename || filenameFromContentDisposition(disposition),
            mimeType: typeof contentType === 'string' ? contentType : undefined
          }
        }
      })
    }
    return materializeAttachments(candidates)
  }

  /** 取用户展示名（contact.user.get，open_id）。失败/未授权返回 null，不抛错。 */
  async getUserDisplayName(accountId: string, userId: string): Promise<string | null> {
    const session = this.sessions.get(accountId)
    if (!session || !userId || userId === 'unknown') return null
    try {
      const res = await session.client.contact.user.get({
        params: { user_id_type: 'open_id' },
        path: { user_id: userId }
      })
      const name = (res as { data?: { user?: { name?: string } } }).data?.user?.name
      return typeof name === 'string' && name.trim() ? name.trim() : null
    } catch {
      return null
    }
  }
}
