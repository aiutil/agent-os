// 国际化核心类型（SPEC-036）。零依赖纯类型模块，主进程/渲染端/测试共用。

/** 支持的语言。 */
export type Lang = 'zh' | 'en'

/** 用户语言偏好（镜像 ThemePreference：跟随系统/中文/英文）。 */
export type LanguagePreference = 'system' | 'zh' | 'en'

/** 复数形式（英文需要；中文 one/other 取相同串以保持字典同形）。 */
export interface PluralForm {
  one: string
  other: string
}

/** 字典叶子：普通字符串 或 复数对象。 */
export type Leaf = string | PluralForm

/** 插值变量。count 为 number 时触发复数选择。 */
export type Vars = Record<string, string | number>

/**
 * 由嵌套字典类型推断所有合法点分键路径（纯编译期，零运行时成本）。
 * 用法：`key: KeyPath<Dictionary>` —— 缺键/拼错即编译报错，并支持自动补全。
 */
export type KeyPath<D, P extends string = ''> = D extends string
  ? P
  : D extends PluralForm
    ? P
    : { [K in keyof D & string]: KeyPath<D[K], P extends '' ? K : `${P}.${K}`> }[keyof D & string]
