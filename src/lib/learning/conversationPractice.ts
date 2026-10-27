import type { Workspace } from '../domain/workspace'
import type { Skill } from '../domain/learning'
import { conversationAnchor } from '../graph/graphService'
import { primaryPath } from '../graph/contracts'
import { containsHanzi } from '../mandarin/chineseParser'

export function lessonConversation(state: Workspace, nodeId: string, startNodeId?: string) {
  const anchor = state.nodes.find(node => node.id === nodeId)
  if (anchor?.type !== 'assistant' || anchor.data.state !== 'complete' || !containsHanzi(anchor.data.text)) throw new Error('Choose a completed Mandarin response for your lesson.')
  const path = primaryPath(nodeId, state.nodes, state.edges), root = path.find(node => node.type === 'root')!
  const messages = path.filter(node => node.type === 'user' || node.type === 'assistant').map(node => ({ nodeId: node.id, role: node.type as 'user' | 'assistant', text: 'text' in node.data ? node.data.text : '' }))
  const start = startNodeId ? messages.findIndex(message => message.nodeId === startNodeId) : 0
  if (start < 0) throw new Error('Choose a starting message from this conversation.')
  return { anchorId: nodeId, rootId: root.id, title: root.type === 'root' ? root.data.name : 'Conversation', messages: messages.slice(start) }
}

export const skillLabels: Record<Skill, string> = { production: 'Write in Mandarin', recognition: 'Choose the answer', meaning: 'Explain the meaning' }

/** Select only ancestors of this branch, never sibling conversations in the topic. */
export function conversationSelection(state: Workspace, nodeId: string, sourceDraftId?: string) {
  const discovered = state.drafts.find(d => d.kind === 'discovery' && d.status === 'validated' && d.discovery?.nodeId === nodeId
    && (sourceDraftId ? d.id === sourceDraftId : !d.discoveryRequest?.origin))
  if (sourceDraftId && !discovered) throw new Error('Choose the reviewed material for this lesson.')
  if (discovered?.discoveryRequest?.origin && discovered.discoveryRequest.origin.learnerId !== state.activeLearnerId) throw new Error('This lesson request belongs to another learner.')
  if (discovered?.discovery) {
    const material = discovered.discovery
    const items = state.items.filter(i => material.captures.some(c => c.itemId === i.id))
    const cards = state.cards.filter(c => c.learnerId === state.activeLearnerId && c.status !== 'suspended' && items.some(i => i.id === c.itemId))
    return { anchorId: nodeId, title: material.title, context: material.explanation,
      kind: discovered.discoveryRequest!.kind === 'roleplay' ? 'scenario' as const : discovered.discoveryRequest!.kind === 'interest' ? 'reading' as const : 'topic' as const,
      source: { draftId: discovered.id, ...(discovered.discoveryPlanning?.accepted ? { scope: discovered.discoveryPlanning.accepted } : {}), passageHanzi: material.passageHanzi, passageMeaning: material.passageMeaning, scenario: material.roleplay },
      items: items.filter(i => cards.some(c => c.itemId === i.id)), cards }
  }
  const anchor = conversationAnchor(state, nodeId)
  if (!anchor) return { kind: 'topic' as const, source: undefined, anchorId: nodeId, title: 'Conversation', context: '', items: [], cards: [] }
  const path = primaryPath(anchor.id, state.nodes, state.edges), ids = new Set(path.map(n => n.id))
  // Traverse derived material once; avoid walking the whole graph for every saved item.
  const children = new Map<string, string[]>()
  for (const edge of state.edges) if (edge.data.kind === 'derived') children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target])
  const related = [...ids]
  for (let i = 0; i < related.length; i++) for (const id of children.get(related[i]!) ?? []) if (!ids.has(id)) { ids.add(id); related.push(id) }
  const items = state.items.filter(item => item.sourceNodeIds.some(id => ids.has(id)))
  const cards = state.cards.filter(c => c.learnerId === state.activeLearnerId && c.status !== 'suspended' && items.some(i => i.id === c.itemId))
  const root = path.find(n => n.type === 'root')
  return { kind: 'topic' as const, source: undefined, anchorId: anchor.id, title: root?.type === 'root' ? root.data.name : 'Conversation',
    context: path.filter(n => n.type === 'user' || n.type === 'assistant').map(n => `${n.type === 'user' ? 'You' : 'Zheng'}: ${'text' in n.data ? n.data.text : ''}`).join('\n').slice(-8000),
    items: items.filter(i => cards.some(c => c.itemId === i.id)), cards }
}
