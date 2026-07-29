import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAdapter } from '../src/main/domains/adapters/registry'
import { MemoryIndex } from '../src/main/domains/memory/index'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-memory-'))
  tempDirs.push(dir)
  return dir
}

function fixture(...parts: string[]): string {
  return resolve('tests', 'fixtures', 'transcripts', ...parts)
}

async function seededIndex(): Promise<MemoryIndex> {
  const dir = tempDir()
  const index = new MemoryIndex(join(dir, 'search-index.sqlite'))
  const claudePath = join(dir, 'claude.jsonl')
  const codexPath = join(dir, 'codex.jsonl')
  copyFileSync(fixture('claude', '2.1.170', 'session.jsonl'), claudePath)
  copyFileSync(fixture('codex', '0.137.0', 'session.jsonl'), codexPath)
  appendFileSync(
    claudePath,
    `${JSON.stringify({
      type: 'user',
      sessionId: '00000000-0000-4000-8000-000000000004',
      cwd: '/workspace/claude-170',
      timestamp: '2026-06-12T03:00:00.000Z',
      message: { role: 'user', content: '请实现会话恢复 resume memory 搜索' }
    })}\n`
  )
  appendFileSync(
    codexPath,
    `${JSON.stringify({
      timestamp: '2026-06-12T04:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Codex 恢复与 search index' }]
      }
    })}\n`
  )
  await index.indexFile(
    getAdapter('claude')!,
    claudePath
  )
  await index.indexFile(
    getAdapter('codex')!,
    codexPath
  )
  return index
}

