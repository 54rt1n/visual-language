import { originalReview, type Workspace } from '../domain/workspace'

/** One preview rule for UI and transactional correction. Never invalidate a later
 * unresolved question by changing the card version underneath its frozen rubric. */
export function correctionImpact(state: Workspace, eventId: string) {
  const event = state.events.find(e => e.id === eventId && (e.kind === 'review' || e.kind === 'correction'))
  if (!event) throw new Error('Choose a saved review result to correct.')
  const card = state.cards.find(c => c.id === event.cardId)!
  const original = originalReview(event, state.events)
  const historical = event.after.revision !== card.revision || state.events.some(e => e.supersedesEventId === event.id)
  const pending = state.exercises.find(e => e.cardId === card.id && e.id !== original.exerciseId && state.sessions.some(s => s.activeExerciseId === e.id && s.status !== 'completed') && !state.events.some(result => result.exerciseId === e.id && (result.kind === 'review' || result.kind === 'practice')))
  return { card, original, historical, canRecall: !original.aid, blocked: !historical && Boolean(pending) }
}
