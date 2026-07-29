import type { TranscriptUsageFact, UsageTokens } from '@shared/types'

export interface UsageCollector {
  visit(record: Record<string, unknown>): void
  finish(): TranscriptUsageFact[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function usageTokens(
  usage: Record<string, unknown>,
  cachedInputIsPartOfInput = false
): UsageTokens {
  const cached = numberOf(usage.cache_read_input_tokens ?? usage.cached_input_tokens)
  const rawInput = numberOf(usage.input_tokens)
  return {
    input: cachedInputIsPartOfInput ? Math.max(0, rawInput - cached) : rawInput,
    output: numberOf(usage.output_tokens),
    cacheWrite: numberOf(usage.cache_creation_input_tokens),
    cacheRead: cached
  }
}

export function createClaudeUsageCollector(): UsageCollector {
  const facts = new Map<string, TranscriptUsageFact>()
  let anonymous = 0

  return {
    visit(record) {
      if (record.type !== 'assistant') return
      const message = asRecord(record.message)
      const usage = asRecord(message?.usage)
      if (!message || !usage) return
      const messageId = asString(message.id) ?? `anonymous-${anonymous++}`
      facts.set(`claude:${messageId}`, {
        key: `claude:${messageId}`,
        model: asString(message.model) ?? null,
        timestamp: asString(record.timestamp) ?? null,
        tokens: usageTokens(usage)
      })
    },
    finish: () => [...facts.values()]
  }
}

export function createCodexUsageCollector(): UsageCollector {
  const facts = new Map<string, TranscriptUsageFact>()
  let currentTurn: string | null = null
  let currentModel: string | null = null
  let anonymous = 0
  let previousTotal: UsageTokens | null = null

  return {
    visit(record) {
      const payload = asRecord(record.payload)
      if (record.type === 'turn_context') {
        currentTurn = asString(payload?.turn_id) ?? null
        currentModel = asString(payload?.model) ?? currentModel
        return
      }
      if (record.type !== 'event_msg' || payload?.type !== 'token_count') return
      const info = asRecord(payload.info)
      const lastUsage = asRecord(info?.last_token_usage)
      const totalUsage = asRecord(info?.total_token_usage)
      const totalTokens = totalUsage ? usageTokens(totalUsage, true) : null
      const tokens = lastUsage
        ? usageTokens(lastUsage, true)
        : totalTokens && previousTotal
          ? {
              input: Math.max(0, totalTokens.input - previousTotal.input),
              output: Math.max(0, totalTokens.output - previousTotal.output),
              cacheWrite: 0,
              cacheRead: Math.max(0, totalTokens.cacheRead - previousTotal.cacheRead)
            }
          : totalTokens
      if (totalTokens) previousTotal = totalTokens
      if (!tokens) return
      const key = `codex:${currentTurn ?? `anonymous-${anonymous++}`}`
      facts.set(key, {
        key,
        model: currentModel,
        timestamp: asString(record.timestamp) ?? null,
        tokens
      })
    },
    finish: () => [...facts.values()]
  }
}
