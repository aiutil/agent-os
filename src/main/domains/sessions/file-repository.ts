import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type {
  CreateSessionInput,
  ManagedChatMessage,
  ManagedChatMessageStatus,
  RuntimeSessionFileV2,
  UpdateSessionPatch,
  WorkbenchSession
} from '@shared/types'
import type { RuntimeSessionRepository } from '../runtime/protocol'

const SCHEMA_VERSION = 2 as const

export class FileSessionRepository implements RuntimeSessionRepository {
  constructor(
    private readonly filePath: string,
    initialSessions: WorkbenchSession[] = []
  ) {
    mkdirSync(dirname(filePath), { recursive: true })
    if (!existsSync(filePath)) this.write(initialSessions)
    else this.migrateIfNeeded()
  }

  listSessions(): WorkbenchSession[] {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as
        | WorkbenchSession[]
        | RuntimeSessionFileV2
      const sessions = Array.isArray(parsed) ? parsed : parsed.sessions
      return sessions.map((session) => this.normalize(session))
    } catch {
      return []
    }
  }

  getSession(id: string): WorkbenchSession | null {
    return this.listSessions().find((session) => session.id === id) ?? null
  }

  createSession(input: CreateSessionInput): WorkbenchSession {
    const now = new Date().toISOString()
    const created: WorkbenchSession = {
      id: randomUUID(),
      name: input.name.trim() || '未命名会话',
      // SPEC-035：显式占位标记优先；空名（回落「未命名会话」）也视为占位。
      nameProvisional: input.nameProvisional ?? !input.name.trim(),
      toolId: input.toolId,
      workspacePath: input.workspacePath,
      terminalSessionId: null,
      nativeSessionId: null,
      surface: input.surface ?? 'terminal',
      mode: input.surface === 'chat' ? 'chat' : 'cli',
      permissionPreset: input.permissionPreset ?? 'safe',
      // 会话级模型覆盖：之前 createSession 丢了 input.model，导致用户选的模型从未生效，
      // turn 永远回落 provider 默认（如 pi 的上次模型）。
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.relaySource ? { relaySource: input.relaySource } : {}),
      ...(input.relayTarget ? { relayTarget: input.relayTarget } : {}),
      ...(input.rootTitle ? { rootTitle: input.rootTitle } : {}),
      ...(input.memoryUse !== undefined ? { memoryUse: input.memoryUse } : {}),
      ...(input.memoryGenerate !== undefined ? { memoryGenerate: input.memoryGenerate } : {}),
      // SPEC-033/034：保留来源/host/渠道绑定——createSession 之前会丢这些字段，
      // 导致 channel 会话的 AgentEvent 路由失败（事件被发到渲染端而非渠道→飞书收不到 agent 回复）
      // 以及远程会话来源徽标缺失。
      ...(input.runtimeHostId ? { runtimeHostId: input.runtimeHostId } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.channelBinding ? { channelBinding: input.channelBinding } : {}),
      favorite: false,
      pinned: false,
      segments: [],
      chatHistory: [],
      linkedSessionId: null,
      createdAt: now,
      updatedAt: now
    }
    this.write([created, ...this.listSessions()])
    return created
  }

  bindNativeSession(id: string, nativeSessionId: string | null): WorkbenchSession | null {
    return this.replace(id, { nativeSessionId })
  }

  updateSession(id: string, patch: UpdateSessionPatch): WorkbenchSession | null {
    const current = this.getSession(id)
    if (!current) return null
    // SPEC-031: 归档/恢复只切换可见性，不代表用户活动，不应刷新 updatedAt
    // （否则 chat-only 会话的 lastActivityAt fallback 会让条目错误前移）。
    const bumpUpdatedAt = patch.archived === undefined
    return this.replace(
      id,
      {
        ...(patch.name !== undefined ? { name: patch.name.trim() || current.name } : {}),
        ...(patch.nameProvisional !== undefined ? { nameProvisional: patch.nameProvisional } : {}),
        ...(patch.model !== undefined ? { model: patch.model || undefined } : {}),
        ...(patch.reasoningEffort !== undefined
          ? { reasoningEffort: patch.reasoningEffort || undefined }
          : {}),
        ...(patch.relaySource !== undefined ? { relaySource: patch.relaySource ?? undefined } : {}),
        ...(patch.relayTarget !== undefined ? { relayTarget: patch.relayTarget ?? undefined } : {}),
        ...(patch.rootTitle !== undefined ? { rootTitle: patch.rootTitle || undefined } : {}),
        ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
        ...(patch.surface !== undefined
          ? { surface: patch.surface, mode: patch.surface === 'chat' ? 'chat' : 'cli' }
          : {}),
        ...(patch.permissionPreset !== undefined ? { permissionPreset: patch.permissionPreset } : {}),
        ...(patch.memoryUse !== undefined ? { memoryUse: patch.memoryUse } : {}),
        ...(patch.memoryGenerate !== undefined ? { memoryGenerate: patch.memoryGenerate } : {}),
        ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
        ...(patch.archived !== undefined
          ? (patch.archived ? { archivedAt: new Date().toISOString() } : { archivedAt: undefined })
          : {})
      },
      bumpUpdatedAt
    )
  }

  attachTerminal(id: string, terminalSessionId: string | null): WorkbenchSession | null {
    return this.replace(id, { terminalSessionId })
  }

  listChatHistory(id: string): ManagedChatMessage[] {
    return [...(this.getSession(id)?.chatHistory ?? [])]
  }

  appendChatMessage(
    id: string,
    message: Omit<ManagedChatMessage, 'id' | 'createdAt' | 'updatedAt'>
  ): ManagedChatMessage {
    const session = this.getSession(id)
    if (!session) throw new Error('会话不存在')
    const now = new Date().toISOString()
    const created: ManagedChatMessage = {
      ...message,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    }
    this.replace(id, { chatHistory: [...(session.chatHistory ?? []), created] })
    return created
  }

  updateChatMessage(
    id: string,
    messageId: string,
    patch: { text?: string; status?: ManagedChatMessageStatus }
  ): ManagedChatMessage | null {
    const session = this.getSession(id)
    if (!session) return null
    let updated: ManagedChatMessage | null = null
    const chatHistory = (session.chatHistory ?? []).map((message) => {
      if (message.id !== messageId) return message
      updated = {
        ...message,
        ...patch,
        updatedAt: new Date().toISOString()
      }
      return updated
    })
    if (!updated) return null
    this.replace(id, { chatHistory })
    return updated
  }

  linkSessions(sourceId: string, linkedId: string): void {
    this.replace(sourceId, { linkedSessionId: linkedId })
    this.replace(linkedId, { linkedSessionId: sourceId })
  }

  removeSession(id: string): void {
    this.write(this.listSessions().filter((session) => session.id !== id))
  }

  clearTerminalBindings(): void {
    const sessions = this.listSessions()
    if (!sessions.some((session) => session.terminalSessionId)) return
    this.write(
      sessions.map((session) => ({
        ...session,
        terminalSessionId: null
      }))
    )
  }

  markInterruptedChatMessages(): void {
    const sessions = this.listSessions()
    let changed = false
    const next = sessions.map((session) => ({
      ...session,
      chatHistory: (session.chatHistory ?? []).map((message) => {
        if (message.status !== 'streaming') return message
        changed = true
        return {
          ...message,
          status: 'interrupted' as const,
          updatedAt: new Date().toISOString()
        }
      })
    }))
    if (changed) this.write(next)
  }

  private replace(
    id: string,
    patch: Partial<WorkbenchSession>,
    bumpUpdatedAt = true
  ): WorkbenchSession | null {
    const sessions = this.listSessions()
    const index = sessions.findIndex((session) => session.id === id)
    if (index === -1) return null
    sessions[index] = {
      ...sessions[index],
      ...patch,
      ...(bumpUpdatedAt ? { updatedAt: new Date().toISOString() } : {})
    }
    this.write(sessions)
    return sessions[index]
  }

  private normalize(session: WorkbenchSession): WorkbenchSession {
    const surface = session.surface ?? (session.mode === 'chat' ? 'chat' : 'terminal')
      return {
      ...session,
      workspacePath: session.workspacePath?.trim() || homedir(),
      terminalSessionId: session.terminalSessionId ?? null,
      nativeSessionId: session.nativeSessionId ?? null,
      pinned: session.pinned ?? false,
      surface,
      mode: session.mode ?? (surface === 'chat' ? 'chat' : 'cli'),
      permissionPreset: session.permissionPreset ?? 'safe',
      favorite: session.favorite ?? false,
      ...(session.relaySource ? { relaySource: session.relaySource } : {}),
      ...(session.relayTarget ? { relayTarget: session.relayTarget } : {}),
      ...(session.rootTitle ? { rootTitle: session.rootTitle } : {}),
      segments: session.segments ?? [],
      chatHistory: session.chatHistory ?? [],
      linkedSessionId: session.linkedSessionId ?? null
    }
  }

  private migrateIfNeeded(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as WorkbenchSession[] | RuntimeSessionFileV2
      if (!Array.isArray(parsed) && parsed.schemaVersion === SCHEMA_VERSION) {
        const normalized = parsed.sessions.map((session) => this.normalize(session))
        if (JSON.stringify(normalized) !== JSON.stringify(parsed.sessions)) this.write(normalized)
        return
      }
      const backupPath = `${this.filePath}.v1.bak`
      if (!existsSync(backupPath)) copyFileSync(this.filePath, backupPath)
      const sessions = Array.isArray(parsed) ? parsed : parsed.sessions
      this.write(sessions.map((session) => this.normalize(session)))
    } catch {
      // 保留无法解析的原文件，运行时以空列表降级。
    }
  }

  private write(sessions: WorkbenchSession[]): void {
    const temporary = `${this.filePath}.${process.pid}.tmp`
    const payload: RuntimeSessionFileV2 = {
      schemaVersion: SCHEMA_VERSION,
      sessions: sessions.map((session) => this.normalize(session))
    }
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.filePath)
    chmodSync(this.filePath, 0o600)
  }
}
