import { create } from 'zustand'
import { tr } from '@shared/i18n'
import type {
  ManagedChatMessage,
  MemoryTranscriptMeta,
  MemoryTranscriptPage,
  NormalizedMessage,
  NormalizedTranscript,
  WorkbenchSessionView
} from '@shared/types'

const PAGE_SIZE = 160
const CACHE_LIMIT = 8

interface CachedPage {
  meta: MemoryTranscriptMeta
  messages: NormalizedMessage[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  pageSessionId: string
}

interface MemoryViewState {
  selectedSessionId: string | null
  meta: MemoryTranscriptMeta | null
  messages: NormalizedMessage[]
  transcript: NormalizedTranscript | null
  loading: boolean
  loadingMore: boolean
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  pageSessionId: string | null
  error: string | null
  open(sessionId: string): Promise<boolean>
  loadBefore(): Promise<void>
  close(): void
}

const cache = new Map<string, CachedPage>()
const inflight = new Map<string, Promise<MemoryTranscriptPage | null>>()

function transcriptOf(page: CachedPage | null): NormalizedTranscript | null {
  if (!page) return null
  return {
    nativeSessionId: page.meta.nativeSessionId,
    toolId: page.meta.toolId,
    cwd: page.meta.cwd,
    title: page.meta.title,
    startedAt: page.meta.startedAt,
    lastActivityAt: page.meta.lastActivityAt,
    messages: page.messages,
    parseErrors: page.meta.parseErrors
  }
}

function remember(sessionId: string, page: CachedPage): void {
  cache.delete(sessionId)
  cache.set(sessionId, page)
  while (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value
    if (!first) break
    cache.delete(first)
  }
}

function fetchPage(
  key: string,
  input: Parameters<typeof window.agentOs.memory.getTranscriptPage>[0]
): Promise<MemoryTranscriptPage | null> {
  const existing = inflight.get(key)
  if (existing) return existing
  const request = window.agentOs.memory
    .getTranscriptPage(input)
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

async function findSessionView(sessionId: string): Promise<WorkbenchSessionView | null> {
  try {
    const views = await window.agentOs.session.listViews()
    return views.find((view) => view.id === sessionId) ?? null
  } catch {
    return null
  }
}

function memoryIdsFor(sessionId: string, view: WorkbenchSessionView | null): string[] {
  const ids: string[] = []
  if (view?.nativeSessionId) ids.push(`${view.toolId}:${view.nativeSessionId}`)
  ids.push(sessionId)
  return Array.from(new Set(ids))
}

function chatMessagesToPage(
  sessionId: string,
  view: WorkbenchSessionView | null,
  history: ManagedChatMessage[]
): CachedPage {
  const messages: NormalizedMessage[] = history.map((message, index) => ({
    seq: index,
    role: message.role,
    text: message.text,
    ts: message.createdAt
  }))
  const fallbackToolId = view?.toolId ?? sessionId.split(':')[0] ?? 'chat'
  const now = new Date(0).toISOString()
  return {
    meta: {
      sessionId,
      nativeSessionId: view?.nativeSessionId ?? sessionId,
      toolId: fallbackToolId,
      cwd: view?.workspacePath ?? null,
      title: view?.name ?? tr('system.memoryView.fallbackTitle'),
      startedAt: view?.createdAt ?? null,
      lastActivityAt: view?.lastActivityAt ?? view?.updatedAt ?? messages.at(-1)?.ts ?? now,
      parseErrors: 0,
      messageCount: messages.length
    },
    messages,
    hasMoreBefore: false,
    hasMoreAfter: false,
    pageSessionId: sessionId
  }
}

async function loadInitialPage(sessionId: string): Promise<CachedPage | null> {
  const view = await findSessionView(sessionId)
  for (const candidate of memoryIdsFor(sessionId, view)) {
    const page = await fetchPage(`${candidate}:latest`, {
      sessionId: candidate,
      direction: 'latest',
      limit: PAGE_SIZE
    })
    if (page) {
      return {
        meta: page.meta,
        messages: page.messages,
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: page.hasMoreAfter,
        pageSessionId: candidate
      }
    }
  }

  const history = await window.agentOs.chat.history(sessionId).catch(() => [])
  if (history.length || view) return chatMessagesToPage(sessionId, view, history)
  return null
}

export const useMemoryViewStore = create<MemoryViewState>((set, get) => ({
  selectedSessionId: null,
  meta: null,
  messages: [],
  transcript: null,
  loading: false,
  loadingMore: false,
  hasMoreBefore: false,
  hasMoreAfter: false,
  pageSessionId: null,
  error: null,
  open: async (sessionId) => {
    const cached = cache.get(sessionId)
    if (cached) {
      set({
        selectedSessionId: sessionId,
        meta: cached.meta,
        messages: cached.messages,
        transcript: transcriptOf(cached),
        loading: false,
        loadingMore: false,
        hasMoreBefore: cached.hasMoreBefore,
        hasMoreAfter: cached.hasMoreAfter,
        pageSessionId: cached.pageSessionId,
        error: null
      })
    } else {
      set({
        selectedSessionId: sessionId,
        meta: null,
        messages: [],
        transcript: null,
        loading: true,
        loadingMore: false,
        hasMoreBefore: false,
        hasMoreAfter: false,
        pageSessionId: null,
        error: null
      })
    }

    try {
      const next = await loadInitialPage(sessionId)
      if (!next) {
        set({ loading: false, error: tr('system.memoryView.unavailable') })
        return false
      }
      remember(sessionId, next)
      if (get().selectedSessionId === sessionId) {
        set({
          meta: next.meta,
          messages: next.messages,
          transcript: transcriptOf(next),
          loading: false,
          hasMoreBefore: next.hasMoreBefore,
          hasMoreAfter: next.hasMoreAfter,
          pageSessionId: next.pageSessionId,
          error: null
        })
      }
      return true
    } catch {
      if (get().selectedSessionId === sessionId) {
        set({ loading: false, error: tr('system.memoryView.unavailable') })
      }
      return false
    }
  },
  loadBefore: async () => {
    const state = get()
    const sessionId = state.selectedSessionId
    const pageSessionId = state.pageSessionId
    const cursor = state.messages[0]?.seq
    if (!sessionId || !pageSessionId || cursor === undefined || state.loadingMore || !state.hasMoreBefore) return
    set({ loadingMore: true })
    try {
      const page = await fetchPage(`${pageSessionId}:before:${cursor}`, {
        sessionId: pageSessionId,
        cursor,
        direction: 'before',
        limit: PAGE_SIZE
      })
      if (!page) return
      const current = get()
      if (current.selectedSessionId !== sessionId) return
      const seen = new Set(current.messages.map((message) => message.seq))
      const messages = [
        ...page.messages.filter((message) => !seen.has(message.seq)),
        ...current.messages
      ]
      const next: CachedPage = {
        meta: page.meta,
        messages,
        hasMoreBefore: page.hasMoreBefore,
        hasMoreAfter: current.hasMoreAfter,
        pageSessionId
      }
      remember(sessionId, next)
      set({
        meta: next.meta,
        messages: next.messages,
        transcript: transcriptOf(next),
        hasMoreBefore: next.hasMoreBefore,
        hasMoreAfter: next.hasMoreAfter,
        pageSessionId: next.pageSessionId,
        loadingMore: false,
        error: null
      })
    } catch {
      set({ loadingMore: false, error: tr('system.memoryView.loadBeforeFailed') })
    }
  },
  close: () =>
    set({
      selectedSessionId: null,
      meta: null,
      messages: [],
      transcript: null,
      loading: false,
      loadingMore: false,
      hasMoreBefore: false,
      hasMoreAfter: false,
      pageSessionId: null,
      error: null
    })
}))
