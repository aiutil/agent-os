import type { AdapterSessionStorage, SessionFileRef, WorkbenchSession } from '@shared/types'
import type { CliAdapter } from '../adapters/types'

interface ObserveNativeSessionInput {
  storage: AdapterSessionStorage
  cwd: string
  timeoutMs?: number
  pollIntervalMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 250
const METADATA_HYDRATION_CONCURRENCY = 8

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

async function listNativeSessions(storage: AdapterSessionStorage): Promise<SessionFileRef[]> {
  if (storage.listNativeSessions) return storage.listNativeSessions()
  const files: SessionFileRef[] = []
  for (const dir of new Set(storage.rootDirs())) {
    files.push(...storage.listSessionFiles(dir))
  }
  return files
}

async function hydrateNativeSessions(storage: AdapterSessionStorage): Promise<SessionFileRef[]> {
  const files = await listNativeSessions(storage)
  if (!storage.readMeta) return files
  const hydrated = new Array<SessionFileRef>(files.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(METADATA_HYDRATION_CONCURRENCY, files.length) },
    async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= files.length) return
        const file = files[index]
        if (file.cwd && file.createdAt !== undefined) {
          hydrated[index] = file
          continue
        }
        try {
          const meta = await storage.readMeta!(file.path)
          const createdAt = meta.startedAt ? new Date(meta.startedAt).getTime() : Number.NaN
          hydrated[index] = {
            ...file,
            ...(file.cwd ? {} : meta.cwd ? { cwd: meta.cwd } : {}),
            ...(file.createdAt !== undefined || !Number.isFinite(createdAt) ? {} : { createdAt })
          }
        } catch {
          hydrated[index] = file
        }
      }
    }
  )
  await Promise.all(workers)
  return hydrated
}

function filterCandidates(
  files: SessionFileRef[],
  cwd: string,
  createdAt: string,
  toleranceMs: number
): SessionFileRef[] {
  const timestamp = new Date(createdAt).getTime()
  return files
    .filter((file) => {
      if (!file.cwd || normalizePath(file.cwd) !== normalizePath(cwd)) return false
      const candidateTime = file.createdAt ?? file.mtime
      return !Number.isFinite(timestamp) || Math.abs(candidateTime - timestamp) <= toleranceMs
    })
    .sort((a, b) => (a.createdAt ?? a.mtime) - (b.createdAt ?? b.mtime))
}

async function matchesCwd(
  storage: AdapterSessionStorage,
  file: SessionFileRef,
  cwd: string,
  allowUnknown = false
): Promise<boolean> {
  if (file.cwd) return normalizePath(file.cwd) === normalizePath(cwd)
  if (!storage.readMeta) return allowUnknown
  const meta = await storage.readMeta(file.path)
  return meta.cwd === null ? allowUnknown : normalizePath(meta.cwd) === normalizePath(cwd)
}

/**
 * 启动前同步快照，随后轮询新增文件。每次调用持有独立快照，
 * 因此同时新建多个 CLI 会话时只会按 cwd 绑定自己的原生 id。
 */
export async function observeNativeSession({
  storage,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
}: ObserveNativeSessionInput): Promise<string | null> {
  const before = new Set((await listNativeSessions(storage)).map((file) => file.nativeSessionId))
  const deadline = Date.now() + timeoutMs
  // 把首次扫描让到下一轮事件循环，调用方可在拿到 Promise 后立即启动 PTY。
  await sleep(pollIntervalMs)
  do {
    const candidates = (await listNativeSessions(storage))
      .filter((file) => !before.has(file.nativeSessionId))
      .sort((a, b) => b.mtime - a.mtime)
    for (const candidate of candidates) {
      if (await matchesCwd(storage, candidate, cwd)) return candidate.nativeSessionId
    }
    if (Date.now() >= deadline) break
    await sleep(pollIntervalMs)
  } while (true)
  return null
}

export async function nativeSessionExists(
  storage: AdapterSessionStorage,
  cwd: string,
  nativeSessionId: string
): Promise<boolean> {
  const match = (await listNativeSessions(storage)).find(
    (file) => file.nativeSessionId === nativeSessionId
  )
  return match ? matchesCwd(storage, match, cwd, true) : false
}

export async function findNativeSessionCandidates(
  storage: AdapterSessionStorage,
  cwd: string,
  createdAt: string,
  toleranceMs = 120_000
): Promise<SessionFileRef[]> {
  return filterCandidates(await hydrateNativeSessions(storage), cwd, createdAt, toleranceMs)
}

export async function backfillManagedNativeSessions(options: {
  sessions: WorkbenchSession[]
  getAdapter(toolId: string): CliAdapter | undefined
  bindNativeSession(id: string, nativeSessionId: string): unknown
}): Promise<number> {
  let bound = 0
  const snapshots = new Map<string, Promise<SessionFileRef[]>>()
  for (const session of options.sessions) {
    if (session.nativeSessionId) continue
    const adapter = options.getAdapter(session.toolId)
    if (!adapter?.sessionStorage || !adapter.buildResumeCommand) continue
    let snapshot = snapshots.get(adapter.id)
    if (!snapshot) {
      snapshot = hydrateNativeSessions(adapter.sessionStorage)
      snapshots.set(adapter.id, snapshot)
    }
    const candidates = filterCandidates(
      await snapshot,
      session.workspacePath,
      session.createdAt,
      120_000
    )
    if (candidates.length !== 1) continue
    options.bindNativeSession(session.id, candidates[0].nativeSessionId)
    bound += 1
  }
  return bound
}
