import { z } from 'zod'
import { identifier, ids, shortText, quizLevelSchema } from './common'

export const discoveryKindSchema = z.enum(['topic', 'roleplay', 'interest'])
export const discoveryRequestSchema = z.strictObject({
  kind: discoveryKindSchema, publicTopic: z.string().max(300), rootId: identifier,
  extract: z.boolean(), refresh: z.boolean(),
  quizLevel: quizLevelSchema.optional(),
})
/** A bounded lesson may contain fewer points; the ceiling is not a curriculum size. */
export const MAX_LESSON_POINTS = 9
export const lessonScopePointSchema = z.strictObject({
  id: identifier, expression: shortText(200), meaning: shortText(1000), purpose: shortText(500),
})
export const lessonScopeSchema = z.strictObject({
  request: discoveryRequestSchema, outline: shortText(1800),
  points: z.array(lessonScopePointSchema).min(1).max(MAX_LESSON_POINTS),
  review: z.strictObject({ reason: shortText(1500), model: shortText(200) }),
})
export const discoveryPlanningSchema = z.strictObject({
  outline: shortText(1800),
  candidate: z.array(lessonScopePointSchema).min(1).max(MAX_LESSON_POINTS).optional(),
  revision: shortText(1500).optional(), rounds: z.number().int().min(0),
  accepted: lessonScopeSchema.optional(),
  reading: z.strictObject({ passage: shortText(1200), translation: shortText(2000) }).optional(),
})
export type LessonScope = z.infer<typeof lessonScopeSchema>
export type DiscoveryPlanning = z.infer<typeof discoveryPlanningSchema>
const cited = ids(3).refine(list => list.length > 0 && new Set(list).size === list.length, 'Choose distinct supporting sources.')
export const discoveryPhraseProposalSchema = z.strictObject({
  hanzi: shortText(200), meaning: shortText(1000), sense: shortText(300),
  explanation: shortText(1200), exampleHanzi: shortText(500), exampleMeaning: shortText(1000), sourceIds: cited,
})
export const roleplayScenarioSchema = z.strictObject({
  situation: shortText(1000), teacherRole: shortText(200), learnerRole: shortText(200),
  openingHanzi: shortText(500), openingMeaning: shortText(1000), objective: shortText(500),
})
export const discoveryProposalSchema = z.strictObject({
  title: shortText(120), explanation: shortText(2500), passageHanzi: shortText(2000), passageMeaning: shortText(3000),
  phrases: z.array(discoveryPhraseProposalSchema).min(1).max(MAX_LESSON_POINTS), sourceIds: cited,
  roleplay: roleplayScenarioSchema.nullable(),
})
export const discoveryMaterialSchema = discoveryProposalSchema.extend({
  nodeId: identifier, passagePinyin: shortText(16000),
  phrases: z.array(discoveryPhraseProposalSchema.extend({ id: identifier, pinyin: shortText(1600), examplePinyin: shortText(4000) })).min(1).max(MAX_LESSON_POINTS),
  captures: z.array(z.strictObject({ phraseId: identifier, itemId: identifier, cardIds: ids(3) })).max(MAX_LESSON_POINTS),
})
export type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>
export type DiscoveryMaterial = z.infer<typeof discoveryMaterialSchema>
export type DiscoveryProposal = z.infer<typeof discoveryProposalSchema>
