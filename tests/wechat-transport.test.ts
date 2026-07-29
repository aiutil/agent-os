import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelAccount } from '../src/shared/types'
import {
  splitWeChatText,
  validateWeChatBaseUrl,
  WeChatTransport,
  weChatMessageToInbound
} from '../src/main/domains/channels/wechat-transport'

const temporaryDirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentos-wechat-test-'))
  temporaryDirs.push(dir)
  return dir
}

describe('SPEC-034 微信 iLink transport', () => {
  it('cursor 文件损坏时 fail closed，不从空游标静默重放', async () => {
    const stateDir = await makeStateDir()
    await writeFile(join(stateDir, 'wechat-corrupt.cursor.json'), '{broken')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const transport = new WeChatTransport(stateDir, '0.3.0-test')
    await expect(transport.start({
      id: 'wechat-corrupt',
      platform: 'wechat',
      alias: '微信',
      enabled: true,
      credentials: {
        bot_id: 'bot@im.wechat',
        token: 'wechat-token',
        base_url: 'https://ilinkai.weixin.qq.com'
      }
    })).rejects.toThrow('cursor 状态文件损坏')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('扫码需要手机数字验证码时在同一流程继续，并返回受信任凭证', async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      requests.push({ url, init })
      expect(init?.redirect).toBe('error')
      if (url.pathname.endsWith('/get_bot_qrcode')) {
        return new Response(JSON.stringify({ qrcode: 'qr-token', qrcode_img_content: 'https://weixin.qq.com/q/abc' }))
      }
      if (!url.searchParams.has('verify_code')) {
        return new Response(JSON.stringify({ status: 'need_verifycode' }))
      }
      return new Response(JSON.stringify({
        status: 'confirmed',
        bot_token: 'wechat-token',
        ilink_bot_id: 'bot@im.wechat',
        ilink_user_id: 'owner-user',
        baseurl: 'https://sh.ilinkai.weixin.qq.com'
      }))
    }))
    const qrCodes: string[] = []
    const requestVerificationCode = vi.fn(async () => '123456')
    const transport = new WeChatTransport(await makeStateDir())

    const result = await transport.startOnboarding!({
      signal: new AbortController().signal,
      onQrCode: ({ url }) => qrCodes.push(url),
      requestVerificationCode
    })

    expect(qrCodes).toEqual(['https://weixin.qq.com/q/abc'])
    expect(requestVerificationCode).toHaveBeenCalledWith('请输入手机微信显示的数字验证码')
    expect(requests.at(-1)?.url.searchParams.get('verify_code')).toBe('123456')
    expect(requests[0].init?.headers).toMatchObject({
      'iLink-App-Id': 'bot',
      AuthorizationType: 'ilink_bot_token'
    })
    expect(result).toEqual({
      appId: 'bot@im.wechat',
      appSecret: 'wechat-token',
      userOpenId: 'owner-user',
      alias: '微信',
      extraCredentials: { base_url: 'https://sh.ilinkai.weixin.qq.com/' }
    })
  })

  it('拒绝把 bearer token 发送到扫码响应指定的非腾讯地址', () => {
    expect(() => validateWeChatBaseUrl('https://evil.example/collect')).toThrow('受信任')
    expect(() => validateWeChatBaseUrl('http://ilinkai.weixin.qq.com')).toThrow('受信任')
    expect(validateWeChatBaseUrl('https://ilinkai.weixin.qq.com')).toBe('https://ilinkai.weixin.qq.com/')
  })

  it('私聊长轮询持久化游标，并用对应 context_token 完整分片回复', async () => {
    const stateDir = await makeStateDir()
    const inbound: unknown[] = []
    const statuses: string[] = []
    const sentBodies: Array<Record<string, unknown>> = []
    let releaseDurableEnqueue!: () => void
    const durableEnqueue = new Promise<void>((resolve) => { releaseDurableEnqueue = resolve })
    let pollCount = 0
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(init?.redirect).toBe('error')
      if (url.pathname.endsWith('/getupdates')) {
        pollCount += 1
        if (pollCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            ret: 0,
            get_updates_buf: 'cursor-1',
            longpolling_timeout_ms: 35_000,
            msgs: [{
              message_id: 7,
              from_user_id: 'wx-user',
              context_token: 'context-secret',
              item_list: [{ type: 1, text_item: { text: '检查状态' } }]
            }]
          })))
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      sentBodies.push(body)
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer wechat-token' })
      return Promise.resolve(new Response(JSON.stringify({ ret: 0 })))
    }))

    const transport = new WeChatTransport(stateDir, '0.3.0-test')
    transport.onMessage(async (message) => {
      inbound.push(message)
      await durableEnqueue
    })
    transport.onStatus((_accountId, status) => statuses.push(status))
    const account: ChannelAccount = {
      id: 'wechat-1',
      platform: 'wechat',
      alias: '微信',
      enabled: true,
      credentials: {
        bot_id: 'bot@im.wechat',
        token: 'wechat-token',
        base_url: 'https://ilinkai.weixin.qq.com'
      }
    }
    await transport.start(account)
    await vi.waitFor(() => expect(inbound).toHaveLength(1))
    await expect(readFile(join(stateDir, 'wechat-1.cursor.json'), 'utf8')).rejects.toThrow()
    expect(inbound[0]).toMatchObject({ deliveryId: '7' })
    releaseDurableEnqueue()
    await vi.waitFor(async () => {
      const cursor = JSON.parse(await readFile(join(stateDir, 'wechat-1.cursor.json'), 'utf8')) as { cursor: string }
      expect(cursor.cursor).toBe('cursor-1')
    })
    expect(statuses).toContain('online')
    expect(inbound[0]).toMatchObject({
      platform: 'wechat',
      chatType: 'private',
      chatId: 'wx-user',
      userId: 'wx-user',
      text: '检查状态'
    })
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(stateDir, 'wechat-1.cursor.json'), 'utf8')) as { cursor: string }
      expect(saved.cursor).toBe('cursor-1')
    })

    const reply = `${'甲'.repeat(3_990)}\n${'乙'.repeat(3_990)}😀`
    const chunks = splitWeChatText(reply)
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true)
    expect(chunks.join('')).toBe(reply)
    await transport.send({
      accountId: account.id,
      chatType: 'private',
      chatId: 'wx-user',
      segments: [{ type: 'text', data: { text: reply } }]
    })
    const sentMessages = sentBodies.map((body) => body.msg as {
      context_token: string
      item_list: Array<{ text_item: { text: string } }>
    })
    expect(sentMessages.every((message) => message.context_token === 'context-secret')).toBe(true)
    expect(sentMessages.map((message) => message.item_list[0].text_item.text)).toEqual(chunks)
    expect(sentBodies.every((body) => (body.base_info as { bot_agent: string }).bot_agent === 'AgentOS/0.3.0-test'))
    await transport.stop(account.id)
    expect(statuses.at(-1)).toBe('disconnected')
  })

  it('stop 等待正在进行的 cursor 原子写，不能提前返回造成快速重启重放', async () => {
    const stateDir = await makeStateDir()
    let pollCount = 0
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/getupdates')) throw new Error(`unexpected request ${url}`)
      pollCount += 1
      if (pollCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ ret: 0, get_updates_buf: 'cursor-stop' })))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }))
    const transport = new WeChatTransport(stateDir, '0.3.0-test')
    const internal = transport as unknown as {
      saveCursor(accountId: string, cursor: string): Promise<void>
    }
    const originalSave = internal.saveCursor.bind(transport)
    let releaseWrite!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    let saveStarted = false
    internal.saveCursor = async (accountId, cursor) => {
      saveStarted = true
      await writeGate
      await originalSave(accountId, cursor)
    }
    const account: ChannelAccount = {
      id: 'wechat-stop',
      platform: 'wechat',
      alias: '微信',
      enabled: true,
      credentials: {
        bot_id: 'bot@im.wechat',
        token: 'wechat-token',
        base_url: 'https://ilinkai.weixin.qq.com'
      }
    }
    await transport.start(account)
    await vi.waitFor(() => expect(saveStarted).toBe(true))
    let stopped = false
    const stopping = transport.stop(account.id).then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    releaseWrite()
    await stopping
    const persisted = JSON.parse(await readFile(join(stateDir, 'wechat-stop.cursor.json'), 'utf8')) as { cursor: string }
    expect(persisted.cursor).toBe('cursor-stop')
  })

  it('durable enqueue 失败时不推进 cursor，保留给微信重投', async () => {
    const stateDir = await makeStateDir()
    let attempts = 0
    let pollCount = 0
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (!url.pathname.endsWith('/getupdates')) throw new Error(`unexpected request ${url}`)
      pollCount += 1
      if (pollCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          ret: 0,
          get_updates_buf: 'must-not-save',
          msgs: [{
            message_id: 10,
            from_user_id: 'wx-user',
            context_token: 'context-secret',
            item_list: [{ type: 1, text_item: { text: 'retry' } }]
          }]
        })))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }))
    const transport = new WeChatTransport(stateDir, '0.3.0-test')
    transport.onMessage(() => {
      attempts += 1
      throw new Error('inbox disk unavailable')
    })
    const account: ChannelAccount = {
      id: 'wechat-inbox-fail',
      platform: 'wechat',
      alias: '微信',
      enabled: true,
      credentials: {
        bot_id: 'bot@im.wechat',
        token: 'wechat-token',
        base_url: 'https://ilinkai.weixin.qq.com'
      }
    }
    await transport.start(account)
    await vi.waitFor(() => expect(attempts).toBe(1))
    await expect(readFile(join(stateDir, 'wechat-inbox-fail.cursor.json'), 'utf8')).rejects.toThrow()
    await transport.stop(account.id)
  })

  it('只声明私聊：群消息不猜测路由，语音转写按文本进入', () => {
    expect(weChatMessageToInbound('a1', {
      from_user_id: 'u1',
      group_id: 'group-1',
      item_list: [{ type: 1, text_item: { text: '群消息' } }]
    })).toBeNull()
    expect(weChatMessageToInbound('a1', {
      from_user_id: 'u1',
      item_list: [{ type: 3, voice_item: { text: '语音转写' } }]
    })).toMatchObject({ text: '语音转写', segments: [{ type: 'text', data: { text: '语音转写' } }] })
  })

  it('sendmessage HTTP 200 但业务码失败时不误报已回复', async () => {
    let pollCount = 0
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/getupdates')) {
        pollCount += 1
        if (pollCount === 1) {
          return Promise.resolve(new Response(JSON.stringify({
            ret: 0,
            msgs: [{
              message_id: 9,
              from_user_id: 'wx-user',
              context_token: 'context-secret',
              item_list: [{ type: 1, text_item: { text: '在吗' } }]
            }]
          })))
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      }
      return Promise.resolve(new Response(JSON.stringify({ ret: 3201, errmsg: 'context token expired' })))
    }))
    const transport = new WeChatTransport(await makeStateDir())
    const inbound: unknown[] = []
    transport.onMessage((message) => { inbound.push(message) })
    const account: ChannelAccount = {
      id: 'wechat-business-error',
      platform: 'wechat',
      alias: '微信',
      enabled: true,
      credentials: {
        bot_id: 'bot@im.wechat',
        token: 'wechat-token',
        base_url: 'https://ilinkai.weixin.qq.com'
      }
    }
    await transport.start(account)
    await vi.waitFor(() => expect(inbound).toHaveLength(1))
    await expect(transport.send({
      accountId: account.id,
      chatType: 'private',
      chatId: 'wx-user',
      segments: [{ type: 'text', data: { text: '回复' } }]
    })).rejects.toThrow('微信消息发送失败：context token expired')
    await transport.stop(account.id)
  })
})
