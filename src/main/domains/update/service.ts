// 应用自动更新（移植自 agent-life electron/updater.cjs，TS/ESM 化）。
// 策略：轮询 GitHub Releases API 获取最新 release，下载平台安装包（.dmg/.exe/.AppImage），
// 通过 shell.openPath 触发安装后退出。不依赖 electron-updater，以兼容旧版（v0.1.x）升级链。

import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage } from 'node:http'
import { app, shell, type BrowserWindow } from 'electron'
import { tr } from '@shared/i18n'
import { EVENTS } from '@shared/ipc-contract'
import type {
  UpdateAsset,
  UpdateCheckResult,
  UpdateProgressEvent,
  UpdateState
} from '@shared/types'

// Public release address after the source and product-site migration.
const GITHUB_OWNER = 'aiutil'
const GITHUB_REPO = 'agent-os'
const TMP_SUBDIR = 'agent-os-update'

/**
 * 自动检查的节流窗口：未认证的 GitHub Releases API 共享 60次/小时·IP 额度，
 * 开应用 / 进设置 / 进关于等自动触发在本窗口内复用上次结果，避免连续打接口触发 403。
 * 设置页手动「检查更新」与错误后「重新检查」走 force，绕过本窗口实时拉取。
 */
const AUTO_CHECK_THROTTLE_MS = 10 * 60 * 1000 // 10 分钟

/** 比较两个 semver 字符串，latest 比 current 新则返回 true。 */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = current.replace(/^v/, '').split('.').map(Number)
  const b = latest.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const ai = a[i] || 0
    const bi = b[i] || 0
    if (bi > ai) return true
    if (bi < ai) return false
  }
  return false
}

/**
 * 选取当前平台/架构的安装包。
 * - darwin → .dmg，win32 → .exe，linux → .AppImage
 * - arch 感知：识别 x64/x86_64/amd64 与 arm64/aarch64 别名。
 * - 带明确架构标记的异构资产绝不 fallback；仅兼容没有任何架构标记的旧版通用包。
 */
export function pickAsset(
  assets: UpdateAsset[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): UpdateAsset | null {
  const ext = platform === 'win32' ? '.exe' : platform === 'linux' ? '.appimage' : '.dmg'
  const candidates = assets.filter((a) => a.name.toLowerCase().endsWith(ext))
  if (candidates.length === 0) return null
  const aliases: Record<string, string[]> = {
    x64: ['x64', 'x86_64', 'amd64'],
    arm64: ['arm64', 'aarch64']
  }
  const knownMarkers = Object.values(aliases).flat()
  const requested = aliases[arch] ?? [arch.toLowerCase()]
  const archMatch = candidates.find((asset) => {
    const name = asset.name.toLowerCase()
    return requested.some((marker) => name.includes(marker))
  })
  if (archMatch) return archMatch
  const generic = candidates.filter((asset) => {
    const name = asset.name.toLowerCase()
    return !knownMarkers.some((marker) => name.includes(marker))
  })
  return generic.length === 1 ? generic[0] : null
}

/** 解析并校验 GitHub asset digest；缺摘要时 fail closed。 */
export function updateAssetSha256(asset: Pick<UpdateAsset, 'digest'>): string {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest ?? '')
  if (!match) throw new Error(tr('system.update.unverifiedAsset'))
  return match[1].toLowerCase()
}

/** 下载完成后的 size + SHA-256 双重校验。 */
export function assertUpdateAssetIntegrity(
  asset: Pick<UpdateAsset, 'size' | 'digest'>,
  receivedBytes: number,
  sha256: string
): void {
  const expectedSha = updateAssetSha256(asset)
  if (!Number.isInteger(asset.size) || asset.size <= 0 || receivedBytes !== asset.size ||
    !/^[a-f0-9]{64}$/i.test(sha256) || sha256.toLowerCase() !== expectedSha) {
    throw new Error(tr('system.update.integrityFailed'))
  }
}

/** GitHub asset 名只能是单一文件名，不能逃逸专用更新目录。 */
export function safeUpdateAssetName(name: string): string {
  if (!name || name === '.' || name === '..' || name.includes('\0') ||
    path.posix.basename(name) !== name || path.win32.basename(name) !== name) {
    throw new Error(tr('system.update.unsafeAssetName'))
  }
  return name
}

