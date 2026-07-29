// SPEC-004 终端状态机单测。验证状态迁移、ANSI 清洗、idle/exit/disconnect。

import { describe, it, expect } from 'vitest'
import {
  TerminalRunStateMachine,
  appendOutputTail,
  sanitizeTail
} from '../src/main/domains/terminal/run-state'

describe('sanitizeTail', () => {
  it('去除 ANSI CSI 与 OSC 转义并保留可读文本', () => {
    const raw = '\x1b[32mok\x1b[0m\r\n\x1b]0;title\x07done'
    expect(sanitizeTail(raw)).toBe('ok\ndone')
  })

  it('仅保留最后 12 行', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n')
    const tail = sanitizeTail(lines)
    expect(tail.split('\n')).toHaveLength(12)
    expect(tail.split('\n')[0]).toBe('line8')
  })
})

describe('appendOutputTail', () => {
  it('把新数据并入既有尾巴', () => {
    expect(appendOutputTail('a\nb', 'c')).toBe('a\nb\nc')
  })
})

describe('TerminalRunStateMachine', () => {
  function freshMachine(clockRef: { t: number }) {
    return new TerminalRunStateMachine({
      now: () => new Date(clockRef.t).toISOString(),
      clock: () => clockRef.t,
      idleThresholdMs: 1000
    })
  }

  it('createState 初始为 starting', () => {
    const m = freshMachine({ t: 0 })
    const state = m.createState({ sessionId: 's1', toolId: 'claude' })
    expect(state.status).toBe('starting')
    expect(state.exitCode).toBeNull()
  })

  it('feedData 把 starting/waiting_input 推进到 running', () => {
    const m = freshMachine({ t: 0 })
    m.createState({ sessionId: 's1' })
    expect(m.feedData('s1', 'hi')?.status).toBe('running')
  })

  it('idle 阈值到达后 running → waiting_input', () => {
    const clock = { t: 0 }
    const m = freshMachine(clock)
    m.createState({ sessionId: 's1' })
    m.feedData('s1', 'hi')
    clock.t = 2000
    expect(m.feedIdle('s1')?.status).toBe('waiting_input')
  })

  it('exit 0 → completed，exit≠0 → failed', () => {
    const m = freshMachine({ t: 0 })
    m.createState({ sessionId: 'ok' })
    expect(m.feedExit('ok', 0)?.status).toBe('completed')
    m.createState({ sessionId: 'bad' })
    const failed = m.feedExit('bad', 1)
    expect(failed?.status).toBe('failed')
    expect(failed?.exitCode).toBe(1)
  })

  it('退出后忽略后续 data', () => {
    const m = freshMachine({ t: 0 })
    m.createState({ sessionId: 's1' })
    m.feedExit('s1', 0)
    expect(m.feedData('s1', 'late')?.status).toBe('completed')
  })

  it('disconnect 标记 disconnected', () => {
    const m = freshMachine({ t: 0 })
    m.createState({ sessionId: 's1' })
    expect(m.feedDisconnected('s1')?.status).toBe('disconnected')
  })

  it('未知 sessionId 返回 null', () => {
    const m = freshMachine({ t: 0 })
    expect(m.feedData('nope', 'x')).toBeNull()
  })
})
