import { createRequire } from 'node:module'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'

const require = createRequire(import.meta.url)
const {
  validateReleaseMetadata,
  unixBootstrap,
  powershellBootstrap
} = require('../scripts/node-update.cjs') as {
  validateReleaseMetadata(input: Record<string, unknown>): { entry: { sha256: string } }
  unixBootstrap(plan: UpdatePlan, parentPid: number, scriptPath: string): string
  powershellBootstrap(plan: UpdatePlan, parentPid: number, scriptPath: string): string
}

interface UpdatePlan {
  prefix: string
  stage: string
  version: string
  platform: string
  protocolVersion: number
  sourceRevision: string
  preparedAtMs: number
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function releaseFixture() {
  const version = '0.3.0'
  const platform = 'linux-x64'
  const assetName = `agentos-node-${version}-${platform}.tar.gz`
  const provenance = {
    schemaVersion: 1,
    version,
    sourceRevision: 'a'.repeat(40),
    sourceTreeClean: true,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    installNodeSha256: 'b'.repeat(64)
  }
  const runtime = {
    selfContainedNodeRuntime: true,
    appVersion: version,
    platform,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    sourceRevision: provenance.sourceRevision,
    nodeVersion: '20.17.0',
    nodeAbi: '115',
    files: [{ path: 'runtime/bin/node', bytes: 1, sha256: 'c'.repeat(64) }]
  }
  const manifest = {
    version,
    provenance,
    assets: [{
      name: assetName,
      sha256: 'd'.repeat(64),
      fileIntegrityVerified: true,
      runtime
    }]
  }
  return { version, platform, assetName, provenance, runtime, manifest }
}

function executable(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  chmodSync(file, 0o755)
}

function updatePlan(root: string): UpdatePlan {
  return {
    prefix: join(root, 'node'),
    stage: join(root, '.node.update-stage'),
    version: '0.3.0',
    platform: 'linux-x64',
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    sourceRevision: 'a'.repeat(40),
    preparedAtMs: Date.now() - 1_000
  }
}

function runUnixBootstrap(failAck = false, missingRuntimeEntry = false) {
  const root = mkdtempSync(join(tmpdir(), 'agentos-node-update-test-'))
  temporaryDirectories.push(root)
  const plan = updatePlan(root)
  const mockBin = join(root, 'bin')
  const script = join(root, 'update.sh')
  mkdirSync(plan.prefix)
  mkdirSync(join(plan.stage, 'runtime', 'bin'), { recursive: true })
  mkdirSync(join(plan.stage, 'out', 'main'), { recursive: true })
  mkdirSync(join(plan.stage, 'bin'), { recursive: true })
  symlinkSync(process.execPath, join(plan.stage, 'runtime', 'bin', 'node'))
  if (!missingRuntimeEntry) {
    writeFileSync(join(plan.stage, 'out', 'main', 'remote-node.js'), 'console.log("node")\n')
  }
  writeFileSync(join(plan.stage, 'bin', 'agentos-cli.cjs'), 'console.log("cli")\n')
  writeFileSync(join(plan.prefix, 'old-marker'), 'old')
  writeFileSync(join(plan.prefix, 'node.env'), [
    'AGENT_OS_HOST=wss://127.0.0.1:7431/agent',
    `AGENT_OS_NODE_TOKEN=${'e'.repeat(64)}`,
    'AGENT_OS_NODE_VERSION=0.2.9'
  ].join('\n'))
  writeFileSync(join(plan.stage, 'new-marker'), 'new')
  executable(join(mockBin, 'systemctl'), `#!/bin/sh
case "$*" in
  *" start "*)
    [ -x "$AGENTOS_TEST_PREFIX/agentos-node" ] || exit 9
    [ -x "$AGENTOS_TEST_PREFIX/agentos-cli" ] || exit 10
    if [ "$AGENTOS_TEST_FAIL_ACK" != "1" ]; then
      cat > "$AGENTOS_TEST_PREFIX/node-status.json" <<EOF
{"state":"connected","hostVersion":"$AGENTOS_TEST_VERSION","protocolVersion":$AGENTOS_TEST_PROTOCOL,"updatedAt":"$AGENTOS_TEST_NOW","adoptedAt":"$AGENTOS_TEST_NOW"}
EOF
    fi
    ;;
esac
exit 0
`)
  writeFileSync(script, unixBootstrap(plan, 999_999, script))
  chmodSync(script, 0o700)
  const now = new Date().toISOString()
  const result = spawnSync('sh', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${mockBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      AGENTOS_TEST_PREFIX: plan.prefix,
      AGENTOS_TEST_VERSION: plan.version,
      AGENTOS_TEST_PROTOCOL: String(plan.protocolVersion),
      AGENTOS_TEST_NOW: now,
      AGENTOS_TEST_FAIL_ACK: failAck ? '1' : '0',
      AGENT_OS_UPDATE_WAIT_ATTEMPTS: '1',
      AGENT_OS_UPDATE_WAIT_DELAY: '0'
    }
  })
  return { root, plan, script, result }
}