async function fileIntegrity(filePath: string): Promise<{ bytes: number; sha256: string }> {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += data.length
      hash.update(data)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ bytes, sha256: hash.digest('hex') }))
  })
}

/** 发起 HTTPS GET 并返回解析后的 JSON（跟随重定向）。 */
function httpsGetJSON(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, rejectUnauthorized: true }, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        httpsGetJSON(res.headers.location, headers).then(resolve, reject)
        return
      }
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      if (status !== 200) {
        res.on('end', () => reject(new Error(`HTTP ${status}: ${body.slice(0, 200)}`)))
        return
      }
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          reject(new Error('Invalid JSON response'))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('Request timeout')))
  })
}

function currentAppVersion(): string {
  try {
    return app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function createInitialState(currentVersion: string): UpdateState {
  return {
    status: 'idle',
    currentVersion: currentVersion || '0.0.0',
    latestVersion: '',
    releaseUrl: '',
    assetName: '',
    progress: 0,
    downloadedPath: '',
    error: '',
    lastCheckedAt: ''
  }
}

// macOS 原地升级脚本。参数：$1=旧进程 PID，$2=dmg 路径，$3=目标 .app，$4=挂载点，$5=日志。
export const MAC_INSTALL_SCRIPT = `#!/bin/bash
set -u
OLD_PID="$1"; DMG="$2"; TARGET="$3"; MOUNT="$4"; LOG="$5"
exec >>"$LOG" 2>&1
echo "[updater] start $(date) pid=$OLD_PID target=$TARGET"
OPEN_DMG_ON_FAILURE=0
BACKED_UP=0
PROMOTED=0
COMMITTED=0
STAGE=""
BACKUP=""

on_exit() {
  STATUS=$?
  if [ "$COMMITTED" -ne 1 ]; then
    if [ "$PROMOTED" -eq 1 ] && [ -e "$TARGET" ]; then rm -rf "$TARGET"; fi
    if [ "$BACKED_UP" -eq 1 ] && [ -e "$BACKUP" ] && [ ! -e "$TARGET" ]; then mv "$BACKUP" "$TARGET" || true; fi
    if [ -n "$STAGE" ] && [ -e "$STAGE" ]; then rm -rf "$STAGE"; fi
  fi
  hdiutil detach "$MOUNT" 2>/dev/null || true
  rmdir "$MOUNT" 2>/dev/null || true
  if [ "$STATUS" -ne 0 ] && [ "$OPEN_DMG_ON_FAILURE" -eq 1 ]; then open "$DMG" || true; fi
}
trap on_exit EXIT

fail() { echo "[updater] $1"; OPEN_DMG_ON_FAILURE=1; exit 1; }

# 1) 目标必须是现存的绝对 .app 目录；拒绝空路径、根目录和 symlink。
case "$TARGET" in /*.app) ;; *) fail "unsafe target path" ;; esac
[ -d "$TARGET" ] || fail "target app missing"
[ ! -L "$TARGET" ] || fail "target app must not be a symlink"
PARENT="$(dirname "$TARGET")"
BASENAME="$(basename "$TARGET")"
[ "$PARENT" != "/" ] || fail "unsafe target parent"
[ -n "$BASENAME" ] && [ "$BASENAME" != ".app" ] || fail "unsafe target name"
STAGE="$PARENT/.\${BASENAME}.update-stage-\${OLD_PID}"
BACKUP="$PARENT/.\${BASENAME}.update-backup-\${OLD_PID}"
[ ! -e "$STAGE" ] || fail "stage path already exists"
[ ! -e "$BACKUP" ] || fail "backup path already exists"

# 2) 等待旧进程退出（最多 ~30s），超时不触碰旧应用。
for i in $(seq 1 60); do kill -0 "$OLD_PID" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$OLD_PID" 2>/dev/null; then fail "old process did not exit"; fi

# 3) 挂载并验证 dmg。
mkdir -p "$MOUNT"
if ! hdiutil attach "$DMG" -nobrowse -mountpoint "$MOUNT"; then fail "attach failed"; fi

# 4) 先在目标同父目录完整 stage，再验证签名；此时旧应用保持不动。
SRC="$(/usr/bin/find "$MOUNT" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$SRC" ]; then fail "no .app in dmg"; fi
if ! /usr/bin/ditto "$SRC" "$STAGE"; then fail "stage copy failed"; fi
if ! /usr/bin/codesign --verify --deep --strict "$STAGE"; then fail "staged app signature invalid"; fi

# 5) 原子切换：旧版先改名为 backup，提升失败由 EXIT trap 恢复。
if ! mv "$TARGET" "$BACKUP"; then fail "backup move failed"; fi
BACKED_UP=1
if ! mv "$STAGE" "$TARGET"; then fail "stage promotion failed"; fi
PROMOTED=1
/usr/bin/xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

# 6) 卸载 dmg，并确认系统接受新应用启动请求；失败仍回滚旧版。
hdiutil detach "$MOUNT" 2>/dev/null || true
rmdir "$MOUNT" 2>/dev/null || true
if ! open "$TARGET"; then fail "new app launch failed"; fi

# 7) 启动请求成功后提交，清理 backup。
COMMITTED=1
rm -rf "$BACKUP"
echo "[updater] done $(date)"
`

interface LatestRelease {
  tagName: string
  htmlUrl: string
  assets: UpdateAsset[]
}

export class UpdateService {
  private latestRelease: LatestRelease | null = null
  private downloadedFilePath: string | null = null
  private downloadedAsset: UpdateAsset | null = null
  private downloadedReleaseTag: string | null = null
  private isDownloading = false
  private state: UpdateState
  /** 最近一次实际拉取（非缓存返回）的时间戳（ms），用于自动检查节流。 */
  private lastFetchAt = 0
  /** 节流缓存：窗口内的自动检查直接返回此结果，不发网络请求。 */
  private cachedCheck: { result: UpdateCheckResult; release: LatestRelease | null } | null = null

  constructor(
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly updateDirectory = path.join(os.tmpdir(), TMP_SUBDIR)
  ) {
    this.state = createInitialState(currentAppVersion())
  }

  getState(): UpdateState {
    return { ...this.state }
  }

  private setState(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial }
    this.emitState()
  }

  private emitState(): void {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENTS.updateState, this.getState())
    }
  }

  private sendProgress(payload: UpdateProgressEvent): void {
    const win = this.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENTS.updateProgress, payload)
    }
  }

  private invalidateDownloadedPackage(removeFile = false): boolean {
    const previousPath = this.downloadedFilePath
    this.downloadedFilePath = null
    this.downloadedAsset = null
    this.downloadedReleaseTag = null
    if (removeFile && previousPath) {
      try {
        fs.rmSync(previousPath, { force: true })
      } catch {
        /* 下一次下载仍会覆盖专用目录中的同名文件。 */
      }
    }
    return previousPath !== null
  }

  /** 拉取最新 release。 */
  private async fetchLatestRelease(): Promise<LatestRelease | null> {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    const data = (await httpsGetJSON(url, {
      'User-Agent': 'agent-os-updater',
      Accept: 'application/vnd.github+json'
    })) as {
      tag_name?: string
      html_url?: string
      assets?: Array<{ name: string; browser_download_url: string; size: number; digest?: string }>
    }
    if (!data || !data.tag_name) return null
    return {
      tagName: data.tag_name,
      htmlUrl: data.html_url ?? '',
      assets: (data.assets ?? []).map((a) => ({
        name: a.name,
        browser_download_url: a.browser_download_url,
        size: a.size,
        digest: a.digest
      }))
    }
  }

  /**
   * 检查更新；silent=true 时失败不弹错误态。
   * 节流：非 force 且距上次实际拉取不足 AUTO_CHECK_THROTTLE_MS 时，直接返回上次结果，
   * 不发网络请求、不改状态——避免开应用 / 进设置 / 进关于接连打 GitHub Releases API
   * （未认证请求共享 60次/小时·IP 额度，连续触发极易触发 403）。
   * force=true 绕过节流实时拉取：设置页手动「检查更新」、错误后「重新检查」用。
   */
  async check(opts: { silent?: boolean; force?: boolean } = {}): Promise<UpdateCheckResult> {
    const silent = opts.silent === true
    const force = opts.force === true
    if (!force && this.cachedCheck && Date.now() - this.lastFetchAt < AUTO_CHECK_THROTTLE_MS) {
      return this.cachedCheck.result
    }
    const currentVersion = currentAppVersion()
    this.setState({
      status: 'checking',
      currentVersion,
      error: '',
      lastCheckedAt: new Date().toISOString()
    })
    try {
      const release = await this.fetchLatestRelease()
      if (!release) {
        const result: UpdateCheckResult = {
          currentVersion,
          latestVersion: null,
          hasUpdate: false,
          releaseUrl: null
        }
        this.setState({ status: 'idle', latestVersion: '', releaseUrl: '', error: tr('system.update.noRelease') })
        this.rememberCheck(result, null)
        return result
      }
      this.latestRelease = release
      const hasUpdate = isNewerVersion(currentVersion, release.tagName)
      let invalidatedDownload = false
      if (this.downloadedFilePath) {
        const downloadedStillCurrent = hasUpdate && this.downloadedReleaseTag === release.tagName &&
          this.downloadedAsset !== null && release.assets.some((asset) =>
            asset.name === this.downloadedAsset?.name && asset.size === this.downloadedAsset.size &&
            asset.digest === this.downloadedAsset.digest)
        if (!downloadedStillCurrent) invalidatedDownload = this.invalidateDownloadedPackage(true)
      }
      const latestVersion = release.tagName.replace(/^v/, '')
      const result: UpdateCheckResult = {
        currentVersion,
        latestVersion,
        hasUpdate,
        releaseUrl: hasUpdate ? release.htmlUrl : null
      }
      if (hasUpdate) {
        this.setState({
          status: 'available',
          latestVersion,
          releaseUrl: release.htmlUrl,
          ...(invalidatedDownload ? { downloadedPath: '', assetName: '', progress: 0 } : {})
        })
      } else {
        this.setState({
          status: 'idle',
          latestVersion,
          releaseUrl: '',
          ...(invalidatedDownload ? { downloadedPath: '', assetName: '', progress: 0 } : {})
        })
      }
      this.rememberCheck(result, release)
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : tr('system.update.checkFailed')
      if (silent) {
        this.setState({ status: 'idle', error: '' })
      } else {
        this.setState({ status: 'error', error })
      }
      const result: UpdateCheckResult = {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: null,
        error
      }
      // 失败也缓存：窗口内的自动触发复用同一结果，避免对同一错误反复打接口；
      // 用户想重试时用设置页「检查更新」(force) 实时拉取。
      this.rememberCheck(result, null)
      return result
    }
  }

  /** 记录本次实际拉取的时间与结果，供节流窗口内复用。 */
  private rememberCheck(result: UpdateCheckResult, release: LatestRelease | null): void {
    this.lastFetchAt = Date.now()
    this.cachedCheck = { result, release }
  }

  /** 开始下载安装包，进度经 EVENTS.updateProgress 推送。 */
  async startDownload(): Promise<{ started: boolean; error?: string }> {
    if (this.isDownloading) return { started: false, error: tr('system.update.downloadInProgress') }
    if (!this.latestRelease) return { started: false, error: tr('system.update.checkFirst') }

    // 下载期间仍可能触发一次强制 check；固定启动时的 release 快照，避免旧资产
    // 完成后误绑定到刚刷新的 tag。
    const release = this.latestRelease
    const asset = pickAsset(release.assets)
    if (!asset) {
      const platform =
        process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : 'macOS'
      const msg = tr('system.update.noAssetForPlatform', { platform })
      this.setState({ status: 'error', error: msg })
      return { started: false, error: msg }
    }
    try {
      updateAssetSha256(asset)
      safeUpdateAssetName(asset.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : tr('system.update.unverifiedAsset')
      this.setState({ status: 'error', error: message })
      return { started: false, error: message }
    }

    this.isDownloading = true
    this.invalidateDownloadedPackage(true)
    this.setState({ status: 'downloading', progress: 0, assetName: asset.name, downloadedPath: '', error: '' })
    let destPath = ''

    try {
      const tmpDir = this.updateDirectory
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
      fs.chmodSync(tmpDir, 0o700)
      destPath = path.join(tmpDir, safeUpdateAssetName(asset.name))
      await this.downloadFile(asset.browser_download_url, destPath, asset)
      const releaseStillCurrent = this.latestRelease?.tagName === release.tagName &&
        this.latestRelease.assets.some((candidate) =>
          candidate.name === asset.name && candidate.size === asset.size && candidate.digest === asset.digest)
      if (!releaseStillCurrent) throw new Error(tr('system.update.updateTargetChanged'))
      this.downloadedFilePath = destPath
      this.downloadedAsset = { ...asset }
      this.downloadedReleaseTag = release.tagName
      this.setState({ status: 'downloaded', progress: 100, downloadedPath: destPath })
      this.sendProgress({ state: 'downloaded', progress: 100, downloadedPath: destPath })
      return { started: true }
    } catch (error) {
      const reason = error instanceof Error ? error.message : tr('system.update.checkFailed')
      const message = tr('system.update.downloadFailed', { reason })
      this.invalidateDownloadedPackage(false)
      this.setState({
        status: 'error',
        error: message
      })
      try {
        if (destPath && fs.existsSync(destPath)) fs.unlinkSync(destPath)
      } catch {
        /* ignore */
      }
      return { started: false, error: message }
    } finally {
      this.isDownloading = false
    }
  }

  /** 安装：打开已下载的安装包，可选退出当前应用让安装器接管。 */
  async install(opts: { quitAfterOpen?: boolean } = {}): Promise<{ ok: boolean; error?: string; quit?: boolean }> {
    const quitAfterOpen = opts.quitAfterOpen !== false
    if (!this.downloadedFilePath) {
      const msg = tr('system.update.noDownloaded')
      this.setState({ status: 'error', downloadedPath: '', error: msg })
      return { ok: false, error: msg }
    }
    if (!fs.existsSync(this.downloadedFilePath)) {
      this.invalidateDownloadedPackage(false)
      const msg = tr('system.update.packageMissing')
      this.setState({ status: 'error', downloadedPath: '', error: msg })
      return { ok: false, error: msg }
    }
    const asset = this.downloadedAsset
    if (!asset || !this.downloadedReleaseTag ||
      (this.latestRelease && this.latestRelease.tagName !== this.downloadedReleaseTag)) {
      this.invalidateDownloadedPackage(false)
      const msg = tr('system.update.noDownloaded')
      this.setState({ status: 'error', downloadedPath: '', error: msg })
      return { ok: false, error: msg }
    }
    try {
      const integrity = await fileIntegrity(this.downloadedFilePath)
      assertUpdateAssetIntegrity(asset, integrity.bytes, integrity.sha256)
    } catch {
      const invalidPath = this.downloadedFilePath
      this.invalidateDownloadedPackage(false)
      try {
        fs.rmSync(invalidPath, { force: true })
      } catch {
        /* best effort */
      }
      const msg = tr('system.update.integrityFailed')
      this.setState({ status: 'error', downloadedPath: '', error: msg })
      return { ok: false, error: msg, quit: false }
    }
    this.setState({ status: 'installing' })

    // macOS：原地静默升级——后台脚本等待本进程退出 → 挂载 dmg → 覆盖 .app → 重新启动。
    // 让用户无需手动关闭应用、手动拖拽。失败则自动回退到「打开 dmg 手动安装」。
    if (process.platform === 'darwin') {
      const launched = this.installMacInPlace(this.downloadedFilePath)
      if (launched) {
        if (quitAfterOpen) setTimeout(() => app.quit(), 600)
        return { ok: true, quit: quitAfterOpen }
      }
      // 未能启动原地升级脚本（如无法定位 .app 包）→ 走下面的 openPath 回退。
    }

    try {
      const errMsg = await shell.openPath(this.downloadedFilePath)
      if (errMsg) {
        this.setState({ status: 'error', error: errMsg })
        return { ok: false, error: errMsg, quit: false }
      }
      if (quitAfterOpen) {
        setTimeout(() => app.quit(), 800)
      }
      return { ok: true, quit: quitAfterOpen }
    } catch (err) {
      const error = err instanceof Error ? err.message : tr('system.update.cannotOpen')
      this.setState({ status: 'error', error })
      return { ok: false, error, quit: false }
    }
  }

  /**
   * macOS 原地升级：写一个分离的 bash 脚本并 detached 拉起，由它在本进程退出后
   * 挂载 dmg、用 ditto 覆盖当前 .app、清除隔离属性、卸载 dmg 并重新打开新版本。
   * 任一步失败则脚本回退到 `open <dmg>` 让用户手动安装。
   * @returns 是否成功拉起后台脚本（false 时调用方走 openPath 回退）。
   */
  private installMacInPlace(dmgPath: string): boolean {
    try {
      const exe = app.getPath('exe') // …/Agent OS.app/Contents/MacOS/Agent OS
      const m = exe.match(/^(.*\.app)\/Contents\/MacOS\//)
      if (!m) return false // 开发态或非常规安装，无法定位 .app 包。
      const targetApp = m[1]

      const dir = this.updateDirectory
      fs.mkdirSync(dir, { recursive: true })
      const scriptPath = path.join(dir, 'mac-install.sh')
      const mountPoint = path.join(dir, `mnt-${Date.now()}`)
      const logPath = path.join(dir, 'install.log')

      fs.writeFileSync(scriptPath, MAC_INSTALL_SCRIPT, { mode: 0o755 })
      const child = spawn(
        '/bin/bash',
        [scriptPath, String(process.pid), dmgPath, targetApp, mountPoint, logPath],
        { detached: true, stdio: 'ignore' }
      )
      child.unref()
      return true
    } catch {
      return false
    }
  }

  /** 只接受 HTTPS，并有限跟随 GitHub CDN 重定向。 */
  private openDownload(url: string, redirects = 5): Promise<IncomingMessage> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return Promise.reject(new Error('Invalid update download URL'))
    }
    if (parsed.protocol !== 'https:') {
      return Promise.reject(new Error('Refusing non-HTTPS update download URL'))
    }
    return new Promise((resolve, reject) => {
      const request = https.get(parsed, { rejectUnauthorized: true }, (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume()
          if (redirects <= 0) {
            reject(new Error('Too many update download redirects'))
            return
          }
          this.openDownload(new URL(response.headers.location, parsed).toString(), redirects - 1)
            .then(resolve, reject)
          return
        }
        if (status !== 200) {
          response.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        resolve(response)
      })
      request.on('error', reject)
      request.setTimeout(300000, () => request.destroy(new Error(tr('system.update.downloadTimeout'))))
    })
  }

  /** 下载到同目录临时文件；bytes/SHA-256 全部通过后才原子提升。 */
  private async downloadFile(url: string, destPath: string, asset: UpdateAsset): Promise<void> {
    const partialPath = `${destPath}.partial`
    fs.rmSync(partialPath, { force: true })
    const hash = createHash('sha256')
    let receivedBytes = 0
    let lastProgressSent = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        receivedBytes += chunk.length
        hash.update(chunk)
        if (asset.size > 0) {
          // 100% 只在完整性校验和 rename 成功后由 startDownload 发出。
          const progress = Math.min(99, Math.round((receivedBytes / asset.size) * 100))
          if (progress - lastProgressSent >= 2) {
            lastProgressSent = progress
            this.setState({ progress })
            this.sendProgress({ state: 'downloading', progress })
          }
        }
        callback(null, chunk)
      }
    })

    try {
      const response = await this.openDownload(url)
      await pipeline(response, meter, fs.createWriteStream(partialPath, { flags: 'wx', mode: 0o600 }))
      assertUpdateAssetIntegrity(asset, receivedBytes, hash.digest('hex'))
      // Windows 的 FlushFileBuffers（fsyncSync 底层实现）要求句柄具备写访问；
      // 只读 `r` 会在下载完整且摘要正确后仍报 EPERM。`r+` 不截断文件，
      // 同时保留 fsync → close → rename 的持久化与原子提升顺序。
      const file = fs.openSync(partialPath, 'r+')
      try {
        fs.fsyncSync(file)
      } finally {
        fs.closeSync(file)
      }
      fs.rmSync(destPath, { force: true })
      fs.renameSync(partialPath, destPath)
    } catch (error) {
      fs.rmSync(partialPath, { force: true })
      throw error
    }
  }
}
