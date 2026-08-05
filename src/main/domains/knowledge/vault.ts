import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import chokidar, { type FSWatcher } from 'chokidar'
import type {
  GraphSnapshot,
  KnowledgeArticle,
  KnowledgeArticleInput,
  KnowledgeArticleStatus,
  KnowledgeComment,
  KnowledgeCommentInput,
  KnowledgeGraphInput,
  KnowledgeListInput,
  KnowledgeSource,
  KnowledgeTopic
} from '@shared/types'
import type { PortableKnowledgeState } from '@shared/types'

interface ArticleRow {
  id: string
  title: string
  summary: string
  status: KnowledgeArticleStatus
  topic: string
  tags: string
  sources: string
  path: string
  createdAt: string
  updatedAt: string
  publishedAt: string | null
  body: string
  wordCount: number
  favorite: number
  favoriteAt: string | null
}

interface CommentRow {
  id: string
  articleId: string
  body: string
  anchor: string | null
  createdAt: string
  updatedAt: string
}

type Frontmatter = Omit<KnowledgeArticle, 'body' | 'path' | 'favorite' | 'favoriteAt' | 'wordCount'>

function cleanStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
}

function safePath(root: string, candidate: string): boolean {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  return absoluteCandidate === absoluteRoot || absoluteCandidate.startsWith(`${absoluteRoot}${sep}`)
}

function slug(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return normalized.slice(0, 80) || 'untitled'
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!raw.startsWith('---\n')) return null
  const end = raw.indexOf('\n---', 4)
  if (end < 0) return null
  const lines = raw.slice(4, end).split('\n')
  const frontmatter: Record<string, unknown> = {}
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/u.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    const value = rawValue.trim()
    frontmatter[key] = value ? parseJson(value, value.replace(/^"|"$/g, '')) : ''
  }
  return { frontmatter, body: raw.slice(end + 4).replace(/^\n/, '') }
}

function serializeFrontmatter(value: Frontmatter): string {
  const entries: Array<[string, unknown]> = [
    ['id', value.id],
    ['title', value.title],
    ['summary', value.summary],
    ['status', value.status],
    ['topic', value.topic],
    ['tags', value.tags],
    ['createdAt', value.createdAt],
    ['updatedAt', value.updatedAt],
    ['publishedAt', value.publishedAt ?? null],
    ['sources', value.sources]
  ]
  return ['---', ...entries.map(([key, item]) => `${key}: ${JSON.stringify(item)}`), '---', ''].join('\n')
}

function wordCount(body: string): number {
  return Math.max(0, Array.from(body.trim()).length)
}

