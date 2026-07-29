// SPEC-033：联邦层 listModels 路由。
// 验证 FederatedRuntimeHost.listModels(toolId, hostId?) 按 host 路由、缺省/未知回退本机、
// 节点抛错（旧版节点不认识 listModels）降级返回空——对应 ModelPicker 的锁定态降级路径。

import { describe, expect, it } from 'vitest'
import type { RuntimeHost, ToolModelInfo } from '../src/shared/types'
import { FederatedRuntimeHost } from '../src/main/domains/runtime/federated-runtime-host'

const A: ToolModelInfo = { id: 'claude-a', label: '本机 Opus', provider: 'anthropic' }
const B: ToolModelInfo = { id: 'claude-b', label: '节点 Sonnet', provider: 'anthropic' }

function fakeHost(models: ToolModelInfo[], opts: { throw?: boolean } = {}): RuntimeHost {
  return {
    subscribe: () => () => {},
    listModels: async () => {
      if (opts.throw) throw new Error('boom')
      return { models, source: 'native' as const, supportsCustomModel: true }
    }
  } as unknown as RuntimeHost
}

describe('SPEC-033 联邦 listModels 路由', () => {
  it('缺省与未知 hostId 均回退本机', async () => {
    const fed = new FederatedRuntimeHost(fakeHost([A]), 'local')
    fed.addHost('node-1', fakeHost([B]))
    expect((await fed.listModels('claude')).models).toEqual([A])
    expect((await fed.listModels('claude', 'does-not-exist')).models).toEqual([A])
  })

  it('按 hostId 路由到指定节点', async () => {
    const fed = new FederatedRuntimeHost(fakeHost([A]), 'local')
    fed.addHost('node-1', fakeHost([B]))
    expect((await fed.listModels('claude', 'node-1')).models).toEqual([B])
  })

  it('节点抛错 → 返回空（旧版节点的降级路径）', async () => {
    const fed = new FederatedRuntimeHost(fakeHost([A]), 'local')
    fed.addHost('node-1', fakeHost([], { throw: true }))
    expect(await fed.listModels('claude', 'node-1')).toEqual({
      models: [],
      source: 'unavailable',
      supportsCustomModel: true
    })
  })
})
