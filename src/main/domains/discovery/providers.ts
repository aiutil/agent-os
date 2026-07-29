// CLI 发现 providers（SPEC-002）。
// 重写自 v1 electron/cli-discovery-providers.cjs。每个 provider 枚举候选路径并探测可执行，
// 只读环境/文件系统、不修改用户环境；上层 discoverWithProviders 组合它们。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { CommandType, DiscoveryEvidence } from '@shared/types'

export interface ProbeContext {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

export interface ProbeResult {
  checkedPaths: string[]
  matchedPath?: string
  commandType?: CommandType
  error?: string
}

export function commandTypeFor(filePath?: string): CommandType {
  if (!filePath) return 'unknown'
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 'cmd'
  if (lower.endsWith('.ps1')) return 'ps1'
  if (lower.endsWith('.exe') || lower.endsWith('.com')) return 'exe'
  if (lower.endsWith('.sh')) return 'shell'
  return 'unknown'
}

export function existsExecutable(dir: string, executable: string): string {
  if (!dir || !executable) return ''
  // Windows 上扩展名为空的同名文件通常是 npm 安装时生成的 Unix shell shim
  // （#!/bin/sh 脚本，非 PE 文件），node 的 spawn 在无 shell 时无法直接执行，
  // 会触发 ENOENT（如 C:\nvm4w\nodejs\claude）。因此把真正的可执行扩展名
  // （.cmd/.bat/.exe/.ps1）排在前面优先命中；'' 作为兜底放最后，既修复了
  // 命中 shim 的 bug，又保留了“目录里只有无扩展名文件”这一兜底语义。
  // macOS/Linux 仍只用 ['']——其可执行文件本就无扩展名。
  const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', '.ps1', ''] : ['']
  for (const ext of exts) {
    const candidate = path.join(dir, `${executable}${ext}`)
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // not found, try next extension
    }
  }
  return ''
}

function listDirsSafe(root: string): string[] {
  if (!root) return []
  try {
    if (!fs.existsSync(root)) return []
    return fs.readdirSync(root).map((name) => path.join(root, name))
  } catch {
    return []
  }
}

function hit(checked: string[], matchedPath: string): ProbeResult {
  return { checkedPaths: checked, matchedPath, commandType: commandTypeFor(matchedPath) }
}

/** EnvPathProvider — 读取 PATH/Path 并逐项探测，含 macOS/Linux 常见兜底目录。 */
export function probeEnvPath(executable: string, ctx: ProbeContext = {}): ProbeResult {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  const home = ctx.home ?? os.homedir()
  const sep = platform === 'win32' ? ';' : ':'
  const checked: string[] = []
  const seen = new Set<string>()
  const rawPaths = [...(env.PATH || '').split(sep), ...(env.Path || '').split(sep)].filter(Boolean)

  for (const entry of rawPaths) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    checked.push(entry)
    const matched = existsExecutable(entry, executable)
    if (matched) return hit(checked, matched)
  }

  if (platform !== 'win32' && home) {
    const fallback = [
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin'
    ]
    for (const entry of fallback) {
      if (!entry || seen.has(entry)) continue
      seen.add(entry)
      checked.push(entry)
      const matched = existsExecutable(entry, executable)
      if (matched) return hit(checked, matched)
    }
  }

  return { checkedPaths: checked }
}

