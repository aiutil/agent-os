// SPEC-034：微信官方 iLink transport。
// 协议依据腾讯微信团队维护的 MIT 包 @tencent-weixin/openclaw-weixin 公布的自有后端 API；
// 这里只实现 Agent OS 的 ChannelTransport，不加载 OpenClaw runtime，也不使用个人号 Hook/逆向协议。

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChannelAccount, ChannelAccountStatus, OneBotSegment } from '@shared/types'
import {
  splitTextByLength,
  type ChannelTransport,
  type InboundChannelMessage,
  type OnboardingCallbacks,
  type OnboardingResult
} from './transport'

const WECHAT_FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WECHAT_TEXT_LIMIT = 4_000
const WECHAT_PROTOCOL_VERSION = '2.4.6'
const WECHAT_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 6)
const WECHAT_POLL_TIMEOUT_MS = 40_000
const WECHAT_API_TIMEOUT_MS = 15_000

interface WeChatMessageItem {
  type?: number
  text_item?: { text?: string }
  voice_item?: { text?: string }
  image_item?: unknown
  file_item?: { file_name?: string }
  video_item?: unknown
}

export interface WeChatMessage {
  message_id?: number
  client_id?: string
  from_user_id?: string
  group_id?: string
  create_time_ms?: number
  item_list?: WeChatMessageItem[]
  context_token?: string
}

interface GetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeChatMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

interface WeChatApiResponse {
  ret?: number
  errcode?: number
  errmsg?: string
}

interface WeChatSession {
  accountId: string
  baseUrl: string
  token: string
  abort: AbortController
  cursor: string
  contextTokens: Map<string, string>
  seenMessageIds: Set<string>
  online: boolean
  pollTask: Promise<void> | null
}

interface QrResponse {
  qrcode?: string
  qrcode_img_content?: string
}

interface QrStatusResponse {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect' | 'need_verifycode' | 'verify_code_blocked' | 'binded_redirect'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

function randomWeChatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

/** bearer token 只能发送到腾讯微信 HTTPS 域名，避免扫码响应被利用为 SSRF/凭证转发。 */
export function validateWeChatBaseUrl(raw: string): string {
  const url = new URL(raw)
  const trusted = url.hostname === 'ilinkai.weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com')
  if (url.protocol !== 'https:' || url.username || url.password || !trusted) {
    throw new Error('微信 iLink 服务地址不是受信任的腾讯 HTTPS 域名')
  }
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function requestJson<T>(input: {
  baseUrl: string
  endpoint: string
  method: 'GET' | 'POST'
  body?: unknown
  token?: string
  signal?: AbortSignal
  timeoutMs: number
}): Promise<T> {
  const baseUrl = validateWeChatBaseUrl(input.baseUrl)
  const url = new URL(input.endpoint, baseUrl)
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const headers: Record<string, string> = {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': WECHAT_CLIENT_VERSION
  }
  if (input.method === 'POST') {
    headers['Content-Type'] = 'application/json'
    headers.AuthorizationType = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = randomWeChatUin()
    if (input.token) headers.Authorization = `Bearer ${input.token}`
  }
  try {
    const response = await fetch(url, {
      method: input.method,
      headers,
      // iLink 的跨地域切换通过签名响应中的 redirect_host 显式完成；HTTP 重定向
      // 不得替代该协议路径，更不能把 bearer token 带到未校验的目标。
      redirect: 'error',
      signal: controller.signal,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) })
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`微信 iLink 请求失败（HTTP ${response.status}）`)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error('微信 iLink 返回了无法解析的数据')
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('aborted'))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function splitWeChatText(text: string): string[] {
  return splitTextByLength(text, WECHAT_TEXT_LIMIT)
}

export function weChatMessageToInbound(accountId: string, message: WeChatMessage): InboundChannelMessage | null {
  const userId = message.from_user_id?.trim()
  // 腾讯插件能力元数据当前只声明 direct chat；v1 不猜测群聊协议语义。
  if (!userId || message.group_id) return null
  const segments: OneBotSegment[] = []
  for (const [index, item] of (message.item_list ?? []).entries()) {
    if (item.type === 1 && item.text_item?.text) {
      segments.push({ type: 'text', data: { text: item.text_item.text } })
    } else if (item.type === 3 && item.voice_item?.text) {
      segments.push({ type: 'text', data: { text: item.voice_item.text } })
    } else if (item.type === 2) {
      segments.push({ type: 'image', data: { file_id: `${message.message_id ?? message.client_id ?? 'message'}:${index}` } })
    } else if (item.type === 4) {
      segments.push({ type: 'file', data: { file_id: `${message.message_id ?? message.client_id ?? 'message'}:${index}` } })
    } else if (item.type === 5) {
      segments.push({ type: 'video', data: { file_id: `${message.message_id ?? message.client_id ?? 'message'}:${index}` } })
    }
  }
  if (!segments.length) return null
  const text = segments
    .filter((segment): segment is Extract<OneBotSegment, { type: 'text' }> => segment.type === 'text')
    .map((segment) => segment.data.text)
    .join('')
  return {
    deliveryId: String(message.message_id ?? message.client_id ?? ''),
    accountId,
    platform: 'wechat',
    chatType: 'private',
    chatId: userId,
    userId,
    mentioned: true,
    segments,
    text,
    resumeContext: message.context_token ? { contextToken: message.context_token } : undefined,
    raw: message
  }
}