describe('SPEC-032 原子节点升级', () => {
  it('只接受同源、同协议且带全文件证据的 Release 元数据', () => {
    const item = releaseFixture()
    expect(validateReleaseMetadata(item).entry.sha256).toBe('d'.repeat(64))
    expect(() => validateReleaseMetadata({
      ...item,
      manifest: {
        ...item.manifest,
        assets: [{
          ...item.manifest.assets[0],
          runtime: { ...item.runtime, protocolVersion: RUNTIME_PROTOCOL_VERSION - 1 }
        }]
      }
    })).toThrow('complete verified runtime')
    expect(() => validateReleaseMetadata({
      ...item,
      provenance: { ...item.provenance, sourceTreeClean: false }
    })).toThrow('provenance')
  })

  it('Unix 外部 bootstrap 退出旧 CLI 后原子提升，并等待主控 ACK', () => {
    const { plan, script, result } = runUnixBootstrap()
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`)
    expect(readFileSync(join(plan.prefix, 'new-marker'), 'utf8')).toBe('new')
    expect(readFileSync(join(dirname(plan.prefix), '.node.previous', 'old-marker'), 'utf8')).toBe('old')
    expect(readFileSync(join(plan.prefix, 'node.env'), 'utf8')).toContain('AGENT_OS_NODE_VERSION=0.3.0')
    const nodeWrapper = readFileSync(join(plan.prefix, 'agentos-node'), 'utf8')
    const cliWrapper = readFileSync(join(plan.prefix, 'agentos-cli'), 'utf8')
    expect(nodeWrapper).toContain('$AGENT_OS_NODE_PREFIX/out/main/remote-node.js" "$@"')
    expect(cliWrapper).toContain('$AGENT_OS_NODE_PREFIX/bin/agentos-cli.cjs" "$@"')
    expect(nodeWrapper).toContain('$(dirname "$0")')
    expect(nodeWrapper).not.toContain('export AGENT_OS_NODE_PREFIX="' + plan.prefix + '"')
    expect(existsSync(script)).toBe(false)
  })

  it('新版本未收到主控 ACK 时删除新目录并恢复上一版', () => {
    const { plan, script, result } = runUnixBootstrap(true)
    expect(result.status).toBe(1)
    expect(readFileSync(join(plan.prefix, 'old-marker'), 'utf8')).toBe('old')
    expect(existsSync(join(plan.prefix, 'new-marker'))).toBe(false)
    expect(readFileSync(join(plan.prefix, 'node.env'), 'utf8')).toContain('AGENT_OS_NODE_VERSION=0.2.9')
    expect(result.stderr).toContain('已恢复上一版')
    expect(existsSync(script)).toBe(false)
  })

  it('升级包缺少守护入口时在提升前拒绝并保留旧安装', () => {
    const { plan, result } = runUnixBootstrap(false, true)
    expect(result.status).toBe(1)
    expect(readFileSync(join(plan.prefix, 'old-marker'), 'utf8')).toBe('old')
    expect(existsSync(join(plan.prefix, 'new-marker'))).toBe(false)
    expect(result.stderr).toContain('升级包缺少远程节点入口')
  })

  it('Windows bootstrap 也等待父进程退出、检查 ACK 并具备失败回滚', () => {
    const plan = updatePlan('C:\\agentos-test')
    const script = powershellBootstrap(plan, 1234, 'C:\\Temp\\agentos-update.ps1')
    expect(script).toContain('Wait-Process -Id $ParentPid')
    expect(script).toContain('Move-Item $Prefix $Backup')
    expect(script).toContain('$Status.state -eq "connected"')
    expect(script).toContain('$Status.hostVersion -eq $Version')
    expect(script).toContain('$Status.protocolVersion')
    expect(script).toContain('$Status.adoptedAt')
    expect(script).toContain('$StageNodeCmd = Join-Path $Stage "agentos-node.cmd"')
    expect(script).toContain('$StageRunner = Join-Path $Stage "run-node.cmd"')
    expect(script).toContain(':agentos_restart')
    expect(script).toContain('goto agentos_restart')
    expect(script).toContain('set "AGENT_OS_NODE_PREFIX=%~dp0"')
    expect(script).toContain('call "%~dp0agentos-node.cmd"')
    expect(script).toContain('Move-Item $Backup $Prefix')
    expect(script).not.toContain('tar -xzf')
  })
})
