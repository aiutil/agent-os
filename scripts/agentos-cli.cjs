#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, console */
/* Agent OS remote-node maintenance CLI. */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  latestVersion,
  prepareNodeUpdate,
  launchPreparedUpdate
} = require('./node-update.cjs')

const REPO = process.env.AGENT_OS_NODE_REPO || 'aiutil/agent-os'
const PREFIX = path.resolve(process.env.AGENT_OS_NODE_PREFIX || path.join(os.homedir(), '.agent-os-node'))
const ENV_FILE = path.join(PREFIX, 'node.env')
const LOG_FILE = path.join(PREFIX, 'node.log')
const LAUNCHD_LABEL = 'com.lohas.agentos-node'
const SYSTEMD_UNIT = 'agentos-node.service'
const WINDOWS_TASK = 'AgentOSNode'

function printMainHelp() {
  console.log(`agentos-cli <command>

Remote node maintenance commands:
  help, -h, --help       Show this help
  version                Print installed package/runtime versions
  status                 Print daemon and remote-node status
  doctor                 Run local dependency and configuration checks
  config                 Print persisted node.env configuration
  logs [n]               Print the last n log lines (default: 80)
  start                  Start the remote-node daemon
  stop                   Stop the remote-node daemon
  restart                Restart the remote-node daemon
  update [version]       Download and install a newer node package, then restart
  daemon <command>       Manage launchd/systemd/schtasks daemon
  deamon <command>       Compatibility alias for daemon
  remote <command>       Inspect remote host configuration
  docker <command>       Docker helper commands

Common examples:
  agentos-cli doctor
  agentos-cli daemon status
  agentos-cli remote config
  agentos-cli restart
  agentos-cli update v0.2.7
  agentos-cli docker list`)
}

function printDaemonHelp() {
  console.log(`agentos-cli daemon <command>

Daemon commands:
  help                   Show this help
  status                 Show launchd/systemd/task status
  install                Install or refresh daemon registration
  uninstall              Remove daemon registration
  enable                 Enable daemon autostart
  disable                Disable daemon autostart
  start                  Start daemon
  stop                   Stop daemon
  restart                Restart daemon`)
}

function printRemoteHelp() {
  console.log(`agentos-cli remote <command>

Remote commands:
  help                   Show this help
  status                 Print AGENT_OS_HOST reachability context
  config                 Print remote host/token/fingerprint config`)
}

function printDockerHelp() {
  console.log(`agentos-cli docker <command>

Docker helper commands:
  help                   Show this help
  list                   List running containers
  status                 Show docker engine status
  restart <container>    Restart a container by name or id`)
}

function fail(message, code = 1) {
  console.error(`error: ${message}`)
  process.exit(code)
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...(options.env || {}) }
  })
  if (result.error) {
    if (options.optional) return result
    fail(`${cmd}: ${result.error.message}`)
  }
  if (!options.optional && result.status !== 0) {
    fail(`${cmd} exited with ${result.status}`)
  }
  return result
}

function commandExists(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0 ||
    spawnSync('command', ['-v', cmd], { stdio: 'ignore', shell: true }).status === 0
}

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {}
  const entries = {}
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    entries[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return entries
}

function maskValue(key, value) {
  if (!/TOKEN|SECRET|PASSWORD/i.test(key)) return value
  if (!value) return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

function printConfig() {
  const env = readEnvFile()
  console.log(`prefix: ${PREFIX}`)
  console.log(`env: ${ENV_FILE}`)
  if (Object.keys(env).length === 0) {
    console.log('node.env: missing')
    return
  }
  for (const key of Object.keys(env).sort()) {
    console.log(`${key}=${maskValue(key, env[key])}`)
  }
}

function detectPlatform() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch
  if (process.platform === 'darwin') return `mac-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  if (process.platform === 'win32') return `win-${arch}`
  return `${process.platform}-${arch}`
}

function currentVersion() {
  const env = readEnvFile()
  const pkg = path.join(PREFIX, 'package.json')
  let packageVersion = ''
  try {
    packageVersion = JSON.parse(fs.readFileSync(pkg, 'utf8')).version || ''
  } catch {
    // package.json 不是必需状态；优先使用 node.env 中的安装版本。
  }
  return env.AGENT_OS_NODE_VERSION || packageVersion || 'unknown'
}

function printVersion() {
  console.log(`agentos-cli: ${currentVersion()}`)
  console.log(`platform: ${detectPlatform()}`)
  console.log(`node: ${process.version}`)
  console.log(`prefix: ${PREFIX}`)
}

function daemonBackend() {
  if (process.platform === 'darwin') return 'launchd'
  if (process.platform === 'linux' && commandExists('systemctl')) return 'systemd'
  if (process.platform === 'win32') return 'schtasks'
  return 'nohup'
}

function nodeCommandPath() {
  return process.execPath
}

function remoteNodeEntry() {
  return path.join(PREFIX, 'out', 'main', 'remote-node.js')
}

function systemdUnitQuote(value) {
  if (/[\0\r\n]/.test(value)) throw new Error('systemd path contains control characters: ' + value)
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"'
}

function systemdUnit(input = {}) {
  const envFile = input.envFile || ENV_FILE
  const nodeCommand = input.nodeCommand || nodeCommandPath()
  const entry = input.entry || remoteNodeEntry()
  return `[Unit]
Description=Agent OS remote node
After=network-online.target

[Service]
EnvironmentFile=${systemdUnitQuote(envFile)}
ExecStart=${systemdUnitQuote(nodeCommand)} ${systemdUnitQuote(entry)}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
}

