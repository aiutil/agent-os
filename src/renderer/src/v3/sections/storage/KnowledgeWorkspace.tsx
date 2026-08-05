import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DurableMemory,
  GraphNode,
  GraphSnapshot,
  KnowledgeArticle,
  KnowledgeArticleInput,
  KnowledgeComment
} from '@shared/types'
import { Markdown } from '../../../lib/markdown/Markdown'
import { MemoryDetailView } from './MemoryDetailView'
import './knowledge.css'

type ViewMode = 'graph' | 'list'
type AtlasDomain = 'memory' | 'knowledge'
type PositionedNode = GraphNode & { x: number; y: number }

const GRAPH_LIMIT = 180

function useViewMode(key: string): [ViewMode, (value: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>(() => (window.localStorage.getItem(key) === 'list' ? 'list' : 'graph'))
  const update = (value: ViewMode): void => {
    window.localStorage.setItem(key, value)
    setMode(value)
  }
  return [mode, update]
}

function nodeRadius(node: GraphNode): number {
  return Math.max(6, Math.min(14, 6 + node.weight * 1.15))
}

function nodeDepth(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = ((hash << 5) - hash + id.charCodeAt(index)) | 0
  return .78 + (Math.abs(hash) % 23) / 100
}

function graphColor(node: GraphNode, token: (name: string) => string): string {
  if (node.type === 'memory' && node.group) {
    const memoryClass = `--graph-${node.group}`
    const value = token(memoryClass)
    if (value) return value
  }
  const palette: Record<string, string> = {
    memory: token('--graph-memory'),
    persona: token('--graph-persona'),
    scope: token('--graph-scope'),
    article: token('--graph-article'),
    topic: token('--graph-topic'),
    tag: token('--graph-tag'),
    'source-session': token('--graph-source')
  }
  return palette[node.type] || token('--graph-fallback')
}

function Graph({
  domain,
  snapshot,
  selectedId,
  onSelect,
  onOpen,
  includeSources,
  onToggleSources,
  emptyTitle,
  emptyHint
}: {
  domain: AtlasDomain
  snapshot: GraphSnapshot
  selectedId?: string
  onSelect(node: GraphNode): void
  onOpen(node: GraphNode): void
  includeSources: boolean
  onToggleSources(): void
  emptyTitle?: string
  emptyHint?: string
}): React.JSX.Element {
  const wrap = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState({ width: 900, height: 560 })
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [finderOpen, setFinderOpen] = useState(false)
  const [finderQuery, setFinderQuery] = useState('')

  const rendered = useMemo<GraphSnapshot>(() => {
    const baseNodes = snapshot.nodes.filter((node) => node.type !== 'source-session')
    const baseNodeIds = new Set(baseNodes.map((node) => node.id))
    const baseEdges = snapshot.edges.filter((edge) => baseNodeIds.has(edge.source) && baseNodeIds.has(edge.target))
    if (!includeSources || !selectedId) return { ...snapshot, nodes: baseNodes, edges: baseEdges }
    const focusedEdges = snapshot.edges.filter((edge) => (
      (edge.source === selectedId || edge.target === selectedId)
      && (edge.relation === 'evidenced_by' || edge.relation === 'sourced_from')
    ))
    const sourceIds = new Set(focusedEdges.flatMap((edge) => [edge.source, edge.target]))
    return {
      ...snapshot,
      nodes: snapshot.nodes.filter((node) => baseNodeIds.has(node.id) || sourceIds.has(node.id)),
      edges: [...baseEdges, ...focusedEdges]
    }
  }, [includeSources, selectedId, snapshot])

  useEffect(() => {
    const element = wrap.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      setSize({ width: Math.max(320, entry.contentRect.width), height: Math.max(360, entry.contentRect.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!rendered.nodes.length) {
      setPositions({})
      return
    }
    const worker = new Worker(new URL('./graph-layout.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<Array<{ id: string; x: number; y: number }>>) => {
      const next = Object.fromEntries(event.data.map((node) => [node.id, node]))
      setPositions(next)
      const xs = event.data.map((node) => node.x)
      const ys = event.data.map((node) => node.y)
      const width = Math.max(1, Math.max(...xs) - Math.min(...xs))
      const height = Math.max(1, Math.max(...ys) - Math.min(...ys))
      const scale = Math.max(.5, Math.min(1.25, Math.min((size.width - 100) / width, (size.height - 110) / height)))
      setView({
        scale,
        x: size.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * scale,
        y: size.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * scale
      })
    }
    worker.postMessage({
      nodes: rendered.nodes,
      edges: rendered.edges,
      width: size.width,
      height: size.height
    })
    return () => worker.terminate()
  }, [domain, rendered, size.height, size.width])

  const nodes = useMemo<PositionedNode[]>(() => rendered.nodes.map((node, index) => ({
    ...node,
    ...(positions[node.id] ?? { x: 80 + (index % 8) * 92, y: 80 + Math.floor(index / 8) * 74 })
  })), [positions, rendered.nodes])

  const importantLabels = useMemo(() => new Set(
    [...nodes]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12)
      .map((node) => node.id)
  ), [nodes])

  const connectedIds = useMemo(() => {
    if (!selectedId) return new Set<string>()
    const result = new Set<string>([selectedId])
    for (const edge of rendered.edges) {
      if (edge.source === selectedId) result.add(edge.target)
      if (edge.target === selectedId) result.add(edge.source)
    }
    return result
  }, [rendered.edges, selectedId])

  const fitCanvas = useCallback((): void => {
    if (!nodes.length) return
    const xs = nodes.map((node) => node.x)
    const ys = nodes.map((node) => node.y)
    const width = Math.max(1, Math.max(...xs) - Math.min(...xs))
    const height = Math.max(1, Math.max(...ys) - Math.min(...ys))
    const scale = Math.max(.5, Math.min(1.25, Math.min((size.width - 100) / width, (size.height - 110) / height)))
    setView({
      scale,
      x: size.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * scale,
      y: size.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * scale
    })
  }, [nodes, size.height, size.width])

  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const ratio = window.devicePixelRatio || 1
    element.width = size.width * ratio
    element.height = size.height * ratio
    const context = element.getContext('2d')
    if (!context) return
    context.scale(ratio, ratio)
    context.clearRect(0, 0, size.width, size.height)
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const styles = getComputedStyle(document.documentElement)
    const token = (name: string): string => styles.getPropertyValue(name).trim()

    for (const edge of rendered.edges) {
      const source = byId.get(edge.source)
      const target = byId.get(edge.target)
      if (!source || !target) continue
      const highlighted = selectedId ? edge.source === selectedId || edge.target === selectedId : false
      context.save()
      context.strokeStyle = highlighted ? token('--graph-edge-active') : token('--graph-edge')
      context.globalAlpha = selectedId && !highlighted ? .22 : highlighted ? .9 : .55
      context.lineWidth = highlighted ? 1.6 : .8
      context.beginPath()
      context.moveTo(source.x * view.scale + view.x, source.y * view.scale + view.y)
      context.lineTo(target.x * view.scale + view.x, target.y * view.scale + view.y)
      context.stroke()
      context.restore()
    }

    for (const node of nodes) {
      const x = node.x * view.scale + view.x
      const y = node.y * view.scale + view.y
      const selected = selectedId === node.id
      const hovered = hoveredId === node.id
      const depth = rendered.nodes.length >= 60 ? nodeDepth(node.id) : 1
      const radius = nodeRadius(node) * Math.max(.76, view.scale) * depth
      const unrelated = selectedId && !connectedIds.has(node.id)
      context.save()
      context.globalAlpha = (node.muted ? .38 : unrelated ? .28 : 1) * (.72 + depth * .28)
      context.beginPath()
      context.arc(x, y, radius, 0, Math.PI * 2)
      context.fillStyle = graphColor(node, token)
      context.fill()
      context.strokeStyle = selected || hovered ? token('--graph-selection') : token('--graph-node-border')
      context.lineWidth = selected ? 2.4 : hovered ? 1.8 : 1
      if (node.status === 'candidate' || node.status === 'draft') context.setLineDash([4, 3])
      if (node.status === 'archived' || node.status === 'superseded') context.setLineDash([2, 3])
      context.stroke()
      context.restore()

      const showLabel = selected || hovered || importantLabels.has(node.id) || (selectedId ? connectedIds.has(node.id) : false)
      if (!showLabel) continue
      const label = node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label
      context.save()
      context.font = selected ? '600 12px system-ui' : '11px system-ui'
      const labelWidth = context.measureText(label).width
      const labelX = x + radius + 7
      const labelY = y - 10
      context.fillStyle = token('--graph-label-bg')
      context.globalAlpha = unrelated ? .46 : .92
      context.fillRect(labelX - 4, labelY - 2, labelWidth + 8, 18)
      context.globalAlpha = unrelated ? .5 : 1
      context.fillStyle = token('--graph-label')
      context.fillText(label, labelX, labelY + 11)
      context.restore()
    }
  }, [connectedIds, hoveredId, importantLabels, nodes, rendered.edges, selectedId, size.height, size.width, view])

  const findHit = (event: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>): PositionedNode | undefined => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left - view.x) / view.scale
    const y = (event.clientY - rect.top - view.y) / view.scale
    return [...nodes].reverse().find((node) => Math.hypot(node.x - x, node.y - y) < (nodeRadius(node) + 6) / view.scale)
  }

  const finderNodes = useMemo(() => {
    const needle = finderQuery.trim().toLowerCase()
    return nodes.filter((node) => !needle || node.label.toLowerCase().includes(needle)).slice(0, 12)
  }, [finderQuery, nodes])

  return (
    <div
      ref={wrap}
      className={`atlas-graph ${rendered.nodes.length ? 'is-orb' : ''}`}
    >
      <div className="atlas-graph__tools">
        <button type="button" aria-expanded={finderOpen} onClick={() => setFinderOpen((value) => !value)}>查找节点</button>
        <button type="button" onClick={fitCanvas}>适应画布</button>
        <button type="button" aria-pressed={includeSources} disabled={!selectedId} onClick={onToggleSources}>
          {includeSources ? '隐藏当前来源' : '展开当前来源'}
        </button>
      </div>
      {finderOpen && (
        <div className="atlas-finder" aria-label="图谱节点导航">
          <input autoFocus value={finderQuery} onChange={(event) => setFinderQuery(event.target.value)} placeholder="输入节点名称" />
          <div className="atlas-finder__list">
            {finderNodes.map((node) => (
              <button key={node.id} type="button" className={selectedId === node.id ? 'is-active' : ''} onClick={() => { onSelect(node); setFinderOpen(false) }}>
                <span className={`atlas-dot is-${node.type}`} />
                <span>{node.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {snapshot.truncated && (
        <div className="atlas-graph__limit" role="status">默认展示最近活跃的 {GRAPH_LIMIT} 条内容，搜索可定位其余条目。</div>
      )}
      <canvas
        ref={canvas}
        className="atlas-graph__canvas"
        aria-label={`圆形${domain === 'memory' ? '记忆' : '知识'}图谱。单击节点在右侧查看详情，双击扩展阅读；拖动空白区域平移，滚轮缩放。`}
        onPointerDown={(event) => {
          if (!findHit(event)) drag.current = { x: event.clientX, y: event.clientY }
        }}
        onPointerMove={(event) => {
          if (drag.current) {
            const dx = event.clientX - drag.current.x
            const dy = event.clientY - drag.current.y
            setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
            drag.current = { x: event.clientX, y: event.clientY }
            return
          }
          setHoveredId(findHit(event)?.id ?? null)
        }}
        onPointerLeave={() => { drag.current = null; setHoveredId(null) }}
        onPointerUp={() => { drag.current = null }}
        onWheel={(event) => {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          const px = event.clientX - rect.left
          const py = event.clientY - rect.top
          setView((current) => {
            const nextScale = Math.max(.42, Math.min(2.25, current.scale * (event.deltaY < 0 ? 1.1 : .9)))
            return {
              scale: nextScale,
              x: px - ((px - current.x) / current.scale) * nextScale,
              y: py - ((py - current.y) / current.scale) * nextScale
            }
          })
        }}
        onClick={(event) => {
          const hit = findHit(event)
          if (hit) onSelect(hit)
        }}
        onDoubleClick={(event) => {
          const hit = findHit(event)
          if (hit) onOpen(hit)
        }}
      />
      {!rendered.nodes.length && (
        <div className="atlas-empty">
          <div className="atlas-empty__mark" aria-hidden="true">◇</div>
          <strong>{emptyTitle ?? '没有可展示的节点'}</strong>
          <span>{emptyHint ?? '调整搜索或筛选条件后再试。'}</span>
        </div>
      )}
      <div className={`atlas-legend is-${domain}`} aria-label="图谱图例">
        {(domain === 'memory'
          ? [['identity', '人格'], ['semantic', '语义'], ['episodic', '情景'], ['procedural', '流程']]
          : [['article', '文章'], ['topic', '主题'], ['tag', '标签']]
        ).map(([type, label]) => <span key={type}><i className={`atlas-dot is-${type}`} />{label}</span>)}
      </div>
      <div className="atlas-graph__hint">单击检查 · 双击扩展 · 滚轮缩放</div>
    </div>
  )
}

function AtlasHeader({
  eyebrow,
  title,
  description,
  count,
  query,
  onQuery,
  mode,
  onMode,
  primaryAction
}: {
  eyebrow: string
  title: string
  description: string
  count: number
  query: string
  onQuery(value: string): void
  mode: ViewMode
  onMode(value: ViewMode): void
  primaryAction?: { label: string; onClick(): void }
}): React.JSX.Element {
  return (
    <header className="atlas-header">
      <div className="atlas-header__identity">
        <p>{eyebrow}</p>
        <div><h1>{title}</h1><span className="atlas-count">{count}</span></div>
        <small>{description}</small>
      </div>
      <div className="atlas-header__controls">
        {primaryAction && <button type="button" className="is-primary" onClick={primaryAction.onClick}>{primaryAction.label}</button>}
        <label className="atlas-search">
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索" />
        </label>
        <div className="atlas-view-switch" aria-label="首页展示方式">
          <button type="button" className={mode === 'graph' ? 'is-active' : ''} aria-pressed={mode === 'graph'} onClick={() => onMode('graph')}>图谱</button>
          <button type="button" className={mode === 'list' ? 'is-active' : ''} aria-pressed={mode === 'list'} onClick={() => onMode('list')}>列表</button>
        </div>
      </div>
    </header>
  )
}

function AtlasContext({
  expanded,
  breadcrumb,
  onToggleExpanded,
  onClose,
  children
}: {
  expanded: boolean
  breadcrumb: string[]
  onToggleExpanded(): void
  onClose(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <aside className={`atlas-context ${expanded ? 'is-expanded' : ''}`} aria-label="上下文详情">
      <div className="atlas-context__bar">
        <div className="atlas-context__trail" aria-label="知识脉络">
          {breadcrumb.filter(Boolean).map((item, index) => (
            <span key={`${item}:${index}`}><i />{item}</span>
          ))}
        </div>
        <div className="atlas-context__actions">
          <button type="button" onClick={onToggleExpanded}>{expanded ? '收窄' : '扩展阅读'}</button>
          <button type="button" aria-label="关闭详情" onClick={onClose}>×</button>
        </div>
      </div>
      <div className="atlas-context__body">{children}</div>
    </aside>
  )
}

function EntityInspector({ node, domain }: { node: GraphNode; domain: AtlasDomain }): React.JSX.Element {
  const typeLabels: Record<string, string> = {
    persona: '人格中心', scope: '作用域', topic: '主题', tag: '标签', 'source-session': '来源会话'
  }
  return (
    <div className="atlas-entity-inspector">
      <p>{domain === 'memory' ? '记忆聚类' : '知识聚类'}</p>
      <h2>{node.label}</h2>
      <div className="atlas-entity-inspector__meta">{typeLabels[node.type] ?? node.type}{node.group ? ` · ${node.group}` : ''}</div>
      <div className="atlas-entity-inspector__note">
        这是用于组织内容的关系节点。选择相连的{domain === 'memory' ? '记忆' : '文章'}即可在这里查看正文，主图谱会保持原位。
      </div>
    </div>
  )
}

function MemoryTable({
  items,
  visible,
  selectedId,
  onSelect,
  onLoadMore
}: {
  items: DurableMemory[]
  visible: number
  selectedId?: string
  onSelect(item: DurableMemory, expanded: boolean): void
  onLoadMore(): void
}): React.JSX.Element {
  return (
    <div className="atlas-list-wrap">
      <div className="atlas-table atlas-table--memory" role="table" aria-label="记忆列表">
        <div role="row" className="atlas-table__head">
          <span>标题</span><span>类别</span><span>作用域</span><span>状态</span><span>使用</span><span>最近使用</span><span>来源</span>
        </div>
        {items.slice(0, visible).map((item) => (
          <button
            type="button"
            role="row"
            key={item.id}
            className={selectedId === item.id ? 'is-selected' : ''}
            onClick={() => onSelect(item, false)}
            onDoubleClick={() => onSelect(item, true)}
          >
            <strong>{item.title}</strong>
            <span>{item.memoryClass ?? item.kind}</span>
            <span>{item.scopeRef ?? item.scope}</span>
            <span><i className={`atlas-status is-${item.status}`} />{item.status}</span>
            <span>{item.accessCount ?? 0} 次</span>
            <span>{item.lastAccessedAt?.slice(0, 10) ?? '从未'}</span>
            <span>{item.evidence.length}</span>
          </button>
        ))}
      </div>
      {visible < items.length && <button type="button" className="atlas-more" onClick={onLoadMore}>再加载 100 条</button>}
    </div>
  )
}

export function MemoryHomeView({
  selectedMemoryId,
  onSelectMemory,
  onCloseSelection
}: {
  selectedMemoryId?: string
  onSelectMemory(memory: { id: string; title: string }): void
  onCloseSelection(): void
}): React.JSX.Element {
  const [items, setItems] = useState<DurableMemory[]>([])
  const [graph, setGraph] = useState<GraphSnapshot>({ nodes: [], edges: [], truncated: false })
  const [query, setQuery] = useState('')
  const [mode, setMode] = useViewMode('agent-os.memory-home-view')
  const [includeSources, setIncludeSources] = useState(false)
  const [visible, setVisible] = useState(100)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [expanded, setExpanded] = useState(false)

  const reload = useCallback((): void => {
    void window.agentOs.memory.listDurable({ query, limit: 1500 }).then(setItems)
    void window.agentOs.memory.graph({ query, limit: GRAPH_LIMIT, includeSources }).then(setGraph)
  }, [includeSources, query])

  useEffect(reload, [reload])

  useEffect(() => {
    if (!selectedMemoryId) return
    const graphNode = graph.nodes.find((node) => node.id === `memory:${selectedMemoryId}`)
    if (graphNode) setSelectedNode(graphNode)
    if (!items.some((item) => item.id === selectedMemoryId)) {
      void window.agentOs.memory.getDurable(selectedMemoryId).then((memory) => {
        if (memory) setItems((current) => [memory, ...current])
      })
    }
  }, [graph.nodes, items, selectedMemoryId])

  const selectedMemory = selectedMemoryId ? items.find((item) => item.id === selectedMemoryId) : undefined

  const selectMemory = (memory: DurableMemory, shouldExpand: boolean): void => {
    setSelectedNode(graph.nodes.find((node) => node.id === `memory:${memory.id}`) ?? {
      id: `memory:${memory.id}`, type: 'memory', label: memory.title, group: memory.memoryClass, status: memory.status, weight: 1
    })
    setExpanded(shouldExpand)
    onSelectMemory(memory)
  }

  const selectNode = (node: GraphNode, shouldExpand: boolean): void => {
    setSelectedNode(node)
    setExpanded(shouldExpand)
    if (node.type === 'memory') {
      const memory = items.find((item) => item.id === node.id.slice('memory:'.length))
      if (memory) onSelectMemory(memory)
    } else {
      onCloseSelection()
    }
  }

  const closeSelection = (): void => {
    setSelectedNode(null)
    setExpanded(false)
    setIncludeSources(false)
    onCloseSelection()
  }

  const handleMemoryChanged = (memory: DurableMemory | null): void => {
    if (!memory) {
      setItems((current) => current.filter((item) => item.id !== selectedMemoryId))
      closeSelection()
      return
    }
    setItems((current) => current.map((item) => item.id === memory.id ? memory : item))
    reload()
  }

  return (
    <section className={`atlas-workspace ${selectedNode ? 'has-context' : ''} ${expanded ? 'has-expanded-context' : ''}`}>
      <AtlasHeader
        eyebrow="MEMORY ATLAS"
        title="记忆脉络"
        description="人格、工作与项目记忆，按关系聚合并保持可审阅。"
        count={items.length}
        query={query}
        onQuery={(value) => { setQuery(value); setVisible(100) }}
        mode={mode}
        onMode={setMode}
      />
      <div className="atlas-stage">
        <div className="atlas-stage__main">
          {mode === 'graph' ? (
            <Graph
              domain="memory"
              snapshot={graph}
              selectedId={selectedNode?.id}
              onSelect={(node) => selectNode(node, false)}
              onOpen={(node) => selectNode(node, true)}
              includeSources={includeSources}
              onToggleSources={() => setIncludeSources((value) => !value)}
              emptyTitle={query ? '没有匹配的记忆' : '还没有长期记忆'}
            />
          ) : (
            <MemoryTable
              items={items}
              visible={visible}
              selectedId={selectedMemoryId}
              onSelect={selectMemory}
              onLoadMore={() => setVisible((count) => count + 100)}
            />
          )}
        </div>
        {selectedNode && (
          <AtlasContext
            expanded={expanded}
            breadcrumb={selectedMemory
              ? [selectedMemory.scopeRef ?? selectedMemory.scope, selectedMemory.memoryClass ?? selectedMemory.kind, selectedMemory.title]
              : [selectedNode.group ?? '全局', selectedNode.label]}
            onToggleExpanded={() => setExpanded((value) => !value)}
            onClose={closeSelection}
          >
            {selectedMemory ? (
              <MemoryDetailView embedded memoryId={selectedMemory.id} onChanged={handleMemoryChanged} />
            ) : (
              <EntityInspector node={selectedNode} domain="memory" />
            )}
          </AtlasContext>
        )}
      </div>
    </section>
  )
}

function KnowledgeTable({
  items,
  visible,
  selectedId,
  onSelect,
  onLoadMore
}: {
  items: KnowledgeArticle[]
  visible: number
  selectedId?: string
  onSelect(item: KnowledgeArticle, expanded: boolean): void
  onLoadMore(): void
}): React.JSX.Element {
  return (
    <div className="atlas-list-wrap">
      <div className="atlas-table atlas-table--knowledge" role="table" aria-label="知识文章列表">
        <div role="row" className="atlas-table__head">
          <span>标题</span><span>主题</span><span>状态</span><span>标签</span><span>发布时间</span><span>更新时间</span><span>收藏</span><span>来源</span>
        </div>
        {items.slice(0, visible).map((item) => (
          <button
            type="button"
            role="row"
            key={item.id}
            className={selectedId === item.id ? 'is-selected' : ''}
            onClick={() => onSelect(item, false)}
            onDoubleClick={() => onSelect(item, true)}
          >
            <strong>{item.title}</strong>
            <span>{item.topic}</span>
            <span><i className={`atlas-status is-${item.status}`} />{item.status}</span>
            <span>{item.tags.map((tag) => `#${tag}`).join(' ') || '—'}</span>
            <span>{item.publishedAt?.slice(0, 10) ?? '—'}</span>
            <span>{item.updatedAt.slice(0, 10)}</span>
            <span>{item.favorite ? '★' : '—'}</span>
            <span>{item.sources.length}</span>
          </button>
        ))}
      </div>
      {visible < items.length && <button type="button" className="atlas-more" onClick={onLoadMore}>再加载 100 篇</button>}
    </div>
  )
}

export function KnowledgeHomeView({
  selectedArticle,
  editing = false,
  creating = false,
  onSelectArticle,
  onCloseSelection,
  onCreate,
  onEdit,
  onSave
}: {
  selectedArticle?: KnowledgeArticle
  editing?: boolean
  creating?: boolean
  onSelectArticle(article: KnowledgeArticle): void
  onCloseSelection(): void
  onCreate(): void
  onEdit(article: KnowledgeArticle): void
  onSave(article: KnowledgeArticle): void
}): React.JSX.Element {
  const [items, setItems] = useState<KnowledgeArticle[]>([])
  const [graph, setGraph] = useState<GraphSnapshot>({ nodes: [], edges: [], truncated: false })
  const [query, setQuery] = useState('')
  const [mode, setMode] = useViewMode('agent-os.knowledge-home-view')
  const [includeSources, setIncludeSources] = useState(false)
  const [visible, setVisible] = useState(100)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [expanded, setExpanded] = useState(false)

  const reload = useCallback((): void => {
    void window.agentOs.knowledge.list({ query, limit: 1500 }).then(setItems)
    void window.agentOs.knowledge.graph({ query, limit: GRAPH_LIMIT, includeSources }).then(setGraph)
  }, [includeSources, query])

  useEffect(reload, [reload])

  useEffect(() => {
    if (!selectedArticle) return
    setSelectedNode(graph.nodes.find((node) => node.id === `article:${selectedArticle.id}`) ?? {
      id: `article:${selectedArticle.id}`,
      type: 'article',
      label: selectedArticle.title,
      group: selectedArticle.topic,
      status: selectedArticle.status,
      weight: 1
    })
  }, [graph.nodes, selectedArticle])

  useEffect(() => {
    if (editing || creating) setExpanded(true)
  }, [creating, editing])

  const currentArticle = selectedArticle
    ? items.find((item) => item.id === selectedArticle.id) ?? selectedArticle
    : undefined

  const selectArticle = (article: KnowledgeArticle, shouldExpand: boolean): void => {
    setSelectedNode(graph.nodes.find((node) => node.id === `article:${article.id}`) ?? {
      id: `article:${article.id}`, type: 'article', label: article.title, group: article.topic, status: article.status, weight: 1
    })
    setExpanded(shouldExpand)
    onSelectArticle(article)
  }

  const selectNode = (node: GraphNode, shouldExpand: boolean): void => {
    setSelectedNode(node)
    setExpanded(shouldExpand)
    if (node.type === 'article') {
      const article = items.find((item) => item.id === node.id.slice('article:'.length))
      if (article) onSelectArticle(article)
    } else {
      onCloseSelection()
    }
  }

  const closeSelection = (): void => {
    setSelectedNode(null)
    setExpanded(false)
    setIncludeSources(false)
    onCloseSelection()
  }

  const articleChanged = (article: KnowledgeArticle | null): void => {
    if (!article) {
      if (currentArticle) setItems((current) => current.filter((item) => item.id !== currentArticle.id))
      closeSelection()
      return
    }
    setItems((current) => current.some((item) => item.id === article.id)
      ? current.map((item) => item.id === article.id ? article : item)
      : [article, ...current])
    onSelectArticle(article)
    reload()
  }

  const contextOpen = Boolean(selectedNode || editing || creating)

  return (
    <section className={`atlas-workspace ${contextOpen ? 'has-context' : ''} ${expanded ? 'has-expanded-context' : ''}`}>
      <AtlasHeader
        eyebrow="KNOWLEDGE ATLAS"
        title="知识脉络"
        description="主题连接文章与来源会话；草稿审核后再发布。"
        count={items.length}
        query={query}
        onQuery={(value) => { setQuery(value); setVisible(100) }}
        mode={mode}
        onMode={setMode}
        primaryAction={{ label: '新建草稿', onClick: onCreate }}
      />
      <div className="atlas-stage">
        <div className="atlas-stage__main">
          {mode === 'graph' ? (
            <Graph
              domain="knowledge"
              snapshot={graph}
              selectedId={selectedNode?.id}
              onSelect={(node) => selectNode(node, false)}
              onOpen={(node) => selectNode(node, true)}
              includeSources={includeSources}
              onToggleSources={() => setIncludeSources((value) => !value)}
              emptyTitle={query ? '没有匹配的知识文章' : '从会话中建立第一篇知识'}
              emptyHint={query ? '换一个关键词，或切换到列表查看全部文章。' : '自动提炼只会生成草稿，你确认后再发布。'}
            />
          ) : items.length ? (
            <KnowledgeTable
              items={items}
              visible={visible}
              selectedId={currentArticle?.id}
              onSelect={selectArticle}
              onLoadMore={() => setVisible((count) => count + 100)}
            />
          ) : (
            <div className="atlas-empty atlas-empty--list">
              <div className="atlas-empty__mark" aria-hidden="true">◇</div>
              <strong>{query ? '没有匹配的文章' : '知识库还是空的'}</strong>
              <span>{query ? '调整搜索关键词后再试。' : '可以手动新建草稿，也可以填写会话 ID 后让 Agent OS 提炼。'}</span>
              {!query && <button type="button" className="is-primary" onClick={onCreate}>创建第一篇草稿</button>}
            </div>
          )}
        </div>
        {contextOpen && (
          <AtlasContext
            expanded={expanded}
            breadcrumb={currentArticle
              ? [currentArticle.topic, currentArticle.title, currentArticle.sources.length ? `${currentArticle.sources.length} 个来源` : '待补充来源']
              : [creating ? '收集箱' : selectedNode?.group ?? '知识库', creating ? '新草稿' : selectedNode?.label ?? '编辑']}
            onToggleExpanded={() => setExpanded((value) => !value)}
            onClose={closeSelection}
          >
            {editing || creating ? (
              <KnowledgeEditor
                embedded
                article={creating ? undefined : currentArticle}
                onDone={(article) => { onSave(article); articleChanged(article) }}
                onCancel={closeSelection}
              />
            ) : currentArticle ? (
              <KnowledgeArticleView
                embedded
                article={currentArticle}
                onBack={closeSelection}
                onEdit={() => onEdit(currentArticle)}
                onChanged={articleChanged}
              />
            ) : selectedNode ? (
              <EntityInspector node={selectedNode} domain="knowledge" />
            ) : null}
          </AtlasContext>
        )}
      </div>
    </section>
  )
}

export function KnowledgeArticleView({
  article,
  onBack,
  onEdit,
  onChanged,
  embedded = false
}: {
  article: KnowledgeArticle
  onBack(): void
  onEdit(): void
  onChanged?(article: KnowledgeArticle | null): void
  embedded?: boolean
}): React.JSX.Element {
  const [current, setCurrent] = useState(article)
  const [comments, setComments] = useState<KnowledgeComment[]>([])
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setCurrent(article)
    void window.agentOs.knowledge.comments(article.id).then(setComments)
  }, [article])

  const update = (promise: Promise<KnowledgeArticle | null>): void => {
    setError('')
    void promise.then((next) => {
      if (!next) return
      setCurrent(next)
      onChanged?.(next)
    }).catch((cause: Error) => setError(cause.message))
  }

  return (
    <section className={`knowledge-article ${embedded ? 'is-embedded' : ''}`}>
      {!embedded && <button type="button" onClick={onBack}>← 返回知识库</button>}
      <header>
        <div className="knowledge-article__kicker"><span className={`atlas-status is-${current.status}`} />{current.topic} · {current.status}</div>
        <h1>{current.title}</h1>
        {current.summary && <p className="knowledge-article__summary">{current.summary}</p>}
        <div className="knowledge-article__tags">{current.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
        <div className="knowledge-article__actions">
          <button type="button" onClick={() => update(window.agentOs.knowledge.setFavorite(current.id, !current.favorite))}>{current.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
          {current.status === 'draft' && <button type="button" className="is-primary" onClick={() => update(window.agentOs.knowledge.publish(current.id))}>发布</button>}
          <button type="button" onClick={() => update(current.status === 'archived' ? window.agentOs.knowledge.restore(current.id) : window.agentOs.knowledge.archive(current.id))}>{current.status === 'archived' ? '恢复草稿' : '归档'}</button>
          <button type="button" onClick={onEdit}>编辑</button>
          <button type="button" onClick={() => void window.agentOs.knowledge.openInObsidian(current.id)}>Obsidian</button>
        </div>
        {error && <p className="atlas-error" role="alert">{error}</p>}
      </header>
      <article className="knowledge-article__body"><Markdown content={current.body} /></article>
      <aside className="knowledge-article__sources">
        <h2>来源会话</h2>
        {current.sources.length
          ? current.sources.map((source) => <div key={`${source.sourceType}:${source.sourceId}`}><strong>{source.toolId ?? source.sourceType}</strong><span>{source.sourceId}</span></div>)
          : <p>尚未关联来源，会在发布前提醒补充。</p>}
      </aside>
      <section className="knowledge-article__comments">
        <h2>本机批注</h2>
        {comments.map((item) => <p key={item.id}>{item.body}</p>)}
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="记录你的批注" />
        <button
          type="button"
          onClick={() => void window.agentOs.knowledge.addComment(current.id, { body: comment }).then((next) => { setComments([...comments, next]); setComment('') })}
          disabled={!comment.trim()}
        >添加批注</button>
      </section>
      <div className="knowledge-article__danger">
        <button type="button" onClick={() => {
          if (!window.confirm('永久删除这篇文章及其本机批注？此操作不可恢复。')) return
          void window.agentOs.knowledge.remove(current.id).then(() => { onChanged?.(null); onBack() })
        }}>永久删除</button>
      </div>
    </section>
  )
}

export function KnowledgeEditor({
  article,
  onDone,
  onCancel,
  embedded = false
}: {
  article?: KnowledgeArticle
  onDone(next: KnowledgeArticle): void
  onCancel?(): void
  embedded?: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState<KnowledgeArticleInput>({
    id: article?.id,
    title: article?.title ?? '',
    summary: article?.summary ?? '',
    body: article?.body ?? '',
    topic: article?.topic ?? '收集箱',
    tags: article?.tags ?? [],
    sources: article?.sources ?? []
  })
  const [sourceId, setSourceId] = useState(article?.sources[0]?.sourceId ?? '')
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft({
      id: article?.id,
      title: article?.title ?? '',
      summary: article?.summary ?? '',
      body: article?.body ?? '',
      topic: article?.topic ?? '收集箱',
      tags: article?.tags ?? [],
      sources: article?.sources ?? []
    })
    setSourceId(article?.sources[0]?.sourceId ?? '')
  }, [article])

  const source = (): KnowledgeArticleInput => ({
    ...draft,
    sources: sourceId.trim() ? [{ sourceType: 'session', sourceId: sourceId.trim() }] : draft.sources
  })

  const extract = (): void => {
    setError('')
    void window.agentOs.memory.getTranscript(sourceId.trim()).then((transcript) => {
      if (!transcript?.cwd) throw new Error('该会话缺少工作目录，无法在受限模式中提炼')
      return window.agentOs.knowledge.extractDraft({
        source: { sourceType: 'session', sourceId: sourceId.trim(), toolId: transcript.toolId },
        cwd: transcript.cwd,
        text: transcript.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => `${message.role}: ${message.text}`)
          .join('\n\n')
      })
    }).then(onDone).catch((cause: Error) => setError(cause.message))
  }

  return (
    <section className={`knowledge-editor ${embedded ? 'is-embedded' : ''}`}>
      <div className="knowledge-editor__heading">
        <div><p>知识草稿</p><h1>{article ? '编辑文章' : '新建文章'}</h1></div>
        {onCancel && <button type="button" onClick={onCancel}>取消</button>}
      </div>
      <label>标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="文章标题" /></label>
      <label>摘要<input value={draft.summary ?? ''} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder="一句话说明这篇文章解决什么问题" /></label>
      <div className="knowledge-editor__row">
        <label>主题<input value={draft.topic} onChange={(event) => setDraft({ ...draft, topic: event.target.value })} placeholder="例如 IoT 开发" /></label>
        <label>标签<input value={(draft.tags ?? []).join(', ')} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder="逗号分隔" /></label>
      </div>
      <label>来源会话<input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="会话 ID（发布前必填）" /></label>
      <label>Markdown 正文<textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder="从问题、判断和可复用结论开始写…" /></label>
      <div className="knowledge-editor__actions">
        <button type="button" className="is-primary" onClick={() => void window.agentOs.knowledge.saveDraft(source()).then(onDone).catch((cause: Error) => setError(cause.message))}>保存草稿</button>
        <button type="button" onClick={extract} disabled={!sourceId.trim()}>使用共享 CLI 提炼</button>
      </div>
      <p className="knowledge-editor__shared-hint">提炼 CLI 和模型在“设置 → 记忆与知识”统一配置。</p>
      {error && <p className="atlas-error" role="alert">{error}</p>}
    </section>
  )
}
