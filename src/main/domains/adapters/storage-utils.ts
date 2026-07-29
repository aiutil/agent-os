import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  NormalizedMessage,
  SessionFileRef,
  TranscriptMessageStream,
  TranscriptParseSummary,
  TranscriptReadOptions
} from '../../../shared/types/transcript'
import type { TranscriptUsageFact } from '@shared/types'
import type { UsageCollector } from '../stats/usage'

export type DraftMessage = Omit<NormalizedMessage, 'seq'>
export type RecordParser = (record: Record<string, unknown>) => DraftMessage[]

export function createArrayTranscriptStream(
  messages: DraftMessage[],
  parseErrors = 0
): TranscriptMessageStream {
  const summary = Promise.resolve({ totalLines: messages.length, parseErrors })
  const usageFacts = Promise.resolve([])
  return {
    summary,
    usageFacts,
    async *[Symbol.asyncIterator]() {
      for (const [seq, message] of messages.entries()) yield { ...message, seq }
    }
  }
}

export function createTranscriptStream(
  path: string,
  parseRecord: RecordParser,
  options: TranscriptReadOptions = {},
  collector?: UsageCollector
): TranscriptMessageStream {
  let resolveSummary!: (summary: TranscriptParseSummary) => void
  let rejectSummary!: (error: unknown) => void
  const summary = new Promise<TranscriptParseSummary>((resolve, reject) => {
    resolveSummary = resolve
    rejectSummary = reject
  })
  let resolveUsageFacts!: (facts: TranscriptUsageFact[]) => void
  let rejectUsageFacts!: (error: unknown) => void
  const usageFacts = new Promise<TranscriptUsageFact[]>((resolve, reject) => {
    resolveUsageFacts = resolve
    rejectUsageFacts = reject
  })

  async function* messages(): AsyncGenerator<NormalizedMessage> {
    let totalLines = 0
    let parseErrors = 0
    let seq = 0

    try {
      const lines = createInterface({
        input: createReadStream(path, {
          encoding: 'utf8',
          start: options.startOffset ?? 0
        }),
        crlfDelay: Infinity
      })

      for await (const line of lines) {
        if (!line.trim()) continue
        totalLines += 1

        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          parseErrors += 1
          continue
        }

        if (!isRecord(record)) {
          parseErrors += 1
          continue
        }

        collector?.visit(record)
        for (const message of parseRecord(record)) {
          yield { ...message, seq }
          seq += 1
        }
      }

      resolveSummary({ totalLines, parseErrors })
      resolveUsageFacts(collector?.finish() ?? [])
    } catch (error) {
      rejectSummary(error)
      rejectUsageFacts(error)
      throw error
    }
  }

  return {
    summary,
    usageFacts,
    [Symbol.asyncIterator]: messages
  }
}

export function listTranscriptFiles(
  dir: string,
  toolId: string,
  extensions: string[] = ['.jsonl']
): SessionFileRef[] {
  if (!existsSync(dir)) return []

  const refs: SessionFileRef[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !extensions.includes(extname(entry.name))) continue

      const stat = statSync(path)
      refs.push({
        path,
        nativeSessionId: sessionIdFromFilename(entry.name),
        toolId,
        mtime: stat.mtimeMs
      })
    }
  }

  visit(dir)
  return refs.sort((a, b) => b.mtime - a.mtime)
}

export async function visitJsonRecords(
  path: string,
  visit: (record: Record<string, unknown>) => void
): Promise<void> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      const record: unknown = JSON.parse(line)
      if (isRecord(record)) visit(record)
    } catch {
      // Metadata extraction is best effort; parseTranscript reports line errors.
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function compactJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value))
    } catch {
      return value
    }
  }
  return JSON.stringify(value ?? {})
}

export function truncateTitle(value: string, maxLength = 80): string {
  return Array.from(value.trim()).slice(0, maxLength).join('')
}

export function fallbackTitle(path: string): string {
  return basename(path, extname(path))
}

function sessionIdFromFilename(filename: string): string {
  const stem = basename(filename, extname(filename))
  const uuid = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)
  return uuid?.[0] ?? stem
}
