#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, __dirname, console */
// SPEC-032：用源码 commit + protocol + 安装脚本哈希绑定桌面与节点制品。

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function normalizeGithubRepository(raw) {
  const match = String(raw || '').trim().match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i)
  return match?.[1] || String(raw || '').trim() || 'unknown'
}

function sourceTreeDirty(root, env = process.env) {
  if (env.AGENT_OS_SOURCE_DIRTY !== undefined) {
    return !/^(?:0|false|no)$/i.test(env.AGENT_OS_SOURCE_DIRTY)
  }
  return git(root, ['status', '--porcelain', '--untracked-files=all']).length > 0
}

function buildLocalReleaseProvenance(root = ROOT, env = process.env) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const runtimeSource = fs.readFileSync(path.join(root, 'src', 'shared', 'types', 'runtime.ts'), 'utf8')
  const protocolVersion = Number(/RUNTIME_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(runtimeSource)?.[1] ?? 0)
  const sourceCommit = env.AGENT_OS_SOURCE_COMMIT || git(root, ['rev-parse', 'HEAD'])
  const dirty = sourceTreeDirty(root, env)
  const sourceRevision = `${sourceCommit}${dirty ? '-dirty' : ''}`
  let sourceRemote = env.AGENT_OS_SOURCE_REPOSITORY || ''
  if (!sourceRemote) {
    try {
      sourceRemote = git(root, ['remote', 'get-url', 'origin'])
    } catch {
      sourceRemote = 'unknown'
    }
  }
  return {
    schemaVersion: 1,
    version: pkg.version,
    sourceRepository: normalizeGithubRepository(sourceRemote),
    sourceCommit,
    sourceRevision,
    sourceTreeClean: !dirty,
    runtimeProtocolVersion: protocolVersion,
    installNodeSha256: sha256(fs.readFileSync(path.join(root, 'scripts', 'install-node.sh')))
  }
}

function provenanceAssetName(version) {
  return `agentos-release-${String(version).replace(/^v/, '')}-provenance.json`
}

function provenanceDifferences(expected, actual) {
  const fields = [
    'schemaVersion',
    'version',
    'sourceRepository',
    'sourceCommit',
    'sourceRevision',
    'sourceTreeClean',
    'runtimeProtocolVersion',
    'installNodeSha256'
  ]
  return fields
    .filter((field) => actual?.[field] !== expected?.[field])
    .map((field) => `${field}: ${String(actual?.[field] ?? 'missing')} != ${String(expected?.[field] ?? 'missing')}`)
}

function assertCompatibleProvenance(expected, actual, label = 'Release provenance') {
  const differences = provenanceDifferences(expected, actual)
  if (differences.length > 0) {
    throw new Error(`${label} 与当前构建不一致\n${differences.map((item) => `  - ${item}`).join('\n')}`)
  }
  if (actual.sourceTreeClean !== true || /-dirty$/.test(actual.sourceRevision || '')) {
    throw new Error(`${label} 不允许来自未提交工作树`)
  }
}

/** 正式发布只能来自权威源仓 main 的精确 HEAD；dry-run 不调用此门禁。 */
function assertPublishSource(
  provenance,
  {
    localHead,
    remoteMainCommit,
    actualSourceRepository,
    actualSourceTreeClean,
    expectedRepository = 'aiutil/agent-os'
  }
) {
  const problems = []
  if (String(provenance?.sourceRepository || '').toLowerCase() !== expectedRepository.toLowerCase()) {
    problems.push(`源仓 ${provenance?.sourceRepository || 'missing'} != ${expectedRepository}`)
  }
  if (!/^[a-f0-9]{40}$/i.test(localHead || '')) problems.push('本地 HEAD 不是完整 commit')
  if (!/^[a-f0-9]{40}$/i.test(remoteMainCommit || '')) problems.push('无法解析远端 main commit')
  if (String(actualSourceRepository || '').toLowerCase() !== expectedRepository.toLowerCase()) {
    problems.push(`实际 origin ${actualSourceRepository || 'missing'} != ${expectedRepository}`)
  }
  if (actualSourceTreeClean !== true) problems.push('实际 git 工作树不是 clean')
  if (provenance?.sourceCommit !== localHead) {
    problems.push(`provenance sourceCommit ${provenance?.sourceCommit || 'missing'} != 本地 HEAD ${localHead || 'missing'}`)
  }
  if (localHead !== remoteMainCommit) {
    problems.push(`本地 HEAD ${localHead || 'missing'} != 远端 main ${remoteMainCommit || 'missing'}`)
  }
  if (provenance?.sourceTreeClean !== true || provenance?.sourceRevision !== localHead) {
    problems.push('provenance 必须绑定干净且无 -dirty 后缀的本地 HEAD')
  }
  if (problems.length > 0) {
    throw new Error(`正式发布来源不可信\n${problems.map((item) => `  - ${item}`).join('\n')}`)
  }
}

function writeLocalReleaseProvenance(root = ROOT, outputDir = path.join(root, 'release')) {
  const provenance = buildLocalReleaseProvenance(root)
  fs.mkdirSync(outputDir, { recursive: true })
  const output = path.join(outputDir, provenanceAssetName(provenance.version))
  fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`)
  return { output, provenance }
}

if (require.main === module) {
  try {
    const provenance = buildLocalReleaseProvenance(ROOT)
    if (process.argv.includes('--stdout')) {
      process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`)
    } else {
      const { output } = writeLocalReleaseProvenance(ROOT)
      console.log(`✓ ${path.relative(ROOT, output)}`)
    }
  } catch (error) {
    console.error(`✗ 无法生成 Release provenance：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = {
  assertCompatibleProvenance,
  assertPublishSource,
  buildLocalReleaseProvenance,
  normalizeGithubRepository,
  provenanceAssetName,
  provenanceDifferences,
  sha256,
  sourceTreeDirty,
  writeLocalReleaseProvenance
}
