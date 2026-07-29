// 远程节点的自签 TLS 物料：生成证书/私钥，并算出 SHA-256 指纹用于主控端 TOFU pin。

import { createHash } from 'node:crypto'
import selfsigned from 'selfsigned'

export interface NodeTlsMaterial {
  cert: string
  key: string
  /** sha256 指纹，大写冒号分隔十六进制（与 OpenSSL 一致）。 */
  fingerprint: string
}

/** 由证书 PEM 计算 SHA-256 指纹。 */
export function certFingerprint(certPem: string): string {
  const b64 = certPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Buffer.from(b64, 'base64')
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase()
  return hex.match(/../g)?.join(':') ?? hex
}

/** 生成自签证书（默认 10 年有效期）。 */
export function generateNodeTls(commonName = 'agent-os-node'): NodeTlsMaterial {
  const pems = selfsigned.generate([{ name: 'commonName', value: commonName }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256'
  })
  return { cert: pems.cert, key: pems.private, fingerprint: certFingerprint(pems.cert) }
}
