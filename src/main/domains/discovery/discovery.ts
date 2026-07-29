// CLI 自动发现编排（SPEC-002）。
// 对每个适配器：用 providers 探测可执行 → 命中则读版本 → 组装 DiscoveryResult。
// 全程非侵入、带超时；首启动引导与工作台 CLI 选择器共用此结果。

import { execFile } from 'node:child_process'
import { listAdapters } from '../adapters/registry'
import type { CliAdapter } from '../adapters/types'
import type { CliHealth, DiscoveryResult } from '@shared/types'
import { discoverWithProviders } from './providers'

const VERSION_TIMEOUT_MS = 3500

/**
 * 异步执行版本命令，失败/超时返回空串（不抛）。
 *
 * Windows：npm 全局 CLI 都是 .cmd/.bat shim，node execFile 无 shell 时对 .cmd
 * 同步抛 EINVAL（CVE-2024-27980）。这里只做兜底——try/catch 捕获同步异常并
 * resolve('')，保证已发现的 CLI 保持 health="ready"（不再误判「修复安装」），
 * 且 scanAll 不逐个 spawn 进程、保持首屏即出（避免新建会话选择器短暂空白）。
 * 副作用：Windows 下版本号暂不抓取；macOS/Linux 行为完全不变，仍正常取版本。
 */
function probeVersion(executablePath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(
        executablePath,
        args,
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) {
            // 部分 CLI 把版本打到 stderr。
            resolve(String(stderr || '').trim())
            return
          }
          resolve(String(stdout || stderr || '').trim())
        }
      )
    } catch {
      // Windows .cmd 无 shell 同步抛 EINVAL：已发现的 CLI 仍保持 ready，仅版本未知。
      resolve('')
    }
  })
}

async function discoverAdapter(adapter: CliAdapter): Promise<DiscoveryResult> {
  const startedAt = Date.now()
  const { matchedPath, commandType, evidence } = discoverWithProviders(adapter.executable)

  const supportsChat = adapter.headlessJson != null

  if (!matchedPath) {
    return {
      toolId: adapter.id,
      displayName: adapter.displayName,
      executable: adapter.executable,
      health: 'missing' satisfies CliHealth,
      supportsChat,
      evidence,
      suggestedFixes: adapter.installHint ? [adapter.installHint] : [],
      scanDurationMs: Date.now() - startedAt
    }
  }

  let version: string | undefined
  let health: CliHealth = 'ready'
  try {
    const raw = await probeVersion(matchedPath, adapter.versionArgs)
    version = adapter.parseVersion(raw)
  } catch {
    health = 'failed'
  }

  return {
    toolId: adapter.id,
    displayName: adapter.displayName,
    executable: adapter.executable,
    health,
    executablePath: matchedPath,
    commandType,
    version,
    runtime: adapter.runtime,
    supportsChat,
    evidence,
    scanDurationMs: Date.now() - startedAt
  }
}

/** 扫描全部适配器（并行）。 */
export async function scanAll(): Promise<DiscoveryResult[]> {
  return Promise.all(listAdapters().map((adapter) => discoverAdapter(adapter)))
}

/** 扫描单个适配器。 */
export async function scanOne(toolId: string): Promise<DiscoveryResult | null> {
  const adapter = listAdapters().find((item) => item.id === toolId)
  if (!adapter) return null
  return discoverAdapter(adapter)
}
