import { z } from 'zod'
import { shortText } from './common'

/** A retained citation to a learner-chosen dictionary sense, not an assessment. */
export const dictionaryCitationSchema = z.strictObject({
  dictionary: z.literal('CC-CEDICT'), attribution: z.literal('MDBG and CC-CEDICT contributors'),
  source: z.literal('https://www.mdbg.net/chinese/dictionary?page=cedict'),
  license: z.literal('https://creativecommons.org/licenses/by-sa/4.0/'),
  snapshotDate: z.iso.datetime(), snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  traditional: shortText(200), simplified: shortText(200), numberedPinyin: shortText(200), definition: shortText(4000),
})
export type DictionaryCitation = z.infer<typeof dictionaryCitationSchema>
export const dictionaryCitationKey = (citation: DictionaryCitation) => JSON.stringify([citation.snapshotSha256, citation.traditional, citation.simplified, citation.numberedPinyin, citation.definition])
