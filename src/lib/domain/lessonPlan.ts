import { z } from 'zod'
import { identifier, shortText } from './common'
import { lessonPreparationSchema, lessonGraphDraftSchema, type LessonPreparation } from './lessonPreparation'
import { orderedWaypoints } from './lessonGraph'

export * from './lessonSettings'
import { lessonKindSchema, lessonSettingsSchema, lessonSourceSchema, englishAnswers, type LessonSettings, type LessonKind } from './lessonSettings'

export const lessonStepSchema = z.strictObject({
  cardId: identifier, waypointId: identifier.optional(), questionId: identifier.optional(), phase: z.enum(['learn', 'practice', 'check']),
  activity: z.enum(['workedExample', 'meaningChoice', 'replyChoice', 'scenarioMeaning', 'scenarioReply', 'passageMeaning', 'passageReply']),
})
export const lessonPlanSchema = z.strictObject({
  version: z.literal(1), kind: lessonKindSchema, settings: lessonSettingsSchema,
  steps: z.array(lessonStepSchema).max(27),
  preparation: lessonPreparationSchema.optional(),
  waypointDraft: lessonGraphDraftSchema.optional(),
  source: lessonSourceSchema.optional(),
  brief: shortText(2000).optional(),
})
export type LessonPlan = z.infer<typeof lessonPlanSchema>

/** A new lesson has no authored steps until its waypoint graph is reviewed. */
export function createLessonPlan(_cardIds: string[], settings: LessonSettings, kind: LessonKind = 'topic'): LessonPlan {
  return lessonPlanSchema.parse({ version: 1, kind, settings, steps: [] })
}

/** Playback respects prerequisites and practices each point once its context is taught. */
export function preparedLessonSteps(preparation: LessonPreparation, settings: LessonSettings, kind: LessonKind): z.infer<typeof lessonStepSchema>[] {
  const activity = englishAnswers(settings.quizLevel)
    ? kind === 'scenario' ? 'scenarioMeaning' : kind === 'reading' ? 'passageMeaning' : 'meaningChoice'
    : kind === 'scenario' ? 'scenarioReply' : kind === 'reading' ? 'passageReply' : 'replyChoice'
  const steps: z.infer<typeof lessonStepSchema>[] = [], taught = new Set<string>(), practiced = new Set<string>()
  for (const w of orderedWaypoints(preparation.lesson.graph)) {
    steps.push({ cardId: w.cardIds[0]!, waypointId: w.id, phase: 'learn', activity: 'workedExample' }); taught.add(w.id)
    for (const q of preparation.practice?.questions ?? []) if (!practiced.has(q.id)
      && [...q.gap.waypointIds, ...(q.coverageReview?.waypointIds ?? [])].every(id => taught.has(id))) {
      steps.push({ cardId: q.question.cardId, questionId: q.id, phase: 'practice', activity }); practiced.add(q.id)
    }
  }
  for (const q of preparation.check?.questions ?? []) steps.push({ cardId: q.question.cardId, questionId: q.id, phase: 'check', activity })
  return steps
}
