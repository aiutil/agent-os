import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAdapter } from '../src/main/domains/adapters/registry'
import type {
  NormalizedMessage,
  TranscriptMessageStream
} from '../src/shared/types/transcript'

const fixture = (...parts: string[]): string =>
  resolve('tests', 'fixtures', 'transcripts', ...parts)

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function collect(stream: TranscriptMessageStream): Promise<{
  messages: NormalizedMessage[]
  summary: Awaited<TranscriptMessageStream['summary']>
}> {
  const messages: NormalizedMessage[] = []
  for await (const message of stream) messages.push(message)
  return { messages, summary: await stream.summary }
}

describe('Claude transcript storage', () => {
  it('流式解析消息、工具块、未知记录与坏行计数', async () => {
    const storage = getAdapter('claude')?.sessionStorage
    expect(storage?.support).toBe('full')
    expect(storage?.parseTranscript).toBeTypeOf('function')

    const parsed = await collect(
      storage!.parseTranscript!(fixture('claude', 'synthetic', 'session.jsonl'))
    )

    expect(parsed.messages.map(({ role, text, toolName, raw }) => ({
      role,
      text,
      toolName,
      kind: raw?.kind
    }))).toEqual([
      { role: 'user', text: 'Plan the release', toolName: undefined, kind: 'user' },
      {
        role: 'assistant',
        text: 'I will inspect the files.',
        toolName: undefined,
        kind: 'text'
      },
      {
        role: 'tool',
        text: '[tool: Read] {"file_path":"README.md"}',
        toolName: 'Read',
        kind: 'tool_use'
      },
      {
        role: 'tool',
        text: 'README contents',
        toolName: undefined,
        kind: 'tool_result'
      },
      {
        role: 'system',
        text: '[unsupported: mystery-event]',
        toolName: undefined,
        kind: 'mystery-event'
      }
    ])
    expect(parsed.messages.map((message) => message.seq)).toEqual([0, 1, 2, 3, 4])
    expect(parsed.summary).toEqual({ totalLines: 7, parseErrors: 1 })
  })

  it('按摘要、首条用户消息、文件名顺序读取元数据', async () => {
    const storage = getAdapter('claude')!.sessionStorage!
    const meta = await storage.readMeta!(
      fixture('claude', 'synthetic', 'session.jsonl')
    )

    expect(meta).toEqual({
      nativeSessionId: '11111111-1111-4111-8111-111111111111',
      cwd: '/workspace/demo',
      title: 'Release planning',
      startedAt: '2026-06-12T01:00:00.000Z'
    })
  })
})

describe('Codex transcript storage', () => {
  it('从 Codex UUIDv7 rollout 文件名提取原生会话 id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-codex-v7-'))
    tempDirs.push(dir)
    const nativeSessionId = '019ebb03-08b0-79b0-ad2c-a3e1dda5da4e'
    writeFileSync(
      join(dir, `rollout-2026-06-12T16-46-38-${nativeSessionId}.jsonl`),
      ''
    )

    expect(getAdapter('codex')!.sessionStorage!.listSessionFiles(dir)[0]?.nativeSessionId)
      .toBe(nativeSessionId)
  })

  it('解析消息与工具调用并忽略已知重复事件', async () => {
    const storage = getAdapter('codex')?.sessionStorage
    expect(storage?.support).toBe('full')

    const parsed = await collect(
      storage!.parseTranscript!(
        fixture(
          'codex',
          'synthetic',
          'rollout-2026-06-12T09-00-00-22222222-2222-4222-8222-222222222222.jsonl'
        )
      )
    )

    expect(parsed.messages.map(({ role, text, toolName, raw }) => ({
      role,
      text,
      toolName,
      kind: raw?.kind
    }))).toEqual([
      { role: 'user', text: 'Fix the parser', toolName: undefined, kind: 'message' },
      {
        role: 'assistant',
        text: 'I will add a test first.',
        toolName: undefined,
        kind: 'message'
      },
      {
        role: 'tool',
        text: '[tool: exec_command] {"cmd":"npm test"}',
        toolName: 'exec_command',
        kind: 'function_call'
      },
      {
        role: 'tool',
        text: 'tests passed',
        toolName: undefined,
        kind: 'function_call_output'
      },
      {
        role: 'system',
        text: '[unsupported: future_record]',
        toolName: undefined,
        kind: 'future_record'
      }
    ])
    expect(parsed.summary).toEqual({ totalLines: 8, parseErrors: 1 })
  })

  it('从 session_meta 与首条用户消息读取元数据', async () => {
    const storage = getAdapter('codex')!.sessionStorage!
    const meta = await storage.readMeta!(
      fixture(
        'codex',
        'synthetic',
        'rollout-2026-06-12T09-00-00-22222222-2222-4222-8222-222222222222.jsonl'
      )
    )

    expect(meta).toEqual({
      nativeSessionId: '22222222-2222-4222-8222-222222222222',
      cwd: '/workspace/demo',
      title: 'Fix the parser',
      startedAt: '2026-06-12T01:00:00.000Z'
    })
  })
})

