#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process, fetch, AbortSignal, setTimeout, console, URL */
// SPEC-032：发布写入后从公开 Release 重新读取并验收五平台节点制品。
// 本脚本不信任本地 release/：必须看到远端 asset、manifest 与下载 URL 全部就绪。

const fs = require('node:fs')
const path = require('node:path')
const {
  assertCompatibleProvenance,
  buildLocalReleaseProvenance,
  provenanceAssetName
} = require('./release-provenance.cjs')

const ROOT = path.resolve(__dirname, '..')
const REPO = 'aiutil/agent-os'
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const localProvenance = buildLocalReleaseProvenance(ROOT)
const tag = `v${version}`
const protocolSource = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'types', 'runtime.ts'), 'utf8')
const protocolVersion = Number(/RUNTIME_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(protocolSource)?.[1] ?? 0)
const apiBase = (process.env.AGENT_OS_RELEASE_API_BASE || 'https://api.github.com').replace(/\/$/, '')
const platforms = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-x64']
const manifestName = `agentos-node-${version}-manifest.json`
const provenanceName = provenanceAssetName(version)
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'agent-os-public-node-release-check'
}

function requireHttps(value, label = '公开 URL') {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} 无效`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} 必须使用 HTTPS`)
  if (parsed.username || parsed.password) throw new Error(`${label} 不得包含内嵌凭证`)
  return parsed
}

const apiOrigin = requireHttps(apiBase, 'GitHub API 地址').origin

async function request(url, init = {}, redirects = 5) {
  const parsed = requireHttps(url)
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const requestHeaders = { ...headers, ...(init.headers || {}) }
      if (process.env.GH_TOKEN && parsed.origin === apiOrigin) {
        requestHeaders.authorization = `Bearer ${process.env.GH_TOKEN}`
      } else {
        delete requestHeaders.authorization
      }
      const response = await fetch(parsed, {
        ...init,
        headers: requestHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000)
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error(`${parsed} 重定向缺少 Location`)
        if (redirects <= 0) throw new Error(`${parsed} 重定向次数过多`)
        const target = requireHttps(new URL(location, parsed).toString(), '公开重定向目标')
        return await request(target.toString(), init, redirects - 1)
      }
      if (response.ok || (response.status < 500 && response.status !== 429)) return response
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
  }
  throw lastError
}

function validRuntime(entry, platform) {
  const runtime = entry?.runtime
  return entry?.name === `agentos-node-${version}-${platform}.tar.gz` &&
    /^[a-f0-9]{64}$/i.test(entry?.sha256 || '') &&
    entry?.fileIntegrityVerified === true &&
    runtime?.selfContainedNodeRuntime === true &&
    runtime?.appVersion === version &&
    runtime?.platform === platform &&
    runtime?.protocolVersion === protocolVersion &&
    runtime?.sourceRevision === localProvenance.sourceRevision &&
    /^20\./.test(runtime?.nodeVersion || '') &&
    /^\d+$/.test(runtime?.nodeAbi || '') &&
    Array.isArray(runtime?.files) && runtime.files.length > 0 &&
    runtime.files.every((file) =>
      typeof file?.path === 'string' && file.path.length > 0 &&
      Number.isInteger(file?.bytes) && file.bytes >= 0 &&
      /^[a-f0-9]{64}$/i.test(file?.sha256 || '')
    )
}

function remoteAssetMatchesManifest(asset, entry) {
  return Number.isInteger(asset?.size) && asset.size === entry?.bytes &&
    String(asset?.digest || '').toLowerCase() === `sha256:${String(entry?.sha256 || '').toLowerCase()}`
}

async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('安全拒绝：NODE_TLS_REJECT_UNAUTHORIZED=0 会关闭 HTTPS 证书校验。请移除该变量；企业 CA 请使用 NODE_EXTRA_CA_CERTS。')
  }
  const releaseResponse = await request(`${apiBase}/repos/${REPO}/releases/tags/${tag}`)
  if (!releaseResponse.ok) throw new Error(`公开 Release ${tag} 不可用：HTTP ${releaseResponse.status}`)
  const release = await releaseResponse.json()
  const assets = Array.isArray(release.assets) ? release.assets : []
  const byName = new Map(assets.filter((asset) => asset?.name).map((asset) => [asset.name, asset]))
  const manifestAsset = byName.get(manifestName)
  if (!manifestAsset?.browser_download_url) throw new Error(`公开 Release 缺少 ${manifestName}`)
  const provenanceAsset = byName.get(provenanceName)
  if (!provenanceAsset?.browser_download_url) throw new Error(`公开 Release 缺少 ${provenanceName}`)

  const provenanceResponse = await request(provenanceAsset.browser_download_url)
  if (!provenanceResponse.ok) throw new Error(`公开 provenance 下载失败：HTTP ${provenanceResponse.status}`)
  const publicProvenance = await provenanceResponse.json()
  assertCompatibleProvenance(localProvenance, publicProvenance, '公开 Release provenance')

  const manifestResponse = await request(manifestAsset.browser_download_url)
  if (!manifestResponse.ok) throw new Error(`公开 manifest 下载失败：HTTP ${manifestResponse.status}`)
  const manifest = await manifestResponse.json()
  if (manifest?.version !== version) throw new Error(`manifest 版本不一致：${manifest?.version || '-'} / ${version}`)
  assertCompatibleProvenance(localProvenance, manifest?.provenance, '节点 aggregate manifest provenance')
  const entries = Array.isArray(manifest.assets) ? manifest.assets : []
  const entryByName = new Map(entries.filter((entry) => entry?.name).map((entry) => [entry.name, entry]))

  for (const platform of platforms) {
    const name = `agentos-node-${version}-${platform}.tar.gz`
    const remoteAsset = byName.get(name)
    const manifestEntry = entryByName.get(name)
    if (!remoteAsset?.browser_download_url) throw new Error(`公开 Release 缺少 ${name}`)
    if (!validRuntime(manifestEntry, platform)) throw new Error(`${name} 的 manifest/runtime/协议/全文件校验不完整`)
    if (!remoteAssetMatchesManifest(remoteAsset, manifestEntry)) {
      throw new Error(`${name} 的公开 bytes/SHA-256 与 manifest 不一致`)
    }
    const downloadProbe = await request(remoteAsset.browser_download_url, { method: 'HEAD' })
    if (!downloadProbe.ok) throw new Error(`${name} 下载 URL 不可用：HTTP ${downloadProbe.status}`)
    console.log(`✓ ${name}`)
  }
  console.log(`✓ 公开节点 Release ${tag}：五平台、manifest 与下载 URL 全部就绪`)
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
