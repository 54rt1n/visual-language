import { markedPinyin } from './markedPinyin'
import { dictionaryCitationSchema, type DictionaryCitation } from '../domain/dictionaryCitation'
import type { DictionaryEntry } from './dictionaryData'
import snapshot from './dictionarySnapshot.json'

export const dictionaryPinyin = markedPinyin
export function dictionaryCapture(text: string, entry: DictionaryEntry, definition: string): { text: string; meaning: string; pinyin: string; dictionary: DictionaryCitation } {
  if (![entry.traditional, entry.simplified].includes(text) || !entry.senses.includes(definition) || /^(?:CL:|Taiwan pr\.|also pr\.)/.test(definition)) throw new Error('Choose a meaning of this exact word.')
  return { text, meaning: definition, pinyin: dictionaryPinyin(entry.pinyin), dictionary: dictionaryCitationSchema.parse({
    dictionary: 'CC-CEDICT', attribution: snapshot.publisher, source: snapshot.source, license: snapshot.license,
    snapshotDate: snapshot.date, snapshotSha256: snapshot.sha256, traditional: entry.traditional, simplified: entry.simplified,
    numberedPinyin: entry.pinyin, definition,
  }) }
}