export class WeChatTransport implements ChannelTransport {
  private readonly sessions = new Map<string, WeChatSession>()
  private readonly lifecycleTasks = new Map<string, Promise<void>>()
  private readonly cursorWrites = new Map<string, Promise<void>>()
  private readonly persistedCursors = new Map<string, string>()
  private readonly requiredCursors = new Map<string, string>()
  private messageCb: ((message: InboundChannelMessage) => void | Promise<void>) | null = null
  private statusCb: ((accountId: string, status: ChannelAccountStatus, error?: string) => void) | null = null

  constructor(
    private readonly stateDir: string,
    private readonly appVersion = '0.0.0'
  ) {}

  onMessage(cb: (message: InboundChannelMessage) => void | Promise<void>): void {
    this.messageCb = cb
  }

  onStatus(cb: (accountId: string, status: ChannelAccountStatus, error?: string) => void): void {
    this.statusCb = cb
  }

  async startOnboarding(callbacks: OnboardingCallbacks): Promise<OnboardingResult> {
    let refreshes = 0
    let qrcode = ''
    const fetchQr = async (): Promise<void> => {
      const result = await requestJson<QrResponse>({
        baseUrl: WECHAT_FIXED_BASE_URL,
        endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3',
        method: 'POST',
        body: { local_token_list: [] },
        signal: callbacks.signal,
        timeoutMs: WECHAT_API_TIMEOUT_MS
      })
      if (!result.qrcode || !result.qrcode_img_content) throw new Error('微信未返回可用二维码')
      qrcode = result.qrcode
      callbacks.onQrCode({ url: result.qrcode_img_content, expireIn: 300 })
    }
    await fetchQr()
    const deadline = Date.now() + 8 * 60_000
    let pollingBaseUrl = WECHAT_FIXED_BASE_URL
    let verificationCode: string | undefined
    while (Date.now() < deadline && !callbacks.signal.aborted) {
      const query = new URLSearchParams({ qrcode })
      if (verificationCode) query.set('verify_code', verificationCode)
      let status: QrStatusResponse
      try {
        status = await requestJson<QrStatusResponse>({
          baseUrl: pollingBaseUrl,
          endpoint: `ilink/bot/get_qrcode_status?${query.toString()}`,
          method: 'GET',
          signal: callbacks.signal,
          timeoutMs: WECHAT_POLL_TIMEOUT_MS
        })
      } catch (error) {
        if (!callbacks.signal.aborted && error instanceof Error && error.name === 'AbortError') continue
        throw error
      }
      callbacks.onStatus?.({ status: status.status ?? 'wait' })
      if (status.status === 'confirmed') {
        if (!status.bot_token || !status.ilink_bot_id) throw new Error('微信扫码成功但未返回完整账号凭证')
        const baseUrl = validateWeChatBaseUrl(status.baseurl || pollingBaseUrl)
        return {
          appId: status.ilink_bot_id,
          appSecret: status.bot_token,
          userOpenId: status.ilink_user_id,
          alias: '微信',
          extraCredentials: { base_url: baseUrl }
        }
      }
      if (status.status === 'need_verifycode') {
        if (!callbacks.requestVerificationCode) throw new Error('微信要求数字验证码，但当前界面无法提交')
        verificationCode = (await callbacks.requestVerificationCode(
          verificationCode ? '数字不匹配，请重新输入手机微信显示的验证码' : '请输入手机微信显示的数字验证码'
        )).trim()
        if (!/^\d{4,8}$/.test(verificationCode)) throw new Error('微信数字验证码格式无效')
        continue
      }
      if (status.status === 'scaned') verificationCode = undefined
      if (status.status === 'scaned_but_redirect') {
        if (!status.redirect_host) throw new Error('微信扫码重定向缺少服务地址')
        pollingBaseUrl = validateWeChatBaseUrl(`https://${status.redirect_host}`)
      } else if (status.status === 'expired' || status.status === 'verify_code_blocked') {
        refreshes += 1
        if (refreshes >= 3) throw new Error('微信二维码或数字验证多次失效，请稍后重试')
        verificationCode = undefined
        pollingBaseUrl = WECHAT_FIXED_BASE_URL
        await fetchQr()
      } else if (status.status === 'binded_redirect') {
        throw new Error('该微信已绑定过当前接入端，请先使用原配置或解除旧绑定后重试')
      }
      await delay(1_000, callbacks.signal)
    }
    if (callbacks.signal.aborted) throw new Error('微信扫码已取消')
    throw new Error('微信扫码超时，请重试')
  }

