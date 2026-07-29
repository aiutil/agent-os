// SPEC-034：Telegram 官方 Bot API transport。默认 long polling，桌面端无需公网 webhook。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelAccount, ChannelAccountStatus, OneBotSegment } from '@shared/types'
import { splitTextByLength, type ChannelTransport, type InboundChannelMessage } from './transport'
import {
  materializeAttachments,
  responseToLimitedBuffer,
  type AttachmentCandidate,
  type MaterializedAttachments
} from './attachments'

interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

interface TelegramMessage {
  message_id: number
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' }
  from?: TelegramUser
  text?: string
  caption?: string
  photo?: Array<{ file_id: string; file_size?: number }>
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  voice?: { file_id: string; mime_type?: string; file_size?: number }
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  reply_to_message?: { from?: TelegramUser }
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramFile {
  file_id: string
  file_size?: number
  file_path?: string
}

export function nextTelegramOffset(current: number, updates: Array<Pick<TelegramUpdate, 'update_id'>>): number {
  return updates.reduce((offset, update) => Math.max(offset, update.update_id + 1), current)
}

interface TelegramSession {
  token: string
  abort: AbortController
  offset: number
  bot: TelegramUser
  pollTask: Promise<void> | null
}

const TELEGRAM_TEXT_LIMIT = 4096

function fitTelegramText(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text
  return `${text.slice(0, TELEGRAM_TEXT_LIMIT - 18)}\n\n…（内容已截断）`
}

/** 最终态不可截断丢内容：优先在换行/空格处分片，并避免切断 UTF-16 代理对。 */
export function splitTelegramText(text: string): string[] {
  return splitTextByLength(text, TELEGRAM_TEXT_LIMIT)
}

function textFromSegments(segments: OneBotSegment[]): string {
  return segments
    .filter((segment): segment is Extract<OneBotSegment, { type: 'text' }> => segment.type === 'text')
    .map((segment) => segment.data.text)
    .join('')
}

/** 纯映射函数单独导出，便于验证 Telegram offset 之外的消息语义。 */
export function telegramMessageToInbound(
  accountId: string,
  bot: TelegramUser,
  message: TelegramMessage,
  updateId = `${message.chat.id}:${message.message_id}`
): InboundChannelMessage | null {
  if (!message.from || message.chat.type === 'channel') return null
  const chatType = message.chat.type === 'private' ? 'private' : 'group'
  const botMention = bot.username ? `@${bot.username}` : ''
  const rawText = message.text ?? message.caption ?? ''
  const text = botMention
    ? rawText.replace(new RegExp(`@${bot.username}\\b`, 'gi'), '').trim()
    : rawText.trim()
  const segments: OneBotSegment[] = []
  if (text) segments.push({ type: 'text', data: { text } })
  const photo = message.photo?.at(-1)
  if (photo) segments.push({ type: 'image', data: { file_id: photo.file_id } })
  if (message.document) segments.push({ type: 'file', data: { file_id: message.document.file_id } })
  if (message.voice) segments.push({ type: 'voice', data: { file_id: message.voice.file_id } })
  if (message.video) segments.push({ type: 'video', data: { file_id: message.video.file_id } })
  const mentioned =
    chatType === 'private' ||
    Boolean(botMention && rawText.toLowerCase().includes(botMention.toLowerCase())) ||
    message.reply_to_message?.from?.id === bot.id
  return {
    deliveryId: String(updateId),
    accountId,
    platform: 'telegram',
    chatType,
    chatId: String(message.chat.id),
    userId: String(message.from.id),
    userName: [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') || message.from.username,
    mentioned,
    segments,
    text,
    resumeContext: { message },
    raw: message
  }
}

export class TelegramTransport implements ChannelTransport {
  private readonly sessions = new Map<string, TelegramSession>()
  private readonly persistedOffsets = new Map<string, number>()
  /** 已交付给上层、但必须确认落盘后才允许再启动的最高 offset。 */
  private readonly requiredOffsets = new Map<string, number>()
  private readonly offsetWrites = new Map<string, Promise<void>>()
  private readonly lifecycleTasks = new Map<string, Promise<void>>()
  private messageCb: ((msg: InboundChannelMessage) => void | Promise<void>) | null = null
  private statusCb: ((accountId: string, status: ChannelAccountStatus, error?: string) => void) | null = null

  constructor(
    private readonly requestTimeoutMs = 30_000,
    private readonly stateDir?: string
  ) {}

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
    const token = account.credentials.bot_token
    if (!token) throw new Error('缺少 Telegram Bot Token')
    // 上一次 stop/save 若因磁盘故障失败，必须先补写内存中的最高已交付 offset。
    // 不可因 session 已删除就回退到旧文件位置。
    await this.flushRequiredOffset(account.id)
    this.statusCb?.(account.id, 'connecting')
    const bot = await this.call<TelegramUser>(token, 'getMe', {})
    const session: TelegramSession = {
      token,
      abort: new AbortController(),
      offset: await this.loadOffset(account.id),
      bot,
      pollTask: null
    }
    this.sessions.set(account.id, session)
    this.statusCb?.(account.id, 'online')
    session.pollTask = this.poll(account.id, session)
  }

  async stop(accountId: string): Promise<void> {
    await this.runLifecycle(accountId, async () => this.stopNow(accountId))
  }

  private async stopNow(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session) {
      await this.flushRequiredOffset(accountId)
      return
    }
    session.abort.abort()
    this.sessions.delete(accountId)
    try {
      await session.pollTask
      // poll 可能在内存 offset 已前进、原子写失败后被 stop 中断。
      // stop 只有在最新 offset 真正落盘后才能返回，否则快速重连会重放。
      this.requireOffset(accountId, session.offset)
      await this.flushRequiredOffset(accountId)
    } finally {
      this.statusCb?.(accountId, 'disconnected')
    }
  }

