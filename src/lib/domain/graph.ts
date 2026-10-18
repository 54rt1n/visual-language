import { z } from 'zod'
import { providerIds } from '../ai/providers'
import { identifier, ids, shortText, timestamp } from './common'
import { learnerSchema } from './learning'
import { originalVocabularySchema, originalWordSegmentsSchema, originalSegmentsMatch } from './original'

export const positionSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() })
const common = { id: identifier, rootId: identifier, position: positionSchema, bookmarked: z.boolean(), collapsed: z.boolean() }
const node = <T extends string, S extends z.ZodType>(type: T, data: S) => z.strictObject({ ...common, type: z.literal(type), data })
const wordSourceSchema = z.strictObject({
  nodeId: identifier, start: z.number().int().min(0).max(100_000), end: z.number().int().min(1).max(100_000),
  contextStart: z.number().int().min(0).max(100_000), context: shortText(1600),
})
export const graphNodeSchema = z.discriminatedUnion('type', [
  node('root', z.strictObject({ name: shortText(200) })),
  node('user', z.strictObject({ text: z.string().max(100_000) })),
  node('assistant', z.strictObject({ text: z.string().max(100_000), reasoning: z.string().max(100_000),
    state: z.enum(['complete', 'interrupted', 'error']), error: z.string().max(1000), provider: z.string().max(100), model: z.string().max(200), editedAt: timestamp.optional(), regeneratedFrom: identifier.optional() })),
  node('chunk', z.strictObject({ text: shortText(1000), pinyin: z.string().max(2000), meaning: z.string().max(4000), itemId: identifier.optional(), originalVocabulary: originalVocabularySchema.optional(), originalWordSegments: originalWordSegmentsSchema.optional(), wordSource: wordSourceSchema.optional() })
    .refine(data => !data.originalWordSegments || originalSegmentsMatch(data.text, data.originalWordSegments), { message: 'Original word segments must match complete, ordered, non-overlapping spans of their chunk.' })
    .refine(data => !data.wordSource || (data.wordSource.end - data.wordSource.start === data.text.length && data.wordSource.start >= data.wordSource.contextStart && data.wordSource.context.slice(data.wordSource.start - data.wordSource.contextStart, data.wordSource.end - data.wordSource.contextStart) === data.text), { message: 'The learning word must match its saved source occurrence.' })),
  node('explanation', z.strictObject({ wordNodeId: identifier, text: z.string().max(100_000), reasoning: z.string().max(100_000),
    state: z.enum(['complete', 'interrupted', 'error']), error: z.string().max(1000), provider: z.string().max(100), model: z.string().max(200) })),
  node('exercise', z.strictObject({ exerciseId: identifier })),
  node('lesson', z.strictObject({ draftId: identifier })),
  node('modelConfig', z.strictObject({ provider: z.enum(providerIds), model: shortText(200), temperature: z.number().min(0).max(2), maxTokens: z.number().int().min(64).max(16000), requiresReview: z.literal(true).optional(), originalProvider: shortText(100).optional() })),
  node('systemConfig', z.strictObject({ prompt: shortText(8000) })),
  node('vocabularyConfig', z.strictObject({ words: z.array(shortText(300)).max(100), instruction: z.string().max(2000) })),
  node('learningConfig', learnerSchema.omit({ id: true, goal: true }).extend({ goal: shortText(2000) })),
])
export const edgeSchema = z.strictObject({
  id: identifier, source: identifier, target: identifier,
  data: z.strictObject({ kind: z.enum(['conversation', 'context', 'derived']) }),
})
export const graphViewSchema = z.strictObject({
  activeRootId: identifier, selectedNodeIds: ids(1000),
  viewport: z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.05).max(8) }),
  teacherCollapsed: z.boolean(), composerDraft: z.string().max(8000),
  teacherPortraits: z.boolean().optional(), // Missing in legacy backups means visible.
})
export type GraphNode = z.infer<typeof graphNodeSchema>
export type GraphEdge = z.infer<typeof edgeSchema>
export type GraphView = z.infer<typeof graphViewSchema>
export const configTypes = ['modelConfig', 'systemConfig', 'vocabularyConfig', 'learningConfig'] as const
