import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelInboundInbox } from '../src/main/domains/channels/inbound-inbox'
import type { InboundChannelMessage } from '../src/main/domains/channels/transport'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryInbox(maxCompleted?: number): { file: string; inbox: ChannelInboundInbox } {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-inbox-'))
  temporaryDirectories.push(directory)
  const file = join(directory, 'channel-inbox.json')
  return { file, inbox: new ChannelInboundInbox(file, maxCompleted) }
}

function message(deliveryId: string): InboundChannelMessage {
  return {
    deliveryId,
    accountId: 'feishu-1',
    platform: 'feishu',
    chatType: 'private',
    chatId: 'chat-1',
    userId: 'user-1',
    mentioned: true,
    segments: [{ type: 'text', data: { text: '执行任务' } }],
    text: '执行任务',
    resumeContext: { message: { message_id: deliveryId } },
    raw: { token: 'must-not-persist', sdk: 'raw-event' }
  }
}

describe('SPEC-034 durable channel inbox', () => {
  it('durable enqueue 后文件为 0600，删除 raw 但保留最小恢复上下文', () => {
    const { file, inbox } = temporaryInbox()
    expect(inbox.enqueue(message('m1'))).toBe('queued')

    expect(statSync(file).mode & 0o777).toBe(0o600)
    const persisted = readFileSync(file, 'utf8')
    expect(persisted).not.toContain('must-not-persist')
    expect(persisted).not.toContain('raw-event')
    expect(JSON.parse(persisted).entries[0].message.resumeContext).toEqual({
      message: { message_id: 'm1' }
    })
  })

  it('queued 跨重启继续，dispatching 跨重启转 recovery 而不自动重放', () => {
    const { file, inbox } = temporaryInbox()
    inbox.enqueue(message('m1'))
    expect(new ChannelInboundInbox(file).next()?.status).toBe('queued')

    const entry = inbox.next()!
    inbox.markDispatching(entry.id)
    const restarted = new ChannelInboundInbox(file)
    expect(restarted.recoverInterrupted()).toBe(1)
    expect(restarted.next()).toMatchObject({ id: entry.id, status: 'recovery' })
  })

  it('completed delivery 跨重启去重，历史按上限裁剪', () => {
    const { file, inbox } = temporaryInbox(2)
    for (const id of ['m1', 'm2', 'm3']) {
      expect(inbox.enqueue(message(id))).toBe('queued')
      inbox.markCompleted(inbox.next()!.id)
    }
    const restarted = new ChannelInboundInbox(file, 2)
    expect(restarted.enqueue(message('m3'))).toBe('duplicate')
    expect(restarted.snapshot().completed.map((item) => item.deliveryKey)).toHaveLength(2)
    expect(restarted.snapshot().completed.some((item) => item.deliveryKey.endsWith('\u0000m1'))).toBe(false)
  })

  it('损坏文件 fail closed，不静默清空后重复执行', () => {
    const { file } = temporaryInbox()
    writeFileSync(file, '{broken', { mode: 0o644 })
    const inbox = new ChannelInboundInbox(file)
    expect(() => inbox.enqueue(message('m1'))).toThrow(/inbox 损坏/)
  })

  it('原子写失败时 enqueue 拒绝，内存也不提前接受消息', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-channel-inbox-fail-'))
    temporaryDirectories.push(directory)
    const parentFile = join(directory, 'not-a-directory')
    writeFileSync(parentFile, 'x')
    chmodSync(parentFile, 0o600)
    const inbox = new ChannelInboundInbox(join(parentFile, 'inbox.json'))
    expect(() => inbox.enqueue(message('m1'))).toThrow()
    expect(inbox.snapshot().entries).toHaveLength(0)
  })

  it('离线账号不会阻塞其他在线账号，删除账号同时清理 pending 与 dedupe 记录', () => {
    const { inbox } = temporaryInbox()
    inbox.enqueue(message('offline'))
    inbox.enqueue({ ...message('online'), accountId: 'feishu-2' })
    expect(inbox.next((entry) => entry.message.accountId === 'feishu-2')?.message.deliveryId).toBe('online')

    inbox.markCompleted(inbox.next((entry) => entry.message.accountId === 'feishu-2')!.id)
    inbox.removeAccount('feishu-1')
    expect(inbox.snapshot().entries).toHaveLength(0)
    inbox.removeAccount('feishu-2')
    expect(inbox.snapshot().completed).toHaveLength(0)
  })
})
