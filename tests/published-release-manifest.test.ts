import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  materializePublishedManifest,
  reusablePublishedManifestAsset
}: {
  reusablePublishedManifestAsset(input: Record<string, unknown>): {
    id: number
    size: number
    digest: string
  } | null
  materializePublishedManifest(input: Record<string, unknown>): string
} = require('../scripts/published-release-manifest.cjs')

const revision = 'a'.repeat(40)
const manifestName = 'agentos-node-0.3.6-manifest.json'
const marker = `<!-- agent-os-source:${revision} -->`

describe('SPEC-042 公开版本 aggregate manifest 重跑', () => {
  it('只允许同 source 的公开版本复用唯一 manifest', () => {
    const asset = {
      id: 7,
      name: manifestName,
      size: 10,
      digest: `sha256:${'b'.repeat(64)}`
    }
    expect(
      reusablePublishedManifestAsset({
        release: {
          tag_name: 'v0.3.6',
          draft: false,
          body: marker,
          assets: [asset]
        },
        tag: 'v0.3.6',
        sourceRevision: revision,
        manifestName
      })
    ).toEqual(asset)
    expect(
      reusablePublishedManifestAsset({
        release: { tag_name: 'v0.3.6', draft: true, body: marker, assets: [asset] },
        tag: 'v0.3.6',
        sourceRevision: revision,
        manifestName
      })
    ).toBeNull()
    expect(() =>
      reusablePublishedManifestAsset({
        release: { tag_name: 'v0.3.6', draft: false, body: '', assets: [asset] },
        tag: 'v0.3.6',
        sourceRevision: revision,
        manifestName
      })
    ).toThrow('不属于当前 source revision')
  })

  it('下载 bytes 必须同时满足 digest、provenance、协议和五平台集合', () => {
    const platforms = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-x64']
    const bytes = Buffer.from(
      JSON.stringify({
        version: '0.3.6',
        provenance: { sourceRevision: revision },
        assets: platforms.map((platform) => ({
          fileIntegrityVerified: true,
          runtime: {
            platform,
            sourceRevision: revision,
            appVersion: '0.3.6',
            protocolVersion: 10
          }
        }))
      })
    )
    const digest = createHash('sha256').update(bytes).digest('hex')
    const targetPath = join(mkdtempSync(join(tmpdir(), 'agentos-published-')), manifestName)
    materializePublishedManifest({
      bytes,
      asset: { size: bytes.length, digest: `sha256:${digest}` },
      targetPath,
      sourceRevision: revision,
      version: '0.3.6',
      protocolVersion: 10,
      requiredPlatforms: platforms
    })
    expect(readFileSync(targetPath)).toEqual(bytes)
    expect(() =>
      materializePublishedManifest({
        bytes,
        asset: { size: bytes.length, digest: `sha256:${'0'.repeat(64)}` },
        targetPath,
        sourceRevision: revision,
        version: '0.3.6',
        protocolVersion: 10,
        requiredPlatforms: platforms
      })
    ).toThrow('SHA-256')

    const duplicateBytes = Buffer.from(
      JSON.stringify({
        version: '0.3.6',
        provenance: { sourceRevision: revision },
        assets: [
          ...platforms,
          'mac-arm64'
        ].map((platform) => ({
          fileIntegrityVerified: true,
          runtime: {
            platform,
            sourceRevision: revision,
            appVersion: '0.3.6',
            protocolVersion: 10
          }
        }))
      })
    )
    const duplicateDigest = createHash('sha256').update(duplicateBytes).digest('hex')
    expect(() =>
      materializePublishedManifest({
        bytes: duplicateBytes,
        asset: { size: duplicateBytes.length, digest: `sha256:${duplicateDigest}` },
        targetPath,
        sourceRevision: revision,
        version: '0.3.6',
        protocolVersion: 10,
        requiredPlatforms: platforms
      })
    ).toThrow('平台集合不精确')
  })
})
