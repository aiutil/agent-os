// 渲染端 i18n hook（SPEC-036）。基于 uiStore.languagePreference 解析生效语言，
// 语言切换经 zustand 自动重渲染。零依赖，复用 @shared/i18n 的纯 t()。

import {
  t as translate,
  resolveLang,
  type Dictionary,
  type KeyPath,
  type Lang,
  type Vars
} from '@shared/i18n'
import { useUiStore } from '../stores/uiStore'
import { useCallback } from 'react'

type TFunction = (key: KeyPath<Dictionary>, vars?: Vars) => string

/**
 * 翻译 hook。返回当前生效语言与绑定该语言的 t()。
 * @example const { t, lang } = useT(); t('common.action.cancel')
 */
export function useT(): { lang: Lang; t: TFunction } {
  const pref = useUiStore((s) => s.languagePreference)
  const systemLanguage = useUiStore((s) => s.platform?.systemLanguage)
  const lang = resolveLang(pref, systemLanguage)
  const t = useCallback<TFunction>((key, vars) => translate(lang, key, vars), [lang])
  return { lang, t }
}

/** 非 React 调用点（如 terminalRegistry 裸字节写入）取当前生效语言。 */
export function getCurrentRendererLang(): Lang {
  const state = useUiStore.getState()
  return resolveLang(state.languagePreference, state.platform?.systemLanguage)
}
