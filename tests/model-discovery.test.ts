import { describe, expect, it } from 'vitest'
import {
  listToolModels,
  parseCodexModels,
  parseCursorModels,
  parseHermesModelsCache,
  parseOpenCodeModels,
  parsePiModels,
  parseReasoningLevels
} from '../src/main/domains/discovery/models'

const OPENCODE_OUTPUT = [
  'openai/gpt-next',
  '{',
  '  "name": "GPT Next",',
  '  "capabilities": {',
  '    "attachment": true,',
  '    "input": { "text": true, "image": true, "pdf": false }',
  '  },',
  '  "variants": { "low": {}, "high": {} }',
  '}',
  'local/text-model',
  '{',
  '  "name": "Text Model",',
  '  "capabilities": {',
  '    "attachment": false,',
  '    "input": { "text": true, "image": false, "pdf": false }',
  '  },',
  '  "variants": {}',
  '}'
].join('\n')

const PI_OUTPUT = [
  'provider       model                   context  max-out  thinking  images',
  'minimax-cn     MiniMax-M2.7            204.8K   131.1K   yes       no',
  'minimax-cn     MiniMax-M3              512K     128K     yes       yes',
  'zai-coding-cn  glm-basic               204.8K   131.1K   no        no'
].join('\n')

describe('Codex 原生 model/list 解析', () => {
  it('保留模型级思考级别、默认项与输入模态', () => {
    const models = parseCodexModels([
      {
        id: 'frontier-id',
        model: 'gpt-frontier',
        displayName: 'GPT Frontier',
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: '' },
          { reasoningEffort: 'medium', description: '' },
          { reasoningEffort: 'high', description: '' }
        ],
        inputModalities: ['text', 'image']
      },
      { id: 'hidden', displayName: 'Hidden', hidden: true }
    ])
    expect(models).toEqual([
      {
        id: 'gpt-frontier',
        label: 'GPT Frontier',
        provider: 'openai',
        isDefault: true,
        reasoningEfforts: [
          { id: 'low', label: 'low' },
          { id: 'medium', label: 'medium', isDefault: true },
          { id: 'high', label: 'high' }
        ],
        inputModalities: ['text', 'image']
      }
    ])
  })
})

describe('OpenCode 原生 verbose 目录', () => {
  it('解析真实名称、variant 与模型输入能力', () => {
    const models = parseOpenCodeModels(OPENCODE_OUTPUT)
    expect(models).toHaveLength(2)
    expect(models[0]).toEqual({
      id: 'openai/gpt-next',
      label: 'GPT Next',
      provider: 'openai',
      reasoningEfforts: [
        { id: 'low', label: 'low' },
        { id: 'high', label: 'high' }
      ],
      inputModalities: ['text', 'image', 'file']
    })
    expect(models[1].inputModalities).toEqual(['text'])
  })
})

describe('Pi 原生目录与帮助', () => {
  it('只给 thinking=yes 的模型附加帮助中声明的级别', () => {
    const efforts = parseReasoningLevels(
      '  --thinking <level>  Set thinking level: off, minimal, low, medium, high, xhigh',
      '--thinking'
    )
    const models = parsePiModels(PI_OUTPUT, efforts)
    expect(efforts.map((item) => item.id)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(models[0].reasoningEfforts).toEqual(efforts)
    expect(models[1].inputModalities).toEqual(['text', 'file', 'image'])
    expect(models[2].reasoningEfforts).toBeUndefined()
  })

  it('支持 Claude help 把 choices 换行展示', () => {
    expect(
      parseReasoningLevels(
        [
          '  --effort <level>  Effort level for the current session',
          '                    (low, medium, high, xhigh, max)',
          '  --file <specs...>  Files'
        ].join('\n'),
        '--effort'
      ).map((item) => item.id)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('Cursor 原生列表', () => {
  it('忽略标题和 Tip，只解析 id - label 行', () => {
    const models = parseCursorModels(
      [
        'Available models',
        '',
        'auto - Auto (current, default)',
        'composer-next - Composer Next',
        '',
        'Tip: use --model <id> to switch.'
      ].join('\n')
    )
    expect(models.map((model) => model.id)).toEqual(['auto', 'composer-next'])
    expect(models[0].isDefault).toBe(true)
  })
})

describe('Hermes 原生 provider cache', () => {
  it('只从 Hermes 已缓存的配置 provider 读取模型', () => {
    const models = parseHermesModelsCache(
      JSON.stringify({
        anthropic: { fp: 'redacted', at: 1, models: ['model-a', 'model-b'] },
        empty: { models: [] }
      })
    )
    expect(models).toEqual([
      { id: 'anthropic/model-a', label: 'model-a', provider: 'anthropic' },
      { id: 'anthropic/model-b', label: 'model-b', provider: 'anthropic' }
    ])
  })
})

describe('无机器可读目录的 Agent', () => {
  it('不回退硬编码模型，同时允许 CLI 原生自定义 ID', async () => {
    await expect(listToolModels('gemini')).resolves.toEqual({
      models: [],
      source: 'unavailable',
      supportsCustomModel: true
    })
    await expect(listToolModels('shell')).resolves.toEqual({
      models: [],
      source: 'unavailable',
      supportsCustomModel: false
    })
  })
})
