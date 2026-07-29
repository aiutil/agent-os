// 主控端模拟：连到容器里的远程节点（WSS + token），跑通整套 RuntimeHost RPC：
// hello 握手 → 在远程创建一个 shell 会话 → 远程真实进程执行 echo → 事件流回传输出。
// 用法： node docker/remote-node/test-client.mjs [port] [token]
import WebSocket from 'ws'

const port = Number(process.argv[2] || process.env.PORT || 7420)
const token = process.argv[3] || process.env.AGENT_OS_NODE_TOKEN || 'devtoken123'
const MARKER = 'HELLO_REMOTE_OK'

const url = `wss://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
const ws = new WebSocket(url, { rejectUnauthorized: false }) // 自签证书：测试放开校验（生产走指纹 pin）

const pending = new Map()
let seq = 0
let captured = ''
let termId = null

function rpc(method, params) {
  const id = String(++seq)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ type: 'request', id, method, params }))
  })
}

function fail(msg) {
  console.error('FAIL:', msg)
  try { ws.close() } catch {}
  process.exit(1)
}

ws.on('unexpected-response', (_req, res) => fail(`upgrade rejected: HTTP ${res.statusCode}`))
ws.on('error', (e) => fail(`socket error: ${e.message}`))

ws.on('message', (data) => {
  let env
  try { env = JSON.parse(data.toString()) } catch { return }
  if (env.type === 'response') {
    const p = pending.get(env.id)
    if (!p) return
    pending.delete(env.id)
    if (env.error) p.reject(new Error(env.error))
    else p.resolve(env.result)
  } else if (env.type === 'event') {
    const ev = env.event
    if (ev?.kind === 'pty-data' && ev.sessionId === termId) captured += ev.bytes
  }
})

ws.on('open', async () => {
  try {
    const hello = await rpc('hello', [])
    console.log('hello ok → protocolVersion', hello.protocolVersion, 'hostVersion', hello.hostVersion)

    const status = await rpc('hostStatus', [])
    console.log('hostStatus →', status.mode, status.connection, 'sessions', status.sessionCount)

    const handle = await rpc('createSession', [
      { name: 'docker-test', toolId: 'shell', workspacePath: '/tmp', surface: 'terminal' }
    ])
    termId = handle?.terminal?.sessionId
    if (!termId) fail('createSession 未返回 terminal.sessionId：' + JSON.stringify(handle))
    console.log('createSession ok → remote terminal', termId)

    await new Promise((r) => setTimeout(r, 400)) // 等 pty 起好
    await rpc('write', [termId, `echo ${MARKER}\n`])
    console.log('write sent, waiting for remote output…')

    await new Promise((r) => setTimeout(r, 2500))
    if (captured.includes(MARKER)) {
      console.log('PASS: 远程进程输出已通过事件流回传，包含标记', JSON.stringify(MARKER))
      ws.close()
      process.exit(0)
    }
    fail('未在事件流中捕获到远程输出标记。captured=' + JSON.stringify(captured.slice(0, 400)))
  } catch (e) {
    fail(e.message)
  }
})

setTimeout(() => fail('总超时'), 15000)
