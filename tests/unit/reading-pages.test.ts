import { beforeAll, describe, expect, it, vi } from 'vitest'
import { pinyin } from 'pinyin-pro'
import { loadReadingLexicon, type ReadingLexicon } from '../../src/lib/mandarin/lexicon'
import { readingPage, readingTokens, type ReadingToken } from '../../src/lib/mandarin/reading'

vi.mock('pinyin-pro', { spy: true })
let lexicon: ReadingLexicon
beforeAll(async () => { lexicon = await loadReadingLexicon() })

function collect(text: string, size: number, dictionary: ReadingLexicon | null = lexicon) {
  const tokens: ReadingToken[] = [], pages: ReturnType<typeof readingPage>[] = []
  for (let start = 0; start < text.length;) {
    const page = readingPage(text, start, size, dictionary ?? undefined)
    expect(page.start).toBe(start); expect(page.end).toBeGreaterThan(start)
    expect(page.tokens.map(token => token.text).join('')).toBe(text.slice(start, page.end))
    for (const token of page.tokens) expect(text.slice(token.start, token.end)).toBe(token.text)
    tokens.push(...page.tokens); pages.push(page); start = page.end
  }
  expect(tokens.map(token => token.text).join('')).toBe(text)
  return { tokens, pages }
}

describe('bounded complete-word response pages', () => {
  it.each(['图书馆', '銀行', '咖啡', '𠮷'])('does not cut %s at the old 1600-code-unit boundary', word => {
    const text = ' '.repeat(1599) + word + '。还有下一句。'
    const page = readingPage(text, 0, 1600, lexicon)
    expect(page.tokens.find(token => token.hanzi)?.text).toBe(word)
    expect(page.end).toBe(1599 + word.length)
    expect(collect(text, 1600).tokens).toEqual(readingTokens(text, lexicon).tokens)
  })

  it('continues within a refined browser collocation without duplicating or dropping either word', () => {
    const text = '我想去图书馆喝咖啡。'
    const result = collect(text, 1)
    expect(result.pages.map(page => page.tokens.map(token => token.text).join(''))).toEqual(['我', '想', '去', '图书馆', '喝', '咖啡', '。'])
    expect(result.tokens).toEqual(readingTokens(text, lexicon).tokens)
  })

  it('keeps mixed text, repeated-word offsets and contextual pinyin across page boundaries', () => {
    const text = '🙂 我想去圖書館。Coffee / 咖啡\n银行行长喜欢音乐，銀行行長也在银行工作。𠮷'
    for (const size of [1, 2, 3, 7, 15, 31]) expect(collect(text, size).tokens).toEqual(readingTokens(text, lexicon).tokens)
    const words = collect(text, 2).tokens
    expect(words.filter(token => token.text === '行长' || token.text === '行長').map(token => token.pinyin)).toEqual(['háng zhǎng', 'háng zhǎng'])
    expect(words.filter(token => token.text === '银行').map(token => token.start)).toEqual([text.indexOf('银行'), text.lastIndexOf('银行')])
  })

  it('can return to earlier pages with the same source spans and pronunciation', () => {
    const text = '我想去图书馆喝咖啡。银行行长喜欢音乐。'
    const { pages } = collect(text, 5)
    for (const prior of [...pages].reverse()) expect(readingPage(text, prior.start, 5, lexicon)).toEqual(prior)
  })

  it('retains code points and dictionary compounds when the browser segmenter is missing', () => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
    try {
      const text = '🙂我想去图书馆。𠮷'
      const withDictionary = collect(text, 1)
      expect(withDictionary.pages.every(page => page.wordsAvailable)).toBe(true)
      expect(withDictionary.tokens.map(token => token.text)).toContain('图书馆')
      const withoutDictionary = collect(text, 1, null)
      // Pass explicitly to the page helper: an unloaded reader must not silently use another reader's dictionary.
      expect(readingPage(text, 0, 1).wordsAvailable).toBe(false)
      expect(withoutDictionary.pages.every(page => !page.wordsAvailable)).toBe(true)
      expect(withoutDictionary.tokens.map(token => token.text).join('')).toBe(text)
    } finally { vi.unstubAllGlobals() }
  })

  it('does not send an entire very long Hanzi run through pinyin for a late page', () => {
    const text = '银行'.repeat(50_000)
    vi.mocked(pinyin).mockClear()
    const page = readingPage(text, 98_000, 1600, lexicon)
    expect(page.start).toBe(98_000); expect(page.end).toBe(99_600)
    expect(page.tokens).toHaveLength(800)
    expect(vi.mocked(pinyin).mock.calls).toHaveLength(1)
    expect(vi.mocked(pinyin).mock.calls[0]![0].length).toBeLessThanOrEqual(3000)
    expect(page.tokens.every(token => token.pinyin === 'yín háng')).toBe(true)
  })

  it('finishes a long non-Hanzi word instead of pretending that a sliced prefix is its whole text', () => {
    const text = 'a'.repeat(5000) + '。咖啡。', page = readingPage(text, 0, 1600, lexicon)
    expect(page.end).toBe(5000); expect(page.tokens).toHaveLength(1)
    expect(collect(text, 1600).tokens.map(token => token.text).join('')).toBe(text)
  })

  it('rejects invalid starts and sizes instead of displaying broken source spans', () => {
    expect(() => readingPage('𠮷', 1, 1600, lexicon)).toThrow('valid reading page')
    expect(() => readingPage('图书馆', 1, 1600, lexicon)).toThrow('previous reading page')
    for (const size of [0, -1, 1.5, NaN, 100_001]) expect(() => readingPage('咖啡', 0, size, lexicon)).toThrow()
    expect(() => readingPage('a'.repeat(100_001), 0, 1600, lexicon)).toThrow('too long')
    expect(readingPage('', 0, 1600, lexicon)).toMatchObject({ start: 0, end: 0, tokens: [] })
  })
})
