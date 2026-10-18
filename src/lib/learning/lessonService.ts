import { nid } from '../id'
import type { LessonAttempt } from '../domain/lesson'
import type { Workspace } from '../domain/workspace'
import type { WorkspaceRepository, WorkspaceSnapshot } from '../storage/repository'
import { resolveLearningCalendar } from './learningCalendar'
import { realClock, type Clock } from './leitner'
import { lessonActivity, lessonHistory } from './lessonPolicy'
import { recordLessonExposure, touchLessonActivity } from './lessonLifecycle'

/** Lifecycle commands preserve reusable material, attempts and earned history. */
export class LessonService {
  constructor(readonly repository: WorkspaceRepository, readonly clock: Clock = realClock) {}
  private change(snapshot: WorkspaceSnapshot, kind: string, intent: unknown, fn: (state: Workspace, at: number) => void) {
    const at = this.clock.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return this.repository.mutate(snapshot.version, { id: nid('op'), kind, intent, at }, state => {
      const learner = state.learners.find(l => l.id === state.activeLearnerId)!
      learner.learningCalendar = resolveLearningCalendar(learner.learningCalendar, at, timeZone)
      fn(state, at)
    })
  }
  archive(snapshot: WorkspaceSnapshot, lessonId: string, archived = true) {
    return this.change(snapshot, archived ? 'archive-lesson' : 'restore-lesson', { lessonId }, (state, at) => {
      const lesson = state.lessons.find(l => l.id === lessonId && l.learnerId === state.activeLearnerId)
      if (!lesson) throw new Error('Choose a saved lesson for the current learner.')
      if (archived) {
        lesson.archivedAt ??= at
        for (const session of lessonHistory(state, lessonId).filter(s => s.status === 'active')) { session.status = 'paused'; session.updatedAt = at }
      } else delete lesson.archivedAt
    })
  }
  revealMaterial(snapshot: WorkspaceSnapshot, cardIds: string[]) {
    return this.change(snapshot, 'lesson-material-help', { cardIds }, state => recordLessonExposure(state, cardIds))
  }
  startActivity(snapshot: WorkspaceSnapshot, lessonId: string, requested?: LessonAttempt['activity']) {
    return this.change(snapshot, 'open-lesson-activity', { lessonId, requested }, (state, at) => {
      const lesson = state.lessons.find(l => l.id === lessonId && l.learnerId === state.activeLearnerId)
      if (!lesson || lesson.archivedAt !== undefined) throw new Error('Restore this archived lesson before opening it.')
      const action = lessonActivity(state, lesson, at), activity = requested ?? action.mode
      if (activity !== 'practice' && (activity !== action.mode || !lesson.opportunity || at < lesson.opportunity.eligibleAt)) throw new Error('This lesson is not ready for a scored check. Practice is available now.')
      const saved = lessonHistory(state, lessonId).find(s => s.status !== 'completed' && s.lessonAttempt!.activity === activity
        && (activity === 'practice' || s.lessonAttempt!.cycleId === lesson.opportunity!.id))
      if (activity === 'practice') recordLessonExposure(state, lesson.cardIds)
      for (const other of state.sessions.filter(s => s.learnerId === state.activeLearnerId && s.status === 'active' && s.id !== saved?.id)) { other.status = 'paused'; other.updatedAt = at }
      if (saved) { saved.status = 'active'; saved.updatedAt = at; touchLessonActivity(state, saved); return }
      if (!lesson.preparation?.check?.complete) throw new Error('Continue preparing the original lesson first.')
      const questions = state.drafts.filter(d => d.lessonPhase === 'check' && d.quiz && state.sessions.some(s => s.id === d.sessionId && s.lessonAttempt?.lessonId === lessonId && s.lessonAttempt.activity !== 'practice'))
        .flatMap(d => d.quiz!.questions)
      const previousQuestions = [...new Map(questions.map(q => [JSON.stringify([q.stem, q.passage]),
        { stem: q.stem, ...(q.passage ? { passageExcerpt: q.passage.slice(0, 240) } : {}) }])).values()].slice(-18)
      const quizOnly = activity === 'learn' && lessonHistory(state, lessonId).some(s => s.lessonAttempt?.cycleId === lesson.opportunity!.id && s.lessonAttempt.completion)
      const session = { id: nid('session'), learnerId: lesson.learnerId, rootId: state.nodes.find(n => n.id === lesson.anchorId)?.rootId ?? null,
        createdAt: at, updatedAt: at, status: 'active' as const, selectedCardIds: [], completedCardIds: [], skippedCardIds: [], introducedItemIds: [], activeExerciseId: null,
        maxReviewCards: lesson.cardIds.length, maxNewItems: lesson.cardIds.length, goal: lesson.goal,
        lessonAttempt: { lessonId, activity, ...(quizOnly ? { quizOnly: true as const } : {}), ...(activity === 'practice' ? {} : { cycleId: lesson.opportunity!.id, checkPreparation: { previousQuestions } }),
          stepIndex: 0, skippedSteps: [], remediatedSteps: [] } }
      state.sessions.push(session); touchLessonActivity(state, session)
      // Guided practice reuses the accepted quizzes; a scored retry/review gets
      // a new check on its own activity, without changing the lesson graph.
      for (const phase of activity === 'review' || quizOnly ? [] : activity === 'practice' ? ['practice', 'check'] as const : ['practice'] as const) {
        const original = state.drafts.find(d => d.kind === 'quiz' && d.lessonPhase === phase && d.status === 'validated'
          && d.discardedAt === undefined && state.sessions.some(s => s.id === d.sessionId && s.lessonAttempt?.lessonId === lessonId && !s.lessonAttempt.checkPreparation))
        if (!original) throw new Error('The lesson is missing its saved quiz.')
        state.drafts.push({ ...structuredClone(original), id: nid('quiz'), sessionId: session.id, createdAt: at, updatedAt: at })
      }
    })
  }
}
