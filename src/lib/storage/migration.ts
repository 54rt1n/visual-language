import { z } from 'zod'
import { primaryPath } from '../graph/contracts'
import { createWorkspace, validateWorkspace, type Workspace } from '../domain/workspace'
import { graphNodeSchema, type GraphNode } from '../domain/graph'
import { identifier } from '../domain/common'
import { loadSettings, publicProviderPreferences } from '../settings'
import { MAX_BACKUP_BYTES } from './backup'

export const LEGACY_GRAPH_KEY = 'vl-graph-v1'
const legacyGraph = z.object({
  nodes: z.array(z.object({ id: identifier, type: z.enum(['root', 'user', 'assistant']),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }), data: z.record(z.string(), z.unknown()),
    selected: z.boolean().optional(), bookmarked: z.boolean().optional(), collapsed: z.boolean().optional(),
  })).min(1).max(12_000),
  edges: z.array(z.object({ id: identifier, source: identifier, target: identifier, data: z.object({ kind: z.literal('conversation') }).optional() })).max(30_000),
})
/** Current three-node prototype migration. Original-project imports are a separate adapter.
 * Does not remove or write localStorage, even after the caller verifies IndexedDB read-back.
 */
export function migrateLegacyGraph(raw: string, now = Date.now()): Workspace {
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES) throw new Error('The legacy graph is too large for automatic migration. Its original record was retained.')
  const legacy = legacyGraph.parse(JSON.parse(raw)), state = createWorkspace(now)
  const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
  state.edges = legacy.edges.map(e => ({ id: e.id, source: e.source, target: e.target, data: { kind: 'conversation' } }))
  state.nodes = legacy.nodes.map(n => {
    const root = primaryPath(n.id, legacy.nodes, state.edges)[0]!
    if (root.type !== 'root') throw new Error('Legacy messages lack a topic root. The source data was retained.')
    let data: GraphNode['data']
    if (n.type === 'root') data = { name: text(n.data.name, 'Conversation') }
    else if (n.type === 'user') data = { text: text(n.data.text, text(n.data.content)) }
    else data = { text: text(n.data.text, text(n.data.content)), reasoning: text(n.data.reasoning), state: n.data.streaming ? 'interrupted' : n.data.error ? 'error' : 'complete',
      error: text(n.data.error), provider: text(n.data.provider, 'legacy'), model: text(n.data.model, 'unknown') }
    return graphNodeSchema.parse({ id: n.id, rootId: root.id, type: n.type, position: n.position, data, bookmarked: n.bookmarked ?? false, collapsed: n.collapsed ?? false })
  })
  const selected = legacy.nodes.filter(n => n.selected).map(n => n.id)
  state.view.selectedNodeIds = selected
  state.view.activeRootId = state.nodes.find(n => n.id === selected[0])?.rootId ?? state.nodes.find(n => n.type === 'root')!.id
  return validateWorkspace(state)
}
export function initialWorkspaceFromStorage(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage, now = Date.now()) {
  const raw = storage.getItem(LEGACY_GRAPH_KEY)
  const state = raw === null ? createWorkspace(now) : migrateLegacyGraph(raw, now)
  state.preferences = publicProviderPreferences(loadSettings(storage)) as Workspace['preferences']
  return validateWorkspace(state)
}
