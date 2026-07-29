#!/usr/bin/env node
// SPEC-032：把 electron-builder 实际产出的桌面制品绑定到源码 provenance。

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const {
  assertCompatibleProvenance,
  buildLocalReleaseProvenance
} = require('./release-provenance.cjs')

const ROOT = path.resolve(__dirname, '..')

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function isDesktopArtifactName(name, version) {
  return name.startsWith(`Agent-Os-${version}-`) || /^latest(?:-.+)?\.ya?ml$/i.test(name)
}

function desktopManifestName(version, platform, architecture) {
  return `agentos-desktop-${version}-${platform}${architecture ? `-${architecture}` : ''}-manifest.json`
}

function artifactPlatform(names, version) {
  const platforms = new Set(names.flatMap((name) => {
    const match = new RegExp(`^Agent-Os-${version.replace(/\./g, '\\.')}-(mac|win|linux)-`).exec(name)
    return match ? [match[1]] : []
  }))
  if (platforms.size !== 1) {
    throw new Error(`桌面制品必须且只能属于一个平台，实际：${[...platforms].join(', ') || 'missing'}`)
  }
  return [...platforms][0]
}

function artifactArchitectures(names, version, platform) {
  const escapedVersion = version.replace(/\./g, '\\.')
  const architectures = new Set(names.flatMap((name) => {
    const match = new RegExp(`^Agent-Os-${escapedVersion}-${platform}-(arm64|x64|x86_64|amd64)(?:[.-]|$)`).exec(name)
    return match ? [match[1] === 'x86_64' || match[1] === 'amd64' ? 'x64' : match[1]] : []
  }))
  if (architectures.size === 0) throw new Error('桌面制品名称缺少可识别的原生架构')
  return [...architectures].sort()
}

function assertBuiltSourceRevision(root, provenance) {
  const mainBundle = path.join(root, 'out', 'main', 'index.js')
  if (!fs.existsSync(mainBundle)) throw new Error('缺少 out/main/index.js，请先执行 npm run build')
  if (!fs.readFileSync(mainBundle, 'utf8').includes(provenance.sourceRevision)) {
    throw new Error(`桌面 bundle 未内嵌当前 source revision：${provenance.sourceRevision}`)
  }
}

function writeDesktopReleaseManifest(buildResult, root = ROOT, provenance = buildLocalReleaseProvenance(root)) {
  assertBuiltSourceRevision(root, provenance)
  const version = provenance.version
  const artifactPaths = [...new Set(buildResult.artifactPaths || [])]
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .filter((file) => isDesktopArtifactName(path.basename(file), version))
  const names = artifactPaths.map((file) => path.basename(file))
  const platform = artifactPlatform(names, version)
  const architectures = artifactArchitectures(names, version, platform)
  const assets = artifactPaths
    .map((file) => ({
      name: path.basename(file),
      bytes: fs.statSync(file).size,
      sha256: sha256File(file)
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const manifest = {
    schemaVersion: 1,
    version,
    platform,
    architectures,
    provenance,
    generatedAt: new Date().toISOString(),
    assets
  }
  fs.mkdirSync(buildResult.outDir, { recursive: true })
  const output = path.join(
    buildResult.outDir,
    desktopManifestName(version, platform, architectures.length === 1 ? architectures[0] : undefined)
  )
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
  return { output, manifest }
}

function assertDesktopReleaseArtifacts(releaseDir, version, expectedProvenance) {
  const names = fs.readdirSync(releaseDir)
  const desktopAssets = names.filter((name) => isDesktopArtifactName(name, version))
  if (desktopAssets.length === 0) return { assets: [], manifests: [] }
  const manifestPattern = new RegExp(`^agentos-desktop-${version.replace(/\./g, '\\.')}-(?:mac|win|linux)(?:-(?:arm64|x64))?-manifest\\.json$`)
  const manifestNames = names.filter((name) => manifestPattern.test(name))
  if (manifestNames.length === 0) {
    throw new Error('桌面制品缺少构建时 manifest，无法排除 release/ 残留旧安装包')
  }
  const verified = new Map()
  for (const manifestName of manifestNames) {
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, manifestName), 'utf8'))
    if (manifest.schemaVersion !== 1 || manifest.version !== version) {
      throw new Error(`${manifestName} 格式或版本无效`)
    }
    assertCompatibleProvenance(expectedProvenance, manifest.provenance, manifestName)
    for (const asset of manifest.assets || []) {
      if (!isDesktopArtifactName(asset?.name || '', version) || path.basename(asset.name) !== asset.name) {
        throw new Error(`${manifestName} 包含非法桌面制品路径`)
      }
      if (!Number.isInteger(asset.bytes) || asset.bytes < 0 || !/^[a-f0-9]{64}$/i.test(asset.sha256 || '')) {
        throw new Error(`${manifestName} 包含无效桌面制品记录：${asset.name}`)
      }
      const previous = verified.get(asset.name)
      if (previous && (previous.bytes !== asset.bytes || previous.sha256 !== asset.sha256)) {
        throw new Error(`${asset.name} 在多个桌面 manifest 中记录不一致`)
      }
      verified.set(asset.name, asset)
    }
  }
  for (const name of desktopAssets) {
    const file = path.join(releaseDir, name)
    const record = verified.get(name)
    if (!record) throw new Error(`${name} 未被当前 source revision 的桌面 manifest 覆盖`)
    const bytes = fs.statSync(file).size
    const digest = sha256File(file)
    if (record.bytes !== bytes || record.sha256 !== digest) {
      throw new Error(`${name} 与构建时桌面 manifest 不一致，可能是残留或被替换的制品`)
    }
  }
  return { assets: desktopAssets, manifests: manifestNames }
}

module.exports = {
  artifactArchitectures,
  artifactPlatform,
  assertBuiltSourceRevision,
  assertDesktopReleaseArtifacts,
  desktopManifestName,
  isDesktopArtifactName,
  sha256File,
  writeDesktopReleaseManifest
}
