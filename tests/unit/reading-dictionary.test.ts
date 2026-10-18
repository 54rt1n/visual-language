import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import snapshot from '../../src/lib/mandarin/dictionarySnapshot.json'
import { createDictionaryIndex } from '../../src/lib/mandarin/dictionaryData'
import { createDictionaryClient, lookupConciseDefinition } from '../../src/lib/mandarin/dictionary'
import { decodeDictionaryArchive } from '../../src/lib/mandarin/dictionaryArchive'

let dictionary: ReturnType<typeof createDictionaryIndex>
beforeAll(() => {
  const archive = readFileSync(`public/dictionaries/${snapshot.file}`)
  expect(archive.length).toBe(snapshot.bytes)
  expect(createHash('sha256').update(archive).digest('hex')).toBe(snapshot.sha256)
  const expanded = gunzipSync(archive)
  expect(expanded.length).toBe(snapshot.expandedBytes)
  expect(expanded.toString()).toContain(`#! license=${snapshot.license}`)
  dictionary = createDictionaryIndex(expanded.toString(), snapshot.entries)
})
afterEach(() => vi.useRealTimers())

describe('real pinned English dictionary', () => {
  it('accepts raw gzip and HTTP-decoded delivery, with exact integrity checks on both', () => {
    const archive = readFileSync(`public/dictionaries/${snapshot.file}`), expanded = gunzipSync(archive)
    expect(decodeDictionaryArchive(archive)).toBe(expanded.toString())
    expect(decodeDictionaryArchive(expanded)).toBe(expanded.toString())
    for (const bytes of [archive, expanded]) {
      expect(() => decodeDictionaryArchive(bytes.subarray(0, bytes.length - 1))).toThrow('integrity')
      const corrupt = new Uint8Array(bytes); corrupt[100] = corrupt[100]! ^ 1
      expect(() => decodeDictionaryArchive(corrupt)).toThrow('integrity')
    }
  })
  it.each([
    ['图书馆', 'library'], ['圖書館', 'library'], ['银行', 'bank'], ['銀行', 'bank'],
    ['咖啡', '(loanword) coffee'], ['学习', 'to learn; to study'], ['还书', 'return books'],
  ])('provides exact senses for %s without model output', (word, meaning) => {
    expect(dictionary.lookup(word).entries.flatMap(entry => entry.senses)).toContain(meaning)
  })
  it('retains distinct pronunciations and senses rather than trusting automatic pinyin', () => {
    const entries = dictionary.lookup('还').entries
    expect(entries.map(entry => entry.pinyin)).toEqual(['hai2', 'huan2', 'Huan2'])
    expect(entries.find(entry => entry.pinyin === 'huan2')?.senses).toContain('to return')
    expect(entries.find(entry => entry.pinyin === 'hai2')?.senses).toContain('still')
    expect(dictionary.lookup('得').entries.map(entry => entry.pinyin)).toEqual(['de2', 'de4', 'de5', 'dei3'])
  })
  it('does not conflate traditional spellings or invent phrase meanings from components', () => {
    expect(dictionary.lookup('乾').entries.every(entry => entry.traditional === '乾' || entry.simplified === '乾')).toBe(true)
    expect(dictionary.lookup('乾').entries.some(entry => entry.traditional === '幹')).toBe(false)
    for (const text of ['我想喝咖啡', '', '字'.repeat(201), '<script>alert(1)</script>']) expect(dictionary.lookup(text)).toEqual({ entries: [], related: [] })
  })
  it('retains all entries and supplies actual referenced words without recursive expansion', () => {
    expect(dictionary.entries).toBe(snapshot.entries)
    const result = dictionary.lookup('麟')
    expect(result.entries.length).toBeGreaterThan(0)
    expect(result.related.some(entry => entry.simplified === '麒麟')).toBe(true)
    const cyclic = createDictionaryIndex('甲 甲 [jia3] /see 乙[yi3]/\n乙 乙 [yi3] /see 甲[jia3]/')
    expect(cyclic.lookup('甲').related.map(entry => entry.simplified)).toEqual(['乙'])
  })
  it('explains a browser-grouped particle expression without inventing an exact dictionary entry', async () => {
    expect(dictionary.lookup('好的').entries).toEqual([])
    const definition = await lookupConciseDefinition('好的', async text => dictionary.lookup(text))
    expect(definition).toMatchObject({ kind: 'components' })
    expect(definition?.meaning).toContain('好 — good; appropriate; proper; all right!')
    expect(definition?.meaning).toContain('的 — attributive or sentence particle')
  })
  it('decomposes another short grouped phrase into the fewest longest real entries', async () => {
    expect(dictionary.lookup('多少钱').entries).toEqual([])
    const definition = await lookupConciseDefinition('多少钱', async text => dictionary.lookup(text))
    expect(definition).toMatchObject({ kind: 'components' })
    expect(definition?.meaning).toContain('多少 — number; amount; somewhat; how much?; how many?')
    expect(definition?.meaning).toContain('钱 — coin; money')
  })
  it('accepts CRLF and an unterminated last line, preserves slash senses and rejects corrupt snapshots', () => {
    const input = '# fixture\r\n圖書館 图书馆 [tu2 shu1 guan3] /library/CL:家[jia1]/'
    expect(createDictionaryIndex(input, 1).lookup('图书馆').entries[0]?.senses).toEqual(['library', 'CL:家[jia1]'])
    expect(() => createDictionaryIndex(input, 2)).toThrow('entry count')
    expect(() => createDictionaryIndex('garbage')).toThrow('Unsupported dictionary')
    expect(() => createDictionaryIndex('# empty')).toThrow('entry count')
  })
})

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: unknown[] = []
  terminate = vi.fn()
  postMessage = (message: unknown) => { this.messages.push(message) }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent) }
}
describe('shared off-thread dictionary client', () => {
  it('waits for readiness, keeps concurrent occurrences distinct and ignores late IDs', async () => {
    const worker = new FakeWorker(), client = createDictionaryClient(() => worker as unknown as Worker, 'https://local.example/dictionary.gz')
    const coffee = client.lookup('咖啡'), bank = client.lookup('银行')
    expect(worker.messages).toEqual([{ type: 'load', url: 'https://local.example/dictionary.gz' }])
    worker.emit({ type: 'ready' }); await Promise.resolve()
    expect(worker.messages.slice(1)).toEqual([{ type: 'lookup', id: 1, text: '咖啡' }, { type: 'lookup', id: 2, text: '银行' }])
    worker.emit({ type: 'result', id: 999, result: null })
    worker.emit({ type: 'result', id: 2, result: dictionary.lookup('银行') })
    worker.emit({ type: 'result', id: 1, result: dictionary.lookup('咖啡') })
    expect(await coffee).toEqual(dictionary.lookup('咖啡')); expect(await bank).toEqual(dictionary.lookup('银行'))
    expect(await client.lookup('字'.repeat(201))).toEqual({ entries: [], related: [] })
  })
  it('terminates and rejects all readers when loading fails, without a hidden retry loop', async () => {
    const worker = new FakeWorker(), client = createDictionaryClient(() => worker as unknown as Worker, '/dictionary.gz')
    const result = client.lookup('字'), rejected = expect(result).rejects.toThrow('unavailable')
    worker.emit({ type: 'error' }); await rejected
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    await expect(client.lookup('银行')).rejects.toThrow('unavailable')
    expect(worker.messages).toHaveLength(1)
  })
  it('bounds both startup and lookup waits and ignores output after termination', async () => {
    vi.useFakeTimers()
    for (const ready of [false, true]) {
      const worker = new FakeWorker(), client = createDictionaryClient(() => worker as unknown as Worker, '/dictionary.gz')
      const result = client.lookup('银行'), rejected = expect(result).rejects.toThrow('unavailable')
      if (ready) worker.emit({ type: 'ready' })
      await vi.advanceTimersByTimeAsync(ready ? 5_000 : 25_000)
      await rejected
      worker.emit({ type: 'ready' }); worker.emit({ type: 'result', id: 1, result: dictionary.lookup('银行') })
      expect(worker.terminate).toHaveBeenCalledTimes(1)
    }
  })
})
