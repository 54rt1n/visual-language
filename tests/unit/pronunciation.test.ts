import { describe, expect, it } from 'vitest'
import { pronunciationChoices, pronunciationFor, pronunciationOverlay, validateContextualPinyin } from '../../src/lib/mandarin/pronunciation'
import type { SavedDraft } from '../../src/lib/domain/workspace'

function note(id: string, text: string, start: number, pinyin: string | null, createdAt = 1, uncertain = false): SavedDraft {
  return { id, kind: 'reading', status: 'validated', text: '', cardIds: [], sourceIds: [], createdAt, updatedAt: createdAt,
    generation: { provider: 'fixture', model: 'fixture', promptVersion: 'word-reading-v2', createdAt },
    reading: { nodeId: 'reply', learnerId: 'learner', sourceHash: 'a'.repeat(64), start, end: start + text.length, text,
      pinyin: '', context: text, contextStart: start, meaning: 'fixture', explanation: 'fixture', sentenceMeaning: 'fixture',
      level: 'beginner', explanationLanguage: 'English', uncertain, pronunciation: { pinyin, note: 'fixture' } } }
}

describe('contextual pronunciation compatibility and provenance', () => {
  it('exposes alternatives with source positions without asserting which meaning fits', () => {
    expect(pronunciationChoices('🙂 还得地')).toEqual([
      { text: '还', start: 3, end: 4, readings: ['hái', 'huán'] },
      { text: '得', start: 4, end: 5, readings: ['dé', 'děi', 'de'] },
      { text: '地', start: 5, end: 6, readings: ['dì', 'de'] },
    ])
    expect(pronunciationChoices('𠮷')[0]?.readings).toEqual([])
    expect(() => pronunciationChoices('还'.repeat(201))).toThrow()
  })

  it.each([
    ['还书', 'huán shū'], ['还', 'hái'], ['得', 'de'], ['得', 'děi'], ['地', 'de'],
    ['一杯', 'yì bēi'], ['不是', 'bú shì'], ['孩子', 'hái zi'], ['女儿', 'nǚ ér'],
    ['哪儿', 'nǎr'], ['花兒', 'huār'], ['儿', 'r'], ['咖啡 / coffee', 'kā fēi'],
  ])('accepts compatible character readings for %s without certifying their grammatical use', (text, pinyin) => {
    expect(validateContextualPinyin(text!, pinyin!, false)).toBe(pinyin)
  })

  it.each([
    ['还书', 'hái'], ['还书', 'huán shū le'], ['咖啡', 'huán shū'], ['女', 'nu'],
    ['还', 'hǎi'], ['书', 'book'], ['还', '<script>'], ['𠮷', 'jí'], ['哪儿', 'nǎr ér'], ['coffee', 'kā fēi'],
  ])('rejects misaligned or incompatible output for %s', (text, pinyin) => {
    expect(() => validateContextualPinyin(text!, pinyin!, false)).toThrow()
  })

  it('requires explicit uncertainty for unavailable pronunciation', () => {
    expect(validateContextualPinyin('𠮷', null, true)).toBeNull()
    expect(() => validateContextualPinyin('还', null, false)).toThrow('uncertainty')
  })

  it('applies the exact saved occurrence and retains local pinyin for other occurrences', () => {
    const notes = [note('second', '还书', 4, 'huán shū')], before = structuredClone(notes), overlay = pronunciationOverlay(notes)
    expect(pronunciationFor('还', 1, 'hái', overlay)).toEqual({ pinyin: 'hái', source: 'automatic' })
    expect(pronunciationFor('还书', 4, 'hái shū', overlay)).toEqual({ pinyin: 'huán shū', source: 'model' })
    expect(pronunciationFor('有还书', 3, 'yǒu hái shū', overlay)).toEqual({ pinyin: 'yǒu huán shū', source: 'mixed' })
    expect(notes).toEqual(before)
  })

  it('newer uncertainty or invalid data never keeps an obsolete confident suggestion', () => {
    for (const newer of [note('uncertain', '还', 4, null, 2, true), note('invalid', '还', 4, 'coffee', 2)]) {
      expect(pronunciationFor('还', 4, 'hái', pronunciationOverlay([newer, note('older', '还', 4, 'huán')]))).toEqual({ pinyin: 'hái', source: 'automatic' })
    }
  })

  it('keeps contracted erhua together instead of manufacturing a separate spoken syllable', () => {
    const overlay = pronunciationOverlay([note('erhua', '哪儿', 0, 'nǎr')])
    expect(pronunciationFor('哪儿', 0, 'nǎ ér', overlay)).toEqual({ pinyin: 'nǎr', source: 'model' })
    expect(pronunciationFor('哪', 0, 'nǎ', overlay)).toEqual({ pinyin: 'nǎ', source: 'automatic' })
    expect(pronunciationFor('儿', 1, 'ér', overlay)).toEqual({ pinyin: 'ér', source: 'automatic' })
  })
})
