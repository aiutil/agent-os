import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelAccount } from '../src/shared/types'
import type { ChannelTransport, InboundChannelMessage } from '../src/main/domains/channels/transport'
import { MultiplexChannelTransport } from '../src/main/domains/channels/multiplex-transport'
import {
  nextTelegramOffset,
  splitTelegramText,
  TelegramTransport,
  telegramMessageToInbound
} from '../src/main/domains/channels/telegram-transport'
import { splitWeComText, WeComTransport, wecomFrameToInbound } from '../src/main/domains/channels/wecom-transport'
import {
  WhatsAppTransport,
  splitWhatsAppText,
  verifyWhatsAppSignature,
  whatsappPayloadToInbound
} from '../src/main/domains/channels/whatsapp-transport'

class StubTransport implements ChannelTransport {
  starts: string[] = []
  sends: string[] = []
  private messageCb: ((msg: InboundChannelMessage) => void) | null = null
  async start(account: ChannelAccount): Promise<void> { this.starts.push(account.id) }
  async stop(): Promise<void> {}
  async send(input: Parameters<ChannelTransport['send']>[0]): Promise<{ messageId?: string }> {
    this.sends.push(input.accountId)
    return { messageId: `${input.accountId}-message` }
  }
  onMessage(cb: (msg: InboundChannelMessage) => void): void { this.messageCb = cb }
  onStatus(): void {}
  emit(msg: InboundChannelMessage): void { this.messageCb?.(msg) }
  materializeInboundAttachments(message: InboundChannelMessage) {
    return Promise.resolve({ files: [`/${message.accountId}.bin`], cleanup: async () => undefined })
  }
}

async function freeTcpPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!port) throw new Error('未能分配测试端口')
  return port
}

