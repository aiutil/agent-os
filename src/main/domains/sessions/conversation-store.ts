// 对话（多段 CLI）仓储（SPEC-017）。
// Conversation 是 SPEC-017 引入的逻辑会话实体，每次切换 CLI 追加新 ConversationSegment。
// WorkbenchSession 由此派生，保持向后兼容。

import { randomUUID } from 'node:crypto'
import { getConversations, setConversations } from '../../store/app-store'
import type {
  Conversation,
  ConversationSegment,
  CreateSessionInput,
  PermissionPreset,
  UpdateSessionPatch,
  WorkbenchSession
} from '@shared/types'

// ─── helpers ──────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString()
}

export function convToSession(conv: Conversation): WorkbenchSession {
  const lastSeg = conv.segments[conv.segments.length - 1]
  return {
    id: conv.id,
    name: conv.name,
    ...(conv.nameProvisional !== undefined ? { nameProvisional: conv.nameProvisional } : {}),
    toolId: lastSeg?.toolId ?? '',
    workspacePath: conv.workspacePath,
    terminalSessionId: conv.terminalSessionId ?? null,
    nativeSessionId: lastSeg?.nativeSessionId ?? null,
    surface: conv.surface ?? 'terminal',
    permissionPreset: conv.permissionPreset ?? 'safe',
    ...(conv.memoryUse !== undefined ? { memoryUse: conv.memoryUse } : {}),
    ...(conv.memoryGenerate !== undefined ? { memoryGenerate: conv.memoryGenerate } : {}),
    ...(conv.model ? { model: conv.model } : {}),
    ...(conv.reasoningEffort ? { reasoningEffort: conv.reasoningEffort } : {}),
    ...(conv.relaySource ? { relaySource: conv.relaySource } : {}),
    ...(conv.relayTarget ? { relayTarget: conv.relayTarget } : {}),
    ...(conv.rootTitle ? { rootTitle: conv.rootTitle } : {}),
    ...(conv.source ? { source: conv.source } : {}),
    ...(conv.channelBinding ? { channelBinding: conv.channelBinding } : {}),
    favorite: conv.favorite,
    pinned: conv.pinned ?? false,
    segments: conv.segments,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    ...(conv.archivedAt ? { archivedAt: conv.archivedAt } : {})
  }
}

// ─── read ──────────────────────────────────────────────────────────────────

export function listConversations(): Conversation[] {
  return getConversations()
}

export function getConversation(id: string): Conversation | null {
  return getConversations().find((c) => c.id === id) ?? null
}

export function listSessions(): WorkbenchSession[] {
  return getConversations().map(convToSession)
}

export function getSession(id: string): WorkbenchSession | null {
  const conv = getConversation(id)
  return conv ? convToSession(conv) : null
}

// ─── write ─────────────────────────────────────────────────────────────────

export function createSession(input: CreateSessionInput): WorkbenchSession {
  const t = now()
  const segment: ConversationSegment = {
    id: randomUUID(),
    toolId: input.toolId,
    nativeSessionId: null,
    startedAt: t,
    endedAt: null
  }
  const conv: Conversation = {
    id: randomUUID(),
    name: input.name.trim() || '未命名会话',
    // SPEC-035：显式占位标记优先；未给时空名（回落「未命名会话」）也视为占位，允许后续真实意图覆盖。
    nameProvisional: input.nameProvisional ?? !input.name.trim(),
    workspacePath: input.workspacePath,
    favorite: false,
    segments: [segment],
    createdAt: t,
    updatedAt: t,
    terminalSessionId: null,
    surface: input.surface ?? 'terminal',
    permissionPreset: input.permissionPreset ?? 'safe',
    ...(input.memoryUse !== undefined ? { memoryUse: input.memoryUse } : {}),
    ...(input.memoryGenerate !== undefined ? { memoryGenerate: input.memoryGenerate } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.relaySource ? { relaySource: input.relaySource } : {}),
    ...(input.relayTarget ? { relayTarget: input.relayTarget } : {}),
    ...(input.rootTitle ? { rootTitle: input.rootTitle } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.channelBinding ? { channelBinding: input.channelBinding } : {}),
    pinned: false
  }
  setConversations([conv, ...getConversations()])
  return convToSession(conv)
}

