#!/usr/bin/env node
/* Verify that canonical and migration-bridge releases expose the exact same bytes. */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { releaseSourceMarker } = require('./release-draft-verifier.cjs')

const ROOT = path.resolve(__dirname, '..')
const CANONICAL_REPO = 'aiutil/agent-os'
const LEGACY_REPO = 'lohasle/agent-life'
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const tag = `v${pkg.version}`
const expectedDraft = process.argv.includes('--draft')

function tokenFor(repo) {
  const token =
    repo === CANONICAL_REPO
      ? process.env.CANONICAL_GH_TOKEN
      : process.env.LEGACY_GH_TOKEN
  if (!token) throw new Error(`missing release read token for ${repo}`)
  return token
}

function ghJson(repo) {
  const output = execFileSync('gh', ['api', `repos/${repo}/releases?per_page=100`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_TOKEN: tokenFor(repo) }
  })
  const releases = JSON.parse(output)
  return Array.isArray(releases)
    ? releases.find((release) => release?.tag_name === tag) || null
    : null
}

function normalizedAssets(release, repo) {
  if (release?.tag_name !== tag || release?.draft !== expectedDraft) {
    throw new Error(
      `${repo} release state mismatch: tag=${release?.tag_name || 'missing'} draft=${String(release?.draft)}`
    )
  }
  const sourceRevision = /<!-- agent-os-source:([a-f0-9]{40}) -->/i.exec(
    String(release.body || '')
  )?.[1]
  if (!sourceRevision || !String(release.body).includes(releaseSourceMarker(sourceRevision))) {
    throw new Error(`${repo} is missing a valid Agent OS source marker`)
  }
  const assets = (release.assets || []).map((asset) => ({
    name: asset?.name,
    bytes: asset?.size,
    digest: String(asset?.digest || '').toLowerCase()
  }))
  assets.sort((left, right) => String(left.name).localeCompare(String(right.name)))
  for (const asset of assets) {
    if (
      !asset.name ||
      !Number.isInteger(asset.bytes) ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
    ) {
      throw new Error(`${repo} contains an unverifiable asset: ${asset.name || '<unnamed>'}`)
    }
  }
  return { sourceRevision: sourceRevision.toLowerCase(), assets }
}

try {
  const canonical = normalizedAssets(ghJson(CANONICAL_REPO), CANONICAL_REPO)
  const legacy = normalizedAssets(ghJson(LEGACY_REPO), LEGACY_REPO)
  if (canonical.sourceRevision !== legacy.sourceRevision) {
    throw new Error(
      `source revision mismatch: ${canonical.sourceRevision} / ${legacy.sourceRevision}`
    )
  }
  if (JSON.stringify(canonical.assets) !== JSON.stringify(legacy.assets)) {
    throw new Error('canonical and legacy asset name/size/SHA-256 sets differ')
  }
  console.log(
    `✓ ${CANONICAL_REPO} and ${LEGACY_REPO} ${tag} are byte-identical (${canonical.assets.length} assets, draft=${expectedDraft})`
  )
} catch (error) {
  console.error(
    `✗ release mirror verification failed: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exit(1)
}