describe('MemoryIndex', () => {
  it('索引脱敏 fixture，并支持中文、英文和混合关键词高亮', async () => {
    const index = await seededIndex()

    const chinese = index.search({ query: '会话恢复', limit: 20 })
    const english = index.search({ query: 'resume', limit: 20 })
    const mixed = index.search({ query: 'Codex 恢复', limit: 20 })

    expect(chinese.length).toBeGreaterThan(0)
    expect(english.length).toBeGreaterThan(0)
    expect(mixed.length).toBeGreaterThan(0)
    expect(chinese[0]?.snippetHtml).toContain('<mark>')
    expect(chinese[0]?.snippetHtml).not.toContain('<script')
    index.close()
  })

  it('FTS trigram 大小写不敏感：小写 query 命中大写正文', async () => {
    const dir = tempDir()
    const index = new MemoryIndex(join(dir, 'search-index.sqlite'))
    const claudePath = join(dir, 'claude.jsonl')
    copyFileSync(fixture('claude', '2.1.170', 'session.jsonl'), claudePath)
    appendFileSync(
      claudePath,
      `${JSON.stringify({
        type: 'user',
        sessionId: '00000000-0000-4000-8000-00000000ca5e',
        cwd: '/workspace/cmp',
        timestamp: '2026-06-12T05:00:00.000Z',
        message: { role: 'user', content: '部署 CMP 项目模块' }
      })}\n`
    )
    await index.indexFile(getAdapter('claude')!, claudePath)
    expect(index.search({ query: 'cmp', limit: 20 }).length).toBeGreaterThan(0)
    index.close()
  })

  it('会话内搜索覆盖整段会话，按 seq 升序返回命中消息（短 CJK 也可命中）', async () => {
    const index = await seededIndex()
    const sessionId = index.search({ query: '会话恢复', limit: 5 })[0]!.sessionId

    const inSession = index.searchInSession({ sessionId, query: '恢复' })
    expect(inSession.length).toBeGreaterThan(0)
    expect(inSession.every((m) => m.text.includes('恢复'))).toBe(true)
    const seqs = inSession.map((m) => m.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)

    expect(index.searchInSession({ sessionId, query: '' })).toEqual([])
    expect(index.searchInSession({ sessionId, query: '这里不存在的关键词xyz' })).toEqual([])
    index.close()
  })

  it('按来源、项目和时间范围过滤，空查询按最近活跃倒序', async () => {
    const index = await seededIndex()
    const feed = index.search({ query: '', limit: 20 })
    const claude = index.search({ query: '', toolIds: ['claude'], limit: 20 })
    const missingProject = index.search({
      query: '',
      workspacePath: '/workspace/missing',
      limit: 20
    })
    const future = index.search({
      query: '',
      dateRange: { from: '2030-01-01T00:00:00.000Z' },
      limit: 20
    })

    expect(feed.length).toBe(2)
    expect(feed[0]!.lastActivityAt >= feed[1]!.lastActivityAt).toBe(true)
    expect(claude).toHaveLength(1)
    expect(claude[0]?.toolId).toBe('claude')
    expect(missingProject).toEqual([])
    expect(future).toEqual([])
    index.close()
  })

  it('追加只消费新完整行，截断后自动整文件重建', async () => {
    const dir = tempDir()
    const source = join(dir, 'session.jsonl')
    copyFileSync(fixture('claude', '2.1.170', 'session.jsonl'), source)
    const index = new MemoryIndex(join(dir, 'search-index.sqlite'))
    const adapter = getAdapter('claude')!

    await index.indexFile(adapter, source)
    const first = index.getIndexedFile(source)
    const appended = JSON.stringify({
      type: 'user',
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cwd: '/workspace/claude-170',
      timestamp: '2026-06-12T03:00:00.000Z',
      message: { role: 'user', content: '增量索引独有词 incremental-tail' }
    })
    appendFileSync(source, appended)
    await index.indexFile(adapter, source)
    expect(index.search({ query: 'incremental-tail', limit: 10 })).toEqual([])
    expect(index.getIndexedFile(source)?.byteOffset).toBe(first?.byteOffset)

    appendFileSync(source, '\n')
    await index.indexFile(adapter, source)
    expect(index.search({ query: 'incremental-tail', limit: 10 })).toHaveLength(1)
    expect(index.getIndexedFile(source)!.byteOffset).toBeGreaterThan(first!.byteOffset)

    truncateSync(source, 0)
    writeFileSync(source, `${appended.replace('incremental-tail', 'rebuilt-tail')}\n`)
    await index.indexFile(adapter, source)
    expect(index.search({ query: 'incremental-tail', limit: 10 })).toEqual([])
    expect(index.search({ query: 'rebuilt-tail', limit: 10 })).toHaveLength(1)
    index.close()
  })

  it('返回完整规范化时间线', async () => {
    const index = await seededIndex()
    const hit = index.search({ query: 'resume', limit: 10 })[0]!
    const transcript = index.getTranscript(hit.sessionId)

    expect(transcript?.nativeSessionId).toBeTruthy()
    expect(transcript?.messages.length).toBeGreaterThan(0)
    expect(transcript?.messages.map((message) => message.seq)).toEqual(
      transcript?.messages.map((_, index) => index)
    )
    index.close()
  })

  it('热索引只写入长 tool 输出前缀，deep 搜索仍可查完整消息', () => {
    const dir = tempDir()
    const index = new MemoryIndex(join(dir, 'search-index.sqlite'))
    const longToolOutput = `visible-prefix ${'x'.repeat(4096)} hidden-tail-needle`
    index.upsertTranscript('test', 'test://session/long-tool', {
      nativeSessionId: 'long-tool',
      toolId: 'test',
      cwd: '/tmp/project',
      title: 'Long tool session',
      startedAt: '2026-06-18T00:00:00.000Z',
      lastActivityAt: '2026-06-18T00:01:00.000Z',
      messages: [
        {
          seq: 0,
          role: 'user',
          text: 'searchable user prompt',
          ts: '2026-06-18T00:00:00.000Z'
        },
        {
          seq: 1,
          role: 'tool',
          toolName: 'read',
          text: longToolOutput,
          ts: '2026-06-18T00:00:01.000Z',
          raw: { kind: 'tool_result' }
        }
      ],
      parseErrors: 0
    })

    expect(index.search({ query: 'searchable', limit: 10 })).toHaveLength(1)
    expect(index.search({ query: 'visible-prefix', limit: 10 })).toHaveLength(1)
    expect(index.search({ query: 'hidden-tail-needle', limit: 10 })).toEqual([])
    expect(index.search({ query: 'hidden-tail-needle', limit: 10, deep: true })).toHaveLength(1)
    index.close()
  })

  it('分页读取历史记录，默认返回最近一页并支持向前取页', () => {
    const dir = tempDir()
    const index = new MemoryIndex(join(dir, 'search-index.sqlite'))
    index.upsertTranscript('test', 'test://session/paged', {
      nativeSessionId: 'paged',
      toolId: 'test',
      cwd: '/tmp/project',
      title: 'Paged session',
      startedAt: '2026-06-18T00:00:00.000Z',
      lastActivityAt: '2026-06-18T00:05:00.000Z',
      messages: Array.from({ length: 300 }, (_, seq) => ({
        seq,
        role: seq % 2 === 0 ? 'user' as const : 'assistant' as const,
        text: `message-${seq}`,
        ts: `2026-06-18T00:${String(seq % 60).padStart(2, '0')}:00.000Z`
      })),
      parseErrors: 0
    })

    const latest = index.getTranscriptPage({
      sessionId: 'test:paged',
      direction: 'latest',
      limit: 50
    })
    expect(latest?.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => 250 + i)
    )
    expect(latest?.hasMoreBefore).toBe(true)
    expect(latest?.hasMoreAfter).toBe(false)

    const previous = index.getTranscriptPage({
      sessionId: 'test:paged',
      direction: 'before',
      cursor: 250,
      limit: 50
    })
    expect(previous?.messages.map((message) => message.seq)).toEqual(
      Array.from({ length: 50 }, (_, i) => 200 + i)
    )
    expect(previous?.hasMoreBefore).toBe(true)
    expect(previous?.hasMoreAfter).toBe(true)
    index.close()
  })

  it('数据库损坏时备份旧文件并自动重建', async () => {
    const dir = tempDir()
    const dbPath = join(dir, 'search-index.sqlite')
    mkdirSync(dirname(dbPath), { recursive: true })
    writeFileSync(dbPath, 'not-a-sqlite-database')

    const index = new MemoryIndex(dbPath)
    await index.indexFile(
      getAdapter('claude')!,
      fixture('claude', '2.1.170', 'session.jsonl')
    )

    expect(index.search({ query: '', limit: 10 })).toHaveLength(1)
    expect(readFileSync(dbPath).subarray(0, 6).toString()).toBe('SQLite')
    index.close()
  })

  it('源文件删除后移除对应会话与文件进度', async () => {
    const dir = tempDir()
    const source = join(dir, 'session.jsonl')
    copyFileSync(fixture('claude', '2.1.170', 'session.jsonl'), source)
    const index = new MemoryIndex(join(dir, 'search-index.sqlite'))
    await index.indexFile(getAdapter('claude')!, source)

    index.removeFile(source)

    expect(index.search({ query: '', limit: 10 })).toEqual([])
    expect(index.getIndexedFile(source)).toBeNull()
    index.close()
  })
})
