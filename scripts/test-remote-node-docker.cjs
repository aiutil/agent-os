#!/usr/bin/env node
// SPEC-032：用当前 package 版本构建生产 remote-node bundle 镜像并跑完整反向控制链。
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process, console */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const image = `agentos-node-reverse-test:${version}`
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
if (!arch) throw new Error(`Docker 节点制品验收不支持当前架构：${process.arch}`)
const dockerArch = arch === 'x64' ? 'amd64' : arch
const platform = `linux-${arch}`
const archiveName = `agentos-node-${version}-${platform}.tar.gz`
const archivePath = path.join(ROOT, 'release', archiveName)
const mount = `type=bind,source=${ROOT},target=/workspace`

function buildImageWithRetry(label, args, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      execFileSync('docker', args, { cwd: ROOT, stdio: 'inherit' })
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) console.warn(`⚠ ${label} 失败，将重试（${attempt}/${attempts}）`)
    }
  }
  throw lastError
}

console.log(`→ 在 Linux ${arch} / Node 20 中生成真实自包含节点制品 ${archiveName}`)
// 这条命令包含全文件、better-sqlite3 与真实 node-pty 探针。
// 任一失败都立即中止，不用重试掩盖行为/原生模块缺陷。
execFileSync('docker', [
  'run', '--rm', '--platform', `linux/${dockerArch}`,
  '--mount', mount,
  '--workdir', '/workspace',
  'node:20-bookworm-slim',
  'sh', '-lc',
  'apt-get update -qq && apt-get install -y -qq --no-install-recommends git python3 make g++ >/dev/null && node scripts/build-node-dist.cjs'
], { cwd: ROOT, stdio: 'inherit' })
if (!fs.existsSync(archivePath)) throw new Error(`节点制品未生成：${archivePath}`)

console.log(`→ 构建无系统 Node/npm/编译链的制品验收镜像 ${image}`)
buildImageWithRetry('制品验收镜像构建', [
  'build',
  '--build-arg', `AGENT_OS_VERSION=${version}`,
  '-f', 'docker/remote-node/Dockerfile',
  '-t', image,
  '.'
])

console.log('→ 验证一行命令、真实安装器、换票/采纳、远程 PTY 与会话 I/O')
execFileSync(process.execPath, ['docker/remote-node/test-reverse.mjs'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    AGENT_OS_NODE_TEST_IMAGE: image,
    AGENT_OS_NODE_TEST_ARCHIVE: archivePath,
    AGENT_OS_NODE_TEST_PLATFORM: platform,
    AGENT_OS_NODE_TEST_VERSION: version
  }
})
