import type { WebBookmark } from './types'

export const AGENT_OS_WEB_ENTRY = {
  name: 'Agent OS',
  url: 'https://agentos.aiutil.com'
} as const

const LEGACY_AGENT_OS_URLS = new Set([
  'https://lohasle.github.io/agent-life/',
  'https://lohasle.github.io/agent-life',
  'https://agentos.aiutil.com/'
])

export function migrateDefaultAgentOsBookmark(bookmark: WebBookmark): WebBookmark {
  if (bookmark.id !== 'bm-agent-life') return bookmark
  const name = bookmark.name === 'Agent Life' ? AGENT_OS_WEB_ENTRY.name : bookmark.name
  const url = LEGACY_AGENT_OS_URLS.has(bookmark.url) ? AGENT_OS_WEB_ENTRY.url : bookmark.url
  return name === bookmark.name && url === bookmark.url ? bookmark : { ...bookmark, name, url }
}
