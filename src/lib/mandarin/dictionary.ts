import snapshot from './dictionarySnapshot.json'
import type { DictionaryEntry, DictionaryLookup } from './dictionaryData'
import { markedPinyin } from './markedPinyin'

export type { DictionaryEntry, DictionaryLookup } from './dictionaryData'
export type ConciseDictionaryDefinition = { meaning: string; pinyin?: string; kind: 'exact' | 'components' }
const unavailable = () => new Error('English dictionary unavailable. You can retry it or ask Zheng for an explanation; word view is unchanged.')
let shared: ReturnType<typeof createDictionaryClient> | undefined

const excludedSense = /^(?:CL:|Taiwan pr\.|also pr\.)/
const grammaticalEndings = new Map([
  ['的', 'attributive or sentence particle'],
  ['了', 'completed-action or changed-state particle'],
  ['吗', 'yes-or-no question particle'],
  ['呢', 'question or continuing-state particle'],
  ['吧', 'suggestion or softening particle'],
  ['啊', 'sentence-final particle'],
  ['呀', 'sentence-final particle'],
  ['嘛', 'sentence-final particle'],
])

function conciseSenses(entries: DictionaryEntry[]) {
  const senses = entries.flatMap(entry => entry.senses).filter(sense => !excludedSense.test(sense))
  return [...new Set(senses)].slice(0, 4).join('; ').slice(0, 220)
}

/** Exact CC-CEDICT meaning, then the fewest longest dictionary components for a
 * short browser-grouped phrase (for example 好的 or 多少钱). Component meanings
 * stay visibly separate; this never invents an exact whole-phrase citation.
 */
export async function lookupConciseDefinition(text: string, lookup = lookupDictionary): Promise<ConciseDictionaryDefinition | null> {
  const result = await lookup(text)
  const exact = conciseSenses(result.entries)
  if (exact) return { meaning: exact, pinyin: result.entries[0]?.pinyin ? markedPinyin(result.entries[0].pinyin) : undefined, kind: 'exact' }
  const characters = [...text]
  if (characters.length < 2 || characters.length > 4 || !characters.every(character => /^\p{Script=Han}$/u.test(character))) return null
  const ranges: Array<{ from: number; to: number; text: string }> = []
  for (let from = 0; from < characters.length; from++) for (let to = from + 1; to <= characters.length; to++) {
    if (from || to < characters.length) ranges.push({ from, to, text: characters.slice(from, to).join('') })
  }
  const unique = new Map<string, Promise<DictionaryLookup>>()
  for (const range of ranges) if (!unique.has(range.text)) unique.set(range.text, lookup(range.text))
  const results = new Map<string, DictionaryLookup>()
  await Promise.all([...unique].map(async ([word, pending]) => { results.set(word, await pending) }))
  type Component = { text: string; entries: DictionaryEntry[] }
  const best = new Map<number, { parts: Component[]; score: number }>([[characters.length, { parts: [], score: 0 }]])
  for (let from = characters.length - 1; from >= 0; from--) for (let to = characters.length; to > from; to--) {
    const word = characters.slice(from, to).join(''), entries = results.get(word)?.entries ?? [], suffix = best.get(to)
    if (!entries.length || !suffix) continue
    const candidate = { parts: [{ text: word, entries }, ...suffix.parts], score: word.length ** 2 + suffix.score }
    const current = best.get(from)
    if (!current || candidate.parts.length < current.parts.length || candidate.parts.length === current.parts.length && candidate.score > current.score) best.set(from, candidate)
  }
  const parts = best.get(0)?.parts
  if (!parts || parts.length < 2 || !parts.some(part => [...part.text].length > 1) && !grammaticalEndings.has(parts.at(-1)!.text)) return null
  const lines = parts.map((part, index) => {
    const particle = index === parts.length - 1 ? grammaticalEndings.get(part.text) : undefined
    return `${part.text} — ${particle ?? conciseSenses(part.entries)}`
  })
  return lines.every(line => !line.endsWith('— ')) ? { meaning: lines.join('\n'), kind: 'components' } : null
}

/** One worker/index per app page, with bounded waits and retry after failure. */
export function createDictionaryClient(makeWorker: () => Worker, url: string) {
  const worker = makeWorker()
  let nextId = 0, failed = false
  const requests = new Map<number, { resolve: (value: DictionaryLookup) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
  let resolveReady: () => void, rejectReady: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void ready.catch(() => {}) // A constructor/worker failure may precede a caller.
  const timeout = setTimeout(fail, 25_000)
  function fail() {
    if (failed) return
    failed = true; clearTimeout(timeout); worker.terminate(); rejectReady(unavailable())
    for (const pending of requests.values()) { clearTimeout(pending.timeout); pending.reject(unavailable()) }
    requests.clear()
  }
  worker.onerror = fail
  worker.onmessageerror = fail
  worker.onmessage = (event: MessageEvent) => {
    if (failed) return
    if (event.data?.type === 'ready') { clearTimeout(timeout); resolveReady() }
    else if (event.data?.type === 'error') fail()
    else if (event.data?.type === 'result') {
      const request = requests.get(event.data.id)
      if (!request) return
      clearTimeout(request.timeout); requests.delete(event.data.id); request.resolve(event.data.result)
    }
  }
  try { worker.postMessage({ type: 'load', url }) } catch { fail() }
  return {
    async lookup(text: string) {
      if (!text || text.length > 200) return { entries: [], related: [] }
      await ready
      if (failed) throw unavailable()
      return new Promise<DictionaryLookup>((resolve, reject) => {
        const id = ++nextId, timeout = setTimeout(fail, 5_000)
        requests.set(id, { resolve, reject, timeout })
        try { worker.postMessage({ type: 'lookup', id, text }) } catch { fail() }
      })
    },
  }
}

export async function lookupDictionary(text: string) {
  if (!text || text.length > 200) return { entries: [], related: [] }
  const client = shared ??= createDictionaryClient(
    () => new Worker(new URL('./dictionary.worker.ts', import.meta.url), { type: 'module' }),
    new URL(`${import.meta.env.BASE_URL}dictionaries/${snapshot.file}`, document.baseURI).href,
  )
  try { return await client.lookup(text) }
  catch { if (shared === client) shared = undefined; throw unavailable() }
}
