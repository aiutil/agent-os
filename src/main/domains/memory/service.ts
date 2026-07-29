import createMemoryWorker from './indexer-worker?nodeWorker'
import { MemoryWorkerClient } from './worker-client'
import type { MemoryIndexStatus } from '@shared/types'

export function createMemoryService(
  dbPath: string,
  onProgress: (status: MemoryIndexStatus) => void
): MemoryWorkerClient {
  const queryWorker = createMemoryWorker({ workerData: { dbPath, role: 'query' } })
  const indexWorker = createMemoryWorker({ workerData: { dbPath, role: 'index' } })
  return new MemoryWorkerClient(queryWorker, onProgress, indexWorker)
}
