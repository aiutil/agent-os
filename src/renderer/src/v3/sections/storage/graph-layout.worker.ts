import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum
} from 'd3-force'

interface NodeInput { id: string; weight: number; type?: string }
interface EdgeInput { source: string; target: string }
interface ShapePoint { x: number; y: number }
interface ForceNode extends SimulationNodeDatum, NodeInput { targetX: number; targetY: number }

function halton(index: number, base: number): number {
  let result = 0
  let fraction = 1 / base
  let value = index
  while (value > 0) {
    result += fraction * (value % base)
    value = Math.floor(value / base)
    fraction /= base
  }
  return result
}

function circlePoints(count: number): ShapePoint[] {
  const frameCount = Math.min(count, Math.max(10, Math.floor(count * .24)))
  const result: ShapePoint[] = []
  for (let index = 0; index < frameCount; index += 1) {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / frameCount
    result.push({ x: Math.cos(angle) * .94, y: Math.sin(angle) * .94 })
  }
  for (let candidate = 1; result.length < count && candidate < 20_000; candidate += 1) {
    const x = halton(candidate, 2) * 2 - 1
    const y = halton(candidate, 3) * 2 - 1
    if (x * x + y * y <= .82) result.push({ x, y })
  }
  return result
}

self.onmessage = (event: MessageEvent<{
  nodes: NodeInput[]
  edges: EdgeInput[]
  width: number
  height: number
}>) => {
  const { nodes, edges, width, height } = event.data
  const dense = nodes.length >= 60
  const centerX = width / 2
  const centerY = height / 2
  const radius = Math.max(120, Math.min(width, height) * .4)
  const targets = circlePoints(nodes.length)
  const layout: ForceNode[] = nodes.map((node, index) => {
    const point = targets[index] ?? { x: 0, y: 0 }
    const targetX = centerX + point.x * radius
    const targetY = centerY + point.y * radius
    return { ...node, targetX, targetY, x: targetX, y: targetY }
  })

  const simulation = forceSimulation<ForceNode>(layout)
    .force('charge', forceManyBody<ForceNode>().strength((node) => {
      const hub = node.type === 'persona' || node.type === 'scope' || node.type === 'topic'
      if (dense) return hub ? -28 : -12
      return hub ? -52 : -34
    }))
    .force('link', forceLink<ForceNode, EdgeInput>(edges)
      .id((node) => node.id)
      .distance(dense ? 24 : 48)
      .strength(dense ? .38 : .3))
    .force('collide', forceCollide<ForceNode>().radius((node) => dense
      ? Math.max(4, Math.min(10, 3 + node.weight * .75))
      : Math.max(8, Math.min(16, 6 + node.weight * 1.25))))
    .force('center', forceCenter(centerX, centerY).strength(.025))
    .force('shape-x', forceX<ForceNode>((node) => node.targetX).strength(dense ? .3 : .34))
    .force('shape-y', forceY<ForceNode>((node) => node.targetY).strength(dense ? .3 : .34))
    .velocityDecay(dense ? .5 : .46)
    .stop()

  simulation.tick(dense ? 380 : 300)
  self.postMessage(layout.map((node) => ({ id: node.id, x: node.x ?? 0, y: node.y ?? 0 })))
}
