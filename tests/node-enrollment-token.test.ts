import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { persistEnrolledNodeToken } from '../src/main/domains/runtime/node-enrollment-token'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SPEC-032 enrollment 长期凭证持久化', () => {
  it('原子替换短期换票，保留其他配置并收紧文件权限', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-enrollment-'))
    temporaryDirectories.push(directory)
    const envFile = join(directory, 'node.env')
    writeFileSync(envFile, [
      'AGENT_OS_HOST=wss://192.168.1.20:7431/agent',
      `AGENT_OS_ENROLL_TOKEN=${'a'.repeat(64)}`,
      'AGENT_OS_HOST_FP=AA:BB'
    ].join('\n'))

    persistEnrolledNodeToken(envFile, 'b'.repeat(64))

    const result = readFileSync(envFile, 'utf8')
    expect(result).toContain('AGENT_OS_HOST=wss://192.168.1.20:7431/agent')
    expect(result).toContain(`AGENT_OS_NODE_TOKEN=${'b'.repeat(64)}`)
    expect(result).not.toContain('AGENT_OS_ENROLL_TOKEN=')
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
  })

  it('拒绝将非 256-bit 凭证写入配置', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-enrollment-'))
    temporaryDirectories.push(directory)
    expect(() => persistEnrolledNodeToken(join(directory, 'node.env'), 'short')).toThrow('无效')
  })
})
