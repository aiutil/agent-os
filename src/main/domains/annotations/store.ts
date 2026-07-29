// 标注层存储（SPEC-025）。收藏 + 标签，覆盖会话/消息 × 自建/CLI。
// 旁路元数据：仅主进程读写，经 annotations: IPC 直达，不进入聊天 runtime/daemon。

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type {
  Annotation,
  AnnotationBrowseEntry,
  AnnotationDisplayMeta,
  AnnotationEntry,
  AnnotationListFilter,
  AnnotationTagCount,
  AnnotationTargetRef
} from '@shared/types'
import { annotationTargetKey, parseTargetKey } from '@shared/types'

function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true })
  try {
    return new Database(path)
  } catch {
    if (existsSync(path)) renameSync(path, `${path}.corrupt-${Date.now()}`)
    return new Database(path)
  }
}

// 标签规范化：去空白、去重（大小写不敏感），保留首次出现的原始大小写。对齐 experience-store 口径。
function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

export class AnnotationsStore {
  private readonly database: Database.Database

  constructor(path: string) {
    this.database = openDatabase(path)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('foreign_keys = ON')
    this.migrate()
  }

  close(): void {
    this.database.close()
  }

  get(ref: AnnotationTargetRef): Annotation {
    const key = annotationTargetKey(ref)
    const row = this.database
      .prepare('SELECT favorite FROM annotations WHERE targetKey = ?')
      .get(key) as { favorite: number } | undefined
    if (!row) return { favorite: false, tags: [] }
    const tags = (
      this.database
        .prepare('SELECT tag FROM annotation_tags WHERE targetKey = ? ORDER BY tag')
        .all(key) as Array<{ tag: string }>
    ).map((r) => r.tag)
    return { favorite: Boolean(row.favorite), tags }
  }

  /** 批量取标注（列表渲染必用）：每个 ref 都返回一条（缺失者为未收藏/无标签）。 */
  getMany(refs: AnnotationTargetRef[]): AnnotationEntry[] {
    if (refs.length === 0) return []
    const keys = refs.map(annotationTargetKey)
    const ph = keys.map(() => '?').join(',')
    const favByKey = new Map(
      (
        this.database
          .prepare(`SELECT targetKey, favorite FROM annotations WHERE targetKey IN (${ph})`)
          .all(...keys) as Array<{ targetKey: string; favorite: number }>
      ).map((r) => [r.targetKey, Boolean(r.favorite)])
    )
    const tagsByKey = new Map<string, string[]>()
    for (const r of this.database
      .prepare(`SELECT targetKey, tag FROM annotation_tags WHERE targetKey IN (${ph}) ORDER BY tag`)
      .all(...keys) as Array<{ targetKey: string; tag: string }>) {
      const arr = tagsByKey.get(r.targetKey) ?? []
      arr.push(r.tag)
      tagsByKey.set(r.targetKey, arr)
    }
    return refs.map((ref, i) => ({
      ref,
      favorite: favByKey.get(keys[i]) ?? false,
      tags: tagsByKey.get(keys[i]) ?? []
    }))
  }

  setFavorite(ref: AnnotationTargetRef, favorite: boolean, meta?: AnnotationDisplayMeta): Annotation {
    const key = this.ensureRow(ref, meta)
    this.database
      .prepare('UPDATE annotations SET favorite = ?, updatedAt = ? WHERE targetKey = ?')
      .run(favorite ? 1 : 0, new Date().toISOString(), key)
    this.pruneIfEmpty(key)
    return this.get(ref)
  }

  setTags(ref: AnnotationTargetRef, tags: string[], meta?: AnnotationDisplayMeta): Annotation {
    const key = this.ensureRow(ref, meta)
    const normalized = normalizeTags(tags)
    const apply = this.database.transaction(() => {
      this.database.prepare('DELETE FROM annotation_tags WHERE targetKey = ?').run(key)
      const insert = this.database.prepare('INSERT INTO annotation_tags(targetKey, tag) VALUES (?, ?)')
      for (const tag of normalized) insert.run(key, tag)
      this.database
        .prepare('UPDATE annotations SET updatedAt = ? WHERE targetKey = ?')
        .run(new Date().toISOString(), key)
    })
    apply()
    this.pruneIfEmpty(key)
    return this.get(ref)
  }

  addTag(ref: AnnotationTargetRef, tag: string, meta?: AnnotationDisplayMeta): Annotation {
    return this.setTags(ref, [...this.get(ref).tags, tag], meta)
  }

  removeTag(ref: AnnotationTargetRef, tag: string, meta?: AnnotationDisplayMeta): Annotation {
    const lower = tag.trim().toLowerCase()
    return this.setTags(
      ref,
      this.get(ref).tags.filter((t) => t.toLowerCase() !== lower),
      meta
    )
  }

  /** 全部标签及其出现次数（标签筛选 / 自动补全）。 */
  listTags(): AnnotationTagCount[] {
    return this.database
      .prepare(
        `SELECT tag, COUNT(*) AS count FROM annotation_tags
         GROUP BY tag ORDER BY count DESC, tag ASC`
      )
      .all() as AnnotationTagCount[]
  }

