#!/usr/bin/env node
/* Synchronize the public agent-life static release surfaces from a versioned manifest. */

const fs = require('node:fs')
const path = require('node:path')
const ROOT = path.resolve(__dirname, '..')

function semverParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error(`invalid release version: ${version || '-'}`)
  return version.split('.').map(Number)
}

function compareSemver(left, right) {
  const a = semverParts(left)
  const b = semverParts(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function replaceVersionOutsidePngLines(content, previousVersion, version) {
  return content.split('\n').map((line) => {
    if (/\.png(?:["'`\s]|$)/i.test(line)) return line
    return line
      .replaceAll(`v${previousVersion}`, `v${version}`)
      .replaceAll(previousVersion, version)
  }).join('\n')
}

function replaceCurrentProductVersionLabels(content, version) {
  return content.replace(/(Agent OS\s*·\s*v)\d+\.\d+\.\d+/g, `$1${version}`)
}

function renderChangelogSection(manifest) {
  const items = manifest.changelog.map((item) =>
    `      <li><b>${escapeHtml(item.title)}</b> — ${escapeHtml(item.body)}</li>`
  ).join('\n')
  return `  <section class="ver">
    <div class="ver__head"><span class="ver__tag">v${manifest.version}</span><span class="ver__date">${manifest.date}</span></div>
    <ul class="ver__list">
${items}
      <li><b>构建来源</b> — 本版本制品的完整源码 revision 与逐文件摘要见 Release provenance。</li>
    </ul>
  </section>

`
}

function assertManifest(manifest) {
  semverParts(manifest?.version)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest?.date || '')) throw new Error('release manifest date is invalid')
  if (typeof manifest?.summaryZh !== 'string' || manifest.summaryZh.trim().length < 20) {
    throw new Error('release manifest summaryZh is missing')
  }
  if (!Array.isArray(manifest?.changelog) || manifest.changelog.length === 0 || manifest.changelog.some((item) =>
    typeof item?.title !== 'string' || typeof item?.body !== 'string' || !item.title || !item.body
  )) throw new Error('release manifest changelog is missing or invalid')
}

function updateReadme(content, manifest) {
  const marker = /Version `\d+\.\d+\.\d+`/
  if (!marker.test(content)) throw new Error('repository README current version is missing')
  return content.replace(marker, `Version \`${manifest.version}\``)
}

function updateIndex(content, previousVersion, version) {
  return replaceCurrentProductVersionLabels(
    replaceVersionOutsidePngLines(content, previousVersion, version),
    version
  )
    .replaceAll('飞书消息接入', '多平台消息通道')
    .replaceAll('Feishu message connection', 'Multi-platform message channels')
    .replaceAll(
      '通过飞书机器人长连接把 IM 消息转交给本机 Agent OS，无需公网入口；设置页集中展示各消息平台的接入状态。',
      '飞书、个人微信、企业微信、Telegram 与 WhatsApp 通过独立 transport 把消息交给本机 Agent OS；设置页区分传输在线、回合可用、访问策略与平台前置条件。'
    )
    .replaceAll(
      'A Feishu bot can hand IM messages to a local Agent OS over a long connection without a public endpoint. Settings shows the connection state for each channel.',
      'Feishu, personal WeChat, WeCom, Telegram, and WhatsApp use independent transports to reach the local Agent OS. Settings separates transport health, end-to-end turns, access policy, and platform prerequisites.'
    )
    .replaceAll('外出时从飞书发起工作。', '外出时从已授权的消息通道发起工作。')
    .replaceAll('dispatch work from Feishu while away.', 'dispatch work from an authorized message channel while away.')
    .replaceAll(
      '远程托管统一接入节点并选择 Runtime Host；飞书机器人通过长连接把消息转给本机 Agent，再回到任务记录审阅。',
      '远程托管统一接入节点并选择 Runtime Host；已授权消息通道把工作转给本机 Agent，再回到任务记录审阅。'
    )
    .replaceAll(
      'Remote hosting enrolls nodes behind selectable Runtime Hosts. A Feishu bot passes messages to the local Agent over a long connection, with review returning to the task record.',
      'Remote hosting enrolls nodes behind selectable Runtime Hosts. Authorized message channels pass work to the local Agent, with review returning to the task record.'
    )
    .replaceAll(
      '飞书机器人通过长连接把 IM 消息转交给本机 Agent OS，无需公网回调。渠道负责接收工作，执行仍进入统一的会话、任务、运行记录和交付流程。',
      '飞书、个人微信、企业微信、Telegram 与 WhatsApp 按各自 transport 接收工作；执行仍进入统一的会话、任务、运行记录和交付流程，公网回调只在平台明确要求时启用。'
    )
    .replaceAll(
      'A Feishu bot hands IM messages to a local Agent OS over a long connection without a public callback. Channels receive work while execution still enters the same sessions, tasks, run records, and delivery flow.',
      'Feishu, personal WeChat, WeCom, Telegram, and WhatsApp receive work through platform-specific transports. Execution still enters the same sessions, tasks, run records, and delivery flow; a public callback is enabled only when the platform requires one.'
    )
    .replaceAll('也可使用飞书机器人转交工作', '也可使用已授权消息通道转交工作')
    .replaceAll('hand it off through a Feishu bot', 'hand it off through an authorized message channel')
    .replaceAll(
      'macOS 当前制品未做 Apple Developer ID 公证，首次启动请在 Finder 中右键应用并选择“打开”。',
      'macOS 制品使用自签名证书，未经过 Apple 公证。首次打开如被拦截，请前往“系统设置 → 隐私与安全”点击“仍要打开”。'
    )
    .replaceAll(
      'The macOS build is not notarized with an Apple Developer ID. On first launch, right-click the app in Finder and choose Open.',
      'The macOS build uses a self-signed certificate and is not notarized by Apple. If blocked, use System Settings → Privacy & Security → Open Anyway.'
    )
}

function updateGuide(content, previousVersion, version) {
  return content
    .replaceAll(`v${previousVersion}`, `v${version}`)
    .replaceAll(previousVersion, version)
    .replaceAll('当前 Windows 制品由 macOS 主机交叉构建。', '当前 Windows 制品由 Windows 原生 GitHub-hosted runner 构建。')
    .replaceAll('The current Windows artifact is cross-built on macOS.', 'The current Windows artifact is built on a native Windows GitHub-hosted runner.')
    .replaceAll(
      '当前截图中飞书已接入，其他平台仍显示未接入、受限或尚未支持。',
      '飞书、个人微信、企业微信、Telegram 与 WhatsApp 以各自实时状态、访问策略和平台前置条件为准。'
    )
    .replaceAll(
      'In the supplied screen, Feishu is connected while the other platforms remain unconnected, restricted, or unavailable.',
      'Feishu, personal WeChat, WeCom, Telegram, and WhatsApp each expose their live health, access policy, and platform prerequisites.'
    )
    .replaceAll('并按需接入飞书或远程节点。', '并按需接入消息通道或远程节点。')
    .replaceAll('deliverable review, Feishu connection, and optional remote Runtime nodes.', 'deliverable review, message-channel connections, and optional remote Runtime nodes.')
    .replaceAll(
      '当前界面支持飞书机器人长连接，把消息转发给本机 Agent OS，无需部署公网回调地址。',
      '当前界面支持飞书、个人微信、企业微信、Telegram 与 WhatsApp；每个平台展示独立接入步骤、健康状态、访问策略与必要前置条件。'
    )
    .replaceAll(
      'The current interface supports a Feishu bot over a long connection, forwarding messages to a local Agent OS without a public callback endpoint.',
      'The current interface supports Feishu, personal WeChat, WeCom, Telegram, and WhatsApp, with platform-specific onboarding, health, access policy, and prerequisites.'
    )
    .replaceAll(
      '企业微信、Telegram、WhatsApp、Discord 与 QQ 会显示未接入、政策受限、即将支持或敬请期待等状态；不要把列表展示视为已经可用。',
      '飞书、个人微信、企业微信、Telegram 与 WhatsApp 只有在各自健康状态与前置条件通过后才可用；Discord 与 QQ 仍只展示规划状态。'
    )
    .replaceAll(
      'WeCom, Telegram, WhatsApp, Discord, and QQ may show not connected, policy restricted, coming soon, or planned. Presence in the list does not mean the channel is available.',
      'Feishu, personal WeChat, WeCom, Telegram, and WhatsApp are usable only after their health and prerequisites pass. Discord and QQ remain planning-only entries.'
    )
}

function updateChangelog(content, previousVersion, manifest) {
  let next = content
    .replaceAll(`<span class="version">v${previousVersion}</span>`, `<span class="version">v${manifest.version}</span>`)
    .replaceAll(`Agent OS · v${previousVersion}`, `Agent OS · v${manifest.version}`)
  if (!next.includes(`<span class="ver__tag">v${manifest.version}</span>`)) {
    const marker = '  <div class="wrap"><div class="timeline">\n\n'
    if (!next.includes(marker)) throw new Error('agent-life changelog timeline marker is missing')
    next = next.replace(marker, `${marker}${renderChangelogSection(manifest)}`)
  }
  return next
}

function syncAgentLifeSite({ repoDir = siteDir, siteDir, manifest, check = false }) {
  assertManifest(manifest)
  const files = {
    'README.md': path.join(repoDir, 'README.md'),
    'site/index.html': path.join(siteDir, 'index.html'),
    'site/guide.html': path.join(siteDir, 'guide.html'),
    'site/changelog.html': path.join(siteDir, 'changelog.html')
  }
  const original = Object.fromEntries(Object.entries(files).map(([name, file]) => {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`agent-life site file is missing: ${name}`)
    return [name, fs.readFileSync(file, 'utf8')]
  }))
  const match = /Version `(\d+\.\d+\.\d+)`/.exec(original['README.md'])
  if (!match) throw new Error('repository README current version is missing')
  const previousVersion = match[1]
  if (compareSemver(previousVersion, manifest.version) > 0) {
    throw new Error(`refusing site downgrade: ${previousVersion} -> ${manifest.version}`)
  }
  const updated = {
    'README.md': updateReadme(original['README.md'], manifest),
    'site/index.html': updateIndex(original['site/index.html'], previousVersion, manifest.version),
    'site/guide.html': updateGuide(original['site/guide.html'], previousVersion, manifest.version),
    'site/changelog.html': updateChangelog(original['site/changelog.html'], previousVersion, manifest)
  }
  const changed = Object.keys(files).filter((name) => updated[name] !== original[name])
  if (!updated['README.md'].includes(`Version \`${manifest.version}\``)) {
    throw new Error(`README.md does not expose ${manifest.version}`)
  }
  for (const name of ['site/index.html', 'site/guide.html']) {
    if (!updated[name].includes(`v${manifest.version}`)) throw new Error(`${name} does not expose v${manifest.version}`)
    if (previousVersion !== manifest.version && updated[name].includes(`/releases/download/v${previousVersion}/`)) {
      throw new Error(`${name} still contains a stale release download URL`)
    }
  }
  if (check && changed.length > 0) throw new Error(`agent-life site is not synchronized: ${changed.join(', ')}`)
  if (!check) {
    for (const name of changed) fs.writeFileSync(files[name], updated[name])
  }
  return { previousVersion, version: manifest.version, changed }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

if (require.main === module) {
  try {
    const repoDir = path.resolve(argument('--repo-dir') || ROOT)
    const siteDir = path.resolve(argument('--site-dir'))
    if (!argument('--site-dir')) throw new Error('--site-dir is required')
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
    const manifestPath = path.join(ROOT, 'docs', 'releases', `${version}.json`)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (manifest.version !== version) throw new Error(`release manifest/package version mismatch: ${manifest.version} / ${version}`)
    const result = syncAgentLifeSite({
      repoDir,
      siteDir,
      manifest,
      check: process.argv.includes('--check')
    })
    console.log(`✓ agent-life site ${result.previousVersion} → ${result.version}; changed: ${result.changed.join(', ') || 'none'}`)
  } catch (error) {
    console.error(`✗ agent-life site sync failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = {
  renderChangelogSection,
  replaceCurrentProductVersionLabels,
  replaceVersionOutsidePngLines,
  syncAgentLifeSite
}
