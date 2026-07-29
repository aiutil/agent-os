import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { ChannelAccount } from '../src/shared/types'
import type { InboundChannelMessage } from '../src/main/domains/channels/transport'

const larkState = vi.hoisted(() => ({
  wsOptions: null as null | Record<string, unknown>,
  eventHandlers: {} as Record<string, (data: unknown) => Promise<void>>,
  closedWith: null as null | { force?: boolean },
  resourceRequests: [] as unknown[],
  createRequests: [] as Array<{
    params: { receive_id_type: string }
    data: { receive_id: string; msg_type: string; content: string }
  }>,
  updateRequests: [] as Array<{
    path: { message_id: string }
    data: { msg_type: string; content: string }
  }>
}))

vi.mock('@larksuiteoapi/node-sdk', () => {
  class Client {
    im = {
      message: {
        create: vi.fn(async (request: (typeof larkState.createRequests)[number]) => {
          larkState.createRequests.push(request)
          return { data: { message_id: `om-reply-${larkState.createRequests.length}` } }
        }),
        update: vi.fn(async (request: (typeof larkState.updateRequests)[number]) => {
          larkState.updateRequests.push(request)
          return {}
        })
      },
      messageResource: {
        get: vi.fn(async (request: unknown) => {
          larkState.resourceRequests.push(request)
          return {
            headers: {
              'content-type': 'image/png',
              'content-length': '7',
              'content-disposition': 'attachment; filename="diagram.png"'
            },
            getReadableStream: () => Readable.from([Buffer.from('pngdata')])
          }
        })
      }
    }
    contact = { user: { get: vi.fn(async () => ({ data: {} })) } }
  }

  class EventDispatcher {
    register(handlers: Record<string, (data: unknown) => Promise<void>>): this {
      larkState.eventHandlers = handlers
      return this
    }
  }

  class WSClient {
    constructor(options: Record<string, unknown>) {
      larkState.wsOptions = options
    }
    async start(): Promise<void> {}
    close(options?: { force?: boolean }): void {
      larkState.closedWith = options ?? {}
    }
  }

  return {
    AppType: { SelfBuild: 'self-build' },
    LoggerLevel: { warn: 'warn' },
    Client,
    EventDispatcher,
    WSClient,
    registerApp: vi.fn()
  }
})

const {
  FEISHU_CONNECTION_DEADLINE_MS,
  FeishuTransport,
  splitFeishuText
} = await import('../src/main/domains/channels/feishu-transport')

const ACCOUNT: ChannelAccount = {
  id: 'feishu-1',
  platform: 'feishu',
  alias: '飞书',
  enabled: true,
  credentials: { app_id: 'cli_0123456789abcdef', app_secret: 'secret' }
}

