// 从全局搜索跳转 / 会话内 Ctrl+F 搜索后，在内容容器里高亮所有匹配并把当前匹配滚到视口。
// 用 CSS Custom Highlight API 覆盖文本节点的 Range，不改 DOM，避免与 React/Markdown 渲染冲突。
// query 变化时重置到首个匹配；ready 变化（流式/分页）只重扫匹配、保持当前匹配位置。

import { useCallback, useEffect, useRef, useState } from 'react'

const HIGHLIGHT_NAME = 'search-term'
const CURRENT_NAME = 'search-term-current'

// CSS Custom Highlight API 在当前 TS dom lib 下未声明，做最小桥接（运行时按特性探测）。
interface HighlightRegistry {
  set(name: string, highlight: object): void
  delete(name: string): void
}
type HighlightCtor = new (...ranges: Range[]) => object

function highlightApi(): { registry: HighlightRegistry; Ctor: HighlightCtor } | null {
  const g = globalThis as unknown as { CSS?: { highlights?: HighlightRegistry }; Highlight?: HighlightCtor }
  if (!g.CSS?.highlights || typeof g.Highlight !== 'function') return null
  return { registry: g.CSS.highlights, Ctor: g.Highlight }
}

function scanRanges(container: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  const lowered = query.toLowerCase()
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const hay = (node.nodeValue ?? '').toLowerCase()
    let from = hay.indexOf(lowered)
    while (from !== -1) {
      const range = new Range()
      range.setStart(node, from)
      range.setEnd(node, from + query.length)
      ranges.push(range)
      from = hay.indexOf(lowered, from + query.length)
    }
    node = walker.nextNode()
  }
  return ranges
}

export interface ContentHighlight {
  /** 匹配总数。 */
  count: number
  /** 当前聚焦的匹配下标（0-based）。 */
  index: number
  /** 跳到指定匹配（自动循环）；负数/超界自动 wrap。 */
  goTo(idx: number): void
}

/**
 * @param containerRef 内容容器（消息列表）
 * @param query 要高亮的搜索词；空则清除高亮
 * @param ready 内容就绪信号（如 items.length、loading 取反），就绪后才扫描匹配
 * @param onConsumed 仅在 query 首次变化且命中时触发（全局搜索消费回调）
 */
export function useContentHighlight(
  containerRef: React.RefObject<HTMLElement | null>,
  query: string | null | undefined,
  ready: unknown,
  onConsumed?: () => void
): ContentHighlight {
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)
  const rangesRef = useRef<Range[]>([])
  const indexRef = useRef(0)
  const lastQuery = useRef<string | null>(null)

  useEffect(() => {
    const q = query?.trim()
    const container = containerRef.current
    const api = highlightApi()
    if (!q || !container) {
      api?.registry.delete(HIGHLIGHT_NAME)
      api?.registry.delete(CURRENT_NAME)
      rangesRef.current = []
      setCount(0)
      lastQuery.current = q ?? null
      return
    }

    const ranges = scanRanges(container, q)
    rangesRef.current = ranges
    setCount(ranges.length)

    const queryChanged = lastQuery.current !== q
    lastQuery.current = q
    if (queryChanged) {
      indexRef.current = 0
      setIndex(0)
    }

    if (ranges.length === 0) {
      api?.registry.delete(HIGHLIGHT_NAME)
      api?.registry.delete(CURRENT_NAME)
      return
    }

    const cur = Math.min(indexRef.current, ranges.length - 1)
    if (cur !== indexRef.current) {
      indexRef.current = cur
      setIndex(cur)
    }
    api?.registry.set(HIGHLIGHT_NAME, new api.Ctor(...ranges))
    api?.registry.set(CURRENT_NAME, new api.Ctor(ranges[cur]))

    if (queryChanged) {
      ranges[cur].startContainer.parentElement?.scrollIntoView({ block: 'center' })
      if (onConsumed) {
        const timer = window.setTimeout(onConsumed, 1500)
        return () => {
          window.clearTimeout(timer)
          api?.registry.delete(HIGHLIGHT_NAME)
          api?.registry.delete(CURRENT_NAME)
        }
      }
    }
    return () => {
      api?.registry.delete(HIGHLIGHT_NAME)
      api?.registry.delete(CURRENT_NAME)
    }
  }, [containerRef, query, ready, onConsumed])

  const goTo = useCallback((idx: number) => {
    const ranges = rangesRef.current
    if (ranges.length === 0) return
    const wrapped = ((idx % ranges.length) + ranges.length) % ranges.length
    indexRef.current = wrapped
    setIndex(wrapped)
    const api = highlightApi()
    api?.registry.set(CURRENT_NAME, new api.Ctor(ranges[wrapped]))
    ranges[wrapped].startContainer.parentElement?.scrollIntoView({ block: 'center' })
  }, [])

  return { count, index, goTo }
}
