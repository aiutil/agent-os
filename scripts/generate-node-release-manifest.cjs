#!/usr/bin/env node
// SPEC-032：为当前版本节点制品生成可发布的 SHA-256 完整性清单。

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { buildLocalReleaseProvenance } = require('./release-provenance.cjs')

const ROOT = path.resolve(__dirname, '..')
const releaseDir = path.join(ROOT, 'release')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const provenance = buildLocalReleaseProvenance(ROOT)
const prefix = `agentos-node-${version}-`
const REQUIRED_PLATFORMS = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-x64']

function verifyArchiveFiles(file) {
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-node-manifest-'))
  try {
    execFileSync('tar', ['-xzf', file, '-C', extracted], { stdio: 'ignore' })
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-node-runtime.cjs'), extracted], {
      stdio: 'ignore'
    })
    return { fileIntegrityVerified: true }
  } catch (error) {
    return {
      fileIntegrityVerified: false,
      integrityError: error instanceof Error ? error.message : String(error)
    }
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true })
  }
}

if (!fs.existsSync(releaseDir)) {
  console.error(`✗ 未找到 ${releaseDir}`)
  process.exit(1)
}

const assets = fs.readdirSync(releaseDir)
  .filter((name) => name.startsWith(prefix) && name.endsWith('.tar.gz'))
  .sort()
  .map((name) => {
    const file = path.join(releaseDir, name)
    let runtime = null
    for (const member of ['./runtime-manifest.json', 'runtime-manifest.json']) {
      try {
        runtime = JSON.parse(execFileSync('tar', ['-xOf', file, member], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        }))
        break
      } catch {
        // 尝试下一种 tar 成员路径。
      }
    }
    return {
      name,
      bytes: fs.statSync(file).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      runtime,
      ...verifyArchiveFiles(file)
    }
  })

if (assets.length === 0) {
  console.error(`✗ release/ 下没有 ${prefix}<platform>.tar.gz`)
  process.exit(1)
}
const names = new Set(assets.map((asset) => asset.name))
const missingAssets = REQUIRED_PLATFORMS
  .map((platform) => `${prefix}${platform}.tar.gz`)
  .filter((name) => !names.has(name))
if (missingAssets.length > 0) {
  console.error('✗ 节点 Release 必须一次齐全五个平台，缺少：')
  missingAssets.forEach((name) => console.error(`   ${name}`))
  process.exit(1)
}

for (const asset of assets) {
  if (asset.runtime?.sourceRevision !== provenance.sourceRevision) {
    console.error(`✗ ${asset.name} 的 source revision 与当前构建不一致`)
    console.error(`  制品：${asset.runtime?.sourceRevision || 'missing'}`)
    console.error(`  当前：${provenance.sourceRevision}`)
    process.exit(1)
  }
}
const manifest = {
  schemaVersion: 2,
  version,
  provenance,
  generatedAt: new Date().toISOString(),
  assets
}
const output = path.join(releaseDir, `agentos-node-${version}-manifest.json`)
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`✓ ${path.relative(ROOT, output)} (${assets.length} 个节点制品)`)
