import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadReadingLexicon, refineWordBoundaries, type ReadingLexicon } from '../../src/lib/mandarin/lexicon'
import { readingSelection, readingTokens } from '../../src/lib/mandarin/reading'

let lexicon: ReadingLexicon
beforeAll(async () => { lexicon = await loadReadingLexicon() })
const words = (text: string) => readingTokens(text, lexicon).tokens.filter(token => token.hanzi).map(token => token.text)

// Project-authored regression examples, not an independent linguistic certification.
describe('local lexical support for beginner and intermediate reading', () => {
  it.each([
    ['今天我们去图书馆学习中文。', ['今天', '我们', '去', '图书馆', '学习', '中文']],
    ['我想喝咖啡，谢谢。', ['我', '想', '喝', '咖啡', '谢谢']],
    ['银行行长在银行工作。', ['银行', '行长', '在', '银行', '工作']],
    ['他正在学习中文。', ['他', '正在', '学习', '中文']],
    ['我喜欢听音乐。', ['我', '喜欢', '听', '音乐']],
    ['研究生命的起源。', ['研究', '生命', '的', '起源']],
    ['你叫什么名字？', ['你', '叫', '什么', '名字']],
    ['这个房间比那个大。', ['这个', '房间', '比', '那个', '大']],
    ['銀行行長喜歡音樂。', ['銀行', '行長', '喜歡', '音樂']],
  ] as const)('retains useful lexical units in %s', (text, expected) => { expect(words(text)).toEqual(expected) })

  it('joins split compounds and separates pronoun collocations regardless of coarse browser suggestions', () => {
    const input = ['我想', '去', '图书', '馆', '喝', '咖啡']
    let start = 0
    const parts = input.map(text => { const part = { text, start }; start += text.length; return part })
    expect(refineWordBoundaries(parts, lexicon).map(part => part.text)).toEqual(['我', '想', '去', '图书馆', '喝', '咖啡'])
    for (const part of refineWordBoundaries(parts, lexicon)) expect(input.join('').slice(part.start, part.start + part.text.length)).toBe(part.text)
  })

  it('does not treat missing dictionary entries as permission to split ordinary words or proper names', () => {
    for (const text of ['行长', '慢慢', '下雨', '北京', '长江', '𠮷野']) {
      expect(refineWordBoundaries([{ text, start: 0 }], lexicon)).toEqual([{ text, start: 0 }])
    }
    // A 市长 dictionary match must not cut into 武汉市 or 长江.
    expect(refineWordBoundaries([{ text: '武汉市', start: 0 }, { text: '长江', start: 3 }], lexicon).map(part => part.text)).toEqual(['武汉市', '长江'])
  })

  it('preserves source spelling, repeated occurrences, punctuation, whitespace, emoji and contextual readings', () => {
    const text = '🙂 我想去圖書館。图书馆 / Coffee\n銀行行長在银行工作。𠮷', parsed = readingTokens(text, lexicon)
    expect(parsed.tokens.map(token => token.text).join('')).toBe(text)
    for (const token of parsed.tokens) expect(text.slice(token.start, token.end)).toBe(token.text)
    expect(words(text)).toContain('圖書館'); expect(words(text)).toContain('图书馆')
    expect(parsed.tokens.find(token => token.text === '行長')?.pinyin).toBe('háng zhǎng')
    const start = text.indexOf('行長')
    expect(readingSelection(text, start, start + 2).pinyin).toBe('háng zhǎng')
    expect(parsed.tokens.find(token => token.text === '𠮷')?.pinyin).toBe('')
    const repeated = readingTokens('图书馆，图书馆。', lexicon).tokens.filter(token => token.text === '图书馆')
    expect(repeated.map(token => token.start)).toEqual([0, 4])
  })

  it('still recognizes common dictionary words when Intl.Segmenter is unavailable', () => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
    try {
      const parsed = readingTokens('我想去图书馆喝咖啡。🙂', lexicon)
      expect(parsed.wordsAvailable).toBe(true)
      expect(parsed.tokens.map(token => token.text)).toEqual(['我', '想', '去', '图书馆', '喝', '咖啡', '。', '🙂'])
    } finally { vi.unstubAllGlobals() }
  })

  it('reuses the same loaded local inventory and leaves pinyin-pro global dictionaries unchanged', async () => {
    expect(await loadReadingLexicon()).toBe(lexicon)
    expect(lexicon.frequency('图书馆')).toBe(lexicon.frequency('圖書館'))
    expect(lexicon.frequency('not a dictionary word')).toBeUndefined()
    // Reading's pronunciation path is deliberately separate from lexical lookup.
    expect(readingTokens('银行行长', lexicon).tokens.map(token => token.pinyin)).toEqual(['yín háng', 'háng zhǎng'])
  })
})
