import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setCurrentLang } from '../src/shared/i18n'
import { MemoryVault } from '../src/main/domains/memory/vault'
import { MemoryCurationService } from '../src/main/domains/memory/curation'
import {
  DEFAULT_KNOWLEDGE_CURATION_PROMPT,
  DEFAULT_MEMORY_CURATION_PROMPT,
  DEFAULT_MEMORY_CURATION_PROMPTS,
  DEFAULT_KNOWLEDGE_CURATION_PROMPTS
} from '../src/shared/curation-prompts'

const directories: string[] = []

function createVault(): MemoryVault {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-vault-'))
  directories.push(directory)
  return new MemoryVault(join(directory, 'memories', 'vault.sqlite'))
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  setCurrentLang('zh')
})

describe('MemoryVault', () => {
  it('默认填充两类提炼提示词，用户修改只更新后续提炼设置', () => {
    setCurrentLang('zh')
    const vault = createVault()
    expect(vault.getSettings()).toMatchObject({
      memoryCurationPrompt: DEFAULT_MEMORY_CURATION_PROMPT,
      knowledgeCurationPrompt: DEFAULT_KNOWLEDGE_CURATION_PROMPT
    })
    expect(vault.updateSettings({ knowledgeCurationPrompt: '后续知识统一使用中文。' }).knowledgeCurationPrompt)
      .toBe('后续知识统一使用中文。')
    expect(vault.getSettings().knowledgeCurationPromptMode).toBe('custom')
    setCurrentLang('en')
    expect(vault.getSettings().memoryCurationPrompt).toBe(DEFAULT_MEMORY_CURATION_PROMPTS.en)
    expect(vault.getSettings().knowledgeCurationPrompt).toBe('后续知识统一使用中文。')
    vault.updateSettings({
      knowledgeCurationPromptMode: 'default',
      knowledgeCurationPrompt: DEFAULT_KNOWLEDGE_CURATION_PROMPTS.en
    })
    setCurrentLang('zh')
    expect(vault.getSettings().knowledgeCurationPrompt).toBe(DEFAULT_KNOWLEDGE_CURATION_PROMPTS.zh)
    vault.close()
  })

  it('候选记忆确认前不能进入 Context Pack，确认后按任务召回且不暴露证据元数据', () => {
    const vault = createVault()
    vault.updateSettings({ enabled: true })
    const candidate = vault.propose({
      kind: 'decision',
      title: '发布策略',
      content: '发布前必须跑完整 typecheck。',
      scope: 'repo',
      scopeRef: '/workspace/app',
      evidence: [{ sourceType: 'session', sourceId: 'codex:run-1' }]
    })

    expect(vault.context({ cwd: '/workspace/app/src', task: '准备发布' }).items).toEqual([])
    const active = vault.confirm(candidate.id)
    expect(active?.status).toBe('active')

    const context = vault.context({ cwd: '/workspace/app/src', task: '准备发布' })
    expect(context.items).toHaveLength(1)
    expect(context.text).toContain('发布前必须跑完整 typecheck')
    expect(context.text).not.toContain('session:codex:run-1')
    expect(context.referencedMemories).toContainEqual(expect.objectContaining({ id: active?.id }))
    vault.close()
  })

  it('保持项目作用域隔离、删除立即失效，并拒绝疑似 secret', () => {
    const vault = createVault()
    vault.updateSettings({ enabled: true })
    const candidate = vault.propose({
      kind: 'pitfall',
      title: '仓库 A 注意事项',
      content: '数据库迁移需要先备份。',
      scope: 'repo',
      scopeRef: '/workspace/a'
    })
    vault.confirm(candidate.id)
    expect(vault.context({ cwd: '/workspace/b', task: '迁移' }).items).toEqual([])
    expect(vault.context({ cwd: '/workspace/a', task: '迁移' }).items).toHaveLength(1)
    vault.forget(candidate.id)
    expect(vault.context({ cwd: '/workspace/a', task: '迁移' }).items).toEqual([])
    expect(() => vault.propose({
      kind: 'fact',
      title: 'credential',
      content: 'OPENAI_API_KEY=sk_abcdefghijklmnopqrstuvwxyz',
      scope: 'user'
    })).toThrow('疑似密钥')
    vault.close()
  })

  it('迁移经验库一次且保留来源与标签', () => {
    const vault = createVault()
    const imported = vault.migrateExperiences([{
      id: 'legacy-1',
      title: '旧经验',
      contentMd: '保持迁移兼容。',
      sourceSessionId: 'claude:legacy-session',
      tags: ['迁移'],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z'
    }])
    expect(imported).toBe(1)
    expect(vault.migrateExperiences([])).toBe(0)
    expect(vault.list({ statuses: ['active'] })).toMatchObject([{
      id: 'legacy-1',
      kind: 'knowledge',
      tags: ['迁移'],
      evidence: [{ sourceType: 'session', sourceId: 'claude:legacy-session' }]
    }])
    vault.close()
  })

  it('策略在同一 Vault 中持久化并限制 Context Pack 预算', () => {
    const vault = createVault()
    expect(vault.getSettings().enabled).toBe(true)
    vault.updateSettings({
      enabled: true,
      contextTokenBudget: 250,
      curatorAgentId: 'pi',
      curatorModel: 'minimax-cn/MiniMax-M2.7'
    })
    expect(vault.getSettings()).toMatchObject({
      curatorAgentId: 'pi',
      curatorModel: 'minimax-cn/MiniMax-M2.7'
    })
    vault.migrateExperiences(Array.from({ length: 5 }, (_, index) => ({
      id: `legacy-budget-${index}`,
      title: `条目 ${index}`,
      contentMd: '可重复的长期上下文。'.repeat(30),
      tags: [],
      createdAt: `2026-06-0${index + 1}T00:00:00.000Z`,
      updatedAt: `2026-06-0${index + 1}T00:00:00.000Z`
    })))
    const context = vault.context({ cwd: '/workspace/app', task: '上下文', tokenBudget: 250 })
    expect(context.estimatedTokens).toBeLessThanOrEqual(250)
    expect(context.truncated).toBe(true)
    vault.close()
  })

  it('工作记忆属于会话、七天后自动失效，且不替代长期候选审批', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-working-memory-'))
    directories.push(directory)
    let current = new Date(2026, 6, 19, 10, 0)
    const vault = new MemoryVault(join(directory, 'vault.sqlite'), () => new Date(current.getTime()))
    vault.updateWorking({
      sessionId: 's-1',
      goal: '完成知识图谱',
      constraints: ['不覆盖现有 V3 改动'],
      decisions: ['默认图谱视图']
    })
    expect(vault.getWorking('s-1')).toMatchObject({ goal: '完成知识图谱', decisions: ['默认图谱视图'] })
    expect(vault.context({ cwd: '/workspace', task: '继续实现', sessionId: 's-1' }).text).toContain('完成知识图谱')
    current = new Date(2026, 6, 27, 10, 0)
    expect(vault.getWorking('s-1')).toBeNull()
    expect(vault.list({ statuses: ['active'] })).toEqual([])
    vault.close()
  })

  it('提炼服务在开关、外部上下文和 curator 配置前安全拒绝', async () => {
    const vault = createVault()
    const service = new MemoryCurationService(vault, () => undefined)
    const input = { sourceId: 'codex:source', cwd: '/workspace/app', text: '稳定的结论。' }
    vault.updateSettings({ enabled: false })
    await expect(service.curate(input)).rejects.toThrow('未启用')
    vault.updateSettings({ enabled: true, generateMemories: true })
    await expect(service.curate({ ...input, hasExternalContext: true })).rejects.toThrow('外部上下文')
    await expect(service.curate(input)).rejects.toThrow('未发现可用于提炼')
    vault.updateSettings({ knowledgeCurationEnabled: false })
    await expect(service.runRestricted('知识草稿', '/workspace/app')).rejects.toThrow('设置中关闭')
    vault.updateSettings({ knowledgeCurationEnabled: true })
    await expect(service.runRestricted('知识草稿', '/workspace/app', { hasExternalContext: true })).rejects.toThrow('外部上下文')
    vault.close()
  })

  it('用户可编辑候选，并在确认时保留编辑结果与原始证据', () => {
    const vault = createVault()
    const candidate = vault.propose({
      kind: 'preference',
      title: '模型候选角色',
      content: '用户可能是一名架构师。',
      scope: 'user',
      evidence: [{ sourceType: 'session', sourceId: 'pi:turn-1' }]
    })
    const active = vault.confirm(candidate.id, {
      title: '用户角色',
      content: '用户是一名架构师。',
      tags: ['个人偏好', '角色']
    })
    expect(active).toMatchObject({
      status: 'active',
      title: '用户角色',
      content: '用户是一名架构师。',
      tags: ['个人偏好', '角色'],
      evidence: [{ sourceType: 'session', sourceId: 'pi:turn-1' }]
    })
    expect(active?.expiresAt).toBeUndefined()
    vault.close()
  })

  it('addActive 直接落 active，同指纹更新不重复占用预算，persona 作为 preamble 注入', () => {
    const vault = createVault()
    vault.updateSettings({ enabled: true })

    // 直接 active：无需确认即可被 context 召回。
    const first = vault.addActive({
      kind: 'preference',
      title: '回复语言',
      content: '用中文回复。',
      scope: 'user',
      tags: ['沟通'],
      evidence: [{ sourceType: 'session', sourceId: 'codex:s1' }]
    })
    expect(first.status).toBe('active')
    expect(first.confidence).toBe('confirmed')
    expect(first.expiresAt).toBeUndefined()
    expect(vault.context({ cwd: '/anywhere', task: '' }).text).toContain('用中文回复')

    // 去重：同 title+scope+scopeRef 不新增，合并 tags、刷新 content。
    const again = vault.addActive({
      kind: 'preference',
      title: '回复语言',
      content: '用中文回复，代码保留原文。',
      scope: 'user',
      tags: ['风格'],
      evidence: [{ sourceType: 'session', sourceId: 'codex:s2' }]
    })
    expect(again.id).toBe(first.id)
    expect(again.content).toBe('用中文回复，代码保留原文。')
    expect(new Set(again.tags)).toEqual(new Set(['沟通', '风格']))
    expect(vault.list({ statuses: ['active'] })).toHaveLength(1)

    // 不同 scopeRef 是新增记录，同一自然日应被全局预算拒绝。
    expect(() => vault.addActive({
      kind: 'convention',
      title: '回复语言',
      content: '另一仓库的偏好。',
      scope: 'repo',
      scopeRef: '/workspace/other'
    })).toThrow('今天已沉淀 1 条记忆')
    expect(vault.list({ statuses: ['active'] })).toHaveLength(1)

    // persona：context 头部含 preamble。
    vault.setPersona('用户偏好最小改动，不顺手重构。')
    const text = vault.context({ cwd: '/anywhere', task: '' }).text
    expect(text.indexOf('# 协作偏好')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('用中文回复')).toBeGreaterThan(text.indexOf('# 协作偏好'))
    expect(vault.getPersona()).toBe('用户偏好最小改动，不顺手重构。')
    vault.close()
  })

  it('所有类型、作用域和连接共享每日一个槽位，删除不释放且次日恢复', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-vault-daily-'))
    directories.push(directory)
    const path = join(directory, 'memories', 'vault.sqlite')
    let current = new Date(2026, 6, 19, 10, 30)
    const clock = (): Date => new Date(current.getTime())
    const firstVault = new MemoryVault(path, clock)
    const secondVault = new MemoryVault(path, clock)

    const candidate = firstVault.propose({
      kind: 'decision',
      title: '当天第一条',
      content: '这是当天唯一允许新增的记忆。',
      scope: 'repo',
      scopeRef: '/workspace/a'
    })
    expect(firstVault.canDepositToday()).toBe(false)
    expect(firstVault.confirm(candidate.id)?.status).toBe('active')

    expect(() => secondVault.propose({
      kind: 'preference',
      title: '跨连接第二条',
      content: '不同类型、作用域和数据库连接也共用额度。',
      scope: 'user'
    })).toThrow('今天已沉淀 1 条记忆')

    firstVault.forget(candidate.id)
    expect(() => secondVault.addActive({
      kind: 'knowledge',
      title: '删除后重写',
      content: '删除当天记忆也不能释放额度。',
      scope: 'agent',
      scopeRef: 'codex'
    })).toThrow('今天已沉淀 1 条记忆')

    current = new Date(2026, 6, 20, 0, 1)
    expect(secondVault.canDepositToday()).toBe(true)
    const nextDay = secondVault.addActive({
      kind: 'knowledge',
      title: '次日第一条',
      content: '新的本地自然日恢复一个槽位。',
      scope: 'user'
    })
    expect(nextDay.status).toBe('active')

    firstVault.close()
    secondVault.close()
  })

  it('升级后当天已有旧记录时会回填占用，不能再新增第二条', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-os-vault-upgrade-'))
    directories.push(directory)
    const path = join(directory, 'memories', 'vault.sqlite')
    const current = new Date(2026, 6, 19, 14, 0)
    const vault = new MemoryVault(path, () => new Date(current.getTime()))

    vault.migrateExperiences([{
      id: 'same-day-legacy',
      title: '升级前当天记忆',
      contentMd: '模拟新配额表尚未占用、但当天已经存在的记录。',
      tags: [],
      createdAt: current.toISOString(),
      updatedAt: current.toISOString()
    }])
    expect(vault.canDepositToday()).toBe(false)
    vault.forget('same-day-legacy')
    expect(() => vault.propose({
      kind: 'fact',
      title: '不应新增',
      content: '当天已有旧记录，即使删除也不能释放回填后的额度。',
      scope: 'user'
    })).toThrow('今天已沉淀 1 条记忆')
    vault.close()
  })
})
