import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shell } from 'electron'
import {
  assertUpdateAssetIntegrity,
  isNewerVersion,
  MAC_INSTALL_SCRIPT,
  pickAsset,
  safeUpdateAssetName,
  UpdateService,
  updateAssetSha256
} from '../src/main/domains/update/service'
import type { UpdateAsset } from '../src/shared/types'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.2.0',
    getPath: () => '/not/a/packaged/app',
    quit: vi.fn()
  },
  shell: { openPath: vi.fn(async () => '') }
}))

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function releaseAssets(version: string, body: Buffer): UpdateAsset[] {
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
  return [
    {
      name: `Agent-OS-${version}-mac-arm64.dmg`,
      browser_download_url: 'https://example.test/mac-arm64',
      size: body.length,
      digest
    },
    {
      name: `Agent-OS-${version}-mac-x64.dmg`,
      browser_download_url: 'https://example.test/mac-x64',
      size: body.length,
      digest
    },
    {
      name: `Agent-OS-${version}-win-x64-setup.exe`,
      browser_download_url: 'https://example.test/win-x64',
      size: body.length,
      digest
    },
    {
      name: `Agent-OS-${version}-linux-arm64.AppImage`,
      browser_download_url: 'https://example.test/linux-arm64',
      size: body.length,
      digest
    },
    {
      name: `Agent-OS-${version}-linux-x86_64.AppImage`,
      browser_download_url: 'https://example.test/linux-x64',
      size: body.length,
      digest
    }
  ]
}

describe('isNewerVersion（升级判定，决定老版本能否升到新版）', () => {
  it('0.1.5 → 0.2.0 视为有更新', () => {
    expect(isNewerVersion('0.1.5', 'v0.2.0')).toBe(true)
  })
  it('容忍前导 v 与等值/降级', () => {
    expect(isNewerVersion('v0.2.0', 'v0.2.0')).toBe(false)
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true)
  })
  it('按段比较而非字典序', () => {
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(true)
  })
})

describe('pickAsset（按平台/架构选安装包）', () => {
  const assets: UpdateAsset[] = [
    { name: 'Agent-Os-0.2.0-mac-arm64.dmg', browser_download_url: 'u1', size: 1 },
    { name: 'Agent-Os-0.2.0-mac-x64.dmg', browser_download_url: 'u2', size: 2 },
    { name: 'Agent-Os-0.2.0-win-x64-setup.exe', browser_download_url: 'u3', size: 3 },
    { name: 'Agent-Os-0.2.0-linux-arm64.AppImage', browser_download_url: 'u4', size: 4 },
    { name: 'Agent-Os-0.2.0-linux-x86_64.AppImage', browser_download_url: 'u5', size: 5 }
  ]

  it('darwin/arm64 选 arm64 dmg', () => {
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toBe('Agent-Os-0.2.0-mac-arm64.dmg')
  })
  it('darwin/x64 选 x64 dmg', () => {
    expect(pickAsset(assets, 'darwin', 'x64')?.name).toBe('Agent-Os-0.2.0-mac-x64.dmg')
  })
  it('win32 选 exe', () => {
    expect(pickAsset(assets, 'win32', 'x64')?.name).toBe('Agent-Os-0.2.0-win-x64-setup.exe')
  })
  it('linux 选 AppImage', () => {
    expect(pickAsset(assets, 'linux', 'x64')?.name).toBe('Agent-Os-0.2.0-linux-x86_64.AppImage')
    expect(pickAsset(assets, 'linux', 'arm64')?.name).toBe('Agent-Os-0.2.0-linux-arm64.AppImage')
  })
  it('无匹配架构时拒绝异构资产，不再下载列表第一项', () => {
    const onlyX64: UpdateAsset[] = [
      { name: 'Agent-Os-0.2.0-mac-x64.dmg', browser_download_url: 'u', size: 1 }
    ]
    expect(pickAsset(onlyX64, 'darwin', 'arm64')).toBeNull()
  })
  it('兼容 amd64/aarch64 别名和没有架构标记的旧版通用包', () => {
    const aliases: UpdateAsset[] = [
      { name: 'Agent-Os-0.2.0-linux-amd64.AppImage', browser_download_url: 'x64', size: 1 },
      { name: 'Agent-Os-0.2.0-linux-aarch64.AppImage', browser_download_url: 'arm64', size: 1 }
    ]
    expect(pickAsset(aliases, 'linux', 'x64')?.browser_download_url).toBe('x64')
    expect(pickAsset(aliases, 'linux', 'arm64')?.browser_download_url).toBe('arm64')
    const generic: UpdateAsset[] = [
      { name: 'Agent-Os-0.1.0-mac.dmg', browser_download_url: 'legacy', size: 1 }
    ]
    expect(pickAsset(generic, 'darwin', 'arm64')?.browser_download_url).toBe('legacy')
  })
  it('无同类型资产返回 null', () => {
    expect(pickAsset([], 'darwin', 'arm64')).toBeNull()
  })
})

