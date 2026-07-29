// SPEC-034：WhatsApp Business Platform / Cloud API 官方 transport。
// 入站必须经用户提供的公网 HTTPS 反向代理/隧道到本机监听端口；不使用个人号逆向协议。

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ChannelAccount, ChannelAccountStatus, OneBotSegment } from '@shared/types'
import { splitTextByLength, type ChannelTransport, type InboundChannelMessage } from './transport'
import {
  materializeAttachments,
  responseToLimitedBuffer,
  type AttachmentCandidate,
  type MaterializedAttachments
} from './attachments'

const DEFAULT_GRAPH_VERSION = 'v23.0'
const MAX_WEBHOOK_BYTES = 1_048_576
const WHATSAPP_TEXT_LIMIT = 4_096

interface WhatsAppSession {
  accountId: string
  phoneNumberId: string
  accessToken: string
  appSecret: string
  verifyToken: string
  graphVersion: string
  publicWebhookUrl: URL
  server: Server
  abort: AbortController
  seenMessageIds: Set<string>
  contactNames: Map<string, string>
}

interface WhatsAppWebhookValue {
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>
  messages?: Array<{
    id?: string
    from?: string
    type?: string
    text?: { body?: string }
    image?: { id?: string; caption?: string }
    audio?: { id?: string }
    video?: { id?: string; caption?: string }
    document?: { id?: string; filename?: string; caption?: string }
    context?: { id?: string }
  }>
}

interface WhatsAppMediaMetadata {
  id?: string
  url?: string
  mime_type?: string
  file_size?: number
}

function textFromSegments(segments: OneBotSegment[]): string {
  return segments
    .filter((segment): segment is Extract<OneBotSegment, { type: 'text' }> => segment.type === 'text')
    .map((segment) => segment.data.text)
    .join('')
}

export function splitWhatsAppText(text: string): string[] {
  return splitTextByLength(text, WHATSAPP_TEXT_LIMIT)
}

/** Meta 的 X-Hub-Signature-256：HMAC-SHA256(app secret, raw body)，必须常量时间比较。 */
export function verifyWhatsAppSignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

/** 把官方 webhook messages payload 展平为统一入站消息。 */
export function whatsappPayloadToInbound(accountId: string, payload: unknown): InboundChannelMessage[] {
  const result: InboundChannelMessage[] = []
  if (!payload || typeof payload !== 'object') return result
  const entries = (payload as { entry?: unknown }).entry
  if (!Array.isArray(entries)) return result
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const changes = (entry as { changes?: unknown }).changes
    if (!Array.isArray(changes)) continue
    for (const change of changes) {
      const value = (change as { value?: WhatsAppWebhookValue } | null)?.value
      if (!value) continue
      const names = new Map(
        (value.contacts ?? [])
          .filter((contact): contact is { wa_id: string; profile?: { name?: string } } => Boolean(contact.wa_id))
          .map((contact) => [contact.wa_id, contact.profile?.name ?? ''])
      )
      for (const message of value.messages ?? []) {
        if (!message.id || !message.from) continue
        const segments: OneBotSegment[] = []
        if (message.context?.id) segments.push({ type: 'reply', data: { message_id: message.context.id } })
        if (message.type === 'text' && message.text?.body) {
          segments.push({ type: 'text', data: { text: message.text.body } })
        } else if (message.type === 'image' && message.image?.id) {
          segments.push({ type: 'image', data: { file_id: message.image.id } })
          if (message.image.caption) segments.push({ type: 'text', data: { text: message.image.caption } })
        } else if (message.type === 'audio' && message.audio?.id) {
          segments.push({ type: 'voice', data: { file_id: message.audio.id } })
        } else if (message.type === 'video' && message.video?.id) {
          segments.push({ type: 'video', data: { file_id: message.video.id } })
          if (message.video.caption) segments.push({ type: 'text', data: { text: message.video.caption } })
        } else if (message.type === 'document' && message.document?.id) {
          segments.push({ type: 'file', data: { file_id: message.document.id } })
          const documentText = message.document.caption || message.document.filename
          if (documentText) segments.push({ type: 'text', data: { text: documentText } })
        } else {
          segments.push({ type: 'text', data: { text: `[WhatsApp ${message.type || 'unsupported'} message]` } })
        }
        result.push({
          deliveryId: message.id,
          accountId,
          platform: 'whatsapp',
          chatType: 'private',
          chatId: message.from,
          userId: message.from,
          userName: names.get(message.from) || undefined,
          mentioned: true,
          segments,
          text: textFromSegments(segments),
          resumeContext: { message },
          raw: message
        })
      }
    }
  }
  return result
}

