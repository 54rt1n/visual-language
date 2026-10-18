import { z } from 'zod'
import { identifier, ids, policyVersion, revision, shortText, timestamp } from './common'
import { originalSrsSchema } from './original'
import { workedExampleSchema } from './workedExample'
import { quizLevelSchema } from './lessonPlan'
import { lessonAttemptSchema } from './lesson'
import { learningCalendarSchema } from './learningCalendar'
import { dictionaryCitationKey, dictionaryCitationSchema } from './dictionaryCitation'

export const skillSchema = z.enum(['recognition', 'meaning', 'production'])
export const learnerSchema = z.strictObject({
  id: identifier, level: z.enum(['beginner', 'intermediate', 'advanced', 'native']), goal: shortText(2000),
  languageBalance: z.enum(['mostlyTarget', 'balanced', 'mostlyNative']).optional(),
  explanationLanguage: shortText(100), pinyinDisplay: z.enum(['always', 'onDemand', 'hidden']),
  maxReviewCards: z.number().int().min(1).max(100), maxNewItems: z.number().int().min(0).max(20),
  learningCalendar: learningCalendarSchema,
})
export const itemSchema = z.strictObject({
  id: identifier, language: z.literal('zh'), kind: z.enum(['word', 'phrase', 'grammar']),
  canonicalText: shortText(1000), senseKey: shortText(1000), meaning: shortText(4000), pinyin: z.string().max(2000).optional(),
  sourceNodeIds: ids(100), sourceRootIds: ids(100), createdAt: timestamp,
  // Only explicitly recognized legacy SRS metadata; never mapped into Leitner boxes.
  originalSrs: originalSrsSchema.optional(),
  dictionarySources: z.array(dictionaryCitationSchema).max(10).optional(),
}).superRefine((item, ctx) => {
  if (item.dictionarySources?.some(citation => ![citation.traditional, citation.simplified].some(word => word.normalize('NFC').trim() === item.canonicalText.normalize('NFC').trim()))) ctx.addIssue({ code: 'custom', message: 'A dictionary citation must match the saved word.' })
  if (item.dictionarySources && new Set(item.dictionarySources.map(dictionaryCitationKey)).size !== item.dictionarySources.length) ctx.addIssue({ code: 'custom', message: 'Dictionary citations must be distinct.' })
})
export const cardSchema = z.strictObject({
  id: identifier, learnerId: identifier, itemId: identifier, skill: skillSchema,
  box: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  status: z.enum(['new', 'active', 'suspended']), policyVersion,
  introducedAt: timestamp.nullable(), dueAt: timestamp.nullable(), lastTransitionAt: timestamp.nullable(), revision,
}).superRefine((card, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (card.status === 'new' && (card.box !== 1 || card.introducedAt !== null || card.dueAt !== null)) invalid('New cards must be unintroduced box 1 cards without a due date.')
  if ((card.introducedAt === null) !== (card.dueAt === null)) invalid('Introduction and due dates must both be set or both be absent.')
  if (card.status === 'active' && card.dueAt === null) invalid('Active cards require introduction and due dates.')
  if (card.introducedAt !== null && (card.lastTransitionAt === null || card.lastTransitionAt < card.introducedAt || card.dueAt! < card.introducedAt)) invalid('Card dates are inconsistent.')
})
export const rubricSchema = z.array(z.strictObject({ id: identifier, description: shortText(1000), required: z.boolean() })).min(1).max(12)
export const multipleChoiceSchema = z.strictObject({
  quizId: identifier, options: z.array(z.strictObject({ id: identifier, text: shortText(200), pinyin: shortText(1600).optional() })).length(4),
  quizLevel: quizLevelSchema.optional(), passagePinyin: shortText(16000).optional(),
  correctOptionId: identifier, explanation: shortText(1000),
  distractorFeedback: z.array(z.strictObject({ optionId: identifier, explanation: shortText(1000) })).length(3),
})
export const learningContextSchema = z.strictObject({
  purpose: z.enum(['freshContext', 'mistakeContrast']), webRequested: z.boolean(), webUsed: z.boolean(),
  notices: z.array(shortText(500)).max(5),
})
export const exerciseSchema = z.strictObject({
  id: identifier, sessionId: identifier, cardId: identifier, cardRevision: revision,
  mode: z.enum(['dueReview', 'practice', 'introduction']), format: z.enum(['multipleChoice', 'freeAnswer']),
  prompt: shortText(4000), expectedAnswer: shortText(4000), acceptedAlternatives: z.array(shortText(1000)).max(30),
  rubric: rubricSchema, allowedAids: z.array(shortText(200)).max(10), sourceNodeIds: ids(100), presentedAt: timestamp,
  sourceIds: ids(10), multipleChoice: multipleChoiceSchema.optional(),
  answerPolicy: z.enum(['exact', 'contextual']), promptVersion: shortText(100), provider: shortText(100), model: shortText(200),
  learningContext: learningContextSchema.optional(),
  sourceLessonId: identifier.optional(),
  lessonStep: z.number().int().min(0).max(26).optional(),
  workedExample: workedExampleSchema.optional(), // Older saved questions may lack teaching material.
}).superRefine((exercise, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (new Set(exercise.rubric.map(c => c.id)).size !== exercise.rubric.length) invalid('Rubric IDs must be unique.')
  if (!exercise.rubric.some(c => c.required)) invalid('An exercise needs at least one required criterion.')
  if ((exercise.format === 'multipleChoice') !== Boolean(exercise.multipleChoice)) invalid('Multiple-choice format requires its matching answer key.')
  const mc = exercise.multipleChoice
  if (!mc) return
  const optionIds = mc.options.map(o => o.id)
  if (new Set(optionIds).size !== 4 || new Set(mc.options.map(o => o.text.normalize('NFKC').trim().toLocaleLowerCase())).size !== 4) invalid('Multiple-choice options must be distinct.')
  if (!optionIds.includes(mc.correctOptionId)) invalid('Answer key must match an option.')
  if (JSON.stringify(optionIds.filter(id => id !== mc.correctOptionId).sort()) !== JSON.stringify(mc.distractorFeedback.map(f => f.optionId).sort())) invalid('Distractor feedback must cover every incorrect option exactly once.')
})
export const assessmentSchema = z.strictObject({
  exerciseId: identifier, grade: z.enum(['correct', 'incorrect', 'uncertain']),
  criteria: z.array(z.strictObject({ criterionId: identifier, met: z.boolean().nullable(), evidence: shortText(2000) })).max(12),
  feedback: shortText(4000), correctedExample: shortText(4000).optional(),
  workedExample: workedExampleSchema.optional(),
})
export const attemptSchema = z.strictObject({
  id: identifier, exerciseId: identifier, cardId: identifier, submittedAt: timestamp, answer: z.string().max(8000),
  selectedOptionId: identifier.optional(), helpUsed: z.boolean(), status: z.enum(['pending', 'assessed', 'needsReview', 'committed']),
  assessment: assessmentSchema.optional(), assessmentSource: z.enum(['deterministic', 'teacher', 'learner']).optional(),
  gradingProvider: shortText(100).optional(), gradingModel: shortText(200).optional(), gradingPromptVersion: shortText(100).optional(),
  gradingError: z.string().max(1000).optional(),
  disputed: z.boolean().optional(),
})
export const eventSchema = z.strictObject({
  id: identifier, cardId: identifier, exerciseId: identifier.optional(), attemptId: identifier.optional(),
  kind: z.enum(['introduced', 'review', 'practice', 'correction', 'suspended', 'resumed']),
  outcome: z.enum(['recalled', 'notRecalled', 'unresolved']).optional(), occurredAt: timestamp, policyVersion,
  before: cardSchema, after: cardSchema, supersedesEventId: identifier.optional(),
  aid: z.enum(['hint', 'reveal', 'dontKnow', 'source']).optional(), disputed: z.boolean().optional(),
})
export const sessionSchema = z.strictObject({
  id: identifier, learnerId: identifier, rootId: identifier.nullable(), createdAt: timestamp, updatedAt: timestamp,
  status: z.enum(['active', 'paused', 'completed']), selectedCardIds: ids(100), completedCardIds: ids(100), skippedCardIds: ids(100),
  introducedItemIds: ids(20), activeExerciseId: identifier.nullable(), maxReviewCards: z.number().int().min(1).max(100),
  maxNewItems: z.number().int().min(0).max(20), goal: shortText(2000),
  // Word-review sessions have no lesson activity.
  lessonAttempt: lessonAttemptSchema.optional(),
})
export type LearnerProfile = z.infer<typeof learnerSchema>
export type LearningItem = z.infer<typeof itemSchema>
export type LeitnerCard = z.infer<typeof cardSchema>
export type Skill = z.infer<typeof skillSchema>
export type Exercise = z.infer<typeof exerciseSchema>
export type Assessment = z.infer<typeof assessmentSchema>
export type ReviewAttempt = z.infer<typeof attemptSchema>
export type LearningEvent = z.infer<typeof eventSchema>
export type LearningSession = z.infer<typeof sessionSchema>