  canUpdate(accountId: string): boolean {
    return this.sessions.has(accountId)
  }

  async send(input: Parameters<ChannelTransport['send']>[0]): Promise<{ messageId?: string }> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`Telegram 账号 ${input.accountId} 未连接`)
    const text = textFromSegments(input.segments)
    if (!text.trim()) return {}
    let firstMessageId: string | undefined
    for (const chunk of splitTelegramText(text)) {
      const message = await this.call<TelegramMessage>(session.token, 'sendMessage', {
        chat_id: input.chatId,
        text: chunk
      })
      firstMessageId ??= String(message.message_id)
    }
    return { messageId: firstMessageId }
  }

  async updateMessage(input: Parameters<NonNullable<ChannelTransport['updateMessage']>>[0]): Promise<void> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`Telegram 账号 ${input.accountId} 未连接`)
    const chunks = input.final ? splitTelegramText(input.content) : [fitTelegramText(input.content)]
    const [first = '', ...continuations] = chunks
    await this.call(session.token, 'editMessageText', {
      chat_id: input.chatId,
      message_id: Number(input.messageId),
      text: first
    })
    for (const chunk of continuations) {
      await this.call(session.token, 'sendMessage', { chat_id: input.chatId, text: chunk })
    }
  }

  async materializeInboundAttachments(message: InboundChannelMessage): Promise<MaterializedAttachments | null> {
    const session = this.sessions.get(message.accountId)
    if (!session) throw new Error(`Telegram 账号 ${message.accountId} 未连接`)
    const context = message.resumeContext as { message?: TelegramMessage } | undefined
    const raw = (message.raw as TelegramMessage | undefined) ?? context?.message
    if (!raw) return null
    const candidates: AttachmentCandidate[] = []
    const photo = raw.photo?.at(-1)
    if (photo) candidates.push(this.fileCandidate(session, 'image', photo.file_id, undefined, 'image/jpeg', photo.file_size))
    if (raw.document) {
      candidates.push(this.fileCandidate(
        session,
        'file',
        raw.document.file_id,
        raw.document.file_name,
        raw.document.mime_type,
        raw.document.file_size
      ))
    }
    if (raw.voice) {
      candidates.push(this.fileCandidate(
        session,
        'voice',
        raw.voice.file_id,
        undefined,
        raw.voice.mime_type || 'audio/ogg',
        raw.voice.file_size
      ))
    }
    if (raw.video) {
      candidates.push(this.fileCandidate(
        session,
        'video',
        raw.video.file_id,
        raw.video.file_name,
        raw.video.mime_type || 'video/mp4',
        raw.video.file_size
      ))
    }
    return materializeAttachments(candidates)
  }

  private fileCandidate(
    session: TelegramSession,
    kind: AttachmentCandidate['kind'],
    fileId: string,
    filename?: string,
    mimeType?: string,
    declaredBytes?: number
  ): AttachmentCandidate {
    return {
      kind,
      filename,
      mimeType,
      declaredBytes,
      load: async (maxBytes) => {
        const file = await this.call<TelegramFile>(session.token, 'getFile', { file_id: fileId })
        if (file.file_size !== undefined && file.file_size > maxBytes) throw new Error('Telegram 附件超过允许大小')
        if (!file.file_path) throw new Error('Telegram getFile 未返回 file_path')
        const safePath = file.file_path.split('/').map(encodeURIComponent).join('/')
        const response = await fetch(`https://api.telegram.org/file/bot${session.token}/${safePath}`, {
          signal: AbortSignal.timeout(30_000)
        })
        return {
          buffer: await responseToLimitedBuffer(response, maxBytes),
          filename: filename || file.file_path.split('/').at(-1),
          mimeType: mimeType || response.headers.get('content-type') || undefined
        }
      }
    }
  }

  private async poll(accountId: string, session: TelegramSession): Promise<void> {
    let failures = 0
    while (!session.abort.signal.aborted && this.sessions.get(accountId) === session) {
      try {
        // 上一轮可能已把 offset 推进到内存，但原子落盘失败。发起下一次网络 poll 前
        // 必须先补写；否则下一轮空结果不会再触发保存，重启后可能重复消费旧 update。
        await this.saveOffset(accountId, session.offset)
        const updates = await this.call<TelegramUpdate[]>(session.token, 'getUpdates', {
          offset: session.offset,
          timeout: 25,
          allowed_updates: ['message']
        }, session.abort.signal, Math.max(this.requestTimeoutMs, 35_000))
        // fetch 通常会因 abort 拒绝，但仍需防御不遵守 signal 的返回或迟到响应。
        if (session.abort.signal.aborted || this.sessions.get(accountId) !== session) return
        const recovered = failures > 0
        failures = 0
        if (recovered) this.statusCb?.(accountId, 'online')
        const acknowledgedOffset = nextTelegramOffset(session.offset, updates)
        for (const update of updates) {
          if (!update.message) continue
          const inbound = telegramMessageToInbound(accountId, session.bot, update.message, String(update.update_id))
          if (inbound) await this.messageCb?.(inbound)
        }
        if (acknowledgedOffset !== session.offset) {
          session.offset = acknowledgedOffset
          this.requireOffset(accountId, acknowledgedOffset)
          await this.saveOffset(accountId, acknowledgedOffset)
        }
      } catch (error) {
        if (session.abort.signal.aborted) return
        failures += 1
        const message = error instanceof Error ? error.message : String(error)
        this.statusCb?.(accountId, failures >= 3 ? 'error' : 'connecting', message)
        await this.waitForRetryDelay(
          Math.min(1_000 * 2 ** (failures - 1), 30_000),
          session.abort.signal
        )
      }
    }
  }

  private async runLifecycle(accountId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.lifecycleTasks.get(accountId) ?? Promise.resolve()
    // 已排队的 start 必须看到前一个 stop/flush 的失败，不能把错误吞掉后继续轮询旧 offset。
    const task = previous.then(action)
    this.lifecycleTasks.set(accountId, task)
    try {
      await task
    } finally {
      if (this.lifecycleTasks.get(accountId) === task) this.lifecycleTasks.delete(accountId)
    }
  }

  private waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(finish, delayMs)
      const onAbort = (): void => finish()
      function finish(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private async call<T = unknown>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: requestSignal
    })
    const payload = (await response.json()) as { ok?: boolean; result?: T; description?: string }
    if (!response.ok || !payload.ok) {
      throw new Error(payload.description || `Telegram API ${method} 返回 HTTP ${response.status}`)
    }
    return payload.result as T
  }

  private offsetPath(accountId: string): string | null {
    if (!this.stateDir) return null
    const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.stateDir, `${safeAccountId}.offset.json`)
  }

  private async loadOffset(accountId: string): Promise<number> {
    const cached = this.persistedOffsets.get(accountId)
    if (cached !== undefined) return cached
    const target = this.offsetPath(accountId)
    if (!target) return 0
    let offset = 0
    try {
      const parsed = JSON.parse(await readFile(target, 'utf8')) as { offset?: unknown }
      if (!Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error('invalid offset')
      offset = Number(parsed.offset)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Telegram offset 状态文件损坏；为避免重复执行，请移除该账号后重新接入')
      }
    }
    this.persistedOffsets.set(accountId, offset)
    return offset
  }

  private async saveOffset(accountId: string, offset: number): Promise<void> {
    const target = this.offsetPath(accountId)
    if (!target || !Number.isSafeInteger(offset) || offset < 0) return
    const previous = this.offsetWrites.get(accountId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      if (offset <= (this.persistedOffsets.get(accountId) ?? 0)) {
        this.clearSatisfiedRequiredOffset(accountId)
        return
      }
      await mkdir(this.stateDir!, { recursive: true, mode: 0o700 })
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ offset }), { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      this.persistedOffsets.set(accountId, offset)
      this.clearSatisfiedRequiredOffset(accountId)
    })
    this.offsetWrites.set(accountId, task)
    try {
      await task
    } finally {
      if (this.offsetWrites.get(accountId) === task) this.offsetWrites.delete(accountId)
    }
  }

  private async waitForOffsetWrite(accountId: string): Promise<void> {
    await this.offsetWrites.get(accountId)
  }

  private requireOffset(accountId: string, offset: number): void {
    if (!this.offsetPath(accountId) || !Number.isSafeInteger(offset) || offset < 0) return
    const current = this.requiredOffsets.get(accountId) ?? 0
    if (offset > current) this.requiredOffsets.set(accountId, offset)
  }

  private clearSatisfiedRequiredOffset(accountId: string): void {
    const required = this.requiredOffsets.get(accountId)
    if (required !== undefined && required <= (this.persistedOffsets.get(accountId) ?? 0)) {
      this.requiredOffsets.delete(accountId)
    }
  }

  private async flushRequiredOffset(accountId: string): Promise<void> {
    await this.waitForOffsetWrite(accountId)
    const required = this.requiredOffsets.get(accountId)
    if (required === undefined) return
    await this.saveOffset(accountId, required)
  }
}