export class WhatsAppTransport implements ChannelTransport {
  private readonly sessions = new Map<string, WhatsAppSession>()
  private readonly lifecycleTasks = new Map<string, Promise<void>>()
  private messageCb: ((msg: InboundChannelMessage) => void | Promise<void>) | null = null
  private statusCb: ((accountId: string, status: ChannelAccountStatus, error?: string) => void) | null = null

  onMessage(cb: (msg: InboundChannelMessage) => void | Promise<void>): void {
    this.messageCb = cb
  }

  onStatus(cb: (accountId: string, status: ChannelAccountStatus, error?: string) => void): void {
    this.statusCb = cb
  }

  async start(account: ChannelAccount): Promise<void> {
    await this.runLifecycle(account.id, async () => this.startNow(account))
  }

  private async startNow(account: ChannelAccount): Promise<void> {
    if (this.sessions.has(account.id)) return
    const phoneNumberId = account.credentials.phone_number_id
    const accessToken = account.credentials.access_token
    const appSecret = account.credentials.app_secret
    const verifyToken = account.credentials.verify_token
    const publicWebhookRaw = account.credentials.public_webhook_url
    const policyBasis = account.credentials.policy_basis
    if (account.credentials.policy_confirmed !== 'true') {
      throw new Error('启用 WhatsApp 前必须确认适用的官方政策依据')
    }
    if (policyBasis !== 'eea_brazil' && policyBasis !== 'ancillary_business') {
      throw new Error('WhatsApp 政策依据必须是已确认适用 EEA/巴西监管临时措施的 WABA，或 AI 非主要功能的附属业务用途')
    }
    if (!phoneNumberId || !accessToken || !appSecret || !verifyToken || !publicWebhookRaw) {
      throw new Error('缺少 WhatsApp Phone Number ID / Access Token / App Secret / Verify Token / Webhook URL')
    }
    const publicWebhookUrl = new URL(publicWebhookRaw)
    if (publicWebhookUrl.protocol !== 'https:' || publicWebhookUrl.username || publicWebhookUrl.password) {
      throw new Error('WhatsApp webhook 必须是无内嵌凭证的公网 HTTPS URL')
    }
    const port = Number(account.credentials.webhook_port)
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
      throw new Error('WhatsApp 本地 webhook 端口必须在 1024-65535 之间')
    }
    const graphVersion = account.credentials.graph_version || DEFAULT_GRAPH_VERSION
    if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error('WhatsApp Graph API 版本格式无效')

