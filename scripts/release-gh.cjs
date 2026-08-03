#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, __dirname, console */
// 把 release/ 下当前版本的安装包（制品）发布到 canonical 仓库，或发布到受限的迁移桥仓库。
// 仅上传制品，不上传源码。既可本地手动执行，也由 node-runtime-release workflow 在五平台产包汇总后调用。
// 要求 gh 当前登录账号（或 GH_TOKEN 对应账号）对目标仓库有写权限。
//
// 用法：
//   npm run pack:mac           # 先在对应平台打包（mac 产 dmg / win 产 exe / linux 产 AppImage+deb）
//   node scripts/release-gh.cjs   # 创建/更新 v<version> release 并上传当前平台已有制品
//   node scripts/release-gh.cjs --dry-run # 只做制品/清单门禁，绝不写 GitHub
//   node scripts/release-gh.cjs --repo lohasle/agent-life --stage-only # 仅用于迁移桥
//   node scripts/release-gh.cjs --notes "本次更新说明"   # 自定义说明（默认 --generate-notes）

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const {
  assertCompatibleProvenance,
  assertPublishSource,
  normalizeGithubRepository,
  provenanceAssetName,
  writeLocalReleaseProvenance
} = require('./release-provenance.cjs')
const { assertDesktopReleaseArtifacts } = require('./desktop-release-manifest.cjs')
const {
  assertRemoteReleaseMatches,
  localAssetRecords,
  releaseSourceMarker
} = require('./release-draft-verifier.cjs')
const {
  materializePublishedManifest,
  reusablePublishedManifestAsset
} = require('./published-release-manifest.cjs')

const ROOT = path.resolve(__dirname, '..')
const CANONICAL_REPO = 'aiutil/agent-os'
const LEGACY_REPO = 'lohasle/agent-life'
const ALLOWED_RELEASE_REPOS = new Set([CANONICAL_REPO, LEGACY_REPO])
const repoIndex = process.argv.indexOf('--repo')
const REPO = repoIndex >= 0 ? process.argv[repoIndex + 1] : CANONICAL_REPO
if (!ALLOWED_RELEASE_REPOS.has(REPO)) {
  console.error(`✗ 不允许的发布目标：${REPO || '<empty>'}`)
  console.error(`  允许目标仅为：${Array.from(ALLOWED_RELEASE_REPOS).join(', ')}`)
  process.exit(1)
}
const RELEASE_DIR = path.join(ROOT, 'release')

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
if (REPO === LEGACY_REPO && version !== '0.3.9') {
  console.error(`✗ ${LEGACY_REPO} 只允许发布 v0.3.9 迁移桥；当前版本为 v${version}`)
  process.exit(1)
}
const tag = `v${version}`
const dryRun = process.argv.includes('--dry-run')
const stageOnly = process.argv.includes('--stage-only')
const promoteOnly = process.argv.includes('--promote-only')
const reuseExistingNodeManifest = process.env.AGENTOS_REUSE_EXISTING_NODE_MANIFEST === 'true'
if (stageOnly && promoteOnly) {
  console.error('✗ --stage-only 与 --promote-only 不能同时使用')
  process.exit(1)
}

function sh(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })
  return out == null ? '' : String(out).trim()
}

function findReleaseByTag() {
  const releases = JSON.parse(sh('gh', ['api', `repos/${REPO}/releases?per_page=100`]))
  return Array.isArray(releases)
    ? releases.find((release) => release?.tag_name === tag) || null
    : null
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function waitForVerifiedRelease(expected, expectedDraft) {
  let lastError
  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const release = findReleaseByTag()
    try {
      const result = assertRemoteReleaseMatches({
        release,
        expected,
        tag,
        sourceRevision: localProvenance.sourceRevision,
        expectedDraft
      })
      return { release, result }
    } catch (error) {
      lastError = error
      if (attempt < 15) sleep(2_000)
    }
  }
  throw lastError
}

