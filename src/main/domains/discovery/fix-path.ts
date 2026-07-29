// GUI 启动期 PATH 补齐（修 `env: node: No such file or directory`）。
//
// 背景：从打包 .app / Dock / Finder 启动时，主进程拿到的是 launchd 的最小 PATH，
// 不含 nvm/homebrew 等 node 目录。chat 会话 spawn 的 CLI 若是 `#!/usr/bin/env node`
// 脚本（pi/codex/qwen），OS 执行 `/usr/bin/env node` 时在子进程 PATH 里找不到 node，
// 直接报 `env: node: No such file or directory`。原生二进制 CLI（claude/opencode）不
// 受影响。
//
// 做法：复用 discovery 已验证的 node 精确路径（resolveNodeBinDir），把其所在目录
// 前置进 process.env.PATH。不硬编码回退目录、不 spawn shell、不加依赖。
// 在主进程入口（index.ts）启动早期调用一次，之后所有 in-process spawn（chat、
// memory-cli、curation、discovery 自身、update）都拿到含 node 的 PATH。

import { resolveNodeBinDir, type ProbeContext } from './providers'

export interface AugmentPathOptions {
  /** 透传给 resolveNodeBinDir 的探测上下文（测试注入用）。 */
  ctx?: ProbeContext
  /** 写入目标 env，默认 process.env（测试注入用）。 */
  target?: NodeJS.ProcessEnv
}

/**
 * 把 node 所在目录前置进 PATH（若已在则跳过）。返回补进去的目录，未补则空串。
 */
export function augmentProcessPathWithNode(options: AugmentPathOptions = {}): string {
  const dir = resolveNodeBinDir(options.ctx)
  if (!dir) return ''
  const env = options.target ?? process.env
  const platform = options.ctx?.platform ?? process.platform
  const key = platform === 'win32' ? 'Path' : 'PATH'
  const sep = platform === 'win32' ? ';' : ':'
  const current = (env[key] ?? '').split(sep).filter(Boolean)
  if (current.includes(dir)) return ''
  env[key] = [dir, ...current].join(sep)
  return dir
}
