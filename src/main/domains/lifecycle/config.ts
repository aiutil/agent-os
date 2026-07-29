import type { CliAdapter } from '../adapters/types'
import { shellQuote } from '../adapters/types'
import type {
  LifecycleDiagnosis,
  LifecycleJobKind,
  MirrorSettings,
  ProviderConfig
} from '@shared/types'

export function buildLifecycleCommand(
  adapter: CliAdapter,
  kind: LifecycleJobKind,
  settings: MirrorSettings
): string {
  const lifecycle = adapter.lifecycle
  if (!lifecycle) throw new Error(`${adapter.displayName} 不支持生命周期操作`)
  if (kind === 'update') {
    if (
      adapter.id === 'gemini' &&
      settings.npmRegistry &&
      lifecycle.updateCommand.startsWith('npm ')
    ) {
      return `${lifecycle.updateCommand} --registry ${shellQuote(settings.npmRegistry)}`
    }
    return lifecycle.updateCommand
  }
  if (lifecycle.install.method === 'shell') return lifecycle.install.command
  const registry = settings.npmRegistry
    ? ` --registry ${shellQuote(settings.npmRegistry)}`
    : ''
  return `npm install --global ${shellQuote(lifecycle.install.packageName)}${registry}`
}

export function buildProviderEnvironment(
  adapter: CliAdapter,
  config: ProviderConfig
): Record<string, string> {
  const names = adapter.providerEnvironment
  if (!names) return {}
  const env: Record<string, string> = {}
  if (names.apiKey && config.apiKey?.trim()) env[names.apiKey] = config.apiKey.trim()
  if (names.baseUrl && config.baseUrl?.trim()) env[names.baseUrl] = config.baseUrl.trim()
  if (names.model && config.model?.trim()) env[names.model] = config.model.trim()
  return env
}

export function validateProviderConfig(config: ProviderConfig): void {
  const key = config.apiKey?.trim()
  if (key && key.length < 8) {
    throw new Error('API Key 长度过短，请检查是否粘贴完整。')
  }
  const baseUrl = config.baseUrl?.trim()
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
    } catch {
      throw new Error('Base URL 必须是有效的 http 或 https 地址。')
    }
  }
}

const DIAGNOSES: Array<{
  category: LifecycleDiagnosis['category']
  pattern: RegExp
  suggestion: string
}> = [
  {
    category: 'network',
    pattern: /\b(?:ENOTFOUND|ENETUNREACH|ECONNRESET|ETIMEDOUT|timeout|network)\b/i,
    suggestion: '检查网络，或切换 npm 镜像并配置 HTTPS 代理后重试。'
  },
  {
    category: 'permission',
    pattern: /\b(?:EACCES|EPERM|permission denied)\b/i,
    suggestion: '检查全局安装目录权限，优先修复 npm prefix，不要直接使用 sudo。'
  },
  {
    category: 'runtime',
    pattern: /(?:command not found|not recognized).*(?:npm|node|curl|brew)|(?:npm|node|curl|brew).*not found/i,
    suggestion: '先安装或修复所需运行时，并确认它能从登录 shell 的 PATH 中找到。'
  },
  {
    category: 'path',
    pattern: /(?:not found in PATH|PATH cache|hash -r)/i,
    suggestion: '刷新 shell PATH（可执行 hash -r）后重新扫描。'
  }
]

export function classifyLifecycleFailure(output: string): LifecycleDiagnosis {
  const evidence =
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-3)
      .join('\n') || '任务异常退出，未提供错误输出。'
  const matched = DIAGNOSES.find((item) => item.pattern.test(output))
  return {
    category: matched?.category ?? 'unknown',
    evidence,
    suggestion: matched?.suggestion ?? '展开日志确认失败原因，修复后重试。'
  }
}
