import { describe, expect, it } from 'vitest'
import {
  deriveTranscriptTitle,
  deriveSessionDisplayTitle,
  isHumanTranscriptText,
  isProvisionalSessionName,
  isSystemGeneratedSessionName,
  shouldAutoRenameSessionName,
  sanitizeTranscriptTitle
} from '@shared/transcript/title'

describe('sanitizeTranscriptTitle', () => {
  it('strips <system-reminder> blocks with inner content', () => {
    const raw = '<system-reminder>\nThis is an automated reminder.\n</system-reminder>'
    expect(sanitizeTranscriptTitle(raw)).toBe('')
  })

  it('drops <command-name> slash-command wrappers', () => {
    expect(sanitizeTranscriptTitle('<command-name>/resume</command-name>')).toBe('')
    expect(
      sanitizeTranscriptTitle(
        '<command-message>resume</command-message><command-name>/resume</command-name><command-args></command-args>'
      )
    ).toBe('')
  })

  it('drops [unsupported: x] markers', () => {
    expect(sanitizeTranscriptTitle('[unsupported: file-history-snapshot]')).toBe('')
  })

  it('keeps human text but strips trailing reminder noise', () => {
    const raw = '帮我重构搜索索引\n<system-reminder>ignore me</system-reminder>'
    expect(sanitizeTranscriptTitle(raw)).toBe('帮我重构搜索索引')
  })

  it('strips stray xml-like tags but keeps inner words', () => {
    expect(sanitizeTranscriptTitle('fix <div> rendering bug')).toBe('fix rendering bug')
  })

  it('does not touch "a < b" arithmetic-like text (no closing tag)', () => {
    expect(sanitizeTranscriptTitle('check a < b < c condition')).toBe('check a < b < c condition')
  })

  it('preserves CJK content and truncates to maxLength', () => {
    expect(sanitizeTranscriptTitle('登录流程排查的问题', 4)).toBe('登录流程')
  })

  it('returns empty for nullish input', () => {
    expect(sanitizeTranscriptTitle(undefined)).toBe('')
    expect(sanitizeTranscriptTitle(null)).toBe('')
    expect(sanitizeTranscriptTitle('   ')).toBe('')
  })

  it('filters UUID-only filenames (BUG-031)', () => {
    expect(sanitizeTranscriptTitle('019ed143-8444-7a1f-a069-8a1e40a07bb3')).toBe('')
  })

  it('filters timestamp-UUID compound filenames (BUG-031)', () => {
    expect(sanitizeTranscriptTitle('2026-06-16T16-28-43-460Z_019ed143-8444-7a1f-a069-8a1e40a07bb3')).toBe('')
  })

  it('filters agent meta filenames (BUG-030)', () => {
    expect(sanitizeTranscriptTitle('agent-a0a4f2dcefc126c55.meta')).toBe('')
  })

  it('filters Caveat system text (BUG-033)', () => {
    expect(sanitizeTranscriptTitle('Caveat: The messages below were generated automatically')).toBe('')
  })

  it('strips codex <environment_context>/<user_instructions> injection blocks (SPEC-035)', () => {
    expect(sanitizeTranscriptTitle('<environment_context>cwd=/x os=mac</environment_context>')).toBe('')
    expect(sanitizeTranscriptTitle('<user_instructions>be terse</user_instructions>')).toBe('')
  })

  it('keeps normal human text that happens to look different from filenames', () => {
    expect(sanitizeTranscriptTitle('帮我对比 claude 和 gpt')).toBe('帮我对比 claude 和 gpt')
  })

  it('filters CLI default names and injected Agent OS context', () => {
    expect(sanitizeTranscriptTitle('New session - 2026-07-23T08:00:00Z')).toBe('')
    expect(sanitizeTranscriptTitle('# 用户画像 这是自动注入内容')).toBe('')
    expect(sanitizeTranscriptTitle('# Agent OS 长期记忆 自动注入')).toBe('')
  })

  it('从任务优先的 Agent OS 信封提取真实任务，不让记忆成为标题', () => {
    expect(
      sanitizeTranscriptTitle(
        '<agent-os-task version="1">\n修复会话标题污染\n</agent-os-task>\n\n<agent-os-context version="1">\n# 协作偏好\n\n用中文回答\n</agent-os-context>'
      )
    ).toBe('修复会话标题污染')
  })

  it('extracts the first non-greeting user intent from a serialized transcript', () => {
    expect(
      sanitizeTranscriptTitle('## user 你好 ## assistant 您好 ## user 分析当前会话标题为什么不一致 ## assistant 好')
    ).toBe('分析当前会话标题为什么不一致')
  })

  it('does not promote a standalone greeting to a session title', () => {
    expect(sanitizeTranscriptTitle('hi')).toBe('')
    expect(sanitizeTranscriptTitle('你好！')).toBe('')
    expect(sanitizeTranscriptTitle('你好，帮我检查会话标题')).toBe('帮我检查会话标题')
  })

  it('redacts credential values from titles', () => {
    expect(sanitizeTranscriptTitle('连接服务器，password=demo-secret 后检查日志')).toBe(
      '连接服务器，password=•••• 后检查日志'
    )
    expect(sanitizeTranscriptTitle('请求 Bearer demo.token-value')).toBe('请求 Bearer ••••')
  })
})

