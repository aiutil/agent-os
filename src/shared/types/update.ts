// 应用自动更新相关类型（SPEC：GitHub Releases 自研更新器）。

/** 更新状态机状态。 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

/** 主进程维护的全局更新状态，推送给渲染端驱动 UI。 */
export interface UpdateState {
  status: UpdateStatus
  /** 当前已安装版本（app.getVersion）。 */
  currentVersion: string
  /** 线上最新版本（去掉前导 v）。 */
  latestVersion: string
  /** release 页面 URL。 */
  releaseUrl: string
  /** 正在/已下载的资产文件名。 */
  assetName: string
  /** 下载进度 0-100。 */
  progress: number
  /** 已下载安装包的本地路径。 */
  downloadedPath: string
  /** 错误信息（error 态）。 */
  error: string
  /** 最近一次检查时间 ISO 字符串。 */
  lastCheckedAt: string
}

/** GitHub release 资产。 */
export interface UpdateAsset {
  name: string
  browser_download_url: string
  size: number
  /** GitHub Release API 返回的内容摘要；当前只接受 sha256:<64 hex>。 */
  digest?: string
}

/** check() 返回结果。 */
export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  releaseUrl: string | null
  error?: string
}

/** 下载进度事件（EVENTS.updateProgress）。 */
export interface UpdateProgressEvent {
  state: string
  progress?: number
  error?: string
  downloadedPath?: string
}
