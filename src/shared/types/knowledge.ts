import type { GraphSnapshot, GraphQuery } from './memory'

export type KnowledgeArticleStatus = 'draft' | 'published' | 'archived'

export interface KnowledgeSource {
  sourceType: 'session' | 'manual'
  sourceId: string
  toolId?: string
  messageStart?: number
  messageEnd?: number
  excerptDigest?: string
}

export interface KnowledgeArticle {
  id: string
  title: string
  summary: string
  body: string
  status: KnowledgeArticleStatus
  topic: string
  tags: string[]
  sources: KnowledgeSource[]
  path: string
  createdAt: string
  updatedAt: string
  publishedAt?: string
  favorite: boolean
  favoriteAt?: string
  wordCount: number
}

export interface KnowledgeArticleInput {
  id?: string
  title: string
  summary?: string
  body: string
  topic: string
  tags?: string[]
  sources?: KnowledgeSource[]
}

export interface KnowledgeListInput {
  query?: string
  statuses?: KnowledgeArticleStatus[]
  topic?: string
  tags?: string[]
  favoriteOnly?: boolean
  limit?: number
}

export interface KnowledgeGraphInput extends KnowledgeListInput, GraphQuery {
  includeSources?: boolean
}

export interface KnowledgeTopic {
  path: string
  label: string
  articleCount: number
  order?: number
}

export interface KnowledgeComment {
  id: string
  articleId: string
  body: string
  anchor?: { heading?: string; excerpt?: string }
  createdAt: string
  updatedAt: string
}

export interface KnowledgeCommentInput {
  body: string
  anchor?: { heading?: string; excerpt?: string }
}

export interface ExtractKnowledgeDraftInput {
  source: KnowledgeSource
  cwd: string
  text: string
  /** 自动任务为 true 时遵循敏感/外部上下文保护；手动请求可显式审阅后再调用。 */
  hasExternalContext?: boolean
}

export interface KnowledgeApi {
  list(input?: KnowledgeListInput): Promise<KnowledgeArticle[]>
  get(id: string): Promise<KnowledgeArticle | null>
  saveDraft(input: KnowledgeArticleInput): Promise<KnowledgeArticle>
  publish(id: string): Promise<KnowledgeArticle | null>
  archive(id: string): Promise<KnowledgeArticle | null>
  restore(id: string): Promise<KnowledgeArticle | null>
  remove(id: string): Promise<void>
  topics(): Promise<KnowledgeTopic[]>
  setFavorite(id: string, favorite: boolean): Promise<KnowledgeArticle | null>
  comments(articleId: string): Promise<KnowledgeComment[]>
  addComment(articleId: string, input: KnowledgeCommentInput): Promise<KnowledgeComment>
  updateComment(id: string, input: KnowledgeCommentInput): Promise<KnowledgeComment | null>
  removeComment(id: string): Promise<void>
  graph(input?: KnowledgeGraphInput): Promise<GraphSnapshot>
  extractDraft(input: ExtractKnowledgeDraftInput): Promise<KnowledgeArticle>
}
