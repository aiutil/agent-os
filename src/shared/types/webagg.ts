// Web 聚合类型（SPEC-011）。

/** Web AI provider 声明。 */
export interface WebProvider {
  id: string
  name: string
  /** 起始 URL（直接在 WebContentsView 里加载）。 */
  url: string
  /** 是否为内置 provider（用户不可删除）。 */
  builtin: boolean
  /** 登录检测：URL 规则（包含该字符串表示未登录）。 */
  loginProbeUrl?: string
  /** 输入框注入配置（选择器随站点更新可能失效）。 */
  inputAdapter?: {
    /** 输入框 CSS 选择器。 */
    fillSelector: string
    /** 发送方式：enter = 模拟 Enter 键；click = 点击发送按钮。 */
    sendMethod: 'enter' | 'click'
    /** 发送按钮 CSS 选择器（sendMethod='click' 时）。 */
    sendSelector?: string
  }
}

/** 每次广播单列结果。 */
export interface WebAggBroadcastResult {
  providerId: string
  ok: boolean
  reason?: string
}

/** Provider 登录状态。 */
export type WebAggLoginState = 'unknown' | 'logged-in' | 'logged-out'

/** Web 聚合整体状态（持久化到 app-store）。 */
export interface WebAggState {
  activeProviderIds: string[]
  loginState: Record<string, WebAggLoginState>
}

/** view bounds（相对于 BrowserWindow client area）。 */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** 单列完整视图状态。 */
export interface WebProviderView extends WebProvider {
  loginState: WebAggLoginState
  injectStatus: 'ready' | 'injecting' | 'inject-failed'
}

/** Web 镜头书签（任意网站，原生 WebContentsView 加载）。 */
export interface WebBookmark {
  id: string
  name: string
  url: string
  color: string
  pinned: boolean
}

/** 单个站点视图的实时状态（推送到渲染端驱动工具栏）。 */
export interface WebSiteState {
  id: string
  status: 'loading' | 'loaded' | 'failed'
  title: string
  url: string
  canGoBack: boolean
  canGoForward: boolean
  failReason?: string
}
