import { parentPort, workerData } from 'node:worker_threads'
import { listAdapters } from '../adapters/registry'
import { MemoryIndex } from './index'
import { MemoryIndexer } from './indexer'
import type { WorkerOutboundMessage, WorkerRequest } from './worker-client'
import type {
  CurationCandidateInput,
  MemoryInSessionSearchInput,
  MemorySearchInput,
  MemoryTranscriptPageInput
} from '@shared/types'
import type { StatsQuery } from '@shared/types'

interface MemoryWorkerData {
  dbPath: string
  role?: 'query' | 'index'
}

if (!parentPort) throw new Error('memory indexer worker requires parentPort')
const port = parentPort

const data = workerData as MemoryWorkerData
const index = new MemoryIndex(data.dbPath)
const sources = listAdapters().flatMap((adapter) =>
  adapter.sessionStorage ? [{ adapter, roots: adapter.sessionStorage.rootDirs() }] : []
)
const indexer = new MemoryIndexer(index, sources, (status) => {
  port.postMessage({
    type: 'progress',
    status
  } satisfies WorkerOutboundMessage)
})

if (data.role !== 'query') void indexer.start()

port.on('message', async (request: WorkerRequest) => {
  if (request.type !== 'request') return
  try {
    let result: unknown
    switch (request.method) {
      case 'search':
        result = index.search(request.params as MemorySearchInput)
        break
      case 'searchInSession':
        result = index.searchInSession(request.params as MemoryInSessionSearchInput)
        break
      case 'getTranscript':
        result = index.getTranscript(String(request.params))
        break
      case 'getTranscriptMeta':
        result = index.getTranscriptMeta(String(request.params))
        break
      case 'getTranscriptPage':
        result = index.getTranscriptPage(request.params as MemoryTranscriptPageInput)
        break
      case 'listCurationCandidates':
        result = index.listCurationCandidates(request.params as CurationCandidateInput)
        break
      case 'indexStatus':
        result = index.getStatus()
        break
      case 'statsSummary':
        result = index.getStatsSummary(request.params as StatsQuery)
        break
      case 'statsActivity':
        result = index.getStatsActivity(request.params as StatsQuery)
        break
      case 'statsDashboard':
        result = index.getStatsDashboard(request.params as StatsQuery)
        break
      case 'statsModels':
        result = index.getStatsModels(request.params as StatsQuery)
        break
      case 'statsProjects':
        result = index.getStatsProjects()
        break
      case 'statsGrowth':
        result = index.getStatsGrowth(Number(request.params) || 0)
        break
    }
    port.postMessage({
      type: 'response',
      id: request.id,
      ok: true,
      result
    } satisfies WorkerOutboundMessage)
  } catch (error) {
    port.postMessage({
      type: 'response',
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    } satisfies WorkerOutboundMessage)
  }
})
