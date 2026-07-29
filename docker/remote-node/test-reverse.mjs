// SPEC-032 Docker E2E: run the exact SHA-anchored desktop one-liner against a
// real enroll/status HTTP endpoint, install the real self-contained tarball,
// exchange the short enrollment ticket over pinned WSS, adopt the node, then
// create real remote CLI sessions and exercise bidirectional PTY I/O.
/* global process, Buffer, clearTimeout, setTimeout, setInterval, clearInterval, console, URL */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import selfsigned from 'selfsigned'

const HTTP_PORT = 17430
const WSS_PORT = 17431
const EXPECTED_PROTOCOL_VERSION = 10
const ENROLLMENT_TOKEN = 'a1'.repeat(32)
const LONG_NODE_TOKEN = 'b2'.repeat(32)
const ENROLL_ID = ENROLLMENT_TOKEN.slice(0, 12)
const IMAGE = process.env.AGENT_OS_NODE_TEST_IMAGE || 'agentos-node-reverse-test'
const ARCHIVE = process.env.AGENT_OS_NODE_TEST_ARCHIVE
const EXPECTED_PLATFORM = process.env.AGENT_OS_NODE_TEST_PLATFORM
const EXPECTED_VERSION = process.env.AGENT_OS_NODE_TEST_VERSION
const CONTAINER_NAME = `agentos-one-click-e2e-${process.pid}`

if (!ARCHIVE || !EXPECTED_PLATFORM || !EXPECTED_VERSION) {
  throw new Error('缺少 AGENT_OS_NODE_TEST_ARCHIVE/PLATFORM/VERSION')
}

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'agentos-one-click-e2e-'))
const pems = selfsigned.generate([{ name: 'commonName', value: 'agent-os-docker-test' }], {
  days: 1,
  keySize: 2048,
  algorithm: 'sha256'
})
const certDer = Buffer.from(pems.cert.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64')
const fingerprint = createHash('sha256')
  .update(certDer)
  .digest('hex')
  .toUpperCase()
  .match(/../g)
  .join(':')
const assetSha256 = createHash('sha256').update(readFileSync(ARCHIVE)).digest('hex')

writeFileSync(join(fixtureDirectory, 'config.json'), JSON.stringify({
  httpBase: `http://host.docker.internal:${HTTP_PORT}`,
  wsUrl: `wss://host.docker.internal:${WSS_PORT}/agent`,
  enrollmentToken: ENROLLMENT_TOKEN,
  fingerprint,
  version: EXPECTED_VERSION,
  protocolVersion: EXPECTED_PROTOCOL_VERSION,
  repo: 'aiutil/agent-os',
  expectedPlatform: EXPECTED_PLATFORM,
  assetSha256
}))
execFileSync(resolve('node_modules/.bin/vite-node'), [
  'scripts/render-node-enroll-fixture.ts',
  join(fixtureDirectory, 'config.json'),
  fixtureDirectory
], { stdio: 'inherit' })
const installScript = readFileSync(join(fixtureDirectory, 'install.sh'))

let docker = null
let httpServer = null
let httpsServer = null
let timedOut = false
let cleaning = false
let dockerOutput = ''
let activeSocket = null
let tokenConfirmed = false
let adopted = false

const timeout = setTimeout(() => {
  timedOut = true
  fail('等待一行命令安装、节点采纳与远程 PTY 验收超时')
}, 90_000)

function closeServer(server) {
  if (!server) return Promise.resolve()
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

async function cleanup(code) {
  if (cleaning) return
  cleaning = true
  clearTimeout(timeout)
  activeSocket?.terminate()
  try {
    execFileSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  } catch {
    // 容器可能尚未创建，或已因启动失败自行退出。
  }
  if (docker && !docker.killed) docker.kill('SIGKILL')
  await Promise.race([
    Promise.all([closeServer(httpServer), closeServer(httpsServer)]),
    new Promise((resolveClose) => setTimeout(resolveClose, 2_000))
  ])
  rmSync(fixtureDirectory, { recursive: true, force: true })
  process.exit(code)
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  if (dockerOutput) console.error(`docker output:\n${dockerOutput.slice(-8000)}`)
  void cleanup(1)
}

function waitFor(predicate, message, duration = 12_000) {
  return new Promise((resolveWait, reject) => {
    const deadline = Date.now() + duration
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolveWait()
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error(message))
      }
    }, 50)
  })
}

