import type { AgentEvent } from '../../../shared/types/agent-event'
import type { HeadlessTurnParser } from './types'
import { extractSessionId } from './headless-utils'

export interface PlainTextParserOptions {
  /** Optional adapter name for unknown session-info lines. */
  adapterName: string
}

/**
 * Fallback parser for CLIs that expose reliable headless text output but not a
 * stable JSON event stream. It keeps the chat usable while still binding native
 * session ids when the CLI prints them.
 */
export function createPlainTextParser(_options: PlainTextParserOptions): HeadlessTurnParser {
  let emittedSession = false
  return {
    parse(line: string): AgentEvent[] {
      const text = stripAnsi(line).trimEnd()
      if (!text.trim()) return []

      const sessionId = extractSessionId(text)
      if (sessionId && !emittedSession) {
        emittedSession = true
        return [{ kind: 'session-bound', nativeSessionId: sessionId }]
      }

      return [{ kind: 'text-delta', text: `${text}\n` }]
    }
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}
