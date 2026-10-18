import { z } from 'zod'
import { convert } from 'pinyin-pro'
import raw from './reading-pronunciation.json'

const caseSchema = z.strictObject({ id: z.string().regex(/^[a-z0-9-]+$/), tag: z.string().min(1), marked: z.string().min(3).max(200), expected: z.string().regex(/^[a-zü]+[1-5]$/u) })
export function decodeReadingCase(value: unknown) {
  const entry = caseSchema.parse(value), pieces = entry.marked.split('▁')
  if (pieces.length !== 3 || !/^\p{Script=Han}$/u.test(pieces[1]!)) throw new Error('Mark exactly one complete Han character with two ▁ delimiters.')
  const [before, target, after] = pieces as [string, string, string]
  return { ...entry, text: before + target + after, target, start: before.length, end: before.length + target.length }
}
export const readingCorpus = z.strictObject({
  version: z.literal('reading-pronunciation-v1'), annotationStatus: z.literal('project-authored-provisional'), scope: z.string(),
  references: z.array(z.strictObject({ id: z.string(), url: z.url(), note: z.string() })), cases: z.array(caseSchema).min(1),
}).parse(raw)
export const readingCases = readingCorpus.cases.map(decodeReadingCase)
if (new Set(readingCases.map(entry => entry.id)).size !== readingCases.length) throw new Error('Reading diagnostic IDs must be unique.')

/** Single-syllable comparison only; neutral tone is numbered 5 in this corpus. */
export function numberedSyllable(value: string) {
  const converted = convert(value.trim().normalize('NFC').toLowerCase(), { format: 'symbolToNum' }).replace(/0$/, '5')
  return /^[a-zü]+$/u.test(converted) ? converted + '5' : converted
}
