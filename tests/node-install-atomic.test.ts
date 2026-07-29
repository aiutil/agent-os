import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { unixInstallScript } from '../src/main/domains/runtime/node-install-scripts'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function executable(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

function fixture(): {
  root: string
  prefix: string
  backup: string
  asset: string
  mockBin: string
  script: string
} {
  const root = mkdtempSync(join(tmpdir(), 'agentos-atomic-install-'))
  temporaryDirectories.push(root)
  const stage = join(root, 'asset-root')
  const base = 'node $USER $(touch injected) `touch ticked` "quote" \'single\' % 中文'
  const prefix = join(root, base)
  const backup = join(root, `.${base}.previous`)
  const mockBin = join(root, 'mock-bin')
  mkdirSync(join(stage, 'runtime', 'bin'), { recursive: true })
  mkdirSync(join(stage, 'bin'), { recursive: true })
  mkdirSync(join(stage, 'out', 'main'), { recursive: true })
  mkdirSync(join(stage, 'node_modules', 'node-pty'), { recursive: true })
  mkdirSync(prefix, { recursive: true })
  writeFileSync(join(prefix, 'old-marker.txt'), 'old installation')
  writeFileSync(join(prefix, 'sessions.json'), '{"preserved":true}')

  executable(join(stage, 'runtime', 'bin', 'node'), `#!/bin/sh
if [ "$1" = "-p" ]; then
  case "$2" in
    *appVersion*) echo 0.2.9 ;;
    *platform*) echo linux-x64 ;;
    *nodeAbi*) echo 115 ;;
    *protocolVersion*) echo ${RUNTIME_PROTOCOL_VERSION} ;;
    *nodeVersion*) echo 20.17.0 ;;
    *process.versions.modules*) echo 115 ;;
    *process.versions.node*) echo 20.17.0 ;;
    *) exit 2 ;;
  esac
  exit 0
fi
exec "${process.execPath}" "$@"
`)
  writeFileSync(join(stage, 'bin', 'verify-node-runtime.cjs'), readFileSync(join(process.cwd(), 'scripts', 'verify-node-runtime.cjs')))
  writeFileSync(join(stage, 'bin', 'agentos-cli.cjs'), 'process.stdout.write(process.env.AGENT_OS_NODE_PREFIX || "missing")\n')
  writeFileSync(join(stage, 'out', 'main', 'remote-node.js'), 'console.log("node")\n')
  writeFileSync(join(stage, 'node_modules', '.keep'), 'fixture')
  writeFileSync(join(stage, 'node_modules', 'node-pty', 'index.js'), `
const { spawn: spawnChild } = require('node:child_process')
exports.spawn = (file, args, options) => {
  const child = spawnChild(file, args, { cwd: options.cwd, env: options.env })
  const dataListeners = []
  const exitListeners = []
  child.stdout.on('data', (chunk) => dataListeners.forEach((listener) => listener(chunk.toString())))
  child.on('close', (exitCode) => exitListeners.forEach((listener) => listener({ exitCode })))
  return {
    onData(listener) { dataListeners.push(listener) },
    onExit(listener) { exitListeners.push(listener) },
    kill() { child.kill() }
  }
}
`)

  const files = [
    join(stage, 'runtime', 'bin', 'node'),
    join(stage, 'bin', 'verify-node-runtime.cjs'),
    join(stage, 'bin', 'agentos-cli.cjs'),
    join(stage, 'out', 'main', 'remote-node.js'),
    join(stage, 'node_modules', '.keep'),
    join(stage, 'node_modules', 'node-pty', 'index.js')
  ].map((file) => {
    const content = readFileSync(file)
    return {
      path: relative(stage, file).split('\\').join('/'),
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex')
    }
  })
  writeFileSync(join(stage, 'runtime-manifest.json'), JSON.stringify({
    appVersion: '0.2.9',
    platform: 'linux-x64',
    nodeAbi: '115',
    nodeVersion: '20.17.0',
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    nodeExecutable: 'runtime/bin/node',
    files
  }))
  const asset = join(root, 'node.tar.gz')
  expect(spawnSync('tar', ['-czf', asset, '-C', stage, '.']).status).toBe(0)
  const sha256 = createHash('sha256').update(readFileSync(asset)).digest('hex')

  executable(join(mockBin, 'uname'), '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n')
  executable(join(mockBin, 'mv'), `#!/bin/sh
if [ "$FAIL_STAGE_PROMOTION" = "1" ] && [ ! -f "$MV_FAILURE_MARKER" ]; then
  case "$1" in
    *".install."*) touch "$MV_FAILURE_MARKER"; exit 1 ;;
  esac
fi
exec /bin/mv "$@"
`)
  executable(join(mockBin, 'curl'), `#!/bin/sh
case "$*" in
  *"/status"*)
    if [ "$FAIL_MASTER_CONFIRM" = "1" ]; then echo '{"status":"pending"}'
    else echo '{"status":"registered"}'; fi
    exit 0
    ;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; cp "$FAKE_NODE_ASSET" "$1"; exit 0; fi
  shift
done
exit 2
`)
  executable(join(mockBin, 'systemctl'), `#!/bin/sh
case "$*" in
  *"enable --now"*) [ "$FAIL_SYSTEMD_ENABLE" != "1" ] ;;
  *) exit 0 ;;
esac
`)
  executable(join(mockBin, 'loginctl'), '#!/bin/sh\nexit 0\n')

  const script = unixInstallScript({
    httpBase: 'http://127.0.0.1:7430',
    wsUrl: 'wss://127.0.0.1:7431/agent',
    enrollmentToken: 'a'.repeat(64),
    fingerprint: 'AA:BB',
    version: '0.2.9',
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    repo: 'aiutil/agent-os',
    expectedPlatform: 'linux-x64',
    assetSha256: sha256
  })
  return { root, prefix, backup, asset, mockBin, script }
}

function runInstall(
  item: ReturnType<typeof fixture>,
  extraEnv: Record<string, string> = {}
): ReturnType<typeof spawnSync> {
  const home = join(item.root, 'home')
  mkdirSync(home, { recursive: true })
  return spawnSync('sh', [], {
    input: item.script,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      AGENT_OS_NODE_PREFIX: item.prefix,
      FAKE_NODE_ASSET: item.asset,
      PATH: `${item.mockBin}:/usr/local/bin:/usr/bin:/bin`,
      AGENT_OS_ENROLL_WAIT_ATTEMPTS: '1',
      AGENT_OS_ENROLL_WAIT_DELAY: '0',
      ...extraEnv
    }
  })
}