httpServer = createHttpServer((request, response) => {
  if (request.method === 'GET' && request.url === `/enroll/${ENROLL_ID}`) {
    response.writeHead(200, {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'content-length': String(installScript.length)
    })
    response.end(installScript)
    return
  }
  if (request.method === 'GET' && request.url === `/enroll/${ENROLL_ID}/status`) {
    if (request.headers.authorization !== `Bearer ${ENROLLMENT_TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"error":"unauthorized"}')
      return
    }
    const registered = tokenConfirmed && adopted && activeSocket?.readyState === 1
    response.writeHead(registered ? 200 : 202, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: registered ? 'registered' : 'pending' }))
    return
  }
  response.writeHead(404)
  response.end()
})

httpsServer = createHttpsServer({ cert: pems.cert, key: pems.private })
const wss = new WebSocketServer({ noServer: true })
httpsServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`)
  if (url.pathname !== '/agent' || url.searchParams.get('enroll') !== ENROLLMENT_TOKEN) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws))
})

wss.once('connection', (ws) => {
  activeSocket = ws
  ws.once('message', (raw) => {
    let register
    try {
      register = JSON.parse(String(raw))
    } catch {
      fail('节点 register 不是 JSON')
      return
    }
    if (
      register.type !== 'register' ||
      register.label !== 'docker-one-click-node' ||
      register.platform !== EXPECTED_PLATFORM ||
      register.hostVersion !== EXPECTED_VERSION ||
      register.protocolVersion !== EXPECTED_PROTOCOL_VERSION
    ) {
      fail(`register 无效：${JSON.stringify(register)}`)
      return
    }

    ws.send(JSON.stringify({ type: 'enrollment-accepted', nodeToken: LONG_NODE_TOKEN }))
    ws.once('message', (confirmationRaw) => {
      let confirmation
      try {
        confirmation = JSON.parse(String(confirmationRaw))
      } catch {
        fail('enrollment-confirmed 不是 JSON')
        return
      }
      if (confirmation.type !== 'enrollment-confirmed') {
        fail(`缺少 enrollment-confirmed：${JSON.stringify(confirmation)}`)
        return
      }
      tokenConfirmed = true

      const pending = new Map()
      let requestSeq = 0
      let captured = ''
      const rpc = (method, params) => new Promise((resolveRpc, reject) => {
        const id = `request-${++requestSeq}`
        pending.set(id, { resolve: resolveRpc, reject })
        ws.send(JSON.stringify({ type: 'request', id, method, params }))
      })
      ws.on('message', (responseRaw) => {
        let response
        try {
          response = JSON.parse(String(responseRaw))
        } catch {
          return
        }
        if (response.type === 'event' && response.event?.kind === 'pty-data') {
          captured += response.event.bytes
          return
        }
        if (response.type !== 'response') return
        const request = pending.get(response.id)
        if (!request) return
        pending.delete(response.id)
        if (response.error) request.reject(new Error(response.error))
        else request.resolve(response.result)
      })

      void (async () => {
        try {
          const probe = await rpc('probeTerminal', [])
          if (probe?.ok !== true || probe?.backend !== 'node-pty') {
            throw new Error(`远程 PTY 注册探针失败：${JSON.stringify(probe)}`)
          }

          const runtimes = await rpc('listRuntimes', [])
          const ids = Array.isArray(runtimes) ? runtimes.map((runtime) => runtime.toolId) : []
          if (!ids.includes('claude')) throw new Error(`节点没有发现 fake Claude：${JSON.stringify(runtimes)}`)
          if (!ids.includes('opencode')) throw new Error(`节点没有发现 fake OpenCode：${JSON.stringify(runtimes)}`)

          ws.send(JSON.stringify({
            type: 'node-adopted',
            nodeId: 'docker-one-click-node',
            hostVersion: register.hostVersion,
            protocolVersion: EXPECTED_PROTOCOL_VERSION,
            adoptedAt: new Date().toISOString()
          }))
          adopted = true

          await waitFor(
            () => dockerOutput.includes('✓ 完成：主控已确认节点注册'),
            '一行安装器没有在主控采纳后成功提交'
          )
          await waitFor(
            () => dockerOutput.includes('FIXTURE: long node token persisted and short enrollment token removed'),
            '安装完成后未证明长期 token 落盘并清除短票'
          )
          await waitFor(() => dockerOutput.includes('[node] connected'), '节点未在主控 ACK 后进入 connected 状态')

          const listing = await rpc('listDirectories', [{ path: '/data' }])
          const directoryNames = Array.isArray(listing?.entries) ? listing.entries.map((entry) => entry.name) : []
          if (!directoryNames.includes('remote-project')) {
            throw new Error(`远程目录浏览未返回 /data/remote-project：${JSON.stringify(listing)}`)
          }

          const handle = await rpc('createSession', [{
            name: 'docker-remote-cli', toolId: 'claude', workspacePath: '/tmp', surface: 'terminal'
          }])
          const terminalId = handle?.terminal?.sessionId
          if (!terminalId) throw new Error(`远程创建会话未返回 terminal id：${JSON.stringify(handle)}`)
          await waitFor(() => captured.includes('fake-claude-ready'), '未收到远程 CLI 启动输出')

          const wrote = await rpc('write', [terminalId, 'ping-from-controller\n'])
          if (wrote !== true) throw new Error('主控写入远程 PTY 失败')
          await waitFor(() => captured.includes('fake-claude-received ping-from-controller'), '未收到远程 CLI 回显')

          const opencodeHandle = await rpc('createSession', [{
            name: 'docker-remote-opencode', toolId: 'opencode', workspacePath: '/data/remote-project', surface: 'terminal'
          }])
          const opencodeTerminalId = opencodeHandle?.terminal?.sessionId
          if (!opencodeTerminalId) throw new Error(`远程创建 OpenCode 会话未返回 terminal id：${JSON.stringify(opencodeHandle)}`)
          await waitFor(() => captured.includes('fake-opencode-ready cwd=/data/remote-project'), 'OpenCode 未在远程工作目录启动')

          console.log('PASS: SHA 锚定一行命令、真实制品安装、短票换票、主控采纳、长期票持久化、Agent/OpenCode、远程目录/cwd 与 PTY 双向 I/O 均通过')
          await cleanup(0)
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
        }
      })()
    })
  })
})