export class KnowledgeVault {
  private readonly database: Database.Database
  private watcher: FSWatcher | null = null
  private internalWrites = new Set<string>()

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.database = new Database(join(root, 'knowledge.sqlite'))
    this.database.pragma('journal_mode = WAL')
    this.initialize()
    this.reindexAll()
    this.watcher = chokidar.watch(join(root, '**/*.md'), { ignoreInitial: true })
    this.watcher.on('add', (path) => this.reindexExternal(path)).on('change', (path) => this.reindexExternal(path)).on('unlink', (path) => this.removeMissing(path))
  }

  close(): void {
    void this.watcher?.close()
    this.database.close()
  }

  list(input: KnowledgeListInput = {}): KnowledgeArticle[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (input.statuses?.length) {
      clauses.push(`status IN (${input.statuses.map(() => '?').join(',')})`)
      params.push(...input.statuses)
    }
    if (input.topic?.trim()) {
      clauses.push('topic = ?')
      params.push(input.topic.trim())
    }
    if (input.favoriteOnly) clauses.push('favorite = 1')
    if (input.tags?.length) {
      clauses.push(`(${input.tags.map(() => 'tags LIKE ?').join(' OR ')})`)
      params.push(...input.tags.map((tag) => `"${tag.replaceAll('"', '""')}"`))
    }
    if (input.query?.trim()) {
      const term = `%${input.query.trim()}%`
      clauses.push('(title LIKE ? OR summary LIKE ? OR body LIKE ? OR tags LIKE ? OR topic LIKE ?)')
      params.push(term, term, term, term, term)
    }
    const limit = Math.max(1, Math.min(input.limit ?? 200, 1501))
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.database
      .prepare(`SELECT * FROM knowledge_articles ${where} ORDER BY favorite DESC, updatedAt DESC LIMIT ?`)
      .all(...params, limit) as ArticleRow[]
    return rows.map((row) => this.hydrate(row))
  }

  get(id: string): KnowledgeArticle | null {
    const row = this.database.prepare('SELECT * FROM knowledge_articles WHERE id = ?').get(id) as ArticleRow | undefined
    return row ? this.hydrate(row) : null
  }

  saveDraft(input: KnowledgeArticleInput): KnowledgeArticle {
    const existing = input.id ? this.get(input.id) : null
    const now = new Date().toISOString()
    const id = existing?.id ?? randomUUID()
    const title = input.title.trim()
    const body = input.body.trim()
    const topic = normalizeTopic(input.topic)
    if (!title || !body || !topic) throw new Error('知识草稿需要标题、正文和主题')
    const next: KnowledgeArticle = {
      id,
      title,
      summary: input.summary?.trim() || existing?.summary || body.slice(0, 160),
      body,
      status: existing?.status === 'published' ? 'published' : 'draft',
      topic,
      tags: cleanStrings(input.tags ?? existing?.tags),
      sources: input.sources ?? existing?.sources ?? [],
      path: existing?.path ?? this.pathFor(topic, title, id),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.publishedAt ? { publishedAt: existing.publishedAt } : {}),
      favorite: existing?.favorite ?? false,
      ...(existing?.favoriteAt ? { favoriteAt: existing.favoriteAt } : {}),
      wordCount: wordCount(body)
    }
    this.writeArticle(next)
    return next
  }

  publish(id: string): KnowledgeArticle | null {
    const article = this.get(id)
    if (!article) return null
    if (!article.title || !article.body || !article.topic || article.sources.length === 0) {
      throw new Error('发布知识前需要标题、正文、主题和至少一个来源')
    }
    const next = { ...article, status: 'published' as const, updatedAt: new Date().toISOString(), publishedAt: article.publishedAt ?? new Date().toISOString() }
    this.writeArticle(next)
    return next
  }

  archive(id: string): KnowledgeArticle | null { return this.setStatus(id, 'archived') }
  restore(id: string): KnowledgeArticle | null { return this.setStatus(id, 'draft') }

  remove(id: string): void {
    const article = this.get(id)
    if (!article) return
    if (safePath(this.root, article.path)) rmSync(article.path, { force: true })
    this.database.transaction(() => {
      this.database.prepare('DELETE FROM knowledge_comments WHERE articleId = ?').run(id)
      this.database.prepare('DELETE FROM knowledge_articles WHERE id = ?').run(id)
      this.database.prepare('DELETE FROM knowledge_fts WHERE articleId = ?').run(id)
    })()
  }

  topics(): KnowledgeTopic[] {
    const rows = this.database.prepare('SELECT topic, COUNT(*) AS articleCount FROM knowledge_articles GROUP BY topic ORDER BY topic').all() as Array<{ topic: string; articleCount: number }>
    return rows.map((row) => ({ path: row.topic, label: row.topic.split('/').pop() ?? row.topic, articleCount: row.articleCount }))
  }

  setFavorite(id: string, favorite: boolean): KnowledgeArticle | null {
    const article = this.get(id)
    if (!article) return null
    this.database.prepare('UPDATE knowledge_articles SET favorite = ?, favoriteAt = ? WHERE id = ?').run(favorite ? 1 : 0, favorite ? new Date().toISOString() : null, id)
    return this.get(id)
  }

  comments(articleId: string): KnowledgeComment[] {
    return (this.database.prepare('SELECT * FROM knowledge_comments WHERE articleId = ? ORDER BY createdAt ASC').all(articleId) as CommentRow[]).map((row) => this.hydrateComment(row))
  }

  addComment(articleId: string, input: KnowledgeCommentInput): KnowledgeComment {
    if (!this.get(articleId)) throw new Error('知识文章不存在')
    const body = input.body.trim()
    if (!body) throw new Error('评论不能为空')
    const now = new Date().toISOString()
    const comment: KnowledgeComment = { id: randomUUID(), articleId, body, ...(input.anchor ? { anchor: input.anchor } : {}), createdAt: now, updatedAt: now }
    this.database.prepare('INSERT INTO knowledge_comments (id, articleId, body, anchor, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(comment.id, articleId, body, input.anchor ? JSON.stringify(input.anchor) : null, now, now)
    return comment
  }

  updateComment(id: string, input: KnowledgeCommentInput): KnowledgeComment | null {
    const current = this.database.prepare('SELECT * FROM knowledge_comments WHERE id = ?').get(id) as CommentRow | undefined
    if (!current || !input.body.trim()) return null
    this.database.prepare('UPDATE knowledge_comments SET body = ?, anchor = ?, updatedAt = ? WHERE id = ?').run(input.body.trim(), input.anchor ? JSON.stringify(input.anchor) : null, new Date().toISOString(), id)
    const row = this.database.prepare('SELECT * FROM knowledge_comments WHERE id = ?').get(id) as CommentRow
    return this.hydrateComment(row)
  }

  removeComment(id: string): void { this.database.prepare('DELETE FROM knowledge_comments WHERE id = ?').run(id) }

  graph(input: KnowledgeGraphInput = {}): GraphSnapshot {
    const cap = Math.max(1, Math.min(input.limit ?? 1500, 1500))
    const articles = this.list({ ...input, limit: cap + 1 })
    const truncated = articles.length > cap
    const visible = articles.slice(0, cap)
    const nodes: GraphSnapshot['nodes'] = []
    const edges: GraphSnapshot['edges'] = []
    const seen = new Set<string>()
    const add = (id: string, type: GraphSnapshot['nodes'][number]['type'], label: string, weight: number, group?: string, status?: string): void => {
      if (seen.has(id)) return
      seen.add(id); nodes.push({ id, type, label, weight, ...(group ? { group } : {}), ...(status ? { status } : {}) })
    }
    for (const article of visible) {
      const articleId = `article:${article.id}`
      add(articleId, 'article', article.title, Math.min(8, 1 + article.wordCount / 800 + (article.favorite ? 1 : 0)), article.topic, article.status)
      const topicId = `topic:${article.topic}`
      add(topicId, 'topic', article.topic, 3)
      edges.push({ id: `topic:${article.id}`, source: articleId, target: topicId, relation: 'belongs_to' })
      for (const tag of article.tags) {
        const tagId = `tag:${tag}`
        add(tagId, 'tag', tag, 1)
        edges.push({ id: `tag:${article.id}:${tag}`, source: articleId, target: tagId, relation: 'tagged_with' })
      }
      if (input.includeSources) {
        for (const source of article.sources.slice(0, 100)) {
          const sourceId = `source:${source.sourceType}:${source.sourceId}`
          add(sourceId, 'source-session', source.sourceId, 1, source.toolId ?? source.sourceType)
          edges.push({ id: `source:${article.id}:${sourceId}`, source: articleId, target: sourceId, relation: 'sourced_from' })
        }
      }
    }
    return {
      nodes,
      edges: input.relations?.length ? edges.filter((edge) => input.relations!.includes(edge.relation)) : edges,
      truncated
    }
  }

  obsidianUri(id: string): string | null {
    const article = this.get(id)
    return article ? `obsidian://open?path=${encodeURIComponent(article.path)}` : null
  }

  hasSourceDigest(sourceId: string, excerptDigest: string): boolean {
    const rows = this.database.prepare('SELECT sources FROM knowledge_articles').all() as Array<{ sources: string }>
    return rows.some((row) => parseJson<KnowledgeSource[]>(row.sources, []).some((source) => source.sourceId === sourceId && source.excerptDigest === excerptDigest))
  }

  /** 便携备份保存正文和本机互动状态；导入时重新生成本机安全路径。 */
  portableState(): PortableKnowledgeState {
    const articleRows = this.database.prepare('SELECT * FROM knowledge_articles ORDER BY updatedAt DESC').all() as ArticleRow[]
    const articles = articleRows.map((row) => {
      const { path: _path, ...article } = this.hydrate(row)
      return article
    })
    const rows = this.database.prepare('SELECT * FROM knowledge_comments ORDER BY createdAt ASC').all() as CommentRow[]
    return { articles, comments: rows.map((row) => this.hydrateComment(row)) }
  }

  replacePortableState(input: PortableKnowledgeState): void {
    const knownArticleIds = new Set(input.articles.map((article) => article.id))
    for (const portable of input.articles) {
      const existing = this.get(portable.id)
      const article: KnowledgeArticle = {
        ...portable,
        path: existing?.path ?? this.pathFor(portable.topic, portable.title, portable.id)
      }
      this.writeArticle(article)
      this.database
        .prepare('UPDATE knowledge_articles SET favorite = ?, favoriteAt = ? WHERE id = ?')
        .run(article.favorite ? 1 : 0, article.favoriteAt ?? null, article.id)
    }
    const write = this.database.transaction(() => {
      const insert = this.database.prepare(
        `INSERT INTO knowledge_comments (id, articleId, body, anchor, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET body=excluded.body, anchor=excluded.anchor, updatedAt=excluded.updatedAt`
      )
      for (const comment of input.comments) {
        if (!knownArticleIds.has(comment.articleId) && !this.get(comment.articleId)) continue
        insert.run(comment.id, comment.articleId, comment.body, comment.anchor ? JSON.stringify(comment.anchor) : null, comment.createdAt, comment.updatedAt)
      }
    })
    write()
  }

  private setStatus(id: string, status: KnowledgeArticleStatus): KnowledgeArticle | null {
    const article = this.get(id)
    if (!article) return null
    const next = { ...article, status, updatedAt: new Date().toISOString() }
    this.writeArticle(next)
    return next
  }

  private pathFor(topic: string, title: string, id: string): string {
    const directory = join(this.root, ...topic.split('/'))
    return join(directory, `${slug(title)}-${id.slice(0, 8)}.md`)
  }

  private writeArticle(article: KnowledgeArticle): void {
    const target = article.path
    if (!safePath(this.root, target)) throw new Error('知识路径不在 Agent OS 知识目录中')
    const source = article.sources.map((item) => ({ ...item }))
    const content = `${serializeFrontmatter({ id: article.id, title: article.title, summary: article.summary, status: article.status, topic: article.topic, tags: article.tags, sources: source, createdAt: article.createdAt, updatedAt: article.updatedAt, ...(article.publishedAt ? { publishedAt: article.publishedAt } : {}) })}\n${article.body.trim()}\n`
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    const temporary = `${target}.${randomUUID()}.tmp`
    this.internalWrites.add(target)
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
      const fd = openSync(temporary, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(temporary, target)
      this.upsert(article)
    } finally {
      this.internalWrites.delete(target)
    }
  }

  private reindexAll(): void {
    const files = this.database.prepare('SELECT path FROM knowledge_articles').all() as Array<{ path: string }>
    for (const file of files) if (!safePath(this.root, file.path)) this.removeMissing(file.path)
    const queue = [this.root]
    while (queue.length) {
      const dir = queue.pop()!
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) queue.push(path)
        else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') this.reindexExternal(path)
      }
    }
  }

  private reindexExternal(path: string): void {
    if (this.internalWrites.has(path) || !safePath(this.root, path)) return
    try {
      const parsed = parseFrontmatter(readFileSync(path, 'utf8'))
      if (!parsed) return
      const front = parsed.frontmatter
      if (typeof front.id !== 'string' || typeof front.title !== 'string' || typeof front.status !== 'string' || typeof front.topic !== 'string') return
      const article: KnowledgeArticle = {
        id: front.id,
        title: front.title,
        summary: typeof front.summary === 'string' ? front.summary : parsed.body.slice(0, 160),
        body: parsed.body.trim(),
        status: front.status as KnowledgeArticleStatus,
        topic: normalizeTopic(front.topic),
        tags: cleanStrings(Array.isArray(front.tags) ? front.tags.filter((item): item is string => typeof item === 'string') : []),
        sources: Array.isArray(front.sources) ? front.sources.filter(isSource) : [],
        path,
        createdAt: typeof front.createdAt === 'string' ? front.createdAt : new Date().toISOString(),
        updatedAt: typeof front.updatedAt === 'string' ? front.updatedAt : new Date().toISOString(),
        ...(typeof front.publishedAt === 'string' ? { publishedAt: front.publishedAt } : {}),
        favorite: this.get(front.id)?.favorite ?? false,
        wordCount: wordCount(parsed.body)
      }
      this.upsert(article)
    } catch {
      // 外部编辑尚未写完或 frontmatter 无效时不破坏已索引的上一次版本。
    }
  }

  private removeMissing(path: string): void {
    this.database.prepare('DELETE FROM knowledge_articles WHERE path = ?').run(path)
    this.database.prepare('DELETE FROM knowledge_fts WHERE articleId NOT IN (SELECT id FROM knowledge_articles)').run()
  }

  private upsert(article: KnowledgeArticle): void {
    const previous = this.get(article.id)
    this.database.prepare(
      `INSERT INTO knowledge_articles (id, title, summary, status, topic, tags, sources, path, createdAt, updatedAt, publishedAt, body, wordCount, favorite, favoriteAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary, status=excluded.status,
         topic=excluded.topic, tags=excluded.tags, sources=excluded.sources, path=excluded.path,
         updatedAt=excluded.updatedAt, publishedAt=excluded.publishedAt, body=excluded.body, wordCount=excluded.wordCount,
         favorite=COALESCE(knowledge_articles.favorite, excluded.favorite), favoriteAt=COALESCE(knowledge_articles.favoriteAt, excluded.favoriteAt)`
    ).run(article.id, article.title, article.summary, article.status, article.topic, JSON.stringify(article.tags), JSON.stringify(article.sources), article.path, article.createdAt, article.updatedAt, article.publishedAt ?? null, article.body, article.wordCount, previous?.favorite ? 1 : 0, previous?.favoriteAt ?? null)
    this.database.prepare('DELETE FROM knowledge_fts WHERE articleId = ?').run(article.id)
    this.database.prepare('INSERT INTO knowledge_fts (articleId, title, summary, body, tags, topic) VALUES (?, ?, ?, ?, ?, ?)').run(article.id, article.title, article.summary, article.body, article.tags.join(' '), article.topic)
  }

  private hydrate(row: ArticleRow): KnowledgeArticle {
    return { id: row.id, title: row.title, summary: row.summary, body: row.body, status: row.status, topic: row.topic, tags: parseJson<string[]>(row.tags, []), sources: parseJson<KnowledgeSource[]>(row.sources, []), path: row.path, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.publishedAt ? { publishedAt: row.publishedAt } : {}), favorite: Boolean(row.favorite), ...(row.favoriteAt ? { favoriteAt: row.favoriteAt } : {}), wordCount: row.wordCount }
  }

  private hydrateComment(row: CommentRow): KnowledgeComment {
    return { id: row.id, articleId: row.articleId, body: row.body, ...(row.anchor ? { anchor: parseJson<NonNullable<KnowledgeComment['anchor']>>(row.anchor, {}) } : {}), createdAt: row.createdAt, updatedAt: row.updatedAt }
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_articles (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
        topic TEXT NOT NULL, tags TEXT NOT NULL, sources TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, publishedAt TEXT, body TEXT NOT NULL,
        wordCount INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, favoriteAt TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_comments (
        id TEXT PRIMARY KEY, articleId TEXT NOT NULL, body TEXT NOT NULL, anchor TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(articleId UNINDEXED, title, summary, body, tags, topic, tokenize='trigram');
      CREATE INDEX IF NOT EXISTS idx_knowledge_articles_status_updated ON knowledge_articles(status, updatedAt DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_comments_article ON knowledge_comments(articleId, createdAt);
    `)
  }
}

function normalizeTopic(value: string): string {
  return value.split('/').map((part) => part.trim().replace(/[\\/]/g, '')).filter(Boolean).join('/')
}

function isSource(value: unknown): value is KnowledgeSource {
  return Boolean(value && typeof value === 'object' && typeof (value as KnowledgeSource).sourceType === 'string' && typeof (value as KnowledgeSource).sourceId === 'string')
}
