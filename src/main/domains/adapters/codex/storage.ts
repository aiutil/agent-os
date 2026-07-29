import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AdapterSessionStorage,
  NormalizedMessage,
  NormalizedTranscript
} from '../../../../shared/types/transcript'
import {
  asRecord,
  asString,
  compactJson,
  createTranscriptStream,
  fallbackTitle,
  listTranscriptFiles,
  visitJsonRecords,
  type DraftMessage
} from '../storage-utils'
import { deriveTranscriptTitle, isHumanTranscriptText } from '@shared/transcript/title'
import { createCodexUsageCollector } from '../../stats/usage'

const ROOT = join(homedir(), '.codex', 'sessions')
const SKIPPED_RECORD_TYPES = new Set(['event_msg', 'session_meta', 'turn_context'])

export const codexSessionStorage: AdapterSessionStorage = {
  support: 'full',
  rootDirs: () => [ROOT],
  locateDir() {
    return existsSync(ROOT) ? ROOT : null
  },
  listSessionFiles(dir) {
    return listTranscriptFiles(dir, 'codex')
  },
  parseTranscript(path, options) {
    return createTranscriptStream(path, parseCodexRecord, options, createCodexUsageCollector())
  },
  async readMeta(path) {
    let nativeSessionId: string | undefined
    let cwd: string | null = null
    let firstUserMessage: string | undefined
    let startedAt: string | null = null

    await visitJsonRecords(path, (record) => {
      const payload = asRecord(record.payload)
      if (record.type === 'session_meta') {
        nativeSessionId ??= asString(payload?.id)
        cwd ??= asString(payload?.cwd) ?? null
        startedAt ??= asString(payload?.timestamp) ?? asString(record.timestamp) ?? null
      }
      if (
        !firstUserMessage &&
        record.type === 'response_item' &&
        payload?.type === 'message' &&
        payload.role === 'user'
      ) {
        const candidate = firstCodexText(payload.content)
        if (candidate && isHumanTranscriptText(candidate) && !isCodexInjectedContext(candidate)) {
          firstUserMessage = candidate
        }
      }
    })

    return {
      nativeSessionId: nativeSessionId ?? fallbackTitle(path),
      cwd,
      title: deriveTranscriptTitle({ firstHumanText: firstUserMessage, fallback: fallbackTitle(path) }),
      startedAt
    } satisfies Pick<NormalizedTranscript, 'nativeSessionId' | 'cwd' | 'title' | 'startedAt'>
  }
}

function parseCodexRecord(record: Record<string, unknown>): DraftMessage[] {
  const recordType = asString(record.type) ?? 'unknown'
  if (SKIPPED_RECORD_TYPES.has(recordType)) return []

  const timestamp = asString(record.timestamp)
  if (recordType !== 'response_item') {
    return [unsupported(recordType, timestamp)]
  }

  const payload = asRecord(record.payload)
  const kind = asString(payload?.type) ?? 'unknown-response-item'

  if (kind === 'message') {
    const role = normalizeRole(payload?.role)
    return textParts(payload?.content).map((text) => ({
      role,
      text,
      ts: timestamp,
      raw: { kind }
    }))
  }

  if (kind === 'function_call' || kind === 'custom_tool_call') {
    const toolName = asString(payload?.name) ?? 'unknown'
    return [
      {
        role: 'tool',
        text: `[tool: ${toolName}] ${compactJson(payload?.arguments ?? payload?.input)}`,
        toolName,
        ts: timestamp,
        raw: { kind }
      }
    ]
  }

  if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
    return [
      {
        role: 'tool',
        text: firstCodexText(payload?.output) ?? compactJson(payload?.output),
        ts: timestamp,
        raw: { kind }
      }
    ]
  }

  if (kind === 'reasoning') {
    return textParts(payload?.summary ?? payload?.content).map((text) => ({
      role: 'assistant',
      text,
      ts: timestamp,
      raw: { kind }
    }))
  }

  return [unsupported(kind, timestamp)]
}

function normalizeRole(value: unknown): NormalizedMessage['role'] {
  if (value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'system'
}

function textParts(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return item ? [item] : []
    const block = asRecord(item)
    const text = asString(block?.text) ?? asString(block?.content) ?? asString(block?.message)
    return text ? [text] : []
  })
}

function firstCodexText(value: unknown): string | undefined {
  return textParts(value)[0] ?? (typeof value === 'string' ? value : undefined)
}

// SPEC-035：codex 在真实用户消息前会注入若干 user 角色记录（AGENTS.md 指令、environment_context
// 等）。这些不是用户键入内容，挑「首条用户消息」做标题时必须跳过，否则标题变成「# AGENTS.md…」。
// 注：<environment_context>/<user_instructions> 已由 title.ts 整块剥离（isHumanTranscriptText 据此判空），
// 此处补「# AGENTS.md instructions…」这类未包 XML 的注入头。
const CODEX_INJECTED_CONTEXT_RE = /^#\s*AGENTS\.md\s+instructions\b/i

function isCodexInjectedContext(text: string): boolean {
  return CODEX_INJECTED_CONTEXT_RE.test(text.trimStart())
}

function unsupported(kind: string, timestamp: string | undefined): DraftMessage {
  return {
    role: 'system',
    text: `[unsupported: ${kind}]`,
    ts: timestamp,
    raw: { kind }
  }
}
