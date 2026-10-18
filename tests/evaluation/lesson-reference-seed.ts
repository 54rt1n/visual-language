import type { Workspace } from '../../src/lib/domain/workspace'
import { teacherContext } from '../../src/lib/teacher/teacherContext'
import { sameRecord } from '../../src/lib/domain/common'

/** Saved evidence keeps its original provenance; fresh evaluation roots are incidental. */
export function restoreLessonSources(current: Workspace['sources'], saved: Workspace['sources'], freshRootId: string): Workspace['sources'] {
  const merged = structuredClone(current)
  for (const source of saved) {
    const index = merged.findIndex(existing => existing.id === source.id)
    if (index < 0) { merged.push(structuredClone(source)); continue }
    const existing = merged[index]!
    const rootAnchorOnly = source.kind === 'local' && existing.kind === 'local'
      && /^evaluation-card-source-[1-9]\d*$/.test(source.id)
      && source.cardId === existing.cardId && Boolean(source.cardId)
      && existing.nodeId === freshRootId && source.nodeId?.startsWith('root-')
      && sameRecord({ ...existing, nodeId: source.nodeId }, source)
    if (!sameRecord(existing, source) && !rootAnchorOnly) throw new Error('Resume source conflicts with seeded evidence.')
    merged[index] = structuredClone(source)
  }
  return merged
}

/** Evaluation-only setup, before any session, interaction or inference exists. */
export function seedLessonReferences(state: Workspace, now: number) {
  if (state.sessions.length || state.exercises.length || state.attempts.length || state.events.length) {
    throw new Error('Stable evaluation references require a fresh, unexercised workspace.')
  }
  const references = new Map(state.cards.map((card, index) => [card.id, `evaluation-card-${index + 1}`]))
  const mapped = (id: string) => references.get(id) ?? id
  const sourceReferences = new Map(state.sources.filter(source => source.kind === 'local')
    .map((source, index) => [source.id, `evaluation-capture-source-${index + 1}`]))
  for (const card of state.cards) card.id = mapped(card.id)
  for (const draft of state.drafts) {
    draft.cardIds = draft.cardIds.map(mapped)
    draft.sourceIds = draft.sourceIds.map(id => sourceReferences.get(id) ?? id)
    for (const capture of draft.discovery?.captures ?? []) capture.cardIds = capture.cardIds.map(mapped)
  }
  for (const source of state.sources) {
    source.id = sourceReferences.get(source.id) ?? source.id
    if (source.cardId) source.cardId = mapped(source.cardId)
  }
  // Persist exactly the source summary that production teacherContext will reuse.
  // Do not replace UUID generation globally or change production ID policy.
  for (const [index, card] of state.cards.entries()) {
    const local = teacherContext(state, card.id, now).sources.find(source => source.kind === 'local' && source.cardId === card.id)!
    state.sources = state.sources.filter(source => source.id !== local.id)
    state.sources.push({ ...local, id: `evaluation-card-source-${index + 1}` })
  }
}
