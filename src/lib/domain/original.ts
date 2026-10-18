import { z } from 'zod'
import { identifier, ids, shortText, timestamp } from './common'

export class ImportedModelReviewRequired extends Error {
  constructor() { super('Review the imported model in Node tools and save a provider/model override before making requests.'); this.name = 'ImportedModelReviewRequired' }
}

/** Offsets are UTF-16 positions in the original chunk, not its full response. */
export const originalWordSegmentSchema = z.strictObject({
  text: shortText(1000), startIndex: z.number().int().min(0).max(1000),
  endIndex: z.number().int().min(1).max(1000), pinyin: z.string().max(2000).optional(),
})
export type OriginalWordSegment = z.infer<typeof originalWordSegmentSchema>
export const originalWordSegmentsSchema = z.array(originalWordSegmentSchema).max(1000)
export function originalSegmentsMatch(text: string, segments: OriginalWordSegment[]) {
  const boundary = (index: number) => !(index > 0 && index < text.length && /[\uD800-\uDBFF]/u.test(text[index - 1]!) && /[\uDC00-\uDFFF]/u.test(text[index]!))
  let previousEnd = 0
  return segments.every(segment => {
    const valid = segment.startIndex >= previousEnd && segment.endIndex > segment.startIndex && segment.endIndex <= text.length &&
      boundary(segment.startIndex) && boundary(segment.endIndex) && text.slice(segment.startIndex, segment.endIndex) === segment.text
    previousEnd = segment.endIndex
    return valid
  })
}

/** Provenance only. None of these fields are scheduling inputs. */
export const originalSrsSchema = z.strictObject({
  easeFactor: z.number().finite().optional(),
  masteryLevel: z.union([z.number().finite(), z.enum(['Not Started', 'Learning', 'Reviewing', 'Confident'])]).optional(),
  interval: z.number().finite().optional(), repetitions: z.number().int().optional(),
  lastSelfAssessmentTimestamp: timestamp.optional(), selfAssessmentCorrectCount: z.number().int().nonnegative().optional(),
  selfAssessmentIncorrectCount: z.number().int().nonnegative().optional(),
  reviewSchedule: z.strictObject({ nextReviewTimestamp: timestamp, currentIntervalDays: z.number().finite().nonnegative().optional(), easeFactor: z.number().finite().optional() }).optional(),
})
export const originalVocabularySchema = originalSrsSchema.extend({
  id: identifier, term: shortText(1000), pinyin: z.string().max(2000).optional(), definition: z.string().max(4000).optional(),
  sourceNodeIds: ids(100).optional(), addedTimestamp: timestamp, category: z.string().max(200).optional(),
})
