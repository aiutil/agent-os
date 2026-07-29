import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAdapter } from '../src/main/domains/adapters/registry'
import {
  buildLifecycleCommand,
  buildProviderEnvironment,
  classifyLifecycleFailure,
  validateProviderConfig
} from '../src/main/domains/lifecycle/config'
import {
  LifecycleJobManager,
  resolveLifecycleShell
} from '../src/main/domains/lifecycle/jobs'

const fixtures = join(import.meta.dirname, 'fixtures/lifecycle')
const originalShell = process.env.SHELL

// 这些测试验证 LifecycleJobManager 的流式输出与终态，不验证用户私有的
// login-shell 配置。全量并发时加载 ~/.zshrc 可能被外部插件/网络初始化拖过
// 10 秒，令一个立即退出的 fixture 产生假失败；固定到系统 sh 保持测试隔离。
beforeAll(() => {
  process.env.SHELL = '/bin/sh'
})

afterAll(() => {
  if (originalShell === undefined) delete process.env.SHELL
  else process.env.SHELL = originalShell
})

async function waitForFinal(manager: LifecycleJobManager, jobId: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const job = manager.get(jobId)
    if (job && ['succeeded', 'failed', 'cancelled'].includes(job.status)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`job ${jobId} did not finish`)
}

describe('lifecycle command and diagnosis', () => {
  it('uses verified native update commands and applies registry only to npm installs', () => {
    expect(
      buildLifecycleCommand(getAdapter('codex')!, 'install', {
        npmRegistry: 'https://registry.npmmirror.com'
      })
    ).toBe(
      "npm install --global '@openai/codex@latest' --registry 'https://registry.npmmirror.com'"
    )
    expect(
      buildLifecycleCommand(getAdapter('gemini')!, 'install', {
        npmRegistry: 'https://registry.npmmirror.com'
      })
    ).toContain("'@google/gemini-cli@latest'")
    expect(buildLifecycleCommand(getAdapter('claude')!, 'update', {})).toBe('claude update')
    expect(buildLifecycleCommand(getAdapter('codex')!, 'update', {})).toBe('codex update')
    expect(buildLifecycleCommand(getAdapter('opencode')!, 'update', {})).toBe(
      'opencode upgrade'
    )
  })

  it('classifies actionable network, permission, PATH and runtime failures', () => {
    expect(classifyLifecycleFailure('npm error ENOTFOUND registry.npmjs.org').category).toBe(
      'network'
    )
    expect(classifyLifecycleFailure('EACCES permission denied').category).toBe('permission')
    expect(classifyLifecycleFailure('zsh: command not found: npm').category).toBe('runtime')
    expect(classifyLifecycleFailure('installed, but codex not found in PATH').category).toBe('path')
  })
})

describe('provider environment', () => {
  it('rejects obviously truncated keys without making a network request', () => {
    expect(() =>
      validateProviderConfig({ toolId: 'claude', apiKey: 'short' })
    ).toThrow('API Key')
    expect(() =>
      validateProviderConfig({ toolId: 'claude', apiKey: 'sk-ant-local-test-key' })
    ).not.toThrow()
  })

  it('maps local BYOK config to adapter-specific process variables without shell mutation', () => {
    expect(
      buildProviderEnvironment(getAdapter('claude')!, {
        toolId: 'claude',
        apiKey: 'sk-ant-test',
        baseUrl: 'https://api.example.test',
        model: 'claude-test'
      })
    ).toEqual({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'https://api.example.test',
      ANTHROPIC_MODEL: 'claude-test'
    })
    expect(
      buildProviderEnvironment(getAdapter('codex')!, {
        toolId: 'codex',
        apiKey: 'sk-test',
        baseUrl: 'https://openai.example.test',
        model: 'gpt-test'
      })
    ).toEqual({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://openai.example.test'
    })
    expect(
      getAdapter('codex')?.buildLaunchCommand({
        cwd: '/tmp/project',
        model: 'gpt-test'
      })
    ).toBe("codex --model 'gpt-test'")
  })
})

describe('LifecycleJobManager', () => {
  it('uses a platform-native command shell', () => {
    expect(resolveLifecycleShell('darwin', '/bin/zsh')).toEqual({
      executable: '/bin/zsh',
      args: ['-lc']
    })
    expect(resolveLifecycleShell('win32')).toEqual({
      executable: 'powershell.exe',
      args: ['-NoProfile', '-Command']
    })
  })

  it('streams a successful synthetic executable and rescans after completion', async () => {
    const rescanned: string[] = []
    const manager = new LifecycleJobManager({
      resolveCommand: () => `/bin/sh '${join(fixtures, 'success.sh')}'`,
      environment: () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890' }),
      onSucceeded: async (toolId) => {
        rescanned.push(toolId)
      }
    })

    const jobId = manager.start('codex', 'install')
    await waitForFinal(manager, jobId)

    expect(manager.get(jobId)).toMatchObject({
      toolId: 'codex',
      kind: 'install',
      status: 'succeeded',
      exitCode: 0
    })
    expect(manager.get(jobId)?.logTail).toContain('installed version 1.2.3')
    expect(rescanned).toEqual(['codex'])
  }, 15_000)

  it.each([
    ['network-failure.sh', 'network'],
    ['permission-failure.sh', 'permission']
  ] as const)('classifies fixture %s as %s', async (fixture, category) => {
    const manager = new LifecycleJobManager({
      resolveCommand: () => `/bin/sh '${join(fixtures, fixture)}'`
    })

    const jobId = manager.start('codex', 'install')
    await waitForFinal(manager, jobId)

    expect(manager.get(jobId)).toMatchObject({
      status: 'failed',
      exitCode: 1,
      diagnosis: { category }
    })
  }, 15_000)
})
