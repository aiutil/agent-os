// SPEC-032：生成接入命令前核对 exact-version GitHub Release 节点制品。

import { RUNTIME_PROTOCOL_VERSION, type NodePlatform, type NodeReleaseReadiness } from '@shared/types'

export const NODE_RELEASE_PLATFORMS: NodePlatform[] = [
  'mac-arm64',
  'mac-x64',
  'linux-arm64',
  'linux-x64',
  'win-x64'
]

export function nodeAssetName(version: string, platform: NodePlatform): string {
  return `agentos-node-${version.replace(/^v/, '')}-${platform}.tar.gz`
}

export function nodeManifestName(version: string): string {
  return `agentos-node-${version.replace(/^v/, '')}-manifest.json`
}

export function releaseProvenanceName(version: string): string {
  return `agentos-release-${version.replace(/^v/, '')}-provenance.json`
}

export async function checkNodeReleaseReadiness(
  repo: string,
  version: string,
  expectedSourceRevision: string,
  fetchImpl: typeof fetch = fetch
): Promise<NodeReleaseReadiness> {
  const normalized = version.replace(/^v/, '')
  const manifestAsset = nodeManifestName(normalized)
  const provenanceAsset = releaseProvenanceName(normalized)
  const checkedAt = new Date().toISOString()
  const empty = (error?: string): NodeReleaseReadiness => ({
    repo,
    version: normalized,
    checkedAt,
    ready: false,
    manifestAsset,
    provenanceAsset,
    platforms: Object.fromEntries(NODE_RELEASE_PLATFORMS.map((platform) => [platform, {
      ready: false,
      asset: nodeAssetName(normalized, platform),
      missing: [nodeAssetName(normalized, platform), manifestAsset, provenanceAsset]
    }])) as NodeReleaseReadiness['platforms'],
    ...(error ? { error } : {})
  })
  if (!expectedSourceRevision || /-dirty$/.test(expectedSourceRevision)) {
    return empty('当前 Agent OS 来自未提交工作树，无法与公开节点制品建立可验证的一致性')
  }
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases/tags/v${normalized}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-os-node-readiness' },
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) {
      return empty(response.status === 404
        ? `v${normalized} 尚未发布，不能生成一条必然下载失败的接入命令`
        : `GitHub Release 检查失败：HTTP ${response.status}`)
    }
    const release = await response.json() as { assets?: Array<{ name?: string; browser_download_url?: string }> }
    const assets = release.assets ?? []
    const names = new Set(assets.map((asset) => asset.name).filter((name): name is string => Boolean(name)))
    const manifestDownload = assets.find((asset) => asset.name === manifestAsset)?.browser_download_url
    const provenanceDownload = assets.find((asset) => asset.name === provenanceAsset)?.browser_download_url
    type ReleaseProvenance = {
      schemaVersion?: number
      version?: string
      sourceRevision?: string
      sourceTreeClean?: boolean
      runtimeProtocolVersion?: number
      installNodeSha256?: string
    }
    let publicProvenance: ReleaseProvenance | null = null
    if (provenanceDownload) {
      const provenanceResponse = await fetchImpl(provenanceDownload, {
        headers: { 'user-agent': 'agent-os-node-readiness' },
        signal: AbortSignal.timeout(8_000)
      })
      if (provenanceResponse.ok) publicProvenance = await provenanceResponse.json() as ReleaseProvenance
    }
    const provenanceMatches = (value?: ReleaseProvenance | null): boolean =>
      value?.schemaVersion === 1 &&
      value.version === normalized &&
      value.sourceRevision === expectedSourceRevision &&
      value.sourceTreeClean === true &&
      value.runtimeProtocolVersion === RUNTIME_PROTOCOL_VERSION &&
      /^[a-f0-9]{64}$/i.test(value.installNodeSha256 ?? '')
    const publicProvenanceReady = provenanceMatches(publicProvenance)
    let verifiedAssets = new Map<string, { sha256: string; platform: string }>()
    if (manifestDownload) {
      const manifestResponse = await fetchImpl(manifestDownload, {
        headers: { 'user-agent': 'agent-os-node-readiness' },
        signal: AbortSignal.timeout(8_000)
      })
      if (manifestResponse.ok) {
        const manifest = await manifestResponse.json() as {
          version?: string
          provenance?: ReleaseProvenance
          assets?: Array<{
            name?: string
            sha256?: string
            fileIntegrityVerified?: boolean
            runtime?: {
              selfContainedNodeRuntime?: boolean
              appVersion?: string
              platform?: string
              protocolVersion?: number
              sourceRevision?: string
              nodeVersion?: string
              nodeAbi?: string
              files?: unknown[]
            }
          }>
        }
        if (manifest.version === normalized && publicProvenanceReady && provenanceMatches(manifest.provenance)) {
          verifiedAssets = new Map((manifest.assets ?? [])
            .filter((asset): asset is { name: string; sha256: string; runtime: { platform: string } } =>
              Boolean(asset.name) &&
              /^[a-f0-9]{64}$/i.test(asset.sha256 ?? '') &&
              asset.fileIntegrityVerified === true &&
              asset.runtime?.selfContainedNodeRuntime === true &&
              asset.runtime?.appVersion === normalized &&
              asset.runtime?.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
              asset.runtime?.sourceRevision === expectedSourceRevision &&
              /^20\./.test(asset.runtime?.nodeVersion ?? '') &&
              /^\d+$/.test(asset.runtime?.nodeAbi ?? '') &&
              Array.isArray(asset.runtime?.files) && asset.runtime.files.length > 0 &&
              Boolean(asset.runtime.platform)
            )
            .map((asset) => [asset.name, { sha256: asset.sha256, platform: asset.runtime.platform }]))
        }
      }
    }
    const platforms = Object.fromEntries(NODE_RELEASE_PLATFORMS.map((platform) => {
      const asset = nodeAssetName(normalized, platform)
      const verified = verifiedAssets.get(asset)
      const missing = [
        ...(!names.has(asset) ? [asset] : []),
        ...(!names.has(manifestAsset) ? [manifestAsset] : []),
        ...(!names.has(provenanceAsset) ? [provenanceAsset] : []),
        ...(names.has(provenanceAsset) && !publicProvenanceReady
          ? [`${provenanceAsset}#source-revision-protocol-install-sha`]
          : []),
        ...(names.has(asset) && (!verified || verified.platform !== platform)
          ? [`${asset}#sha256-runtime-protocol-platform-files-integrity`]
          : [])
      ]
      return [platform, {
        ready: missing.length === 0,
        asset,
        missing,
        ...(verified?.platform === platform ? { sha256: verified.sha256 } : {})
      }]
    })) as NodeReleaseReadiness['platforms']
    return {
      repo,
      version: normalized,
      checkedAt,
      ready: Object.values(platforms).every((item) => item.ready),
      manifestAsset,
      provenanceAsset,
      platforms,
      ...(!names.has(manifestAsset)
        ? { error: `Release 缺少完整性清单 ${manifestAsset}` }
        : !names.has(provenanceAsset)
          ? { error: `Release 缺少构建来源证明 ${provenanceAsset}` }
          : !publicProvenanceReady
            ? { error: 'Release provenance 与当前桌面构建不一致，已拒绝生成接入命令' }
            : {})
    }
  } catch (error) {
    return empty(`无法检查 GitHub Release：${error instanceof Error ? error.message : String(error)}`)
  }
}
