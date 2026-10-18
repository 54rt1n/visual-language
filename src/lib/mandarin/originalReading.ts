import type { OriginalWordSegment } from '../domain/original'
import { containsHanzi } from './chineseParser'

/** Keep gaps and punctuation verbatim. Supplied pinyin belongs to the whole
 * original span; do not guess how to divide it among characters or new words. */
export function originalReadingTokens(text: string, segments: OriginalWordSegment[]) {
  const tokens: { text: string; start: number; end: number; hanzi: boolean; pinyin: string; imported: boolean }[] = []
  let cursor = 0
  for (const segment of segments) {
    if (cursor < segment.startIndex) tokens.push({ text: text.slice(cursor, segment.startIndex), start: cursor, end: segment.startIndex, hanzi: false, pinyin: '', imported: false })
    tokens.push({ text: segment.text, start: segment.startIndex, end: segment.endIndex, hanzi: containsHanzi(segment.text), pinyin: segment.pinyin ?? '', imported: true })
    cursor = segment.endIndex
  }
  if (cursor < text.length) tokens.push({ text: text.slice(cursor), start: cursor, end: text.length, hanzi: false, pinyin: '', imported: false })
  return tokens
}
