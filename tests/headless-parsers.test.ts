import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/shared/types/agent-event'
import type { HeadlessTurnParser } from '../src/main/domains/adapters/types'
import {
  buildCodexHeadlessTurn,
  createCodexParser
} from '../src/main/domains/adapters/codex/control'
import {
  buildOpenCodeHeadlessTurn,
  createOpenCodeParser
} from '../src/main/domains/adapters/opencode/control'
import {
  buildGeminiHeadlessTurn,
  createGeminiParser
} from '../src/main/domains/adapters/gemini/control'
import {
  buildHermesHeadlessTurn,
  createHermesParser
} from '../src/main/domains/adapters/hermes/control'
import {
  buildOpenClawHeadlessTurn,
  createOpenClawParser
} from '../src/main/domains/adapters/openclaw/control'
import {
  buildCursorAgentHeadlessTurn,
  createCursorAgentParser
} from '../src/main/domains/adapters/cursor-agent/control'
import { buildPiHeadlessTurn } from '../src/main/domains/adapters/pi/control'
import { listAdapters } from '../src/main/domains/adapters/registry'

function parseFixture(parser: HeadlessTurnParser, file: string): AgentEvent[] {
  return readFileSync(resolve(file), 'utf8')
    .trim()
    .split('\n')
    .flatMap((line) => parser.parse(line))
}

describe('Codex headless control channel (SPEC-019)', () => {
  it('builds exec --json with workspace-write sandbox and stdin prompt', () => {
    const launch = buildCodexHeadlessTurn({
      prompt: '列出文件',
      permissionPreset: 'safe',
      approvalUrl: 'http://127.0.0.1/permission',
      approvalToken: 't',
      turnId: 'turn-1'
    })
    expect(launch.command).toBe('codex')
    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true'
    ])
    expect(launch.stdin).toBe('列出文件')
  })

  it('maps the auto preset to danger-full-access', () => {
    const launch = buildCodexHeadlessTurn({
      prompt: 'go',
      permissionPreset: 'auto',
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.args).toContain('danger-full-access')
  })

  it('composes prior transcript into the stdin prompt', () => {
    const launch = buildCodexHeadlessTurn({
      prompt: '继续',
      transcript: [
        { role: 'user', text: '第一问' },
        { role: 'assistant', text: '第一答' }
      ],
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.stdin).toBe('## user\n\n第一问\n\n## assistant\n\n第一答\n\n## user\n\n继续')
  })

  it('parses a turn into structured events without dropping unknowns', () => {
    const events = parseFixture(createCodexParser(), 'tests/fixtures/control/codex/turn.synthetic.jsonl')
    expect(events).toEqual([
      { kind: 'session-bound', nativeSessionId: 'th_abc' },
      { kind: 'text-delta', text: '正在检查目录' },
      { kind: 'tool-start', toolUseId: 'cmd_1', toolName: 'Bash', input: { command: 'ls -la' } },
      { kind: 'tool-result', toolUseId: 'cmd_1', content: 'file.txt', isError: false },
      { kind: 'turn-end', status: 'completed' },
      { kind: 'unknown', rawType: 'future_codex_event', payload: { type: 'future_codex_event', data: 1 } }
    ])
  })

  it('deduplicates repeated error frames', () => {
    const parser = createCodexParser()
    const a = parser.parse('{"type":"error","message":"boom"}')
    const b = parser.parse('{"type":"turn.failed","error":"boom again"}')
    expect(a).toEqual([{ kind: 'error', message: 'boom' }])
    expect(b).toEqual([])
  })

  it('turns malformed lines into an observable unknown event', () => {
    expect(createCodexParser().parse('{bad')).toEqual([
      { kind: 'unknown', rawType: 'invalid-json', payload: '{bad' }
    ])
  })
})

