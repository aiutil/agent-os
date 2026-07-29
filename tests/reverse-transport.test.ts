// SPEC-032 Step B：反向传输（节点出站拨号 + 主控接管 socket 驱动）端到端。
// 用一个 plain ws server 扮演主控网关：节点 startNodeGatewayClient 连入并上报身份，
// 主控 DaemonRuntimeHost.adopt 接管该 socket 后驱动节点的 RuntimeHost；事件反向推送。

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { RUNTIME_PROTOCOL_VERSION, type HostEvent, type RuntimeHost } from '../src/shared/types'
import { DaemonRuntimeHost } from '../src/main/domains/runtime/daemon-runtime-host'
import { startNodeGatewayClient } from '../src/main/domains/runtime/node-gateway-client'
import {
  parseDaemonEnvelope,
  type DaemonRegister
} from '../src/main/domains/runtime/daemon-protocol'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** 节点侧最小 RuntimeHost：只实现本测试会驱动到的方法 + 事件订阅。 */
class NodeFakeRuntime extends EventEmitter {
  async hostStatus() {
    return { mode: 'daemon', connection: 'connected', sessionCount: 2, pid: 999 }
  }
  async listSessions() {
    return [{ id: 'remote-1', name: '远程会话' }]
  }
  async write(_sessionId: string, data: string) {
    return data === 'ping'
  }
  subscribe(listener: (event: HostEvent) => void): () => void {
    this.on('ev', listener)
    return () => this.off('ev', listener)
  }
  emitHost(event: HostEvent): void {
    this.emit('ev', event)
  }
}

function startGateway(): Promise<{
  port: number
  accepted: Promise<{ driver: DaemonRuntimeHost; register: DaemonRegister }>
  close: () => Promise<void>
}> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const accepted = new Promise<{ driver: DaemonRuntimeHost; register: DaemonRegister }>(
    (resolve) => {
      wss.on('connection', (socket: WebSocket) => {
        // 第一帧应为 register；拦截后再把 socket 交给驱动。
        socket.once('message', (raw) => {
          const env = parseDaemonEnvelope(String(raw))
          if (env.type !== 'register') return
          const driver = DaemonRuntimeHost.adopt(socket)
          resolve({ driver, register: env })
        })
      })
    }
  )
  return new Promise((resolve) => {
    wss.on('listening', () => {
      const addr = wss.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        accepted,
        close: async () => {
          for (const c of wss.clients) c.close()
          await new Promise<void>((r) => wss.close(() => r()))
        }
      })
    })
  })
}

describe('SPEC-032 反向传输', () => {
  it('节点拨入 → 主控接管 socket 驱动 RPC + 反向事件推送', async () => {
    const gw = await startGateway()
    cleanups.push(gw.close)

    const runtime = new NodeFakeRuntime()
    const client = startNodeGatewayClient({
      url: `ws://127.0.0.1:${gw.port}/agent`,
      token: 'node-token',
      rpc: {
        runtime: runtime as unknown as RuntimeHost,
        hostVersion: '9.9.9',
        runtimeBuildId: 'build-xyz',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      },
      register: {
        label: '书房台式机',
        platform: 'win-x64',
        protocolVersion: RUNTIME_PROTOCOL_VERSION
      }
    })
    cleanups.push(() => client.close())

    const { driver, register } = await gw.accepted

    // 身份上报。
    expect(register.label).toBe('书房台式机')
    expect(register.platform).toBe('win-x64')

    // hello（端点合成）。
    const hello = await driver.hello()
    expect(hello.protocolVersion).toBe(RUNTIME_PROTOCOL_VERSION)
    expect(hello.hostVersion).toBe('9.9.9')
    expect(hello.runtimeBuildId).toBe('build-xyz')

    // 注册收口所需的远程原生 PTY 探针，不只验证 RPC 可达。
    await expect(driver.probeTerminal()).resolves.toMatchObject({
      ok: true,
      backend: 'node-pty',
      nodeVersion: expect.any(String),
      nodeAbi: expect.any(String)
    })

    // 转发到节点 runtime 的方法。
    const sessions = await driver.listSessions()
    expect(sessions).toEqual([{ id: 'remote-1', name: '远程会话' }])
    expect(await driver.write('s', 'ping')).toBe(true)
    expect(await driver.write('s', 'nope')).toBe(false)

    // 反向事件：节点 emit → 主控 subscribe 收到。
    const got = new Promise<HostEvent>((resolve) => {
      const off = driver.subscribe((ev) => {
        off()
        resolve(ev)
      })
    })
    runtime.emitHost({ type: 'exit', sessionId: 'remote-1', code: 0 } as unknown as HostEvent)
    const ev = await got
    expect('sessionId' in ev ? ev.sessionId : undefined).toBe('remote-1')

    await driver.close()
  })
})