function xmlEscape(value) {
  const text = String(value)
  if ([...text].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error('launchd value contains XML control characters')
  }
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function launchdPlist(input = {}) {
  const label = input.label || LAUNCHD_LABEL
  const nodeCommand = input.nodeCommand || nodeCommandPath()
  const entry = input.entry || remoteNodeEntry()
  const logFile = input.logFile || LOG_FILE
  const env = input.env || readEnvFile()
  const environment = Object.entries(env)
    .map(([key, value]) => `<key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(nodeCommand)}</string><string>${xmlEscape(entry)}</string></array>
  <key>EnvironmentVariables</key><dict>${environment}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
</dict></plist>
`
}

function installDaemon() {
  fs.mkdirSync(PREFIX, { recursive: true })
  const backend = daemonBackend()
  if (backend === 'launchd') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    fs.writeFileSync(plist, launchdPlist())
    console.log(`installed launchd plist: ${plist}`)
    return
  }
  if (backend === 'systemd') {
    const dir = path.join(os.homedir(), '.config', 'systemd', 'user')
    const unit = path.join(dir, SYSTEMD_UNIT)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(unit, systemdUnit())
    run('systemctl', ['--user', 'daemon-reload'])
    console.log(`installed systemd unit: ${unit}`)
    return
  }
  if (backend === 'schtasks') {
    const runner = path.join(PREFIX, 'run-node.cmd')
    fs.writeFileSync(runner, '@echo off\r\n:agentos_restart\r\ncall "%~dp0agentos-node.cmd"\r\ntimeout /t 5 /nobreak >nul\r\ngoto agentos_restart\r\n')
    run('schtasks', ['/Create', '/TN', WINDOWS_TASK, '/TR', `"${runner}"`, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'])
    console.log(`installed scheduled task: ${WINDOWS_TASK}`)
    return
  }
  console.log('daemon install skipped: no supported service manager detected')
}

function daemonStatus() {
  const backend = daemonBackend()
  console.log(`backend: ${backend}`)
  if (backend === 'launchd') {
    const uid = process.getuid ? process.getuid() : ''
    run('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`], { optional: true })
    return
  }
  if (backend === 'systemd') {
    run('systemctl', ['--user', 'status', SYSTEMD_UNIT, '--no-pager'], { optional: true })
    return
  }
  if (backend === 'schtasks') {
    run('schtasks', ['/Query', '/TN', WINDOWS_TASK], { optional: true })
    return
  }
  console.log('status: unmanaged')
}

function daemonStart() {
  const backend = daemonBackend()
  if (backend === 'launchd') run('launchctl', ['load', path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)], { optional: true })
  else if (backend === 'systemd') run('systemctl', ['--user', 'start', SYSTEMD_UNIT])
  else if (backend === 'schtasks') run('schtasks', ['/Run', '/TN', WINDOWS_TASK])
  else startNohup()
}

function daemonStop() {
  const backend = daemonBackend()
  if (backend === 'launchd') run('launchctl', ['unload', path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)], { optional: true })
  else if (backend === 'systemd') run('systemctl', ['--user', 'stop', SYSTEMD_UNIT])
  else if (backend === 'schtasks') run('schtasks', ['/End', '/TN', WINDOWS_TASK], { optional: true })
  else console.log('stop: unmanaged daemon; stop the node process manually')
}

function daemonEnable() {
  const backend = daemonBackend()
  if (backend === 'launchd') daemonStart()
  else if (backend === 'systemd') run('systemctl', ['--user', 'enable', SYSTEMD_UNIT])
  else if (backend === 'schtasks') run('schtasks', ['/Change', '/TN', WINDOWS_TASK, '/ENABLE'])
  else console.log('enable: unmanaged daemon')
}

function daemonDisable() {
  const backend = daemonBackend()
  if (backend === 'launchd') daemonStop()
  else if (backend === 'systemd') run('systemctl', ['--user', 'disable', SYSTEMD_UNIT])
  else if (backend === 'schtasks') run('schtasks', ['/Change', '/TN', WINDOWS_TASK, '/DISABLE'])
  else console.log('disable: unmanaged daemon')
}

function daemonUninstall() {
  daemonStop()
  const backend = daemonBackend()
  if (backend === 'launchd') {
    fs.rmSync(path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`), { force: true })
  } else if (backend === 'systemd') {
    run('systemctl', ['--user', 'disable', SYSTEMD_UNIT], { optional: true })
    fs.rmSync(path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT), { force: true })
    run('systemctl', ['--user', 'daemon-reload'], { optional: true })
  } else if (backend === 'schtasks') {
    run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F'], { optional: true })
  }
}

function startNohup() {
  const env = readEnvFile()
  const out = fs.openSync(LOG_FILE, 'a')
  const child = require('node:child_process').spawn(nodeCommandPath(), [remoteNodeEntry()], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...env }
  })
  child.unref()
  console.log(`started pid: ${child.pid}`)
}

function printStatus() {
  printVersion()
  console.log('')
  daemonStatus()
}

function doctor() {
  const checks = [
    ['prefix exists', fs.existsSync(PREFIX)],
    ['node.env exists', fs.existsSync(ENV_FILE)],
    ['remote-node entry exists', fs.existsSync(remoteNodeEntry())],
    ['Node.js >= 18', Number(process.versions.node.split('.')[0]) >= 18]
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'ok' : 'fail'} - ${name}`)
    if (!pass) ok = false
  }
  const env = readEnvFile()
  for (const key of ['AGENT_OS_HOST', 'AGENT_OS_HOST_FP']) {
    const pass = Boolean(env[key])
    console.log(`${pass ? 'ok' : 'fail'} - ${key}`)
    if (!pass) ok = false
  }
  const credentialReady = Boolean(env.AGENT_OS_NODE_TOKEN || env.AGENT_OS_ENROLL_TOKEN)
  console.log(`${credentialReady ? 'ok' : 'fail'} - node credential`)
  if (!credentialReady) ok = false
  process.exit(ok ? 0 : 1)
}

function logs(linesArg) {
  const lines = Number(linesArg || 80)
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`log missing: ${LOG_FILE}`)
    return
  }
  const content = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/)
  console.log(content.slice(-Math.max(1, lines)).join('\n'))
}