describe('SPEC-032 Unix 节点原子安装', () => {
  it('先在 stage 完整验证，再提升并保留节点数据/上一版', () => {
    const item = fixture()
    const result = runInstall(item)
    if (result.status !== 0) throw new Error(`install failed\n${result.stdout}\n${result.stderr}`)
    expect(existsSync(join(item.prefix, 'runtime', 'bin', 'node'))).toBe(true)
    expect(readFileSync(join(item.prefix, 'sessions.json'), 'utf8')).toContain('preserved')
    expect(readFileSync(join(item.prefix, 'node.env'), 'utf8')).toContain('AGENT_OS_ENROLL_TOKEN=')
    const unit = readFileSync(join(item.root, 'home', '.config', 'systemd', 'user', 'agentos-node.service'), 'utf8')
    const canonicalPrefix = realpathSync(item.prefix)
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('%', '%%')
    expect(unit).toContain('EnvironmentFile="' + canonicalPrefix + '/node.env"')
    expect(unit).toContain('ExecStart="' + canonicalPrefix + '/agentos-node"')
    const cli = spawnSync(join(item.prefix, 'agentos-cli'), ['probe'], {
      cwd: item.root,
      env: { ...process.env, USER: 'expanded-user' },
      encoding: 'utf8'
    })
    expect(cli.status).toBe(0)
    expect(cli.stdout).toBe(realpathSync(item.prefix))
    expect(existsSync(join(item.root, 'injected'))).toBe(false)
    expect(existsSync(join(item.root, 'ticked'))).toBe(false)
    expect(readFileSync(join(item.backup, 'old-marker.txt'), 'utf8')).toBe('old installation')
    expect(result.stdout).toContain('主控已确认节点注册')
  })

  it('守护注册失败时恢复旧安装，不留下混合版本', () => {
    const item = fixture()
    const result = runInstall(item, { FAIL_SYSTEMD_ENABLE: '1' })
    expect(result.status).toBe(1)
    expect(readFileSync(join(item.prefix, 'old-marker.txt'), 'utf8')).toBe('old installation')
    expect(existsSync(join(item.prefix, 'runtime'))).toBe(false)
  })

  it('旧目录已备份但 stage 提升失败时仍恢复旧安装', () => {
    const item = fixture()
    const result = runInstall(item, {
      FAIL_STAGE_PROMOTION: '1',
      MV_FAILURE_MARKER: join(item.root, 'mv-failed-once')
    })
    expect(result.status).toBe(1)
    expect(readFileSync(join(item.prefix, 'old-marker.txt'), 'utf8')).toBe('old installation')
    expect(existsSync(join(item.prefix, 'runtime'))).toBe(false)
    expect(existsSync(item.backup)).toBe(false)
  })

  it('本地守护启动但主控未确认注册时也恢复旧安装', () => {
    const item = fixture()
    const result = runInstall(item, { FAIL_MASTER_CONFIRM: '1' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('主控未在限时内确认节点注册')
    expect(readFileSync(join(item.prefix, 'old-marker.txt'), 'utf8')).toBe('old installation')
    expect(existsSync(join(item.prefix, 'runtime'))).toBe(false)
  })

  it('首次安装未获主控确认时移除新目录和 systemd unit', () => {
    const item = fixture()
    rmSync(item.prefix, { recursive: true, force: true })
    const result = runInstall(item, { FAIL_MASTER_CONFIRM: '1' })
    expect(result.status).toBe(1)
    expect(existsSync(item.prefix)).toBe(false)
    expect(existsSync(join(item.root, 'home', '.config', 'systemd', 'user', 'agentos-node.service'))).toBe(false)
  })
})