describe('isHumanTranscriptText', () => {
  it('classifies wrapper/system content as non-human', () => {
    expect(isHumanTranscriptText('<command-name>/resume</command-name>')).toBe(false)
    expect(isHumanTranscriptText('[unsupported: progress]')).toBe(false)
  })
  it('classifies real prompts as human', () => {
    expect(isHumanTranscriptText('帮我修一下登录')).toBe(true)
  })
})

describe('deriveTranscriptTitle', () => {
  it('prefers a clean preferred source', () => {
    expect(
      deriveTranscriptTitle({ preferred: '重构搜索索引', firstHumanText: '随便', fallback: 'file.jsonl' })
    ).toBe('重构搜索索引')
  })

  it('falls through to first human text when preferred is empty/noisy', () => {
    expect(
      deriveTranscriptTitle({
        preferred: '<system-reminder>x</system-reminder>',
        firstHumanText: '帮我排查登录问题',
        fallback: 'file.jsonl'
      })
    ).toBe('帮我排查登录问题')
  })

  it('falls back to filename when nothing human remains, never empty', () => {
    expect(
      deriveTranscriptTitle({
        preferred: '<command-name>/resume</command-name>',
        firstHumanText: '[unsupported: progress]',
        fallback: 'session-abc'
      })
    ).toBe('session-abc')
  })
})

describe('isProvisionalSessionName (SPEC-035)', () => {
  it('honors explicit nameProvisional flag over name heuristics', () => {
    expect(isProvisionalSessionName('重构搜索索引', { nameProvisional: true })).toBe(true)
    expect(isProvisionalSessionName('对比 · Pi', { nameProvisional: false })).toBe(false)
  })

  it('treats template/placeholder names as provisional via regex fallback', () => {
    expect(isProvisionalSessionName('未命名会话')).toBe(true)
    expect(isProvisionalSessionName('新会话')).toBe(true)
    expect(isProvisionalSessionName('对比 · Pi')).toBe(true)
    expect(isProvisionalSessionName('飞书 私聊')).toBe(true)
    expect(isProvisionalSessionName('飞书 群聊')).toBe(true)
    expect(isProvisionalSessionName('feishu · …de1458')).toBe(true)
    expect(isProvisionalSessionName('')).toBe(true)
  })

  it('treats workspace-derived names as provisional only with matching base', () => {
    expect(isProvisionalSessionName('agent-os 会话', { workspaceBase: 'agent-os' })).toBe(true)
    expect(isProvisionalSessionName('agent-os 终端', { workspaceBase: 'agent-os' })).toBe(true)
    expect(isProvisionalSessionName('agent-os 会话')).toBe(false)
  })

  it('treats real user intent titles as final', () => {
    expect(isProvisionalSessionName('帮我排查登录 401')).toBe(false)
    expect(isProvisionalSessionName('重构搜索索引性能')).toBe(false)
    expect(isProvisionalSessionName('say hello')).toBe(false)
  })
})

describe('session display title policy (SPEC-035 v2)', () => {
  it('separates persisted flag semantics from known system-name detection', () => {
    expect(isSystemGeneratedSessionName('agent-os 会话', { workspaceBase: 'agent-os' })).toBe(true)
    expect(
      shouldAutoRenameSessionName('agent-os 会话', {
        nameProvisional: false,
        workspaceBase: 'agent-os'
      })
    ).toBe(true)
    expect(shouldAutoRenameSessionName('重构搜索索引', { nameProvisional: true })).toBe(true)
    expect(shouldAutoRenameSessionName('重构搜索索引', { nameProvisional: false })).toBe(false)
  })

  it('uses a trusted title, then first user intent, then an explicit fallback', () => {
    expect(
      deriveSessionDisplayTitle({
        name: '会话 · SPEC-035 标题治理',
        workspaceBase: 'agent-os',
        firstUserText: '不应覆盖',
        fallback: '未命名会话'
      })
    ).toBe('SPEC-035 标题治理')
    expect(
      deriveSessionDisplayTitle({
        name: 'agent-os 会话',
        workspaceBase: 'agent-os',
        firstUserText: '统一会话和 CLI 标题',
        fallback: '未命名会话'
      })
    ).toBe('统一会话和 CLI 标题')
    expect(
      deriveSessionDisplayTitle({
        name: 'New session - 123',
        fallback: '未命名会话'
      })
    ).toBe('未命名会话')
  })
})
