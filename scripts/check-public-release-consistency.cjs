#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, __dirname, process, fetch, AbortSignal, Buffer, setTimeout, console, URL */
// SPEC-032：核对 package、Latest Release、GitHub Pages、公开 README 与安装脚本内容。

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const {
  buildLocalReleaseProvenance,
  provenanceAssetName,
  provenanceDifferences
} = require('./release-provenance.cjs')

const ROOT = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const repo = 'aiutil/agent-os'
const versionsOnly = process.argv.includes('--versions-only')
const prePublish = process.argv.includes('--pre-publish')
const apiBase = (process.env.AGENT_OS_RELEASE_API_BASE || 'https://api.github.com').replace(/\/$/, '')
const pageUrl = process.env.AGENT_OS_RELEASE_PAGE_URL || 'https://agentos.aiutil.com/'
const readmeUrl = process.env.AGENT_OS_RELEASE_README_URL || `https://raw.githubusercontent.com/${repo}/main/README.md`
const localInstallScript = fs.readFileSync(path.join(ROOT, 'scripts', 'install-node.sh'))
const localProvenance = buildLocalReleaseProvenance(ROOT)

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function pageCurrentVersion(content) {
  return /<span\s+class=["']version["']>v(\d+\.\d+\.\d+)<\/span>/i.exec(content)?.[1] || ''
}

function readmeCurrentVersion(content) {
  return /Version `(\d+\.\d+\.\d+)`/.exec(content)?.[1] ||
    /当前最新版本：\*\*v(\d+\.\d+\.\d+)\*\*\s*·\s*\d{4}-\d{2}-\d{2}/.exec(content)?.[1] ||
    /releases\/tag\/v(\d+\.\d+\.\d+)/.exec(content)?.[1] ||
    ''
}

async function fetchBuffer(url, accept, attempts = 3, redirects = 5) {
  const parsed = requireHttps(url)
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(parsed, {
        headers: { 'user-agent': 'agent-os-release-consistency', ...(accept ? { accept } : {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000)
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error(`${parsed} 重定向缺少 Location`)
        if (redirects <= 0) throw new Error(`${parsed} 重定向次数过多`)
        const target = requireHttps(new URL(location, parsed).toString(), '公开重定向目标')
        return await fetchBuffer(target.toString(), accept, attempts, redirects - 1)
      }
      if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('安全拒绝：NODE_TLS_REJECT_UNAUTHORIZED=0 会关闭 HTTPS 证书校验。请移除该变量；企业 CA 请使用 NODE_EXTRA_CA_CERTS。')
  }
  const [latestBuffer, pageBuffer, readmeBuffer] = await Promise.all([
    fetchBuffer(`${apiBase}/repos/${repo}/releases/latest`, 'application/vnd.github+json'),
    fetchBuffer(pageUrl),
    fetchBuffer(readmeUrl)
  ])
  const latest = JSON.parse(latestBuffer.toString('utf8'))
  const pageHtml = pageBuffer.toString('utf8')
  const readme = readmeBuffer.toString('utf8')
  const pageVersion = pageCurrentVersion(pageHtml)
  const readmeVersion = readmeCurrentVersion(readme)
  const publicProvenanceAsset = (latest.assets || []).find(
    (asset) => asset?.name === provenanceAssetName(version)
  )
  const publicProvenanceBuffer = publicProvenanceAsset?.browser_download_url
    ? await fetchBuffer(publicProvenanceAsset.browser_download_url)
    : null
  let publicProvenance = null
  try {
    publicProvenance = publicProvenanceBuffer
      ? JSON.parse(publicProvenanceBuffer.toString('utf8'))
      : null
  } catch {
    publicProvenance = null
  }
  const provenanceDiff = provenanceDifferences(localProvenance, publicProvenance)
  const provenanceReady = provenanceDiff.length === 0 &&
    publicProvenance?.sourceTreeClean === true &&
    !/-dirty$/.test(publicProvenance?.sourceRevision || '')
  const desktopAssets = (latest.assets || []).filter((asset) =>
    typeof asset?.name === 'string' && asset.name.startsWith(`Agent-Os-${version}-`)
  )
  const requiredDesktopAssetNames = [
    `Agent-Os-${version}-mac-arm64.dmg`,
    `Agent-Os-${version}-mac-x64.dmg`,
    `Agent-Os-${version}-linux-arm64.AppImage`,
    `Agent-Os-${version}-linux-arm64.deb`,
    `Agent-Os-${version}-linux-x86_64.AppImage`,
    `Agent-Os-${version}-linux-amd64.deb`,
    `Agent-Os-${version}-win-x64-setup.exe`
  ]
  const requiredDesktopManifestNames = [
    `agentos-desktop-${version}-mac-arm64-manifest.json`,
    `agentos-desktop-${version}-mac-x64-manifest.json`,
    `agentos-desktop-${version}-linux-arm64-manifest.json`,
    `agentos-desktop-${version}-linux-x64-manifest.json`,
    `agentos-desktop-${version}-win-x64-manifest.json`
  ]
  const desktopManifestPattern = new RegExp(`^agentos-desktop-${version.replace(/\./g, '\\.')}-(?:mac|win|linux)(?:-(?:arm64|x64))?-manifest\\.json$`)
  const desktopManifestAssets = (latest.assets || []).filter((asset) =>
    typeof asset?.name === 'string' && desktopManifestPattern.test(asset.name)
  )
  const publicDesktopManifests = await Promise.all(desktopManifestAssets.map(async (asset) => {
    if (!asset.browser_download_url) return null
    try {
      return JSON.parse((await fetchBuffer(asset.browser_download_url)).toString('utf8'))
    } catch {
      return null
    }
  }))
  const desktopRecords = new Map()
  const publicAssetNames = new Set((latest.assets || []).map((asset) => asset?.name).filter(Boolean))
  let desktopManifestsReady = requiredDesktopAssetNames.every((name) => publicAssetNames.has(name)) &&
    requiredDesktopManifestNames.every((name) => publicAssetNames.has(name))
  for (const manifest of publicDesktopManifests) {
    const compatible = manifest?.schemaVersion === 1 && manifest.version === version &&
      provenanceDifferences(localProvenance, manifest?.provenance).length === 0 &&
      manifest?.provenance?.sourceTreeClean === true
    if (!compatible || !Array.isArray(manifest.assets)) {
      desktopManifestsReady = false
      continue
    }
    for (const asset of manifest.assets) {
      if (typeof asset?.name === 'string' && Number.isInteger(asset.bytes) && /^[a-f0-9]{64}$/i.test(asset.sha256 || '')) {
        desktopRecords.set(asset.name, asset)
      }
    }
  }
  const coveredDesktopAssets = desktopAssets.filter((asset) => {
    const record = desktopRecords.get(asset.name)
    return record && Number.isInteger(asset.size) && record.bytes === asset.size &&
      String(asset.digest || '').toLowerCase() === `sha256:${String(record.sha256).toLowerCase()}`
  })
  const coveredDesktopNames = new Set(coveredDesktopAssets.map((asset) => asset.name))
  const coveredRequiredDesktopAssets = requiredDesktopAssetNames.filter((name) => coveredDesktopNames.has(name))
  desktopManifestsReady = desktopManifestsReady &&
    coveredDesktopAssets.length === desktopAssets.length &&
    coveredRequiredDesktopAssets.length === requiredDesktopAssetNames.length
  const publicInstallAsset = versionsOnly
    ? null
    : (latest.assets || []).find((asset) => asset?.name === 'install-node.sh')
  const publicInstallScript = !versionsOnly && publicInstallAsset?.browser_download_url
    ? await fetchBuffer(publicInstallAsset.browser_download_url)
    : null
  const installDigest = publicInstallScript ? sha256(publicInstallScript) : ''
  const expectedInstallDigest = sha256(localInstallScript)
  const checks = [
    { label: 'package.json', ok: true, value: `v${version}` },
    ...(!prePublish ? [{ label: 'Latest Release', ok: latest.tag_name === `v${version}`, value: latest.tag_name || 'missing' }] : []),
    { label: 'GitHub Pages 当前版本标记', ok: pageVersion === version, value: pageVersion ? `v${pageVersion}` : 'missing' },
    { label: '公开 README 当前版本标记', ok: readmeVersion === version, value: readmeVersion ? `v${readmeVersion}` : 'missing' },
    ...(!prePublish ? [{
      label: '公开 Release provenance',
      ok: provenanceReady,
      value: publicProvenance?.sourceRevision || 'missing'
    }, {
      label: '公开桌面制品 manifest',
      ok: desktopManifestsReady,
      value: `${coveredRequiredDesktopAssets.length}/${requiredDesktopAssetNames.length}`
    }] : []),
    ...(!prePublish && !versionsOnly ? [{
      label: '公开 install-node.sh',
      ok: installDigest === expectedInstallDigest,
      value: installDigest ? `sha256:${installDigest.slice(0, 12)}` : 'missing'
    }] : [])
  ]
  for (const check of checks) {
    console.log(`${check.ok ? '✓' : '✗'} ${check.label}: ${check.value}`)
  }
  if (!prePublish && !provenanceReady && provenanceDiff.length > 0) {
    provenanceDiff.forEach((difference) => console.log(`  - ${difference}`))
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(`✗ 发布一致性检查失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