function assertRemoteProvenance(release) {
  const name = provenanceAssetName(version)
  const asset = (release?.assets || []).find((item) => item?.name === name)
  if (!asset?.id) {
    throw new Error(`已存在的 ${tag} 缺少 ${name}，无法证明桌面二进制与当前源码同源。`)
  }
  const remoteRaw = sh('gh', [
    'api',
    `repos/${REPO}/releases/assets/${asset.id}`,
    '-H',
    'Accept: application/octet-stream'
  ])
  assertCompatibleProvenance(localProvenance, JSON.parse(remoteRaw), `已存在的 ${tag} provenance`)
}

// 1) 校验 gh 已安装。目标仓库由 allowlist 约束，写权限由 GitHub API 在实际操作时验证。
let activeUser = ''
if (dryRun) {
  activeUser = 'dry-run'
} else {
  try {
    activeUser = sh('gh', ['api', 'user', '--jq', '.login'])
  } catch (err) {
    console.error('✗ 未检测到可用的 gh CLI 或未登录。请先 `gh auth login`。')
    console.error(String(err.stderr || err.message || err))
    process.exit(1)
  }
}

// 桌面与节点制品不能只靠 SemVer 对齐。首发写 provenance，后续补传必须与既有记录完全一致。
if (!fs.existsSync(RELEASE_DIR)) {
  console.error(`✗ 未找到 ${RELEASE_DIR}，请先执行 pack:mac / pack:win / pack:linux。`)
  process.exit(1)
}
const { provenance: localProvenance } = writeLocalReleaseProvenance(ROOT, RELEASE_DIR)
if (!dryRun && !localProvenance.sourceTreeClean) {
  console.error('✗ 拒绝从未提交工作树发布；请先提交并提升版本。')
  process.exit(1)
}
if (!dryRun) {
  try {
    const localHead = sh('git', ['rev-parse', 'HEAD'])
    // 正式门禁绕开 AGENT_OS_SOURCE_* 覆盖值，并且不信任可被改写的 origin 回答 main commit。
    const actualSourceTreeClean =
      sh('git', ['status', '--porcelain', '--untracked-files=all']).length === 0
    const actualSourceRepository = normalizeGithubRepository(
      sh('git', ['remote', 'get-url', 'origin'])
    )
    const remoteMainCommit = sh('gh', [
      'api',
      `repos/${CANONICAL_REPO}/git/ref/heads/main`,
      '--jq',
      '.object.sha'
    ])
    assertPublishSource(localProvenance, {
      localHead,
      remoteMainCommit,
      actualSourceRepository,
      actualSourceTreeClean
    })
    console.log(`✓ 发布来源已绑定 ${CANONICAL_REPO} main：${localHead.slice(0, 12)}`)
  } catch (error) {
    console.error(`✗ 发布来源门禁失败：${error instanceof Error ? error.message : String(error)}`)
    console.error('  只能从已推送且与远端 main 精确一致的 Agent-OS commit 发布 Latest。')
    process.exit(1)
  }
}

try {
  const desktop = assertDesktopReleaseArtifacts(RELEASE_DIR, version, localProvenance)
  if (desktop.assets.length > 0) {
    console.log(`✓ 桌面制品与构建时 provenance manifest 一致（${desktop.assets.length} 个文件）`)
  }
} catch (error) {
  console.error(`✗ 桌面制品来源校验失败：${error instanceof Error ? error.message : String(error)}`)
  console.error(
    '  请删除残留制品，并从当前干净 source revision 重新执行 pack:mac / pack:win / pack:linux。'
  )
  process.exit(1)
}

// 2) 收集当前版本的安装包制品。存在节点包时先生成同版本 SHA-256 清单。
const hasNodeAssets = fs
  .readdirSync(RELEASE_DIR)
  .some((f) => f.startsWith(`agentos-node-${version}-`) && f.endsWith('.tar.gz'))
