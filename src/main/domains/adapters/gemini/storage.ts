import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AdapterSessionStorage, NormalizedMessage, NormalizedTranscript } from '../../../../shared/types/transcript'
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

const ROOT = join(homedir(), '.gemini', 'tmp')

export const geminiSessionStorage: AdapterSessionStorage = {
  support: 'full',
  rootDirs: () => [ROOT],
  locateDir() {
    return existsSync(ROOT) ? ROOT : null
  },
  listSessionFiles(dir) {
    return listTranscriptFiles(dir, 'gemini', ['.json', '.jsonl'])
      .filter((ref) => ref.path.split(/[/\\]/).pop()?.startsWith('session-'))
      .map((ref) => ({
        ...ref,
        cwd: projectRootFor(ref.path) ?? ref.cwd
      }))
  },
  parseTranscript(path, options) {
    return createTranscriptStream(path, parseGeminiRecord, options)
  },
  async readMeta(path) {
    let nativeSessionId: string | undefined
    let summary: string | undefined
    let firstUserMessage: string | undefined
    let startedAt: string | null = null

    await visitJsonRecords(path, (record) => {
      const metadata = metadataOf(record)
      nativeSessionId ??= asString(metadata.sessionId)
      summary ??= asString(metadata.summary)
      startedAt ??= asString(metadata.startTime) ?? asString(metadata.lastUpdated) ?? null
      firstUserMessage ??= firstUserTextFromMetadata(metadata)

      for (const message of messagesFromRecord(record)) {
        if (!firstUserMessage && message.role === 'user' && isHumanTranscriptText(message.text)) {
          firstUserMessage = message.text
        }
      }
    })

    return {
      nativeSessionId: nativeSessionId ?? fallbackTitle(path).replace(/^session-\d{8}-\d{6}-/, ''),
      cwd: projectRootFor(path),
      title: deriveTranscriptTitle({
        preferred: summary,
        firstHumanText: firstUserMessage,
        fallback: fallbackTitle(path)
      }),
      startedAt
    } satisfies Pick<NormalizedTranscript, 'nativeSessionId' | 'cwd' | 'title' | 'startedAt'>
  }
}

function parseGeminiRecord(record: Record<string, unknown>): DraftMessage[] {
  return messagesFromRecord(record)
}

function messagesFromRecord(record: Record<string, unknown>): DraftMessage[] {
  const direct = geminiMessage(record)
  if (direct) return [direct]

  const metadata = metadataOf(record)
  const messages = Array.isArray(metadata.messages) ? metadata.messages : []
  return messages.flatMap((message) => {
    const normalized = geminiMessage(asRecord(message) ?? {})
    return normalized ? [normalized] : []
  })
}

function metadataOf(record: Record<string, unknown>): Record<string, unknown> {
  return asRecord(record.$set) ?? record
}

function geminiMessage(record: Record<string, unknown>): DraftMessage | null {
  const type = asString(record.type)
  const role = normalizeGeminiRole(type)
  if (!role) return null
  const text = geminiContentText(record.content)
  if (!text) return null
  return {
    role,
    text,
    ts: asString(record.timestamp) ?? asString(record.createdAt),
    raw: { kind: type ?? 'message' }
  }
}

function normalizeGeminiRole(type: string | undefined): NormalizedMessage['role'] | null {
  if (type === 'user') return 'user'
  if (type === 'model' || type === 'assistant') return 'assistant'
  if (type === 'tool') return 'tool'
  return null
}

function geminiContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const block = asRecord(part)
      return asString(block?.text) ?? compactGeminiTool(block)
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function compactGeminiTool(block: Record<string, unknown> | undefined): string {
  if (!block) return ''
  const call = asRecord(block.functionCall)
  if (call) return `[tool: ${asString(call.name) ?? 'unknown'}] ${compactJson(call.args)}`
  const response = asRecord(block.functionResponse)
  if (response) return compactJson(response.response)
  return ''
}

function firstUserTextFromMetadata(metadata: Record<string, unknown>): string | undefined {
  const text = asString(metadata.firstUserMessage)
  if (text && isHumanTranscriptText(text)) return text
  const messages = Array.isArray(metadata.messages) ? metadata.messages : []
  for (const value of messages) {
    const message = geminiMessage(asRecord(value) ?? {})
    if (message?.role === 'user' && isHumanTranscriptText(message.text)) return message.text
  }
  return undefined
}

function projectRootFor(sessionPath: string): string | null {
  const marker = join(dirname(dirname(sessionPath)), '.project_root')
  if (!existsSync(marker)) return null
  try {
    return readFileSync(marker, 'utf8').trim() || null
  } catch {
    return null
  }
}
