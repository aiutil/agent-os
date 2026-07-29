import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentTask, PortableBackupV1, RuntimeHost } from '../src/shared/types'
import type { MemoryVault } from '../src/main/domains/memory/vault'

const store = vi.hoisted(() => ({
  language: 'zh' as 'zh' | 'en',
  gamification: true,
  mirror: { npmRegistry: 'https://registry.npmjs.org' } as {
    npmRegistry?: string
    httpsProxy?: string
  },
  providers: {
    codex: {
      toolId: 'codex',
      apiKey: 'production-secret-must-never-export',
      baseUrl: 'https://example.test',
      model: 'native'
    }
  } as Record<string, { toolId: string; apiKey?: string; baseUrl?: string; model?: string }>
}))

vi.mock('../src/main/store/app-store', () => ({
  getLanguage: () => store.language,
  setLanguage: (value: 'zh' | 'en') => {
    store.language = value
  },
  getGamificationEnabled: () => store.gamification,
  setGamificationEnabled: (value: boolean) => {
    store.gamification = value
  },
  getMirrorSettings: () => store.mirror,
  setMirrorSettings: (value: typeof store.mirror) => {
    store.mirror = value
  },
  getProviderConfig: (toolId: string) => store.providers[toolId] ?? { toolId },
  setProviderConfig: (value: (typeof store.providers)[string]) => {
    store.providers[value.toolId] = value
  }
}))

vi.mock('../src/main/domains/adapters/registry', () => ({
  listAdapters: () => [{ id: 'codex' }]
}))

const { PortableBackupService } = await import('../src/main/domains/backup/service')

const memoryState = {
  persona: '偏好简洁回答',
  settings: {
    enabled: true,
    useMemories: true,
    generateMemories: false,
    allowExternalContext: false,
    contextTokenBudget: 1200
  },
  items: []
}

function task(id: string, runtimeHostId?: string): AgentTask {
  return {
    id,
    title: `任务 ${id}`,
    prompt: '第一行\n第二行',
    workspacePath: '/workspace',
    ...(runtimeHostId ? { runtimeHostId } : {}),
    assignee: { toolId: 'codex' },
    boardStatus: 'todo',
    executionStatus: 'idle',
    permissionPreset: 'safe',
    sessionPolicy: 'new',
    schedule: {
      kind: 'interval',
      everyMs: 30 * 60_000,
      anchorAt: '2026-07-23T00:00:00.000Z',
      timeZone: 'Asia/Shanghai',
      enabled: true,
      misfirePolicy: 'run_once',
      nextRunAt: '2026-07-23T00:30:00.000Z'
    },
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z'
  }
}

describe('SPEC-042 安全配置迁移', () => {
  it('导出排除凭据和远程任务，并保留多行任务说明', async () => {
    store.mirror = {
      npmRegistry: 'https://registry.npmjs.org',
      httpsProxy: 'https://proxy-user:proxy-secret@proxy.example.test'
    }
    store.providers.codex.baseUrl = 'https://provider-user:provider-secret@example.test/v1'
    const runtime = {
      listTasks: vi.fn(async () => [
        {
          ...task('local-task'),
          latestRunId: 'run-secret',
          latestSessionId: 'session-secret',
          lastError: 'private failure detail'
        },
        task('remote-task', 'node-1')
      ])
    } as unknown as RuntimeHost
    const vault = {
      portableState: () => structuredClone(memoryState)
    } as unknown as MemoryVault
    const service = new PortableBackupService(runtime, vault, '0.3.6')
    const output = join(mkdtempSync(join(tmpdir(), 'agentos-backup-')), 'safe.json')

    await service.exportTo(output)
    const raw = readFileSync(output, 'utf8')
    const backup = JSON.parse(raw) as PortableBackupV1
    expect(raw).not.toContain('production-secret-must-never-export')
    expect(raw).not.toContain('proxy-secret')
    expect(raw).not.toContain('provider-secret')
    expect(raw).not.toContain('session-secret')
    expect(raw).not.toContain('private failure detail')
    expect(backup.preferences.providers).toEqual([{ toolId: 'codex', model: 'native' }])
    expect(backup.preferences.mirrorSettings.httpsProxy).toBeUndefined()
    expect(backup.tasks).toHaveLength(1)
    expect(backup.tasks[0].prompt).toBe('第一行\n第二行')
  })

  it('导入忽略注入的 apiKey，并强制暂停计划', async () => {
    store.mirror = { npmRegistry: 'https://registry.npmjs.org' }
    store.providers.codex.baseUrl = 'https://example.test'
    const created: AgentTask[] = []
    const runtime = {
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(async (input) => {
        const value = {
          ...task(input.portableId ?? 'created'),
          ...input,
          id: input.portableId ?? 'created'
        } as AgentTask
        created.push(value)
        return value
      }),
      updateTask: vi.fn(async () => null),
      removeTask: vi.fn(async () => undefined)
    } as unknown as RuntimeHost
    const vault = {
      portableState: () => structuredClone(memoryState),
      replacePortableState: vi.fn()
    } as unknown as MemoryVault
    const service = new PortableBackupService(runtime, vault, '0.3.6')
    const file = join(mkdtempSync(join(tmpdir(), 'agentos-import-')), 'input.json')
    const backup = await service.build()
    backup.tasks = [task('imported')]
    const providerWithAttack = {
      ...backup.preferences.providers[0],
      apiKey: 'attacker-overwrite'
    }
    backup.preferences.providers = [providerWithAttack]
    writeFileSync(file, JSON.stringify(backup))

    const result = await service.importFrom(file)

    expect(result.schedulesPaused).toBe(1)
    expect(created[0].schedule).toMatchObject({ kind: 'interval', enabled: false })
    expect(created[0].schedule?.nextRunAt).toBeUndefined()
    expect(created[0].id).toBe('imported')
    expect(store.providers.codex.apiKey).toBe('production-secret-must-never-export')
  })

  it('预览指纹变化或 schema 无效时零写入', async () => {
    store.mirror = { npmRegistry: 'https://registry.npmjs.org' }
    store.providers.codex.baseUrl = 'https://example.test'
    const runtime = {
      listTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      updateTask: vi.fn(),
      removeTask: vi.fn()
    } as unknown as RuntimeHost
    const vault = {
      portableState: () => structuredClone(memoryState),
      replacePortableState: vi.fn()
    } as unknown as MemoryVault
    const service = new PortableBackupService(runtime, vault, '0.3.6')
    const file = join(mkdtempSync(join(tmpdir(), 'agentos-import-guard-')), 'input.json')
    const backup = await service.build()
    backup.tasks = [task('imported-task')]
    writeFileSync(file, JSON.stringify(backup))
    const fingerprint = service.fingerprint(file)

    backup.tasks[0].permissionPreset = 'root' as never
    writeFileSync(file, JSON.stringify(backup))
    await expect(service.importFrom(file, fingerprint)).rejects.toThrow('预览后发生变化')
    await expect(service.importFrom(file)).rejects.toThrow('任务枚举值无效')

    backup.tasks[0].permissionPreset = 'safe'
    backup.preferences.providers = [{ toolId: '__proto__.credential' }]
    writeFileSync(file, JSON.stringify(backup))
    await expect(service.importFrom(file)).rejects.toThrow('未知 provider')

    expect(vault.replacePortableState).not.toHaveBeenCalled()
    expect(runtime.createTask).not.toHaveBeenCalled()
    expect(runtime.updateTask).not.toHaveBeenCalled()
  })
})
