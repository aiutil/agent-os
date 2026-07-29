import { describe, expect, it } from 'vitest'
import { listToolModels } from '../src/main/domains/discovery/models'

const runNative = process.env.AGENT_OS_NATIVE_INTEGRATION === '1'

describe.skipIf(!runNative)('SPEC-041 本机 Agent 原生目录集成', () => {
  it('Codex 通过 app-server 返回账户真实模型、思考级别与图片模态', async () => {
    const catalog = await listToolModels('codex', process.env.CODEX_BIN || 'codex')
    expect(catalog.source).toBe('native')
    expect(catalog.models.some((model) => model.id.startsWith('gpt-5.6'))).toBe(true)
    const frontier = catalog.models.find((model) => model.id.startsWith('gpt-5.6'))
    expect(frontier?.reasoningEfforts?.length).toBeGreaterThan(0)
    expect(frontier?.inputModalities).toContain('image')
  }, 30_000)

  it('Pi 返回当前已配置 provider 的真实模型并带原生能力', async () => {
    const catalog = await listToolModels('pi', process.env.PI_BIN || 'pi')
    expect(catalog.source).toBe('native')
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.models.every((model) => model.id.includes('/'))).toBe(true)
    expect(catalog.reasoningEfforts?.map((option) => option.id)).toContain('xhigh')
  }, 30_000)

  it('OpenCode 使用 verbose 原生目录并保留模型 variant/附件元数据', async () => {
    const catalog = await listToolModels('opencode', process.env.OPENCODE_BIN || 'opencode')
    expect(catalog.source).toBe('native')
    expect(catalog.models.some((model) => model.id.includes('gpt-5.6'))).toBe(true)
    expect(catalog.models.some((model) => model.reasoningEfforts?.length)).toBe(true)
    expect(catalog.models.some((model) => model.inputModalities?.includes('image'))).toBe(true)
  }, 30_000)

  it('Cursor 不把标题和 Tip 解析成模型', async () => {
    const catalog = await listToolModels(
      'cursor-agent',
      process.env.CURSOR_AGENT_BIN || 'cursor-agent'
    )
    expect(catalog.source).toBe('native')
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.models.some((model) => /^(Available|Tip:?)$/.test(model.id))).toBe(false)
  }, 30_000)

  it('Claude 不伪造模型目录，但从当前 CLI 读取原生 effort', async () => {
    const catalog = await listToolModels('claude', process.env.CLAUDE_BIN || 'claude')
    expect(catalog.source).toBe('unavailable')
    expect(catalog.models).toEqual([])
    expect(catalog.supportsCustomModel).toBe(true)
    expect(catalog.reasoningEfforts?.map((option) => option.id)).toContain('max')
  }, 30_000)

  it('Hermes 读取自身配置 provider 的模型缓存', async () => {
    const catalog = await listToolModels('hermes', process.env.HERMES_BIN || 'hermes')
    expect(catalog.source).toBe('native-cache')
    expect(catalog.models.length).toBeGreaterThan(0)
    expect(catalog.models.every((model) => Boolean(model.provider))).toBe(true)
  }, 30_000)
})
