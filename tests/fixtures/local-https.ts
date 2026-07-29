import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestListener } from 'node:http'
import selfsigned from 'selfsigned'

export interface LocalHttpsFixture {
  origin: string
  caPath: string
  close(): Promise<void>
}

/** 启动只监听 loopback 的 HTTPS fixture，并返回供子进程 NODE_EXTRA_CA_CERTS 使用的 CA 文件。 */
export async function startLocalHttpsFixture(listener: RequestListener): Promise<LocalHttpsFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'agent-os-test-tls-'))
  const pems = selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
    days: 1,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] }
    ]
  })
  const caPath = join(directory, 'ca.pem')
  writeFileSync(caPath, pems.cert, { mode: 0o600 })
  const server: Server = createServer({ key: pems.private, cert: pems.cert }, listener)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试 HTTPS 服务器地址无效')
    return {
      origin: `https://127.0.0.1:${address.port}`,
      caPath,
      close: async () => {
        await closeServer(server)
        rmSync(directory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await closeServer(server)
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
