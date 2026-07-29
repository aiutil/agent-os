// 统一 diff（unified diff）解析（SPEC-005 v2）。把 Edit 工具结果按行分类，供着色渲染。

export type DiffLineKind = 'add' | 'del' | 'meta' | 'context'
export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** 启发式判断文本是否像 unified diff（含 @@ hunk 头或 ---/+++ 文件头）。 */
export function isUnifiedDiff(text: string): boolean {
  if (!text) return false
  if (/^@@ .* @@/m.test(text)) return true
  return /^---\s/m.test(text) && /^\+\+\+\s/m.test(text)
}

/** 把 diff 文本逐行分类。 */
export function parseDiff(text: string): DiffLine[] {
  return text.split('\n').map((line) => {
    if (
      /^@@ .* @@/.test(line) ||
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ')
    ) {
      return { kind: 'meta', text: line }
    }
    if (line.startsWith('+')) return { kind: 'add', text: line }
    if (line.startsWith('-')) return { kind: 'del', text: line }
    return { kind: 'context', text: line }
  })
}

/** 统计 diff 的新增/删除行数（不计文件头/hunk 头）。 */
export function diffStats(lines: DiffLine[]): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const l of lines) {
    if (l.kind === 'add' && !l.text.startsWith('+++')) added += 1
    else if (l.kind === 'del' && !l.text.startsWith('---')) deleted += 1
  }
  return { added, deleted }
}