    this.statusCb?.(account.id, 'connecting')
    const server = createServer((request, response) => void this.handleWebhook(account.id, request, response))
    const session: WhatsAppSession = {
      accountId: account.id,
      phoneNumberId,
      accessToken,
      appSecret,
      verifyToken,
      graphVersion,
      publicWebhookUrl,
      server,
      abort: new AbortController(),
      seenMessageIds: new Set(),
      contactNames: new Map()
    }
    this.sessions.set(account.id, session)
    try {
      await this.verifyCloudApi(session)
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError)
          resolve()
        })
      })
      await this.probePublicWebhook(session)
      this.statusCb?.(account.id, 'online')
    } catch (error) {
      this.sessions.delete(account.id)
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      this.statusCb?.(account.id, 'error', message)
      throw error
    }
  }

  async stop(accountId: string): Promise<void> {
    // start 可能仍在 Cloud API / 公网回探；先打断网络，再按账号串行清理监听器。
    this.sessions.get(accountId)?.abort.abort()
    await this.runLifecycle(accountId, async () => this.stopNow(accountId))
  }

  private async stopNow(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session) return
    session.abort.abort()
    this.sessions.delete(accountId)
    await new Promise<void>((resolve) => session.server.close(() => resolve()))
    this.statusCb?.(accountId, 'disconnected')
  }

  async send(input: Parameters<ChannelTransport['send']>[0]): Promise<{ messageId?: string }> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`WhatsApp 账号 ${input.accountId} 未连接`)
    const text = textFromSegments(input.segments)
    if (!text.trim()) return {}
    let firstMessageId: string | undefined
    for (const body of splitWhatsAppText(text)) {
      const payload = await this.graphRequest<{ messages?: Array<{ id?: string }> }>(session, 'POST', 'messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.chatId,
        type: 'text',
        text: { body, preview_url: false }
      })
      firstMessageId ??= payload.messages?.[0]?.id
    }
    return { messageId: firstMessageId }
  }

  canUpdate(): boolean {
    return false
  }

  getUserDisplayName(accountId: string, userId: string): Promise<string | null> {
    return Promise.resolve(this.sessions.get(accountId)?.contactNames.get(userId) ?? null)
  }

  async materializeInboundAttachments(message: InboundChannelMessage): Promise<MaterializedAttachments | null> {
    const session = this.sessions.get(message.accountId)
    if (!session) throw new Error(`WhatsApp 账号 ${message.accountId} 未连接`)
    const context = message.resumeContext as { message?: NonNullable<WhatsAppWebhookValue['messages']>[number] } | undefined
    const raw = (message.raw as NonNullable<WhatsAppWebhookValue['messages']>[number] | undefined) ?? context?.message
    if (!raw) return null
    let kind: AttachmentCandidate['kind'] | undefined
    let mediaId: string | undefined
    let filename: string | undefined
    if (raw.type === 'image') {
      kind = 'image'
      mediaId = raw.image?.id
    } else if (raw.type === 'audio') {
      kind = 'voice'
      mediaId = raw.audio?.id
    } else if (raw.type === 'video') {
      kind = 'video'
      mediaId = raw.video?.id
    } else if (raw.type === 'document') {
      kind = 'file'
      mediaId = raw.document?.id
      filename = raw.document?.filename
    }
    if (!kind || !mediaId) return null
    const candidate: AttachmentCandidate = {
      kind,
      filename,
      load: async (maxBytes) => {
        const metadata = await this.graphObjectRequest<WhatsAppMediaMetadata>(session, mediaId)
        if (!metadata.url) throw new Error('WhatsApp media object 未返回下载 URL')
        if (metadata.file_size !== undefined && metadata.file_size > maxBytes) {
          throw new Error('WhatsApp 附件超过允许大小')
        }
        const downloadUrl = new URL(metadata.url)
        if (downloadUrl.protocol !== 'https:' || downloadUrl.username || downloadUrl.password) {
          throw new Error('WhatsApp media object 返回了不安全的下载 URL')
        }
        const response = await fetch(downloadUrl, {
          headers: { authorization: `Bearer ${session.accessToken}` },
          redirect: 'error',
          signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(30_000)])
        })
        return {
          buffer: await responseToLimitedBuffer(response, maxBytes),
          filename,
          mimeType: metadata.mime_type || response.headers.get('content-type') || undefined
        }
      }
    }
    return materializeAttachments([candidate])
  }

  private async handleWebhook(accountId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session) return this.respond(response, 503, 'not ready')
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
    if (requestUrl.pathname !== session.publicWebhookUrl.pathname) return this.respond(response, 404, 'not found')
    if (request.method === 'GET') {
      const mode = requestUrl.searchParams.get('hub.mode')
      const token = requestUrl.searchParams.get('hub.verify_token')
      const challenge = requestUrl.searchParams.get('hub.challenge')
      return mode === 'subscribe' && token === session.verifyToken && challenge
        ? this.respond(response, 200, challenge)
        : this.respond(response, 403, 'forbidden')
    }
    if (request.method !== 'POST') return this.respond(response, 405, 'method not allowed')
    try {
      const rawBody = await this.readBody(request)
      const signature = Array.isArray(request.headers['x-hub-signature-256'])
        ? request.headers['x-hub-signature-256'][0]
        : request.headers['x-hub-signature-256']
      if (!verifyWhatsAppSignature(rawBody, signature, session.appSecret)) {
        return this.respond(response, 401, 'invalid signature')
      }
      const payload = JSON.parse(rawBody.toString('utf8')) as unknown
      const inboundMessages = whatsappPayloadToInbound(accountId, payload)
      for (const inbound of inboundMessages) {
        const rawId = (inbound.raw as { id?: string } | undefined)?.id
        if (!rawId || session.seenMessageIds.has(rawId)) continue
        if (inbound.userName) session.contactNames.set(inbound.userId, inbound.userName)
        await this.messageCb?.(inbound)
        session.seenMessageIds.add(rawId)
        if (session.seenMessageIds.size > 1_000) {
          const oldest = session.seenMessageIds.values().next().value
          if (oldest) session.seenMessageIds.delete(oldest)
        }
      }
      this.respond(response, 200, 'ok')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.statusCb?.(accountId, 'error', `WhatsApp webhook: ${message}`)
      if (!response.headersSent) this.respond(response, 400, 'bad request')
    }
  }

  private async verifyCloudApi(session: WhatsAppSession): Promise<void> {
    await this.graphRequest(session, 'GET', '?fields=display_phone_number,verified_name')
  }

  private async probePublicWebhook(session: WhatsAppSession): Promise<void> {
    const probeUrl = new URL(session.publicWebhookUrl)
    const challenge = `agent-os-${Date.now()}`
    probeUrl.searchParams.set('hub.mode', 'subscribe')
    probeUrl.searchParams.set('hub.verify_token', session.verifyToken)
    probeUrl.searchParams.set('hub.challenge', challenge)
    const response = await fetch(probeUrl, {
      redirect: 'error',
      signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(10_000)])
    })
    const body = await response.text()
    if (!response.ok || body !== challenge) {
      throw new Error(`公网 webhook 自检失败（HTTP ${response.status}）；请确认 HTTPS 反向代理已转发到本地监听端口`)
    }
  }

  private async graphRequest<T = unknown>(
    session: WhatsAppSession,
    method: 'GET' | 'POST',
    suffix: string,
    body?: unknown
  ): Promise<T> {
    return this.graphObjectRequest(session, session.phoneNumberId, suffix, method, body)
  }

  private async graphObjectRequest<T = unknown>(
    session: WhatsAppSession,
    objectId: string,
    suffix = '',
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
  ): Promise<T> {
    const encodedObjectId = encodeURIComponent(objectId)
    const response = await fetch(
      `https://graph.facebook.com/${session.graphVersion}/${encodedObjectId}${suffix.startsWith('?') ? suffix : suffix ? `/${suffix}` : ''}`,
      {
        method,
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(15_000)])
      }
    )
    const text = await response.text()
    let payload: unknown = {}
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { error: { message: text } }
    }
    if (!response.ok) {
      const message = (payload as { error?: { message?: string } }).error?.message
      throw new Error(message || `WhatsApp Cloud API 返回 HTTP ${response.status}`)
    }
    return payload as T
  }

  private async runLifecycle(accountId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.lifecycleTasks.get(accountId) ?? Promise.resolve()
    // stop 必须在失败/取消的 start 之后继续清理；同账号后续操作不能与旧监听流程交错。
    const task = previous.catch(() => undefined).then(action)
    this.lifecycleTasks.set(accountId, task)
    try {
      await task
    } finally {
      if (this.lifecycleTasks.get(accountId) === task) this.lifecycleTasks.delete(accountId)
    }
  }

  private readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > MAX_WEBHOOK_BYTES) {
          reject(new Error('payload too large'))
          request.destroy()
          return
        }
        chunks.push(buffer)
      })
      request.on('end', () => resolve(Buffer.concat(chunks)))
      request.on('error', reject)
    })
  }

  private respond(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(body)
  }
}
