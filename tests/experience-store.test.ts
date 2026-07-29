import { describe, expect, it } from 'vitest'
import {
  ExperienceStore,
  type ExperiencePersistence
} from '../src/main/domains/memory/experience-store'
import type { ExperienceEntry } from '../src/shared/types'

describe('ExperienceStore', () => {
  it('创建、过滤、更新和删除经验条目', () => {
    let entries: ExperienceEntry[] = []
    const persistence: ExperiencePersistence = {
      getEntries: () => structuredClone(entries),
      setEntries: (next) => {
        entries = structuredClone(next)
      }
    }
    const store = new ExperienceStore(persistence)
    const created = store.create({
      title: 'SQLite 索引经验',
      contentMd: '使用 **FTS5 trigram** 支持中文。',
      sourceSessionId: 'claude:1',
      toolId: 'claude',
      tags: ['搜索', 'SQLite']
    })

    expect(store.list('trigram')).toHaveLength(1)
    expect(store.list('不存在')).toEqual([])
    expect(store.update(created.id, { title: '本地搜索经验' })?.title)
      .toBe('本地搜索经验')
    store.remove(created.id)
    expect(store.list()).toEqual([])
  })
})