async function update(versionArg) {
  const version = versionArg || await latestVersion(REPO)
  console.log(`preparing verified node update: v${String(version).replace(/^v/, '')} (${detectPlatform()})`)
  const plan = await prepareNodeUpdate({
    repo: REPO,
    version,
    platform: detectPlatform(),
    prefix: PREFIX
  })
  console.log(`verified archive and staged runtime: ${plan.sourceRevision}`)
  const launched = launchPreparedUpdate(plan)
  console.log(`external atomic updater started (pid ${launched.pid}); waiting for this CLI to exit`)
  console.log('the updater will roll back unless the controller acknowledges the new Runtime/PTY/Agent probes')
}

function docker(command, rest) {
  if (command === 'help' || !command) return printDockerHelp()
  if (!commandExists('docker')) fail('docker is not installed or not on PATH')
  if (command === 'list') return run('docker', ['ps'])
  if (command === 'status') return run('docker', ['info'])
  if (command === 'restart') {
    if (!rest[0]) fail('docker restart requires a container name or id')
    return run('docker', ['restart', rest[0]])
  }
  fail(`unknown docker command: ${command}`)
}

function daemon(command) {
  switch (command || 'help') {
    case 'help': return printDaemonHelp()
    case 'status': return daemonStatus()
    case 'install': return installDaemon()
    case 'uninstall': return daemonUninstall()
    case 'enable': return daemonEnable()
    case 'disable': return daemonDisable()
    case 'start': return daemonStart()
    case 'stop': return daemonStop()
    case 'restart': daemonStop(); return daemonStart()
    default: fail(`unknown daemon command: ${command}`)
  }
}

function remote(command) {
  if (command === 'help' || !command) return printRemoteHelp()
  if (command === 'config') return printConfig()
  if (command === 'status') {
    const env = readEnvFile()
    console.log(`host: ${env.AGENT_OS_HOST || 'missing'}`)
    console.log(`fingerprint: ${env.AGENT_OS_HOST_FP || 'missing'}`)
    return
  }
  fail(`unknown remote command: ${command}`)
}

async function main(argv) {
  const [cmd, sub, ...rest] = argv
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') return printMainHelp()
  if (cmd === 'version') return printVersion()
  if (cmd === 'status') return printStatus()
  if (cmd === 'doctor') return doctor()
  if (cmd === 'config') return printConfig()
  if (cmd === 'logs') return logs(sub)
  if (cmd === 'start') return daemonStart()
  if (cmd === 'stop') return daemonStop()
  if (cmd === 'restart') { daemonStop(); return daemonStart() }
  if (cmd === 'update') return await update(sub)
  if (cmd === 'daemon' || cmd === 'deamon') return daemon(sub)
  if (cmd === 'remote') return remote(sub)
  if (cmd === 'docker') return docker(sub, rest)
  fail(`unknown command: ${cmd}`)
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch((error) => {
    fail(error instanceof Error ? error.message : String(error))
  })
}

module.exports = { launchdPlist, systemdUnit, systemdUnitQuote, xmlEscape }