/** NpmGlobalProvider — 通过 `npm prefix -g` 推断全局 bin 目录。 */
export function probeNpmGlobal(executable: string, ctx: ProbeContext = {}): ProbeResult {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  const home = ctx.home ?? os.homedir()
  const checked: string[] = []
  const binDirs = new Set<string>()

  let prefix = ''
  try {
    prefix =
      execFileSync('npm', ['prefix', '-g', '--silent'], {
      env: { ...env, npm_config_prefix: '', NPM_CONFIG_PREFIX: '' },
      timeout: 2000,
      encoding: 'utf8',
      windowsHide: true,
      shell: platform === 'win32'
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? ''
  } catch {
    prefix = ''
  }

  if (prefix) {
    const binDir =
      platform === 'win32' ? path.join(prefix, 'node_modules', '.bin') : path.join(prefix, 'bin')
    checked.push(binDir)
    binDirs.add(binDir)
  }

  const fallback =
    platform === 'win32'
      ? path.join(home || '', 'AppData', 'Roaming', 'npm')
      : prefix
        ? path.join(prefix, 'bin')
        : path.join(home || '', '.npm-global', 'bin')
  if (fallback) {
    checked.push(fallback)
    binDirs.add(fallback)
  }

  for (const dir of binDirs) {
    const matched = existsExecutable(dir, executable)
    if (matched) return hit(checked, matched)
  }
  return { checkedPaths: checked }
}

/** VersionManagerProvider — Volta / fnm / nvm / pnpm / Bun。 */
export function probeVersionManagers(executable: string, ctx: ProbeContext = {}): ProbeResult {
  const platform = ctx.platform ?? process.platform
  const home = ctx.home ?? os.homedir()
  const checked: string[] = []
  if (!home) return { checkedPaths: checked }

  const candidates =
    platform === 'win32'
      ? [
          path.join(home, 'AppData', 'Local', 'Volta', 'bin'),
          path.join(home, '.fnm', 'aliases', 'default'),
          path.join(home, 'AppData', 'Roaming', 'fnm', 'node-versions'),
          path.join(home, 'AppData', 'Roaming', 'nvm'),
          path.join(home, 'AppData', 'Local', 'pnpm'),
          path.join(home, 'AppData', 'Roaming', 'npm'),
          path.join(home, '.bun', 'bin')
        ]
      : [
          path.join(home, '.volta', 'bin'),
          path.join(home, '.fnm', 'aliases', 'default'),
          path.join(home, '.local', 'share', 'fnm', 'node-versions'),
          path.join(home, '.nvm', 'versions', 'node'),
          path.join(home, '.local', 'share', 'pnpm'),
          path.join(home, '.bun', 'bin')
        ]

  for (const base of candidates) {
    if (!base) continue
    checked.push(base)
    const directHit = existsExecutable(base, executable)
    if (directHit) return hit(checked, directHit)
    for (const dir of listDirsSafe(base)) {
      if (checked.includes(dir)) continue
      checked.push(dir)
      const matched = existsExecutable(dir, executable)
      if (matched) return hit(checked, matched)
      // 版本管理器把可执行放在版本目录的 bin 子目录，且布局不一致：
      //   nvm:  ~/.nvm/versions/node/<ver>/bin
      //   fnm:  ~/.local/share/fnm/node-versions/<ver>/installation/bin
      // 现有只探到版本目录一级，会漏掉 nvm 的 node（其 node 在 <ver>/bin 里）。
      // 逐个候选 bin 子目录用 existsExecutable 校验存在性后命中——不是猜路径，
      // 是按版本管理器既定布局定位再验证。
      for (const sub of [path.join(dir, 'bin'), path.join(dir, 'installation', 'bin')]) {
        if (checked.includes(sub)) continue
        checked.push(sub)
        const nested = existsExecutable(sub, executable)
        if (nested) return hit(checked, nested)
      }
    }
  }
  return { checkedPaths: checked }
}

/** PackageManagerProvider — Scoop / Chocolatey / Homebrew / Linux 包管理。 */
export function probePackageManagers(executable: string, ctx: ProbeContext = {}): ProbeResult {
  const platform = ctx.platform ?? process.platform
  const env = ctx.env ?? process.env
  const home = ctx.home ?? os.homedir()
  const checked: string[] = []
  const candidates: string[] = []

  if (platform === 'win32') {
    candidates.push(
      env.SCOOP ? path.join(env.SCOOP, 'shims') : path.join(home || '', 'scoop', 'shims'),
      env.ChocolateyInstall
        ? path.join(env.ChocolateyInstall, 'bin')
        : 'C:\\ProgramData\\chocolatey\\bin'
    )
  } else if (platform === 'darwin') {
    candidates.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home || '', '.brew', 'bin'))
  } else {
    candidates.push('/usr/bin', '/usr/local/bin', '/snap/bin')
  }

  for (const dir of candidates) {
    if (!dir) continue
    checked.push(dir)
    const matched = existsExecutable(dir, executable)
    if (matched) return hit(checked, matched)
  }
  return { checkedPaths: checked }
}

export interface Provider {
  name: string
  probe: (executable: string, ctx: ProbeContext) => ProbeResult
}

export const PROVIDERS: Provider[] = [
  { name: 'EnvPathProvider', probe: probeEnvPath },
  { name: 'NpmGlobalProvider', probe: probeNpmGlobal },
  { name: 'VersionManagerProvider', probe: probeVersionManagers },
  { name: 'PackageManagerProvider', probe: probePackageManagers }
]

export interface DiscoverWithProvidersResult {
  matchedPath?: string
  commandType?: CommandType
  evidence: DiscoveryEvidence[]
}

/** 按顺序运行 providers，命中即返回，并保留完整证据链。 */
export function discoverWithProviders(
  executable: string,
  ctx: ProbeContext = {}
): DiscoverWithProvidersResult {
  const evidence: DiscoveryEvidence[] = []
  for (const provider of PROVIDERS) {
    const result = provider.probe(executable, { ...ctx }) ?? { checkedPaths: [] }
    evidence.push({
      provider: provider.name,
      checkedPaths: result.checkedPaths ?? [],
      matchedPath: result.matchedPath,
      commandType: result.commandType,
      error: result.error
    })
    if (result.matchedPath) {
      return { matchedPath: result.matchedPath, commandType: result.commandType, evidence }
    }
  }
  return { evidence }
}

/**
 * 精确解析 node 可执行文件所在目录（用于 GUI 启动时补齐 PATH）。
 *
 * GUI 启动时 process.env.PATH 是 launchd 的最小集，缺 nvm/homebrew 等 node 目录，
 * 导致 #!/usr/bin/env node 的 CLI（pi/codex/qwen）shebang 解析失败（env: node: No such file）。
 * 这里只跑能定位 node 的三个 provider（EnvPath / VersionManager / PackageManager），
 * 跳过 NpmGlobal——它要 spawn `npm prefix -g`，而 GUI 下 npm 往往也不在 PATH，
 * 且 npm 全局 bin 里放的是 CLI 不是 node，对定位 node 无帮助。
 * 返回的是经 existsExecutable 验证的真实 node 所在目录，非硬编码回退表。
 */
export function resolveNodeBinDir(ctx: ProbeContext = {}): string {
  for (const probe of [probeEnvPath, probeVersionManagers, probePackageManagers]) {
    const matched = probe('node', ctx).matchedPath
    if (matched) return path.dirname(matched)
  }
  return ''
}