const nodeManifestPath = path.join(RELEASE_DIR, `agentos-node-${version}-manifest.json`)
const runtimeSource = fs.readFileSync(
  path.join(ROOT, 'src', 'shared', 'types', 'runtime.ts'),
  'utf8'
)
const protocolVersion = Number(/RUNTIME_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(runtimeSource)?.[1] ?? 0)
const requiredNodePlatforms = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-x64']
let reusedPublishedManifest = false
if (hasNodeAssets && !dryRun) {
  try {
    const release = findReleaseByTag()
    const asset = reusablePublishedManifestAsset({
      release,
      tag,
      sourceRevision: localProvenance.sourceRevision,
      manifestName: path.basename(nodeManifestPath)
    })
    if (asset) {
      assertRemoteProvenance(release)
      const bytes = execFileSync(
        'gh',
        [
          'api',
          `repos/${REPO}/releases/assets/${asset.id}`,
          '-H',
          'Accept: application/octet-stream'
        ],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      materializePublishedManifest({
        bytes,
        asset,
        targetPath: nodeManifestPath,
        sourceRevision: localProvenance.sourceRevision,
        version,
        protocolVersion,
        requiredPlatforms: requiredNodePlatforms
      })
      reusedPublishedManifest = true
      console.log(`✓ 已复用公开 ${tag} 的 aggregate manifest；后续仅执行只读 exact postcheck`)
    }
  } catch (error) {
    console.error(
      `✗ 公开 aggregate manifest 复用失败：${error instanceof Error ? error.message : String(error)}`
    )
    process.exit(1)
  }
}
// stage-only 上传的 manifest 必须与 promote-only 校验的 bytes 完全相同；
// generatedAt 会令二次生成产生不同 digest，因此晋升阶段只复用已验证文件。
if (hasNodeAssets && !promoteOnly && !reusedPublishedManifest) {
  if (reuseExistingNodeManifest) {
    if (!fs.existsSync(nodeManifestPath)) {
      console.error('✗ 要求复用本次 run 的 aggregate manifest，但本地文件不存在。')
      process.exit(1)
    }
    console.log('✓ 复用本次 run 已生成并校验过的 aggregate manifest，保持迁移双仓 bytes 一致')
  } else {
    try {
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts', 'generate-node-release-manifest.cjs')],
        {
          cwd: ROOT,
          stdio: 'inherit'
        }
      )
    } catch {
      console.error('✗ 节点 aggregate manifest 生成失败，已停止发布。')
      process.exit(1)
    }
  }
}
const nodeManifest = fs.existsSync(nodeManifestPath)
  ? JSON.parse(fs.readFileSync(nodeManifestPath, 'utf8'))
  : { assets: [] }