Promise.all([
  new Promise((resolveListen, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(HTTP_PORT, '0.0.0.0', resolveListen)
  }),
  new Promise((resolveListen, reject) => {
    httpsServer.once('error', reject)
    httpsServer.listen(WSS_PORT, '0.0.0.0', resolveListen)
  })
]).then(() => {
  docker = spawn(
    'docker',
    [
      'run', '--rm', '--add-host', 'host.docker.internal:host-gateway',
      '--name', CONTAINER_NAME,
      '--mount', `type=bind,source=${ARCHIVE},target=/fixture/agentos-node.tar.gz,readonly`,
      '--mount', `type=bind,source=${fixtureDirectory},target=/fixture-config,readonly`,
      '-e', 'AGENT_OS_NODE_LABEL=docker-one-click-node',
      '-e', 'AGENT_OS_NODE_DATA=/data',
      '-e', `AGENT_OS_EXPECTED_NODE_TOKEN=${LONG_NODE_TOKEN}`,
      IMAGE
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  docker.stdout.on('data', (chunk) => { dockerOutput += chunk })
  docker.stderr.on('data', (chunk) => { dockerOutput += chunk })
  docker.once('error', (error) => fail(`无法启动 Docker：${error.message}`))
  docker.once('exit', (code) => {
    if (!cleaning && !timedOut) fail(`节点容器提前退出（code ${code ?? 'signal'}）`)
  })
}).catch((error) => fail(error instanceof Error ? error.message : String(error)))
