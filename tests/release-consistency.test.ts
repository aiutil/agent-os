import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'
import { startLocalHttpsFixture } from './fixtures/local-https'

const execFileAsync = promisify(execFile)
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
const installScript = readFileSync('scripts/install-node.sh')
const testCommit = 'a'.repeat(40)
const provenanceName = `agentos-release-${version}-provenance.json`
const desktopAssetBytes = 16
const desktopManifestFixtures = [
  {
    name: `agentos-desktop-${version}-mac-arm64-manifest.json`,
    platform: 'mac',
    architectures: ['arm64'],
    assets: [`Agent-Os-${version}-mac-arm64.dmg`]
  },
  {
    name: `agentos-desktop-${version}-mac-x64-manifest.json`,
    platform: 'mac',
    architectures: ['x64'],
    assets: [`Agent-Os-${version}-mac-x64.dmg`]
  },
  {
    name: `agentos-desktop-${version}-linux-arm64-manifest.json`,
    platform: 'linux',
    architectures: ['arm64'],
    assets: [`Agent-Os-${version}-linux-arm64.AppImage`, `Agent-Os-${version}-linux-arm64.deb`]
  },
  {
    name: `agentos-desktop-${version}-linux-x64-manifest.json`,
    platform: 'linux',
    architectures: ['x64'],
    assets: [`Agent-Os-${version}-linux-x86_64.AppImage`, `Agent-Os-${version}-linux-amd64.deb`]
  },
  {
    name: `agentos-desktop-${version}-win-x64-manifest.json`,
    platform: 'win',
    architectures: ['x64'],
    assets: [`Agent-Os-${version}-win-x64-setup.exe`]
  }
]
const desktopAssetNames = desktopManifestFixtures.flatMap((item) => item.assets)
const desktopDigest = `sha256:${'c'.repeat(64)}`
const provenance = {
  schemaVersion: 1,
  version,
  sourceRepository: 'aiutil/agent-os',
  sourceCommit: testCommit,
  sourceRevision: testCommit,
  sourceTreeClean: true,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  installNodeSha256: createHash('sha256').update(installScript).digest('hex')
}

