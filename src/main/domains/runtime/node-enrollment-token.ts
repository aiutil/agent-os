// SPEC-032：节点首注册凭证持久化。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 用同目录临时文件 + rename 原子替换 node.env。
 * 成功后只保留长期 token，移除已消费的 enrollment token。
 */
export function persistEnrolledNodeToken(envFile: string, nodeToken: string): void {
  if (!/^[a-f0-9]{64}$/i.test(nodeToken)) throw new Error('无效的长期节点 token')
  mkdirSync(dirname(envFile), { recursive: true })
  const previous = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
  const lines = previous
    .split(/\r?\n/)
    .filter((line) => line && !/^AGENT_OS_(?:NODE|ENROLL)_TOKEN=/.test(line))
  lines.push(`AGENT_OS_NODE_TOKEN=${nodeToken}`)
  const temporary = `${envFile}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, envFile)
}
