// 标注层渲染端缓存（SPEC-025）。会话/消息级的「收藏 + 标签」。
// 列表渲染批量预取；写入走乐观更新，失败时回滚并重拉单条。

import { create } from 'zustand'
import type {
  Annotation,
  AnnotationBrowseEntry,
  AnnotationDisplayMeta,
  AnnotationListFilter,
  AnnotationTargetRef,
  AnnotationTagCount
} from '@shared/types'
import { annotationTargetKey } from '@shared/types'

interface AnnotationsState {
  /** 以 targetKey 为键的标注缓存（乐观更新可被主进程返回值覆盖）。 */
  entries: Map<string, Annotation>
  /** 全局标签计数缓存（标签筛选 / 自动补全）。 */
  tagCounts: AnnotationTagCount[]
  /** 批量预取：列表渲染前调用，缺失的 ref 才会请求主进程。 */
  loadMany: (refs: AnnotationTargetRef[]) => Promise<void>
  /** 单条取（打开编辑器、切换收藏）。 */
  load: (ref: AnnotationTargetRef) => Promise<Annotation>
  /** 切换收藏（乐观更新）。meta 提供展示快照供收藏页渲染。 */
  toggleFavorite: (ref: AnnotationTargetRef, next: boolean, meta?: AnnotationDisplayMeta) => Promise<void>
  /** 设置整组标签（乐观更新）。 */
  setTags: (ref: AnnotationTargetRef, tags: string[], meta?: AnnotationDisplayMeta) => Promise<void>
  /** 读取当前缓存值（未缓存返回默认）。 */
  get: (ref: AnnotationTargetRef) => Annotation
  /** 刷新全局标签计数（新建/删除标签后）。 */
  refreshTags: () => Promise<void>
  /** 浏览已标注条目（收藏页，不走缓存，直查主进程）。 */
  listAnnotated: (filter?: AnnotationListFilter) => Promise<AnnotationBrowseEntry[]>
}

const DEFAULT: Annotation = { favorite: false, tags: [] }

export const useAnnotationsStore = create<AnnotationsState>((set, get) => ({
  entries: new Map(),
  tagCounts: [],

  async loadMany(refs) {
    if (refs.length === 0) return
    const existing = get().entries
    const missing = refs.filter((ref) => !existing.has(annotationTargetKey(ref)))
    if (missing.length === 0) return
    const fetched = await window.agentOs.annotations.getMany(missing)
    set((state) => {
      const next = new Map(state.entries)
      for (const entry of fetched) {
        next.set(annotationTargetKey(entry.ref), {
          favorite: entry.favorite,
          tags: entry.tags
        })
      }
      return { entries: next }
    })
  },

  async load(ref) {
    const [entry] = await window.agentOs.annotations.getMany([ref])
    const value: Annotation = entry
      ? { favorite: entry.favorite, tags: entry.tags }
      : { ...DEFAULT }
    set((state) => {
      const next = new Map(state.entries)
      next.set(annotationTargetKey(ref), value)
      return { entries: next }
    })
    return value
  },

  async toggleFavorite(ref, next, meta) {
    const key = annotationTargetKey(ref)
    const prev = get().entries.get(key) ?? DEFAULT
    set((state) => {
      const map = new Map(state.entries)
      map.set(key, { favorite: next, tags: prev.tags })
      return { entries: map }
    })
    try {
      const result = await window.agentOs.annotations.setFavorite({ ref, favorite: next, meta })
      set((state) => {
        const map = new Map(state.entries)
        map.set(key, result)
        return { entries: map }
      })
    } catch {
      // 回滚：重拉以拿到主进程真值。
      await get().load(ref)
    }
  },

  async setTags(ref, tags, meta) {
    const key = annotationTargetKey(ref)
    const prev = get().entries.get(key) ?? DEFAULT
    set((state) => {
      const map = new Map(state.entries)
      map.set(key, { favorite: prev.favorite, tags })
      return { entries: map }
    })
    try {
      const result = await window.agentOs.annotations.setTags({ ref, tags, meta })
      set((state) => {
        const map = new Map(state.entries)
        map.set(key, result)
        return { entries: map }
      })
    } catch {
      await get().load(ref)
    }
    await get().refreshTags()
  },

  get(ref) {
    return get().entries.get(annotationTargetKey(ref)) ?? DEFAULT
  },

  async refreshTags() {
    const tagCounts = await window.agentOs.annotations.listTags()
    set({ tagCounts })
  },

  listAnnotated(filter) {
    return window.agentOs.annotations.listAnnotated(filter)
  }
}))
