// SPEC-034：消息渠道 durable inbox。
// 平台事件只有在 enqueue() 原子落盘后才能 ACK；SDK raw event/凭据不进入文件。

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { InboundChannelMessage } from './transport'

const INBOX_SCHEMA_VERSION = 1
const MAX_INBOX_ENTRIES = 1_000
const MAX_COMPLETED_DELIVERIES = 2_000
const MAX_STORED_MESSAGE_BYTES = 1_000_000

export type StoredInboundChannelMessage = Omit<InboundChannelMessage, 'raw'>
export type ChannelInboxStatus = 'queued' | 'dispatching' | 'recovery'

export interface ChannelInboxEntry {
  id: string
  deliveryKey: string
  message: StoredInboundChannelMessage
  status: ChannelInboxStatus
  receivedAt: string
  updatedAt: string
}

interface CompletedDelivery {
  deliveryKey: string
  completedAt: string
}

export interface ChannelInboxState {
  schemaVersion: 1
  entries: ChannelInboxEntry[]
  completed: CompletedDelivery[]
}

function initialState(): ChannelInboxState {
  return { schemaVersion: INBOX_SCHEMA_VERSION, entries: [], completed: [] }
}

function deliveryKey(message: Pick<InboundChannelMessage, 'platform' | 'accountId' | 'deliveryId'>): string {
  if (!message.deliveryId || message.deliveryId.length > 512) {
    throw new Error('渠道消息缺少有效 deliveryId，已拒绝确认以等待平台重试')
  }
  return `${message.platform}\u0000${message.accountId}\u0000${message.deliveryId}`
}

function storedMessage(message: InboundChannelMessage): StoredInboundChannelMessage {
  const stored = { ...message }
  delete stored.raw
  const bytes = Buffer.byteLength(JSON.stringify(stored), 'utf8')
  if (bytes > MAX_STORED_MESSAGE_BYTES) throw new Error('渠道消息超过 inbox 持久化上限')
  return stored
}

function parseState(raw: string): ChannelInboxState {
  const value = JSON.parse(raw) as Partial<ChannelInboxState>
  if (value.schemaVersion !== INBOX_SCHEMA_VERSION || !Array.isArray(value.entries) || !Array.isArray(value.completed)) {
    throw new Error('schema 不兼容')
  }
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object' ||
      typeof entry.id !== 'string' || typeof entry.deliveryKey !== 'string' ||
      !['queued', 'dispatching', 'recovery'].includes(entry.status) ||
      !entry.message || typeof entry.message !== 'object' ||
      typeof entry.message.deliveryId !== 'string' || Object.hasOwn(entry.message, 'raw') ||
      entry.deliveryKey !== deliveryKey(entry.message)) {
      throw new Error('entry 损坏')
    }
  }
  for (const item of value.completed) {
    if (!item || typeof item.deliveryKey !== 'string' || typeof item.completedAt !== 'string') {
      throw new Error('completed 损坏')
    }
  }
  return value as ChannelInboxState
}

/** 单主进程同步状态机；每次变更先完整原子写，再替换内存真源。 */
export class ChannelInboundInbox {
  private state: ChannelInboxState
  private readonly loadError: Error | null