const validNodeAsset = (asset) => {
  const runtime = asset.runtime
  return (
    asset.fileIntegrityVerified === true &&
    runtime?.selfContainedNodeRuntime === true &&
    runtime.appVersion === version &&
    runtime.protocolVersion === protocolVersion &&
    runtime.sourceRevision === localProvenance.sourceRevision &&
    /^20\./.test(runtime.nodeVersion || '') &&
    /^\d+$/.test(runtime.nodeAbi || '') &&
    Array.isArray(runtime.files) &&
    runtime.files.length > 0 &&
    asset.name === `agentos-node-${version}-${runtime.platform}.tar.gz`
  )
}
const invalidNodeAssets = (nodeManifest.assets || []).filter((asset) => !validNodeAsset(asset))
if (hasNodeAssets && invalidNodeAssets.length > 0) {
  console.error('✗ 拒绝发布不完整的节点制品：')
  invalidNodeAssets.forEach((asset) =>
    console.error(
      `   ${asset.name}（缺少固定 runtime / 协议 / 平台 / 文件清单，或 archive 全文件校验失败）`
    )
  )
  process.exit(1)
}
const publishableNodeAssets = new Set(
  (nodeManifest.assets || []).filter(validNodeAsset).map((asset) => asset.name)
)
const requiredNodeAssets = requiredNodePlatforms.map(
  (platform) => `agentos-node-${version}-${platform}.tar.gz`
)
const requiredDesktopAssets = [
  `Agent-Os-${version}-mac-arm64.dmg`,
  `Agent-Os-${version}-mac-x64.dmg`,
  `Agent-Os-${version}-linux-arm64.AppImage`,
  `Agent-Os-${version}-linux-arm64.deb`,
  `Agent-Os-${version}-linux-x86_64.AppImage`,
  `Agent-Os-${version}-linux-amd64.deb`,
  `Agent-Os-${version}-win-x64-setup.exe`
]
const requiredDesktopManifests = [
  `agentos-desktop-${version}-mac-arm64-manifest.json`,
  `agentos-desktop-${version}-mac-x64-manifest.json`,
  `agentos-desktop-${version}-linux-arm64-manifest.json`,
  `agentos-desktop-${version}-linux-x64-manifest.json`,
  `agentos-desktop-${version}-win-x64-manifest.json`
]
const missingCompleteBundle = [
  ...requiredNodeAssets.filter((name) => !publishableNodeAssets.has(name)),
  ...requiredDesktopAssets.filter((name) => !fs.existsSync(path.join(RELEASE_DIR, name))),
  ...requiredDesktopManifests.filter((name) => !fs.existsSync(path.join(RELEASE_DIR, name))),
  ...(!fs.existsSync(nodeManifestPath) ? [path.basename(nodeManifestPath)] : []),
  ...(!fs.existsSync(path.join(RELEASE_DIR, provenanceAssetName(version)))
    ? [provenanceAssetName(version)]
    : []),
  ...(!fs.existsSync(path.join(ROOT, 'scripts', 'install-node.sh')) ? ['install-node.sh'] : [])
]
if (missingCompleteBundle.length > 0) {
  console.error(
    '✗ 正式 Release 必须由同一 source revision 一次汇总桌面与五平台节点制品，当前缺少：'
  )
  missingCompleteBundle.forEach((name) => console.error(`   ${name}`))
  console.error(
    '  请使用 Verified desktop and node release workflow 在五个原生 runner 完整构建后再发布。'
  )
  process.exit(1)
}
const ASSET_EXT = ['.dmg', '.exe', '.AppImage', '.deb', '.tar.gz', '.blockmap', '.json']
const assets = fs
  .readdirSync(RELEASE_DIR)
  .filter(
    (f) =>
      f.includes(version) &&
      ASSET_EXT.some((ext) => f.toLowerCase().endsWith(ext.toLowerCase())) &&
      (!f.startsWith(`agentos-node-${version}-`) ||
        !f.endsWith('.tar.gz') ||
        publishableNodeAssets.has(f))
  )
  .map((f) => path.join(RELEASE_DIR, f))

const hasPrimaryArtifact = assets.some((file) => {
  const name = path.basename(file)
  return (
    name.startsWith(`Agent-Os-${version}-`) ||
    (name.startsWith(`agentos-node-${version}-`) && name.endsWith('.tar.gz'))
  )
})
if (!hasPrimaryArtifact) {
  console.error(
    `✗ release/ 下没有 ${version} 的桌面制品或已验证节点包；禁止只发 provenance/安装脚本。`
  )
  process.exit(1)
}

for (const f of fs.readdirSync(RELEASE_DIR)) {
  if (/^latest(?:-.+)?\.ya?ml$/i.test(f)) assets.push(path.join(RELEASE_DIR, f))
}

// 远程节点一键安装脚本（非版本命名，固定附带）。
const installScript = path.join(ROOT, 'scripts', 'install-node.sh')
if (fs.existsSync(installScript)) assets.push(installScript)

if (assets.length === 0) {
  console.error(
    `✗ release/ 下没有匹配 ${version} 的制品（.dmg/.exe/.AppImage/.deb/.tar.gz）。先打包再发布。`
  )
  process.exit(1)
}
const expectedAssets = localAssetRecords(assets)
console.log(`→ 目标仓库 ${REPO}，tag ${tag}，账号 ${activeUser}`)
console.log('→ 待上传制品：')
assets.forEach((a) => console.log('   ' + path.basename(a)))

if (dryRun) {
  console.log('✓ dry-run 通过：未写入 GitHub')
  process.exit(0)
}

// 3) 解析说明参数。
const notesIdx = process.argv.indexOf('--notes')
const customNotes = notesIdx >= 0 ? process.argv[notesIdx + 1] : null
const sourceMarker = releaseSourceMarker(localProvenance.sourceRevision)

