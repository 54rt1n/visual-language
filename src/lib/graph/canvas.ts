import type { Edge, Node } from '@xyflow/svelte'
import { graphNodeSchema } from '../domain/graph'
import type { Workspace } from '../domain/workspace'
import { primaryPath, validateGraph } from './contracts'
import { hiddenNodes } from './graphService'

export type CanvasNode = Node<Record<string, unknown>>
export function canvasGraph(state: Workspace): { nodes: CanvasNode[]; edges: Edge[] } {
  const hidden = hiddenNodes(state)
  return {
    nodes: state.nodes.map(node => ({ id: node.id, type: ['root', 'user', 'assistant', 'chunk', 'exercise', 'lesson', 'explanation'].includes(node.type) ? node.type : 'generic', position: { ...node.position },
      data: { ...node.data, domainType: node.type, ...(['assistant', 'explanation'].includes(node.type) ? { streaming: false } : {}) },
      selected: state.view.selectedNodeIds.includes(node.id), hidden: hidden.has(node.id),
    })),
    edges: state.edges.map(edge => ({ ...edge, data: { ...edge.data }, hidden: hidden.has(edge.source) || hidden.has(edge.target),
      style: edge.data.kind === 'context' ? 'stroke: #b39af3; stroke-dasharray: 7 4' : edge.data.kind === 'derived' ? 'stroke: #e9c46a; stroke-dasharray: 2 4' : 'stroke: #7aa2f7',
    })),
  }
}
export function updateGraphFromCanvas(state: Workspace, nodes: CanvasNode[], edges: Edge[], composerDraft: string, viewport: Workspace['view']['viewport']) {
  const previous = new Map(state.nodes.map(n => [n.id, n]))
  state.nodes = nodes.map(node => {
    const saved = previous.get(node.id)
    if (saved && !['root', 'user', 'assistant', 'explanation'].includes(node.type ?? '')) return { ...saved, position: { ...node.position } }
    const rootId = saved?.rootId ?? primaryPath(node.id, nodes, edges)[0]!.id
    const base = { id: node.id, rootId, type: node.type, position: node.position, bookmarked: saved?.bookmarked ?? false, collapsed: saved?.collapsed ?? false }
    const string = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
    let data: unknown
    if (node.type === 'root') data = { name: string(node.data.name, 'Conversation') }
    else if (node.type === 'user') data = { text: string(node.data.text) }
    else if (node.type === 'assistant' || node.type === 'explanation') data = {
      text: string(node.data.text), reasoning: string(node.data.reasoning), state: node.data.streaming ? 'interrupted' : string(node.data.state, node.data.error ? 'error' : 'complete'),
      error: string(node.data.error), provider: string(node.data.provider, 'legacy'), model: string(node.data.model, 'unknown'),
      ...(node.type === 'explanation' ? { wordNodeId: string(node.data.wordNodeId) } : {}),
      ...(saved?.type === 'assistant' && saved.data.editedAt !== undefined ? { editedAt: saved.data.editedAt } : {}),
      ...(saved?.type === 'assistant' && saved.data.regeneratedFrom ? { regeneratedFrom: saved.data.regeneratedFrom } : typeof node.data.regeneratedFrom === 'string' ? { regeneratedFrom: node.data.regeneratedFrom } : {}),
    }
    else throw new Error('The canvas contains an unsupported node type.')
    return graphNodeSchema.parse({ ...base, data })
  })
  state.edges = edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, data: { kind: edge.data?.kind as Workspace['edges'][number]['data']['kind'] ?? 'conversation' } }))
  state.view = { ...state.view, selectedNodeIds: nodes.filter(n => n.selected).map(n => n.id), composerDraft, viewport }
  const selected = state.nodes.find(n => n.id === state.view.selectedNodeIds[0])
  if (selected) state.view.activeRootId = selected.rootId
  validateGraph(state.nodes, state.edges)
}
