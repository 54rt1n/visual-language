import { pinyin } from 'pinyin-pro'
import { containsHanzi } from './chineseParser'
import { currentReadingLexicon, refineWordBoundaries, type ReadingLexicon, type WordPart } from './lexicon'

export type ReadingToken = { text: string; start: number; end: number; hanzi: boolean; pinyin: string }

/** Browser word boundaries, not regex Hanzi runs. Offsets always address the unchanged source. */
export function readingTokens(text: string, lexicon: ReadingLexicon | undefined = currentReadingLexicon()): { tokens: ReadingToken[]; wordsAvailable: boolean } {
  const { tokens, wordsAvailable } = readingPage(text, 0, Math.max(1, text.length), lexicon)
  return { tokens, wordsAvailable }
}

function characterBoundary(text: string, offset: number, direction: -1 | 1) {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/u.test(text[offset]!) ? offset + direction : offset
}

/** Page endpoints are complete refined words, never a sliced prefix fed to the segmenter.
 * Continue from a previous page's end. All token offsets address the full source.
 */
export function readingPage(text: string, start: number, size = 1600, lexicon?: ReadingLexicon): { tokens: ReadingToken[]; wordsAvailable: boolean; start: number; end: number } {
  if (text.length > 100_000) throw new Error('This response is too long for word view.')
  if (!Number.isInteger(start) || start < 0 || start > text.length || characterBoundary(text, start, -1) !== start || !Number.isInteger(size) || size < 1 || size > 100_000) throw new Error('Choose a valid reading page.')
  const browserWords = typeof Intl.Segmenter === 'function'
  const wordsAvailable = browserWords || Boolean(lexicon)
  const target = Math.min(text.length, start + size), stop = Math.min(text.length, target + (lexicon?.maxLength ?? 1))
  const basic: WordPart[] = []
  if (browserWords) {
    // Give Intl the whole response, even though only a small section is materialized.
    const segments = new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text)
    if (typeof segments.containing === 'function') {
      for (let cursor = start; cursor < stop;) {
        const segment = segments.containing(cursor)
        if (!segment) break
        basic.push({ text: segment.segment, start: segment.index }); cursor = segment.index + segment.segment.length
      }
    } else {
      for (const segment of segments) {
        if (segment.index >= stop) break
        if (segment.index + segment.segment.length > start) basic.push({ text: segment.segment, start: segment.index })
      }
    }
  } else {
    let cursor = start
    for (const char of text.slice(start)) {
      if (cursor >= stop) break
      basic.push({ text: char, start: cursor }); cursor += char.length
    }
  }
  const parts = (lexicon ? refineWordBoundaries(basic, lexicon) : basic).filter(part => part.start + part.text.length > start && part.start < target)
  if (parts[0] && parts[0].start !== start) throw new Error('Continue from the end of the previous reading page.')
  const end = parts.at(-1) ? parts.at(-1)!.start + parts.at(-1)!.text.length : start
  // Keep Hanzi context on BOTH sides of a page, without reprocessing a huge run.
  // This is still automatic dictionary-based pinyin, not grammatical certification.
  const readings = new Map<number, string>()
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    if (match.index >= end) break
    if (match.index + match[0].length <= start) continue
    const from = characterBoundary(text, Math.max(match.index, start - 700), -1)
    const to = characterBoundary(text, Math.min(match.index + match[0].length, end + 700), 1)
    const context = text.slice(from, to)
    let offset = from
    for (const part of pinyin(lexicon?.normalize(context) ?? context, { type: 'all', toneType: 'symbol' })) {
      if (offset >= end) break
      if (offset >= start) readings.set(offset, part.isZh ? part.pinyin : '')
      offset += part.origin.length
    }
  }
  return { wordsAvailable, start, end, tokens: parts.map(part => {
    const end = part.start + part.text.length, sounds: string[] = []
    let offset = part.start, known = true
    for (const char of part.text) {
      if (containsHanzi(char)) { const sound = readings.get(offset); if (!sound) known = false; else sounds.push(sound) }
      offset += char.length
    }
    return { ...part, end, hanzi: containsHanzi(part.text), pinyin: known ? sounds.join(' ') : '' }
  }) }
}

/** A bounded sentence window for a selected word OR a learner-expanded phrase. */
export function readingSelection(text: string, start: number, end: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length || end - start > 200 || text.length > 100_000) throw new Error('Choose a word or short phrase from this response.')
  const word = text.slice(start, end)
  if (!containsHanzi(word) || /^[\uDC00-\uDFFF]/.test(word) || /[\uD800-\uDBFF]$/.test(word)) throw new Error('Choose complete Mandarin characters.')
  const before = text.slice(Math.max(0, start - 700), start)
  const boundary = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('\n'), before.lastIndexOf('!'), before.lastIndexOf('?'))
  const contextStart = start - before.length + boundary + 1
  const after = text.slice(end, end + 700), next = after.search(/[。！？!?\n]/u)
  const context = text.slice(contextStart, end + (next < 0 ? after.length : next + 1))
  const tokens = readingTokens(context).tokens
  const relativeStart = start - contextStart, relativeEnd = end - contextStart
  // Preserve contextual pronunciation even when the selection crosses word boundaries.
  let offset = contextStart
  const syllables: string[] = []
  let known = true
  for (const part of pinyin(currentReadingLexicon()?.normalize(context) ?? context, { type: 'all', toneType: 'symbol' })) {
    if (offset >= start && offset < end && containsHanzi(part.origin)) {
      if (!part.isZh || !part.pinyin) known = false
      else syllables.push(part.pinyin)
    }
    offset += part.origin.length
  }
  return { text: word, start, end, contextStart, context, pinyin: known ? syllables.join(' ') : '',
    wordBoundary: tokens.some(t => t.start === relativeStart && t.end === relativeEnd) }
}
