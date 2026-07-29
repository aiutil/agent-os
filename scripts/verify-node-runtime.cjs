#!/usr/bin/env node
// SPEC-032：验证已解包节点 runtime 的文件级 SHA-256 完整性。

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const prefix = path.resolve(process.argv[2] || process.cwd())
const manifestPath = path.join(prefix, 'runtime-manifest.json')
const probePty = process.argv.includes('--probe-pty')

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!fs.existsSync(manifestPath)) fail('制品缺少 runtime-manifest.json')
let manifest
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch (error) {
  fail(`runtime manifest 无法解析：${error.message}`)
}
if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('runtime manifest 缺少文件完整性清单')

for (const item of manifest.files) {
  if (!item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256 || '')) {
    fail('runtime manifest 包含无效文件记录')
  }
  const absolute = path.resolve(prefix, item.path)
  const relative = path.relative(prefix, absolute)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`非法文件路径：${item.path}`)
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) fail(`制品文件缺失：${item.path}`)
  const content = fs.readFileSync(absolute)
  if (content.length !== item.bytes) fail(`制品文件大小不一致：${item.path}`)
  const actual = crypto.createHash('sha256').update(content).digest('hex')
  if (actual.toLowerCase() !== item.sha256.toLowerCase()) fail(`制品文件校验失败：${item.path}`)
}

console.log(`✓ runtime 文件完整性通过（${manifest.files.length} 个文件）`)

if (probePty) {
  const executableRelative = manifest.nodeExecutable
  if (typeof executableRelative !== 'string' || !executableRelative) fail('runtime manifest 缺少 nodeExecutable')
  const executable = path.resolve(prefix, executableRelative)
  const executableFromRoot = path.relative(prefix, executable)
  if (executableFromRoot.startsWith('..') || path.isAbsolute(executableFromRoot)) {
    fail(`非法 Node 入口路径：${executableRelative}`)
  }
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) fail('制品缺少包内 Node 入口')

  let pty
  try {
    pty = require(path.join(prefix, 'node_modules', 'node-pty'))
  } catch (error) {
    fail(`node-pty 无法加载：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof pty?.spawn !== 'function') fail('node-pty 未提供 spawn')

  const nonce = `AGENT_OS_PTY_PROBE_${crypto.randomBytes(12).toString('hex')}`
  let output = ''
  let settled = false
  const finish = (ok, message) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (!ok) fail(message)
    console.log('✓ node-pty 真实子进程回显通过')
    // Windows ConPTY may retain an internal handle after onExit. The probe has
    // completed all assertions, so terminate explicitly instead of hanging the
    // parent packaging step until its job timeout.
    process.exit(0)
  }
  let child
  try {
    child = pty.spawn(executable, ['-e', `process.stdout.write(${JSON.stringify(nonce)})`], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: prefix,
      env: Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'))
    })
  } catch (error) {
    fail(`node-pty 无法创建子进程：${error instanceof Error ? error.message : String(error)}`)
  }
  const timer = setTimeout(() => {
    try { child.kill() } catch { /* 已经退出 */ }
    finish(false, 'node-pty 子进程回显超时')
  }, 10_000)
  child.onData((data) => { output += data })
  child.onExit(({ exitCode }) => {
    // node-pty 在部分平台会先上报 exit、再冲刷最后一段 onData；延后一拍再判断回显。
    setImmediate(() => {
      finish(exitCode === 0 && output.includes(nonce),
        exitCode === 0
          ? `node-pty 子进程未返回预期内容（收到 ${JSON.stringify(output.slice(-200))}）`
          : `node-pty 子进程异常退出：${exitCode}`)
    })
  })
}
