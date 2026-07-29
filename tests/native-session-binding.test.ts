import { describe, expect, it } from 'vitest'
import {
  backfillManagedNativeSessions,
  nativeSessionExists,
  observeNativeSession
} from '../src/main/domains/sessions/native-session-binding'
import type { AdapterSessionStorage, SessionFileRef } from '../src/shared/types'
import type { CliAdapter } from '../src/main/domains/adapters/types'

function ref(path: string, nativeSessionId: string, mtime: number): SessionFileRef {
  return { path, nativeSessionId, toolId: 'codex', mtime }
}

function storage(
  lists: SessionFileRef[][],
  cwdByPath: Record<string, string | null>
): AdapterSessionStorage {
  let index = 0
  return {
    support: 'full',
    rootDirs: () => ['/sessions'],
    locateDir: () => '/sessions',
    listSessionFiles: () => lists[Math.min(index++, lists.length - 1)] ?? [],
    async readMeta(path) {
      return {
        nativeSessionId: path,
        cwd: cwdByPath[path] ?? null,
        title: path,
        startedAt: null
      }
    }
  }
}

describe('observeNativeSession', () => {
  it('只绑定快照后新增且 cwd 匹配的原生会话', async () => {
    const result = await observeNativeSession({
      storage: storage(
        [
          [ref('/old', 'old', 1)],
          [ref('/old', 'old', 1), ref('/wrong', 'wrong', 3), ref('/match', 'match', 4)]
        ],
        { '/wrong': '/other', '/match': '/project' }
      ),
      cwd: '/project',
      timeoutMs: 10,
      pollIntervalMs: 0
    })

    expect(result).toBe('match')
  })

  it('并发观察使用各自快照与 cwd，不会串绑', async () => {
    const shared = storage(
      [
        [],
        [],
        [ref('/a', 'session-a', 2), ref('/b', 'session-b', 2)],
        [ref('/a', 'session-a', 2), ref('/b', 'session-b', 2)]
      ],
      { '/a': '/project-a', '/b': '/project-b' }
    )

    const [a, b] = await Promise.all([
      observeNativeSession({
        storage: shared,
        cwd: '/project-a',
        timeoutMs: 10,
        pollIntervalMs: 0
      }),
      observeNativeSession({
        storage: shared,
        cwd: '/project-b',
        timeoutMs: 10,
        pollIntervalMs: 0
      })
    ])

    expect(a).toBe('session-a')
    expect(b).toBe('session-b')
  })

  it('按原生 id 与 cwd 校验会话文件是否仍存在', async () => {
    const source = storage([[ref('/match', 'session-a', 2), ref('/wrong', 'session-b', 2)]], {
      '/match': '/project-a',
      '/wrong': '/project-b'
    })

    await expect(nativeSessionExists(source, '/project-a', 'session-a')).resolves.toBe(true)
    await expect(nativeSessionExists(source, '/project-a', 'session-b')).resolves.toBe(false)
    await expect(nativeSessionExists(source, '/project-a', 'missing')).resolves.toBe(false)
  })

  it('支持 SQLite 风格的逻辑会话快照', async () => {
    const source: AdapterSessionStorage = {
      support: 'full',
      incremental: false,
      rootDirs: () => ['/sessions.db'],
      locateDir: () => '/sessions.db',
      listSessionFiles: () => [],
      listNativeSessions: () => [
        {
          path: '/sessions.db#session-a',
          nativeSessionId: 'session-a',
          toolId: 'opencode',
          cwd: '/project-a',
          createdAt: 100,
          mtime: 200
        }
      ]
    }

    await expect(nativeSessionExists(source, '/project-a', 'session-a')).resolves.toBe(true)
  })

  it('只在 Agent、cwd 和创建时间唯一匹配时回填托管会话', async () => {
    const source: AdapterSessionStorage = {
      support: 'full',
      rootDirs: () => ['/sessions'],
      locateDir: () => '/sessions',
      listSessionFiles: () => [],
      listNativeSessions: () =>
        [
          ref('/a', 'native-a', 1_000),
          { ...ref('/b1', 'native-b1', 1_000), cwd: '/project-b' },
          { ...ref('/b2', 'native-b2', 1_001), cwd: '/project-b' }
        ].map((item) => ({
          ...item,
          cwd: item.cwd ?? '/project-a',
          createdAt: item.mtime
        }))
    }
    const adapter = {
      id: 'codex',
      sessionStorage: source,
      buildResumeCommand: () => 'resume'
    } as unknown as CliAdapter
    const bound: Array<[string, string]> = []

    await backfillManagedNativeSessions({
      sessions: [
        {
          id: 'managed-a',
          name: 'A',
          toolId: 'codex',
          workspacePath: '/project-a',
          terminalSessionId: null,
          nativeSessionId: null,
          surface: 'terminal',
          permissionPreset: 'safe',
          favorite: false,
          pinned: false,
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(1_000).toISOString()
        },
        {
          id: 'managed-b',
          name: 'B',
          toolId: 'codex',
          workspacePath: '/project-b',
          terminalSessionId: null,
          nativeSessionId: null,
          surface: 'terminal',
          permissionPreset: 'safe',
          favorite: false,
          pinned: false,
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(1_000).toISOString()
        }
      ],
      getAdapter: () => adapter,
      bindNativeSession: (id, nativeSessionId) => bound.push([id, nativeSessionId])
    })

    expect(bound).toEqual([['managed-a', 'native-a']])
  })

  it('大量存量 transcript 的元数据读取限制并发，避免启动时耗尽文件句柄', async () => {
    let active = 0
    let maxActive = 0
    const files = Array.from({ length: 40 }, (_, index) =>
      ref(`/session-${index}`, `native-${index}`, 1_000 + index)
    )
    const source: AdapterSessionStorage = {
      support: 'full',
      rootDirs: () => ['/sessions'],
      locateDir: () => '/sessions',
      listSessionFiles: () => files,
      async readMeta(path) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 2))
        active -= 1
        return {
          nativeSessionId: path,
          cwd: '/project',
          title: path,
          startedAt: new Date(1_000).toISOString()
        }
      }
    }
    const adapter = {
      id: 'codex',
      sessionStorage: source,
      buildResumeCommand: () => 'resume'
    } as unknown as CliAdapter

    await backfillManagedNativeSessions({
      sessions: [
        {
          id: 'managed',
          name: 'Managed',
          toolId: 'codex',
          workspacePath: '/project',
          terminalSessionId: null,
          nativeSessionId: null,
          surface: 'terminal',
          permissionPreset: 'safe',
          favorite: false,
          pinned: false,
          createdAt: new Date(1_000).toISOString(),
          updatedAt: new Date(1_000).toISOString()
        }
      ],
      getAdapter: () => adapter,
      bindNativeSession: () => undefined
    })

    expect(maxActive).toBeLessThanOrEqual(8)
  })
})
