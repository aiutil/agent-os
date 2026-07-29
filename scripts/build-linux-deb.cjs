#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, __dirname, console, module */
// electron-builder 的内置 FPM 是 x86 二进制，无法在 Linux ARM64 runner 执行。
// 本脚本从同一次 arm64 electron-builder 产生的 unpacked app 构建原生 deb，
// 并重写桌面 manifest，把 AppImage、deb 与 update metadata 绑定到同一源码。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { writeDesktopReleaseManifest } = require('./desktop-release-manifest.cjs')

const ROOT = path.resolve(__dirname, '..')

function debControl(version, architecture = 'arm64') {
  return [
    'Package: agent-os',
    `Version: ${version}`,
    'Section: devel',
    'Priority: optional',
    `Architecture: ${architecture}`,
    'Maintainer: lohasle <lohasle@users.noreply.github.com>',
    'Homepage: https://agentos.aiutil.com/',
    'Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0',
    'Description: Agent OS v2 personal AI workspace',
    ' Unified access to AI CLIs, memory, knowledge and remote agents.',
    ''
  ].join('\n')
}

function desktopEntry() {
  return [
    '[Desktop Entry]',
    'Name=Agent OS',
    'Comment=Personal AI workspace',
    'Exec="/opt/Agent OS/agent-os" %U',
    'Terminal=false',
    'Type=Application',
    'Icon=agent-os',
    'Categories=Development;',
    ''
  ].join('\n')
}

function desktopArtifactPaths(releaseDir, version) {
  const prefix = `Agent-Os-${version}-linux-arm64.`
  return fs.readdirSync(releaseDir)
    .filter((name) => name.startsWith(prefix) || name === 'latest-linux-arm64.yml')
    .map((name) => path.join(releaseDir, name))
}

function buildLinuxDeb(root = ROOT) {
  if (process.platform !== 'linux' || process.arch !== 'arm64') {
    throw new Error(`Linux ARM64 deb 必须在 linux/arm64 原生 runner 构建，当前为 ${process.platform}/${process.arch}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = pkg.version
  const releaseDir = path.join(root, 'release')
  const appDir = path.join(releaseDir, 'linux-arm64-unpacked')
  const icon = path.join(root, 'assets', 'icons', 'icon_1024x1024.png')
  if (!fs.existsSync(appDir)) throw new Error(`缺少 arm64 unpacked app：${appDir}`)
  if (!fs.existsSync(icon)) throw new Error(`缺少 Linux 应用图标：${icon}`)

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-deb-arm64-'))
  const appTarget = path.join(stage, 'opt', 'Agent OS')
  const controlDir = path.join(stage, 'DEBIAN')
  const applicationsDir = path.join(stage, 'usr', 'share', 'applications')
  const iconsDir = path.join(stage, 'usr', 'share', 'icons', 'hicolor', '1024x1024', 'apps')
  const output = path.join(releaseDir, `Agent-Os-${version}-linux-arm64.deb`)
  try {
    fs.mkdirSync(path.dirname(appTarget), { recursive: true })
    fs.cpSync(appDir, appTarget, { recursive: true, dereference: false })
    fs.mkdirSync(controlDir, { recursive: true })
    fs.mkdirSync(applicationsDir, { recursive: true })
    fs.mkdirSync(iconsDir, { recursive: true })
    fs.writeFileSync(path.join(controlDir, 'control'), debControl(version))
    fs.writeFileSync(path.join(applicationsDir, 'agent-os.desktop'), desktopEntry())
    fs.copyFileSync(icon, path.join(iconsDir, 'agent-os.png'))
    const sandbox = path.join(appTarget, 'chrome-sandbox')
    if (fs.existsSync(sandbox)) fs.chmodSync(sandbox, 0o4755)
    fs.rmSync(output, { force: true })
    execFileSync('dpkg-deb', ['--build', '--root-owner-group', stage, output], { stdio: 'inherit' })
    const artifactPaths = desktopArtifactPaths(releaseDir, version)
    if (!artifactPaths.includes(output)) throw new Error('arm64 deb 未进入桌面制品集合')
    writeDesktopReleaseManifest({ outDir: releaseDir, artifactPaths }, root)
    console.log(`✓ Linux ARM64 deb 与桌面 manifest 已生成：${path.basename(output)}`)
    return output
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

if (require.main === module) buildLinuxDeb()

module.exports = { buildLinuxDeb, debControl, desktopArtifactPaths, desktopEntry }
