/** A pinned local lexical inventory; no text is sent to a segmentation service. */
export interface ReadingLexicon {
  frequency(text: string): number | undefined
  normalize(text: string): string
  maxLength: number
}

let loaded: ReadingLexicon | undefined
let pending: Promise<ReadingLexicon> | undefined
export const currentReadingLexicon = () => loaded

export function loadReadingLexicon(): Promise<ReadingLexicon> {
  if (loaded) return Promise.resolve(loaded)
  if (pending) return pending
  let timeout: ReturnType<typeof setTimeout>
  const loading = Promise.race([
    Promise.all([import('@pinyin-pro/data/modern'), import('@pinyin-pro/data/traditional')]),
    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('The local word dictionary could not load. Basic word view is still available.')), 15_000) }),
  ]).then(([modern, traditional]) => {
    const words = new Map(Object.entries(modern.default).map(([word, entry]) => [word, Array.isArray(entry) && typeof entry[1] === 'number' && entry[1] > 0 ? entry[1] : 1e-10]))
    const normalize = (text: string) => [...text].map(char => {
      const simplified = traditional.default[char]
      // Never let dictionary normalization change source-addressing lengths.
      return simplified?.length === char.length ? simplified : char
    }).join('')
    loaded = { normalize, frequency: text => words.get(normalize(text)), maxLength: [...words.keys()].reduce((max, word) => Math.max(max, word.length), 0) }
    return loaded
  }).finally(() => { clearTimeout(timeout); pending = undefined })
  pending = loading
  return loading
}

export type WordPart = { text: string; start: number }
const hanWord = (text: string) => /^\p{Script=Han}+$/u.test(text)
// These are grammatical heads, not a list of sentence-specific corrections.
// Only separate a browser collocation when its prefix is a pronoun or modal;
// a dictionary's missing entry is NOT evidence that an ordinary word should split.
const grammaticalHeads = ['我们', '你们', '他们', '她们', '它们', '咱们', '自己', '应该', '可以', '必须', '能够', '我', '你', '您', '他', '她', '它', '想', '要', '能', '会']

/**
 * Refine whole browser tokens, never substrings inside an established word.
 * Join dictionary compounds (图书 / 馆), then split unknown collocations (我想)
 * only when every resulting unit is in the lexicon. Unknown names stay intact.
 * Traditional spelling is normalized for lookup only; source text is untouched.
 */
export function refineWordBoundaries(parts: WordPart[], lexicon: ReadingLexicon): WordPart[] {
  const result: WordPart[] = []
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (!hanWord(part.text)) { result.push(part); continue }
    let combined = part.text, longest = part.text, through = i
    for (let j = i + 1; j < parts.length && hanWord(parts[j]!.text); j++) {
      combined += parts[j]!.text
      if (combined.length > lexicon.maxLength) break
      if (lexicon.frequency(combined) !== undefined) { longest = combined; through = j }
    }
    i = through
    if (lexicon.frequency(longest) !== undefined || longest.length > 100 || !grammaticalHeads.some(head => longest.startsWith(head) && longest.length > head.length)) {
      result.push({ text: longest, start: part.start }); continue
    }

    // Most probable complete lexical decomposition, not an arbitrary character split.
    const offsets = [0]
    for (const char of longest) offsets.push(offsets.at(-1)! + char.length)
    const best = new Map<number, { score: number; next: number }>([[longest.length, { score: 0, next: longest.length }]])
    for (const from of offsets.slice(0, -1).reverse()) {
      for (const to of offsets) {
        if (to <= from || to - from > lexicon.maxLength) continue
        const suffix = best.get(to), frequency = lexicon.frequency(longest.slice(from, to))
        if (!suffix || frequency === undefined) continue
        const score = Math.log(frequency) + suffix.score
        if (!best.has(from) || score > best.get(from)!.score) best.set(from, { score, next: to })
      }
    }
    if (!best.has(0)) { result.push({ text: longest, start: part.start }); continue }
    for (let from = 0; from < longest.length;) {
      const to = best.get(from)!.next
      result.push({ text: longest.slice(from, to), start: part.start + from }); from = to
    }
  }
  return result
}
