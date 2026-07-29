import type {
  CurationCandidate,
  CurationCandidateInput,
  MemoryInSessionSearchInput,
  MemoryIndexStatus,
  MemorySearchHit,
  MemorySearchInput,
  MemoryTranscriptMeta,
  MemoryTranscriptPage,
  MemoryTranscriptPageInput,
  NormalizedTranscript,
  StatsActivity,
  StatsDashboard,
  StatsGrowth,
  StatsModels,
  StatsProjectOption,
  StatsQuery,
  StatsSummary
} from '@shared/types'

export interface MemoryWorkerLike {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: WorkerOutboundMessage) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  terminate(): Promise<number>
}

type WorkerMethod =
  | 'search'
  | 'searchInSession'
  | 'getTranscript'
  | 'getTranscriptMeta'
  | 'getTranscriptPage'
  | 'listCurationCandidates'
  | 'indexStatus'
  | 'statsSummary'
  | 'statsActivity'
  | 'statsDashboard'
  | 'statsModels'
  | 'statsProjects'
  | 'statsGrowth'

export interface WorkerRequest {
  type: 'request'
  id: number
  method: WorkerMethod
  params: unknown
}

export type WorkerOutboundMessage =
  | {
      type: 'response'
      id: number
      ok: true
      result: unknown
    }
  | {
      type: 'response'
      id: number
      ok: false
      error: string
    }
  | {
      type: 'progress'
      status: MemoryIndexStatus
    }

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class MemoryWorkerClient {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private closed = false

  constructor(
    private readonly worker: MemoryWorkerLike,
    private readonly onProgress: (status: MemoryIndexStatus) => void = () => undefined,
    private readonly indexWorker: MemoryWorkerLike = worker
  ) {
    worker.on('message', (message) => this.handleMessage(message))
    worker.on('error', (error) => this.rejectAll(error))
    if (indexWorker !== worker) {
      indexWorker.on('message', (message) => this.handleMessage(message))
      indexWorker.on('error', (error) => this.rejectAll(error))
    }
  }

  search(input: MemorySearchInput): Promise<MemorySearchHit[]> {
    return this.request('search', input)
  }

  searchInSession(input: MemoryInSessionSearchInput): Promise<NormalizedTranscript['messages']> {
    return this.request('searchInSession', input)
  }

  getTranscript(sessionId: string): Promise<NormalizedTranscript | null> {
    return this.request('getTranscript', sessionId)
  }

  getTranscriptMeta(sessionId: string): Promise<MemoryTranscriptMeta | null> {
    return this.request('getTranscriptMeta', sessionId)
  }

  getTranscriptPage(input: MemoryTranscriptPageInput): Promise<MemoryTranscriptPage | null> {
    return this.request('getTranscriptPage', input)
  }

  listCurationCandidates(input: CurationCandidateInput): Promise<CurationCandidate[]> {
    // 走 query worker（只读，不与 index worker 的写入回合争用）；WAL 下可见已提交写入。
    return this.request('listCurationCandidates', input)
  }

  indexStatus(): Promise<MemoryIndexStatus> {
    return this.request('indexStatus', null, this.indexWorker)
  }

  statsSummary(input: StatsQuery): Promise<StatsSummary> {
    return this.request('statsSummary', input)
  }

  statsActivity(input: StatsQuery): Promise<StatsActivity> {
    return this.request('statsActivity', input)
  }

  statsDashboard(input: StatsQuery): Promise<StatsDashboard> {
    return this.request('statsDashboard', input)
  }

  statsModels(input: StatsQuery): Promise<StatsModels> {
    return this.request('statsModels', input)
  }

  statsProjects(): Promise<StatsProjectOption[]> {
    return this.request('statsProjects', null)
  }

  statsGrowth(memoriesCount: number): Promise<StatsGrowth> {
    return this.request('statsGrowth', memoriesCount)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.rejectAll(new Error('memory worker closed'))
    await Promise.all([
      this.worker.terminate(),
      this.indexWorker === this.worker ? Promise.resolve(0) : this.indexWorker.terminate()
    ])
  }

  private request<T>(
    method: WorkerMethod,
    params: unknown,
    worker: MemoryWorkerLike = this.worker
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('memory worker closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject
      })
      worker.postMessage({ type: 'request', id, method, params } satisfies WorkerRequest)
    })
  }

  private handleMessage(message: WorkerOutboundMessage): void {
    if (this.closed) return
    if (message.type === 'progress') {
      this.onProgress(message.status)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error))
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
