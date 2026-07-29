import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  oneLiners,
  powershellInstallScript,
  unixInstallScript
} from '../src/main/domains/runtime/node-install-scripts'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'

const params = {
  httpBase: 'http://192.168.1.20:7430',
  wsUrl: 'wss://192.168.1.20:7431/agent',
  enrollmentToken: 'a'.repeat(64),
  fingerprint: 'AA:BB',
  version: '0.2.9',
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  repo: 'aiutil/agent-os',
  expectedPlatform: 'linux-x64',
  assetSha256: 'b'.repeat(64)
}

describe('SPEC-032 一键脚本制品与 ABI 门禁', () => {
  it('复制命令先校验桌面锚定的脚本 SHA，再执行临时文件', () => {
    const commands = oneLiners(params)
    const unixDigest = createHash('sha256').update(unixInstallScript(params), 'utf8').digest('hex')
    const powershellDigest = createHash('sha256').update(powershellInstallScript(params), 'utf8').digest('hex')

    expect(commands.unix).toContain(unixDigest)
    expect(commands.unix).toContain('sha256sum')
    expect(commands.unix).toContain('shasum -a 256')
    expect(commands.unix).toContain('curl -fsSL')
    expect(commands.unix).toContain('-o "$agentos_enroll_tmp"')
    expect(commands.unix).toContain('sh "$agentos_enroll_tmp"')
    expect(commands.unix).not.toContain('| sh')
    expect(spawnSync('sh', ['-n'], { input: commands.unix, encoding: 'utf8' }).status).toBe(0)

    expect(commands.powershell).toContain(powershellDigest)
    expect(commands.powershell).toContain('Get-FileHash -Algorithm SHA256')
    expect(commands.powershell).toContain('[scriptblock]::Create')
    expect(commands.powershell).toContain('Remove-Item $AgentOsEnrollPath')
    expect(commands.powershell).not.toContain('| iex')
  })

  it('Unix 复制命令拒绝被替换的明文 HTTP 脚本且清理临时文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-enroll-command-'))
    try {
      const mockBin = join(root, 'bin')
      const temp = join(root, 'tmp')
      const tampered = join(root, 'tampered.sh')
      const executed = join(root, 'executed')
      mkdirSync(mockBin)
      mkdirSync(temp)
      writeFileSync(tampered, `#!/bin/sh\ntouch '${executed}'\n`)
      const curl = join(mockBin, 'curl')
      writeFileSync(curl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; cp "$AGENTOS_TEST_ENROLL_BODY" "$1"; exit 0; fi
  shift
done
exit 2
`)
      chmodSync(curl, 0o755)

      const result = spawnSync('sh', ['-c', oneLiners(params).unix], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTOS_TEST_ENROLL_BODY: tampered,
          PATH: `${mockBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          TMPDIR: temp
        }
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('安装脚本 SHA-256 校验失败')
      expect(existsSync(executed)).toBe(false)
      expect(readdirSync(temp)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('Unix 脚本绑定目标平台、校验 SHA，并只用包内 Node runtime', () => {
    const script = unixInstallScript(params)
    expect(script).toContain('EXPECTED_PLATFORM="linux-x64"')
    expect(script).toContain(`EXPECTED_SHA256="${'b'.repeat(64)}"`)
    expect(script).toContain('制品 SHA-256 校验失败')
    expect(script).toContain('RUNTIME_NODE="$PREFIX/runtime/bin/node"')
    expect(script).toContain('Node ABI 不一致')
    expect(script).toContain('bin/verify-node-runtime.cjs')
    expect(script).toContain('"$INSTALL_ROOT" --probe-pty')
    expect(script).toContain('AGENT_OS_ENROLL_TOKEN=$ENROLL_TOKEN')
    expect(script).not.toContain('AGENT_OS_NODE_TOKEN=')
    // 这里断言的是“安装器中的 heredoc”，因此变量必须保留一层转义；
    // heredoc 执行后写出的最终 wrapper 才应包含可运行的未转义 $()/变量引用。
    expect(script).toContain('AGENT_OS_NODE_PREFIX="\\$(CDPATH= cd -P "\\$(dirname "\\$0")" && pwd -P)"')
    expect(script).toContain('. "\\$AGENT_OS_NODE_PREFIX/node.env"')
    expect(script).toContain('"\\$AGENT_OS_NODE_PREFIX/out/main/remote-node.js" "\\$@"')
    expect(script).not.toContain('export AGENT_OS_NODE_PREFIX="$PREFIX"')
    expect(script).not.toContain('command -v node')
    expect(script).not.toContain('npm install')
    expect(script).not.toContain('nohup sh -c')
    expect(script).toContain('INSTALL_ROOT=')
    expect(script).toContain('PROMOTED=1')
    expect(script).toContain('INSTALL_SUCCEEDED=1')
    expect(script).toContain('if [ "$INSTALL_SUCCEEDED" -ne 1 ] && [ "$status" -eq 0 ]')
    expect(script).toContain('mv "$INSTALL_ROOT" "$PREFIX"')
    expect(script).toContain('/enroll/aaaaaaaaaaaa/status')
    expect(script).toContain('Authorization: Bearer $ENROLL_TOKEN')
    expect(script).toContain('主控已确认节点注册')
    expect(spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0)
  })

  it('PowerShell 脚本拒绝平台不符、校验 SHA，并要求 win 原生自包含包', () => {
    const script = powershellInstallScript({ ...params, expectedPlatform: 'win-x64' })
    expect(script).toContain('$ExpectedPlatform = "win-x64"')
    expect(script).toContain('Get-FileHash -Algorithm SHA256')
    expect(script).toContain('runtime\\bin\\node.exe')
    expect(script).toContain('制品缺少 Windows 预编译运行时依赖')
    expect(script).toContain('bin\\verify-node-runtime.cjs')
    expect(script).toContain('$InstallRoot --probe-pty')
    expect(script).toContain('AGENT_OS_ENROLL_TOKEN=$EnrollToken')
    expect(script).not.toContain('AGENT_OS_NODE_TOKEN=')
    expect(script).toContain('for /f "usebackq tokens=1,* delims=="')
    expect(script).not.toContain('npm install')
    expect(script).toContain('$InstallRoot = Join-Path $Parent')
    expect(script).toContain('$Promoted = $true')
    expect(script).toContain('$OldMoved = $true')
    expect(script).toContain('$TaskExistedBefore = $LASTEXITCODE -eq 0')
    expect(script).toContain('Move-Item $InstallRoot $Prefix')
    expect(script).toContain('/enroll/aaaaaaaaaaaa/status')
    expect(script).toContain('Authorization = "Bearer $EnrollToken"')
    expect(script).toContain('主控已确认节点注册')
    expect(script).toContain('if ($Promoted) {')
    expect(script).toContain('if ($OldMoved -and (Test-Path $Backup))')
    expect(script).toContain('Move-Item $Backup $Prefix')
    expect(script).toContain('schtasks /Delete /TN $TaskName /F')
    expect(script).toContain('throw "计划任务创建失败"')
    expect(script).toContain('throw "计划任务启动失败"')
    expect(script).toContain(':agentos_restart')
    expect(script).toContain('timeout /t 5 /nobreak >nul')
    expect(script).toContain('goto agentos_restart')
    expect(script).toContain('set "AGENT_OS_NODE_PREFIX=%~dp0"')
    expect(script).toContain('call "%~dp0agentos-node.cmd"')
    expect(script).not.toContain('call "$Prefix\\agentos-node.cmd"')
    expect(script).toContain('} finally {')
    expect(script).not.toContain('tar -xzf $tmp -C $Prefix')
  })

  it('macOS launchd plist 使用包内 Node 转义特殊路径后再写 XML', () => {
    const script = unixInstallScript({ ...params, expectedPlatform: 'mac-arm64' })
    expect(script).toContain('PLIST_PREFIX=$("$RUNTIME_NODE" -e')
    expect(script).toContain('replaceAll("&","&amp;")')
    expect(script).toContain('<string>$PLIST_PREFIX/agentos-node</string>')
    expect(script).not.toContain('<string>$PREFIX/agentos-node</string>')
    expect(spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0)
  })
})