beforeEach(() => {
  vi.useRealTimers()
  larkState.wsOptions = null
  larkState.eventHandlers = {}
  larkState.closedWith = null
  larkState.resourceRequests = []
  larkState.createRequests = []
  larkState.updateRequests = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SPEC-034 飞书 transport 真实连接状态', () => {
  it('WSClient.start resolve 只表示已启动连接循环，必须等 onReady 才标记 online', async () => {
    const transport = new FeishuTransport()
    const statuses: Array<{ status: string; error?: string }> = []
    transport.onStatus((_accountId, status, error) => statuses.push({ status, error }))

    await transport.start(ACCOUNT)

    expect(statuses).toEqual([{ status: 'connecting', error: undefined }])
    expect(larkState.wsOptions?.handshakeTimeoutMs).toBe(15_000)

    ;(larkState.wsOptions?.onReady as (() => void) | undefined)?.()
    expect(statuses.at(-1)?.status).toBe('online')

    ;(larkState.wsOptions?.onReconnecting as (() => void) | undefined)?.()
    expect(statuses.at(-1)).toEqual({ status: 'connecting', error: '飞书长连接正在重连' })

    ;(larkState.wsOptions?.onReconnected as (() => void) | undefined)?.()
    expect(statuses.at(-1)?.status).toBe('online')

    await transport.stop(ACCOUNT.id)
    expect(larkState.closedWith).toEqual({ force: true })
    expect(statuses.at(-1)?.status).toBe('disconnected')
  })

  it('终态连接错误进入 error 并释放 session，允许用户修正后重试', async () => {
    const transport = new FeishuTransport()
    const statuses: Array<{ status: string; error?: string }> = []
    transport.onStatus((_accountId, status, error) => statuses.push({ status, error }))
    await transport.start(ACCOUNT)

    ;(larkState.wsOptions?.onError as ((error: Error) => void) | undefined)?.(new Error('鉴权失败'))
    expect(statuses.at(-1)).toEqual({ status: 'error', error: '鉴权失败' })
    expect(larkState.closedWith).toEqual({ force: true })

    await transport.start(ACCOUNT)
    expect(statuses.at(-1)?.status).toBe('connecting')
  })

  it('首次连接超过截止时间会关闭并释放旧 session，迟到 ready 不污染重试', async () => {
    vi.useFakeTimers()
    const transport = new FeishuTransport()
    const statuses: Array<{ status: string; error?: string }> = []
    transport.onStatus((_accountId, status, error) => statuses.push({ status, error }))
    await transport.start(ACCOUNT)
    const staleOptions = larkState.wsOptions

    await vi.advanceTimersByTimeAsync(FEISHU_CONNECTION_DEADLINE_MS)

    expect(statuses.at(-1)?.status).toBe('error')
    expect(statuses.at(-1)?.error).toContain('订阅 im.message.receive_v1')
    expect(statuses.at(-1)?.error).toContain('重新连接')
    expect(larkState.closedWith).toEqual({ force: true })

    await transport.start(ACCOUNT)
    const retryOptions = larkState.wsOptions
    expect(statuses.at(-1)?.status).toBe('connecting')
    ;(staleOptions?.onReady as (() => void) | undefined)?.()
    expect(statuses.at(-1)?.status).toBe('connecting')
    ;(retryOptions?.onReady as (() => void) | undefined)?.()
    expect(statuses.at(-1)?.status).toBe('online')
    await transport.stop(ACCOUNT.id)
  })

  it('断线重连超过截止时间进入可恢复 error，迟到 reconnected 被隔离', async () => {
    vi.useFakeTimers()
    const transport = new FeishuTransport()
    const statuses: Array<{ status: string; error?: string }> = []
    transport.onStatus((_accountId, status, error) => statuses.push({ status, error }))
    await transport.start(ACCOUNT)
    const staleOptions = larkState.wsOptions
    ;(staleOptions?.onReady as (() => void) | undefined)?.()
    ;(staleOptions?.onReconnecting as (() => void) | undefined)?.()

    await vi.advanceTimersByTimeAsync(FEISHU_CONNECTION_DEADLINE_MS)

    expect(statuses.at(-1)?.status).toBe('error')
    expect(statuses.at(-1)?.error).toContain('30 秒内未恢复')
    expect(larkState.closedWith).toEqual({ force: true })
    ;(staleOptions?.onReconnected as (() => void) | undefined)?.()
    expect(statuses.at(-1)?.status).toBe('error')
  })

  it('同一 message_id 重投只驱动一次入站回合', async () => {
    const transport = new FeishuTransport()
    const inbound: InboundChannelMessage[] = []
    let releaseDurableEnqueue!: () => void
    const durableEnqueue = new Promise<void>((resolve) => { releaseDurableEnqueue = resolve })
    transport.onMessage(async (message) => {
      inbound.push(message)
      await durableEnqueue
    })
    await transport.start(ACCOUNT)

    const event = {
      message: {
        message_id: 'om-inbound-1',
        chat_type: 'p2p',
        chat_id: 'oc-chat',
        message_type: 'text',
        content: JSON.stringify({ text: '检查发布' }),
        mentions: []
      },
      sender: { sender_id: { open_id: 'ou-owner' } }
    }
    const handler = larkState.eventHandlers['im.message.receive_v1']
    let acknowledged = false
    const firstDelivery = handler(event).then(() => { acknowledged = true })
    await vi.waitFor(() => expect(inbound).toHaveLength(1))
    expect(acknowledged).toBe(false)
    releaseDurableEnqueue()
    await firstDelivery
    await handler(event)

    expect(inbound).toHaveLength(1)
    expect(inbound[0]).toMatchObject({
      accountId: ACCOUNT.id,
      deliveryId: 'om-inbound-1',
      chatType: 'private',
      chatId: 'oc-chat',
      userId: 'ou-owner',
      text: '检查发布'
    })
  })

  it('durable enqueue 失败时不把 message_id 记为已处理，允许平台重投', async () => {
    const transport = new FeishuTransport()
    let attempts = 0
    const inbound: InboundChannelMessage[] = []
    transport.onMessage((message) => {
      attempts += 1
      if (attempts === 1) throw new Error('inbox disk unavailable')
      inbound.push(message)
    })
    await transport.start(ACCOUNT)
    const handler = larkState.eventHandlers['im.message.receive_v1']
    const event = {
      message: {
        message_id: 'om-retry-1',
        chat_type: 'p2p',
        chat_id: 'oc-chat',
        message_type: 'text',
        content: JSON.stringify({ text: '重试' }),
        mentions: []
      },
      sender: { sender_id: { open_id: 'ou-owner' } }
    }
    await expect(handler(event)).rejects.toThrow('inbox disk unavailable')
    await handler(event)
    expect(attempts).toBe(2)
    expect(inbound).toHaveLength(1)
  })

  it('最终长回复按 4000 字符完整分片，更新原气泡后顺序续发', async () => {
    const transport = new FeishuTransport()
    await transport.start(ACCOUNT)
    const placeholder = await transport.send({
      accountId: ACCOUNT.id,
      chatType: 'private',
      chatId: 'oc-chat',
      segments: [{ type: 'text', data: { text: '处理中…' } }],
      streaming: true
    })
    larkState.createRequests = []

    const content = `${'甲'.repeat(3_990)}\n${'乙'.repeat(3_990)}😀${'丙'.repeat(100)}`
    const chunks = splitFeishuText(content)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true)
    expect(chunks.join('')).toBe(content)

    await transport.updateMessage({
      accountId: ACCOUNT.id,
      chatType: 'private',
      chatId: 'oc-chat',
      messageId: placeholder.messageId!,
      content,
      final: true
    })

    const updated = JSON.parse(larkState.updateRequests[0].data.content) as { text: string }
    const continued = larkState.createRequests.map((request) => (
      JSON.parse(request.data.content) as { text: string }
    ).text)
    expect(updated.text).toBe(chunks[0])
    expect(continued).toEqual(chunks.slice(1))
    expect([updated.text, ...continued].join('')).toBe(content)
  })

  it('图片消息使用 messageResource 官方接口下载为临时文件并可清理', async () => {
    const transport = new FeishuTransport()
    const inbound: InboundChannelMessage[] = []
    transport.onMessage((message) => { inbound.push(message) })
    await transport.start(ACCOUNT)
    await larkState.eventHandlers['im.message.receive_v1']({
      message: {
        message_id: 'om-image-1',
        chat_type: 'p2p',
        chat_id: 'oc-chat',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img-key-1' }),
        mentions: []
      },
      sender: { sender_id: { open_id: 'ou-owner' } }
    })

    expect(inbound[0].segments).toEqual([{ type: 'image', data: { file_id: 'img-key-1' } }])
    const materialized = await transport.materializeInboundAttachments(inbound[0])
    expect(larkState.resourceRequests).toEqual([{
      params: { type: 'image' },
      path: { message_id: 'om-image-1', file_key: 'img-key-1' }
    }])
    expect(await readFile(materialized!.files[0], 'utf8')).toBe('pngdata')
    expect(materialized!.files[0]).toMatch(/01-diagram\.png$/)
    await materialized!.cleanup()
    await expect(access(materialized!.files[0])).rejects.toThrow()
  })

  it('缺失或格式错误的凭证同步拒绝，不伪装成已启动', async () => {
    const transport = new FeishuTransport()
    await expect(transport.start({ ...ACCOUNT, credentials: {} })).rejects.toThrow('缺少 app_id / app_secret')
    await expect(transport.start({
      ...ACCOUNT,
      credentials: { app_id: 'not-a-cli-id', app_secret: 'secret' }
    })).rejects.toThrow('飞书 App ID 格式无效')
  })
})