describe('桌面更新包完整性门禁', () => {
  const body = Buffer.from('verified desktop artifact')
  const digest = createHash('sha256').update(body).digest('hex')
  const asset: UpdateAsset = {
    name: 'Agent-Os-1.0.0-mac-arm64.dmg',
    browser_download_url: 'https://example.test/asset',
    size: body.length,
    digest: `sha256:${digest}`
  }

  it('Release API 与制品下载都显式强制 TLS 证书校验', async () => {
    const requestOptions: Array<Record<string, unknown>> = []
    const requestTargets: string[] = []
    const getSpy = vi.spyOn(https, 'get')
    const implementation = (
      target: string | URL,
      options: Record<string, unknown>,
      callback: (
        response: NodeJS.ReadableStream & { statusCode: number; headers: Record<string, string> }
      ) => void
    ): ReturnType<typeof https.get> => {
      requestTargets.push(String(target))
      requestOptions.push(options)
      const body = String(target).includes('api.github.com')
        ? JSON.stringify({
            tag_name: 'v9.9.9',
            html_url: 'https://example.test/release',
            assets: []
          })
        : ''
      const response = Object.assign(Readable.from([body]), { statusCode: 200, headers: {} })
      const request = new EventEmitter() as EventEmitter & {
        setTimeout: (milliseconds: number, callback: () => void) => unknown
        destroy: (error?: Error) => void
      }
      request.setTimeout = vi.fn(() => request)
      request.destroy = vi.fn()
      queueMicrotask(() => callback(response))
      return request as ReturnType<typeof https.get>
    }
    getSpy.mockImplementation(implementation as never)
    try {
      const service = new UpdateService(() => null)
      await service.check({ force: true })
      const internal = service as unknown as {
        openDownload(url: string): Promise<NodeJS.ReadableStream>
      }
      const response = await internal.openDownload('https://example.test/asset')
      response.resume()

      expect(requestOptions).toHaveLength(2)
      expect(requestOptions.every((options) => options.rejectUnauthorized === true)).toBe(true)
      expect(requestTargets[0]).toBe('https://api.github.com/repos/aiutil/agent-os/releases/latest')
    } finally {
      getSpy.mockRestore()
    }
  })

  it('同时匹配 bytes 与 GitHub sha256 digest 才通过', () => {
    expect(updateAssetSha256(asset)).toBe(digest)
    expect(() => assertUpdateAssetIntegrity(asset, body.length, digest)).not.toThrow()
  })

  it('缺 digest、bytes 不同或 SHA 不同均拒绝', () => {
    expect(() => updateAssetSha256({})).toThrow('SHA-256')
    expect(() => assertUpdateAssetIntegrity(asset, body.length - 1, digest)).toThrow('完整性')
    expect(() => assertUpdateAssetIntegrity(asset, body.length, 'b'.repeat(64))).toThrow('完整性')
  })

  it('拒绝绝对路径、父目录与正反斜杠 asset 名称', () => {
    expect(safeUpdateAssetName('Agent-OS-1.0.0.dmg')).toBe('Agent-OS-1.0.0.dmg')
    for (const unsafe of [
      '/tmp/Agent-OS.dmg',
      '../Agent-OS.dmg',
      'nested/Agent-OS.dmg',
      'nested\\Agent-OS.dmg',
      'bad\0name.dmg',
      '.',
      '..'
    ]) {
      expect(() => safeUpdateAssetName(unsafe)).toThrow('文件名')
    }
  })

  it('下载只在 pipeline 与完整性校验成功后把 partial 原子提升', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-update-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, asset.name)
    const service = new UpdateService(() => null)
    const internal = service as unknown as {
      openDownload: (url: string) => Promise<NodeJS.ReadableStream>
      downloadFile: (url: string, destination: string, asset: UpdateAsset) => Promise<void>
    }
    internal.openDownload = vi.fn(async () => Readable.from([body]))

    await internal.downloadFile(asset.browser_download_url, destination, asset)

    expect(readFileSync(destination)).toEqual(body)
    expect(existsSync(`${destination}.partial`)).toBe(false)
  })

  it('Windows 只读句柄 fsync 会 EPERM 时改用可写句柄持久化', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-update-windows-fsync-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, asset.name)
    const service = new UpdateService(() => null)
    const internal = service as unknown as {
      openDownload: (url: string) => Promise<NodeJS.ReadableStream>
      downloadFile: (url: string, destination: string, asset: UpdateAsset) => Promise<void>
    }
    internal.openDownload = vi.fn(async () => Readable.from([body]))

    const readonlyDescriptors = new Set<number>()
    const originalOpenSync = fs.openSync.bind(fs)
    const originalFsyncSync = fs.fsyncSync.bind(fs)
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const descriptor = originalOpenSync(...args)
      if (args[1] === 'r') readonlyDescriptors.add(descriptor)
      return descriptor
    }) as typeof fs.openSync)
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (readonlyDescriptors.has(descriptor)) {
        throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' })
      }
      originalFsyncSync(descriptor)
    })

    try {
      await internal.downloadFile(asset.browser_download_url, destination, asset)
      expect(openSpy).toHaveBeenCalledWith(`${destination}.partial`, 'r+')
      expect(fsyncSpy).toHaveBeenCalledOnce()
      expect(readFileSync(destination)).toEqual(body)
      expect(existsSync(`${destination}.partial`)).toBe(false)
    } finally {
      fsyncSpy.mockRestore()
      openSpy.mockRestore()
    }
  })

  it('可写句柄真正 fsync 失败时仍清理 partial 且不生成最终文件', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-update-fsync-failure-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, asset.name)
    const service = new UpdateService(() => null)
    const internal = service as unknown as {
      openDownload: (url: string) => Promise<NodeJS.ReadableStream>
      downloadFile: (url: string, destination: string, asset: UpdateAsset) => Promise<void>
    }
    internal.openDownload = vi.fn(async () => Readable.from([body]))
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: fsync failed'), { code: 'EIO' })
    })

    try {
      await expect(
        internal.downloadFile(asset.browser_download_url, destination, asset)
      ).rejects.toThrow('fsync failed')
    } finally {
      fsyncSpy.mockRestore()
    }
    expect(existsSync(destination)).toBe(false)
    expect(existsSync(`${destination}.partial`)).toBe(false)
  })

  it('pipeline 完成但 digest 不符时删除 partial 且不生成最终文件', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-update-download-'))
    temporaryDirectories.push(directory)
    const destination = join(directory, asset.name)
    const service = new UpdateService(() => null)
    const internal = service as unknown as {
      openDownload: (url: string) => Promise<NodeJS.ReadableStream>
      downloadFile: (url: string, destination: string, asset: UpdateAsset) => Promise<void>
    }
    internal.openDownload = vi.fn(async () => Readable.from([body]))

    await expect(
      internal.downloadFile(asset.browser_download_url, destination, {
        ...asset,
        digest: `sha256:${'b'.repeat(64)}`
      })
    ).rejects.toThrow('完整性')

    expect(existsSync(destination)).toBe(false)
    expect(existsSync(`${destination}.partial`)).toBe(false)
  })
})

