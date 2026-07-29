// SPEC-003 适配器协议单测。验证注册表与版本解析。

import { describe, it, expect } from 'vitest'
import { getAdapter, listAdapters } from '../src/main/domains/adapters/registry'
import { parseSemver } from '../src/main/domains/adapters/types'

describe('parseSemver', () => {
  it('解析常见版本输出', () => {
    expect(parseSemver('1.2.3')).toBe('1.2.3')
    expect(parseSemver('claude 2.1.156 (build)')).toBe('2.1.156')
    expect(parseSemver('v0.9.2-beta.1')).toBe('0.9.2-beta.1')
    expect(parseSemver('no version here')).toBeUndefined()
  })
})

describe('adapter registry', () => {
  it('内置首批适配器存在', () => {
    const ids = listAdapters().map((a) => a.id)
    expect(ids).toEqual(
      expect.arrayContaining(['claude', 'codex', 'gemini', 'hermes', 'openclaw', 'opencode', 'shell'])
    )
  })

  it('getAdapter 命中与未命中', () => {
    expect(getAdapter('claude')?.displayName).toBe('Claude Code')
    expect(getAdapter('ghost')).toBeUndefined()
  })

  it('uses canonical product names across CLI adapters', () => {
    expect(
      Object.fromEntries(listAdapters().map((item) => [item.id, item.displayName]))
    ).toMatchObject({
      claude: 'Claude Code',
      gemini: 'Gemini CLI',
      hermes: 'Hermes Agent',
      'cursor-agent': 'Cursor Agent'
    })
  })

  it('每个适配器都有可执行名与安装提示（shell 除外）', () => {
    for (const adapter of listAdapters()) {
      expect(adapter.executable).toBeTruthy()
      if (adapter.id !== 'shell') expect(adapter.installHint).toBeTruthy()
    }
  })

  it('按实测 CLI 契约构造注入与恢复命令', () => {
    const claude = getAdapter('claude')
    const codex = getAdapter('codex')
    const opencode = getAdapter('opencode')
    const gemini = getAdapter('gemini')
    const hermes = getAdapter('hermes')

    expect(claude?.supportsSessionIdInjection).toBe(true)
    expect(
      claude?.buildLaunchCommand({
        cwd: '/tmp/project',
        nativeSessionId: '11111111-1111-4111-8111-111111111111'
      })
    ).toBe("claude --session-id '11111111-1111-4111-8111-111111111111'")
    expect(claude?.buildResumeCommand?.('native id', '/tmp/project')).toBe(
      "claude --resume 'native id'"
    )
    expect(codex?.buildResumeCommand?.('native id', '/tmp/project')).toBe(
      "codex resume 'native id'"
    )
    expect(opencode?.buildResumeCommand?.('native id', '/tmp/project')).toBe(
      "opencode --session 'native id'"
    )
    expect(gemini?.buildLaunchCommand({ cwd: '/tmp/project' })).toBe('gemini --skip-trust')
    expect(gemini?.buildLaunchCommand({ cwd: '/tmp/project', model: 'pro' })).toBe(
      "gemini --skip-trust --model 'pro'"
    )
    expect(gemini?.buildResumeCommand?.('native id', '/tmp/project')).toBe(
      "gemini --skip-trust --resume 'native id'"
    )
    expect(hermes?.buildResumeCommand?.('native id', '/tmp/project')).toBe(
      "hermes chat --resume 'native id'"
    )
  })

  it('会话模式支持的 CLI 均声明结构化聊天控制面', () => {
    for (const id of ['claude', 'codex', 'gemini', 'openclaw', 'opencode', 'hermes']) {
      expect(getAdapter(id)?.headlessJson, id).toBeTruthy()
    }
  })

  it('SPEC-041 附件能力按图片/文件分别声明', () => {
    expect(getAdapter('codex')?.headlessJson?.attachments).toMatchObject({
      images: true,
      files: false
    })
    expect(getAdapter('pi')?.headlessJson?.attachments).toMatchObject({
      images: true,
      files: true
    })
    expect(getAdapter('hermes')?.headlessJson?.attachments).toMatchObject({
      images: true,
      files: false,
      maxFiles: 1
    })
    expect(getAdapter('cursor-agent')?.headlessJson?.attachments).toEqual({
      images: false,
      files: false
    })
  })
})
