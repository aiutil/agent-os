import { describe, expect, it } from 'vitest'
import {
  assessDataPlaneHealth,
  DataPlaneHealthRegistry,
  inspectDataPlaneFile
} from '../src/main/domains/diagnostics/data-plane-health'
import { resolve } from 'node:path'
import { getDataPlaneDegradationNotice } from '../src/shared/data-plane-notice'

describe('assessDataPlaneHealth', () => {
  it('partial adapter 始终标记为 partial', () => {
    expect(
      assessDataPlaneHealth({
        toolId: 'gemini',
        cliVersion: 'unknown',
        support: 'partial',
        totalLines: 0,
        parseErrors: 0,
        requiredFieldsPresent: false
      })
    ).toEqual({
      toolId: 'gemini',
      cliVersion: 'unknown',
      status: 'partial',
      sampleErrors: ['该适配器仅支持会话定位，暂不支持详情解析']
    })
  })

  it('坏行比例超过 10% 时标记 drifted', () => {
    const health = assessDataPlaneHealth({
      toolId: 'claude',
      cliVersion: '2.1.170',
      support: 'full',
      totalLines: 10,
      parseErrors: 3,
      requiredFieldsPresent: true
    })
    expect(health).toMatchObject({
      status: 'drifted',
      sampleErrors: ['解析错误比例 30.0%，超过 10% 阈值']
    })
    expect(getDataPlaneDegradationNotice([health])).toEqual([
      'claude 格式漂移'
    ])
  })

  it('必取元数据缺失时标记 drifted', () => {
    expect(
      assessDataPlaneHealth({
        toolId: 'codex',
        cliVersion: '0.137.0',
        support: 'full',
        totalLines: 20,
        parseErrors: 0,
        requiredFieldsPresent: false
      })
    ).toMatchObject({
      status: 'drifted',
      sampleErrors: ['缺少 nativeSessionId 或 title']
    })
  })

  it('没有样本时保持 untested，其余健康样本为 ok', () => {
    expect(
      assessDataPlaneHealth({
        toolId: 'claude',
        cliVersion: 'unknown',
        support: 'full',
        totalLines: 0,
        parseErrors: 0,
        requiredFieldsPresent: false,
        hasSample: false
      }).status
    ).toBe('untested')
    expect(
      assessDataPlaneHealth({
        toolId: 'claude',
        cliVersion: '2.1.170',
        support: 'full',
        totalLines: 100,
        parseErrors: 1,
        requiredFieldsPresent: true
      }).status
    ).toBe('ok')
  })
})

describe('DataPlaneHealthRegistry', () => {
  it('按 toolId + cliVersion 更新并稳定排序', () => {
    const registry = new DataPlaneHealthRegistry()
    registry.record({
      toolId: 'codex',
      cliVersion: '0.137.0',
      status: 'ok',
      sampleErrors: []
    })
    registry.record({
      toolId: 'claude',
      cliVersion: '2.1.170',
      status: 'drifted',
      sampleErrors: ['bad']
    })
    registry.record({
      toolId: 'codex',
      cliVersion: '0.137.0',
      status: 'drifted',
      sampleErrors: ['changed']
    })

    expect(registry.list()).toEqual([
      {
        toolId: 'claude',
        cliVersion: '2.1.170',
        status: 'drifted',
        sampleErrors: ['bad']
      },
      {
        toolId: 'codex',
        cliVersion: '0.137.0',
        status: 'drifted',
        sampleErrors: ['changed']
      }
    ])
  })
})

describe('inspectDataPlaneFile', () => {
  it('从 Claude fixture 检测版本并完成健康评估', async () => {
    const health = await inspectDataPlaneFile(
      'claude',
      resolve(
        'tests',
        'fixtures',
        'transcripts',
        'claude',
        '2.1.170',
        'session.jsonl'
      )
    )

    expect(health).toEqual({
      toolId: 'claude',
      cliVersion: '2.1.170',
      status: 'ok',
      sampleErrors: []
    })
  })

  it('从 Codex fixture 检测版本并完成健康评估', async () => {
    const health = await inspectDataPlaneFile(
      'codex',
      resolve(
        'tests',
        'fixtures',
        'transcripts',
        'codex',
        '0.94.0',
        'session.jsonl'
      )
    )

    expect(health.cliVersion).toBe('0.94.0')
    expect(health.status).toBe('ok')
  })
})
