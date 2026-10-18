import { nid } from '../id'
import { configTypes, graphNodeSchema, type GraphNode } from '../domain/graph'
import type { Workspace } from '../domain/workspace'
import { realClock, type Clock } from '../learning/leitner'
import type { WorkspaceRepository, WorkspaceSnapshot } from '../storage/repository'
import { effectiveConfiguration } from './contracts'
import { readingSelection } from '../mandarin/reading'
import { isReadingNode } from '../mandarin/captureSource'
import { readingConcealed } from '../mandarin/readingHistory'

export type ConfigKind = typeof configTypes[number]
export const configLabels: Record<ConfigKind, string> = { modelConfig: 'Model', systemConfig: 'System instruction', vocabularyConfig: 'Vocabulary', learningConfig: 'Learning' }
export const isConversation = (node: GraphNode) => ['root', 'user', 'assistant'].includes(node.type)
function requireNode(state: Workspace, id: string) { const node = state.nodes.find(n => n.id === id); if (!node) throw new Error('This graph node is no longer available.'); return node }

/** Derived/context links help locate their conversation, but never become chat ancestry. */
export function conversationAnchor(state: Workspace, nodeId: string): GraphNode | undefined {
  const byId = new Map(state.nodes.map(n => [n.id, n])), seen = new Set<string>(), queue = [nodeId]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    if (seen.has(id)) continue
    seen.add(id)
    const node = byId.get(id)
    if (!node) continue
    if (isConversation(node)) return node
    queue.push(...state.edges.filter(e => e.data.kind === 'derived' && e.target === id).map(e => e.source))
    queue.push(...state.edges.filter(e => e.data.kind === 'context' && e.source === id).map(e => e.target))
  }
  const node = byId.get(nodeId)
  return node ? byId.get(node.rootId) : undefined
}
export function learningPreferences(state: Workspace, nodeId?: string, learnerId = state.activeLearnerId) {
  const learner = state.learners.find(l => l.id === learnerId)!, anchor = nodeId ? conversationAnchor(state, nodeId) : undefined
  const config = anchor ? effectiveConfiguration(anchor.id, state.nodes, state.edges).learningConfig : undefined
  return config?.type === 'learningConfig' ? { ...learner, ...config.data } : learner
}
export function learningPreferencesForCard(state: Workspace, cardId?: string) {
  const card = state.cards.find(c => c.id === cardId), item = state.items.find(i => i.id === card?.itemId)
  const sourceId = item?.sourceNodeIds.find(id => state.nodes.some(n => n.id === id)) ?? item?.sourceRootIds.find(id => state.nodes.some(n => n.id === id))
  return learningPreferences(state, sourceId, card?.learnerId)
}

function descendants(state: Workspace, nodeId: string, includeSelf = true): Set<string> {
  const node = requireNode(state, nodeId)
  if (node.type === 'root') return new Set(state.nodes.filter(n => n.rootId === nodeId && (includeSelf || n.id !== nodeId)).map(n => n.id))
  const outgoing = new Map<string, string[]>()
  for (const edge of state.edges) if (edge.data.kind !== 'context') outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge.target])
  const result = new Set<string>(), queue = includeSelf ? [nodeId] : [...outgoing.get(nodeId) ?? []]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    if (result.has(id)) continue
    result.add(id); queue.push(...outgoing.get(id) ?? [])
  }
  return result
}
export function hiddenNodes(state: Workspace): Set<string> {
  const hidden = new Set(state.nodes.filter(n => n.rootId !== state.view.activeRootId).map(n => n.id))
  const lessonSessions = new Set(state.sessions.filter(s => s.lessonAttempt).map(s => s.id))
  const lessonExercises = new Set(state.exercises.filter(e => lessonSessions.has(e.sessionId)).map(e => e.id))
  for (const node of state.nodes) if (node.type === 'exercise' && lessonExercises.has(node.data.exerciseId)) hidden.add(node.id)
  for (const node of state.nodes.filter(n => n.collapsed)) descendants(state, node.id, false).forEach(id => hidden.add(id))
  for (const node of state.nodes.filter(n => (configTypes as readonly string[]).includes(n.type))) {
    const targets = state.edges.filter(e => e.data.kind === 'context' && e.source === node.id).map(e => e.target)
    if (targets.length && targets.every(id => hidden.has(id))) hidden.add(node.id)
  }
  return hidden
}
/** Deliberate deletion follows conversation/derived children, never outgoing configuration links. */
export function deletionScope(state: Workspace, nodeId: string) {
  const removed = descendants(state, nodeId)
  for (const node of state.nodes.filter(n => (configTypes as readonly string[]).includes(n.type))) {
    const targets = state.edges.filter(e => e.data.kind === 'context' && e.source === node.id).map(e => e.target)
    if (targets.length && targets.every(id => removed.has(id))) removed.add(node.id)
  }
  const edges = state.edges.filter(e => removed.has(e.source) || removed.has(e.target))
  return { nodeIds: [...removed].sort(), edgeIds: edges.map(e => e.id).sort(), learningItems: state.items.filter(i => i.sourceNodeIds.some(id => removed.has(id))).length }
}
function expandAncestors(state: Workspace, nodeId: string) {
  const node = requireNode(state, nodeId), seen = new Set<string>(), queue = [nodeId, node.rootId]
  // A config is positioned alongside its targets; reveal their ancestry as well.
  if ((configTypes as readonly string[]).includes(node.type)) queue.push(...state.edges.filter(e => e.data.kind === 'context' && e.source === nodeId).map(e => e.target))
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!
    if (seen.has(id)) continue
    seen.add(id)
    const current = state.nodes.find(n => n.id === id)
    if (current) current.collapsed = false
    queue.push(...state.edges.filter(e => e.data.kind !== 'context' && e.target === id).map(e => e.source))
  }
}
function removeRecords(state: Workspace, nodeIds: string[], edgeIds: string[], operationId: string, at: number) {
  state.nodes = state.nodes.filter(n => !nodeIds.includes(n.id)); state.edges = state.edges.filter(e => !edgeIds.includes(e.id))
  for (const [entityType, ids] of [['node', nodeIds], ['edge', edgeIds]] as const) for (const entityId of ids) state.tombstones.push({ id: nid('tombstone'), entityType, entityId, operationId, deletedAt: at })
  state.view.selectedNodeIds = state.view.selectedNodeIds.filter(id => !nodeIds.includes(id))
}

