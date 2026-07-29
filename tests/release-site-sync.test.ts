import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { syncAgentLifeSite } = require('../scripts/sync-agent-life-site.cjs') as {
  syncAgentLifeSite(input: {
    siteDir: string
    repoDir?: string
    manifest: Record<string, unknown>
    sourceRevision: string
    check?: boolean
  }): { previousVersion: string; version: string; changed: string[] }
}

const directories: string[] = []
const sourceRevision = 'a'.repeat(40)
const manifest = JSON.parse(readFileSync('docs/releases/0.3.0.json', 'utf8')) as Record<string, unknown>

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentos-release-site-'))
  directories.push(directory)
  mkdirSync(join(directory, 'site'), { recursive: true })
  writeFileSync(join(directory, 'README.md'), `# Agent OS

Version \`0.2.9\` provides native builds for macOS, Windows, and Linux.
`)
  writeFileSync(join(directory, 'site', 'index.html'), `<span class="version">v0.2.9</span>
<a href="https://github.com/aiutil/agent-os/releases/download/v0.2.9/Agent-Os-0.2.9-linux-x86_64.AppImage">下载 v0.2.9</a>
<img src="message-channels-feishu-v0.2.9.png" />
<h3>飞书消息接入</h3>
<p>通过飞书机器人长连接把 IM 消息转交给本机 Agent OS，无需公网入口；设置页集中展示各消息平台的接入状态。</p>
<footer>Agent OS · v0.2.8</footer>
`)
  writeFileSync(join(directory, 'site', 'guide.html'), `<span class="version">v0.2.9</span>
<a href="https://github.com/aiutil/agent-os/releases/download/v0.2.9/Agent-Os-0.2.9-win-x64-setup.exe">Windows</a>
<p>当前 Windows 制品由 macOS 主机交叉构建。</p>
<p>当前截图中飞书已接入，其他平台仍显示未接入、受限或尚未支持。</p>
`)
  writeFileSync(join(directory, 'site', 'changelog.html'), `<span class="version">v0.2.9</span>
  <div class="wrap"><div class="timeline">

  <section class="ver"><div class="ver__head"><span class="ver__tag">v0.2.9</span></div></section>
</div></div>
<footer>Agent OS · v0.2.9</footer>
`)
  return directory
}

describe('SPEC-032 agent-life 公开站点同步', () => {
  it('从版本清单同步 Page/README/指南/更新记录，同时保留历史截图与历史版本', () => {
    const siteDir = fixture()
    const result = syncAgentLifeSite({ repoDir: siteDir, siteDir: join(siteDir, 'site'), manifest, sourceRevision })
    expect(result).toMatchObject({
      previousVersion: '0.2.9',
      version: '0.3.0',
      changed: ['README.md', 'site/index.html', 'site/guide.html', 'site/changelog.html']
    })

    const readme = readFileSync(join(siteDir, 'README.md'), 'utf8')
    const index = readFileSync(join(siteDir, 'site', 'index.html'), 'utf8')
    const guide = readFileSync(join(siteDir, 'site', 'guide.html'), 'utf8')
    const changelog = readFileSync(join(siteDir, 'site', 'changelog.html'), 'utf8')
    expect(readme).toContain('Version `0.3.0`')
    expect(index).toContain('多平台消息通道')
    expect(index).toContain('message-channels-feishu-v0.2.9.png')
    expect(index).not.toContain('飞书机器人通过长连接把 IM 消息转交')
    expect(index).toContain('<footer>Agent OS · v0.3.0</footer>')
    expect(index).not.toContain('Agent OS · v0.2.8')
    expect(guide).toContain('Windows 原生 GitHub-hosted runner')
    expect(guide).toContain('/releases/download/v0.3.0/Agent-Os-0.3.0-win-x64-setup.exe')
    expect(changelog).toContain('<span class="ver__tag">v0.3.0</span>')
    expect(changelog).toContain('<span class="ver__tag">v0.2.9</span>')
    expect(changelog).toContain(sourceRevision.slice(0, 12))

    const input = { repoDir: siteDir, siteDir: join(siteDir, 'site'), manifest, sourceRevision }
    expect(syncAgentLifeSite(input).changed).toEqual([])
    expect(() => syncAgentLifeSite({ ...input, check: true })).not.toThrow()
  })

  it('模板标记漂移或站点版本高于待发布版本时 fail closed', () => {
    const siteDir = fixture()
    writeFileSync(join(siteDir, 'README.md'), '# missing release marker\n')
    expect(() => syncAgentLifeSite({ repoDir: siteDir, siteDir: join(siteDir, 'site'), manifest, sourceRevision })).toThrow('current version is missing')

    const newer = fixture()
    const readmePath = join(newer, 'README.md')
    writeFileSync(readmePath, readFileSync(readmePath, 'utf8').replace('0.2.9', '9.0.0'))
    expect(() => syncAgentLifeSite({ repoDir: newer, siteDir: join(newer, 'site'), manifest, sourceRevision })).toThrow('refusing site downgrade')
  })
})
