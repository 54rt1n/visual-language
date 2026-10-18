import { describe, expect, it } from 'vitest'
import metadata from '../../public/reading-model/g2pw-v2-int4-1/metadata.json'
import vectors from '../fixtures/reading-model-inputs.json'
import { createReadingModelInput } from '../../src/lib/mandarin/readingModelInput'
import { pronunciationFor } from '../../src/lib/mandarin/pronunciation'
import { markedPinyin, modelPinyin } from '../../src/lib/mandarin/markedPinyin'

describe('contextual pronunciation browser inputs', () => {
  const prepare = createReadingModelInput(metadata)
  it.each([['de5', 'de'], ['de0', 'de'], ['hai2 zi5', 'hái zi'], ['nu:3 er2', 'nǚ ér'], ['huan2 shu1', 'huán shū']])('converts numbered model/dictionary syllables without leaking neutral tone digits: %s', (input, expected) => {
    expect(markedPinyin(input)).toBe(expected)
  })
  it('does not present unmapped upstream Bopomofo labels as pinyin', () => {
    const unmapped = metadata.sounds.filter(sound => modelPinyin(sound) === undefined)
    expect(unmapped).toHaveLength(8)
    expect(unmapped.every(sound => /\p{Script=Bopomofo}/u.test(sound))).toBe(true)
    expect(modelPinyin('de5')).toBe('de')
  })
  it.each(vectors.cases)('matches independent official Python/BERT numeric inputs: $id', entry => {
    const inputs = prepare(entry.text, [{ start: entry.start, end: entry.end }])
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.ids).toEqual(entry.ids)
    const target = inputs[0]!.targets[0]!
    expect(target).toMatchObject({ start: entry.start, end: entry.end, text: entry.text.slice(entry.start, entry.end), charId: entry.charId, position: entry.position })
    expect([...target.candidates].sort((a, b) => a - b)).toEqual(entry.candidates)
  })
  it('rejects oversized, invalid and split-surrogate requests', () => {
    for (const [text, ranges] of [['🙂还', [{ start: 1, end: 3 }]], ['还', [{ start: 0, end: 2 }]], ['还'.repeat(100001), [{ start: 0, end: 1 }]], ['还'.repeat(300), [{ start: 0, end: 150 }, { start: 150, end: 300 }]]] as const) {
      expect(() => prepare(text, [...ranges])).toThrow()
    }
  })
  it('shares only identical encoder inputs and retains repeated occurrence offsets', () => {
    const text = '🙂 银行行长在银行工作。', groups = prepare(text, [{ start: 0, end: text.length }])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.targets.filter(t => t.text === '行').map(t => t.start)).toEqual([4, 5, 9])
    expect(groups[0]!.targets.every(t => text.slice(t.start, t.end) === t.text)).toBe(true)
  })
  it('keeps local predictions separate and lower priority than saved AI readings', () => {
    const local = new Map([[4, { start: 4, end: 5, pinyin: 'huán' }]])
    expect(pronunciationFor('还书', 4, 'hái shū', new Map(), local)).toEqual({ pinyin: 'huán shū', source: 'local-mixed' })
    expect(pronunciationFor('还', 4, 'hái', new Map(), local)).toEqual({ pinyin: 'huán', source: 'local' })
    expect(pronunciationFor('还', 1, 'hái', new Map(), local)).toEqual({ pinyin: 'hái', source: 'automatic' })
    expect(pronunciationFor('还', 4, 'hái', new Map([[4, { start: 4, end: 5, pinyin: 'hái' }]]), local)).toEqual({ pinyin: 'hái', source: 'model' })
  })
})
