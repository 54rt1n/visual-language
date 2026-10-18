/** Browser port of G2pW's window/token mapping, not a correction dictionary. */
export type ModelMetadata = { version: number; vocabulary: string[]; sounds: string[]; chars: string[]; candidates: number[][]; s2t: Record<string, string> }
export type ReadingRange = { start: number; end: number }
export type ModelTarget = ReadingRange & { text: string; charId: number; position: number; candidates: number[] }
export type ModelInput = { ids: number[]; targets: ModelTarget[] }
export type LocalPronunciation = ReadingRange & { text: string; pinyin: string; confidence: number }

export function createReadingModelInput(data: ModelMetadata) {
  if (data.version !== 1 || data.sounds.length !== 1305 || data.chars.length !== 3582 || data.candidates.length !== data.chars.length || data.vocabulary[101] !== '[CLS]' || data.vocabulary[2533] !== '得' || data.vocabulary[6917] !== '還') throw new Error('Unsupported pronunciation metadata.')
  const vocab = new Map(data.vocabulary.map((token, id) => [token, id])), chars = new Map(data.chars.map((char, id) => [char, id]))
  function wordpiece(raw: string) {
    // Upstream groups ASCII alphanumerics; every other code point is a separate
    // BasicTokenizer input. Empty/control inputs become UNK in its mapping helper.
    const word = raw.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[\p{Cc}\p{Cf}\p{Z}\uFFFD]/gu, '')
    if (!word || word.length > 100) return [100]
    const result: number[] = []
    for (let start = 0; start < word.length;) {
      let found = false
      for (let end = word.length; end > start; end--) {
        const id = vocab.get((start ? '##' : '') + word.slice(start, end))
        if (id !== undefined) { result.push(id); start = end; found = true; break }
      }
      if (!found) return [100]
    }
    return result
  }
  return (source: string, ranges: ReadingRange[]): ModelInput[] => {
    if (typeof source !== 'string' || source.length > 100_000 || !Array.isArray(ranges) || ranges.length > 256 || ranges.some(r => !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end <= r.start || r.end > source.length || r.end - r.start > 200 || /^[\uDC00-\uDFFF]/u.test(source.slice(r.start, r.end)) || /[\uD800-\uDBFF]$/u.test(source.slice(r.start, r.end)))) throw new Error('Choose complete short reading spans.')
    let offset = 0
    const points = [...source].map(text => { const start = offset; offset += text.length; const normalized = data.s2t[text] ?? text; return { text, start, end: offset, normalized: [...normalized].length === 1 ? normalized : text } })
    const groups = new Map<string, ModelInput>(); let targets = 0
    for (let query = 0; query < points.length; query++) {
      const point = points[query]!, charId = chars.get(point.normalized)
      if (charId === undefined || !ranges.some(range => point.start >= range.start && point.end <= range.end)) continue
      if (++targets > 256) throw new Error('Check at most 256 characters at a time.')
      const begin = Math.max(0, query - 16), end = Math.min(points.length, query + 16), ids = [101]
      let position = -1
      for (let i = begin; i < end;) {
        if (points[i]!.normalized === ' ') { i++; continue }
        const from = i; let word = points[i++]!.normalized
        if (/^[A-Za-z0-9]$/u.test(word)) while (i < end && /^[A-Za-z0-9]$/u.test(points[i]!.normalized)) word += points[i++]!.normalized
        if (query >= from && query < i) position = ids.length
        ids.push(...wordpiece(word))
      }
      ids.push(102)
      if (position < 1 || ids[position] !== vocab.get(point.normalized)) continue
      const key = ids.join(','), group = groups.get(key) ?? { ids, targets: [] }
      group.targets.push({ text: point.text, start: point.start, end: point.end, charId, position, candidates: data.candidates[charId]! }); groups.set(key, group)
    }
    return [...groups.values()]
  }
}
