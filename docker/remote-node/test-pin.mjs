// 验证 RemoteRuntimeHost 用的 TLS 配对+指纹 pin 路径（对真实容器节点）：
// 1) TOFU 探测：rejectUnauthorized:false 连一次，抓 peer 证书指纹 + PEM（= probeRemoteNode 逻辑）
// 2) 钉住重连：用抓到的证书作 ca + rejectUnauthorized:true 再连，hello 应通过（= tlsOptionsFor 逻辑）
// 3) 负向：用错误的 ca 连接应被 TLS 拒绝
import WebSocket from 'ws'

const port = Number(process.argv[2] || 7420)
const token = process.argv[3] || 'devtoken123'
const base = `wss://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`

function derToPem(der) {
  const b64 = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`
}
function hello(ws) {
  return new Promise((resolve, reject) => {
    const onMsg = (d) => {
      const env = JSON.parse(d.toString())
      if (env.type === 'response' && env.id === 'h') { ws.off('message', onMsg); resolve(env.result) }
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ type: 'request', id: 'h', method: 'hello', params: [] }))
  })
}
const fail = (m) => { console.error('FAIL:', m); process.exit(1) }

// step 1: TOFU probe
const probe = await new Promise((resolve) => {
  const ws = new WebSocket(base, { rejectUnauthorized: false })
  ws.on('error', (e) => fail('probe error: ' + e.message))
  ws.on('open', async () => {
    const cert = ws._socket.getPeerCertificate(true)
    const res = await hello(ws)
    ws.close()
    resolve({ fingerprint: cert.fingerprint256, certPem: derToPem(cert.raw), hostVersion: res.hostVersion })
  })
})
console.log('probe ok → fingerprint', probe.fingerprint.slice(0, 17) + '…', 'hostVersion', probe.hostVersion)

// step 2: pinned reconnect with captured cert as ca
await new Promise((resolve) => {
  const ws = new WebSocket(base, {
    ca: [probe.certPem],
    rejectUnauthorized: true,
    checkServerIdentity: () => undefined
  })
  ws.on('error', (e) => fail('pinned connect rejected: ' + e.message))
  ws.on('open', async () => {
    const res = await hello(ws)
    if (res?.protocolVersion) console.log('pinned connect ok → protocolVersion', res.protocolVersion)
    else fail('pinned hello no result')
    ws.close()
    resolve()
  })
})

// step 3: negative — a different self-signed CA must be rejected
const WRONG_CA =
  '-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIJANr...invalid...\n-----END CERTIFICATE-----\n'
await new Promise((resolve) => {
  const ws = new WebSocket(base, { ca: [WRONG_CA], rejectUnauthorized: true, checkServerIdentity: () => undefined })
  let done = false
  ws.on('error', () => { if (!done) { done = true; console.log('negative ok → 错误 ca 被 TLS 拒绝'); resolve() } })
  ws.on('open', () => { if (!done) { done = true; fail('错误 ca 竟然连上了（pin 失效）'); } })
  setTimeout(() => { if (!done) { done = true; console.log('negative ok → 错误 ca 未建立连接'); resolve() } }, 3000)
})

console.log('PASS: 配对探测 + 证书 pin + 负向校验 全部通过')
process.exit(0)
