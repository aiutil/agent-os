// Web 聚合服务（SPEC-011）。
// 管理 WebContentsView 实例（每 provider 一个），隔离 cookie/session，广播注入。

import { WebContentsView, session as electronSession } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  ViewBounds,
  WebAggBroadcastResult,
  WebAggLoginState,
  WebBookmark,
  WebProviderView,
  WebSiteState
} from '@shared/types'
import { BUILTIN_PROVIDERS, getProvider } from './providers'
import { getWebBookmarks, setWebBookmarks } from '../../store/app-store'
import { tr } from '@shared/i18n'

// 把内嵌 WebContentsView 完整伪装成桌面版 Chrome：UA + UA-CH 客户端提示一致，
// 抹掉 Electron 品牌。否则 Google 等会判定「此浏览器可能不安全」而拒绝登录。
// 版本对齐 Electron 33 内置的 Chromium 130，使特性探测与 UA 自洽。
const CHROME_VERSION = '130'
const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`
const SEC_CH_UA = `"Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}", "Not?A_Brand";v="99"`
const SEC_CH_UA_PLATFORM =
  process.platform === 'darwin' ? '"macOS"' : process.platform === 'win32' ? '"Windows"' : '"Linux"'

// OAuth / SSO 登录弹窗的 URL 特征。命中则允许其作为真实顶层窗口打开（见 attachWindowOpenHandler）。
// 关键：Google 等的「使用 Google 登录」走 window.open 弹窗；若被 deny 或塞回内嵌主框架，
// 会被判定为嵌入式 webview 而拒绝（“此浏览器或应用可能不安全”）。放行为真实窗口即可登录。
const AUTH_POPUP_PATTERNS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'oauth2',
  'oauth',
  '/signin',
  '/authorize',
  '/sso',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'github.com/login',
  'auth0.com',
  'okta.com'
]

function isAuthPopupUrl(url: string): boolean {
  const u = url.toLowerCase()
  return AUTH_POPUP_PATTERNS.some((p) => u.includes(p))
}

const configuredSessions = new WeakSet<Electron.Session>()

/** 给会话装上 Chrome UA 与一致的 client-hints（含子资源/XHR），并去除 Electron 痕迹。 */
function configureChromeSession(ses: Electron.Session): void {
  ses.setUserAgent(CHROME_UA)
  if (configuredSessions.has(ses)) return
  configuredSessions.add(ses)
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase()
      if (lower === 'user-agent' || lower === 'sec-ch-ua' || lower === 'sec-ch-ua-mobile' || lower === 'sec-ch-ua-platform') {
        delete headers[key]
      }
    }
    headers['User-Agent'] = CHROME_UA
    headers['sec-ch-ua'] = SEC_CH_UA
    headers['sec-ch-ua-mobile'] = '?0'
    headers['sec-ch-ua-platform'] = SEC_CH_UA_PLATFORM
    callback({ requestHeaders: headers })
  })
}

interface WebAggServiceOptions {
  getMainWindow(): BrowserWindow | null
  emit(channel: string, payload: unknown): void
}

interface ManagedView {
  view: WebContentsView
  providerId: string
  injectStatus: 'ready' | 'injecting' | 'inject-failed'
}

export class WebAggService {
  private readonly views = new Map<string, ManagedView>()
  private activeProviderIds: string[] = []
  private readonly loginState = new Map<string, WebAggLoginState>()
  // Web 镜头：任意 URL 的原生站点视图（独立于 AI 聚合）。
  private readonly siteViews = new Map<string, { view: WebContentsView; url: string }>()

  constructor(private readonly options: WebAggServiceOptions) {}

  /**
   * 统一的新窗口策略：
   * - OAuth/SSO 登录弹窗 → 放行为真实顶层窗口并复用同一 session（共享 cookie），
   *   套上 Chrome UA，使 Google 不再判定为「嵌入式 webview」，登录后 cookie 落回同一会话。
   * - 其它 target=_blank → 仍在当前视图内打开，避免弹出零散窗口。
   */
  private attachWindowOpenHandler(wc: Electron.WebContents, ses: Electron.Session): void {
    wc.setWindowOpenHandler(({ url }) => {
      if (isAuthPopupUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            width: 520,
            height: 680,
            webPreferences: { session: ses }
          }
        }
      }
      void wc.loadURL(url)
      return { action: 'deny' }
    })
    // 新建的登录弹窗也显式套 Chrome UA（其请求头同时被 session 级 onBeforeSendHeaders 兜底）。
    wc.on('did-create-window', (win) => {
      try {
        win.webContents.setUserAgent(CHROME_UA)
      } catch {
        /* ignore */
      }
    })
  }

  // ─── Web 镜头：书签 ─────────────────────────────────────────────────────────

  listBookmarks(): WebBookmark[] {
    return getWebBookmarks()
  }

  addBookmark(input: { name: string; url: string; color?: string }): WebBookmark[] {
    const url = /^https?:\/\//.test(input.url) ? input.url : `https://${input.url}`
    const bookmark: WebBookmark = {
      id: `bm-${Math.random().toString(36).slice(2, 9)}`,
      name: input.name.trim() || url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      url,
      color: input.color ?? '#6b6b70',
      pinned: false
    }
    const next = [...getWebBookmarks(), bookmark]
    setWebBookmarks(next)
    return next
  }

  updateBookmark(id: string, input: { name?: string; url?: string; color?: string }): WebBookmark[] {
    const next = getWebBookmarks().map((bookmark) => {
      if (bookmark.id !== id) return bookmark
      const rawUrl = input.url?.trim()
      const url = rawUrl ? (/^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}`) : bookmark.url
      return {
        ...bookmark,
        name: input.name?.trim() || bookmark.name,
        url,
        color: input.color ?? bookmark.color
      }
    })
    setWebBookmarks(next)
    return next
  }

  removeBookmark(id: string): WebBookmark[] {
    const next = getWebBookmarks().filter((b) => b.id !== id)
    setWebBookmarks(next)
    return next
  }

  // ─── Web 镜头：站点视图（原生 WebContentsView + 自定义 UA） ───────────────────

  private emitSiteState(id: string, view: WebContentsView, status: 'loading' | 'loaded' | 'failed', failReason?: string): void {
    const wc = view.webContents
    this.options.emit('webagg:siteStateChanged', {
      id,
      status,
      title: wc.getTitle(),
      url: wc.getURL(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      failReason
    })
  }

  openSite(id: string, url: string): void {
    const existing = this.siteViews.get(id)
    if (existing) {
      if (existing.url !== url) {
        existing.url = url
        void existing.view.webContents.loadURL(url)
      }
      return
    }
    const ses = electronSession.fromPartition('persist:webview')
    configureChromeSession(ses)
    const view = new WebContentsView({ webPreferences: { session: ses } })
    view.webContents.setUserAgent(CHROME_UA)
    const wc = view.webContents
    wc.on('did-start-loading', () => this.emitSiteState(id, view, 'loading'))
    wc.on('did-stop-loading', () => this.emitSiteState(id, view, 'loaded'))
    wc.on('page-title-updated', () => this.emitSiteState(id, view, 'loaded'))
    wc.on('did-navigate', () => this.emitSiteState(id, view, 'loaded'))
    // SPA 内导航（ChatGPT/Claude.ai 等用 history.pushState 切换对话）：did-navigate 抓不到，
    // 靠 did-navigate-in-page 才会 emit，上层据此把对话级 URL 存为 lastUrl（对比 webchat 恢复用）。
    wc.on('did-navigate-in-page', () => this.emitSiteState(id, view, 'loaded'))
    wc.on('did-fail-load', (_e, code, desc, _validatedURL, isMainFrame) => {
      if (isMainFrame && code !== -3) this.emitSiteState(id, view, 'failed', desc)
    })
    // 新窗口：OAuth 登录弹窗放行为真实窗口（共享 session），其余在当前视图内打开。
    this.attachWindowOpenHandler(wc, ses)
    this.siteViews.set(id, { view, url })
    void wc.loadURL(url)
  }

  siteAction(id: string, action: 'back' | 'forward' | 'reload'): void {
    const m = this.siteViews.get(id)
    if (!m) return
    const wc = m.view.webContents
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
  }

  getSiteState(id: string): WebSiteState | null {
    const m = this.siteViews.get(id)
    if (!m) return null
    const wc = m.view.webContents
    return {
      id,
      status: wc.isLoading() ? 'loading' : 'loaded',
      title: wc.getTitle(),
      url: wc.getURL() || m.url,
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  /** 定位/显隐站点视图。空对象 = 隐藏全部站点视图（页面切走兜底）。 */
  updateSiteBounds(bounds: Record<string, ViewBounds>): void {
    const win = this.options.getMainWindow()
    if (!win) return
    if (Object.keys(bounds).length === 0) {
      for (const m of this.siteViews.values()) {
        try { win.contentView.removeChildView(m.view) } catch { /* not attached */ }
      }
      return
    }
    for (const [id, b] of Object.entries(bounds)) {
      const m = this.siteViews.get(id)
      if (!m) continue
      if (!b.visible) {
        try { win.contentView.removeChildView(m.view) } catch { /* not attached */ }
        continue
      }
      try {
        if (!win.contentView.children.includes(m.view)) win.contentView.addChildView(m.view)
      } catch { /* already attached */ }
      m.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })
    }
  }

  /** 向站点视图注入文本并提交（对比镜头批量发送）。 */
  async injectSite(id: string, text: string): Promise<boolean> {
    const m = this.siteViews.get(id)
    if (!m) return false
    try {
      const wc = m.view.webContents
      wc.focus()
      // 用 execCommand('insertText') 走真实输入管线：React / ProseMirror（ChatGPT、Claude 等）
      // 才会同步内部状态、启用发送按钮；直接赋值 innerText 常常「填了但不生效」。
      const ok = await wc.executeJavaScript(`
        (function() {
          const text = ${JSON.stringify(text)}
          const selectors = [
            '#prompt-textarea',
            'div[contenteditable="true"][data-testid="composer-editor"]',
            'textarea:not([readonly]):not([disabled])',
            'div[contenteditable="true"]',
            '[contenteditable="true"]',
            '[contenteditable]',
            'div[role="textbox"]',
            'input[type="text"]:not([readonly]):not([disabled])'
          ]
          let el = null
          for (const sel of selectors) {
            const found = document.querySelector(sel)
            if (found) { el = found; break }
          }
          if (!el) return false
          el.focus()
          const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
          try {
            if (isField) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
              setter?.call(el, '')
            } else {
              const range = document.createRange()
              range.selectNodeContents(el)
              const sel = window.getSelection()
              sel.removeAllRanges()
              sel.addRange(range)
            }
          } catch (e) { /* 清空失败不阻断插入 */ }
          let inserted = false
          try { inserted = document.execCommand('insertText', false, text) } catch (e) { inserted = false }
          if (!inserted) {
            if (isField) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
              setter?.call(el, text)
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
            } else {
              el.innerText = text
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }))
            }
          }
          return true
        })()
      `)
      if (!ok) return false
      // 等框架处理 input、启用发送按钮后再提交。
      await new Promise((resolve) => setTimeout(resolve, 180))
      const clicked = await wc
        .executeJavaScript(`
          (function() {
            const sels = [
              '[data-testid="send-button"]',
              'button[data-testid="send-button"]',
              'button[aria-label*="Send" i]',
              'button[aria-label*="发送"]',
              'button[type="submit"]:not([disabled])'
            ]
            for (const s of sels) {
              const b = document.querySelector(s)
              if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); return true }
            }
            return false
          })()
        `)
        .catch(() => false)
      if (!clicked) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      }
      return true
    } catch {
      return false
    }
  }

  closeSite(id: string): void {
    const m = this.siteViews.get(id)
    if (!m) return
    const win = this.options.getMainWindow()
    if (win) {
      try { win.contentView.removeChildView(m.view) } catch { /* not attached */ }
    }
    m.view.webContents.close()
    this.siteViews.delete(id)
  }

  // ─── provider query ───────────────────────────────────────────────────────

  listProviders(): WebProviderView[] {
    return BUILTIN_PROVIDERS.map((p) => ({
      ...p,
      loginState: this.loginState.get(p.id) ?? 'unknown',
      injectStatus: this.views.get(p.id)?.injectStatus ?? 'ready'
    }))
  }

  // ─── active set management ─────────────────────────────────────────────────

  async setActive(providerIds: string[]): Promise<void> {
    // 关闭不再活跃的 view
    for (const [id, managed] of this.views) {
      if (!providerIds.includes(id)) {
        this.detachAndDestroy(managed)
        this.views.delete(id)
      }
    }

    // 创建新增的 view
    for (const id of providerIds) {
      if (!this.views.has(id)) {
        const provider = getProvider(id)
        if (!provider) continue
        const view = this.createView(id)
        this.views.set(id, { view, providerId: id, injectStatus: 'ready' })
        await view.webContents.loadURL(provider.url)
        this.watchLoginState(id, view)
      }
    }

    this.activeProviderIds = providerIds
  }

  private createView(providerId: string): WebContentsView {
    const partition = `persist:webagg-${providerId}`
    const ses = electronSession.fromPartition(partition)
    configureChromeSession(ses)
    const view = new WebContentsView({ webPreferences: { session: ses } })
    view.webContents.setUserAgent(CHROME_UA)
    // provider 视图（如 ChatGPT）也需放行 Google 登录弹窗，否则同样被判定为不安全。
    this.attachWindowOpenHandler(view.webContents, ses)
    return view
  }

  private detachAndDestroy(managed: ManagedView): void {
    const win = this.options.getMainWindow()
    if (win) {
      try {
        win.contentView.removeChildView(managed.view)
      } catch {
        // view may not be attached
      }
    }
    managed.view.webContents.close()
  }

  private watchLoginState(providerId: string, view: WebContentsView): void {
    const provider = getProvider(providerId)
    view.webContents.on('did-navigate', (_event, url) => {
      if (!provider?.loginProbeUrl) return
      const isLoginPage = url.includes(provider.loginProbeUrl)
      const newState: WebAggLoginState = isLoginPage ? 'logged-out' : 'logged-in'
      this.loginState.set(providerId, newState)
      this.options.emit('webagg:loginStateChanged', { providerId, state: newState })
    })
  }

  // ─── bounds ────────────────────────────────────────────────────────────────

  updateBounds(bounds: Record<string, ViewBounds>): void {
    const win = this.options.getMainWindow()
    if (!win) return

    // 空对象 = 隐藏全部（页面切走时的兜底调用）
    if (Object.keys(bounds).length === 0) {
      for (const managed of this.views.values()) {
        try { win.contentView.removeChildView(managed.view) } catch { /* not attached */ }
      }
      return
    }

    for (const [providerId, b] of Object.entries(bounds)) {
      const managed = this.views.get(providerId)
      if (!managed) continue

      if (!b.visible) {
        try {
          win.contentView.removeChildView(managed.view)
        } catch {
          // not attached
        }
        continue
      }

      // Ensure attached
      try {
        if (!win.contentView.children.includes(managed.view)) {
          win.contentView.addChildView(managed.view)
        }
      } catch {
        // may already be attached
      }

      managed.view.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height)
      })
    }
  }

  // ─── broadcast ─────────────────────────────────────────────────────────────

  async broadcast(text: string): Promise<WebAggBroadcastResult[]> {
    const results: WebAggBroadcastResult[] = []

    for (const id of this.activeProviderIds) {
      const managed = this.views.get(id)
      const provider = getProvider(id)
      if (!managed || !provider?.inputAdapter) {
        results.push({ providerId: id, ok: false, reason: tr('web.inject.noConfig') })
        continue
      }

      managed.injectStatus = 'injecting'
      try {
        const { fillSelector, sendMethod, sendSelector } = provider.inputAdapter
        // 注入文本
        await managed.view.webContents.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(fillSelector)});
            if (!el) throw new Error('selector not found: ' + ${JSON.stringify(fillSelector)});
            el.focus();
            // Try React synthetic event first, fallback to native
            const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')
              || Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype, 'value');
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
              setter?.call(el, ${JSON.stringify(text)});
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              el.innerText = ${JSON.stringify(text)};
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
            }
          })()
        `)

        // 发送
        if (sendMethod === 'enter') {
          await managed.view.webContents.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(fillSelector)});
              if (!el) return;
              el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
              el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            })()
          `)
        } else if (sendMethod === 'click' && sendSelector) {
          await managed.view.webContents.executeJavaScript(`
            (function() {
              const btn = document.querySelector(${JSON.stringify(sendSelector)});
              btn?.click();
            })()
          `)
        }

        managed.injectStatus = 'ready'
        results.push({ providerId: id, ok: true })
      } catch (error) {
        managed.injectStatus = 'inject-failed'
        results.push({
          providerId: id,
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return results
  }

  // ─── reload ────────────────────────────────────────────────────────────────

  async reload(providerId: string): Promise<void> {
    const managed = this.views.get(providerId)
    if (!managed) return
    managed.injectStatus = 'ready'
    await managed.view.webContents.reload()
  }

  // ─── cleanup ───────────────────────────────────────────────────────────────

  destroy(): void {
    for (const managed of this.views.values()) {
      this.detachAndDestroy(managed)
    }
    this.views.clear()
    for (const id of [...this.siteViews.keys()]) this.closeSite(id)
  }
}