export class GraphService {
  constructor(readonly repository: WorkspaceRepository, readonly clock: Clock = realClock) {}
  private change(snapshot: WorkspaceSnapshot, kind: string, intent: unknown, change: (state: Workspace, operationId: string, at: number) => void, operationId = nid('op')) {
    const at = this.clock.now()
    return this.repository.mutate(snapshot.version, { id: operationId, kind, intent, at }, state => change(state, operationId, at))
  }
  createTopic(snapshot: WorkspaceSnapshot, name = `Topic ${snapshot.state.nodes.filter(n => n.type === 'root').length + 1}`) {
    return this.change(snapshot, 'create-topic', { name }, state => {
      const id = nid('root'), x = Math.max(...state.nodes.filter(n => n.type === 'root').map(n => n.position.x)) + 650
      state.nodes.push(graphNodeSchema.parse({ id, rootId: id, type: 'root', position: { x, y: 0 }, data: { name: name.trim() }, bookmarked: false, collapsed: false }))
      state.view.activeRootId = id; state.view.selectedNodeIds = [id]
    })
  }
  addLearningWord(snapshot: WorkspaceSnapshot, sourceId: string, sourceText: string, start: number, end: number, pinyin: string, position: { x: number; y: number }) {
    return this.change(snapshot, 'add-learning-word', { sourceId, start, end, pinyin, position }, state => {
      if (readingConcealed(state)) throw new Error('Finish the review or reveal help before adding source material.')
      const source = requireNode(state, sourceId)
      if (!isReadingNode(source) || source.data.text !== sourceText) throw new Error('The response changed. Select the word again.')
      const selection = readingSelection(sourceText, start, end)
      const existing = state.nodes.find(node => node.type === 'chunk' && node.data.wordSource?.nodeId === sourceId && node.data.wordSource.start === start && node.data.wordSource.end === end && node.data.wordSource.context === selection.context && node.data.text === selection.text)
      const id = existing?.id ?? nid('word')
      if (!existing) {
        state.nodes.push(graphNodeSchema.parse({ id, rootId: source.rootId, type: 'chunk', position, bookmarked: false, collapsed: false,
          data: { text: selection.text, pinyin, meaning: '', wordSource: { nodeId: sourceId, start, end, contextStart: selection.contextStart, context: selection.context } } }))
        state.edges.push({ id: nid('edge'), source: sourceId, target: id, data: { kind: 'derived' } })
      }
      expandAncestors(state, id)
      state.view.activeRootId = source.rootId; state.view.selectedNodeIds = [id]
    })
  }
  addWordExplanation(snapshot: WorkspaceSnapshot, wordNodeId: string, position: { x: number; y: number }, provider: string, model: string) {
    return this.change(snapshot, 'start-word-explanation', { wordNodeId, position, provider, model }, state => {
      if (readingConcealed(state)) throw new Error('Finish the review or reveal help before requesting an explanation.')
      const word = requireNode(state, wordNodeId)
      if (word.type !== 'chunk') throw new Error('Choose a learning word to explain.')
      const id = nid('explanation')
      state.nodes.push(graphNodeSchema.parse({ id, rootId: word.rootId, type: 'explanation', position, bookmarked: false, collapsed: false,
        data: { wordNodeId, text: '', reasoning: '', state: 'interrupted', error: '', provider, model } }))
      state.edges.push({ id: nid('edge'), source: wordNodeId, target: id, data: { kind: 'derived' } })
      expandAncestors(state, id)
      state.view.activeRootId = word.rootId; state.view.selectedNodeIds = [id]
    })
  }
  editText(snapshot: WorkspaceSnapshot, nodeId: string, text: string) {
    return this.change(snapshot, 'edit-graph-text', { nodeId, text }, (state, _op, at) => {
      const node = requireNode(state, nodeId)
      if (node.type === 'root') node.data.name = text.trim()
      else if (node.type === 'user' || node.type === 'assistant') {
        if (!text.trim()) throw new Error('A message cannot be empty.')
        // Frozen cards, citations, questions and results are independent of this editable text.
        node.data.text = text
        if (node.type === 'assistant') node.data.editedAt = at
      } else throw new Error('Edit this record through its learning or branch settings controls.')
    })
  }
  setFlag(snapshot: WorkspaceSnapshot, nodeId: string, flag: 'bookmarked' | 'collapsed', value: boolean) {
    return this.change(snapshot, 'graph-display-flag', { nodeId, flag, value }, state => { requireNode(state, nodeId)[flag] = value })
  }
  reveal(snapshot: WorkspaceSnapshot, nodeId: string) {
    return this.change(snapshot, 'reveal-graph-node', { nodeId }, state => {
      const node = requireNode(state, nodeId); expandAncestors(state, nodeId)
      state.view.activeRootId = node.rootId; state.view.selectedNodeIds = [nodeId]
      state.view.viewport = { ...state.view.viewport } // Centering is applied by the canvas, not guessed here.
    })
  }
  setConfiguration(snapshot: WorkspaceSnapshot, targetId: string, type: ConfigKind, data: unknown) {
    return this.change(snapshot, 'set-branch-configuration', { targetId, type, data }, (state, op, at) => {
      const target = requireNode(state, targetId)
      if (!isConversation(target)) throw new Error('Attach settings to a conversation node.')
      const oldEdge = state.edges.find(e => e.data.kind === 'context' && e.target === targetId && state.nodes.find(n => n.id === e.source)?.type === type)
      const old = oldEdge ? requireNode(state, oldEdge.source) : undefined
      const shared = old && state.edges.filter(e => e.data.kind === 'context' && e.source === old.id).length > 1
      const id = old && !shared ? old.id : nid('config')
      const config = graphNodeSchema.parse({ id, rootId: target.rootId, type, data, position: old?.position ?? { x: target.position.x - 330, y: target.position.y + configTypes.indexOf(type) * 180 }, bookmarked: old?.bookmarked ?? false, collapsed: false })
      if (old && !shared) state.nodes[state.nodes.findIndex(n => n.id === old.id)] = config
      else {
        state.nodes.push(config)
        if (oldEdge) removeRecords(state, [], [oldEdge.id], op, at)
        state.edges.push({ id: nid('edge'), source: id, target: targetId, data: { kind: 'context' } })
      }
    })
  }
  removeConfiguration(snapshot: WorkspaceSnapshot, targetId: string, type: ConfigKind) {
    return this.change(snapshot, 'remove-branch-override', { targetId, type }, (state, op, at) => {
      const edge = state.edges.find(e => e.data.kind === 'context' && e.target === targetId && state.nodes.find(n => n.id === e.source)?.type === type)
      if (!edge) return
      const shared = state.edges.some(e => e.id !== edge.id && e.source === edge.source)
      removeRecords(state, shared ? [] : [edge.source], [edge.id], op, at)
    })
  }
  deleteSubtree(snapshot: WorkspaceSnapshot, nodeId: string, expectedNodeIds: string[]) {
    return this.change(snapshot, 'delete-graph-subtree', { nodeId, expectedNodeIds }, (state, op, at) => {
      const scope = deletionScope(state, nodeId)
      if (JSON.stringify(scope.nodeIds) !== JSON.stringify([...expectedNodeIds].sort())) throw new Error('The deletion scope changed. Review a fresh preview before deleting.')
      if (!state.nodes.some(n => n.type === 'root' && !scope.nodeIds.includes(n.id))) throw new Error('Keep at least one topic. Create another topic before deleting the last root.')
      const parentId = state.edges.find(e => e.target === nodeId && e.data.kind === 'conversation')?.source
      removeRecords(state, scope.nodeIds, scope.edgeIds, op, at)
      if (!state.nodes.some(n => n.id === state.view.activeRootId)) state.view.activeRootId = state.nodes.find(n => n.type === 'root')!.id
      if (!state.view.selectedNodeIds.length) state.view.selectedNodeIds = [parentId && state.nodes.some(n => n.id === parentId) ? parentId : state.view.activeRootId]
      // Intentionally retain items/cards, frozen sources, exercises, attempts, events and sessions.
    })
  }
}
