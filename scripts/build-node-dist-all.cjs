#!/usr/bin/env node
// SPEC-032：在当前 Mac arm64 + Docker Linux arm64/x64 中生成节点自包含制品。
// Linux 包必须在目标架构内安装 node-pty / better-sqlite3，不能复用宿主 node_modules。
// 前置：先执行 npm run build；Docker Desktop/OrbStack 需可用。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const remoteNode = path.join(ROOT, 'out', 'main', 'remote-node.js')
const IMAGE = process.env.AGENT_OS_NODE_DIST_IMAGE || 'node:20-bookworm-slim'

function findNode20() {
  const candidates = [process.execPath]
  const nvmRoot = process.env.NVM_DIR || path.join(os.homedir(), '.nvm')
  const versionsDir = path.join(nvmRoot, 'versions', 'node')
  if (fs.existsSync(versionsDir)) {
    for (const versionDir of fs.readdirSync(versionsDir).sort().reverse()) {
      candidates.push(path.join(versionsDir, versionDir, 'bin', 'node'))
    }
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    try {
      const major = execFileSync(candidate, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).trim()
      if (major === '20') return candidate
    } catch {
      // 继续尝试下一项。
    }
  }
  throw new Error('未找到 Node 20.x；节点制品构建需要固定 ABI 115。请安装 Node 20 后重试。')
}

if (!fs.existsSync(remoteNode)) {
  console.error('✗ 未找到 out/main/remote-node.js，请先执行 `npm run build`。')
  process.exit(1)
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('✗ dist:node:all 当前仅在 macOS arm64 主控机运行；请在该机执行。')
  process.exit(1)
}

function run(cmd, args) {
  console.log(`→ ${[cmd, ...args].join(' ')}`)
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })
}

function runWithRetry(cmd, args, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(cmd, args)
      return
    } catch (error) {
      lastError = error
      if (attempt >= attempts) break
      console.warn(`⚠ 命令失败，${attempts - attempt} 次重试剩余：${[cmd, ...args].join(' ')}`)
    }
  }
  throw lastError
}

// 本机 Node ABI：mac-arm64。即使桌面开发环境使用 Node 22/24，也强制寻找 Node 20。
run(findNode20(), ['scripts/build-node-dist.cjs'])
console.log('→ win-x64 不再生成需目标机 npm install 的 bootstrap 假制品；请在 Windows 原生构建机运行 build-node-dist.cjs。')

// Docker 中才安装 Linux 对应 ABI 的运行时依赖；编译工具是 node-pty 无 prebuild 时的兜底。
for (const platform of ['linux/arm64', 'linux/amd64']) {
  runWithRetry('docker', [
    'run', '--rm', '--platform', platform,
    '--mount', `type=bind,source=${ROOT},target=/workspace`,
    '--workdir', '/workspace',
    IMAGE,
    'sh', '-lc',
    'apt-get update -qq && apt-get install -y -qq --no-install-recommends python3 make g++ >/dev/null && node scripts/build-node-dist.cjs'
  ])
}

console.log('✓ 已生成本机 mac-arm64 与 Linux arm64/x64 自包含节点制品；Windows 制品需在 Windows 原生构建机生成。')
