import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'

const require = createRequire(import.meta.url)
const {
  artifactArchitectures,
  assertDesktopReleaseArtifacts,
  desktopManifestName,
  writeDesktopReleaseManifest
} = require('../scripts/desktop-release-manifest.cjs') as {
  artifactArchitectures(names: string[], version: string, platform: string): string[]
  assertDesktopReleaseArtifacts(
    releaseDir: string,
    version: string,
    provenance: Record<string, unknown>
  ): { assets: string[]; manifests: string[] }
  desktopManifestName(version: string, platform: string, architecture?: string): string
  writeDesktopReleaseManifest(
    buildResult: { outDir: string; artifactPaths: string[] },
    root: string,
    provenance: Record<string, unknown>
  ): { output: string; manifest: { assets: Array<{ name: string; bytes: number; sha256: string }> } }
}

const afterAllArtifactBuild = require('../build/after-all-artifact-build.cjs').default as (
  buildResult: { outDir: string; artifactPaths: string[] }
) => Promise<string[]>

const temporaryDirectories: string[] = []
const provenance = {
  schemaVersion: 1,
  version: '0.2.9',
  sourceRepository: 'aiutil/agent-os',
  sourceCommit: 'a'.repeat(40),
  sourceRevision: 'a'.repeat(40),
  sourceTreeClean: true,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  installNodeSha256: 'b'.repeat(64)
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): { root: string; release: string; dmg: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-desktop-release-'))
  temporaryDirectories.push(root)
  const release = join(root, 'release')
  mkdirSync(join(root, 'out', 'main'), { recursive: true })
  mkdirSync(release, { recursive: true })
  writeFileSync(join(root, 'out', 'main', 'index.js'), `const sourceRevision = ${JSON.stringify(provenance.sourceRevision)}\n`)
  const dmg = join(release, 'Agent-Os-0.2.9-mac-arm64.dmg')
  writeFileSync(dmg, 'desktop artifact')
  return { root, release, dmg }
}

describe('SPEC-032 桌面制品 provenance', () => {
  it('目录模式没有发布制品时跳过 manifest，而不是把已生成的 unpacked App 判为失败', async () => {
    const { release } = fixture()
    await expect(afterAllArtifactBuild({ outDir: release, artifactPaths: [] })).resolves.toEqual([])
  })

  it('把 Linux 的 x86_64/amd64 实际文件名统一识别为逻辑 x64 架构', () => {
    expect(artifactArchitectures([
      'Agent-Os-0.2.9-linux-x86_64.AppImage',
      'Agent-Os-0.2.9-linux-amd64.deb'
    ], '0.2.9', 'linux')).toEqual(['x64'])
  })

  it('electron-builder 实际返回的制品会记录 SHA，并可在发布前复验', () => {
    const { root, release, dmg } = fixture()
    const blockmap = join(release, 'Agent-Os-0.2.9-mac-arm64.dmg.blockmap')
    writeFileSync(blockmap, 'blockmap')
    const result = writeDesktopReleaseManifest({ outDir: release, artifactPaths: [dmg, blockmap] }, root, provenance)

    expect(result.output).toBe(join(release, desktopManifestName('0.2.9', 'mac', 'arm64')))
    expect(result.manifest.assets.map((asset) => asset.name)).toEqual([
      'Agent-Os-0.2.9-mac-arm64.dmg',
      'Agent-Os-0.2.9-mac-arm64.dmg.blockmap'
    ])
    expect(assertDesktopReleaseArtifacts(release, '0.2.9', provenance).assets).toHaveLength(2)
  })

  it('拒绝 stale bundle、缺 manifest 或打包后被替换的安装包', () => {
    const { root, release, dmg } = fixture()
    writeFileSync(join(root, 'out', 'main', 'index.js'), 'const sourceRevision = "stale"\n')
    expect(() => writeDesktopReleaseManifest({ outDir: release, artifactPaths: [dmg] }, root, provenance))
      .toThrow('未内嵌当前 source revision')

    writeFileSync(join(root, 'out', 'main', 'index.js'), `const sourceRevision = ${JSON.stringify(provenance.sourceRevision)}\n`)
    expect(() => assertDesktopReleaseArtifacts(release, '0.2.9', provenance)).toThrow('缺少构建时 manifest')
    writeDesktopReleaseManifest({ outDir: release, artifactPaths: [dmg] }, root, provenance)
    writeFileSync(dmg, `${readFileSync(dmg, 'utf8')} tampered`)
    expect(() => assertDesktopReleaseArtifacts(release, '0.2.9', provenance)).toThrow('不一致')
  })
})
