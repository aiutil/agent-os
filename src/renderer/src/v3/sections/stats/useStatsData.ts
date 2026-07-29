import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StatsDashboard, StatsModels, StatsQuery } from '@shared/types'

const STORAGE_KEY = 'agent-os.v3.statsCache.v1'
const MAX_PERSISTED = 8
const TTL_MS = 7 * 24 * 60 * 60 * 1000

type StatsCacheKind = 'dashboard' | 'models'

interface CacheEntry<T> {
  key: string
  kind: StatsCacheKind
  updatedAt: number
  data: T
}

interface CachedState<T> {
  data: T | null
  loading: boolean
  refreshing: boolean
  updatedAt: number | null
  refresh(): void
}

const memoryCache = new Map<string, CacheEntry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()
let persistentLoaded = false

function normalizeQuery(input: StatsQuery): StatsQuery {
  return {
    range: input.range,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    ...(input.unassignedWorkspace ? { unassignedWorkspace: true } : {}),
    ...(input.toolIds?.length ? { toolIds: [...input.toolIds].sort() } : {})
  }
}

function cacheKey(kind: StatsCacheKind, input: StatsQuery): string {
  const query = normalizeQuery(input)
  return `${kind}:${query.range}:${query.workspacePath ?? ''}:${query.unassignedWorkspace ? 'unassigned' : ''}:${query.toolIds?.join(',') ?? ''}`
}

function loadPersistent(): void {
  if (persistentLoaded) return
  persistentLoaded = true
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const entries = JSON.parse(raw) as Array<CacheEntry<unknown>>
    const now = Date.now()
    for (const entry of entries) {
      if (!entry?.key || now - entry.updatedAt > TTL_MS) continue
      memoryCache.set(entry.key, entry)
    }
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}

function persist(): void {
  const entries = [...memoryCache.values()]
    .filter((entry) => Date.now() - entry.updatedAt <= TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_PERSISTED)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Cache persistence is best-effort; memory cache still covers menu switches.
  }
}

function readCache<T>(key: string): CacheEntry<T> | null {
  loadPersistent()
  const entry = memoryCache.get(key) as CacheEntry<T> | undefined
  if (!entry || Date.now() - entry.updatedAt > TTL_MS) return null
  return entry
}

function writeCache<T>(key: string, kind: StatsCacheKind, data: T): CacheEntry<T> {
  const entry: CacheEntry<T> = { key, kind, data, updatedAt: Date.now() }
  memoryCache.set(key, entry)
  persist()
  return entry
}

function fetchCached<T>(
  kind: StatsCacheKind,
  query: StatsQuery,
  fetcher: (input: StatsQuery) => Promise<T>
): Promise<CacheEntry<T>> {
  const key = cacheKey(kind, query)
  const pending = inflight.get(key) as Promise<CacheEntry<T>> | undefined
  if (pending) return pending
  const request = fetcher(normalizeQuery(query))
    .then((data) => writeCache(key, kind, data))
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

function useCachedStats<T>(
  kind: StatsCacheKind,
  query: StatsQuery,
  fetcher: (input: StatsQuery) => Promise<T>,
  enabled = true
): CachedState<T> {
  const key = useMemo(() => cacheKey(kind, query), [kind, query])
  const initial = enabled ? readCache<T>(key) : null
  const [data, setData] = useState<T | null>(initial?.data ?? null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(initial?.updatedAt ?? null)
  const [loading, setLoading] = useState(enabled && !initial)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(() => {
    if (!enabled) return
    const cached = readCache<T>(key)
    if (cached) {
      setData(cached.data)
      setUpdatedAt(cached.updatedAt)
      setLoading(false)
    } else {
      setLoading(true)
    }
    setRefreshing(true)
    void fetchCached(kind, query, fetcher)
      .then((entry) => {
        setData(entry.data)
        setUpdatedAt(entry.updatedAt)
      })
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [enabled, fetcher, key, kind, query])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setRefreshing(false)
      return
    }
    let cancelled = false
    const cached = readCache<T>(key)
    if (cached) {
      setData(cached.data)
      setUpdatedAt(cached.updatedAt)
      setLoading(false)
      setRefreshing(true)
    } else {
      setData(null)
      setUpdatedAt(null)
      setLoading(true)
      setRefreshing(false)
    }
    void fetchCached(kind, query, fetcher)
      .then((entry) => {
        if (cancelled) return
        setData(entry.data)
        setUpdatedAt(entry.updatedAt)
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setRefreshing(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, fetcher, key, kind, query])

  return { data, loading, refreshing, updatedAt, refresh }
}

export function useStatsDashboard(query: StatsQuery): CachedState<StatsDashboard> {
  const fetcher = useCallback((input: StatsQuery) => window.agentOs.stats.dashboard(input), [])
  return useCachedStats('dashboard', query, fetcher)
}

export function useStatsModels(query: StatsQuery, enabled: boolean): CachedState<StatsModels> {
  const fetcher = useCallback((input: StatsQuery) => window.agentOs.stats.models(input), [])
  return useCachedStats('models', query, fetcher, enabled)
}

export function prefetchStatsDashboard(query: StatsQuery): void {
  void fetchCached('dashboard', query, (input) => window.agentOs.stats.dashboard(input)).catch(() => {})
}