export function bindNativeSession(id: string, nativeSessionId: string | null): WorkbenchSession | null {
  const convs = getConversations()
  const idx = convs.findIndex((c) => c.id === id)
  if (idx === -1) return null
  const conv = convs[idx]
  const segs = [...conv.segments]
  if (segs.length === 0) return null
  segs[segs.length - 1] = { ...segs[segs.length - 1], nativeSessionId }
  convs[idx] = { ...conv, segments: segs, updatedAt: now() }
  setConversations(convs)
  return convToSession(convs[idx])
}

export function updateSession(id: string, patch: UpdateSessionPatch): WorkbenchSession | null {
  const convs = getConversations()
  const idx = convs.findIndex((c) => c.id === id)
  if (idx === -1) return null
  const conv = convs[idx]
  convs[idx] = {
    ...conv,
    ...(patch.name !== undefined ? { name: patch.name.trim() || conv.name } : {}),
    ...(patch.nameProvisional !== undefined ? { nameProvisional: patch.nameProvisional } : {}),
    ...(patch.model !== undefined ? { model: patch.model || undefined } : {}),
    ...(patch.reasoningEffort !== undefined
      ? { reasoningEffort: patch.reasoningEffort || undefined }
      : {}),
    ...(patch.relaySource !== undefined ? { relaySource: patch.relaySource ?? undefined } : {}),
    ...(patch.relayTarget !== undefined ? { relayTarget: patch.relayTarget ?? undefined } : {}),
    ...(patch.rootTitle !== undefined ? { rootTitle: patch.rootTitle || undefined } : {}),
    ...(patch.favorite !== undefined ? { favorite: patch.favorite } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(patch.surface !== undefined ? { surface: patch.surface } : {}),
    ...(patch.permissionPreset !== undefined ? { permissionPreset: patch.permissionPreset as PermissionPreset } : {}),
    ...(patch.memoryUse !== undefined ? { memoryUse: patch.memoryUse } : {}),
    ...(patch.memoryGenerate !== undefined ? { memoryGenerate: patch.memoryGenerate } : {}),
    ...(patch.archived !== undefined
      ? (patch.archived ? { archivedAt: now() } : { archivedAt: undefined })
      : {}),
    updatedAt: now()
  }
  setConversations(convs)
  return convToSession(convs[idx])
}

export function attachTerminal(id: string, terminalSessionId: string | null): WorkbenchSession | null {
  const convs = getConversations()
  const idx = convs.findIndex((c) => c.id === id)
  if (idx === -1) return null
  convs[idx] = { ...convs[idx], terminalSessionId, updatedAt: now() }
  setConversations(convs)
  return convToSession(convs[idx])
}

export function removeSession(id: string): void {
  setConversations(getConversations().filter((c) => c.id !== id))
}

// ─── SPEC-017: segment switch ───────────────────────────────────────────────

/**
 * 结束当前末段，追加新 CLI 段落，返回更新后的会话。
 * handoffDocPath 可选；由调用方写入交接文档后传入。
 */
export function appendSegment(
  id: string,
  targetToolId: string,
  handoffDocPath?: string
): WorkbenchSession | null {
  const convs = getConversations()
  const idx = convs.findIndex((c) => c.id === id)
  if (idx === -1) return null
  const conv = convs[idx]
  const t = now()

  // 结束当前末段
  const segs = [...conv.segments]
  if (segs.length > 0) {
    segs[segs.length - 1] = { ...segs[segs.length - 1], endedAt: t }
  }

  // 新段
  const newSeg: ConversationSegment = {
    id: randomUUID(),
    toolId: targetToolId,
    nativeSessionId: null,
    startedAt: t,
    endedAt: null,
    ...(handoffDocPath ? { handoffDocPath } : {})
  }
  segs.push(newSeg)

  convs[idx] = {
    ...conv,
    segments: segs,
    // 切换 CLI 后镜头自动切为 chat（新 CLI 以聊天开启）
    surface: 'chat',
    // 清除旧终端关联
    terminalSessionId: null,
    updatedAt: t
  }
  setConversations(convs)
  return convToSession(convs[idx])
}
