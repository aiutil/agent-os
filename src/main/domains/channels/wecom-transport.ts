// SPEC-034：微信（企业微信）官方智能机器人 WebSocket transport。

import AiBot, { generateReqId } from '@wecom/aibot-node-sdk'
import type { BaseMessage, WsFrame } from '@wecom/aibot-node-sdk'
import type { ChannelAccount, ChannelAccountStatus, OneBotSegment } from '@shared/types'
import { splitTextByUtf8Bytes, type ChannelTransport, type InboundChannelMessage } from './transport'
import {
  materializeAttachments,
  type AttachmentCandidate,
  type MaterializedAttachments
} from './attachments'

interface WeComSession {
  client: InstanceType<typeof AiBot.WSClient>
  latestFrames: Map<string, WsFrame<BaseMessage>>
  streams: Map<string, WsFrame<BaseMessage>>
  seenMessageIds: Set<string>
}

const WECOM_STREAM_LIMIT_BYTES = 20_480

function fitWeComText(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= WECOM_STREAM_LIMIT_BYTES) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= WECOM_STREAM_LIMIT_BYTES - 24) low = mid
    else high = mid - 1
  }
  return `${text.slice(0, low)}\n\n…（内容已截断）`
}

export function splitWeComText(text: string): string[] {
  return splitTextByUtf8Bytes(text, WECOM_STREAM_LIMIT_BYTES)
}

function textFromSegments(segments: OneBotSegment[]): string {
  return segments
    .filter((segment): segment is Extract<OneBotSegment, { type: 'text' }> => segment.type === 'text')
    .map((segment) => segment.data.text)
    .join('')
}

export function wecomFrameToInbound(accountId: string, frame: WsFrame<BaseMessage>): InboundChannelMessage | null {
  const body = frame.body
  if (!body?.from?.userid || !body.msgid) return null
  const chatType = body.chattype === 'group' ? 'group' : 'private'
  const chatId = body.chatid || body.from.userid
  const segments: OneBotSegment[] = []
  if (body.msgtype === 'text' && body.text?.content) {
    segments.push({ type: 'text', data: { text: body.text.content } })
  } else if (body.msgtype === 'mixed' && body.mixed?.msg_item) {
    for (const item of body.mixed.msg_item) {
      if (item.msgtype === 'text' && item.text?.content) {
        segments.push({ type: 'text', data: { text: item.text.content } })
      } else if (item.msgtype === 'image' && item.image?.url) {
        segments.push({ type: 'image', data: { url: item.image.url } })
      }
    }
  } else if (body.msgtype === 'voice' && body.voice?.content) {
    segments.push({ type: 'text', data: { text: body.voice.content } })
  } else if (body.msgtype === 'image' && body.image?.url) {
    segments.push({ type: 'image', data: { url: body.image.url } })
  } else if (body.msgtype === 'file' && body.file?.url) {
    segments.push({ type: 'file', data: { path: body.file.url } })
  } else if (body.msgtype === 'video' && body.video?.url) {
    segments.push({ type: 'video', data: { path: body.video.url } })
  }
  const text = textFromSegments(segments)
  return {
    deliveryId: body.msgid,
    accountId,
    platform: 'wecom',
    chatType,
    chatId,
    userId: body.from.userid,
    mentioned: true,
    segments,
    text,
    resumeContext: { frame },
    raw: frame
  }
}

export class WeComTransport implements ChannelTransport {
  private readonly sessions = new Map<string, WeComSession>()
  private messageCb: ((msg: InboundChannelMessage) => void | Promise<void>) | null = null
  private statusCb: ((accountId: string, status: ChannelAccountStatus, error?: string) => void) | null = null

  onMessage(cb: (msg: InboundChannelMessage) => void | Promise<void>): void {
    this.messageCb = cb
  }

  onStatus(cb: (accountId: string, status: ChannelAccountStatus, error?: string) => void): void {
    this.statusCb = cb
  }