describe('SPEC-032 公开版本与安装脚本一致性', () => {
  it('版本字符串和 install-node.sh 内容必须同时与当前工作树一致', async () => {
    let staleInstallScript = false
    let staleProvenance = false
    let latestTag = `v${version}`
    let hideAssets = false
    let downgradeInstallRedirect = false
    let staleDesktopDigest = false
    let stalePageMarker = false
    let origin = ''
    let requestCount = 0
    const fixture = await startLocalHttpsFixture((request, response) => {
      requestCount += 1
      if (request.url === '/repos/aiutil/agent-os/releases/latest') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          tag_name: latestTag,
          assets: hideAssets ? [] : [
            { name: 'install-node.sh', browser_download_url: `${origin}/install-node.sh` },
            { name: provenanceName, browser_download_url: `${origin}/provenance.json` },
            ...desktopAssetNames.map((name) => ({
              name,
              size: desktopAssetBytes,
              digest: staleDesktopDigest ? `sha256:${'d'.repeat(64)}` : desktopDigest
            })),
            ...desktopManifestFixtures.map((item, index) => ({
              name: item.name,
              browser_download_url: `${origin}/desktop-manifest-${index}.json`
            }))
          ]
        }))
        return
      }
      if (request.url === '/page' || request.url === '/readme') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end(request.url === '/page'
          ? `<span class="version">v${stalePageMarker ? '0.0.1' : version}</span><p>历史版本 v${version}</p>`
          : `当前最新版本：**v${version}** · 2026-07-19`)
        return
      }
      if (request.url === '/install-node.sh') {
        if (downgradeInstallRedirect) {
          response.writeHead(302, { location: 'http://127.0.0.1:1/downgraded' })
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(staleInstallScript ? '#!/bin/sh\necho stale\n' : installScript)
        return
      }
      if (request.url === '/provenance.json') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(staleProvenance
          ? { ...provenance, sourceCommit: 'b'.repeat(40), sourceRevision: 'b'.repeat(40) }
          : provenance))
        return
      }
      const desktopManifestMatch = /^\/desktop-manifest-(\d+)\.json$/.exec(request.url ?? '')
      if (desktopManifestMatch) {
        const fixture = desktopManifestFixtures[Number(desktopManifestMatch[1])]
        if (!fixture) {
          response.writeHead(404).end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          schemaVersion: 1,
          version,
          platform: fixture.platform,
          architectures: fixture.architectures,
          provenance,
          assets: fixture.assets.map((name) => ({
            name,
            bytes: desktopAssetBytes,
            sha256: 'c'.repeat(64)
          }))
        }))
        return
      }
      response.writeHead(404)
      response.end()
    })
    origin = fixture.origin

    const run = (args: string[] = [], envOverrides: NodeJS.ProcessEnv = {}) => execFileAsync(process.execPath, [
      'scripts/check-public-release-consistency.cjs',
      ...args
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_OS_RELEASE_API_BASE: origin,
        AGENT_OS_RELEASE_PAGE_URL: `${origin}/page`,
        AGENT_OS_RELEASE_README_URL: `${origin}/readme`,
        AGENT_OS_SOURCE_COMMIT: testCommit,
        AGENT_OS_SOURCE_DIRTY: '0',
        AGENT_OS_SOURCE_REPOSITORY: 'aiutil/agent-os',
        NODE_TLS_REJECT_UNAUTHORIZED: '',
        NODE_EXTRA_CA_CERTS: fixture.caPath,
        ...envOverrides
      },
      maxBuffer: 1024 * 1024
    })
    try {
      const success = await run()
      expect(success.stdout).toContain('✓ 公开 install-node.sh')
      expect(success.stdout).toContain('✓ 公开桌面制品 manifest: 7/7')

      staleDesktopDigest = true
      await expect(run()).rejects.toMatchObject({
        stdout: expect.stringContaining('✗ 公开桌面制品 manifest: 0/7')
      })
      staleDesktopDigest = false

      stalePageMarker = true
      await expect(run(['--pre-publish'])).rejects.toMatchObject({
        stdout: expect.stringContaining('✗ GitHub Pages 当前版本标记: v0.0.1')
      })
      stalePageMarker = false

      const requestsBeforeUnsafeTls = requestCount
      await expect(run([], { NODE_TLS_REJECT_UNAUTHORIZED: '0' })).rejects.toMatchObject({
        stderr: expect.stringContaining('NODE_EXTRA_CA_CERTS')
      })
      expect(requestCount).toBe(requestsBeforeUnsafeTls)

      await expect(run([], { AGENT_OS_RELEASE_API_BASE: 'http://127.0.0.1:1' })).rejects.toMatchObject({
        stderr: expect.stringContaining('必须使用 HTTPS')
      })

      downgradeInstallRedirect = true
      await expect(run()).rejects.toMatchObject({
        stderr: expect.stringContaining('公开重定向目标 必须使用 HTTPS')
      })
      downgradeInstallRedirect = false

      staleInstallScript = true
      const versionsOnly = await run(['--versions-only'])
      expect(versionsOnly.stdout).not.toContain('公开 install-node.sh')
      await expect(run()).rejects.toMatchObject({
        stdout: expect.stringContaining('✗ 公开 install-node.sh')
      })

      staleInstallScript = false
      staleProvenance = true
      await expect(run(['--versions-only'])).rejects.toMatchObject({
        stdout: expect.stringContaining('✗ 公开 Release provenance')
      })

      staleProvenance = false
      latestTag = 'v0.0.1'
      hideAssets = true
      const prePublish = await run(['--pre-publish'])
      expect(prePublish.stdout).toContain('✓ GitHub Pages 当前版本标记')
      expect(prePublish.stdout).toContain('✓ 公开 README 当前版本标记')
      expect(prePublish.stdout).not.toContain('Latest Release')
      expect(prePublish.stdout).not.toContain('公开 Release provenance')
    } finally {
      await fixture.close()
    }
  }, 30_000)
})
