import { isAbsolute, relative, resolve } from 'node:path'

export const PACKAGED_RENDERER_SCHEME = 'agent-os'
export const PACKAGED_RENDERER_URL = `${PACKAGED_RENDERER_SCHEME}://app/index.html`

/** 将自定义协议路径限制在构建后的 renderer 目录内，避免暴露或读取本地安装路径。 */
export function resolveRendererAssetPath(rendererRoot: string, requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl)
    if (url.protocol !== `${PACKAGED_RENDERER_SCHEME}:` || url.hostname !== 'app') return null
    const requestedPath = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const resolvedRoot = resolve(rendererRoot)
    const candidate = resolve(resolvedRoot, requestedPath)
    const relativePath = relative(resolvedRoot, candidate)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null
    return candidate
  } catch {
    return null
  }
}