describe('UpdateService 下载状态与安装交接', () => {
  const body = Buffer.from('verified update package')

  function setup(version = '9.9.9'): {
    service: UpdateService
    internal: {
      latestRelease: { tagName: string; htmlUrl: string; assets: UpdateAsset[] } | null
      downloadedFilePath: string | null
      downloadedAsset: UpdateAsset | null
      downloadedReleaseTag: string | null
      downloadFile: (url: string, destination: string, asset: UpdateAsset) => Promise<void>
      installMacInPlace: (filePath: string) => boolean
      fetchLatestRelease: () => Promise<{
        tagName: string
        htmlUrl: string
        assets: UpdateAsset[]
      } | null>
    }
    directory: string
    selected: UpdateAsset
  } {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-update-state-'))
    temporaryDirectories.push(directory)
    const service = new UpdateService(() => null, directory)
    const internal = service as unknown as {
      latestRelease: { tagName: string; htmlUrl: string; assets: UpdateAsset[] } | null
      downloadedFilePath: string | null
      downloadedAsset: UpdateAsset | null
      downloadedReleaseTag: string | null
      downloadFile: (url: string, destination: string, asset: UpdateAsset) => Promise<void>
      installMacInPlace: (filePath: string) => boolean
      fetchLatestRelease: () => Promise<{
        tagName: string
        htmlUrl: string
        assets: UpdateAsset[]
      } | null>
    }
    const assets = releaseAssets(version, body)
    const selected = pickAsset(assets)
    if (!selected) throw new Error('current platform fixture missing')
    internal.latestRelease = {
      tagName: `v${version}`,
      htmlUrl: 'https://example.test/release',
      assets
    }
    internal.downloadFile = vi.fn(async (_url, destination) => writeFileSync(destination, body))
    internal.installMacInPlace = vi.fn(() => false)
    return { service, internal, directory, selected }
  }

  it('完整下载后才绑定 release/asset 并进入 downloaded', async () => {
    const { service, internal, selected } = setup()

    await expect(service.startDownload()).resolves.toEqual({ started: true })

    expect(service.getState()).toMatchObject({
      status: 'downloaded',
      progress: 100,
      assetName: selected.name
    })
    expect(internal.downloadedReleaseTag).toBe('v9.9.9')
    expect(internal.downloadedAsset).toEqual(selected)
    expect(internal.downloadedFilePath && readFileSync(internal.downloadedFilePath)).toEqual(body)
  })

  it('开始新下载即失效旧包，新下载失败后不能继续安装旧路径', async () => {
    const { service, internal } = setup()
    await service.startDownload()
    const oldPath = internal.downloadedFilePath
    expect(oldPath && existsSync(oldPath)).toBe(true)

    const nextAssets = releaseAssets('9.9.10', body)
    internal.latestRelease = {
      tagName: 'v9.9.10',
      htmlUrl: 'https://example.test/release-2',
      assets: nextAssets
    }
    internal.downloadFile = vi.fn(async () => {
      throw new Error('network interrupted')
    })

    const result = await service.startDownload()

    expect(result.started).toBe(false)
    expect(oldPath && existsSync(oldPath)).toBe(false)
    expect(internal.downloadedFilePath).toBeNull()
    expect(internal.downloadedAsset).toBeNull()
    expect(service.getState()).toMatchObject({ status: 'error', downloadedPath: '' })
    await expect(service.install({ quitAfterOpen: false })).resolves.toMatchObject({ ok: false })
  })

  it('下载途中 Release 目标变化时删除刚完成的旧包且不绑定到新 tag', async () => {
    const { service, internal, directory, selected } = setup()
    let finishDownload: (() => void) | undefined
    internal.downloadFile = vi.fn(async (_url, destination) => {
      writeFileSync(destination, body)
      await new Promise<void>((resolve) => {
        finishDownload = resolve
      })
    })

    const download = service.startDownload()
    await vi.waitFor(() => expect(finishDownload).toBeTypeOf('function'))
    internal.latestRelease = {
      tagName: 'v9.9.10',
      htmlUrl: 'https://example.test/release-2',
      assets: releaseAssets('9.9.10', body)
    }
    finishDownload?.()

    await expect(download).resolves.toMatchObject({ started: false })
    expect(internal.downloadedFilePath).toBeNull()
    expect(internal.downloadedReleaseTag).toBeNull()
    expect(service.getState()).toMatchObject({ status: 'error', downloadedPath: '' })
    expect(existsSync(join(directory, selected.name))).toBe(false)
  })

  it('Release tag 或 asset 元数据变化时清理已下载旧包', async () => {
    const { service, internal } = setup()
    await service.startDownload()
    const oldPath = internal.downloadedFilePath
    const nextAssets = releaseAssets('9.9.10', body)
    internal.fetchLatestRelease = vi.fn(async () => ({
      tagName: 'v9.9.10',
      htmlUrl: 'https://example.test/release-2',
      assets: nextAssets
    }))

    await service.check({ force: true })

    expect(oldPath && existsSync(oldPath)).toBe(false)
    expect(internal.downloadedFilePath).toBeNull()
    expect(service.getState()).toMatchObject({
      status: 'available',
      downloadedPath: '',
      assetName: '',
      progress: 0
    })
  })

  it('安装前重新计算 bytes/SHA，文件被篡改时删除并拒绝打开', async () => {
    const { service, internal } = setup()
    await service.startDownload()
    const downloadedPath = internal.downloadedFilePath
    if (!downloadedPath) throw new Error('download fixture missing')
    writeFileSync(downloadedPath, Buffer.from('tampered update package'))
    vi.mocked(shell.openPath).mockClear()

    const result = await service.install({ quitAfterOpen: false })

    expect(result).toMatchObject({ ok: false, quit: false })
    expect(existsSync(downloadedPath)).toBe(false)
    expect(internal.downloadedFilePath).toBeNull()
    expect(service.getState()).toMatchObject({ status: 'error', downloadedPath: '' })
    expect(shell.openPath).not.toHaveBeenCalled()
  })

  it('已下载文件消失时清空下载状态并拒绝安装', async () => {
    const { service, internal } = setup()
    await service.startDownload()
    const downloadedPath = internal.downloadedFilePath
    if (!downloadedPath) throw new Error('download fixture missing')
    rmSync(downloadedPath, { force: true })

    const result = await service.install({ quitAfterOpen: false })

    expect(result.ok).toBe(false)
    expect(internal.downloadedFilePath).toBeNull()
    expect(service.getState()).toMatchObject({ status: 'error', downloadedPath: '' })
  })

  it('安装前复验通过后才调用平台安装交接', async () => {
    const { service, internal } = setup()
    await service.startDownload()
    const downloadedPath = internal.downloadedFilePath
    vi.mocked(shell.openPath).mockClear()
    vi.mocked(shell.openPath).mockResolvedValue('')

    const result = await service.install({ quitAfterOpen: false })

    expect(result).toEqual({ ok: true, quit: false })
    if (process.platform === 'darwin')
      expect(internal.installMacInPlace).toHaveBeenCalledWith(downloadedPath)
    expect(shell.openPath).toHaveBeenCalledWith(downloadedPath)
  })
})

