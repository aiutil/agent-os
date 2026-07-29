// 守卫：远程节点 bundle 真实引用的外部包，必须全部在 docker/remote-node/package.json
// 运行时清单里声明——否则节点机 `npm install` 后会缺包崩溃（cross-spawn 已被坑过两次）。
// 需要先 `npm run build` 产出 out/main；无产物时跳过（不阻塞未构建环境的单测）。

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const OUT_MAIN = path.join(ROOT, 'out', 'main')
const ENTRY = path.join(OUT_MAIN, 'remote-node.js')

// node 内置模块前缀/裸名，不算外部依赖。
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'tty',
  'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib'
])

function bareSpecifier(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  if (spec.startsWith('node:')) return null
  // scoped: @scope/name；否则取第一段。
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]
  if (NODE_BUILTINS.has(name)) return null
  return name
}

function collectExternals(): Set<string> {
  const files = [ENTRY]
  const chunks = path.join(OUT_MAIN, 'chunks')
  if (fs.existsSync(chunks)) {
    for (const f of fs.readdirSync(chunks)) {
      if (f.endsWith('.js') || f.endsWith('.mjs')) files.push(path.join(chunks, f))
    }
  }
  const externals = new Set<string>()
  const re = /(?:require2?\(\s*|from\s*|import\(\s*)['"]([^'"]+)['"]/g
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const name = bareSpecifier(m[1])
      if (name) externals.add(name)
    }
  }
  return externals
}

describe('远程节点 bundle 外部依赖清单守卫', () => {
  const hasBuild = fs.existsSync(ENTRY)

  it.runIf(hasBuild)('bundle 引用的每个外部包都在 docker/remote-node/package.json 声明', () => {
    const declared = new Set(
      Object.keys(
        JSON.parse(fs.readFileSync(path.join(ROOT, 'docker', 'remote-node', 'package.json'), 'utf8'))
          .dependencies ?? {}
      )
    )
    const used = collectExternals()
    const missing = [...used].filter((dep) => !declared.has(dep))
    expect(missing, `节点运行时清单缺少依赖：${missing.join(', ')}`).toEqual([])
  })

  it.skipIf(hasBuild)('未构建（缺 out/main/remote-node.js），跳过 bundle 依赖守卫', () => {
    expect(true).toBe(true)
  })
})
