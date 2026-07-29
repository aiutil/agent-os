import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AnnotationsStore } from '../src/main/domains/annotations/store'
import {
  annotationTargetKey,
  parseTargetKey,
  type AnnotationTargetRef
} from '@shared/types'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
})

function newStore(): AnnotationsStore {
  const dir = mkdtempSync(join(tmpdir(), 'anno-'))
  tempDirs.push(dir)
  return new AnnotationsStore(join(dir, 'annotations.sqlite'))
}

const managedConv: AnnotationTargetRef = {
  kind: 'conversation',
  source: 'managed',
  convId: 'c-uuid-1'
}
const cliConv: AnnotationTargetRef = {
  kind: 'conversation',
  source: 'cli',
  toolId: 'claude',
  nativeSessionId: 'sess-abc'
}
const managedMsg: AnnotationTargetRef = {
  kind: 'message',
  source: 'managed',
  sessionId: 's-1',
  messageId: 'm-uuid-9'
}
const cliMsg: AnnotationTargetRef = {
  kind: 'message',
  source: 'cli',
  toolId: 'codex',
  nativeSessionId: 'sess-xyz',
  seq: 42
}

describe('annotationTargetKey / parseTargetKey', () => {
  it('encode/decode round-trips for all four ref shapes', () => {
    for (const ref of [managedConv, cliConv, managedMsg, cliMsg]) {
      const key = annotationTargetKey(ref)
      const back = parseTargetKey(key, ref.kind, ref.source)
      expect(back).toEqual(ref)
    }
  })

  it('returns null for malformed keys', () => {
    expect(parseTargetKey('garbage', 'conversation', 'managed')).toBeNull()
    expect(parseTargetKey('conv:managed:', 'conversation', 'managed')).toBeNull()
    expect(parseTargetKey('msg:cli:tool:1', 'message', 'cli')).toBeNull()
  })
})

describe('AnnotationsStore', () => {
  it('default annotation is unfavorite/no tags; getMany fills missing', () => {
    const store = newStore()
    try {
      expect(store.get(managedConv)).toEqual({ favorite: false, tags: [] })
      const many = store.getMany([managedConv, cliMsg])
      expect(many).toHaveLength(2)
      expect(many[0]).toMatchObject({ favorite: false, tags: [] })
      expect(many[0].ref).toEqual(managedConv)
      store.close()
    } finally {
      /* cleanup in afterEach */
    }
  })

  it('setFavorite + setTags persist across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anno-reopen-'))
    tempDirs.push(dir)
    const path = join(dir, 'annotations.sqlite')
    const store = new AnnotationsStore(path)
    store.setFavorite(cliConv, true)
    store.setTags(managedMsg, ['重要', '部署'])
    store.close()

    const reopened = new AnnotationsStore(path)
    try {
      expect(reopened.get(cliConv)).toEqual({ favorite: true, tags: [] })
      expect(reopened.get(managedMsg).tags.sort()).toEqual(['部署', '重要'])
      reopened.close()
    } finally {
      /* cleanup */
    }
  })

  it('prunes sparse rows when favorite off and no tags remain', () => {
    const store = newStore()
    try {
      store.setFavorite(managedConv, true)
      store.addTag(managedConv, 'x')
      store.removeTag(managedConv, 'x')
      store.setFavorite(managedConv, false)
      expect(store.get(managedConv)).toEqual({ favorite: false, tags: [] })
      // listTags should be empty (row pruned)
      expect(store.listTags()).toEqual([])
      store.close()
    } finally {
      /* cleanup */
    }
  })

  it('normalizes tags (trim, dedupe case-insensitive, keep first case)', () => {
    const store = newStore()
    try {
      store.setTags(managedMsg, [' 重要 ', '部署', '重要', 'IMPORTANT', 'important'])
      // normalizeTags keeps the first-seen case (IMPORTANT before 'important'); SQL returns sorted.
      const tags = store.get(managedMsg).tags
      expect(tags.some((t) => t.toLowerCase() === 'important')).toBe(true)
      expect(tags.some((t) => t.toLowerCase() === 'important' && t !== 'important')).toBe(true)
      expect(tags.filter((t) => t.toLowerCase() === 'important')).toHaveLength(1)
      expect(tags).toHaveLength(3)
    } finally {
      /* cleanup */
    }
  })

  it('listTags aggregates counts across targets', () => {
    const store = newStore()
    try {
      store.setTags(managedConv, ['A', 'B'])
      store.setTags(cliConv, ['A'])
      store.setTags(managedMsg, ['B', 'C'])
      const counts = Object.fromEntries(store.listTags().map((t) => [t.tag, t.count]))
      expect(counts).toEqual({ A: 2, B: 2, C: 1 })
      store.close()
    } finally {
      /* cleanup */
    }
  })

  it('listAnnotated filters by favorite/kind/tag and carries display snapshot', () => {
    const store = newStore()
    try {
      store.setFavorite(managedConv, true, { label: '重构搜索', toolId: 'claude' })
      store.setFavorite(cliMsg, true, { label: '一条命中的消息', toolId: 'codex' })
      store.addTag(cliMsg, 'bug')
      store.setTags(cliConv, ['idea'], { label: '只打标签的会话', toolId: 'claude' })

      // 无过滤：返回全部已标注（收藏或有标签）条目。
      const all = store.listAnnotated()
      expect(all.map((e) => annotationTargetKey(e.ref)).sort()).toEqual(
        [
          annotationTargetKey(managedConv),
          annotationTargetKey(cliMsg),
          annotationTargetKey(cliConv)
        ].sort()
      )
      const managedRow = all.find((e) => annotationTargetKey(e.ref) === annotationTargetKey(managedConv))!
      expect(managedRow.label).toBe('重构搜索')
      expect(managedRow.toolId).toBe('claude')

      // favorite=true 只看收藏（cliConv 仅打标签，被排除）。
      const favs = store.listAnnotated({ favorite: true })
      expect(favs.map((e) => annotationTargetKey(e.ref)).sort()).toEqual(
        [annotationTargetKey(managedConv), annotationTargetKey(cliMsg)].sort()
      )

      // kind=message 只看消息。
      const messages = store.listAnnotated({ kind: 'message' })
      expect(messages).toHaveLength(1)
      expect(messages[0]!.ref).toEqual(cliMsg)
      expect(messages[0]!.tags).toEqual(['bug'])

      // tag 过滤（大小写不敏感）。
      const tagged = store.listAnnotated({ tag: 'IDEA' })
      expect(tagged).toHaveLength(1)
      expect(tagged[0]!.ref).toEqual(cliConv)
      store.close()
    } finally {
      /* cleanup */
    }
  })

  it('meta label/toolId survive reopen and update on rewrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anno-meta-'))
    tempDirs.push(dir)
    const path = join(dir, 'annotations.sqlite')
    const store = new AnnotationsStore(path)
    store.setFavorite(cliConv, true, { label: '初始标题', toolId: 'claude' })
    // 不带 meta 的写入不应清空既有快照。
    store.setTags(cliConv, ['x'])
    store.close()

    const reopened = new AnnotationsStore(path)
    try {
      const row = reopened.listAnnotated().find((e) => annotationTargetKey(e.ref) === annotationTargetKey(cliConv))!
      expect(row.label).toBe('初始标题')
      expect(row.toolId).toBe('claude')
      reopened.close()
    } finally {
      /* cleanup */
    }
  })
})
