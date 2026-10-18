import type { Workspace } from '../domain/workspace'
import type { LearningSession } from '../domain/learning'
import { lessonForSession, lessonView } from '../domain/lesson'
import { nid } from '../id'
import { lessonReviewEligibleAt } from './learningCalendar'
import { LESSON_POLICY_VERSION, lessonCheckAnswers, lessonProgression, lessonReviewInterval } from './lessonPolicy'

export function touchLessonActivity(state: Workspace, session: LearningSession) {
  if (session.lessonAttempt && !session.lessonAttempt.completion)
    session.lessonAttempt.interactionDay = state.learners.find(l => l.id === session.learnerId)!.learningCalendar.anchor!
}

export function completeLessonActivity(state: Workspace, session: LearningSession, at: number) {
  const activity = session.lessonAttempt, lesson = lessonForSession(state, session)
  if (!activity || !lesson || activity.completion) return
  const plan = lessonView(state, session)!
  if (!plan.preparation?.check?.complete || activity.stepIndex !== plan.steps.length) throw new Error('Finish the saved lesson steps before completing it.')
  const answers = lessonCheckAnswers(state, session), passed = answers.length > 0 && answers.every(a => a.outcome === 'correct')
  const previous = lessonProgression(state, lesson.id)
  const day = state.learners.find(l => l.id === session.learnerId)!.learningCalendar.anchor!
  activity.completion = { completedAt: at, day, passed, pointAwarded: activity.activity !== 'practice' && passed && previous.points < 10, answers, policyVersion: LESSON_POLICY_VERSION }
  session.status = 'completed'; session.activeExerciseId = null; session.updatedAt = at
  recordLessonExposure(state, lesson.cardIds)
  if (activity.activity !== 'practice' && passed) {
    if (!lesson.opportunity || activity.cycleId !== lesson.opportunity.id) throw new Error('This scored opportunity is no longer open.')
    const progress = lessonProgression(state, lesson.id)
    lesson.opportunity = { id: nid('lesson-cycle'), kind: progress.level >= 4 ? 'maintenance' : 'review', previousSessionId: session.id,
      eligibleAt: lessonReviewEligibleAt(at, day, lessonReviewInterval(progress.level, previous.level)) }
  }
}

/** Preserve submitted answers; material exposure affects only unanswered checks. */
export function recordLessonExposure(state: Workspace, cardIds: string[]) {
  for (const session of state.sessions) {
    const activity = session.lessonAttempt
    if (!activity || activity.activity !== 'review' || session.status === 'completed') continue
    const plan = lessonView(state, session)!
    for (const cardId of plan.cardIds.filter(id => cardIds.includes(id))) {
      if (activity.exposures?.some(e => e.cardId === cardId)) continue
      const answeredQuestionIds = plan.steps.flatMap((step, index) => step.phase === 'check' && step.cardId === cardId
        && state.exercises.some(e => e.sessionId === session.id && e.lessonStep === index && state.attempts.some(a => a.exerciseId === e.id)) ? [step.questionId!] : [])
      if (!activity.exposures) activity.exposures = []
      activity.exposures.push({ cardId, answeredQuestionIds })
    }
  }
}
