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
import { useT } from '../../../lib/i18n'
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
  const { t } = useT()
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
        <button type="button" aria-expanded={finderOpen} onClick={() => setFinderOpen((value) => !value)}>{t('memory.atlas.common.findNode')}</button>
        <button type="button" onClick={fitCanvas}>{t('memory.atlas.common.fitCanvas')}</button>
        <button type="button" aria-pressed={includeSources} disabled={!selectedId} onClick={onToggleSources}>
          {includeSources ? t('memory.atlas.common.hideSources') : t('memory.atlas.common.showSources')}
        </button>
      </div>
      {finderOpen && (
        <div className="atlas-finder" aria-label={t('memory.atlas.common.navigator')}>
          <input autoFocus value={finderQuery} onChange={(event) => setFinderQuery(event.target.value)} placeholder={t('memory.atlas.common.nodePlaceholder')} />
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
        <div className="atlas-graph__limit" role="status">{t('memory.atlas.common.truncated', { count: GRAPH_LIMIT })}</div>
      )}
      <canvas
        ref={canvas}
        className="atlas-graph__canvas"
        aria-label={t(domain === 'memory' ? 'memory.atlas.common.memoryGraphAria' : 'memory.atlas.common.knowledgeGraphAria')}
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
          <strong>{emptyTitle ?? t('memory.atlas.common.emptyTitle')}</strong>
          <span>{emptyHint ?? t('memory.atlas.common.emptyHint')}</span>
        </div>
      )}
      <div className={`atlas-legend is-${domain}`} aria-label={t('memory.atlas.common.legend')}>
        {(domain === 'memory'
          ? [['identity', t('memory.atlas.type.identity')], ['semantic', t('memory.atlas.type.semantic')], ['episodic', t('memory.atlas.type.episodic')], ['procedural', t('memory.atlas.type.procedural')]]
          : [['article', t('memory.atlas.type.article')], ['topic', t('memory.atlas.type.topic')], ['tag', t('memory.atlas.type.tag')]]
        ).map(([type, label]) => <span key={type}><i className={`atlas-dot is-${type}`} />{label}</span>)}
      </div>
      <div className="atlas-graph__hint">{t('memory.atlas.common.interactionHint')}</div>
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
  const { t } = useT()
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
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={t('memory.atlas.common.search')} />
        </label>
        <div className="atlas-view-switch" aria-label={t('memory.atlas.common.viewMode')}>
          <button type="button" className={mode === 'graph' ? 'is-active' : ''} aria-pressed={mode === 'graph'} onClick={() => onMode('graph')}>{t('memory.atlas.common.graph')}</button>
          <button type="button" className={mode === 'list' ? 'is-active' : ''} aria-pressed={mode === 'list'} onClick={() => onMode('list')}>{t('memory.atlas.common.list')}</button>
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
  const { t } = useT()
  return (
    <aside className={`atlas-context ${expanded ? 'is-expanded' : ''}`} aria-label={t('memory.atlas.common.context')}>
      <div className="atlas-context__bar">
        <div className="atlas-context__trail" aria-label={t('memory.atlas.common.trail')}>
          {breadcrumb.filter(Boolean).map((item, index) => (
            <span key={`${item}:${index}`}><i />{item}</span>
          ))}
        </div>
        <div className="atlas-context__actions">
          <button type="button" onClick={onToggleExpanded}>{expanded ? t('memory.atlas.common.narrow') : t('memory.atlas.common.expandReading')}</button>
          <button type="button" aria-label={t('memory.atlas.common.close')} onClick={onClose}>×</button>
        </div>
      </div>
      <div className="atlas-context__body">{children}</div>
    </aside>
  )
}

