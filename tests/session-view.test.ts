// SPEC-005 会话视图构建单测。验证元数据 ⊕ 实时状态合并与按项目分组。

import { describe, it, expect } from 'vitest'
import {
  projectNameOf,
  buildSessionView,
  buildSessionViews,
  groupByProject
} from '../src/main/domains/sessions/view'
import type { TerminalRunState, WorkbenchSession } from '../src/shared/types'

function session(overrides: Partial<WorkbenchSession>): WorkbenchSession {
  return {
    id: 'id',
    name: 'name',
    toolId: 'claude',
    workspacePath: '/a/b',
    terminalSessionId: null,
    nativeSessionId: null,
    surface: 'terminal',
    permissionPreset: 'safe',
    favorite: false,
    pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function state(overrides: Partial<TerminalRunState>): TerminalRunState {
  return {
    sessionId: 't1',
    toolId: 'claude',
    workspacePath: '/a/b',
    command: 'claude',
    status: 'running',
    backend: 'pty',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-02T00:00:00.000Z',
    exitCode: null,
    outputTail: 'building…',
    ...overrides
  }
}

describe('projectNameOf', () => {
  it('取 PATH basename', () => {
    expect(projectNameOf('/Users/x/upwork/agent-os')).toBe('agent-os')
  })
  it('空路径回退', () => {
    expect(projectNameOf('')).toBe('未命名项目')
  })
})

describe('buildSessionView', () => {
  it('无实时状态时标记 disconnected', () => {
    const view = buildSessionView(session({}), null)
    expect(view.status).toBe('disconnected')
  })
  it('有原生 id 且 adapter 支持恢复时标记 resumable', () => {
    const view = buildSessionView(
      session({ nativeSessionId: 'native-1', terminalSessionId: 'stale-terminal' }),
      null,
      true
    )
    expect(view.status).toBe('resumable')
    expect(view.terminalSessionId).toBeNull()
    expect(view.continuity.state).toBe('ready')
  })
  it('有原生 id 但 adapter 不支持恢复时仍标记 disconnected', () => {
    const view = buildSessionView(session({ nativeSessionId: 'native-1' }), null, false)
    expect(view.status).toBe('disconnected')
    expect(view.continuity.state).toBe('unsupported')
  })
  it('合并实时状态', () => {
    const view = buildSessionView(session({ terminalSessionId: 't1' }), state({}), true)
    expect(view.status).toBe('running')
    expect(view.outputTail).toBe('building…')
    expect(view.lastActivityAt).toBe('2026-01-02T00:00:00.000Z')
    expect(view.continuity.state).toBe('binding')
  })
  it('聊天会话不会被错误标记为终端可恢复', () => {
    const view = buildSessionView(
      session({ surface: 'chat', mode: 'chat', nativeSessionId: 'native-1' }),
      null,
      true
    )
    expect(view.status).toBe('disconnected')
    expect(view.continuity.state).toBe('ready')
  })
})

describe('buildSessionViews', () => {
  it('按 terminalSessionId 关联状态', () => {
    const sessions = [
      session({ id: 's1', terminalSessionId: 't1' }),
      session({ id: 's2', terminalSessionId: null })
    ]
    const views = buildSessionViews(sessions, [state({ sessionId: 't1' })])
    expect(views.find((v) => v.id === 's1')?.status).toBe('running')
    expect(views.find((v) => v.id === 's2')?.status).toBe('disconnected')
  })
  it('归档会话不进入工作台列表，但其持久化数据可由仓储保留', () => {
    const views = buildSessionViews(
      [
        session({ id: 'active' }),
        session({ id: 'archived', archivedAt: '2026-06-23T00:00:00.000Z' })
      ],
      []
    )
    expect(views.map((view) => view.id)).toEqual(['active'])
  })
})

describe('groupByProject', () => {
  it('按工作目录分组并按最近活跃倒序', () => {
    const views = buildSessionViews(
      [
        session({ id: 's1', workspacePath: '/a/old', terminalSessionId: 't1' }),
        session({ id: 's2', workspacePath: '/a/new', terminalSessionId: 't2' })
      ],
      [
        state({ sessionId: 't1', lastActivityAt: '2026-01-01T00:00:00.000Z' }),
        state({ sessionId: 't2', lastActivityAt: '2026-06-01T00:00:00.000Z' })
      ]
    )
    const groups = groupByProject(views)
    expect(groups).toHaveLength(2)
    expect(groups[0].workspacePath).toBe('/a/new')
    expect(groups[0].projectName).toBe('new')
  })

  it('相同路径的本地与远程会话按运行节点隔离', () => {
    const views = buildSessionViews(
      [
        session({ id: 'local', workspacePath: '/workspace/lohas' }),
        session({ id: 'remote-a', workspacePath: '/workspace/lohas', runtimeHostId: 'node-a' }),
        session({ id: 'remote-b', workspacePath: '/workspace/lohas', runtimeHostId: 'node-b' })
      ],
      []
    )

    const groups = groupByProject(views)
    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.runtimeHostId)).toEqual(
      expect.arrayContaining([undefined, 'node-a', 'node-b'])
    )
    expect(groups.every((group) => group.projectName === 'lohas')).toBe(true)
  })
})
