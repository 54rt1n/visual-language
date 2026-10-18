import { originalReview, type Workspace } from '../domain/workspace'
import type { LearningEvent } from '../domain/learning'
import { sessionQueue } from '../learning/leitner'
import { effectiveReviewEvents } from './teacherContext'

/** Read-only learner projections. Original assessment text and effective scheduling
 * outcomes stay separate, especially after corrections or historical disputes. */
export function cardReviewHistory(state: Workspace, cardId: string) {
  const card = state.cards.find(c => c.id === cardId && c.learnerId === state.activeLearnerId)
  if (!card) return []
  const effective = new Map(effectiveReviewEvents(state).filter(e => e.cardId === cardId).map(e => [e.exerciseId, e]))
  return state.exercises.filter(e => e.cardId === cardId).map(exercise => {
    const attempts = state.attempts.filter(a => a.exerciseId === exercise.id)
    const event = effective.get(exercise.id), original = event ? originalReview(event, state.events) : undefined
    const corrections = state.events.filter(e => e.exerciseId === exercise.id && e.kind === 'correction')
    const aids = state.events.filter(e => e.exerciseId === exercise.id && e.aid).map(e => e.aid!)
    const latest = Boolean(event && event.after.revision === card.revision)
    const disputed = Boolean(event?.disputed || original?.disputed || corrections.some(e => e.disputed) || attempts.some(a => a.disputed))
    return { exercise, attempts, event, original, corrections, aids, latest, disputed }
  }).reverse().sort((a, b) => b.exercise.presentedAt - a.exercise.presentedAt)
}

export function sessionReflection(state: Workspace, sessionId: string, now: number) {
  const session = state.sessions.find(s => s.id === sessionId)
  if (!session) throw new Error('The saved session is missing.')
  const exercises = new Map(state.exercises.filter(e => e.sessionId === session.id).map(e => [e.id, e]))
  const reviews = effectiveReviewEvents(state).filter(e => e.exerciseId && exercises.has(e.exerciseId))
  const observe = (event: LearningEvent) => {
    const card = state.cards.find(c => c.id === event.cardId)!, item = state.items.find(i => i.id === card.itemId)!
    const original = originalReview(event, state.events), attempt = state.attempts.find(a => a.id === original.attemptId)
    return { eventId: event.id, cardId: card.id, text: item.canonicalText, skill: card.skill, outcome: event.outcome,
      corrected: event.kind === 'correction', disputed: Boolean(event.disputed || original.disputed || attempt?.disputed), aid: original.aid,
      feedback: attempt?.assessment?.feedback, source: event.kind === 'correction' ? 'learner correction' : attempt?.assessmentSource ?? (original.aid ? 'explicit help' : 'saved review') }
  }
  const observations = reviews.map(observe)
  const strengths = observations.filter(o => o.outcome === 'recalled' && !o.disputed)
  const difficulties = observations.filter(o => o.outcome === 'notRecalled' && !o.disputed)
  const unresolved = [...exercises.values()].filter(e => !reviews.some(r => r.exerciseId === e.id) && state.attempts.some(a => a.exerciseId === e.id && a.status !== 'committed')).length
  const scoped = sessionQueue(state.cards, state.items, session, now)
  const pending = session.activeExerciseId && !state.events.some(e => e.exerciseId === session.activeExerciseId)
  const scopedCards = state.cards.filter(c => c.learnerId === session.learnerId && (!session.rootId || state.items.find(i => i.id === c.itemId)!.sourceRootIds.includes(session.rootId)))
  const newCards = scopedCards.filter(c => c.status === 'new')
  let nextStep: string
  if (pending) nextStep = 'Continue your saved question when you’re ready.'
  else if (scoped.remainingDueCount) nextStep = session.status !== 'completed' && scoped.cards.length ? 'Continue with your remaining reviews.' : 'Start another review to finish the reviews still due.'
  else if (difficulties.length) nextStep = 'Practice the words above, or come back for your next review.'
  else if (newCards.length && (scoped.canIntroduce || session.status === 'completed' && session.maxNewItems > 0)) nextStep = 'Choose a new saved word to learn.'
  else if (scopedCards.some(c => c.status === 'active')) nextStep = 'Practice a saved word, or come back for your next review.'
  else if (scoped.outsideScopeCount) nextStep = 'Choose another topic to continue your reviews.'
  else nextStep = 'Create a lesson or save a word from a conversation.'
  const root = state.nodes.find(n => n.id === session.rootId)
  return { goal: session.goal, scope: session.rootId ? root?.type === 'root' ? root.data.name : 'Removed topic' : 'All topics',
    strengths: strengths.slice(0, 5), difficulties: difficulties.slice(0, 5), strengthCount: strengths.length, difficultyCount: difficulties.length,
    disputed: observations.filter(o => o.disputed).length, unresolved, dueInScope: scoped.remainingDueCount, dueOutsideScope: scoped.outsideScopeCount, nextStep }
}
