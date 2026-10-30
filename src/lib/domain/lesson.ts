import { z } from 'zod'
import { identifier, ids, sameRecord, shortText, timestamp } from './common'
import { lessonPlanSchema, preparedLessonSteps } from './lessonPlan'
import { waypointQuizSchema } from './lessonPreparation'
import { learningDaySchema } from './learningCalendar'

/** Reusable content is stored once; each session owns only its activity state. */
export const lessonSchema = lessonPlanSchema.extend({
  id: identifier, learnerId: identifier, anchorId: identifier,
  title: shortText(200), goal: shortText(2000), context: z.string().max(8000), cardIds: ids(9).min(1),
  createdAt: timestamp, archivedAt: timestamp.optional(),
  generationFailure: z.strictObject({ at: timestamp, details: z.string().max(6000) }).optional(),
  opportunity: z.strictObject({
    id: identifier, kind: z.enum(['initial', 'review', 'maintenance']), eligibleAt: timestamp,
    previousSessionId: identifier.optional(),
  }),
})

export const lessonCheckAnswerSchema = z.strictObject({
  questionId: identifier, cardId: identifier, exerciseId: identifier.optional(), attemptId: identifier.optional(),
  outcome: z.enum(['correct', 'incorrect', 'helped', 'skipped', 'unresolved']),
})
export const lessonAttemptSchema = z.strictObject({
  lessonId: identifier, activity: z.enum(['learn', 'practice', 'review']), cycleId: identifier.optional(),
  quizOnly: z.literal(true).optional(),
  stepIndex: z.number().int().min(0).max(27),
  remediatedSteps: z.array(z.number().int().min(0).max(26)).max(18),
  skippedSteps: z.array(z.number().int().min(0).max(26)).max(27),
  interactionDay: learningDaySchema.optional(),
  checkPreparation: z.strictObject({
    quiz: waypointQuizSchema.optional(),
    previousQuestions: z.array(z.strictObject({ stem: z.string().max(500), passageExcerpt: z.string().max(240).optional() })).max(18),
  }).optional(),
  exposures: z.array(z.strictObject({ cardId: identifier, answeredQuestionIds: ids(9) })).max(9).optional(),
  completion: z.strictObject({
    completedAt: timestamp, day: learningDaySchema, passed: z.boolean(), pointAwarded: z.boolean(),
    answers: z.array(lessonCheckAnswerSchema).min(1).max(9),
    policyVersion: z.literal('lesson-progression-v1'),
  }).refine(value => value.completedAt >= value.day.startAt && value.completedAt < value.day.endAt,
    'Completion must belong to its credited learning day.').optional(),
}).refine(value => value.activity !== 'practice' || !value.cycleId, 'Practice cannot claim a scored review cycle.')
  .refine(value => value.activity !== 'review' || Boolean(value.cycleId), 'Review requires a scored cycle.')
  .refine(value => !value.quizOnly || (value.activity === 'learn' && Boolean(value.checkPreparation)), 'A quiz retry requires its own saved preparation.')

export type Lesson = z.infer<typeof lessonSchema>
export type LessonAttempt = z.infer<typeof lessonAttemptSchema>

export function canKeepPracticeAlongsideReview(a: { status: string; lessonAttempt?: LessonAttempt }, b: { status: string; lessonAttempt?: LessonAttempt }) {
  const first = a.lessonAttempt, second = b.lessonAttempt
  return Boolean(first && second && first.lessonId === second.lessonId && (a.status === 'paused' || b.status === 'paused')
    && ((first.activity === 'practice' && second.activity === 'review') || (first.activity === 'review' && second.activity === 'practice')))
}

export function lessonForSession(state: { lessons: Lesson[] }, session?: { lessonAttempt?: LessonAttempt }): Lesson | undefined {
  return session?.lessonAttempt ? state.lessons.find(lesson => lesson.id === session.lessonAttempt!.lessonId) : undefined
}

/** Read projection for rendering/validation; mutations target the owning record. */
export function lessonView(state: { lessons: Lesson[] }, session?: { lessonAttempt?: LessonAttempt }): Readonly<Lesson & LessonAttempt> | undefined {
  const lesson = lessonForSession(state, session)
  if (!lesson || !session?.lessonAttempt) return undefined
  const attempt = session.lessonAttempt
  const preparation = attempt.checkPreparation && lesson.preparation
    ? { ...lesson.preparation, check: attempt.checkPreparation.quiz } : lesson.preparation
  const steps = attempt.checkPreparation && preparation ? preparedLessonSteps(preparation, lesson.settings, lesson.kind) : lesson.steps
  return { ...lesson, ...attempt, preparation, steps: attempt.activity === 'review' || attempt.quizOnly ? steps.filter(s => s.phase === 'check') : steps }
}

export function validateLessonChanges(previous: Lesson[], next: Lesson[]) {
  const byId = new Map(next.map(lesson => [lesson.id, lesson]))
  const content = ({ archivedAt: _archive, opportunity: _opportunity, ...value }: Lesson) => value
  for (const lesson of previous) {
    if (!lesson.preparation?.check?.complete) continue
    const updated = byId.get(lesson.id)
    if (!updated || !sameRecord(content(lesson), content(updated))) throw new Error('Prepared lesson content is immutable. Create a new lesson for different material or settings.')
  }
}

/** Completion evidence and the activity that earned it are append-only. */
export function validateLessonActivityChanges(previous: { id: string; lessonAttempt?: LessonAttempt }[], next: { id: string; lessonAttempt?: LessonAttempt }[]) {
  const byId = new Map(next.map(session => [session.id, session]))
  for (const session of previous) {
    const saved = session.lessonAttempt, updated = byId.get(session.id)?.lessonAttempt
    if (!saved) continue
    if (!updated || saved.lessonId !== updated.lessonId || saved.activity !== updated.activity || saved.cycleId !== updated.cycleId || saved.quizOnly !== updated.quizOnly)
      throw new Error('A saved lesson activity must preserve its lesson, mode and scored opportunity.')
    if (saved.completion && !sameRecord(saved, updated)) throw new Error('Completed lesson activity and its history are immutable.')
  }
}
