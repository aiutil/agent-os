import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { RUNTIME_PROTOCOL_VERSION } from '../src/shared/types'
import { startLocalHttpsFixture } from './fixtures/local-https'

const execFileAsync = promisify(execFile)
const platforms = ['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-x64']
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
const manifestName = `agentos-node-${version}-manifest.json`
const provenanceName = `agentos-release-${version}-provenance.json`
const sourceRevision = 'a'.repeat(40)
const provenance = {
  schemaVersion: 1,
  version,
  sourceRepository: 'aiutil/agent-os',
  sourceCommit: sourceRevision,
  sourceRevision,
  sourceTreeClean: true,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  installNodeSha256: createHash('sha256').update(readFileSync('scripts/install-node.sh')).digest('hex')
}

describe('SPEC-032 公开节点 Release 发布后验收', () => {
  it('真实读取远端 asset/manifest/HEAD，五平台齐全才通过', async () => {
    let omittedPlatform = ''
    let downgradeManifestRedirect = false
    let staleAssetDigest = false
    let origin = ''
    let assetOrigin = ''
    let requestCount = 0
    const authorizationByPath = new Map<string, string | undefined>()
    const fixture = await startLocalHttpsFixture((request, response) => {
      requestCount += 1
      authorizationByPath.set(request.url ?? '', request.headers.authorization)
      if (request.url === `/repos/aiutil/agent-os/releases/tags/v${version}`) {
        const assets = [
          { name: manifestName, browser_download_url: `${assetOrigin}/download/${manifestName}` },
          { name: provenanceName, browser_download_url: `${assetOrigin}/download/${provenanceName}` },
          ...platforms
            .filter((platform) => platform !== omittedPlatform)
            .map((platform) => ({
              name: `agentos-node-${version}-${platform}.tar.gz`,
              size: 1,
              digest: `sha256:${(staleAssetDigest ? 'c' : 'a').repeat(64)}`,
              browser_download_url: `${assetOrigin}/download/agentos-node-${version}-${platform}.tar.gz`
            }))
        ]
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ assets }))
        return
      }
      if (request.url === `/download/${provenanceName}`) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(provenance))
        return
      }
      if (request.url === `/download/${manifestName}`) {
        if (downgradeManifestRedirect) {
          response.writeHead(302, { location: 'http://127.0.0.1:1/downgraded' })
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          version,
          provenance,
          assets: platforms.map((platform) => ({
            name: `agentos-node-${version}-${platform}.tar.gz`,
            bytes: 1,
            sha256: 'a'.repeat(64),
            fileIntegrityVerified: true,
            runtime: {
              selfContainedNodeRuntime: true,
              appVersion: version,
              platform,
              protocolVersion: RUNTIME_PROTOCOL_VERSION,
              sourceRevision,
              nodeVersion: '20.17.0',
              nodeAbi: '115',
              files: [{ path: 'runtime/bin/node', bytes: 1, sha256: 'b'.repeat(64) }]
            }
          }))
        }))
        return
      }
      if (request.method === 'HEAD' && request.url?.startsWith('/download/agentos-node-')) {
        response.writeHead(200, { 'content-length': '1' })
        response.end()
        return
      }
      response.writeHead(404)
      response.end()
    })
    origin = fixture.origin
    assetOrigin = origin.replace('127.0.0.1', 'localhost')

    const run = (envOverrides: NodeJS.ProcessEnv = {}) => execFileAsync(process.execPath, ['scripts/check-public-node-release.cjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_OS_RELEASE_API_BASE: origin,
        AGENT_OS_SOURCE_COMMIT: sourceRevision,
        AGENT_OS_SOURCE_DIRTY: '0',
        AGENT_OS_SOURCE_REPOSITORY: 'aiutil/agent-os',
        GH_TOKEN: 'test-api-origin-token',
        NODE_TLS_REJECT_UNAUTHORIZED: '',
        NODE_EXTRA_CA_CERTS: fixture.caPath,
        ...envOverrides
      },
      maxBuffer: 1024 * 1024
    })
    try {
      const success = await run()
      expect(success.stdout).toContain('五平台、manifest 与下载 URL 全部就绪')
      expect(authorizationByPath.get(`/repos/aiutil/agent-os/releases/tags/v${version}`)).toBe('Bearer test-api-origin-token')
      expect([...authorizationByPath.entries()]
        .filter(([path]) => path.startsWith('/download/'))
        .every(([, authorization]) => authorization === undefined)).toBe(true)

      const requestsBeforeUnsafeTls = requestCount
      await expect(run({ NODE_TLS_REJECT_UNAUTHORIZED: '0' })).rejects.toMatchObject({
        stderr: expect.stringContaining('NODE_EXTRA_CA_CERTS')
      })
      expect(requestCount).toBe(requestsBeforeUnsafeTls)

      await expect(run({ AGENT_OS_RELEASE_API_BASE: 'http://127.0.0.1:1' })).rejects.toMatchObject({
        stderr: expect.stringContaining('必须使用 HTTPS')
      })

      downgradeManifestRedirect = true
      await expect(run()).rejects.toMatchObject({
        stderr: expect.stringContaining('公开重定向目标 必须使用 HTTPS')
      })
      downgradeManifestRedirect = false

      staleAssetDigest = true
      await expect(run()).rejects.toMatchObject({
        stderr: expect.stringContaining('公开 bytes/SHA-256 与 manifest 不一致')
      })
      staleAssetDigest = false

      omittedPlatform = 'win-x64'
      await expect(run()).rejects.toMatchObject({
        stderr: expect.stringContaining(`公开 Release 缺少 agentos-node-${version}-win-x64.tar.gz`)
      })
    } finally {
      await fixture.close()
    }
  }, 15_000)
})
