import { z } from 'zod'
import { identifier, ids, shortText, timestamp } from '../domain/common'
import { assessmentSchema, rubricSchema, learnerSchema, skillSchema } from '../domain/learning'
import { lessonSettingsSchema } from '../domain/lessonPlan'
import { workedExampleProposalSchema } from '../domain/workedExample'

export const generationSchema = z.strictObject({ provider: shortText(100), model: shortText(200), promptVersion: shortText(100), createdAt: timestamp })
export const quizTargetSchema = z.strictObject({
  cardId: identifier, skill: skillSchema, hanzi: shortText(1000), pinyin: z.string().max(2000), sense: shortText(1000), meaning: shortText(4000),
  reviewSettings: lessonSettingsSchema.optional(),
  level: learnerSchema.shape.level, explanationLanguage: shortText(100), languageBalance: learnerSchema.shape.languageBalance,
})
export type QuizTarget = z.infer<typeof quizTargetSchema>
export const teachingMaterialSchema = z.strictObject({
  itemId: identifier, explanation: shortText(4000), exampleHanzi: shortText(1000), examplePinyin: shortText(2000), exampleMeaning: shortText(2000), sourceIds: ids(3),
})
export const teachingProposalSchema = teachingMaterialSchema.omit({ itemId: true, examplePinyin: true })
export const freeExerciseProposalSchema = z.strictObject({
  prompt: shortText(2000), expectedAnswer: shortText(2000), acceptedAlternatives: z.array(shortText(1000)).max(20),
  rubric: rubricSchema, allowedAids: z.array(shortText(100)).max(6), sourceIds: ids(3), answerPolicy: z.enum(['exact', 'contextual']),
  workedExample: workedExampleProposalSchema,
})
// New model responses require paired material; old persisted assessments still
// parse through the backward-compatible domain schema. Uncertainty must not guess.
export const teacherAssessmentProposalSchema = assessmentSchema.omit({ workedExample: true, correctedExample: true }).extend({
  workedExample: workedExampleProposalSchema.nullable(),
})
export const quizContentReviewSchema = z.strictObject({
  verdict: z.enum(['supported', 'uncertain', 'rejected']), reasons: shortText(4000),
  questions: z.array(z.strictObject({ cardId: identifier, oneCorrectAnswer: z.boolean().nullable(), sourceSupported: z.boolean().nullable(),
    skillAligned: z.boolean().nullable(), answerHidden: z.boolean().nullable(), levelAppropriate: z.boolean().nullable(), lessonAligned: z.boolean().optional(), evidence: shortText(1500) })).min(1).max(3),
})
export type TeachingMaterial = z.infer<typeof teachingMaterialSchema>
export type FreeExerciseProposal = z.infer<typeof freeExerciseProposalSchema>
export type QuizContentReview = z.infer<typeof quizContentReviewSchema>
/** Prepared lessons require alignment; daily review does not have a lesson recipe. */
export const lessonQuizContentReviewSchema = quizContentReviewSchema.extend({
  questions: z.array(quizContentReviewSchema.shape.questions.element.extend({ lessonAligned: z.boolean() })).min(1).max(3),
})
