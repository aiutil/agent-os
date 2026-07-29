import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  assertRemoteReleaseMatches,
  localAssetRecords,
  releaseSourceMarker
} = require('../scripts/release-draft-verifier.cjs') as {
  assertRemoteReleaseMatches(input: {
    release: Record<string, unknown>
    expected: Array<{ name: string; bytes: number; sha256: string }>
    tag: string
    sourceRevision: string
    expectedDraft: boolean
  }): { assets: number; bytes: number }
  localAssetRecords(files: string[]): Array<{ name: string; bytes: number; sha256: string }>
  releaseSourceMarker(sourceRevision: string): string
}

const directories: string[] = []
const revision = 'a'.repeat(40)

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentos-release-draft-'))
  directories.push(directory)
  const first = join(directory, 'Agent-Os-1.2.3-mac-arm64.dmg')
  const second = join(directory, 'agentos-node-1.2.3-mac-arm64.tar.gz')
  writeFileSync(first, 'desktop artifact')
  writeFileSync(second, 'node artifact')
  const expected = localAssetRecords([second, first])
  const release = {
    tag_name: 'v1.2.3',
    draft: true,
    body: `release notes\n\n${releaseSourceMarker(revision)}`,
    assets: expected.map((asset, index) => ({
      id: index + 1,
      name: asset.name,
      size: asset.bytes,
      digest: `sha256:${asset.sha256}`
    }))
  }
  return { expected, release }
}

describe('SPEC-032 draft Release 原子晋升门禁', () => {
  it('仅接受绑定当前 source revision 的 exact asset set、bytes 与 SHA-256', () => {
    const { expected, release } = fixture()
    expect(assertRemoteReleaseMatches({
      release,
      expected,
      tag: 'v1.2.3',
      sourceRevision: revision,
      expectedDraft: true
    })).toEqual({
      assets: 2,
      bytes: expected.reduce((total, asset) => total + asset.bytes, 0)
    })
  })

  it('缺失、额外或 digest 不同的远端资产均 fail closed', () => {
    const { expected, release } = fixture()
    const verify = (candidate: Record<string, unknown>) => assertRemoteReleaseMatches({
      release: candidate,
      expected,
      tag: 'v1.2.3',
      sourceRevision: revision,
      expectedDraft: true
    })
    expect(() => verify({ ...release, assets: release.assets.slice(1) })).toThrow('asset set mismatch')
    expect(() => verify({
      ...release,
      assets: [...release.assets, { id: 9, name: 'stale.zip', size: 1, digest: `sha256:${'b'.repeat(64)}` }]
    })).toThrow('asset set mismatch')
    expect(() => verify({
      ...release,
      assets: release.assets.map((asset, index) => index === 0
        ? { ...asset, digest: `sha256:${'b'.repeat(64)}` }
        : asset)
    })).toThrow('digest mismatch')
  })

  it('错误 draft 状态或 source marker 不能晋升', () => {
    const { expected, release } = fixture()
    const input = {
      expected,
      tag: 'v1.2.3',
      sourceRevision: revision,
      expectedDraft: true
    }
    expect(() => assertRemoteReleaseMatches({ ...input, release: { ...release, draft: false } }))
      .toThrow('draft state mismatch')
    expect(() => assertRemoteReleaseMatches({ ...input, release: { ...release, body: 'no source marker' } }))
      .toThrow('not bound to the current source revision')
  })
})
