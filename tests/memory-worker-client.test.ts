import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  MemoryWorkerClient,
  type MemoryWorkerLike
} from '../src/main/domains/memory/worker-client'

class FakeWorker extends EventEmitter implements MemoryWorkerLike {
  posted: unknown[] = []

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  async terminate(): Promise<number> {
    return 0
  }
}

describe('MemoryWorkerClient', () => {
  it('关联并发请求响应并转发索引进度', async () => {
    const worker = new FakeWorker()
    const progress: unknown[] = []
    const client = new MemoryWorkerClient(worker, (status) => progress.push(status))

    const search = client.search({ query: 'resume', limit: 10 })
    const status = client.indexStatus()
    const [searchRequest, statusRequest] = worker.posted as Array<{ id: number }>

    worker.emit('message', {
      type: 'progress',
      status: { filesTotal: 2, filesIndexed: 1, building: true, failedFiles: [] }
    })
    worker.emit('message', {
      type: 'response',
      id: statusRequest.id,
      ok: true,
      result: { filesTotal: 2, filesIndexed: 2, building: false, failedFiles: [] }
    })
    worker.emit('message', {
      type: 'response',
      id: searchRequest.id,
      ok: true,
      result: [{ sessionId: 'claude:1' }]
    })

    await expect(search).resolves.toEqual([{ sessionId: 'claude:1' }])
    await expect(status).resolves.toMatchObject({ building: false })
    expect(progress).toHaveLength(1)
    await client.close()
  })

  it('把 worker 错误传播给调用方', async () => {
    const worker = new FakeWorker()
    const client = new MemoryWorkerClient(worker)
    const request = client.indexStatus()
    const [{ id }] = worker.posted as Array<{ id: number }>

    worker.emit('message', {
      type: 'response',
      id,
      ok: false,
      error: 'database unavailable'
    })

    await expect(request).rejects.toThrow('database unavailable')
    await client.close()
  })

  it('关闭后忽略迟到的 worker 进度消息', async () => {
    const worker = new FakeWorker()
    const progress: unknown[] = []
    const client = new MemoryWorkerClient(worker, (status) => progress.push(status))

    await client.close()

    worker.emit('message', {
      type: 'progress',
      status: { filesTotal: 2, filesIndexed: 1, building: true, failedFiles: [] }
    })

    expect(progress).toHaveLength(0)
    await expect(client.indexStatus()).rejects.toThrow('memory worker closed')
    expect(worker.posted).toHaveLength(0)
  })
})