  async start(account: ChannelAccount): Promise<void> {
    if (this.sessions.has(account.id)) return
    const botId = account.credentials.bot_id
    const secret = account.credentials.secret
    if (!botId || !secret) throw new Error('缺少企业微信 Bot ID / Secret')
    const client = new AiBot.WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 5
    })
    const session: WeComSession = {
      client,
      latestFrames: new Map(),
      streams: new Map(),
      seenMessageIds: new Set()
    }
    this.sessions.set(account.id, session)
    client.on('authenticated', () => this.statusCb?.(account.id, 'online'))
    client.on('reconnecting', (attempt) => this.statusCb?.(account.id, 'connecting', `正在第 ${attempt} 次重连`))
    client.on('disconnected', (reason) => this.statusCb?.(account.id, 'connecting', reason))
    client.on('error', (error) => this.statusCb?.(account.id, 'error', error.message))
    client.on('message', (frame) => {
      void this.handleFrame(account.id, session, frame).catch((error: unknown) => {
        this.statusCb?.(account.id, 'error', error instanceof Error ? error.message : String(error))
      })
    })
    this.statusCb?.(account.id, 'connecting')
    client.connect()
  }

  async stop(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session) return
    session.client.disconnect()
    this.sessions.delete(accountId)
    this.statusCb?.(accountId, 'disconnected')
  }

  canUpdate(accountId: string): boolean {
    return this.sessions.get(accountId)?.client.isConnected ?? false
  }

  restoreInboundContext(message: InboundChannelMessage): void {
    const session = this.sessions.get(message.accountId)
    const context = message.resumeContext as { frame?: WsFrame<BaseMessage> } | undefined
    if (session && context?.frame?.body) session.latestFrames.set(message.chatId, context.frame)
  }

  async send(input: Parameters<ChannelTransport['send']>[0]): Promise<{ messageId?: string }> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`企业微信账号 ${input.accountId} 未连接`)
    const text = textFromSegments(input.segments)
    if (!text.trim()) return {}
    if (input.streaming) {
      const frame = session.latestFrames.get(input.chatId)
      if (!frame) throw new Error('企业微信回调上下文已失效，请重新发送一条消息')
      const streamId = generateReqId('agentos')
      await session.client.replyStream(frame, streamId, fitWeComText(text), false)
      session.streams.set(streamId, frame)
      return { messageId: streamId }
    }
    for (const content of splitWeComText(text)) {
      await session.client.sendMessage(input.chatId, {
        msgtype: 'markdown',
        markdown: { content }
      })
    }
    return {}
  }

  async updateMessage(input: Parameters<NonNullable<ChannelTransport['updateMessage']>>[0]): Promise<void> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`企业微信账号 ${input.accountId} 未连接`)
    const frame = session.streams.get(input.messageId)
    if (!frame) throw new Error('企业微信流式回复上下文已失效')
    const chunks = input.final ? splitWeComText(input.content) : [fitWeComText(input.content)]
    const [first = '', ...continuations] = chunks
    await session.client.replyStreamNonBlocking(
      frame,
      input.messageId,
      first,
      input.final ?? false
    )
    if (input.final) {
      for (const content of continuations) {
        await session.client.sendMessage(input.chatId, {
          msgtype: 'markdown',
          markdown: { content }
        })
      }
      session.streams.delete(input.messageId)
    }
  }

  async materializeInboundAttachments(message: InboundChannelMessage): Promise<MaterializedAttachments | null> {
    const session = this.sessions.get(message.accountId)
    if (!session) throw new Error(`企业微信账号 ${message.accountId} 未连接`)
    const context = message.resumeContext as { frame?: WsFrame<BaseMessage> } | undefined
    const frame = (message.raw as WsFrame<BaseMessage> | undefined) ?? context?.frame
    const body = frame?.body
    if (!body) return null
    const candidates: AttachmentCandidate[] = []
    const add = (kind: AttachmentCandidate['kind'], url?: string, aeskey?: string): void => {
      if (!url) return
      candidates.push({
        kind,
        load: async () => {
          // 官方 SDK 同时完成下载和每条消息独立 aeskey 解密，不能用普通 fetch 代替。
          const result = await session.client.downloadFile(url, aeskey)
          return { buffer: result.buffer, filename: result.filename }
        }
      })
    }
    if (body.msgtype === 'mixed') {
      for (const item of body.mixed?.msg_item ?? []) {
        if (item.msgtype === 'image') add('image', item.image?.url, item.image?.aeskey)
      }
    } else if (body.msgtype === 'image') {
      add('image', body.image?.url, body.image?.aeskey)
    } else if (body.msgtype === 'file') {
      add('file', body.file?.url, body.file?.aeskey)
    } else if (body.msgtype === 'video') {
      add('video', body.video?.url, body.video?.aeskey)
    }
    return materializeAttachments(candidates)
  }

  private async handleFrame(accountId: string, session: WeComSession, frame: WsFrame<BaseMessage>): Promise<void> {
    const inbound = wecomFrameToInbound(accountId, frame)
    if (!inbound) return
    const messageId = frame.body?.msgid
    if (!messageId) return
    if (session.seenMessageIds.has(messageId)) return
    session.latestFrames.set(inbound.chatId, frame)
    await this.messageCb?.(inbound)
    session.seenMessageIds.add(messageId)
    if (session.seenMessageIds.size > 1_000) {
      const oldest = session.seenMessageIds.values().next().value
      if (oldest) session.seenMessageIds.delete(oldest)
    }
  }
}
