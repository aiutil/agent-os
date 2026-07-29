// 非 React 调用点（主进程 tr / 终端裸字节写入）用的运行时语言状态（SPEC-036）。
// 默认 'zh' —— 这是让 41 个断言中文的测试在未配置语言时原样通过的根因。

import type { Dictionary } from './dictionaries'
import type { KeyPath, Lang, Vars } from './types'
import { t } from './t'

let currentLang: Lang = 'zh'

export function getCurrentLang(): Lang {
  return currentLang
}

export function setCurrentLang(lang: Lang): void {
  currentLang = lang
}

/** 用当前运行时语言翻译（主进程 / 终端等非 React 点）。 */
export function tr(key: KeyPath<Dictionary>, vars?: Vars): string {
  return t(currentLang, key, vars)
}
