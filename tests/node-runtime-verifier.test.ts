import { createHash } from 'node:crypto'
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
const verifier = join(process.cwd(), 'scripts', 'verify-node-runtime.cjs')

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): { prefix: string; payload: string } {
  const prefix = mkdtempSync(join(tmpdir(), 'agentos-runtime-'))
  temporaryDirectories.push(prefix)
  const runtimeNode = join(prefix, 'runtime', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const hostNode = process.env.npm_node_execpath || process.execPath
  mkdirSync(join(prefix, 'runtime', 'bin'), { recursive: true })
  try {
    linkSync(hostNode, runtimeNode)
  } catch {
    copyFileSync(hostNode, runtimeNode)
  }
  mkdirSync(join(prefix, 'node_modules'), { recursive: true })
  symlinkSync(
    join(process.cwd(), 'node_modules', 'node-pty'),
    join(prefix, 'node_modules', 'node-pty'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const payload = join(prefix, 'payload.txt')
  writeFileSync(payload, 'trusted runtime\n')
  const content = readFileSync(payload)
  writeFileSync(join(prefix, 'runtime-manifest.json'), JSON.stringify({
    nodeExecutable: `runtime/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
    files: [{
      path: 'payload.txt',
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex')
    }]
  }))
  return { prefix, payload }
}

describe('SPEC-032 解包 runtime 文件完整性', () => {
  it('清单与实际文件一致时通过', () => {
    const { prefix } = fixture()
    const result = spawnSync(process.execPath, [verifier, prefix], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('runtime 文件完整性通过')
  })

  it('真实 node-pty 能启动包内 Node 子进程并回显随机内容', () => {
    const { prefix } = fixture()
    const result = spawnSync(process.execPath, [verifier, prefix, '--probe-pty'], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`PTY probe failed\n${result.stdout}\n${result.stderr}`)
    expect(result.stdout).toContain('node-pty 真实子进程回显通过')
  })

  it('解包后任一文件被篡改时拒绝启动', () => {
    const { prefix, payload } = fixture()
    writeFileSync(payload, 'tampered\n')
    const result = spawnSync(process.execPath, [verifier, prefix], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/大小不一致|校验失败/)
  })
})