  async start(account: ChannelAccount): Promise<void> {
    await this.runLifecycle(account.id, async () => this.startNow(account))
  }

  private async startNow(account: ChannelAccount): Promise<void> {
    if (this.sessions.has(account.id)) return
    const token = account.credentials.token
    const botId = account.credentials.bot_id
    if (!token || !botId) throw new Error('缺少微信扫码授权凭证，请重新扫码')
    await this.flushRequiredCursor(account.id)
    const baseUrl = validateWeChatBaseUrl(account.credentials.base_url || WECHAT_FIXED_BASE_URL)
    const session: WeChatSession = {
      accountId: account.id,
      baseUrl,
      token,
      abort: new AbortController(),
      cursor: await this.loadCursor(account.id),
      contextTokens: new Map(),
      seenMessageIds: new Set(),
      online: false,
      pollTask: null
    }
    this.sessions.set(account.id, session)
    this.statusCb?.(account.id, 'connecting')
    session.pollTask = this.poll(session)
  }

  async stop(accountId: string): Promise<void> {
    await this.runLifecycle(accountId, async () => this.stopNow(accountId))
  }

  private async stopNow(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId)
    if (!session) {
      await this.flushRequiredCursor(accountId)
      return
    }
    session.abort.abort()
    this.sessions.delete(accountId)
    try {
      await session.pollTask
      if (session.cursor) this.requiredCursors.set(accountId, session.cursor)
      await this.flushRequiredCursor(accountId)
    } finally {
      this.statusCb?.(accountId, 'disconnected')
    }
  }

  canUpdate(): boolean {
    return false
  }

  restoreInboundContext(message: InboundChannelMessage): void {
    const session = this.sessions.get(message.accountId)
    const context = message.resumeContext as { contextToken?: unknown } | undefined
    if (session && typeof context?.contextToken === 'string' && context.contextToken) {
      session.contextTokens.set(message.userId, context.contextToken)
    }
  }

  async send(input: Parameters<ChannelTransport['send']>[0]): Promise<{ messageId?: string }> {
    const session = this.sessions.get(input.accountId)
    if (!session) throw new Error(`微信账号 ${input.accountId} 未连接`)
    const text = input.segments
      .filter((segment): segment is Extract<OneBotSegment, { type: 'text' }> => segment.type === 'text')
      .map((segment) => segment.data.text)
      .join('')
    if (!text.trim()) return {}
    const contextToken = session.contextTokens.get(input.chatId)
    if (!contextToken) throw new Error('微信会话上下文已失效，请让对方重新发送一条消息')
    let firstMessageId: string | undefined
    for (const chunk of splitWeChatText(text)) {
      const clientId = `agentos-wechat-${randomUUID()}`
      const response = await this.apiPost<WeChatApiResponse>(session, 'ilink/bot/sendmessage', {
        msg: {
          from_user_id: '',
          to_user_id: input.chatId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: chunk } }],
          context_token: contextToken
        }
      }, WECHAT_API_TIMEOUT_MS)
      if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
        throw new Error(`微信消息发送失败：${response.errmsg || response.errcode || response.ret}`)
      }
      firstMessageId ??= clientId
    }
    return { messageId: firstMessageId }
  }

  private async poll(session: WeChatSession): Promise<void> {
    let consecutiveFailures = 0
    let timeoutMs = WECHAT_POLL_TIMEOUT_MS
    while (!session.abort.signal.aborted && this.sessions.get(session.accountId) === session) {
      try {
        await this.flushRequiredCursor(session.accountId)
        const response = await this.apiPost<GetUpdatesResponse>(session, 'ilink/bot/getupdates', {
          get_updates_buf: session.cursor
        }, timeoutMs)
        if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
          throw new Error(`微信长轮询失败：${response.errmsg || response.errcode || response.ret}`)
        }
        consecutiveFailures = 0
        if (!session.online) {
          session.online = true
          this.statusCb?.(session.accountId, 'online')
        }
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeoutMs = Math.max(response.longpolling_timeout_ms + 5_000, WECHAT_POLL_TIMEOUT_MS)
        }
        for (const message of response.msgs ?? []) await this.handleMessage(session, message)
        if (response.get_updates_buf && response.get_updates_buf !== session.cursor) {
          session.cursor = response.get_updates_buf
          this.requiredCursors.set(session.accountId, session.cursor)
          await this.saveCursor(session.accountId, session.cursor)
        }
      } catch (error) {
        if (session.abort.signal.aborted) return
        if (error instanceof Error && error.name === 'AbortError') continue
        session.online = false
        consecutiveFailures += 1
        const message = error instanceof Error ? error.message : String(error)
        this.statusCb?.(
          session.accountId,
          consecutiveFailures >= 3 ? 'error' : 'connecting',
          message
        )
        await delay(consecutiveFailures >= 3 ? 30_000 : 2_000, session.abort.signal).catch(() => undefined)
      }
    }
  }

  private async handleMessage(session: WeChatSession, message: WeChatMessage): Promise<void> {
    const inbound = weChatMessageToInbound(session.accountId, message)
    if (!inbound) return
    const messageId = String(message.message_id ?? message.client_id ?? '')
    if (!messageId) throw new Error('微信消息缺少 message_id/client_id，已拒绝推进游标')
    if (messageId && session.seenMessageIds.has(messageId)) return
    if (message.context_token) session.contextTokens.set(inbound.userId, message.context_token)
    await this.messageCb?.(inbound)
    session.seenMessageIds.add(messageId)
    if (session.seenMessageIds.size > 1_000) {
      const oldest = session.seenMessageIds.values().next().value
      if (oldest) session.seenMessageIds.delete(oldest)
    }
  }

  private apiPost<T = unknown>(
    session: WeChatSession,
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<T> {
    return requestJson<T>({
      baseUrl: session.baseUrl,
      endpoint,
      method: 'POST',
      body: {
        ...body,
        base_info: { channel_version: WECHAT_PROTOCOL_VERSION, bot_agent: `AgentOS/${this.appVersion}` }
      },
      token: session.token,
      signal: session.abort.signal,
      timeoutMs
    })
  }

  private cursorPath(accountId: string): string {
    const safeAccountId = accountId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.stateDir, `${safeAccountId}.cursor.json`)
  }

  private async loadCursor(accountId: string): Promise<string> {
    const cached = this.persistedCursors.get(accountId)
    if (cached !== undefined) return cached
    try {
      const parsed = JSON.parse(await readFile(this.cursorPath(accountId), 'utf8')) as { cursor?: unknown }
      if (typeof parsed.cursor !== 'string') throw new Error('invalid cursor')
      this.persistedCursors.set(accountId, parsed.cursor)
      return parsed.cursor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('微信 cursor 状态文件损坏；为避免重复执行，请移除该账号后重新接入')
      }
      this.persistedCursors.set(accountId, '')
      return ''
    }
  }

  private async saveCursor(accountId: string, cursor: string): Promise<void> {
    const previous = this.cursorWrites.get(accountId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(async () => {
      if (this.persistedCursors.get(accountId) === cursor) {
        if (this.requiredCursors.get(accountId) === cursor) this.requiredCursors.delete(accountId)
        return
      }
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 })
      const target = this.cursorPath(accountId)
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify({ cursor }), { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, target)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw error
      }
      this.persistedCursors.set(accountId, cursor)
      if (this.requiredCursors.get(accountId) === cursor) this.requiredCursors.delete(accountId)
    })
    this.cursorWrites.set(accountId, task)
    try {
      await task
    } finally {
      if (this.cursorWrites.get(accountId) === task) this.cursorWrites.delete(accountId)
    }
  }

  private async flushRequiredCursor(accountId: string): Promise<void> {
    const required = this.requiredCursors.get(accountId)
    if (required !== undefined) await this.saveCursor(accountId, required)
    else await this.cursorWrites.get(accountId)
  }

  private async runLifecycle(accountId: string, action: () => Promise<void>): Promise<void> {
    const previous = this.lifecycleTasks.get(accountId) ?? Promise.resolve()
    const task = previous.then(action)
    this.lifecycleTasks.set(accountId, task)
    try {
      await task
    } finally {
      if (this.lifecycleTasks.get(accountId) === task) this.lifecycleTasks.delete(accountId)
    }
  }
}
