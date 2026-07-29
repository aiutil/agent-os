import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAdapter } from '../src/main/domains/adapters/registry'
import { MemoryIndex } from '../src/main/domains/memory/index'
import { UNASSIGNED_STATS_PROJECT_KEY } from '../src/shared/types'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('stats index', () => {
  it('成长记忆数只使用显式传入的真实经验条目数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-stats-'))
    tempDirs.push(dir)
    const index = new MemoryIndex(join(dir, 'index.sqlite'))

    expect(index.getStatsGrowth(7).memoriesCount).toBe(7)
    expect(index.getStatsGrowth(0).memoriesCount).toBe(0)
    index.close()
  })

  it('聚合 token、成本与真实用户提示，并按工具/项目过滤', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-stats-'))
    tempDirs.push(dir)
    const source = join(dir, 'claude.jsonl')
    writeFileSync(
      source,
      [
        {
          type: 'user',
          sessionId: 'stats-session',
          cwd: '/workspace/stats',
          timestamp: '2026-06-12T01:00:00.000Z',
          message: { role: 'user', content: '第一条提示' }
        },
        {
          type: 'user',
          sessionId: 'stats-session',
          cwd: '/workspace/stats',
          timestamp: '2026-06-12T01:00:01.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: '工具回执' }]
          }
        },
        {
          type: 'assistant',
          sessionId: 'stats-session',
          cwd: '/workspace/stats',
          timestamp: '2026-06-12T01:00:02.000Z',
          message: {
            id: 'msg-1',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: [{ type: 'text', text: '完成' }],
            usage: {
              input_tokens: 1000,
              output_tokens: 100,
              cache_creation_input_tokens: 200,
              cache_read_input_tokens: 300
            }
          }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n'
    )

    const index = new MemoryIndex(join(dir, 'index.sqlite'))
    await index.indexFile(getAdapter('claude')!, source)
    const summary = index.getStatsSummary({
      range: 'all',
      toolIds: ['claude'],
      workspacePath: '/workspace/stats'
    })
    const dashboard = index.getStatsDashboard({
      range: 'all',
      toolIds: ['claude'],
      workspacePath: '/workspace/stats'
    })
    const models = index.getStatsModels({
      range: 'all',
      toolIds: ['claude'],
      workspacePath: '/workspace/stats'
    })
    const projects = index.getStatsProjects()
    const activity = index.getStatsActivity({ range: 'all' })

    expect(summary.sessions).toBe(1)
    expect(summary.prompts).toBe(1)
    expect(summary.tokens).toEqual({
      input: 1000,
      output: 100,
      cacheWrite: 200,
      cacheRead: 300,
      total: 1600
    })
    expect(summary.estimatedCostUsd).toBeCloseTo(0.00534)
    expect(summary.hasUnpricedUsage).toBe(false)
    expect(summary.byProject).toContainEqual({
      key: '/workspace/stats',
      label: '/workspace/stats',
      sessions: 1,
      prompts: 1,
      tokens: 1600,
      estimatedCostUsd: expect.any(Number),
      hasUnpricedUsage: false
    })
    expect(summary.trend).toContainEqual({
      date: '2026-06-12',
      prompts: 0,
      tokens: 1600,
      estimatedCostUsd: expect.any(Number)
    })
    expect(summary.byModel[0]?.key).toBe('claude-sonnet-4-6')
    expect(summary.modelTrend.some((point) => point.model === 'claude-sonnet-4-6')).toBe(true)
    expect(dashboard.summary.tokens.total).toBe(1600)
    expect(dashboard.activity.totalPrompts).toBe(1)
    expect(dashboard.projects).toContainEqual({ key: '/workspace/stats', label: '/workspace/stats' })
    expect(models.tokens.total).toBe(1600)
    expect(models.byModel[0]?.tokens.total).toBe(1600)
    expect(models.modelTrend.some((point) => point.model === 'claude-sonnet-4-6')).toBe(true)
    expect(projects).toContainEqual({ key: '/workspace/stats', label: '/workspace/stats' })
    expect(activity.totalPrompts).toBe(1)
    expect(activity.days.find((day) => day.date === '2026-06-12')?.prompts).toBe(1)
    index.close()
  })

  it('未知模型有 token 但费用保持未定价而不是零', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-stats-'))
    tempDirs.push(dir)
    const source = join(dir, 'claude.jsonl')
    writeFileSync(
      source,
      [
        {
          type: 'user',
          sessionId: 'unknown-price',
          cwd: '/workspace/stats',
          timestamp: '2026-06-12T01:00:00.000Z',
          message: { role: 'user', content: '提示' }
        },
        {
          type: 'assistant',
          sessionId: 'unknown-price',
          cwd: '/workspace/stats',
          timestamp: '2026-06-12T01:00:01.000Z',
          message: {
            id: 'unknown-1',
            role: 'assistant',
            model: 'private-proxy-model',
            content: '完成',
            usage: { input_tokens: 100, output_tokens: 10 }
          }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n'
    )
    const index = new MemoryIndex(join(dir, 'index.sqlite'))
    await index.indexFile(getAdapter('claude')!, source)

    const summary = index.getStatsSummary({ range: 'all' })
    expect(summary.tokens.total).toBe(110)
    expect(summary.estimatedCostUsd).toBeNull()
    expect(summary.hasUnpricedUsage).toBe(true)
    index.close()
  })

  it('缺少工作目录的会话可从未识别项目分组继续查看', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-stats-'))
    tempDirs.push(dir)
    const source = join(dir, 'claude.jsonl')
    writeFileSync(
      source,
      [
        {
          type: 'user',
          sessionId: 'unassigned-project',
          timestamp: '2026-06-12T01:00:00.000Z',
          message: { role: 'user', content: '无工作目录提示' }
        },
        {
          type: 'assistant',
          sessionId: 'unassigned-project',
          timestamp: '2026-06-12T01:00:01.000Z',
          message: {
            id: 'unassigned-1',
            role: 'assistant',
            model: 'claude-sonnet-4-6',
            content: '完成',
            usage: { input_tokens: 40, output_tokens: 10 }
          }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n'
    )

    const index = new MemoryIndex(join(dir, 'index.sqlite'))
    await index.indexFile(getAdapter('claude')!, source)

    const all = index.getStatsSummary({ range: 'all' })
    const unassigned = index.getStatsSummary({
      range: 'all',
      unassignedWorkspace: true
    })

    expect(all.byProject).toContainEqual({
      key: UNASSIGNED_STATS_PROJECT_KEY,
      label: '未识别项目',
      sessions: 1,
      prompts: 1,
      tokens: 50,
      estimatedCostUsd: expect.any(Number),
      hasUnpricedUsage: false
    })
    expect(unassigned.sessions).toBe(1)
    expect(unassigned.prompts).toBe(1)
    expect(unassigned.tokens.total).toBe(50)
    expect(unassigned.trend).toContainEqual({
      date: '2026-06-12',
      prompts: 0,
      tokens: 50,
      estimatedCostUsd: expect.any(Number)
    })
    index.close()
  })
})
