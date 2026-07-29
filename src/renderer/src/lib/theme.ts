// 外观主题（SPEC-010 v2）。支持「跟随系统 / 浅色 / 深色」。
// 解析逻辑保持纯函数以便单测；DOM/matchMedia 副作用独立封装。

import { tr } from '@shared/i18n'

export type ThemePreference = 'system' | 'light' | 'dark'
export type EffectiveTheme = 'light' | 'dark'

export interface ThemeOption {
  value: ThemePreference
  label: string
  hint: string
}

/**
 * 外观选项（带本地化 label/hint）。改为函数以便在调用点（组件渲染期）解析当前语言，
 * 语言切换后下次渲染即生效；避免模块加载期一次性锁定中文。
 */
export function themeOptions(): ThemeOption[] {
  return [
    { value: 'system', label: tr('system.appearance.system'), hint: tr('system.appearance.systemHint') },
    { value: 'light', label: tr('system.appearance.light'), hint: tr('system.appearance.lightHint') },
    { value: 'dark', label: tr('system.appearance.dark'), hint: tr('system.appearance.darkHint') }
  ]
}

/** 纯函数：由偏好与系统是否深色，解析出实际生效主题。 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): EffectiveTheme {
  if (preference === 'light') return 'light'
  if (preference === 'dark') return 'dark'
  return systemPrefersDark ? 'dark' : 'light'
}

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 当前系统是否偏好深色。 */
export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY).matches
    : false
}

/** 把生效主题写到根元素的 data-theme，驱动 tokens.css 覆盖。 */
export function applyTheme(effective: EffectiveTheme): void {
  document.documentElement.dataset.theme = effective
}

/**
 * 应用偏好并在「跟随系统」时监听系统外观变化。
 * 返回取消监听的清理函数。
 */
export function watchTheme(preference: ThemePreference, onChange: (t: EffectiveTheme) => void): () => void {
  applyTheme(resolveTheme(preference, systemPrefersDark()))
  if (preference !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  const mql = window.matchMedia(DARK_QUERY)
  const handler = (e: MediaQueryListEvent): void => {
    const next = e.matches ? 'dark' : 'light'
    applyTheme(next)
    onChange(next)
  }
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
