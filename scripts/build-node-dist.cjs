#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, __dirname, console */
// SPEC-032：打包「Agent OS 远程节点」自包含分发物（按当前平台）。
// 产物 release/agentos-node-<version>-<platform>.tar.gz，内含：
//   out/main 远程节点 bundle + 运行时 package.json + node_modules（本平台 node-ABI 原生模块）。
// 节点机解包即用，无需联网装依赖、无需编译链。
// 前置：先 npm run build（生成 out/main/remote-node.js）。
// 注意：自包含按平台绑定 → 需在 mac/Linux/Windows 各跑一次本脚本（或 CI 矩阵）才能集齐三份。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { buildLocalReleaseProvenance } = require('./release-provenance.cjs')

const ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const releaseProvenance = buildLocalReleaseProvenance(ROOT)
const outMain = path.join(ROOT, 'out', 'main')
const EXPECTED_NODE_MAJOR = 20
const npmCliCandidates = [
  // Unix setup-node / nvm 布局：<prefix>/bin/node → <prefix>/lib/node_modules/npm/bin/npm-cli.js
  path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  // Windows setup-node 布局：node.exe 与 node_modules/npm 同目录。
  path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
]
const npmCli = npmCliCandidates.find((candidate) => fs.existsSync(candidate))

if (Number(process.versions.node.split('.')[0]) !== EXPECTED_NODE_MAJOR) {
  console.error(`✗ 节点制品必须使用 Node ${EXPECTED_NODE_MAJOR}.x 构建，当前为 ${process.version} (ABI ${process.versions.modules})。`)
  console.error('  这项门禁防止 better-sqlite3 / node-pty 在目标机因 ABI 不一致首启崩溃。')
  process.exit(1)
}
if (!npmCli) {
  console.error(`✗ 找不到与 ${process.execPath} 配套的 npm-cli.js：`)
  npmCliCandidates.forEach((candidate) => console.error(`  - ${candidate}`))
  process.exit(1)
}

function platformTag() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  if (process.platform === 'darwin') return `mac-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  if (process.platform === 'win32') return `win-${arch}`
  return `${process.platform}-${arch}`
}

if (!fs.existsSync(path.join(outMain, 'remote-node.js'))) {
  console.error('✗ 未找到 out/main/remote-node.js，请先执行 `npm run build`。')
  process.exit(1)
}

const platform = platformTag()
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-node-dist-'))
const cleanupStage = () => fs.rmSync(stage, { recursive: true, force: true })
process.once('exit', cleanupStage)
const stageMain = path.join(stage, 'out', 'main')
fs.mkdirSync(path.join(stageMain, 'chunks'), { recursive: true })
fs.mkdirSync(path.join(stage, 'bin'), { recursive: true })
fs.mkdirSync(path.join(stage, 'runtime', 'bin'), { recursive: true })

// 1) 远程节点 bundle（remote-node.js + 共享 chunks；不带 index/daemon，减重防误用）。
fs.copyFileSync(path.join(outMain, 'remote-node.js'), path.join(stageMain, 'remote-node.js'))
const chunksDir = path.join(outMain, 'chunks')
if (fs.existsSync(chunksDir)) {
  for (const f of fs.readdirSync(chunksDir)) {
    fs.copyFileSync(path.join(chunksDir, f), path.join(stageMain, 'chunks', f))
  }
}
fs.copyFileSync(path.join(ROOT, 'scripts', 'agentos-cli.cjs'), path.join(stage, 'bin', 'agentos-cli.cjs'))
fs.copyFileSync(path.join(ROOT, 'scripts', 'node-update.cjs'), path.join(stage, 'bin', 'node-update.cjs'))
fs.copyFileSync(path.join(ROOT, 'scripts', 'verify-node-runtime.cjs'), path.join(stage, 'bin', 'verify-node-runtime.cjs'))
const bundledNodeName = process.platform === 'win32' ? 'node.exe' : 'node'
const bundledNodePath = path.join(stage, 'runtime', 'bin', bundledNodeName)
fs.copyFileSync(process.execPath, bundledNodePath)
if (process.platform !== 'win32') fs.chmodSync(bundledNodePath, 0o755)

// 2) 运行时依赖清单（含 cross-spawn，与桌面端 dependencies 对齐），打上版本号。
const nodePkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'docker', 'remote-node', 'package.json'), 'utf8'))
nodePkg.version = version
fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(nodePkg, null, 2)}\n`)

