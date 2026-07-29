// SPEC-002 发现 providers 单测。用临时目录构造可执行文件，验证 PATH 探测与证据链。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  commandTypeFor,
  existsExecutable,
  probeEnvPath,
  probeVersionManagers,
  discoverWithProviders,
  resolveNodeBinDir
} from '../src/main/domains/discovery/providers'
import { augmentProcessPathWithNode } from '../src/main/domains/discovery/fix-path'

let tmpDir: string
const EXE = 'mycli'

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-discovery-'))
  fs.writeFileSync(path.join(tmpDir, EXE), '#!/bin/sh\necho ok\n', { mode: 0o755 })
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('commandTypeFor', () => {
  it('按扩展名分类', () => {
    expect(commandTypeFor('/x/a.cmd')).toBe('cmd')
    expect(commandTypeFor('/x/a.exe')).toBe('exe')
    expect(commandTypeFor('/x/a.ps1')).toBe('ps1')
    expect(commandTypeFor('/x/a.sh')).toBe('shell')
    expect(commandTypeFor('/x/a')).toBe('unknown')
    expect(commandTypeFor(undefined)).toBe('unknown')
  })
})

describe('existsExecutable', () => {
  it('命中临时目录中的可执行', () => {
    expect(existsExecutable(tmpDir, EXE)).toBe(path.join(tmpDir, EXE))
  })
  it('未命中返回空串', () => {
    expect(existsExecutable(tmpDir, 'nonexistent')).toBe('')
  })
})

describe('probeEnvPath', () => {
  it('在注入的 PATH 中发现可执行', () => {
    const result = probeEnvPath(EXE, {
      platform: 'linux',
      env: { PATH: tmpDir },
      home: os.homedir()
    })
    expect(result.matchedPath).toBe(path.join(tmpDir, EXE))
    expect(result.checkedPaths).toContain(tmpDir)
  })

  it('未发现时返回检查过的路径但无 matchedPath', () => {
    const result = probeEnvPath('ghost', { platform: 'linux', env: { PATH: tmpDir }, home: '' })
    expect(result.matchedPath).toBeUndefined()
    expect(result.checkedPaths).toContain(tmpDir)
  })
})

describe('discoverWithProviders', () => {
  it('命中即返回并保留证据链', () => {
    const original = process.env.PATH
    process.env.PATH = tmpDir
    try {
      const result = discoverWithProviders(EXE)
      expect(result.matchedPath).toBe(path.join(tmpDir, EXE))
      expect(result.evidence.length).toBeGreaterThan(0)
      expect(result.evidence[0].provider).toBe('EnvPathProvider')
    } finally {
      process.env.PATH = original
    }
  })
})

// 构造 fake nvm 布局：<home>/.nvm/versions/node/<ver>/bin/node
// 用于验证版本目录下 bin 子目录的探测（修 nvm node 两级嵌套漏探）。
function makeFakeNvmHome(): { home: string; binDir: string; nodePath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-nvm-'))
  const binDir = path.join(home, '.nvm', 'versions', 'node', 'v9.9.9', 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const nodePath = path.join(binDir, 'node')
  fs.writeFileSync(nodePath, '#!/bin/sh\necho ok\n', { mode: 0o755 })
  return { home, binDir, nodePath }
}

describe('probeVersionManagers', () => {
  it('在 nvm 版本目录的 bin 子目录里发现 node', () => {
    const { home, binDir, nodePath } = makeFakeNvmHome()
    try {
      // env.PATH 故意不含 binDir，迫使走 VersionManagerProvider 的 nvm 分支
      const result = probeVersionManagers('node', {
        platform: 'linux',
        home,
        env: { PATH: '/usr/bin' }
      })
      expect(result.matchedPath).toBe(nodePath)
      expect(result.checkedPaths).toContain(binDir)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('resolveNodeBinDir', () => {
  it('返回 node 所在 bin 目录', () => {
    const { home, binDir } = makeFakeNvmHome()
    try {
      // 把 fake binDir 放进注入的 PATH，使 EnvPathProvider 确定性命中、
      // 不受测试机 /opt/homebrew/bin 等真实 node 干扰
      const dir = resolveNodeBinDir({
        platform: 'linux',
        home,
        env: { PATH: binDir }
      })
      expect(dir).toBe(binDir)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('找不到 node 时返回空串', () => {
    // 用 platform: 'win32'：probeEnvPath 的系统兜底目录只在非 win32 下追加，
    // 且 win32 的版本管理器/包管理器候选在 posix CI 上都不存在，
    // 从而确定性地构造「找不到 node」（posix 上用 linux 会被测试机
    // /opt/homebrew/bin 等真实 node 污染）。
    const dir = resolveNodeBinDir({
      platform: 'win32',
      home: '/nonexistent-home',
      env: { PATH: '/nonexistent-bin' }
    })
    expect(dir).toBe('')
  })
})

describe('augmentProcessPathWithNode', () => {
  it('把 node 目录前置进 PATH，重复调用不重复补', () => {
    const { home, binDir } = makeFakeNvmHome()
    try {
      const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' }
      const ctx = { platform: 'linux' as const, home, env: { PATH: binDir } }
      const added = augmentProcessPathWithNode({ ctx, target })
      expect(added).toBe(binDir)
      expect(target.PATH).toBe(`${binDir}:/usr/bin:/bin`)
      // 已在 PATH，再次调用应幂等
      const added2 = augmentProcessPathWithNode({ ctx, target })
      expect(added2).toBe('')
      expect(target.PATH).toBe(`${binDir}:/usr/bin:/bin`)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('找不到 node 时不改动 PATH', () => {
    // 同上，用 win32 在 posix CI 上确定性构造「找不到 node」
    const target: NodeJS.ProcessEnv = { Path: 'C:\\Windows;C:\\Windows\\System32' }
    const added = augmentProcessPathWithNode({
      ctx: { platform: 'win32', home: 'C:\\nonexistent', env: { PATH: 'C:\\nonexistent-bin' } },
      target
    })
    expect(added).toBe('')
    expect(target.Path).toBe('C:\\Windows;C:\\Windows\\System32')
  })
})
