import { z } from 'zod'

const text = (max: number) => z.string().trim().min(1).max(max)
// Source IDs/provenance belong to the containing exercise, assessment or feedback
// draft. A paired translation is never inferred from the target phrase's meaning.
export const workedExampleProposalSchema = z.strictObject({
  hanzi: text(1000).regex(/\p{Script=Han}/u, 'A worked example needs Mandarin text.'),
  meaning: text(2000), explanation: text(2000),
})
export const workedExampleSchema = workedExampleProposalSchema.extend({ pinyin: text(8000) })
export type WorkedExample = z.infer<typeof workedExampleSchema>