describe('macOS 原地更新脚本事务顺序', () => {
  it('生成的后台脚本通过 bash 语法检查', () => {
    if (process.platform === 'win32') return
    const result = spawnSync('/bin/bash', ['-n'], { input: MAC_INSTALL_SCRIPT, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  })

  it('先 stage/验签，再 backup/promote/open，失败由 trap 恢复旧应用', () => {
    const stage = MAC_INSTALL_SCRIPT.indexOf('/usr/bin/ditto "$SRC" "$STAGE"')
    const verify = MAC_INSTALL_SCRIPT.indexOf('/usr/bin/codesign --verify --deep --strict "$STAGE"')
    const backup = MAC_INSTALL_SCRIPT.indexOf('mv "$TARGET" "$BACKUP"')
    const promote = MAC_INSTALL_SCRIPT.indexOf('mv "$STAGE" "$TARGET"')
    const launch = MAC_INSTALL_SCRIPT.indexOf('open "$TARGET"')
    const commit = MAC_INSTALL_SCRIPT.indexOf('COMMITTED=1')
    expect([stage, verify, backup, promote, launch, commit].every((index) => index >= 0)).toBe(true)
    expect(stage).toBeLessThan(verify)
    expect(verify).toBeLessThan(backup)
    expect(backup).toBeLessThan(promote)
    expect(promote).toBeLessThan(launch)
    expect(launch).toBeLessThan(commit)
    expect(MAC_INSTALL_SCRIPT).toContain(
      'if [ "$PROMOTED" -eq 1 ] && [ -e "$TARGET" ]; then rm -rf "$TARGET"; fi'
    )
    expect(MAC_INSTALL_SCRIPT).toContain(
      'if [ "$BACKED_UP" -eq 1 ] && [ -e "$BACKUP" ] && [ ! -e "$TARGET" ]; then mv "$BACKUP" "$TARGET" || true; fi'
    )
    expect(MAC_INSTALL_SCRIPT).not.toContain('hdiutil attach "$DMG" -nobrowse -noverify')
    expect(MAC_INSTALL_SCRIPT).not.toContain(
      'rm -rf "$TARGET"\nif ! /usr/bin/ditto "$SRC" "$TARGET"'
    )
  })
})

describe('UpdateService.check 节流（窗口内复用缓存，避免连续打 GitHub 接口触发 403）', () => {
  it('非强制二次检查复用缓存、不发请求；force 绕过节流实时再拉', async () => {
    const svc = new UpdateService(() => null)
    const svcInternal = svc as unknown as {
      fetchLatestRelease: () => Promise<{
        tagName: string
        htmlUrl: string
        assets: UpdateAsset[]
      } | null>
    }
    const spy = vi.spyOn(svcInternal, 'fetchLatestRelease').mockResolvedValue({
      tagName: 'v9.9.9',
      htmlUrl: 'https://example/release',
      assets: []
    })

    const first = await svc.check()
    expect(first.latestVersion).toBe('9.9.9')
    expect(spy).toHaveBeenCalledTimes(1)

    // 窗口内、非强制 → 直接返回缓存对象，不再发请求
    const cached = await svc.check()
    expect(cached).toBe(first)
    expect(spy).toHaveBeenCalledTimes(1)

    // force → 绕过节流，实时再拉一次
    await svc.check({ force: true })
    expect(spy).toHaveBeenCalledTimes(2)

    spy.mockRestore()
  })
})
