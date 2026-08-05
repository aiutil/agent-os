import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeVault } from '../src/main/domains/knowledge/vault'
import { KnowledgeCurationService } from '../src/main/domains/knowledge/curation'
import type { MemoryCurationService } from '../src/main/domains/memory/curation'

const directories: string[] = []

function createVault(): KnowledgeVault {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-knowledge-'))
  directories.push(directory)
  return new KnowledgeVault(join(directory, 'knowledge'))
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('KnowledgeVault', () => {
  it('以原子 Markdown 正文为真源，发布、评论、收藏和图谱关系可重建', () => {
    const vault = createVault()
    const draft = vault.saveDraft({
      title: 'IoT 设备接入复盘',
      summary: '接入过程中的可复用结论。',
      body: '# 结论\n\n先校验协议版本，再验证设备心跳。',
      topic: 'IoT 开发/设备接入',
      tags: ['IoT', '协议'],
      sources: [{ sourceType: 'session', sourceId: 'codex:session-1', toolId: 'codex' }]
    })

    expect(draft.status).toBe('draft')
    expect(existsSync(draft.path)).toBe(true)
    expect(readFileSync(draft.path, 'utf8')).toContain('status: "draft"')
    expect(vault.list({ query: '协议' })).toMatchObject([{ id: draft.id }])

    const published = vault.publish(draft.id)
    expect(published).toMatchObject({ id: draft.id, status: 'published' })
    expect(published?.publishedAt).toBeTruthy()
    expect(vault.setFavorite(draft.id, true)?.favorite).toBe(true)

    const comment = vault.addComment(draft.id, { body: '下次补充网关诊断步骤。', anchor: { heading: '结论' } })
    expect(vault.updateComment(comment.id, { body: '补充网关诊断步骤。' })?.body).toBe('补充网关诊断步骤。')
    expect(vault.comments(draft.id)).toHaveLength(1)

    const graph = vault.graph({ includeSources: true })
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `article:${draft.id}`, type: 'article' }),
      expect.objectContaining({ id: 'topic:IoT 开发/设备接入', type: 'topic' }),
      expect.objectContaining({ id: 'source:session:codex:session-1', type: 'source-session' })
    ]))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'sourced_from', source: `article:${draft.id}` })
    ]))

    const archived = vault.archive(draft.id)
    const restored = vault.restore(draft.id)
    expect(archived?.status).toBe('archived')
    expect(restored).toMatchObject({ status: 'draft', publishedAt: published?.publishedAt })
    vault.close()
  })

  it('拒绝缺少来源的发布，但允许无来源草稿等待人工补全', () => {
    const vault = createVault()
    const draft = vault.saveDraft({ title: '待审阅', body: '正文', topic: '收集箱' })
    expect(() => vault.publish(draft.id)).toThrow('至少一个来源')
    expect(vault.get(draft.id)?.status).toBe('draft')
    vault.close()
  })

  it('从会话只生成可审核草稿，保留来源摘要并阻止同一摘要重复提炼', async () => {
    const vault = createVault()
    const customKnowledgePrompt = '使用中文写成体系化文章，并保留可复用的边界条件。'
    const runner = {
      getKnowledgeCurationPrompt: vi.fn(() => customKnowledgePrompt),
      runRestricted: vi.fn(async () => JSON.stringify({
        title: '部署经验', summary: '摘要', topic: '工程/发布', tags: ['部署'], body: '# 部署\n\n先验收。'
      }))
    } as unknown as MemoryCurationService
    const curation = new KnowledgeCurationService(vault, runner)
    const input = {
      source: { sourceType: 'session' as const, sourceId: 'codex:session-2' },
      cwd: process.cwd(),
      text: '完成部署前必须完整验收。'
    }
    const article = await curation.extractDraft(input)
    expect(article).toMatchObject({ status: 'draft', topic: '工程/发布', sources: [expect.objectContaining({ sourceId: 'codex:session-2' })] })
    expect(runner.runRestricted).toHaveBeenCalledWith(expect.any(String), process.cwd(), { hasExternalContext: undefined })
    const prompt = vi.mocked(runner.runRestricted).mock.calls[0]?.[0] ?? ''
    expect(prompt).toContain(customKnowledgePrompt)
    expect(prompt).toContain('完成部署前必须完整验收。')
    await expect(curation.extractDraft(input)).rejects.toThrow('已经生成过知识草稿')
    expect(runner.runRestricted).toHaveBeenCalledTimes(1)
    vault.close()
  })
})
