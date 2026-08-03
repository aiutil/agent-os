import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  remoteNodeTipLabel,
  remoteRuntimeHostId,
  sessionProjectGroupKey
} from '../src/shared/session-origin'
import type { RemoteNodeStatus } from '../src/shared/types'

const remoteStatus: RemoteNodeStatus = {
  id: 'node-study',
  label: '书房 Mac',
  host: '192.0.2.10',
  port: 4242,
  connection: 'connected'
}

describe('SPEC-044 会话运行来源', () => {
  it('本机不显示 tip，且 undefined/local 使用同一分组身份', () => {
    expect(remoteRuntimeHostId()).toBeUndefined()
    expect(remoteRuntimeHostId('local')).toBeUndefined()
    expect(remoteNodeTipLabel('local', [remoteStatus], '远程节点')).toBeNull()
    expect(sessionProjectGroupKey('/workspace/lohas')).toBe(
      sessionProjectGroupKey('/workspace/lohas', 'local')
    )
  })

  it('远程项目按节点隔离并优先显示节点名称', () => {
    expect(sessionProjectGroupKey('/workspace/lohas', 'node-study')).not.toBe(
      sessionProjectGroupKey('/workspace/lohas')
    )
    expect(remoteNodeTipLabel('node-study', [remoteStatus], '远程节点')).toBe('书房 Mac')
  })

  it('节点状态未加载时仍显示远程兜底 tip', () => {
    expect(remoteNodeTipLabel('node-offline', [], '远程节点')).toBe('远程节点')
  })

  it('当前 V3 会话/CLI 面板使用节点分组和节点 tip', () => {
    const panel = readFileSync(
      'src/renderer/src/v3/sections/chat/ChatSecPanel.tsx',
      'utf8'
    )
    expect(panel).toContain('sessionProjectGroupKey(path, runtimeHostId)')
    expect(panel).toContain('remoteNodeTipLabel(')
    expect(panel).toContain('chat-folder__node-tip')
  })
})
