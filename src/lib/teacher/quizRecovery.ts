import type { SavedDraft, Workspace } from '../domain/workspace'
import { quizTargetSchema, type QuizTarget } from './contracts'
import { teacherContext } from './teacherContext'

export function frozenQuizTarget(context: ReturnType<typeof teacherContext>): QuizTarget {
  const { card, item, learner } = context
  return quizTargetSchema.parse({ cardId: card.id, skill: card.skill, hanzi: item.canonicalText, pinyin: item.pinyin ?? '', sense: item.senseKey, meaning: item.meaning,
    level: learner.level, explanationLanguage: learner.explanationLanguage, languageBalance: learner.languageBalance })
}
export function savedQuizTargets(state: Workspace, draft: SavedDraft, now: number) {
  return draft.quizTargets ?? draft.cardIds.map(id => frozenQuizTarget(teacherContext(state, id, now, draft.sourceLessonId)))
}
export function unusedQuiz(state: Workspace, id: string) { return !state.exercises.some(e => e.multipleChoice?.quizId === id) }
export function quizForLearner(state: Workspace, id: string) {
  const draft = state.drafts.find(d => d.id === id && d.kind === 'quiz')
  if (!draft?.quiz || !draft.generation || !draft.cardIds.length || draft.cardIds.some(id => state.cards.find(c => c.id === id)?.learnerId !== state.activeLearnerId)) throw new Error('Choose a saved quiz for the current learner.')
  if (draft.discardedAt !== undefined) throw new Error('This quiz candidate was discarded. Its record remains in backups.')
  return draft
}
export function inactiveQuiz(state: Workspace, id: string) {
  const draft = quizForLearner(state, id)
  if (draft.status === 'validated' || !unusedQuiz(state, id)) throw new Error('A reviewed or presented quiz is frozen; its saved questions cannot be replaced.')
  return draft
}
export function recoverableQuizzes(state: Workspace) {
  return state.drafts.filter(d => d.kind === 'quiz' && d.quiz && d.generation && d.discardedAt === undefined && d.cardIds.length &&
    d.cardIds.every(id => state.cards.find(c => c.id === id)?.learnerId === state.activeLearnerId) && unusedQuiz(state, d.id)).reverse()
}
