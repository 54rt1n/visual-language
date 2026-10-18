import { lessonView, type Lesson } from '../domain/lesson'
import type { LearningSession } from '../domain/learning'
import type { Workspace } from '../domain/workspace'
import type { LearningDay } from '../domain/learningCalendar'

export const LESSON_POLICY_VERSION = 'lesson-progression-v1' as const
const thresholds = [1, 3, 6, 10]

/** First submissions, including missing slots, are the evidence for a check. */
export function lessonCheckAnswers(state: Workspace, session: LearningSession) {
  const plan = lessonView(state, session)
  return (plan?.steps ?? []).flatMap((step, index) => {
    if (step.phase !== 'check') return []
    const exercise = state.exercises.find(e => e.sessionId === session.id && e.lessonStep === index)
    const attempt = exercise && state.attempts.filter(a => a.exerciseId === exercise.id).sort((a, b) => a.submittedAt - b.submittedAt)[0]
    const exposure = session.lessonAttempt?.exposures?.find(e => e.cardId === step.cardId)
    const helped = Boolean(attempt?.helpUsed || (exercise && state.events.some(e => e.exerciseId === exercise.id && e.aid))
      || (exposure && !exposure.answeredQuestionIds.includes(step.questionId!)))
    const outcome = session.lessonAttempt!.skippedSteps.includes(index) ? 'skipped' as const
      : !attempt || attempt.status !== 'committed' || attempt.assessment?.grade === 'uncertain' ? 'unresolved' as const
      : helped ? 'helped' as const : attempt.assessment?.grade === 'correct' ? 'correct' as const : 'incorrect' as const
    return [{ questionId: step.questionId!, cardId: step.cardId, ...(exercise ? { exerciseId: exercise.id } : {}),
      ...(attempt ? { attemptId: attempt.id } : {}), outcome }]
  })
}

export function lessonHistory(state: Workspace, lessonId: string) {
  return state.sessions.filter(s => s.lessonAttempt?.lessonId === lessonId)
    .reverse().sort((a, b) => (b.lessonAttempt?.completion?.completedAt ?? b.updatedAt) - (a.lessonAttempt?.completion?.completedAt ?? a.updatedAt) || b.createdAt - a.createdAt)
}

export function lessonProgression(state: Workspace, lessonId: string) {
  const passes = new Set(lessonHistory(state, lessonId).flatMap(s => s.lessonAttempt?.completion?.passed
    && s.lessonAttempt.activity !== 'practice' && s.lessonAttempt.cycleId ? [s.lessonAttempt.cycleId] : []))
  const points = Math.min(10, passes.size), level = thresholds.filter(t => points >= t).length
  return { points, level, nextThreshold: thresholds[level], passes: passes.size }
}

export function lessonReviewInterval(level: number, previousLevel: number) {
  return level >= 4 ? previousLevel < 4 ? 14 : 30 : level === 3 ? 7 : level === 2 ? 3 : 1
}

export function lessonActivity(state: Workspace, lesson: Lesson, now: number) {
  const history = lessonHistory(state, lesson.id), opportunity = lesson.opportunity
  const due = Boolean(lesson.archivedAt === undefined && opportunity && opportunity.kind !== 'initial' && now >= opportunity.eligibleAt)
  const scored = history.find(s => s.status !== 'completed' && s.lessonAttempt!.activity !== 'practice' && s.lessonAttempt!.cycleId === opportunity?.id)
  const practice = history.find(s => s.status !== 'completed' && s.lessonAttempt!.activity === 'practice')
  const eligible = opportunity && now >= opportunity.eligibleAt
  const mode = eligible ? opportunity.kind === 'initial' ? 'learn' as const : 'review' as const : 'practice' as const
  const session = eligible ? scored : practice
  const day = session?.lessonAttempt?.interactionDay
  const current = Boolean(day && now >= day.startAt && now < day.endAt)
  return { due, mode, session, savedPractice: practice, label: current ? 'Continue' : mode === 'learn' ? 'Learn' : mode === 'review' ? 'Review' : 'Practice',
    retry: Boolean(eligible && history.some(s => s.lessonAttempt?.cycleId === opportunity.id && s.lessonAttempt.completion && !s.lessonAttempt.completion.passed)) }
}

export function learningStreak(state: Workspace, day: LearningDay) {
  const credits = new Map(state.sessions.flatMap(s => s.learnerId === state.activeLearnerId && s.lessonAttempt?.completion
    ? [[s.lessonAttempt.completion.day.id, s.lessonAttempt.completion.day] as const] : []))
  const sequences = [...new Set([...credits.values()].map(d => d.sequence))].sort((a, b) => a - b)
  let best = 0, run = 0, last = -Infinity
  for (const sequence of sequences) { run = sequence === last + 1 ? run + 1 : 1; best = Math.max(best, run); last = sequence }
  const current = last >= day.sequence - 1 && last <= day.sequence ? run : 0
  return { current, best, today: sequences.includes(day.sequence), days: Array.from({ length: 7 }, (_, i) => {
    const sequence = day.sequence - 6 + i
    return { sequence, completed: sequences.includes(sequence) }
  }) }
}

export function pendingLessonReview(state: Workspace) {
  return state.sessions.find(session => {
    const activity = session.lessonAttempt
    if (activity?.activity !== 'review' || session.status === 'completed') return false
    const plan = lessonView(state, session)!
    return plan.cardIds.some(cardId => !activity.exposures?.some(e => e.cardId === cardId)
      && (!activity.checkPreparation?.quiz?.complete || plan.steps.some((step, index) => step.cardId === cardId
        && !state.exercises.some(e => e.sessionId === session.id && e.lessonStep === index && state.attempts.some(a => a.exerciseId === e.id)))))
  })
}

export function pendingRecallExercise(state: Workspace) {
  return state.exercises.find(exercise => {
    const session = state.sessions.find(s => s.id === exercise.sessionId)
    if (session?.activeExerciseId !== exercise.id || session.status === 'completed') return false
    const lessonReview = session.lessonAttempt?.activity === 'review'
    if (exercise.mode !== 'dueReview' && !lessonReview) return false
    const resolved = state.events.some(e => e.exerciseId === exercise.id && (e.kind === 'review' || e.aid))
    const answered = state.attempts.some(a => a.exerciseId === exercise.id && (a.status === 'committed' || lessonReview))
    return !resolved && !answered
  })
}
