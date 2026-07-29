#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { releaseSourceMarker } = require('./release-draft-verifier.cjs')

function reusablePublishedManifestAsset({ release, tag, sourceRevision, manifestName }) {
  if (!release || release.tag_name !== tag || release.draft === true) return null
  if (!String(release.body || '').includes(releaseSourceMarker(sourceRevision))) {
    throw new Error(`已公开的 ${tag} 不属于当前 source revision，拒绝复用 aggregate manifest`)
  }
  const matches = (release.assets || []).filter((asset) => asset?.name === manifestName)
  if (matches.length !== 1 || !matches[0]?.id) {
    throw new Error(`已公开的 ${tag} 缺少唯一 ${manifestName}`)
  }
  const asset = matches[0]
  if (!Number.isInteger(asset.size) || !/^sha256:[a-f0-9]{64}$/i.test(String(asset.digest || ''))) {
    throw new Error(`已公开的 ${manifestName} 缺少 size/SHA-256 元数据`)
  }
  return asset
}

function materializePublishedManifest({
  bytes,
  asset,
  targetPath,
  sourceRevision,
  version,
  protocolVersion,
  requiredPlatforms
}) {
  if (!Buffer.isBuffer(bytes)) throw new Error('aggregate manifest 下载结果不是 bytes')
  if (bytes.length !== asset.size) {
    throw new Error(`aggregate manifest bytes 不一致：${bytes.length} / ${asset.size}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (`sha256:${digest}` !== String(asset.digest).toLowerCase()) {
    throw new Error('aggregate manifest SHA-256 与 GitHub 资产元数据不一致')
  }
  const manifest = JSON.parse(bytes.toString('utf8'))
  if (
    manifest?.provenance?.sourceRevision !== sourceRevision ||
    manifest?.version !== version ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error('aggregate manifest provenance/version/结构不一致')
  }
  const platforms = manifest.assets
    .filter(
      (entry) =>
        entry?.fileIntegrityVerified === true &&
        entry?.runtime?.sourceRevision === sourceRevision &&
        entry?.runtime?.appVersion === version &&
        entry?.runtime?.protocolVersion === protocolVersion
    )
    .map((entry) => entry.runtime.platform)
  const expectedPlatforms = [...requiredPlatforms].sort()
  const actualPlatforms = [...platforms].sort()
  if (
    actualPlatforms.length !== expectedPlatforms.length ||
    actualPlatforms.some((platform, index) => platform !== expectedPlatforms[index])
  ) {
    throw new Error(
      `aggregate manifest 平台集合不精确：期望 ${expectedPlatforms.join(', ')}；实际 ${actualPlatforms.join(', ')}`
    )
  }
  const temporary = `${targetPath}.${process.pid}.published.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600 })
    fs.renameSync(temporary, targetPath)
  } finally {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // rename 成功后临时文件已不存在；失败时清理不完整下载。
    }
  }
  try {
    fs.chmodSync(targetPath, 0o600)
  } catch {
    // Windows may not expose POSIX modes.
  }
  return path.basename(targetPath)
}

module.exports = {
  materializePublishedManifest,
  reusablePublishedManifestAsset
}
