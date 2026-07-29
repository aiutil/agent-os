import { describe, expect, it, vi } from 'vitest'
import {
  checkNodeReleaseReadiness,
  nodeAssetName,
  nodeManifestName,
  releaseProvenanceName
} from '../src/main/domains/runtime/node-release-readiness'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'

const sourceRevision = 'a'.repeat(40)
const validProvenance = (version: string) => ({
  schemaVersion: 1,
  version,
  sourceRevision,
  sourceTreeClean: true,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  installNodeSha256: 'f'.repeat(64)
})
const validRuntime = (version: string, platform: string) => ({
  selfContainedNodeRuntime: true,
  appVersion: version,
  platform,
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  sourceRevision,
  nodeVersion: '20.17.0',
  nodeAbi: '115',
  files: [{ path: 'runtime/bin/node', bytes: 1, sha256: 'c'.repeat(64) }]
})

describe('SPEC-032 节点 Release exact-version 门禁', () => {
  it('资产、SHA-256 与包内固定 runtime 元数据齐全时平台才 ready', async () => {
    const version = '0.2.9'
    const asset = nodeAssetName(version, 'linux-x64')
    const manifestName = nodeManifestName(version)
    const provenanceName = releaseProvenanceName(version)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assets: [
          { name: asset },
          { name: manifestName, browser_download_url: 'https://download/manifest.json' },
          { name: provenanceName, browser_download_url: 'https://download/provenance.json' }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validProvenance(version)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version,
        provenance: validProvenance(version),
        assets: [{
          name: asset,
          sha256: 'a'.repeat(64),
          fileIntegrityVerified: true,
          runtime: validRuntime(version, 'linux-x64')
        }]
      }), { status: 200 }))

    const result = await checkNodeReleaseReadiness('aiutil/agent-os', version, sourceRevision, fetchMock)
    expect(result.platforms['linux-x64']).toMatchObject({ ready: true, sha256: 'a'.repeat(64) })
    expect(result.platforms['mac-arm64'].ready).toBe(false)
  })

  it('exact version 未发布时给出可操作错误，不生成乐观状态', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 404 }))
    const result = await checkNodeReleaseReadiness('aiutil/agent-os', '9.9.9', sourceRevision, fetchMock)
    expect(result.ready).toBe(false)
    expect(result.error).toContain('尚未发布')
  })

  it('清单内 runtime 平台与资产名不一致时拒绝安装', async () => {
    const version = '0.2.9'
    const asset = nodeAssetName(version, 'linux-x64')
    const manifestName = nodeManifestName(version)
    const provenanceName = releaseProvenanceName(version)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assets: [
          { name: asset },
          { name: manifestName, browser_download_url: 'https://download/manifest.json' },
          { name: provenanceName, browser_download_url: 'https://download/provenance.json' }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validProvenance(version)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version,
        provenance: validProvenance(version),
        assets: [{
          name: asset,
          sha256: 'b'.repeat(64),
          fileIntegrityVerified: true,
          runtime: validRuntime(version, 'mac-arm64')
        }]
      }), { status: 200 }))

    const result = await checkNodeReleaseReadiness('aiutil/agent-os', version, sourceRevision, fetchMock)
    expect(result.platforms['linux-x64'].ready).toBe(false)
    expect(result.platforms['linux-x64'].sha256).toBeUndefined()
    expect(result.platforms['linux-x64'].missing[0]).toContain('runtime-protocol-platform-files')
  })

  it('协议版本、Node 20 或文件清单缺失时不将制品标记为 ready', async () => {
    const version = '0.2.9'
    const asset = nodeAssetName(version, 'linux-x64')
    const manifestName = nodeManifestName(version)
    const provenanceName = releaseProvenanceName(version)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assets: [
          { name: asset },
          { name: manifestName, browser_download_url: 'https://download/manifest.json' },
          { name: provenanceName, browser_download_url: 'https://download/provenance.json' }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validProvenance(version)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version,
        provenance: validProvenance(version),
        assets: [{
          name: asset,
          sha256: 'd'.repeat(64),
          fileIntegrityVerified: true,
          runtime: { ...validRuntime(version, 'linux-x64'), protocolVersion: RUNTIME_PROTOCOL_VERSION - 1, files: [] }
        }]
      }), { status: 200 }))

    const result = await checkNodeReleaseReadiness('aiutil/agent-os', version, sourceRevision, fetchMock)
    expect(result.platforms['linux-x64'].ready).toBe(false)
    expect(result.platforms['linux-x64'].sha256).toBeUndefined()
  })

  it('外层 manifest 未证明 archive 全文件复验通过时拒绝安装', async () => {
    const version = '0.2.9'
    const asset = nodeAssetName(version, 'linux-x64')
    const manifestName = nodeManifestName(version)
    const provenanceName = releaseProvenanceName(version)
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assets: [
          { name: asset },
          { name: manifestName, browser_download_url: 'https://download/manifest.json' },
          { name: provenanceName, browser_download_url: 'https://download/provenance.json' }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(validProvenance(version)), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version,
        provenance: validProvenance(version),
        assets: [{
          name: asset,
          sha256: 'e'.repeat(64),
          fileIntegrityVerified: false,
          runtime: validRuntime(version, 'linux-x64')
        }]
      }), { status: 200 }))

    const result = await checkNodeReleaseReadiness('aiutil/agent-os', version, sourceRevision, fetchMock)
    expect(result.platforms['linux-x64'].ready).toBe(false)
    expect(result.platforms['linux-x64'].missing[0]).toContain('files-integrity')
  })

  it('同版本但 provenance/source revision 不同时 fail closed', async () => {
    const version = '0.2.9'
    const asset = nodeAssetName(version, 'linux-x64')
    const manifestName = nodeManifestName(version)
    const provenanceName = releaseProvenanceName(version)
    const staleProvenance = { ...validProvenance(version), sourceRevision: 'b'.repeat(40) }
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assets: [
          { name: asset },
          { name: manifestName, browser_download_url: 'https://download/manifest.json' },
          { name: provenanceName, browser_download_url: 'https://download/provenance.json' }
        ]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(staleProvenance), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        version,
        provenance: staleProvenance,
        assets: [{
          name: asset,
          sha256: 'e'.repeat(64),
          fileIntegrityVerified: true,
          runtime: { ...validRuntime(version, 'linux-x64'), sourceRevision: staleProvenance.sourceRevision }
        }]
      }), { status: 200 }))

    const result = await checkNodeReleaseReadiness('aiutil/agent-os', version, sourceRevision, fetchMock)
    expect(result.ready).toBe(false)
    expect(result.error).toContain('provenance')
    expect(result.platforms['linux-x64'].missing.join(' ')).toContain('source-revision')
  })

  it('未提交桌面构建不请求公开 Release，直接拒绝生成命令', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const result = await checkNodeReleaseReadiness(
      'aiutil/agent-os',
      '0.2.9',
      `${sourceRevision}-dirty`,
      fetchMock
    )
    expect(result.ready).toBe(false)
    expect(result.error).toContain('未提交工作树')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