function EntityInspector({ node, domain }: { node: GraphNode; domain: AtlasDomain }): React.JSX.Element {
  const { t } = useT()
  const typeLabels: Record<string, string> = {
    persona: t('memory.atlas.type.persona'),
    scope: t('memory.atlas.type.scope'),
    topic: t('memory.atlas.type.topic'),
    tag: t('memory.atlas.type.tag'),
    'source-session': t('memory.atlas.type.sourceSession')
  }
  return (
    <div className="atlas-entity-inspector">
      <p>{domain === 'memory' ? t('memory.atlas.entity.memoryCluster') : t('memory.atlas.entity.knowledgeCluster')}</p>
      <h2>{node.label}</h2>
      <div className="atlas-entity-inspector__meta">{typeLabels[node.type] ?? node.type}{node.group ? ` · ${node.group}` : ''}</div>
      <div className="atlas-entity-inspector__note">
        {t(domain === 'memory' ? 'memory.atlas.entity.noteMemory' : 'memory.atlas.entity.noteKnowledge')}
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
  const { t } = useT()
  const statusLabel = (status: DurableMemory['status']): string => {
    const labels: Record<DurableMemory['status'], string> = {
      candidate: t('memory.atlas.status.candidate'),
      active: t('memory.atlas.status.active'),
      superseded: t('memory.atlas.status.superseded'),
      archived: t('memory.atlas.status.archived')
    }
    return labels[status]
  }
  return (
    <div className="atlas-list-wrap">
      <div className="atlas-table atlas-table--memory" role="table" aria-label={t('memory.atlas.memory.listAria')}>
        <div role="row" className="atlas-table__head">
          <span>{t('memory.atlas.memory.titleColumn')}</span><span>{t('memory.atlas.memory.classColumn')}</span><span>{t('memory.atlas.memory.scopeColumn')}</span><span>{t('memory.atlas.memory.statusColumn')}</span><span>{t('memory.atlas.memory.useColumn')}</span><span>{t('memory.atlas.memory.lastUsedColumn')}</span><span>{t('memory.atlas.memory.sourceColumn')}</span>
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
            <span><i className={`atlas-status is-${item.status}`} />{statusLabel(item.status)}</span>
            <span>{t('memory.atlas.memory.accessCount', { count: item.accessCount ?? 0 })}</span>
            <span>{item.lastAccessedAt?.slice(0, 10) ?? t('memory.atlas.memory.never')}</span>
            <span>{item.evidence.length}</span>
          </button>
        ))}
      </div>
      {visible < items.length && <button type="button" className="atlas-more" onClick={onLoadMore}>{t('memory.atlas.memory.loadMore')}</button>}
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
  const { t } = useT()
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
        eyebrow={t('memory.atlas.memory.eyebrow')}
        title={t('memory.atlas.memory.title')}
        description={t('memory.atlas.memory.description')}
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
              emptyTitle={query ? t('memory.atlas.memory.noMatch') : t('memory.atlas.memory.empty')}
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
              : [selectedNode.group ?? t('memory.atlas.common.global'), selectedNode.label]}
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
  const { t } = useT()
  const statusLabel = (status: KnowledgeArticle['status']): string => ({
    draft: t('memory.atlas.status.draft'),
    published: t('memory.atlas.status.published'),
    archived: t('memory.atlas.status.archived')
  })[status]
  return (
    <div className="atlas-list-wrap">
      <div className="atlas-table atlas-table--knowledge" role="table" aria-label={t('memory.atlas.knowledge.listAria')}>
        <div role="row" className="atlas-table__head">
          <span>{t('memory.atlas.knowledge.titleColumn')}</span><span>{t('memory.atlas.knowledge.topicColumn')}</span><span>{t('memory.atlas.knowledge.statusColumn')}</span><span>{t('memory.atlas.knowledge.tagsColumn')}</span><span>{t('memory.atlas.knowledge.publishedColumn')}</span><span>{t('memory.atlas.knowledge.updatedColumn')}</span><span>{t('memory.atlas.knowledge.favoriteColumn')}</span><span>{t('memory.atlas.knowledge.sourceColumn')}</span>
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
            <span><i className={`atlas-status is-${item.status}`} />{statusLabel(item.status)}</span>
            <span>{item.tags.map((tag) => `#${tag}`).join(' ') || '—'}</span>
            <span>{item.publishedAt?.slice(0, 10) ?? '—'}</span>
            <span>{item.updatedAt.slice(0, 10)}</span>
            <span>{item.favorite ? '★' : '—'}</span>
            <span>{item.sources.length}</span>
          </button>
        ))}
      </div>
      {visible < items.length && <button type="button" className="atlas-more" onClick={onLoadMore}>{t('memory.atlas.knowledge.loadMore')}</button>}
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
  const { t } = useT()
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
        eyebrow={t('memory.atlas.knowledge.eyebrow')}
        title={t('memory.atlas.knowledge.title')}
        description={t('memory.atlas.knowledge.description')}
        count={items.length}
        query={query}
        onQuery={(value) => { setQuery(value); setVisible(100) }}
        mode={mode}
        onMode={setMode}
        primaryAction={{ label: t('memory.atlas.knowledge.newDraft'), onClick: onCreate }}
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
              emptyTitle={query ? t('memory.atlas.knowledge.noMatch') : t('memory.atlas.knowledge.firstKnowledge')}
              emptyHint={query ? t('memory.atlas.knowledge.noMatchHint') : t('memory.atlas.knowledge.firstHint')}
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
              <strong>{query ? t('memory.atlas.knowledge.noArticle') : t('memory.atlas.knowledge.emptyLibrary')}</strong>
              <span>{query ? t('memory.atlas.knowledge.retrySearch') : t('memory.atlas.knowledge.emptyLibraryHint')}</span>
              {!query && <button type="button" className="is-primary" onClick={onCreate}>{t('memory.atlas.knowledge.createFirst')}</button>}
            </div>
          )}
        </div>
        {contextOpen && (
          <AtlasContext
            expanded={expanded}
            breadcrumb={currentArticle
              ? [currentArticle.topic, currentArticle.title, currentArticle.sources.length ? t('memory.atlas.common.sourceCount', { count: currentArticle.sources.length }) : t('memory.atlas.common.pendingSource')]
              : [creating ? t('memory.atlas.common.inbox') : selectedNode?.group ?? t('memory.atlas.common.library'), creating ? t('memory.atlas.common.newDraft') : selectedNode?.label ?? t('memory.atlas.common.edit')]}
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
  const { t } = useT()
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
      {!embedded && <button type="button" onClick={onBack}>{t('memory.atlas.reader.back')}</button>}
      <header>
        <div className="knowledge-article__kicker"><span className={`atlas-status is-${current.status}`} />{current.topic} · {current.status === 'published' ? t('memory.atlas.status.published') : current.status === 'archived' ? t('memory.atlas.status.archived') : t('memory.atlas.status.draft')}</div>
        <h1>{current.title}</h1>
        {current.summary && <p className="knowledge-article__summary">{current.summary}</p>}
        <div className="knowledge-article__tags">{current.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>
        <div className="knowledge-article__actions">
          <button type="button" onClick={() => update(window.agentOs.knowledge.setFavorite(current.id, !current.favorite))}>{current.favorite ? t('memory.atlas.reader.favoriteOn') : t('memory.atlas.reader.favoriteOff')}</button>
          {current.status === 'draft' && <button type="button" className="is-primary" onClick={() => update(window.agentOs.knowledge.publish(current.id))}>{t('memory.atlas.reader.publish')}</button>}
          <button type="button" onClick={() => update(current.status === 'archived' ? window.agentOs.knowledge.restore(current.id) : window.agentOs.knowledge.archive(current.id))}>{current.status === 'archived' ? t('memory.atlas.reader.restore') : t('memory.atlas.reader.archive')}</button>
          <button type="button" onClick={onEdit}>{t('memory.atlas.reader.edit')}</button>
          <button type="button" onClick={() => void window.agentOs.knowledge.openInObsidian(current.id)}>Obsidian</button>
        </div>
        {error && <p className="atlas-error" role="alert">{error}</p>}
      </header>
      <article className="knowledge-article__body"><Markdown content={current.body} /></article>
      <aside className="knowledge-article__sources">
        <h2>{t('memory.atlas.reader.sources')}</h2>
        {current.sources.length
          ? current.sources.map((source) => <div key={`${source.sourceType}:${source.sourceId}`}><strong>{source.toolId ?? source.sourceType}</strong><span>{source.sourceId}</span></div>)
          : <p>{t('memory.atlas.reader.noSources')}</p>}
      </aside>
      <section className="knowledge-article__comments">
        <h2>{t('memory.atlas.reader.comments')}</h2>
        {comments.map((item) => <p key={item.id}>{item.body}</p>)}
        <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={t('memory.atlas.reader.commentPlaceholder')} />
        <button
          type="button"
          onClick={() => void window.agentOs.knowledge.addComment(current.id, { body: comment }).then((next) => { setComments([...comments, next]); setComment('') })}
          disabled={!comment.trim()}
        >{t('memory.atlas.reader.addComment')}</button>
      </section>
      <div className="knowledge-article__danger">
        <button type="button" onClick={() => {
          if (!window.confirm(t('memory.atlas.reader.deleteConfirm'))) return
          void window.agentOs.knowledge.remove(current.id).then(() => { onChanged?.(null); onBack() })
        }}>{t('memory.atlas.reader.deleteForever')}</button>
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
  const { t, lang } = useT()
  const defaultTopic = t('memory.atlas.common.inbox')
  const [draft, setDraft] = useState<KnowledgeArticleInput>({
    id: article?.id,
    title: article?.title ?? '',
    summary: article?.summary ?? '',
    body: article?.body ?? '',
    topic: article?.topic ?? defaultTopic,
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
      topic: article?.topic ?? defaultTopic,
      tags: article?.tags ?? [],
      sources: article?.sources ?? []
    })
    setSourceId(article?.sources[0]?.sourceId ?? '')
  }, [article, lang])

  const source = (): KnowledgeArticleInput => ({
    ...draft,
    sources: sourceId.trim() ? [{ sourceType: 'session', sourceId: sourceId.trim() }] : draft.sources
  })

  const extract = (): void => {
    setError('')
    void window.agentOs.memory.getTranscript(sourceId.trim()).then((transcript) => {
      if (!transcript?.cwd) throw new Error(t('memory.atlas.editor.noCwd'))
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
        <div><p>{t('memory.atlas.editor.kicker')}</p><h1>{article ? t('memory.atlas.editor.editTitle') : t('memory.atlas.editor.newTitle')}</h1></div>
        {onCancel && <button type="button" onClick={onCancel}>{t('memory.atlas.editor.cancel')}</button>}
      </div>
      <label>{t('memory.atlas.editor.title')}<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder={t('memory.atlas.editor.titlePlaceholder')} /></label>
      <label>{t('memory.atlas.editor.summary')}<input value={draft.summary ?? ''} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} placeholder={t('memory.atlas.editor.summaryPlaceholder')} /></label>
      <div className="knowledge-editor__row">
        <label>{t('memory.atlas.editor.topic')}<input value={draft.topic} onChange={(event) => setDraft({ ...draft, topic: event.target.value })} placeholder={t('memory.atlas.editor.topicPlaceholder')} /></label>
        <label>{t('memory.atlas.editor.tags')}<input value={(draft.tags ?? []).join(', ')} onChange={(event) => setDraft({ ...draft, tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder={t('memory.atlas.editor.tagsPlaceholder')} /></label>
      </div>
      <label>{t('memory.atlas.editor.source')}<input value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder={t('memory.atlas.editor.sourcePlaceholder')} /></label>
      <label>{t('memory.atlas.editor.body')}<textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} placeholder={t('memory.atlas.editor.bodyPlaceholder')} /></label>
      <div className="knowledge-editor__actions">
        <button type="button" className="is-primary" onClick={() => void window.agentOs.knowledge.saveDraft(source()).then(onDone).catch((cause: Error) => setError(cause.message))}>{t('memory.atlas.editor.save')}</button>
        <button type="button" onClick={extract} disabled={!sourceId.trim()}>{t('memory.atlas.editor.extract')}</button>
      </div>
      <p className="knowledge-editor__shared-hint">{t('memory.atlas.editor.sharedHint')}</p>
      {error && <p className="atlas-error" role="alert">{error}</p>}
    </section>
  )
}
