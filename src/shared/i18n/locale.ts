// 语言↔区域映射 + 系统语言探测（SPEC-036）。纯函数，便于单测。

import type { Lang, LanguagePreference } from './types'

/** 由语言派生 BCP-47 区域标签，供 Intl/toLocaleString 使用（替换硬编码 'zh-CN'）。 */
export function localeFor(lang: Lang): 'zh-CN' | 'en-US' {
  return lang === 'zh' ? 'zh-CN' : 'en-US'
}

/**
 * 探测系统语言：zh 语系→zh，其余→en。无 navigator（主进程/测试）退回 zh。
 * 仅在渲染端用于解析 'system' 偏好；主进程直接读 app-store 持久化的 lang。
 */
export function detectSystemLang(): Lang {
  if (typeof navigator === 'undefined' || !navigator.language) return 'zh'
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** 由偏好解析出实际生效语言。 */
export function resolveLang(
  pref: LanguagePreference,
  systemLang: Lang = detectSystemLang()
): Lang {
  return pref === 'system' ? systemLang : pref
}