try {
  let release = findReleaseByTag()
  if (release && release.draft !== true) {
    try {
      assertRemoteProvenance(release)
      const verified = assertRemoteReleaseMatches({
        release,
        expected: expectedAssets,
        tag,
        sourceRevision: localProvenance.sourceRevision,
        expectedDraft: false
      })
      console.log(
        `✓ ${tag} 已公开且与本地 exact asset set 一致（${verified.assets} 个文件），无需重复上传`
      )
      process.exit(0)
    } catch (error) {
      console.error(
        `✗ 拒绝修改已公开的 ${tag}：${error instanceof Error ? error.message : String(error)}`
      )
      console.error(
        '  为避免同版本异实现，公开 Release 禁止补传或 --clobber；请提升 package.json 版本并整套重发。'
      )
      process.exit(1)
    }
  }

  if (promoteOnly) {
    if (!release || release.draft !== true) throw new Error(`没有可晋升的 ${tag} 私有 draft`)
    const draftVerification = waitForVerifiedRelease(expectedAssets, true)
    console.log(
      `✓ 待晋升 draft 仍与本地 exact asset set 一致（${draftVerification.result.assets} 个文件）`
    )
  } else {
    if (release) {
      if (!String(release.body || '').includes(sourceMarker)) {
        throw new Error(`已存在的 ${tag} draft 不属于当前 source revision，拒绝覆盖`)
      }
      const expectedNames = new Set(expectedAssets.map((asset) => asset.name))
      const unexpected = (release.assets || []).filter((asset) => !expectedNames.has(asset?.name))
      for (const asset of unexpected) {
        if (!asset?.id)
          throw new Error(`draft 中存在无法安全删除的未知资产：${asset?.name || '<unnamed>'}`)
        sh('gh', ['api', '-X', 'DELETE', `repos/${REPO}/releases/assets/${asset.id}`])
        console.log(`→ 已清理同源 draft 的过期资产：${asset.name}`)
      }
      console.log(`→ 复用同源 draft ${tag}，安全重试资产上传…`)
    } else {
      console.log(`→ 创建私有 draft ${tag}；完整性复验前不会公开…`)
      const legacyNotes =
        `Agent OS ${tag} migration bridge. Future updates and source are hosted at ` +
        `https://github.com/${CANONICAL_REPO}.`
      const notes = customNotes
        ? `${customNotes}\n\n${sourceMarker}`
        : `${REPO === LEGACY_REPO ? `${legacyNotes}\n\n` : ''}${sourceMarker}`
      const args = [
        'release',
        'create',
        tag,
        '--repo',
        REPO,
        '--title',
        `${tag} — Agent OS`,
        '--draft',
        '--latest=false',
        '--notes',
        notes
      ]
      if (!customNotes && REPO === CANONICAL_REPO) args.push('--generate-notes')
      sh('gh', args, { stdio: 'inherit' })
    }

    sh('gh', ['release', 'upload', tag, ...assets, '--repo', REPO, '--clobber'], {
      stdio: 'inherit'
    })
    const draftVerification = waitForVerifiedRelease(expectedAssets, true)
    console.log(`✓ draft 远端 bytes/SHA-256 全量一致（${draftVerification.result.assets} 个文件）`)
    if (stageOnly) {
      console.log(`✓ ${tag} 已安全暂存为私有 draft，尚未改变 Latest`)
      process.exit(0)
    }
  }

  sh('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false', '--latest'], {
    stdio: 'inherit'
  })
  try {
    const publicVerification = waitForVerifiedRelease(expectedAssets, false)
    console.log(`✓ 已原子晋升 Latest：https://github.com/${REPO}/releases/tag/${tag}`)
    console.log(
      `✓ 公开 Release exact asset set 复验通过（${publicVerification.result.assets} 个文件）`
    )
  } catch (error) {
    try {
      sh('gh', ['release', 'edit', tag, '--repo', REPO, '--draft', '--latest=false'], {
        stdio: 'inherit'
      })
    } catch (rollbackError) {
      console.error(
        `✗ 无法自动恢复为 draft：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
      )
    }
    throw new Error(
      `晋升后复验失败，已尝试恢复为 draft：${error instanceof Error ? error.message : String(error)}`
    )
  }
} catch (err) {
  console.error('✗ 发布失败：', String(err.stderr || err.message || err))
  console.error(
    '  若 draft 已创建，它会保持私有；修复网络或制品后可用同一 source revision 安全重试。'
  )
  process.exit(1)
}
