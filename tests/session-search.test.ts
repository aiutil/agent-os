import { describe, expect, it } from 'vitest'
import type { MemorySearchHit, WorkbenchSession } from '../src/shared/types'
import type { ChatSessionMatch } from '../src/main/domains/sessions/chat-sqlite-store'
import { mergeSessionHits, searchAgentChats } from '../src/main/domains/sessions/session-search'

function session(partial: Partial<WorkbenchSession> & Pick<WorkbenchSession, 'id'>): WorkbenchSession {
  return {
    name: partial.id,
    toolId: 'claude',
    workspacePath: '/repo',
    terminalSessionId: null,
    nativeSessionId: null,
    surface: 'chat',
    mode: 'chat',
    permissionPreset: 'safe',
    favorite: false,
    segments: [],
    chatHistory: [],
    linkedSessionId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial
  } as WorkbenchSession
}

describe('searchAgentChats', () => {
  const sessions: WorkbenchSession[] = [
    session({ id: 'chat-1', name: 'CMP 部署', updatedAt: '2026-02-01T00:00:00.000Z' }),
    session({ id: 'chat-2', name: '随便聊聊', updatedAt: '2026-02-02T00:00:00.000Z' }),
    session({ id: 'term-1', name: '终端会话', surface: 'terminal' })
  ]

  function deps(
    matches: Record<string, ChatSessionMatch[]>,
    sourceSessions = sessions
  ): {
    listSessions: () => WorkbenchSession[]
    searchChatSessions: (q: string, l: number) => ChatSessionMatch[]
  } {
    return {
      listSessions: () => sourceSessions,
      searchChatSessions: (q) => matches[q.trim()] ?? matches[''] ?? []
    }
  }

  it('builds agent hits from content match with highlighted snippet, excluding terminal surface', () => {
    const d = deps({
      '': [{ sessionId: 'chat-1', matchText: null, messageCount: 4, lastActivityAt: '2026-02-01T00:00:00.000Z' }],
      cmp: [{ sessionId: 'chat-1', matchText: 'deploy the CMP module', messageCount: 4, lastActivityAt: '2026-02-01T00:00:00.000Z' }]
    })
    const hits = searchAgentChats(d, { query: 'cmp', limit: 10 })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ sessionId: 'chat-1', toolId: 'claude', source: 'agent', messageCount: 4 })
    expect(hits[0].snippetHtml).toContain('<mark>CMP</mark>')
  })

  it('includes title matches even without content match', () => {
    const d = deps({ '': [], cmp: [] })
    const hits = searchAgentChats(d, { query: 'cmp', limit: 10 })
    expect(hits.map((h) => h.sessionId)).toEqual(['chat-1'])
    expect(hits[0].source).toBe('agent')
  })

  it('empty query lists chat sessions sorted by recent activity', () => {
    const d = deps({
      '': [
        { sessionId: 'chat-1', matchText: null, messageCount: 4, lastActivityAt: '2026-02-01T00:00:00.000Z' },
        { sessionId: 'chat-2', matchText: null, messageCount: 2, lastActivityAt: '2026-02-02T00:00:00.000Z' }
      ]
    })
    const hits = searchAgentChats(d, { query: '', limit: 10 })
    expect(hits.map((h) => h.sessionId)).toEqual(['chat-2', 'chat-1'])
  })

  it('honors toolIds and workspacePath filters', () => {
    const d = deps({ '': [], cmp: [] })
    expect(searchAgentChats(d, { query: 'cmp', limit: 10, toolIds: ['codex'] })).toEqual([])
    expect(searchAgentChats(d, { query: 'cmp', limit: 10, workspacePath: '/other' })).toEqual([])
  })

  it('returns the canonical title when a workspace placeholder has user history', () => {
    const legacy = session({
      id: 'chat-legacy',
      name: 'repo 会话',
      nameProvisional: false,
      workspacePath: '/work/repo',
      chatHistory: [
        {
          id: 'message-0',
          role: 'user',
          text: 'hi',
          status: 'completed',
          createdAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z'
        },
        {
          id: 'message-1',
          role: 'user',
          text: '排查当前标题不一致',
          status: 'completed',
          createdAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z'
        }
      ]
    })
    const d = deps(
      {
        '': [
          {
            sessionId: legacy.id,
            matchText: null,
            messageCount: 1,
            lastActivityAt: legacy.updatedAt
          }
        ]
      },
      [legacy]
    )

    const [hit] = searchAgentChats(d, { query: '', limit: 10 })

    expect(hit.title).toBe('排查当前标题不一致')
    expect(hit.snippetHtml).toBe('排查当前标题不一致')
  })
})

describe('mergeSessionHits', () => {
  const cliHit = (id: string, at: string): MemorySearchHit => ({
    sessionId: id, nativeSessionId: id, toolId: 'claude', title: id, cwd: null,
    snippetHtml: '', lastActivityAt: at, score: 0, messageCount: 1
  })
  const agentHit = (id: string, at: string): MemorySearchHit => ({ ...cliHit(id, at), source: 'agent' })

  it('tags cli source, merges, sorts by recency and applies limit', () => {
    const merged = mergeSessionHits(
      [cliHit('cli-1', '2026-01-01T00:00:00.000Z')],
      [agentHit('agent-1', '2026-03-01T00:00:00.000Z')],
      10
    )
    expect(merged.map((h) => h.sessionId)).toEqual(['agent-1', 'cli-1'])
    expect(merged[1].source).toBe('cli')
  })
})
