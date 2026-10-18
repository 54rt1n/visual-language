/** CC-CEDICT v1 index. Source spelling, separate readings and all senses survive. */
export type DictionaryEntry = { traditional: string; simplified: string; pinyin: string; senses: string[] }
export type DictionaryLookup = { entries: DictionaryEntry[]; related: DictionaryEntry[] }
const entryPattern = /^(\S+) (\S+) \[([^\[\]]+)\] \/(.+)\/$/u

export function createDictionaryIndex(source: string, expectedEntries?: number) {
  if (source.length > 16_000_000) throw new Error('Dictionary exceeds its expanded text limit.')
  const index = new Map<string, number[]>()
  let count = 0
  function lineAt(start: number) {
    const end = source.indexOf('\n', start)
    return source.slice(start, end < 0 ? source.length : end).replace(/\r$/, '')
  }
  function entryAt(start: number): DictionaryEntry {
    const match = entryPattern.exec(lineAt(start))!
    return { traditional: match[1]!, simplified: match[2]!, pinyin: match[3]!, senses: match[4]!.split('/') }
  }
  for (let start = 0; start < source.length;) {
    const line = lineAt(start), end = source.indexOf('\n', start)
    if (line && !line.startsWith('#')) {
      const match = entryPattern.exec(line)
      if (!match || line.length > 32_768 || match[1]!.length > 200 || match[2]!.length > 200) throw new Error('Unsupported dictionary entry.')
      if (++count > 200_000) throw new Error('Dictionary has too many entries.')
      for (const spelling of new Set([match[1]!, match[2]!])) {
        const positions = index.get(spelling) ?? []
        positions.push(start); index.set(spelling, positions)
      }
    }
    if (end < 0) break
    start = end + 1
  }
  if (!count || expectedEntries !== undefined && count !== expectedEntries) throw new Error('Dictionary entry count does not match its snapshot.')
  // CC-CEDICT capitalizes proper names. Show common readings before names;
  // preserve every entry/sense and do not use automatic pinyin to select a sense.
  const exact = (text: string) => (index.get(text) ?? []).map(entryAt).sort((a, b) => Number(/^[A-Z]/.test(a.pinyin)) - Number(/^[A-Z]/.test(b.pinyin)))
  return {
    entries: count,
    lookup(text: string): DictionaryLookup {
      if (!text || text.length > 200) return { entries: [], related: [] }
      // Do not normalize simplified/traditional characters: a many-to-one mapping
      // could conflate distinct senses. Both exact spellings were indexed above.
      const entries = exact(text), related: DictionaryEntry[] = [], seen = new Set([text])
      for (const entry of entries) for (const sense of entry.senses) {
        // Expand explicit cross-references one level, never recursively or by
        // concatenating component meanings into an invented phrase translation.
        const ref = /^(?:see|(?:old |erhua )?variant of|used in) ([\p{Script=Han}]+)(?:\|([\p{Script=Han}]+))?\[/u.exec(sense)
        const word = ref?.[2] ?? ref?.[1]
        if (word && !seen.has(word) && related.length < 12) { seen.add(word); related.push(...exact(word).slice(0, 12 - related.length)) }
      }
      return { entries, related }
    },
  }
}
