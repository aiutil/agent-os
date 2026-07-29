// 统一会话搜索（SPEC-005 延伸）。把「自建 agent 对话」(chat-store.sqlite + 会话元数据)
// 检索结果归一为 MemorySearchHit，供 IPC 层与 CLI 历史 FTS 结果合并。

import type { MemorySearchHit, MemorySearchInput, WorkbenchSession } from '@shared/types'
import type { ChatSessionMatch } from './chat-sqlite-store'
import { deriveSessionDisplayTitle, sanitizeTranscriptTitle } from '@shared/transcript/title'

export interface AgentChatSearchDeps {
  listSessions(): WorkbenchSession[]
  searchChatSessions(query: string, limit: number): ChatSessionMatch[]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** 在命中正文里裁出片段并用 <mark> 高亮（输出已转义，可安全 dangerouslySetInnerHTML）。 */
function buildSnippet(text: string, query: string): string {
  const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (idx < 0) return escapeHtml(text.slice(0, 120))
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, idx + query.length + 90)
  const before = (start > 0 ? '…' : '') + escapeHtml(text.slice(start, idx))
  const match = escapeHtml(text.slice(idx, idx + query.length))
  const after = escapeHtml(text.slice(idx + query.length, end)) + (end < text.length ? '…' : '')
  return `${before}<mark>${match}</mark>${after}`
}

export function searchAgentChats(deps: AgentChatSearchDeps, input: MemorySearchInput): MemorySearchHit[] {
  const limit = Math.max(1, Math.min(input.limit || 50, 200))
  const query = input.query.trim()
  const lower = query.toLowerCase()

  const chatSessions = deps.listSessions().filter((s) => s.surface === 'chat')
  const byId = new Map(chatSessions.map((s) => [s.id, s]))
  const titleOf = (session: WorkbenchSession): string =>
    deriveSessionDisplayTitle({
      name: session.name,
      workspaceBase: session.workspacePath.split(/[/\\]/).filter(Boolean).pop() ?? '',
      firstUserText: session.chatHistory
        ?.filter((message) => message.role === 'user')
        .map((message) => sanitizeTranscriptTitle(message.text, 80))
        .find(Boolean),
      fallback: '未命名会话'
    })
  const passes = (s: WorkbenchSession): boolean =>
    (!input.toolIds?.length || input.toolIds.includes(s.toolId)) &&
    (!input.workspacePath || s.workspacePath === input.workspacePath)

  // 不再每次查询都全表聚合所有会话统计；stats 仅取自实际命中结果（FTS/默认列表自带）。
  const makeHit = (
    s: WorkbenchSession,
    snippetHtml: string,
    stat?: { messageCount: number; lastActivityAt: string }
  ): MemorySearchHit => ({
    sessionId: s.id,
    nativeSessionId: s.id,
    toolId: s.toolId,
    title: titleOf(s),
    cwd: s.workspacePath || null,
    snippetHtml,
    lastActivityAt: stat?.lastActivityAt ?? s.updatedAt,
    // SPEC-031：agent 会话命中带 createdAt，供排序使用；CLI 历史命中无此字段。
    createdAt: s.createdAt,
    score: 0,
    messageCount: stat?.messageCount ?? 0,
    source: 'agent'
  })

  const hits = new Map<string, MemorySearchHit>()

  if (!query) {
    // 默认列表：只取最近 limit 个会话的统计（单条 GROUP BY，受 LIMIT 约束）。
    const recent = new Map(deps.searchChatSessions('', limit).map((m) => [m.sessionId, m]))
    for (const s of chatSessions) {
      if (passes(s)) hits.set(s.id, makeHit(s, escapeHtml(titleOf(s)), recent.get(s.id)))
    }
  } else {
    // 正文命中（带高亮 snippet），统计随命中结果一并返回。
    for (const m of deps.searchChatSessions(query, limit * 4)) {
      const s = byId.get(m.sessionId)
      if (!s || !passes(s)) continue
      hits.set(
        s.id,
        makeHit(s, m.matchText ? buildSnippet(m.matchText, query) : escapeHtml(titleOf(s)), m)
      )
    }
    // 标题命中（无正文命中的会话，纯内存过滤已加载会话，无 DB 扫描）。
    for (const s of chatSessions) {
      if (hits.has(s.id) || !passes(s)) continue
      const title = titleOf(s)
      if (title.toLowerCase().includes(lower) || s.name.toLowerCase().includes(lower)) {
        hits.set(s.id, makeHit(s, escapeHtml(title)))
      }
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, limit)
}

/** 合并 CLI 历史与自建对话命中：标记来源、按最近活动排序、套用 limit。 */
export function mergeSessionHits(
  cli: MemorySearchHit[],
  agent: MemorySearchHit[],
  limit: number
): MemorySearchHit[] {
  const merged = [...cli.map((hit) => ({ ...hit, source: 'cli' as const })), ...agent]
  merged.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return merged.slice(0, Math.max(1, Math.min(limit || 50, 200)))
}
