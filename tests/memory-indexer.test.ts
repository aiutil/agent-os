import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAdapter } from '../src/main/domains/adapters/registry'
import type { CliAdapter } from '../src/main/domains/adapters/types'
import { MemoryIndex } from '../src/main/domains/memory/index'
import { MemoryIndexer } from '../src/main/domains/memory/indexer'
import type {
  MemoryIndexStatus,
  NormalizedTranscript
} from '../src/shared/types'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('MemoryIndexer', () => {
  it('对 full adapter 全量对账并持续报告进度，partial adapter 不进入解析队列', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-indexer-'))
    tempDirs.push(dir)
    const claudeRoot = join(dir, 'claude')
    const geminiRoot = join(dir, 'gemini')
    mkdirSync(claudeRoot)
    mkdirSync(geminiRoot)
    copyFileSync(
      resolve('tests/fixtures/transcripts/claude/2.1.170/session.jsonl'),
      join(claudeRoot, 'session.jsonl')
    )
    const index = new MemoryIndex(join(dir, 'index.sqlite'))
    const statuses: MemoryIndexStatus[] = []
    const indexer = new MemoryIndexer(index, [
      { adapter: getAdapter('claude')!, roots: [claudeRoot] },
      { adapter: getAdapter('gemini')!, roots: [geminiRoot] }
    ], (status) => statuses.push(status))

    await indexer.reconcile()

    expect(index.search({ query: '', limit: 10 })).toHaveLength(1)
    expect(statuses[0]).toMatchObject({ filesTotal: 1, filesIndexed: 0, building: true })
    expect(statuses.at(-1)).toMatchObject({ filesTotal: 1, filesIndexed: 1, building: false })
    expect(statuses.at(-1)?.failedFiles).toEqual([])
    await indexer.close()
  })

  it('逐条消费数据库快照并移除已失效的虚拟会话', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-snapshot-indexer-'))
    tempDirs.push(dir)
    const snapshots: NormalizedTranscript[] = [
      {
        nativeSessionId: 'snapshot-1',
        toolId: 'snapshot',
        cwd: '/tmp/project',
        title: 'Snapshot session',
        startedAt: '2026-06-13T08:00:00.000Z',
        lastActivityAt: '2026-06-13T08:01:00.000Z',
        messages: [
          {
            seq: 0,
            role: 'user',
            text: '真实用户消息',
            ts: '2026-06-13T08:00:00.000Z'
          }
        ],
        parseErrors: 0
      }
    ]
    const adapter = {
      id: 'snapshot',
      displayName: 'Snapshot',
      executable: 'snapshot',
      versionArgs: ['--version'],
      parseVersion: () => undefined,
      installHint: '',
      runtime: 'test',
      buildLaunchCommand: () => 'snapshot',
      sessionStorage: {
        support: 'full',
        incremental: false,
        rootDirs: () => [],
        locateDir: () => null,
        listSessionFiles: () => [],
        async *scanTranscripts() {
          yield* snapshots
        }
      }
    } satisfies CliAdapter
    const index = new MemoryIndex(join(dir, 'index.sqlite'))
    const statuses: MemoryIndexStatus[] = []
    const indexer = new MemoryIndexer(
      index,
      [{ adapter, roots: [] }],
      (status) => statuses.push(status)
    )

    await indexer.reconcile()
    expect(index.search({ query: '', limit: 10 })).toHaveLength(1)
    expect(statuses.at(-1)).toMatchObject({
      filesTotal: 1,
      filesIndexed: 1,
      building: false
    })

    snapshots.splice(0)
    await indexer.reconcile()
    expect(index.search({ query: '', limit: 10 })).toHaveLength(0)
    await indexer.close()
  })
})