  constructor(
    private readonly filePath: string,
    private readonly maxCompletedDeliveries = MAX_COMPLETED_DELIVERIES
  ) {
    try {
      this.state = existsSync(filePath)
        ? parseState(readFileSync(filePath, 'utf8'))
        : initialState()
      if (existsSync(filePath)) chmodSync(filePath, 0o600)
      this.loadError = null
    } catch (error) {
      this.state = initialState()
      this.loadError = new Error(
        `消息 inbox 损坏；为避免重复执行已停止确认新消息。请关闭 Agent OS，备份并移走 ${filePath} 后重启：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  recoverInterrupted(): number {
    this.assertHealthy()
    const now = new Date().toISOString()
    const entries = this.state.entries.map((entry) =>
      entry.status === 'dispatching' ? { ...entry, status: 'recovery' as const, updatedAt: now } : entry
    )
    const recovered = entries.filter((entry, index) => entry !== this.state.entries[index]).length
    if (recovered) this.commit({ ...this.state, entries })
    return recovered
  }

  enqueue(message: InboundChannelMessage): 'queued' | 'duplicate' {
    this.assertHealthy()
    const key = deliveryKey(message)
    if (this.state.entries.some((entry) => entry.deliveryKey === key) ||
      this.state.completed.some((item) => item.deliveryKey === key)) return 'duplicate'
    if (this.state.entries.length >= MAX_INBOX_ENTRIES) {
      throw new Error('消息 inbox 已满，已拒绝确认以等待平台重试')
    }
    const now = new Date().toISOString()
    const entry: ChannelInboxEntry = {
      id: randomUUID(),
      deliveryKey: key,
      message: storedMessage(message),
      status: 'queued',
      receivedAt: now,
      updatedAt: now
    }
    this.commit({ ...this.state, entries: [...this.state.entries, entry] })
    return 'queued'
  }

  next(eligible: (entry: ChannelInboxEntry) => boolean = () => true): ChannelInboxEntry | null {
    this.assertHealthy()
    return this.state.entries.find((entry) => entry.status === 'recovery' && eligible(entry)) ??
      this.state.entries.find((entry) => entry.status === 'queued' && eligible(entry)) ?? null
  }

  markDispatching(id: string): void {
    this.transition(id, 'queued', 'dispatching')
  }

  /** 会话已有活跃回合时退回 durable queued；真正启动排队回合前再置 dispatching。 */
  markQueued(id: string): void {
    this.transition(id, 'dispatching', 'queued')
  }

  markRecovery(id: string): void {
    const current = this.state.entries.find((entry) => entry.id === id)
    if (!current || current.status === 'recovery') return
    this.transition(id, 'dispatching', 'recovery')
  }

  markCompleted(id: string): void {
    this.assertHealthy()
    const entry = this.state.entries.find((item) => item.id === id)
    if (!entry) return
    const completed = [
      ...this.state.completed.filter((item) => item.deliveryKey !== entry.deliveryKey),
      { deliveryKey: entry.deliveryKey, completedAt: new Date().toISOString() }
    ].slice(-this.maxCompletedDeliveries)
    this.commit({
      ...this.state,
      entries: this.state.entries.filter((item) => item.id !== id),
      completed
    })
  }

  removeAccount(accountId: string): void {
    this.assertHealthy()
    const entries = this.state.entries.filter((entry) => entry.message.accountId !== accountId)
    const completed = this.state.completed.filter((item) => item.deliveryKey.split('\u0000')[1] !== accountId)
    if (entries.length !== this.state.entries.length || completed.length !== this.state.completed.length) {
      this.commit({ ...this.state, entries, completed })
    }
  }

  snapshot(): ChannelInboxState {
    return structuredClone(this.state)
  }

  private transition(id: string, from: ChannelInboxStatus, to: ChannelInboxStatus): void {
    this.assertHealthy()
    const index = this.state.entries.findIndex((entry) => entry.id === id)
    if (index === -1 || this.state.entries[index].status !== from) {
      throw new Error(`消息 inbox 状态转换无效：${from} → ${to}`)
    }
    const entries = [...this.state.entries]
    entries[index] = { ...entries[index], status: to, updatedAt: new Date().toISOString() }
    this.commit({ ...this.state, entries })
  }

  private assertHealthy(): void {
    if (this.loadError) throw this.loadError
  }

  private commit(next: ChannelInboxState): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    let fd: number | null = null
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(next), 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
      if (process.platform !== 'win32') {
        const directoryFd = openSync(dirname(this.filePath), 'r')
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      }
      this.state = next
    } catch (error) {
      if (fd !== null) closeSync(fd)
      try { unlinkSync(temporary) } catch { /* ignore cleanup failure */ }
      throw error
    }
  }
}