describe('SPEC-034 官方消息 transport 映射', () => {
  it('Telegram 群消息仅在 @机器人或回复机器人时标记 mentioned，并剥离 mention', () => {
    const inbound = telegramMessageToInbound(
      'tg-1',
      { id: 99, username: 'AgentOSBot' },
      {
        message_id: 1,
        chat: { id: -1001, type: 'supergroup' },
        from: { id: 7, first_name: 'Ada' },
        text: '@AgentOSBot 帮我检查发布'
      }
    )
    expect(inbound).toMatchObject({
      platform: 'telegram',
      chatType: 'group',
      chatId: '-1001',
      userId: '7',
      userName: 'Ada',
      mentioned: true,
      text: '帮我检查发布'
    })
  })

  it('Telegram 私聊携带媒体 file_id 进入统一段模型', () => {
    const inbound = telegramMessageToInbound(
      'tg-1',
      { id: 99, username: 'AgentOSBot' },
      {
        message_id: 2,
        chat: { id: 7, type: 'private' },
        from: { id: 7 },
        caption: '看看图片',
        photo: [{ file_id: 'small' }, { file_id: 'large' }]
      }
    )
    expect(inbound?.segments).toEqual([
      { type: 'text', data: { text: '看看图片' } },
      { type: 'image', data: { file_id: 'large' } }
    ])
  })

  it('Telegram offset 单调前进到最大 update_id + 1，避免确认后重复消费', () => {
    expect(nextTelegramOffset(10, [{ update_id: 8 }, { update_id: 12 }, { update_id: 11 }])).toBe(13)
    expect(nextTelegramOffset(20, [{ update_id: 12 }])).toBe(20)
  })

  it('Telegram 原子保存 offset，应用重启后首个 poll 从已确认位置恢复', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-os-telegram-offset-'))
    const account: ChannelAccount = {
      id: 'tg-restart',
      platform: 'telegram',
      alias: 'Telegram',
      enabled: true,
      credentials: { bot_token: 'bot-token' }
    }
    const offsets: number[] = []
    const inbound: InboundChannelMessage[] = []
    let releaseDurableEnqueue!: () => void
    const durableEnqueue = new Promise<void>((resolve) => { releaseDurableEnqueue = resolve })
    let delivered = false
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').at(-1)
      if (method === 'getMe') {
        return new Response(JSON.stringify({
          ok: true,
          result: { id: 99, username: 'AgentOSBot', first_name: 'Agent OS' }
        }), { status: 200 })
      }
      if (method !== 'getUpdates') throw new Error(`unexpected Telegram method ${method}`)
      const body = JSON.parse(String(init?.body)) as { offset: number }
      offsets.push(body.offset)
      if (!delivered) {
        delivered = true
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 41,
            message: {
              message_id: 7,
              chat: { id: 123, type: 'private' },
              from: { id: 123, first_name: 'Ada' },
              text: '只执行一次'
            }
          }]
        }), { status: 200 })
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return reject(new Error('getUpdates 缺少 abort signal'))
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    try {
      const first = new TelegramTransport(30_000, stateDir)
      first.onMessage(async (message) => {
        inbound.push(message)
        await durableEnqueue
      })
      await first.start(account)
      const offsetPath = join(stateDir, 'tg-restart.offset.json')
      await vi.waitFor(() => expect(inbound).toHaveLength(1))
      await expect(access(offsetPath)).rejects.toThrow()
      expect(offsets).toEqual([0])
      expect(inbound[0].deliveryId).toBe('41')
      releaseDurableEnqueue()
      await vi.waitFor(async () => {
        const saved = JSON.parse(await readFile(offsetPath, 'utf8')) as { offset: number }
        expect(saved.offset).toBe(42)
        expect(offsets).toEqual([0, 42])
      })
      if (process.platform !== 'win32') expect((await stat(offsetPath)).mode & 0o777).toBe(0o600)
      expect(inbound).toHaveLength(1)
      await first.stop(account.id)

      const callsBeforeRestart = offsets.length
      const second = new TelegramTransport(30_000, stateDir)
      second.onMessage((message) => { inbound.push(message) })
      await second.start(account)
      await vi.waitFor(() => expect(offsets.length).toBeGreaterThan(callsBeforeRestart))
      expect(offsets[callsBeforeRestart]).toBe(42)
      expect(inbound).toHaveLength(1)
      await second.stop(account.id)
    } finally {
      vi.unstubAllGlobals()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('Telegram durable enqueue 失败时不推进或落盘 offset', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-os-telegram-inbox-fail-'))
    const account: ChannelAccount = {
      id: 'tg-inbox-fail',
      platform: 'telegram',
      alias: 'Telegram',
      enabled: true,
      credentials: { bot_token: 'bot-token' }
    }
    let attempts = 0
    let delivered = false
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').at(-1)
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 99, username: 'AgentOSBot' } }), { status: 200 })
      }
      if (method !== 'getUpdates') throw new Error(`unexpected Telegram method ${method}`)
      if (!delivered) {
        delivered = true
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 71,
            message: { message_id: 8, chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'retry' }
          }]
        }), { status: 200 })
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }))
    try {
      const transport = new TelegramTransport(30_000, stateDir)
      transport.onMessage(() => {
        attempts += 1
        throw new Error('inbox disk unavailable')
      })
      await transport.start(account)
      await vi.waitFor(() => expect(attempts).toBe(1))
      await expect(access(join(stateDir, 'tg-inbox-fail.offset.json'))).rejects.toThrow()
      await transport.stop(account.id)
    } finally {
      vi.unstubAllGlobals()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('Telegram stop/start 等待延迟的 offset 落盘，新 poll 不重复消费', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-os-telegram-reconnect-offset-'))
    const account: ChannelAccount = {
      id: 'tg-fast-reconnect',
      platform: 'telegram',
      alias: 'Telegram',
      enabled: true,
      credentials: { bot_token: 'bot-token' }
    }
    const offsets: number[] = []
    const inbound: InboundChannelMessage[] = []
    let delivered = false
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').at(-1)
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 99, username: 'AgentOSBot' } }), { status: 200 })
      }
      if (method !== 'getUpdates') throw new Error(`unexpected Telegram method ${method}`)
      const body = JSON.parse(String(init?.body)) as { offset: number }
      offsets.push(body.offset)
      if (!delivered) {
        delivered = true
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 41,
            message: {
              message_id: 7,
              chat: { id: 123, type: 'private' },
              from: { id: 123 },
              text: '只执行一次'
            }
          }]
        }), { status: 200 })
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return reject(new Error('getUpdates 缺少 abort signal'))
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    try {
      const transport = new TelegramTransport(30_000, stateDir)
      transport.onMessage((message) => { inbound.push(message) })
      const internal = transport as unknown as {
        saveOffset(accountId: string, offset: number): Promise<void>
      }
      const originalSaveOffset = internal.saveOffset.bind(transport)
      let releaseSave!: () => void
      const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
      let delayed = false
      internal.saveOffset = vi.fn(async (accountId, offset) => {
        if (offset === 42 && !delayed) {
          delayed = true
          await saveGate
        }
        await originalSaveOffset(accountId, offset)
      })

      await transport.start(account)
      await vi.waitFor(() => expect(inbound).toHaveLength(1))
      let reconnectSettled = false
      const reconnect = (async () => {
        await transport.stop(account.id)
        await transport.start(account)
        reconnectSettled = true
      })()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(reconnectSettled).toBe(false)
      expect(offsets).toEqual([0])

      releaseSave()
      await reconnect
      await vi.waitFor(() => expect(offsets).toEqual([0, 42]))
      expect(inbound).toHaveLength(1)
      await transport.stop(account.id)
    } finally {
      vi.unstubAllGlobals()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('Telegram stop 后忽略不遵守 abort 的迟到 getUpdates 响应', async () => {
    const account: ChannelAccount = {
      id: 'tg-late-response',
      platform: 'telegram',
      alias: 'Telegram',
      enabled: true,
      credentials: { bot_token: 'bot-token' }
    }
    const inbound: InboundChannelMessage[] = []
    let resolveLate!: (response: Response) => void
    const lateResponse = new Promise<Response>((resolve) => { resolveLate = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: unknown): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').at(-1)
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 99, username: 'AgentOSBot' } }), { status: 200 })
      }
      if (method === 'getUpdates') return lateResponse
      throw new Error(`unexpected Telegram method ${method}`)
    }))
    try {
      const transport = new TelegramTransport()
      transport.onMessage((message) => { inbound.push(message) })
      await transport.start(account)
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

      const stopping = transport.stop(account.id)
      resolveLate(new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 41,
          message: {
            message_id: 7,
            chat: { id: 123, type: 'private' },
            from: { id: 123 },
            text: '迟到消息不应执行'
          }
        }]
      }), { status: 200 }))
      await stopping
      expect(inbound).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Telegram stop 持续落盘失败时保留必需 offset 并阻断 start，补写后才恢复', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-os-telegram-failed-stop-'))
    const account: ChannelAccount = {
      id: 'tg-failed-stop',
      platform: 'telegram',
      alias: 'Telegram',
      enabled: true,
      credentials: { bot_token: 'bot-token' }
    }
    const offsets: number[] = []
    const inbound: InboundChannelMessage[] = []
    let getMeCalls = 0
    let delivered = false
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').at(-1)
      if (method === 'getMe') {
        getMeCalls += 1
        return new Response(JSON.stringify({ ok: true, result: { id: 99, username: 'AgentOSBot' } }), { status: 200 })
      }
      if (method !== 'getUpdates') throw new Error(`unexpected Telegram method ${method}`)
      const body = JSON.parse(String(init?.body)) as { offset: number }
      offsets.push(body.offset)
      if (!delivered) {
        delivered = true
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 41,
            message: {
              message_id: 7,
              chat: { id: 123, type: 'private' },
              from: { id: 123 },
              text: '落盘前已交付'
            }
          }]
        }), { status: 200 })
      }
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return reject(new Error('getUpdates 缺少 abort signal'))
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }))
    try {
      const transport = new TelegramTransport(30_000, stateDir)
      transport.onMessage((message) => { inbound.push(message) })
      const internal = transport as unknown as {
        saveOffset(accountId: string, offset: number): Promise<void>
      }
      const originalSaveOffset = internal.saveOffset.bind(transport)
      let failOffset42 = true
      let failedSaveAttempts = 0
      internal.saveOffset = vi.fn(async (accountId, offset) => {
        if (offset === 42 && failOffset42) {
          failedSaveAttempts += 1
          throw new Error('offset disk unavailable')
        }
        await originalSaveOffset(accountId, offset)
      })

      await transport.start(account)
      await vi.waitFor(() => {
        expect(inbound).toHaveLength(1)
        expect(failedSaveAttempts).toBe(1)
      })

      const stopping = transport.stop(account.id)
      const queuedStart = transport.start(account)
      await expect(stopping).rejects.toThrow('offset disk unavailable')
      await expect(queuedStart).rejects.toThrow('offset disk unavailable')
      expect(getMeCalls).toBe(1)
      expect(offsets).toEqual([0])
      await expect(transport.stop(account.id)).rejects.toThrow('offset disk unavailable')

      failOffset42 = false
      await transport.start(account)
      await vi.waitFor(() => expect(offsets).toEqual([0, 42]))
      expect(getMeCalls).toBe(2)
      expect(inbound).toHaveLength(1)
      expect(JSON.parse(await readFile(join(stateDir, 'tg-failed-stop.offset.json'), 'utf8'))).toEqual({ offset: 42 })
      await transport.stop(account.id)
    } finally {
      vi.unstubAllGlobals()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('Telegram offset 文件损坏时 fail closed，不从 0 静默重放', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agent-os-telegram-corrupt-offset-'))
    await writeFile(join(stateDir, 'tg-corrupt.offset.json'), '{broken', { mode: 0o600 })
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown): Promise<Response> => {
      const method = new URL(String(input)).pathname.split('/').at(-1) ?? ''
      methods.push(method)
      if (method === 'getMe') {
        return new Response(JSON.stringify({ ok: true, result: { id: 99, username: 'AgentOSBot' } }), { status: 200 })
      }
      throw new Error(`unexpected Telegram method ${method}`)
    }))
    try {
      const transport = new TelegramTransport(30_000, stateDir)
      await expect(transport.start({
        id: 'tg-corrupt',
        platform: 'telegram',
        alias: 'Telegram',
        enabled: true,
        credentials: { bot_token: 'bot-token' }
      })).rejects.toThrow('为避免重复执行')
      expect(methods).toEqual(['getMe'])
    } finally {
      vi.unstubAllGlobals()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('Telegram offset 首次落盘失败时先补写成功，才继续下一次 poll', async () => {
    vi.useFakeTimers()
    const transport = new TelegramTransport()
    const abort = new AbortController()
    type TestTelegramSession = {
      token: string
      abort: AbortController
      offset: number
      bot: { id: number; username: string }
    }
    const session: TestTelegramSession = {
      token: 'bot-token',
      abort,
      offset: 0,
      bot: { id: 99, username: 'AgentOSBot' }
    }
    const inbound: InboundChannelMessage[] = []
    const savedOffsets: number[] = []
    const requestedOffsets: number[] = []
    let failedOnce = false
    const internal = transport as unknown as {
      sessions: Map<string, TestTelegramSession>
      saveOffset(accountId: string, offset: number): Promise<void>
      call(token: string, method: string, body: Record<string, unknown>): Promise<unknown>
      poll(accountId: string, session: TestTelegramSession): Promise<void>
    }
    internal.sessions.set('tg-retry-save', session)
    transport.onMessage((message) => { inbound.push(message) })
    internal.saveOffset = vi.fn(async (_accountId, offset) => {
      savedOffsets.push(offset)
      if (offset === 42 && !failedOnce) {
        failedOnce = true
        throw new Error('disk temporarily unavailable')
      }
    })
    internal.call = vi.fn(async (_token: string, method: string, body: Record<string, unknown>): Promise<unknown> => {
      if (method !== 'getUpdates') throw new Error(`unexpected Telegram method ${method}`)
      requestedOffsets.push(Number(body.offset))
      if (requestedOffsets.length === 1) {
        return [{
          update_id: 41,
          message: {
            message_id: 7,
            chat: { id: 123, type: 'private' },
            from: { id: 123 },
            text: '不要重复'
          }
        }]
      }
      abort.abort()
      return []
    })
    try {
      const polling = internal.poll('tg-retry-save', session)
      await vi.waitFor(() => expect(savedOffsets).toEqual([0, 42]))
      expect(requestedOffsets).toEqual([0])
      expect(inbound).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(1_000)
      await polling

      expect(savedOffsets).toEqual([0, 42, 42])
      expect(requestedOffsets).toEqual([0, 42])
      expect(inbound).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Telegram 最终长回复按 4096 字符分片并完整续发，不再截断丢内容', async () => {
    const transport = new TelegramTransport()
    ;(transport as unknown as { sessions: Map<string, unknown> }).sessions.set('tg-long', {
      token: 'bot-token',
      abort: new AbortController(),
      offset: 0,
      bot: { id: 99, username: 'AgentOSBot' }
    })
    const content = `${'甲'.repeat(4090)}\n${'乙'.repeat(4090)}😀${'丙'.repeat(100)}`
    const chunks = splitTelegramText(content)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true)
    expect(chunks.join('')).toBe(content)

    const requests: Array<{ method: string; text: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = new URL(String(input)).pathname.split('/').at(-1)!
      const body = JSON.parse(String(init?.body)) as { text: string }
      requests.push({ method, text: body.text })
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: requests.length, chat: { id: 7, type: 'private' } }
      }), { status: 200 })
    }))
    try {
      await transport.updateMessage({
        accountId: 'tg-long',
        chatType: 'private',
        chatId: '7',
        messageId: '1',
        content,
        final: true
      })
      expect(requests[0].method).toBe('editMessageText')
      expect(requests.slice(1).every((request) => request.method === 'sendMessage')).toBe(true)
      expect(requests.map((request) => request.text).join('')).toBe(content)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Telegram 通过 getFile + 官方文件地址下载附件并清理', async () => {
    const transport = new TelegramTransport()
    ;(transport as unknown as { sessions: Map<string, unknown> }).sessions.set('tg-1', {
      token: 'bot-token',
      abort: new AbortController(),
      offset: 0,
      bot: { id: 99, username: 'AgentOSBot' }
    })
    const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/getFile')) {
        return new Response(JSON.stringify({
          ok: true,
          result: { file_id: 'doc-1', file_size: 4, file_path: 'documents/report.txt' }
        }), { status: 200 })
      }
      if (url.pathname.endsWith('/documents/report.txt')) {
        return new Response(Buffer.from('data'), { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      throw new Error(`unexpected Telegram fetch ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const inbound = telegramMessageToInbound('tg-1', { id: 99 }, {
        message_id: 3,
        chat: { id: 7, type: 'private' },
        from: { id: 7 },
        document: { file_id: 'doc-1', file_name: 'report.txt', mime_type: 'text/plain', file_size: 4 }
      })!
      const batch = await transport.materializeInboundAttachments(inbound)
      expect(await readFile(batch!.files[0], 'utf8')).toBe('data')
      expect(batch!.files[0]).toMatch(/01-report\.txt$/)
      await batch!.cleanup()
      await expect(access(batch!.files[0])).rejects.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('Telegram Bot API 请求悬挂时主动超时，不卡住消息终态', async () => {
    const transport = new TelegramTransport(5)
    ;(transport as unknown as { sessions: Map<string, unknown> }).sessions.set('tg-timeout', {
      token: 'bot-token',
      abort: new AbortController(),
      offset: 0,
      bot: { id: 99, username: 'AgentOSBot' }
    })
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error('请求未配置超时 signal'))
      if (signal.aborted) return reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })))
    try {
      await expect(transport.send({
        accountId: 'tg-timeout',
        chatType: 'private',
        chatId: '7',
        segments: [{ type: 'text', data: { text: 'status' } }]
      })).rejects.toMatchObject({ name: 'TimeoutError' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('企业微信官方回调映射单聊 user/chat 与文本', () => {
    const inbound = wecomFrameToInbound('wx-1', {
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'r1' },
      body: {
        msgid: 'm1',
        aibotid: 'bot',
        chattype: 'single',
        from: { userid: 'zhangsan' },
        msgtype: 'text',
        text: { content: '你好' }
      }
    })
    expect(inbound).toMatchObject({
      deliveryId: 'm1',
      platform: 'wecom',
      chatType: 'private',
      chatId: 'zhangsan',
      userId: 'zhangsan',
      mentioned: true,
      text: '你好'
    })
  })

  it('企业微信 durable enqueue 失败时不写入进程内去重，后续重投仍可接收', async () => {
    const transport = new WeComTransport()
    let attempts = 0
    transport.onMessage(() => {
      attempts += 1
      if (attempts === 1) throw new Error('inbox disk unavailable')
    })
    const session = {
      latestFrames: new Map(),
      streams: new Map(),
      seenMessageIds: new Set<string>()
    }
    const frame = {
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'r-retry' },
      body: {
        msgid: 'm-retry',
        aibotid: 'bot',
        chattype: 'single' as const,
        from: { userid: 'zhangsan' },
        msgtype: 'text',
        text: { content: '重试' }
      }
    }
    const internal = transport as unknown as {
      handleFrame(accountId: string, activeSession: typeof session, input: typeof frame): Promise<void>
    }
    await expect(internal.handleFrame('wx-1', session, frame)).rejects.toThrow('inbox disk unavailable')
    expect(session.seenMessageIds.has('m-retry')).toBe(false)
    await internal.handleFrame('wx-1', session, frame)
    expect(attempts).toBe(2)
    expect(session.seenMessageIds.has('m-retry')).toBe(true)
  })

  it('企业微信使用官方 SDK downloadFile 与独立 aeskey 下载解密附件', async () => {
    const downloadFile = vi.fn(async () => ({ buffer: Buffer.from('image'), filename: 'wecom.png' }))
    const transport = new WeComTransport()
    ;(transport as unknown as { sessions: Map<string, unknown> }).sessions.set('wx-1', {
      client: { downloadFile },
      latestFrames: new Map(),
      streams: new Map(),
      seenMessageIds: new Set()
    })
    const inbound = wecomFrameToInbound('wx-1', {
      cmd: 'aibot_msg_callback',
      headers: { req_id: 'r-image' },
      body: {
        msgid: 'm-image',
        aibotid: 'bot',
        chattype: 'single',
        from: { userid: 'zhangsan' },
        msgtype: 'image',
        image: { url: 'https://wecom.example/encrypted', aeskey: 'aes-key' }
      }
    })!
    const batch = await transport.materializeInboundAttachments(inbound)
    expect(downloadFile).toHaveBeenCalledWith('https://wecom.example/encrypted', 'aes-key')
    expect(await readFile(batch!.files[0], 'utf8')).toBe('image')
    await batch!.cleanup()
  })

  it('企业微信最终长回复按 20 KiB UTF-8 字节分片并完整续发', async () => {
    const replyStreamNonBlocking = vi.fn(
      async (_frame: unknown, _streamId: string, _content: string, _final: boolean) => undefined
    )
    const sendMessage = vi.fn(
      async (_chatId: string, _message: { msgtype: string; markdown: { content: string } }) => undefined
    )
    const transport = new WeComTransport()
    ;(transport as unknown as { sessions: Map<string, unknown> }).sessions.set('wx-long', {
      client: { replyStreamNonBlocking, sendMessage },
      latestFrames: new Map(),
      streams: new Map([['stream-1', { body: { msgid: 'm1' } }]]),
      seenMessageIds: new Set()
    })
    const content = `${'甲'.repeat(9_000)}\n${'乙'.repeat(9_000)}😀`
    const chunks = splitWeComText(content)
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 20_480)).toBe(true)
    expect(chunks.join('')).toBe(content)

    await transport.updateMessage({
      accountId: 'wx-long',
      chatType: 'private',
      chatId: 'zhangsan',
      messageId: 'stream-1',
      content,
      final: true
    })
    expect(replyStreamNonBlocking.mock.calls[0][2]).toBe(chunks[0])
    expect(sendMessage.mock.calls.map((call) => call[1].markdown.content).join('')).toBe(chunks.slice(1).join(''))
  })

  it('WhatsApp 校验原始 webhook body 的 HMAC-SHA256，拒绝篡改内容', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}')
    const secret = 'meta-app-secret'
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    expect(verifyWhatsAppSignature(body, signature, secret)).toBe(true)
    expect(verifyWhatsAppSignature(Buffer.from('{}'), signature, secret)).toBe(false)
    expect(verifyWhatsAppSignature(body, undefined, secret)).toBe(false)
  })

  it('WhatsApp 官方 messages webhook 展平为私聊文本/媒体段', () => {
    const messages = whatsappPayloadToInbound('wa-1', {
      entry: [{
        changes: [{
          value: {
            contacts: [{ wa_id: '4912345', profile: { name: 'Ada' } }],
            messages: [
              { id: 'wamid.text', from: '4912345', type: 'text', text: { body: 'hello' } },
              { id: 'wamid.image', from: '4912345', type: 'image', image: { id: 'media-1', caption: 'diagram' } }
            ]
          }
        }]
      }]
    })
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      deliveryId: 'wamid.text',
      accountId: 'wa-1',
      platform: 'whatsapp',
      chatType: 'private',
      chatId: '4912345',
      userId: '4912345',
      userName: 'Ada',
      text: 'hello'
    })
    expect(messages[1].segments).toEqual([
      { type: 'image', data: { file_id: 'media-1' } },
      { type: 'text', data: { text: 'diagram' } }
    ])
  })

  it('WhatsApp 先取 Graph media object，再用 bearer 下载官方 HTTPS 资源', async () => {
    const transport = new WhatsAppTransport()
    ;(transport as unknown as { sessions: Map<string, unknown> }).sessions.set('wa-1', {
      accountId: 'wa-1',
      phoneNumberId: 'phone-1',
      accessToken: 'access-token',
      appSecret: 'secret',
      verifyToken: 'verify',
      graphVersion: 'v23.0',
      publicWebhookUrl: new URL('https://example.com/webhook'),
      server: {},
      abort: new AbortController(),
      seenMessageIds: new Set(),
      contactNames: new Map()
    })
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input))
      if (url.hostname === 'graph.facebook.com') {
        expect(init?.redirect).toBe('error')
        return new Response(JSON.stringify({
          id: 'media-1',
          url: 'https://lookaside.fbsbx.com/media-1',
          mime_type: 'image/jpeg',
          file_size: 4
        }), { status: 200 })
      }
      if (url.hostname === 'lookaside.fbsbx.com') {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token')
        expect(init?.redirect).toBe('error')
        return new Response(Buffer.from('jpeg'), { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      throw new Error(`unexpected WhatsApp fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const inbound = whatsappPayloadToInbound('wa-1', {
        entry: [{ changes: [{ value: {
          messages: [{ id: 'wamid.image', from: '4912345', type: 'image', image: { id: 'media-1' } }]
        } }] }]
      })[0]
      const batch = await transport.materializeInboundAttachments(inbound)
      expect(await readFile(batch!.files[0], 'utf8')).toBe('jpeg')
      expect(batch!.files[0]).toMatch(/01-image\.jpg$/)
      await batch!.cleanup()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('WhatsApp 未明确政策依据时在任何网络请求前拒绝启动', async () => {
    const transport = new WhatsAppTransport()
    await expect(transport.start({
      id: 'wa-blocked',
      platform: 'whatsapp',
      alias: 'blocked',
      enabled: true,
      credentials: {
        phone_number_id: '123',
        access_token: 'token',
        app_secret: 'secret',
        verify_token: 'verify',
        public_webhook_url: 'https://example.com/webhook',
        webhook_port: '8788'
      }
    })).rejects.toThrow('必须确认适用的官方政策依据')
  })

  it('WhatsApp 真实监听本地 webhook：公网 challenge、自签名入站、去重与 Cloud API 回复闭环', async () => {
    const port = await freeTcpPort()
    const originalFetch = globalThis.fetch
    const graphRequests: Array<{ url: string; body?: unknown }> = []
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input))
      if (url.hostname === 'public.agent-os.test') {
        expect(init?.redirect).toBe('error')
        return originalFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init)
      }
      if (url.hostname === 'graph.facebook.com') {
        expect(init?.redirect).toBe('error')
        graphRequests.push({
          url: url.toString(),
          ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {})
        })
        return url.pathname.endsWith('/messages')
          ? new Response(JSON.stringify({ messages: [{ id: 'wamid.reply' }] }), { status: 200 })
          : new Response(JSON.stringify({ display_phone_number: '+49 123', verified_name: 'Agent OS' }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const transport = new WhatsAppTransport()
    const inbound: InboundChannelMessage[] = []
    const statuses: string[] = []
    let releaseDurableEnqueue!: () => void
    const durableEnqueue = new Promise<void>((resolve) => { releaseDurableEnqueue = resolve })
    let rejectDurableEnqueue = false
    transport.onMessage(async (message) => {
      if (rejectDurableEnqueue) throw new Error('inbox disk unavailable')
      inbound.push(message)
      if (message.deliveryId === 'wamid.inbound') await durableEnqueue
    })
    transport.onStatus((_accountId, status) => statuses.push(status))
    const account: ChannelAccount = {
      id: 'wa-live-local',
      platform: 'whatsapp',
      alias: 'WhatsApp local integration',
      enabled: true,
      credentials: {
        phone_number_id: '123456789',
        access_token: 'access-token',
        app_secret: 'meta-app-secret',
        verify_token: 'verify-token',
        public_webhook_url: 'https://public.agent-os.test/webhook',
        webhook_port: String(port),
        graph_version: 'v23.0',
        policy_basis: 'eea_brazil',
        policy_confirmed: 'true'
      }
    }

    try {
      await transport.start(account)
      expect(statuses).toEqual(['connecting', 'online'])

      const payload = Buffer.from(JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{
          changes: [{
            value: {
              contacts: [{ wa_id: '4912345', profile: { name: 'Ada' } }],
              messages: [{ id: 'wamid.inbound', from: '4912345', type: 'text', text: { body: 'run status' } }]
            }
          }]
        }]
      }))
      const signature = `sha256=${createHmac('sha256', 'meta-app-secret').update(payload).digest('hex')}`
      const webhookUrl = `http://127.0.0.1:${port}/webhook`
      let webhookAcknowledged = false
      const acceptedPromise = originalFetch(webhookUrl, {
        method: 'POST',
        headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' },
        body: payload
      })
      await vi.waitFor(() => expect(inbound).toHaveLength(1))
      void acceptedPromise.then(() => { webhookAcknowledged = true })
      await Promise.resolve()
      expect(webhookAcknowledged).toBe(false)
      expect(inbound[0].deliveryId).toBe('wamid.inbound')
      releaseDurableEnqueue()
      const accepted = await acceptedPromise
      expect(accepted.status).toBe(200)
      const duplicate = await originalFetch(webhookUrl, {
        method: 'POST',
        headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' },
        body: payload
      })
      expect(duplicate.status).toBe(200)
      expect(inbound).toHaveLength(1)
      expect(inbound[0]).toMatchObject({ chatId: '4912345', userName: 'Ada', text: 'run status' })

      const retryPayload = Buffer.from(JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: {
          messages: [{ id: 'wamid.retry', from: '4912345', type: 'text', text: { body: 'retry me' } }]
        } }] }]
      }))
      const retrySignature = `sha256=${createHmac('sha256', 'meta-app-secret').update(retryPayload).digest('hex')}`
      rejectDurableEnqueue = true
      const notAcknowledged = await originalFetch(webhookUrl, {
        method: 'POST',
        headers: { 'x-hub-signature-256': retrySignature, 'content-type': 'application/json' },
        body: retryPayload
      })
      expect(notAcknowledged.status).toBe(400)
      rejectDurableEnqueue = false
      const retried = await originalFetch(webhookUrl, {
        method: 'POST',
        headers: { 'x-hub-signature-256': retrySignature, 'content-type': 'application/json' },
        body: retryPayload
      })
      expect(retried.status).toBe(200)
      expect(inbound.map((message) => message.deliveryId)).toEqual(['wamid.inbound', 'wamid.retry'])

      const rejected = await originalFetch(webhookUrl, {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'sha256=deadbeef', 'content-type': 'application/json' },
        body: payload
      })
      expect(rejected.status).toBe(401)

      const sent = await transport.send({
        accountId: account.id,
        chatType: 'private',
        chatId: '4912345',
        segments: [{ type: 'text', data: { text: 'done' } }]
      })
      expect(sent.messageId).toBe('wamid.reply')
      expect(graphRequests.at(-1)).toMatchObject({
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '4912345',
          type: 'text',
          text: { body: 'done', preview_url: false }
        }
      })

      const longReply = `${'A'.repeat(4090)}\n${'B'.repeat(4090)}😀`
      const longChunks = splitWhatsAppText(longReply)
      const beforeLongReply = graphRequests.length
      await transport.send({
        accountId: account.id,
        chatType: 'private',
        chatId: '4912345',
        segments: [{ type: 'text', data: { text: longReply } }]
      })
      const sentChunks = graphRequests
        .slice(beforeLongReply)
        .map((request) => (request.body as { text: { body: string } }).text.body)
      expect(sentChunks).toEqual(longChunks)
      expect(sentChunks.join('')).toBe(longReply)
    } finally {
      await transport.stop(account.id)
      vi.unstubAllGlobals()
    }
    expect(statuses.at(-1)).toBe('disconnected')
  })

  it('WhatsApp stop 可取消进行中的启动，且不会在关闭后留下幽灵 webhook 监听', async () => {
    const port = await freeTcpPort()
    let graphStarted!: () => void
    const graphStartedPromise = new Promise<void>((resolve) => { graphStarted = resolve })
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
      graphStarted()
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    }))
    const transport = new WhatsAppTransport()
    const account: ChannelAccount = {
      id: 'wa-cancel-start',
      platform: 'whatsapp',
      alias: 'WhatsApp cancel startup',
      enabled: true,
      credentials: {
        phone_number_id: '123456789',
        access_token: 'access-token',
        app_secret: 'meta-app-secret',
        verify_token: 'verify-token',
        public_webhook_url: 'https://public.agent-os.test/webhook',
        webhook_port: String(port),
        graph_version: 'v23.0',
        policy_basis: 'eea_brazil',
        policy_confirmed: 'true'
      }
    }

    try {
      const starting = transport.start(account)
      await graphStartedPromise
      const stopping = transport.stop(account.id)
      await expect(starting).rejects.toThrow()
      await expect(stopping).resolves.toBeUndefined()

      const probe = createNetServer()
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', resolve)
      })
      await new Promise<void>((resolve) => probe.close(() => resolve()))
    } finally {
      await transport.stop(account.id)
      vi.unstubAllGlobals()
    }
  })

  it('多路复用层按账号平台路由启动、入站和出站', async () => {
    const feishu = new StubTransport()
    const telegram = new StubTransport()
    const multiplex = new MultiplexChannelTransport({ feishu, telegram })
    const inbound: InboundChannelMessage[] = []
    multiplex.onMessage((message) => { inbound.push(message) })
    multiplex.onStatus(() => undefined)

    const account = (id: string, platform: ChannelAccount['platform']): ChannelAccount => ({
      id,
      platform,
      alias: id,
      enabled: true,
      credentials: {}
    })
    await multiplex.start(account('fs-1', 'feishu'))
    await multiplex.start(account('tg-1', 'telegram'))
    await multiplex.send({
      accountId: 'tg-1',
      chatType: 'private',
      chatId: 'chat',
      segments: [{ type: 'text', data: { text: 'hello' } }]
    })
    feishu.emit({
      deliveryId: 'feishu-message-1',
      accountId: 'fs-1',
      platform: 'feishu',
      chatType: 'private',
      chatId: 'chat',
      userId: 'u1',
      mentioned: true,
      segments: [{ type: 'text', data: { text: '你好' } }],
      text: '你好'
    })
    const attachment = await multiplex.materializeInboundAttachments({
      deliveryId: 'telegram-message-1',
      accountId: 'tg-1',
      platform: 'telegram',
      chatType: 'private',
      chatId: 'chat',
      userId: 'u1',
      segments: [{ type: 'file', data: { file_id: 'f1' } }],
      text: ''
    })

    expect(feishu.starts).toEqual(['fs-1'])
    expect(telegram.starts).toEqual(['tg-1'])
    expect(telegram.sends).toEqual(['tg-1'])
    expect(feishu.sends).toEqual([])
    expect(inbound).toHaveLength(1)
    expect(inbound[0].accountId).toBe('fs-1')
    expect(attachment?.files).toEqual(['/tg-1.bin'])
  })
})
