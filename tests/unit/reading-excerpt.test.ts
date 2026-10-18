import { describe, expect, it } from 'vitest'
import { readingExcerpt } from '../../src/lib/mandarin/readingExcerpt'

function selection(context: string, start: number, end: number, contextStart = 0) {
  return { context, contextStart, start: contextStart + start, end: contextStart + end, text: context.slice(start, end) }
}

describe('source-visible reading excerpts', () => {
  it('highlights only the selected occurrence, including a later-page source offset', () => {
    const source = '咖啡，还是咖啡。', selected = selection(source, 5, 7, 3200)
    expect(readingExcerpt(selected)).toEqual({ before: '咖啡，还是', selected: '咖啡', after: '。', leading: false, trailing: false })
    expect(selected).toEqual(selection(source, 5, 7, 3200))
  })

  it('keeps mixed text, line breaks and punctuation verbatim', () => {
    const source = 'Coffee?\n我喝咖啡！', excerpt = readingExcerpt(selection(source, 10, 12))
    expect(excerpt.before + excerpt.selected + excerpt.after).toBe(source)
    expect(excerpt.selected).toBe('咖啡')
  })

  it('clips surrounding text at whole code points without truncating a selected phrase', () => {
    const source = '𠮷🙂甲乙咖啡丙丁🙂𠮷', selected = selection(source, 6, 8)
    expect(readingExcerpt(selected, 3)).toEqual({ before: '🙂甲乙', selected: '咖啡', after: '丙丁🙂', leading: true, trailing: true })
    expect(readingExcerpt(selected, 0)).toEqual({ before: '', selected: '咖啡', after: '', leading: true, trailing: true })
    const long = '前' + '咖啡'.repeat(100) + '后'
    expect(readingExcerpt(selection(long, 1, 201)).selected).toBe('咖啡'.repeat(100))
  })

  it('rejects stale or malformed offsets instead of highlighting a different word', () => {
    const selected = selection('我喝咖啡。', 2, 4)
    expect(() => readingExcerpt({ ...selected, text: '银行' })).toThrow('source selection')
    expect(() => readingExcerpt({ ...selected, start: -1 })).toThrow()
    expect(() => readingExcerpt({ ...selected, end: 99 })).toThrow()
    expect(() => readingExcerpt({ ...selected, start: 2.5 })).toThrow()
    expect(() => readingExcerpt(selection('𠮷', 0, 1))).toThrow()
    expect(() => readingExcerpt(selection('𠮷', 1, 2))).toThrow()
    expect(() => readingExcerpt(selected, -1)).toThrow()
  })
})
