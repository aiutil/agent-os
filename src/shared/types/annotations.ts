// 标注层（收藏 + 标签）共享类型。统一覆盖「会话/消息 × 自建(managed)/CLI 历史(cli)」。
// 自建消息用稳定的 chat_messages.id；CLI 消息用 (toolId, nativeSessionId, seq) 定位。

export type AnnotationTargetRef =
  | { kind: 'conversation'; source: 'managed'; convId: string }
  | { kind: 'conversation'; source: 'cli'; toolId: string; nativeSessionId: string }
  | { kind: 'message'; source: 'managed'; sessionId: string; messageId: string }
  | { kind: 'message'; source: 'cli'; toolId: string; nativeSessionId: string; seq: number }

export interface Annotation {
  favorite: boolean
  tags: string[]
}

export interface AnnotationEntry extends Annotation {
  ref: AnnotationTargetRef
}

/** 写入时附带的展示快照，使「收藏/标签」浏览页无需回查会话/消息即可渲染。 */
export interface AnnotationDisplayMeta {
  /** 会话标题 / 消息文本预览。 */
  label?: string
  toolId?: string
}

/** 浏览页用的富条目：标注 + 展示快照 + 最近更新时间（排序）。 */
export interface AnnotationBrowseEntry extends AnnotationEntry {
  label: string
  toolId: string
  updatedAt: string
}

export interface AnnotationListFilter {
  favorite?: boolean
  tag?: string
  kind?: 'conversation' | 'message'
}

export interface AnnotationTagCount {
  tag: string
  count: number
}

export interface AnnotationSetFavoriteInput {
  ref: AnnotationTargetRef
  favorite: boolean
  meta?: AnnotationDisplayMeta
}

export interface AnnotationSetTagsInput {
  ref: AnnotationTargetRef
  tags: string[]
  meta?: AnnotationDisplayMeta
}

export interface AnnotationTagInput {
  ref: AnnotationTargetRef
  tag: string
  meta?: AnnotationDisplayMeta
}

/**
 * 把多态 ref 编码成稳定的字符串主键，供 SQLite 主键与渲染端缓存 Map 共用。
 * 组成部分（toolId / UUID / seq）均不含冒号，故可安全用 ':' 分隔。
 */
export function annotationTargetKey(ref: AnnotationTargetRef): string {
  if (ref.kind === 'conversation') {
    return ref.source === 'managed'
      ? `conv:managed:${ref.convId}`
      : `conv:cli:${ref.toolId}:${ref.nativeSessionId}`
  }
  return ref.source === 'managed'
    ? `msg:managed:${ref.sessionId}:${ref.messageId}`
    : `msg:cli:${ref.toolId}:${ref.nativeSessionId}:${ref.seq}`
}
/**
 * annotationTargetKey 的逆运算：解析回多态 ref。
 * 返回 null 表示格式不匹配（不应在正常写入路径上发生；UI 应忽略）。
 */
export function parseTargetKey(
  key: string,
  kind: 'conversation' | 'message',
  source: 'managed' | 'cli'
): AnnotationTargetRef | null {
  if (kind === 'conversation') {
    if (source === 'managed') {
      if (!key.startsWith('conv:managed:')) return null
      const convId = key.slice('conv:managed:'.length)
      return convId ? { kind: 'conversation', source: 'managed', convId } : null
    }
    if (!key.startsWith('conv:cli:')) return null
    const rest = key.slice('conv:cli:'.length)
    const idx = rest.indexOf(':')
    if (idx <= 0) return null
    const toolId = rest.slice(0, idx)
    const nativeSessionId = rest.slice(idx + 1)
    return nativeSessionId
      ? { kind: 'conversation', source: 'cli', toolId, nativeSessionId }
      : null
  }
  if (source === 'managed') {
    if (!key.startsWith('msg:managed:')) return null
    const rest = key.slice('msg:managed:'.length)
    const idx = rest.indexOf(':')
    if (idx <= 0) return null
    const sessionId = rest.slice(0, idx)
    const messageId = rest.slice(idx + 1)
    return sessionId && messageId
      ? { kind: 'message', source: 'managed', sessionId, messageId }
      : null
  }
  if (!key.startsWith('msg:cli:')) return null
  const rest = key.slice('msg:cli:'.length)
  const first = rest.indexOf(':')
  const last = rest.lastIndexOf(':')
  if (first <= 0 || last <= first) return null
  const toolId = rest.slice(0, first)
  const nativeSessionId = rest.slice(first + 1, last)
  const seq = Number(rest.slice(last + 1))
  if (!toolId || !nativeSessionId || !Number.isInteger(seq) || seq < 0) return null
  return { kind: 'message', source: 'cli', toolId, nativeSessionId, seq }
}

