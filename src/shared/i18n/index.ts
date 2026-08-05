// 国际化统一出口（SPEC-036）。
// verbatimModuleSyntax 下严格区分 type / value 导出。

export type { Dictionary } from './dictionaries'
export type { KeyPath, Lang, LanguagePreference, Leaf, PluralForm, Vars } from './types'
export { DICTS } from './dictionaries'
export { t } from './t'
export { getCurrentLang, setCurrentLang, tr } from './runtime'
export { detectSystemLang, langFromLocale, localeFor, resolveLang } from './locale'
