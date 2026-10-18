import { describe, expect, it } from 'vitest'
import { decodeReadingCase, numberedSyllable, readingCases, readingCorpus } from '../evaluation/reading-corpus'

describe('contextual pronunciation diagnostic integrity, not engine accuracy', () => {
  it('contains contrasting readings, explicit provisional status and exact source targets', () => {
    expect(readingCorpus.annotationStatus).toBe('project-authored-provisional')
    expect(readingCases.length).toBeGreaterThan(50)
    for (const entry of readingCases) expect(entry.text.slice(entry.start, entry.end)).toBe(entry.target)
    for (const [target, sounds] of [['还', ['hai2', 'huan2']], ['得', ['de2', 'de5', 'dei3']], ['地', ['di4', 'de5']]] as const) {
      expect(new Set(readingCases.filter(entry => entry.target === target).map(entry => entry.expected))).toEqual(new Set(sounds))
    }
  })
  it('addresses the marked occurrence with UTF-16 offsets, including supplementary characters', () => {
    expect(decodeReadingCase({ id: 'offset', tag: 'test', marked: '🙂 还没有▁还▁书。', expected: 'huan2' })).toMatchObject({ text: '🙂 还没有还书。', start: 6, end: 7 })
    expect(decodeReadingCase({ id: 'character', tag: 'test', marked: 'a▁𠮷▁。', expected: 'ji2' })).toMatchObject({ target: '𠮷', start: 1, end: 3 })
  })
  it('rejects unmarked, repeated-marker, non-Han and multi-character targets', () => {
    for (const marked of ['还书', '▁还▁▁书', '▁还书▁', '▁a▁']) expect(() => decodeReadingCase({ id: 'bad', tag: 'test', marked, expected: 'huan2' })).toThrow()
  })
  it('normalizes explicit tones and neutral tone without conflating them', () => {
    for (const [input, expected] of [['hái', 'hai2'], ['huán', 'huan2'], ['de', 'de5'], ['dé', 'de2'], ['děi', 'dei3'], ['lǜ', 'lü4']]) expect(numberedSyllable(input!)).toBe(expected)
    expect(numberedSyllable('')).toBe('')
  })
})
