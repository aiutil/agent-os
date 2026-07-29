import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompareScenario } from '../src/shared/types'

// 用内存数组替代 electron-store，避免测试写入真实用户数据。
const scenarios = vi.hoisted<{ current: CompareScenario[] }>(() => ({ current: [] }))

vi.mock('../src/main/store/app-store', () => ({
  getCompareRuns: () => [],
  setCompareRuns: () => {},
  getCompareScenarios: () => scenarios.current,
  setCompareScenarios: (next: CompareScenario[]) => {
    scenarios.current = next
  }
}))

import { CompareService } from '../src/main/domains/compare/service'

function makeService(): CompareService {
  // deleteScenario / saveScenario / listScenarios 不依赖会话创建，传 stub 即可。
  return new CompareService({
    createSession: async () => ({ session: { id: 'stub' } }),
    writeToSession: async () => true
  })
}

const panes = [
  { id: 'p1', type: 'chat' as const, toolId: 'claude', sessionId: null, lastUrl: null },
  { id: 'p2', type: 'chat' as const, toolId: 'codex', sessionId: null, lastUrl: null }
]

describe('CompareService scenario 删除', () => {
  beforeEach(() => {
    scenarios.current = []
  })

  it('deleteScenario 按 id 移除记录并保留其余（不级联底层会话）', () => {
    const svc = makeService()
    const a = svc.saveScenario({ workspacePath: '/w', prompt: '你好', paneCount: 2, panes })
    svc.saveScenario({ workspacePath: '/w', prompt: '世界', paneCount: 2, panes })
    expect(svc.listScenarios()).toHaveLength(2)

    svc.deleteScenario(a.id)

    const left = svc.listScenarios()
    expect(left).toHaveLength(1)
    expect(left[0].prompt).toBe('世界')
  })

  it('deleteScenario 对不存在的 id 安全（幂等）', () => {
    const svc = makeService()
    svc.saveScenario({ workspacePath: '/w', prompt: '你好', paneCount: 2, panes })
    svc.deleteScenario('does-not-exist')
    expect(svc.listScenarios()).toHaveLength(1)
  })
})
