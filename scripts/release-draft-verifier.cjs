#!/usr/bin/env node
/* Release draft metadata verification shared by the publisher and tests. */

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

function sha256File(file) {
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead = 0
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function localAssetRecords(files) {
  const records = files.map((file) => {
    const stat = fs.statSync(file)
    if (!stat.isFile()) throw new Error(`release asset is not a file: ${file}`)
    return {
      name: path.basename(file),
      bytes: stat.size,
      sha256: sha256File(file)
    }
  })
  const names = new Set()
  for (const record of records) {
    if (names.has(record.name)) throw new Error(`duplicate release asset name: ${record.name}`)
    names.add(record.name)
  }
  return records.sort((left, right) => left.name.localeCompare(right.name))
}

function releaseSourceMarker(sourceRevision) {
  if (!/^[a-f0-9]{40}$/i.test(sourceRevision || '')) {
    throw new Error(`invalid release source revision: ${sourceRevision || '-'}`)
  }
  return `<!-- agent-os-source:${sourceRevision.toLowerCase()} -->`
}

function assertRemoteReleaseMatches({
  release,
  expected,
  tag,
  sourceRevision,
  expectedDraft
}) {
  if (!release || release.tag_name !== tag) {
    throw new Error(`remote release tag mismatch: ${release?.tag_name || 'missing'} / ${tag}`)
  }
  if (release.draft !== expectedDraft) {
    throw new Error(`remote release draft state mismatch: ${String(release.draft)} / ${String(expectedDraft)}`)
  }
  const marker = releaseSourceMarker(sourceRevision)
  if (!String(release.body || '').includes(marker)) {
    throw new Error('remote release is not bound to the current source revision')
  }
  const remoteAssets = Array.isArray(release.assets) ? release.assets : []
  const remoteByName = new Map(remoteAssets.map((asset) => [asset?.name, asset]))
  const expectedByName = new Map(expected.map((asset) => [asset.name, asset]))
  const missing = expected.filter((asset) => !remoteByName.has(asset.name)).map((asset) => asset.name)
  const unexpected = remoteAssets
    .filter((asset) => !expectedByName.has(asset?.name))
    .map((asset) => asset?.name || '<unnamed>')
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`remote release asset set mismatch; missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`)
  }
  for (const expectedAsset of expected) {
    const remote = remoteByName.get(expectedAsset.name)
    if (!Number.isInteger(remote?.size) || remote.size !== expectedAsset.bytes) {
      throw new Error(`${expectedAsset.name} remote size mismatch: ${remote?.size ?? 'missing'} / ${expectedAsset.bytes}`)
    }
    const digest = String(remote?.digest || '').toLowerCase()
    if (digest !== `sha256:${expectedAsset.sha256.toLowerCase()}`) {
      throw new Error(`${expectedAsset.name} remote digest mismatch: ${digest || 'missing'}`)
    }
  }
  return {
    assets: expected.length,
    bytes: expected.reduce((total, asset) => total + asset.bytes, 0)
  }
}

module.exports = {
  assertRemoteReleaseMatches,
  localAssetRecords,
  releaseSourceMarker,
  sha256File
}
