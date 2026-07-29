// SPEC-034 消息渠道 —— 纯逻辑单测（acl / renderer / router）。
// 不触达 electron-store / 飞书 SDK，保证可移植、快。

import { describe, expect, it } from 'vitest'
import { isAllowed } from '../src/main/domains/channels/acl'
import {
  ackSegments,
  buildReplySegments,
  chunkSegments,
  toolProgressLine,
  parseCommand
} from '../src/main/domains/channels/renderer'
import {
  bindingKey,
  findBinding,
  resolveBinding,
  type RouterDeps
} from '../src/main/domains/channels/router'
import type { ChannelBinding, WorkbenchSession } from '../src/shared/types'
import type { InboundChannelMessage } from '../src/main/domains/channels/transport'

const msg = (over: Partial<InboundChannelMessage> = {}): InboundChannelMessage => ({
  deliveryId: 'feishu-message-1',
  accountId: 'a1',
  platform: 'feishu',
  chatType: 'private',
  chatId: 'oc_x',
  userId: 'ou_me',
  segments: [{ type: 'text', data: { text: 'hi' } }],
  text: 'hi',
  ...over
})

const BINDING: ChannelBinding = {
  platform: 'feishu',
  accountId: 'a1',
  chatType: 'private',
  chatId: 'oc_x',
  conversationId: 's1',
  toolId: 'claude',
  workspacePath: '/tmp'
}

describe('channels acl (SPEC-034)', () => {
  it('存量无 mode ACL 保持 legacy-open，避免升级后静默断流', () => {
    expect(isAllowed(undefined, 'u1')).toBe(true)
    expect(isAllowed({ allowlist: [] }, 'u1')).toBe(true)
  })
  it('新账号 owner / allowlist / open 模式语义明确', () => {
    expect(isAllowed({ mode: 'owner', ownerId: 'u1', allowlist: [] }, 'u1')).toBe(true)
    expect(isAllowed({ mode: 'owner', ownerId: 'u1', allowlist: [] }, 'u2')).toBe(false)
    expect(isAllowed({ mode: 'owner', allowlist: [] }, 'u1')).toBe(false)
    expect(isAllowed({ mode: 'allowlist', allowlist: ['u2'] }, 'u2')).toBe(true)
    expect(isAllowed({ mode: 'open', allowlist: [] }, 'u9')).toBe(true)
  })
  it('非空 allowlist 必须命中', () => {
    expect(isAllowed({ allowlist: ['ou_x'] }, 'ou_x')).toBe(true)
    expect(isAllowed({ allowlist: ['ou_x'] }, 'ou_y')).toBe(false)
  })
})

describe('channels renderer (SPEC-034)', () => {
  it('buildReplySegments 仅返回正文（深链已隐藏）', () => {
    expect(buildReplySegments('hello', 'agentos://session/s1')).toEqual([
      { type: 'text', data: { text: 'hello' } }
    ])
    expect(buildReplySegments('  ', 'agentos://session/s1')).toEqual([])
  })
  it('ackSegments', () => {
    expect(ackSegments('claude')).toEqual([{ type: 'text', data: { text: '⏳ claude 接手中…' } }])
  })
  it('chunkSegments 去空白、空文本返回空', () => {
    expect(chunkSegments('  hi  ')).toEqual([{ type: 'text', data: { text: 'hi' } }])
    expect(chunkSegments('   ')).toEqual([])
  })
  it('toolProgressLine 取有信息量入参并截断', () => {
    expect(toolProgressLine('Read', { file_path: '/a/b.ts' })).toBe('🔧 Read · /a/b.ts')
    expect(toolProgressLine('Bash', { command: 'ls -la' })).toBe('🔧 Bash · ls -la')
    expect(toolProgressLine('Glob', {})).toBe('🔧 Glob')
    const long = 'x'.repeat(100)
    expect(toolProgressLine('Grep', { pattern: long })).toBe(`🔧 Grep · ${'x'.repeat(59)}…`)
  })
  it('parseCommand 识别已知命令与参数', () => {
    expect(parseCommand('/stop')).toEqual({ cmd: 'stop', arg: '' })
    expect(parseCommand('/help')).toEqual({ cmd: 'help', arg: '' })
    expect(parseCommand('/help@AgentOsBot')).toEqual({ cmd: 'help', arg: '' })
    expect(parseCommand('/use claude')).toEqual({ cmd: 'use', arg: 'claude' })
    expect(parseCommand('/sessions')).toEqual({ cmd: 'sessions', arg: '' })
    expect(parseCommand('/session 2')).toEqual({ cmd: 'session', arg: '2' })
    expect(parseCommand('/tasks')).toEqual({ cmd: 'tasks', arg: '' })
    expect(parseCommand('/task add 每隔30分钟检查 ISSUE')).toEqual({
      cmd: 'task',
      arg: 'add 每隔30分钟检查 ISSUE'
    })
    expect(parseCommand('/steer 先修测试')).toEqual({ cmd: 'steer', arg: '先修测试' })
    expect(parseCommand('普通消息')).toBeNull()
    expect(parseCommand('/unknown whatever')).toEqual({ cmd: 'unknown', arg: 'unknown' })
    expect(parseCommand('/未知')).toEqual({ cmd: 'unknown', arg: '未知' })
  })
})

describe('channels router (SPEC-034)', () => {
  it('bindingKey 稳定', () => {
    expect(bindingKey('feishu', 'a1', 'private', 'oc_x')).toBe('feishu:a1:private:oc_x')
  })

  it('findBinding 命中已有绑定', () => {
    const deps: RouterDeps = {
      listBindings: () => [BINDING],
      saveBinding: () => {},
      createChannelSession: async () => {
        throw new Error('不应新建')
      },
      pickDefaultAgent: async () => null
    }
    expect(findBinding(deps, msg())).toBe(BINDING)
  })

  it('resolveBinding 有绑定时复用、不新建', async () => {
    let saved: ChannelBinding | null = null
    const deps: RouterDeps = {
      listBindings: () => [BINDING],
      saveBinding: (b) => {
        saved = b
      },
      createChannelSession: async () => {
        throw new Error('不应新建')
      },
      pickDefaultAgent: async () => ({ toolId: 'claude', workspacePath: '/tmp', name: 'Claude' })
    }
    expect(await resolveBinding(deps, msg())).toBe(BINDING)
    expect(saved).toBeNull()
  })

  it('resolveBinding 无绑定时建会话 + 落绑定', async () => {
    let saved: ChannelBinding | null = null
    let created = false
    const deps: RouterDeps = {
      listBindings: () => [],
      saveBinding: (b) => {
        saved = b
      },
      createChannelSession: async () => {
        created = true
        return { id: 's-new' } as WorkbenchSession
      },
      pickDefaultAgent: async () => ({ toolId: 'claude', workspacePath: '/tmp', name: 'Claude' })
    }
    const result = await resolveBinding(deps, msg())
    expect(created).toBe(true)
    expect(result.conversationId).toBe('s-new')
    expect(result.toolId).toBe('claude')
    expect(result.chatId).toBe('oc_x')
    expect(saved).toEqual(result)
  })

  it('resolveBinding 无可对话 agent 时抛错', async () => {
    const deps: RouterDeps = {
      listBindings: () => [],
      saveBinding: () => {},
      createChannelSession: async () => ({ id: 'x' }) as WorkbenchSession,
      pickDefaultAgent: async () => null
    }
    await expect(resolveBinding(deps, msg())).rejects.toThrow(/未发现/)
  })
})