describe('Pi transcript storage', () => {
  it('保留结构化思考与工具调用，供会话详情折叠展示', async () => {
    const storage = getAdapter('pi')?.sessionStorage
    expect(storage?.support).toBe('full')

    const dir = mkdtempSync(join(tmpdir(), 'agent-os-pi-structured-'))
    tempDirs.push(dir)
    const path = join(dir, 'session.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'session', id: 'pi-structured', workspace: '/workspace/pi' }),
        JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'text', text: '检查 UI' }] }),
        JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '先看消息结构' }] }),
        JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/App.tsx' } }] }),
        JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] }),
        JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'UI 已确认' }] })
      ].join('\n')
    )

    const parsed = await collect(storage!.parseTranscript!(path))

    expect(parsed.messages.map(({ role, text, toolName, raw }) => ({
      role,
      text,
      toolName,
      kind: raw?.kind
    }))).toEqual([
      { role: 'user', text: '检查 UI', toolName: undefined, kind: 'text' },
      { role: 'assistant', text: '先看消息结构', toolName: undefined, kind: 'thinking' },
      {
        role: 'tool',
        text: '[tool: Read] {"file_path":"src/App.tsx"}',
        toolName: 'Read',
        kind: 'tool_use'
      },
      { role: 'tool', text: 'ok', toolName: undefined, kind: 'tool_result' },
      { role: 'assistant', text: 'UI 已确认', toolName: undefined, kind: 'text' }
    ])
  })
})

describe('session storage capabilities', () => {
  it('Gemini 声明 full 并暴露解析能力', () => {
    const storage = getAdapter('gemini')?.sessionStorage
    expect(storage?.support).toBe('full')
    expect(storage?.parseTranscript).toBeDefined()
    expect(storage?.readMeta).toBeDefined()
  })

  it('目录不存在时返回空会话列表', () => {
    const missing = join(tmpdir(), `agent-os-missing-${Date.now()}`)
    expect(getAdapter('claude')!.sessionStorage!.listSessionFiles(missing)).toEqual([])
    expect(getAdapter('codex')!.sessionStorage!.listSessionFiles(missing)).toEqual([])
  })

  it('100MB 合成 JSONL 的流式消费堆内存增量低于 100MB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-os-transcript-'))
    tempDirs.push(dir)
    const path = join(dir, 'large.jsonl')
    const text = 'x'.repeat(900)
    const line = `${JSON.stringify({
      type: 'user',
      sessionId: '33333333-3333-4333-8333-333333333333',
      cwd: '/workspace/synthetic',
      timestamp: '2026-06-12T01:00:00.000Z',
      message: { role: 'user', content: text }
    })}\n`
    const count = Math.ceil((100 * 1024 * 1024) / Buffer.byteLength(line))
    const fd = openSync(path, 'w')
    const chunk = line.repeat(1000)
    let written = 0
    while (written < count) {
      const linesToWrite = Math.min(1000, count - written)
      writeSync(fd, linesToWrite === 1000 ? chunk : line.repeat(linesToWrite))
      written += linesToWrite
    }
    closeSync(fd)

    const startHeap = process.memoryUsage().heapUsed
    let peakHeap = startHeap
    let messageCount = 0
    const stream = getAdapter('claude')!.sessionStorage!.parseTranscript!(path)
    for await (const _message of stream) {
      messageCount += 1
      if (messageCount % 1000 === 0) {
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
      }
    }

    expect(messageCount).toBe(count)
    expect((await stream.summary).parseErrors).toBe(0)
    expect(peakHeap - startHeap).toBeLessThan(100 * 1024 * 1024)
  }, 30_000)
})
