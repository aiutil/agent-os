// SPEC-041 adapter buildTurn 原生附件翻译单测。
import { describe, expect, it } from 'vitest'
import { buildClaudeHeadlessTurn } from '../src/main/domains/adapters/claude/control'
import { buildCodexHeadlessTurn } from '../src/main/domains/adapters/codex/control'
import { buildGeminiHeadlessTurn } from '../src/main/domains/adapters/gemini/control'
import { buildHermesHeadlessTurn } from '../src/main/domains/adapters/hermes/control'
import { buildOpenCodeHeadlessTurn } from '../src/main/domains/adapters/opencode/control'
import { buildPiHeadlessTurn } from '../src/main/domains/adapters/pi/control'
import type { HeadlessTurnInput } from '../src/main/domains/adapters/types'

const base: HeadlessTurnInput = {
  prompt: '看图',
  approvalUrl: 'http://127.0.0.1:4567/permission',
  approvalToken: 't',
  turnId: 'turn-1'
}

describe('attachment translation in buildTurn (SPEC-041)', () => {
  // claude 没有「本地文件」flag：--file 是远端 file_id 下载（会抛 session token 错），
  // 也没有 --image / @path 展开。附件路径拼进 positional prompt，靠 Read 工具读取。
  it('claude 把附件路径拼进 prompt、且不产生 --file', () => {
    const launch = buildClaudeHeadlessTurn({ ...base, files: ['/a.png', '/b.txt'] })
    expect(launch.args).not.toContain('--file')
    // prompt 是最后一个 positional argv。
    const promptArg = launch.args[launch.args.length - 1]
    expect(promptArg).toContain('看图')
    expect(promptArg).toContain('/a.png')
    expect(promptArg).toContain('/b.txt')
    expect(promptArg).toContain('Read')
  })

  it('claude 无附件时 prompt 保持原样、不含附件块', () => {
    const launch = buildClaudeHeadlessTurn(base)
    expect(launch.args).not.toContain('--file')
    expect(launch.args[launch.args.length - 1]).toBe('看图')
  })

  it('opencode 把每个附件翻成 --file <abspath>', () => {
    const launch = buildOpenCodeHeadlessTurn({ ...base, files: ['/a.png'] })
    expect(launch.args).toEqual(expect.arrayContaining(['--file', '/a.png']))
  })

  it('gemini 把附件翻成 @<abspath> 追加进 --prompt', () => {
    const launch = buildGeminiHeadlessTurn({ ...base, files: ['/abs/x.png', '/abs/y.pdf'] })
    const promptArg = launch.args[launch.args.indexOf('--prompt') + 1]
    expect(promptArg).toContain('看图')
    expect(promptArg).toContain('@/abs/x.png')
    expect(promptArg).toContain('@/abs/y.pdf')
  })

  it('gemini 无附件时 prompt 保持原样、不含 @', () => {
    const launch = buildGeminiHeadlessTurn(base)
    const promptArg = launch.args[launch.args.indexOf('--prompt') + 1]
    expect(promptArg).toBe('看图')
  })

  it('opencode/claude 无附件时不产生 --file', () => {
    expect(buildOpenCodeHeadlessTurn(base).args).not.toContain('--file')
    expect(buildClaudeHeadlessTurn(base).args).not.toContain('--file')
  })

  it('codex 把每张图片翻译为原生 --image，并拒绝通用文件', () => {
    const launch = buildCodexHeadlessTurn({
      ...base,
      reasoningEffort: 'high',
      files: ['/tmp/a.png', '/tmp/b.webp']
    })
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '-c',
        'model_reasoning_effort="high"',
        '--image',
        '/tmp/a.png',
        '--image',
        '/tmp/b.webp'
      ])
    )
    expect(() => buildCodexHeadlessTurn({ ...base, files: ['/tmp/readme.md'] })).toThrow(
      '仅支持图片附件'
    )
  })

  it('pi 使用原生 @path positional 参数并传递 thinking', () => {
    const launch = buildPiHeadlessTurn({
      ...base,
      reasoningEffort: 'xhigh',
      files: ['/tmp/a.png', '/tmp/readme.md']
    })
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--thinking',
        'xhigh',
        '@/tmp/a.png',
        '@/tmp/readme.md'
      ])
    )
  })

  it('Hermes 使用单图 --image 并拒绝多图', () => {
    expect(buildHermesHeadlessTurn({ ...base, files: ['/tmp/a.png'] }).args).toEqual(
      expect.arrayContaining(['--image', '/tmp/a.png'])
    )
    expect(() =>
      buildHermesHeadlessTurn({ ...base, files: ['/tmp/a.png', '/tmp/b.png'] })
    ).toThrow('每次最多接收 1 个附件')
  })

  it('Claude 与 OpenCode 传递各自原生思考级别', () => {
    expect(
      buildClaudeHeadlessTurn({ ...base, reasoningEffort: 'max' }).args
    ).toEqual(expect.arrayContaining(['--effort', 'max']))
    expect(
      buildOpenCodeHeadlessTurn({ ...base, reasoningEffort: 'high' }).args
    ).toEqual(expect.arrayContaining(['--variant', 'high']))
  })
})