describe('OpenCode headless control channel (SPEC-019)', () => {
  it('builds run --format json with positional prompt', () => {
    const launch = buildOpenCodeHeadlessTurn({
      prompt: '改一下',
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.command).toBe('opencode')
    expect(launch.args).toEqual(['run', '--format', 'json', '改一下'])
    expect(launch.stdin).toBeUndefined()
  })

  it('resumes native sessions with --session', () => {
    const launch = buildOpenCodeHeadlessTurn({
      prompt: '继续',
      nativeSessionId: 'ses_1',
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.args).toEqual(['run', '--format', 'json', '--session', 'ses_1', '继续'])
  })

  it('parses text, tool use/result and error frames', () => {
    const events = parseFixture(
      createOpenCodeParser(),
      'tests/fixtures/control/opencode/turn.synthetic.jsonl'
    )
    expect(events).toEqual([
      { kind: 'session-bound', nativeSessionId: 'ses_1' },
      { kind: 'text-delta', text: '读取文件' },
      { kind: 'tool-start', toolUseId: 'call_1', toolName: 'read', input: { path: 'a.txt' } },
      { kind: 'tool-result', toolUseId: 'call_1', content: 'hello', isError: false },
      { kind: 'error', message: 'boom' }
    ])
  })
})

describe('Gemini headless control channel', () => {
  it('builds stream-json prompt mode with approval mapping and resume', () => {
    const launch = buildGeminiHeadlessTurn({
      prompt: '继续',
      nativeSessionId: 'gemini-session-1',
      model: 'pro',
      permissionPreset: 'acceptEdits',
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.command).toBe('gemini')
    expect(launch.args).toEqual([
      '--output-format',
      'stream-json',
      '--prompt',
      '继续',
      '--skip-trust',
      '--model',
      'pro',
      '--resume',
      'gemini-session-1',
      '--approval-mode',
      'auto_edit'
    ])
    expect(launch.stdin).toBeUndefined()
  })

  it('parses stream-json session, text, tool and result frames', () => {
    const events = parseFixture(
      createGeminiParser(),
      'tests/fixtures/control/gemini/turn.synthetic.jsonl'
    )
    expect(events).toEqual([
      { kind: 'session-bound', nativeSessionId: 'gemini_1', model: 'gemini-2.5-pro' },
      { kind: 'text-delta', text: '读取文件' },
      { kind: 'tool-start', toolUseId: 'tool_1', toolName: 'read_file', input: { path: 'a.txt' } },
      { kind: 'tool-result', toolUseId: 'tool_1', content: 'hello', isError: false },
      { kind: 'turn-end', status: 'completed' }
    ])
  })
})

describe('Hermes headless control channel', () => {
  it('builds quiet single-query chat with native resume', () => {
    const launch = buildHermesHeadlessTurn({
      prompt: '部署',
      nativeSessionId: 'hermes-session-1',
      permissionPreset: 'auto',
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.command).toBe('hermes')
    expect(launch.args).toEqual([
      'chat',
      '--query',
      '部署',
      '--quiet',
      '--source',
      'agent-os',
      '--resume',
      'hermes-session-1',
      '--yolo'
    ])
  })

  it('parses session info and text output', () => {
    const parser = createHermesParser()
    expect(parser.parse('Session ID: hermes_1')).toEqual([
      { kind: 'session-bound', nativeSessionId: 'hermes_1' }
    ])
    expect(parser.parse('完成了')).toEqual([{ kind: 'text-delta', text: '完成了\n' }])
  })

  it('disables the streaming-only startup watchdog (non-interactive batch)', () => {
    // hermes --query 非交互 + spawn 后 stdin EOF ⇒ 进程必然自行退出，「完成」由
    // exit 驱动而非 stdout 事件。默认 90s「无事件即卡死」看门狗对它不成立，禁用
    // （null），信任进程生命周期；真挂死交用户 interrupt，不用拍脑袋的超时阈值。
    const hermes = listAdapters().find((a) => a.id === 'hermes')!
    expect(hermes.headlessJson?.startupTimeoutMs).toBeNull()
  })
})

describe('OpenClaw headless control channel', () => {
  it('builds prompt mode and keeps the adapter discoverable only when installed', () => {
    const launch = buildOpenClawHeadlessTurn({
      prompt: '检查',
      model: 'default',
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.command).toBe('openclaw')
    expect(launch.args).toEqual(['chat', '--prompt', '检查'])
  })

  it('uses the shared plain text parser', () => {
    expect(createOpenClawParser().parse('ok')).toEqual([{ kind: 'text-delta', text: 'ok\n' }])
  })
})

describe('Pi headless control channel', () => {
  it('uses an isolated, no-tool invocation for memory curation', () => {
    const launch = buildPiHeadlessTurn({
      prompt: '只返回 JSON',
      model: 'minimax-cn/MiniMax-M2.7',
      isolated: true,
      approvalUrl: '',
      approvalToken: '',
      turnId: 'curation-1'
    })
    expect(launch.command).toBe('pi')
    expect(launch.args).toEqual([
      '--mode',
      'json',
      '--print',
      '--no-tools',
      '--no-session',
      '--no-context-files',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--model',
      'minimax-cn/MiniMax-M2.7',
      '只返回 JSON'
    ])
  })
})

describe('Cursor Agent headless control channel (SPEC-019)', () => {
  it('builds --print stream-json with force/trust and stdin prompt', () => {
    const launch = buildCursorAgentHeadlessTurn({
      prompt: '你好',
      approvalUrl: '',
      approvalToken: '',
      turnId: 't'
    })
    expect(launch.command).toBe('cursor-agent')
    expect(launch.args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--force',
      '--trust'
    ])
    expect(launch.stdin).toBe('你好')
  })

  it('streams incremental deltas and reconciles the terminal replay without duplication', () => {
    const events = parseFixture(
      createCursorAgentParser(),
      'tests/fixtures/control/cursor-agent/turn.synthetic.jsonl'
    )
    expect(events).toEqual([
      { kind: 'session-bound', nativeSessionId: 'cur_1', model: 'sonnet-4' },
      { kind: 'text-delta', text: '你好' },
      { kind: 'text-delta', text: '，世界' },
      { kind: 'turn-end', status: 'completed' }
    ])
  })
})

describe('memory curator candidates (SPEC-028)', () => {
  it('只有声明 supportsIsolatedCuration 的适配器可作为提炼 Agent', () => {
    const candidates = listAdapters().filter((a) => a.headlessJson?.supportsIsolatedCuration)
    const ids = candidates.map((a) => a.id)
    expect(ids).toContain('pi')
    // 常见 CLI 默认不允许隔离提炼，避免误把会话上下文交给 curator
    expect(ids).not.toContain('claude')
    expect(ids).not.toContain('codex')
    expect(ids).not.toContain('shell')
  })
})
