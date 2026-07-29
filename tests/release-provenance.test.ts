import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
const {
  assertCompatibleProvenance,
  assertPublishSource,
  buildLocalReleaseProvenance,
  normalizeGithubRepository,
  provenanceAssetName,
  provenanceDifferences
} = require('../scripts/release-provenance.cjs') as {
  assertCompatibleProvenance(expected: Record<string, unknown>, actual: Record<string, unknown>, label?: string): void
  assertPublishSource(
    provenance: Record<string, unknown>,
    input: {
      localHead: string
      remoteMainCommit: string
      actualSourceRepository: string
      actualSourceTreeClean: boolean
      expectedRepository?: string
    }
  ): void
  buildLocalReleaseProvenance(root?: string, env?: NodeJS.ProcessEnv): Record<string, unknown>
  normalizeGithubRepository(raw: string): string
  provenanceAssetName(version: string): string
  provenanceDifferences(expected: Record<string, unknown>, actual: Record<string, unknown>): string[]
}

describe('SPEC-032 Release provenance', () => {
  it('将源仓、commit、protocol 与安装脚本哈希固定为可比对记录', () => {
    const commit = 'a'.repeat(40)
    const provenance = buildLocalReleaseProvenance(process.cwd(), {
      ...process.env,
      AGENT_OS_SOURCE_COMMIT: commit,
      AGENT_OS_SOURCE_DIRTY: '0',
      AGENT_OS_SOURCE_REPOSITORY: 'git@github.com:aiutil/agent-os.git'
    })

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      version,
      sourceRepository: 'aiutil/agent-os',
      sourceCommit: commit,
      sourceRevision: commit,
      sourceTreeClean: true,
      runtimeProtocolVersion: expect.any(Number),
      installNodeSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(provenanceAssetName(`v${version}`)).toBe(`agentos-release-${version}-provenance.json`)
    expect(normalizeGithubRepository('https://github.com/aiutil/agent-os')).toBe('aiutil/agent-os')
    expect(() => assertCompatibleProvenance(provenance, { ...provenance })).not.toThrow()
  })

  it('同 SemVer 但 commit 不同或工作树未提交时拒绝追加制品', () => {
    const commit = 'a'.repeat(40)
    const clean = buildLocalReleaseProvenance(process.cwd(), {
      ...process.env,
      AGENT_OS_SOURCE_COMMIT: commit,
      AGENT_OS_SOURCE_DIRTY: '0',
      AGENT_OS_SOURCE_REPOSITORY: 'aiutil/agent-os'
    })
    const anotherCommit = { ...clean, sourceCommit: 'b'.repeat(40), sourceRevision: 'b'.repeat(40) }
    expect(provenanceDifferences(clean, anotherCommit).join('\n')).toContain('sourceCommit')
    expect(() => assertCompatibleProvenance(clean, anotherCommit, 'existing release')).toThrow('不一致')

    const dirty = {
      ...clean,
      sourceRevision: `${commit}-dirty`,
      sourceTreeClean: false
    }
    expect(() => assertCompatibleProvenance(dirty, dirty, 'dirty release')).toThrow('未提交工作树')
  })

  it('正式发布要求权威源仓、本地 HEAD 与远端 main 三者精确一致', () => {
    const commit = 'a'.repeat(40)
    const provenance = {
      sourceRepository: 'aiutil/agent-os',
      sourceCommit: commit,
      sourceRevision: commit,
      sourceTreeClean: true
    }
    expect(() => assertPublishSource(provenance, {
      localHead: commit,
      remoteMainCommit: commit,
      actualSourceRepository: 'aiutil/agent-os',
      actualSourceTreeClean: true
    })).not.toThrow()
    expect(() => assertPublishSource(
      { ...provenance, sourceRepository: 'someone/Agent-OS' },
      {
        localHead: commit,
        remoteMainCommit: commit,
        actualSourceRepository: 'aiutil/agent-os',
        actualSourceTreeClean: true
      }
    )).toThrow('源仓')
    expect(() => assertPublishSource(provenance, {
      localHead: commit,
      remoteMainCommit: 'b'.repeat(40),
      actualSourceRepository: 'aiutil/agent-os',
      actualSourceTreeClean: true
    })).toThrow('远端 main')
    expect(() => assertPublishSource(
      { ...provenance, sourceCommit: 'b'.repeat(40) },
      {
        localHead: commit,
        remoteMainCommit: commit,
        actualSourceRepository: 'aiutil/agent-os',
        actualSourceTreeClean: true
      }
    )).toThrow('本地 HEAD')
    expect(() => assertPublishSource(provenance, {
      localHead: commit,
      remoteMainCommit: commit,
      actualSourceRepository: 'attacker/fork',
      actualSourceTreeClean: true
    })).toThrow('实际 origin')
    expect(() => assertPublishSource(provenance, {
      localHead: commit,
      remoteMainCommit: commit,
      actualSourceRepository: 'aiutil/agent-os',
      actualSourceTreeClean: false
    })).toThrow('实际 git 工作树')
  })

  it('构建环境覆盖值不能把正式发布的真实 dirty/fork 状态伪装为可信', () => {
    const commit = 'a'.repeat(40)
    const forged = buildLocalReleaseProvenance(process.cwd(), {
      ...process.env,
      AGENT_OS_SOURCE_COMMIT: commit,
      AGENT_OS_SOURCE_DIRTY: '0',
      AGENT_OS_SOURCE_REPOSITORY: 'aiutil/agent-os'
    })
    expect(forged).toMatchObject({ sourceTreeClean: true, sourceRepository: 'aiutil/agent-os' })
    expect(() => assertPublishSource(forged, {
      localHead: commit,
      remoteMainCommit: commit,
      actualSourceRepository: 'attacker/fork',
      actualSourceTreeClean: false
    })).toThrow(/实际 origin|实际 git 工作树/)
  })
})
