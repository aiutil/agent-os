// 纯函数翻译器（SPEC-036）。{{var}} 插值 + count 复数。无副作用，测试友好。

import type { Dictionary } from './dictionaries'
import type { KeyPath, Lang, Leaf, Vars } from './types'
import { DICTS } from './dictionaries'

/** 沿点分键取叶子；缺失时返回键本身（可见、不崩溃）。 */
function resolveLeaf(dict: Dictionary, key: string): Leaf {
  const parts = key.split('.')
  let cur: unknown = dict
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return key
    }
  }
  return (cur as Leaf) ?? key
}

/** 复数对象按 vars.count 选 one/other；普通串原样返回。 */
function pickPlural(leaf: Leaf, vars?: Vars): string {
  if (typeof leaf === 'string') return leaf
  const count = typeof vars?.count === 'number' ? vars.count : 1
  return count === 1 ? leaf.one : leaf.other
}

/** {{var}} 插值；未提供的占位符保留原样以便发现遗漏。 */
function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    k in vars ? String(vars[k]) : `{{${k}}}`
  )
}

/**
 * 翻译。纯函数：相同入参恒定输出。
 * @example t('zh', 'common.action.cancel') // '取消'
 * @example t('en', 'chat.sessionCount', { count: 2 }) // '2 sessions'
 */
export function t(lang: Lang, key: KeyPath<Dictionary>, vars?: Vars): string {
  const leaf = resolveLeaf(DICTS[lang], key)
  return interpolate(pickPlural(leaf, vars), vars)
}