  /**
   * 浏览已标注条目（收藏页数据源）。每行天然非空（收藏或有标签）。
   * filter.favorite=true 只看收藏；filter.kind 限会话/消息；filter.tag 限含某标签。
   * 返回带展示快照（label/toolId），按 updatedAt 倒序。
   */
  listAnnotated(filter: AnnotationListFilter = {}): AnnotationBrowseEntry[] {
    const conds: string[] = []
    const params: unknown[] = []
    if (filter.favorite) conds.push('a.favorite = 1')
    if (filter.kind) {
      conds.push('a.targetKind = ?')
      params.push(filter.kind)
    }
    if (filter.tag) {
      conds.push('EXISTS (SELECT 1 FROM annotation_tags t WHERE t.targetKey = a.targetKey AND LOWER(t.tag) = LOWER(?))')
      params.push(filter.tag)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = this.database
      .prepare(
        `SELECT targetKey, targetKind, source, favorite, label, toolId, updatedAt
         FROM annotations a ${where}
         ORDER BY updatedAt DESC`
      )
      .all(...params) as Array<{
      targetKey: string
      targetKind: 'conversation' | 'message'
      source: 'managed' | 'cli'
      favorite: number
      label: string
      toolId: string
      updatedAt: string
    }>
    if (rows.length === 0) return []
    const keys = rows.map((r) => r.targetKey)
    const ph = keys.map(() => '?').join(',')
    const tagsByKey = new Map<string, string[]>()
    for (const r of this.database
      .prepare(`SELECT targetKey, tag FROM annotation_tags WHERE targetKey IN (${ph}) ORDER BY tag`)
      .all(...keys) as Array<{ targetKey: string; tag: string }>) {
      const arr = tagsByKey.get(r.targetKey) ?? []
      arr.push(r.tag)
      tagsByKey.set(r.targetKey, arr)
    }
    return rows.flatMap((row) => {
      const ref = parseTargetKey(row.targetKey, row.targetKind, row.source)
      return ref
        ? [{
            ref,
            favorite: Boolean(row.favorite),
            tags: tagsByKey.get(row.targetKey) ?? [],
            label: row.label,
            toolId: row.toolId,
            updatedAt: row.updatedAt
          }]
        : []
    })
  }

  // 确保 annotations 主行存在（标签/收藏写入前），返回 targetKey。
  // meta 提供时刷新展示快照（label/toolId）；未提供则保留既有值。
  private ensureRow(ref: AnnotationTargetRef, meta?: AnnotationDisplayMeta): string {
    const key = annotationTargetKey(ref)
    this.database
      .prepare(
        `INSERT INTO annotations(targetKey, targetKind, source, favorite, label, toolId, updatedAt)
         VALUES (@key, @kind, @source, 0, @label, @toolId, @now)
         ON CONFLICT(targetKey) DO UPDATE SET
           updatedAt = excluded.updatedAt,
           label = CASE WHEN @hasLabel THEN excluded.label ELSE annotations.label END,
           toolId = CASE WHEN @hasToolId THEN excluded.toolId ELSE annotations.toolId END`
      )
      .run({
        key,
        kind: ref.kind,
        source: ref.source,
        label: meta?.label ?? '',
        toolId: meta?.toolId ?? '',
        hasLabel: meta?.label !== undefined ? 1 : 0,
        hasToolId: meta?.toolId !== undefined ? 1 : 0,
        now: new Date().toISOString()
      })
    return key
  }

  // 收藏关闭且无标签时删除主行，保持表稀疏（annotation_tags 随 FK 级联清理）。
  private pruneIfEmpty(key: string): void {
    const row = this.database
      .prepare('SELECT favorite FROM annotations WHERE targetKey = ?')
      .get(key) as { favorite: number } | undefined
    if (!row || row.favorite) return
    const { count } = this.database
      .prepare('SELECT COUNT(*) AS count FROM annotation_tags WHERE targetKey = ?')
      .get(key) as { count: number }
    if (count === 0) this.database.prepare('DELETE FROM annotations WHERE targetKey = ?').run(key)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS annotations (
        targetKey TEXT PRIMARY KEY,
        targetKind TEXT NOT NULL CHECK(targetKind IN ('conversation', 'message')),
        source TEXT NOT NULL CHECK(source IN ('managed', 'cli')),
        favorite INTEGER NOT NULL DEFAULT 0,
        label TEXT NOT NULL DEFAULT '',
        toolId TEXT NOT NULL DEFAULT '',
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS annotation_tags (
        targetKey TEXT NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (targetKey, tag),
        FOREIGN KEY (targetKey) REFERENCES annotations(targetKey) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_annotations_kind_fav ON annotations(targetKind, favorite);
      CREATE INDEX IF NOT EXISTS idx_annotation_tags_tag ON annotation_tags(tag);
    `)

    // v1 旧库补列（展示快照）。列已存在则忽略。
    const columns = (
      this.database.prepare('PRAGMA table_info(annotations)').all() as Array<{ name: string }>
    ).map((c) => c.name)
    if (!columns.includes('label')) {
      this.database.exec(`ALTER TABLE annotations ADD COLUMN label TEXT NOT NULL DEFAULT ''`)
    }
    if (!columns.includes('toolId')) {
      this.database.exec(`ALTER TABLE annotations ADD COLUMN toolId TEXT NOT NULL DEFAULT ''`)
    }
    this.database.pragma('user_version = 1')
  }
}
