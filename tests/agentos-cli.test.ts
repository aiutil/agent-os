import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(__dirname, '..')
const CLI = join(ROOT, 'scripts', 'agentos-cli.cjs')
const require = createRequire(import.meta.url)
const { launchdPlist, systemdUnit, systemdUnitQuote, xmlEscape } = require(CLI) as {
  launchdPlist(input: {
    label: string
    nodeCommand: string
    entry: string
    logFile: string
    env: Record<string, string>
  }): string
  systemdUnit(input: { envFile: string; nodeCommand: string; entry: string }): string
  systemdUnitQuote(value: string): string
  xmlEscape(value: string): string
}

function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
}

describe('agentos-cli remote node operations', () => {
  it('prints a help surface for node maintenance commands', () => {
    const result = runCli(['-h'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('agentos-cli <command>')
    expect(result.stdout).toContain('doctor')
    expect(result.stdout).toContain('daemon status')
    expect(result.stdout).toContain('remote config')
    expect(result.stdout).toContain('docker list')
  })

  it('prints persisted remote node configuration without leaking token', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'agentos-cli-test-'))
    writeFileSync(
      join(prefix, 'node.env'),
      [
        'AGENT_OS_HOST=wss://192.168.1.20:7430/agent',
        'AGENT_OS_NODE_TOKEN=super-secret-token',
        'AGENT_OS_HOST_FP=AA:BB:CC',
        'AGENT_OS_NODE_VERSION=0.2.5'
      ].join('\n')
    )

    const result = runCli(['config'], { AGENT_OS_NODE_PREFIX: prefix })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`prefix: ${prefix}`)
    expect(result.stdout).toContain('AGENT_OS_HOST=wss://192.168.1.20:7430/agent')
    expect(result.stdout).toContain('AGENT_OS_NODE_TOKEN=supe…oken')
    expect(result.stdout).not.toContain('super-secret-token')
    expect(result.stdout).toContain('AGENT_OS_NODE_VERSION=0.2.5')
  })

  it('accepts deamon as a compatibility alias for daemon help', () => {
    const result = runCli(['deamon', 'help'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('agentos-cli daemon <command>')
    expect(result.stdout).toContain('install')
    expect(result.stdout).toContain('disable')
  })

  it('systemd unit 正确引用含空格、百分号和中文的安装路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-cli-systemd-test-'))
    const prefix = join(root, 'node with % 中文')
    const unit = systemdUnit({
      envFile: join(prefix, 'node.env'),
      nodeCommand: join(prefix, 'runtime', 'bin', 'node'),
      entry: join(prefix, 'out', 'main', 'remote-node.js')
    })

    expect(unit).toContain('EnvironmentFile="' + join(prefix, 'node.env').replace('%', '%%') + '"')
    expect(unit).toContain('ExecStart="' + join(prefix, 'runtime', 'bin', 'node').replace('%', '%%') + '" "' + join(prefix, 'out', 'main', 'remote-node.js').replace('%', '%%') + '"')
  })

  it('systemd 路径转义反斜杠、双引号与 specifier，并拒绝控制字符', () => {
    expect(systemdUnitQuote('/tmp/a\\b"c%d')).toBe('"/tmp/a\\\\b\\"c%%d"')
    expect(() => systemdUnitQuote('/tmp/a\nnode')).toThrow('control characters')
  })

  it('launchd plist 转义路径、环境键值与 XML 特殊字符', () => {
    const plist = launchdPlist({
      label: 'Agent & <Node>',
      nodeCommand: '/Users/张三/A & B/"runtime"/node',
      entry: "/Users/张三/A & B/'entry'.js",
      logFile: '/Users/张三/A & B/node.log',
      env: { 'KEY&': 'a<b>c"d\'e' }
    })

    expect(plist).toContain('<string>Agent &amp; &lt;Node&gt;</string>')
    expect(plist).toContain('/Users/张三/A &amp; B/&quot;runtime&quot;/node')
    expect(plist).toContain('<key>KEY&amp;</key><string>a&lt;b&gt;c&quot;d&apos;e</string>')
    expect(plist).not.toContain('A & B')
    expect(() => xmlEscape('bad\u0001value')).toThrow('XML control characters')
    if (process.platform === 'darwin') {
      const lint = spawnSync('plutil', ['-lint', '-'], { input: plist, encoding: 'utf8' })
      expect(lint.status).toBe(0)
    }
  })
})
