import { configTypes, type GraphEdge, type GraphNode } from '../domain/graph'
import { uniqueIds } from '../domain/common'

type NodeLike = { id: string; type?: string; data: Record<string, unknown> }
type EdgeLike = { source: string; target: string; data?: Record<string, unknown> }
const conversation = (edge: EdgeLike) => !edge.data?.kind || edge.data.kind === 'conversation'

/** Only the primary conversation relation is ancestry. Legacy edges have no kind. */
export function primaryPath<N extends NodeLike>(triggerId: string, nodes: N[], edges: EdgeLike[], maxDepth = 200): N[] {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const parents = new Map<string, string>()
  for (const edge of edges.filter(conversation)) {
    if (parents.has(edge.target)) throw new Error('A conversation node cannot have two primary parents.')
    parents.set(edge.target, edge.source)
  }
  const path: N[] = [], visited = new Set<string>()
  let id: string | undefined = triggerId
  while (id) {
    if (visited.has(id)) throw new Error('Conversation ancestry contains a cycle.')
    if (path.length >= maxDepth) throw new Error(`Conversation ancestry exceeds ${maxDepth} nodes.`)
    visited.add(id)
    const current = byId.get(id)
    if (!current) throw new Error('Conversation ancestry references a missing node.')
    path.push(current)
    id = parents.get(id)
  }
  return path.reverse()
}

/** Each configuration kind resolves independently, starting on the trigger itself. */
export function effectiveConfiguration(triggerId: string, nodes: GraphNode[], edges: GraphEdge[]) {
  const resolved: Partial<Record<typeof configTypes[number], GraphNode>> = {}
  const byId = new Map(nodes.map(n => [n.id, n]))
  for (const target of primaryPath(triggerId, nodes, edges).reverse()) {
    for (const kind of configTypes) {
      if (resolved[kind]) continue
      const attached = edges.filter(e => e.data.kind === 'context' && e.target === target.id).map(e => byId.get(e.source)).filter(n => n?.type === kind)
      if (attached.length > 1) throw new Error(`Ambiguous ${kind} attachments on ${target.id}.`)
      if (attached[0]) resolved[kind] = attached[0]
    }
  }
  return resolved
}

export function validateGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  const nodeIds = uniqueIds(nodes, 'node'), roots = new Set(nodes.filter(n => n.type === 'root').map(n => n.id))
  uniqueIds(edges, 'edge')
  if (!roots.size) throw new Error('A workspace requires at least one topic root.')
  const byId = new Map(nodes.map(n => [n.id, n])), primaryParents = new Set<string>(), configurations = new Set<string>()
  for (const node of nodes) {
    if (!roots.has(node.rootId) || (node.type === 'root' && node.rootId !== node.id)) throw new Error('Invalid graph root ownership.')
  }
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) throw new Error('Graph edge references a missing node.')
    const source = byId.get(edge.source)!, target = byId.get(edge.target)!
    if (source.rootId !== target.rootId) throw new Error('Graph relationships must remain within their topic root.')
    if (edge.data.kind === 'conversation') {
      if (!['root', 'user', 'assistant'].includes(source.type) || !['user', 'assistant'].includes(target.type)) throw new Error('Conversation edges connect only primary conversation nodes.')
      if (primaryParents.has(target.id)) throw new Error('A conversation node cannot have two primary parents.')
      primaryParents.add(target.id)
    } else if (edge.data.kind === 'context') {
      if (!(configTypes as readonly string[]).includes(source.type) || !['root', 'user', 'assistant'].includes(target.type)) throw new Error('Context edges attach configuration to conversation nodes.')
      const identity = `${target.id}\u0000${source.type}`
      if (configurations.has(identity)) throw new Error('A node cannot have conflicting attachments of one configuration kind.')
      configurations.add(identity)
    } else if (!['chunk', 'exercise', 'lesson', 'explanation'].includes(target.type)) throw new Error('Derived relationships target learning material or explanations.')
    outgoing.set(source.id, [...(outgoing.get(source.id) ?? []), target.id])
  }
  for (const node of nodes) if (['user', 'assistant'].includes(node.type) && !primaryParents.has(node.id)) throw new Error('Conversation nodes require a primary parent.')
  for (const node of nodes) if (node.type === 'explanation') {
    const incoming = edges.filter(edge => edge.target === node.id)
    if (byId.get(node.data.wordNodeId)?.type !== 'chunk' || incoming.length !== 1 || incoming[0]?.source !== node.data.wordNodeId || incoming[0].data.kind !== 'derived') throw new Error('An explanation must belong to its learning word node.')
  }
  // Iterative Kahn traversal avoids stack overflow on untrusted deep graphs.
  const indegree = new Map(nodes.map(n => [n.id, 0]))
  for (const edge of edges) indegree.set(edge.target, indegree.get(edge.target)! + 1)
  const queue = nodes.filter(n => indegree.get(n.id) === 0).map(n => n.id)
  for (let i = 0; i < queue.length; i++) for (const target of outgoing.get(queue[i]!) ?? []) {
    indegree.set(target, indegree.get(target)! - 1)
    if (indegree.get(target) === 0) queue.push(target)
  }
  if (queue.length !== nodes.length) throw new Error('Graph relationships contain a cycle.')
}
