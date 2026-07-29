import { resolve, sep } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { MemoryIndexStatus, NormalizedTranscript } from '@shared/types'
import type { CliAdapter } from '../adapters/types'
import { MemoryIndex } from './index'

export interface MemoryIndexSource {
  adapter: CliAdapter
  roots: string[]
}

export type IndexProgressHandler = (status: MemoryIndexStatus) => void

function isWithin(path: string, root: string): boolean {
  const absolutePath = resolve(path)
  const absoluteRoot = resolve(root)
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}${sep}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class MemoryIndexer {
  private watcher: FSWatcher | null = null
  private queue = Promise.resolve()
  private snapshotReconcileQueued = false
  private snapshotReconcileRequested = false

  constructor(
    private readonly index: MemoryIndex,
    private readonly sources: MemoryIndexSource[],
    private readonly onProgress: IndexProgressHandler = () => undefined
  ) {}

  async start(): Promise<void> {
    await this.reconcile()
    const roots = this.fullSources().flatMap((source) => source.roots)
    if (roots.length > 0) {
      this.watcher = chokidar.watch(roots, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100
        }
      })
      this.watcher.on('add', (path) => this.enqueueChange(path))
      this.watcher.on('change', (path) => this.enqueueChange(path))
      this.watcher.on('unlink', (path) => this.enqueueChange(path, true))
    }
    void this.backfillHotSearchIndex()
  }

  async reconcile(): Promise<void> {
    const sources = this.fullSources()
    const files = sources.flatMap((source) =>
      source.roots.flatMap((root) =>
        source.adapter.sessionStorage!.listSessionFiles(root).map((file) => ({
          adapter: source.adapter,
          path: file.path
        }))
      )
    )
    const discovered = new Set(files.map((file) => file.path))

    const status: MemoryIndexStatus = {
      filesTotal: files.length,
      filesIndexed: 0,
      building: true,
      failedFiles: []
    }
    this.publish(status)
    for (const file of files) {
      try {
        await this.index.indexFile(file.adapter, file.path)
      } catch (error) {
        status.failedFiles.push({
          path: file.path,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
      status.filesIndexed += 1
      this.publish(status)
    }

    for (const source of sources) {
      const scanTranscripts = source.adapter.sessionStorage?.scanTranscripts
      if (!scanTranscripts) continue
      for await (const transcript of scanTranscripts()) {
        const sourcePath = this.snapshotPath(source.adapter, transcript)
        discovered.add(sourcePath)
        status.filesTotal += 1
        this.publish(status)
        try {
          this.index.upsertTranscript(source.adapter.id, sourcePath, transcript)
        } catch (error) {
          status.failedFiles.push({
            path: sourcePath,
            reason: error instanceof Error ? error.message : String(error)
          })
        }
        status.filesIndexed += 1
        this.publish(status)
      }
    }

    for (const indexed of this.index.listIndexedFiles()) {
      if (!discovered.has(indexed.path)) this.index.removeFile(indexed.path)
    }
    status.building = false
    this.publish(status)
  }

  async close(): Promise<void> {
    await this.queue
    await this.watcher?.close()
    this.index.close()
  }

  private fullSources(): MemoryIndexSource[] {
    return this.sources.filter(
      (source) => {
        const storage = source.adapter.sessionStorage
        return Boolean(
          storage?.support === 'full' &&
            ((storage.parseTranscript && storage.readMeta) || storage.scanTranscripts)
        )
      }
    )
  }

  private enqueueChange(path: string, removed = false): void {
    const source = this.fullSources().find((candidate) =>
      candidate.roots.some((root) => isWithin(path, root))
    )
    if (!source) return
    if (source.adapter.sessionStorage?.scanTranscripts) {
      this.enqueueSnapshotReconcile()
      return
    }
    this.queue = this.queue
      .then(() => {
        if (removed) {
          this.index.removeFile(path)
          return
        }
        return this.index.indexFile(source.adapter, path)
      })
      .catch((error) => {
        const current = this.index.getStatus()
        current.failedFiles = [
          ...current.failedFiles.filter((item) => item.path !== path),
          { path, reason: error instanceof Error ? error.message : String(error) }
        ]
        this.publish(current)
      })
  }

  private enqueueSnapshotReconcile(): void {
    this.snapshotReconcileRequested = true
    if (this.snapshotReconcileQueued) return
    this.snapshotReconcileQueued = true
    this.queue = this.queue
      .then(async () => {
        do {
          this.snapshotReconcileRequested = false
          await this.reconcile()
        } while (this.snapshotReconcileRequested)
      })
      .finally(() => {
        this.snapshotReconcileQueued = false
      })
  }

  private async backfillHotSearchIndex(): Promise<void> {
    try {
      let result = this.index.backfillHotSearchIndexBatch(2_000)
      while (!result.done) {
        const current = this.index.getStatus()
        this.publish({
          ...current,
          optimizing: true,
          hotIndexedMessages: result.indexed,
          hotTotalMessages: result.total
        })
        await sleep(20)
        result = this.index.backfillHotSearchIndexBatch(2_000)
      }
      this.index.cleanupLegacySearchIndexIfSafe()
      const current = this.index.getStatus()
      this.publish({
        ...current,
        optimizing: false,
        hotIndexedMessages: result.indexed,
        hotTotalMessages: result.total
      })
    } catch (error) {
      const current = this.index.getStatus()
      this.publish({
        ...current,
        optimizing: false,
        failedFiles: [
          ...current.failedFiles,
          {
            path: 'hot-search-index',
            reason: error instanceof Error ? error.message : String(error)
          }
        ]
      })
    }
  }

  private snapshotPath(
    adapter: CliAdapter,
    transcript: NormalizedTranscript
  ): string {
    return `${adapter.id}://session/${transcript.nativeSessionId}`
  }

  private publish(status: MemoryIndexStatus): void {
    const snapshot = structuredClone(status)
    this.index.setStatus(snapshot)
    this.onProgress(snapshot)
  }
}