// 3) 自包含：在 stage 内为「本平台 node ABI」安装运行时依赖（拉 prebuild，无需编译链）。
console.log(`→ 安装 node-ABI 运行时依赖到分发物（${platform}）…`)
execFileSync(process.execPath, [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: stage,
  stdio: 'inherit',
  // npm lifecycle/node-gyp 可能重新从 PATH 找 node；显式把当前 Node 20 放首位，避免构建机默认 Node 24 污染原生 ABI。
  env: {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    npm_node_execpath: process.execPath,
    npm_execpath: npmCli
  }
})

// node-pty 1.1.x 的 macOS 预编译包可能把 spawn-helper 发布为 0644。
// pty.node 会通过 posix_spawn 执行同目录 helper；缺少执行位时节点会在首次启动 CLI
// 时失败并报 `posix_spawnp failed`。同时兼容预编译与本机构建两种目录。
if (process.platform === 'darwin') {
  const nodePtyDir = path.join(stage, 'node_modules', 'node-pty')
  for (const helper of [
    path.join(nodePtyDir, 'build', 'Release', 'spawn-helper'),
    path.join(nodePtyDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper')
  ]) {
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
  }
}

// 4) README。
fs.writeFileSync(
  path.join(stage, 'README.md'),
  [
    `# Agent OS 远程节点 ${version} (${platform})`,
    '',
    `已内置 Node ${EXPECTED_NODE_MAJOR}.x ABI ${process.versions.modules} runtime 与原生模块；目标机无需预装 Node/npm。`,
    '通常由主控「远程托管 → 添加节点」生成的一行命令自动下载安装，无需手动操作。',
    '安装后可用 `agentos-cli -h` 查看诊断、状态、启停、更新与 daemon 管理命令。',
    '',
    '安装完成后的手动诊断：',
    '```bash',
    '~/.agent-os-node/agentos-cli doctor',
    '~/.agent-os-node/agentos-cli status',
    '```'
  ].join('\n') + '\n'
)

// 5) 包内文件级完整性清单（manifest 自身不循环哈希）。
function listFiles(directory, base = directory) {
  const result = []
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name)
    const stat = fs.lstatSync(absolute)
    if (stat.isDirectory()) result.push(...listFiles(absolute, base))
    else if (stat.isFile()) {
      const content = fs.readFileSync(absolute)
      result.push({
        path: path.relative(base, absolute).split(path.sep).join('/'),
        bytes: stat.size,
        sha256: crypto.createHash('sha256').update(content).digest('hex')
      })
    }
  }
  return result
}

const runtimeSource = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'types', 'runtime.ts'), 'utf8')
const protocolVersion = Number(/RUNTIME_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(runtimeSource)?.[1] ?? 0)
fs.writeFileSync(path.join(stage, 'runtime-manifest.json'), `${JSON.stringify({
  schemaVersion: 2,
  appVersion: version,
  protocolVersion,
  sourceRevision: releaseProvenance.sourceRevision,
  platform,
  nodeVersion: process.versions.node,
  nodeAbi: process.versions.modules,
  selfContainedNodeRuntime: true,
  nodeExecutable: `runtime/bin/${bundledNodeName}`,
  files: listFiles(stage)
}, null, 2)}\n`)

// 6) 在目标平台、目标 Node ABI 上先做全文件与原生模块冒烟；失败的 stage 不允许打包。
execFileSync(bundledNodePath, [path.join(stage, 'bin', 'verify-node-runtime.cjs'), stage, '--probe-pty'], {
  cwd: stage,
  stdio: 'inherit'
})
execFileSync(bundledNodePath, ['-e', [
  "const Database = require('better-sqlite3')",
  "const db = new Database(':memory:')",
  "db.exec('create table smoke(id integer)')",
  'db.close()'
].join(';')], {
  cwd: stage,
  stdio: 'inherit'
})

// 7) 打包。
fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true })
const tarball = path.join(ROOT, 'release', `agentos-node-${version}-${platform}.tar.gz`)
fs.rmSync(tarball, { force: true })
execFileSync('tar', ['-czf', tarball, '-C', stage, '.'], { stdio: 'inherit' })
cleanupStage()
process.removeListener('exit', cleanupStage)

const sizeMB = (fs.statSync(tarball).size / 1048576).toFixed(1)
console.log(`✓ ${path.relative(ROOT, tarball)} (${sizeMB} MB)`)
