import { z } from 'zod'
import { identifier, shortText } from './common'

export const readingPronunciationSchema = z.strictObject({
  pinyin: z.string().trim().min(1).max(1500).nullable(), note: shortText(300),
})
export const readingExplanationSchema = z.strictObject({
  meaning: shortText(600), explanation: shortText(1500), sentenceMeaning: shortText(2200), uncertain: z.boolean(),
  // Optional only for old saved notes; every new request must address pronunciation.
  pronunciation: readingPronunciationSchema.optional(),
})
export function readingRequestSchema(level: 'beginner' | 'intermediate' | 'advanced' | 'native') {
  return readingExplanationSchema.extend({
    meaning: shortText(level === 'beginner' ? 160 : 240),
    explanation: shortText(level === 'beginner' ? 360 : level === 'intermediate' ? 600 : 1000),
    pronunciation: readingPronunciationSchema,
  })
}
export const readingNoteSchema = readingExplanationSchema.extend({
  nodeId: identifier, learnerId: identifier, sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  start: z.number().int().min(0).max(100_000), end: z.number().int().min(1).max(100_000),
  text: shortText(200), pinyin: z.string().max(1500), contextStart: z.number().int().min(0).max(100_000), context: shortText(1600),
  explanationLanguage: shortText(100), level: z.enum(['beginner', 'intermediate', 'advanced', 'native']),
}).refine(note => note.end - note.start === note.text.length && note.start >= note.contextStart && note.context.slice(note.start - note.contextStart, note.end - note.contextStart) === note.text, 'A reading note must match its frozen text span.')
export type ReadingNote = z.infer<typeof readingNoteSchema>
