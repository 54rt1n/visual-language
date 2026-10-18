import { describe, expect, it } from 'vitest'
import { readingExcerptIssue } from '../../src/lib/learning/sourceExcerpt'

const source = '展览结束后，请分类投放垃圾。纸张可以回收利用，所以请放进回收箱。'
describe('reading example provenance', () => {
  it('accepts source clauses and phrases with surrounding punctuation or layout changes', () => {
    for (const excerpt of ['「请分类投放垃圾。」', '纸张可以回收利用。', '回收利用', '纸张 可以回收利用，所以请放进回收箱。']) {
      expect(readingExcerptIssue(excerpt, source)).toBeNull()
    }
  })
  it('rejects the observed new-material example, added locations, and disjoint spans', () => {
    for (const excerpt of ['塑料瓶可以回收利用。', '请在出口处分类投放垃圾。', '纸张可以回收利用，请分类投放垃圾。', '。']) {
      expect(readingExcerptIssue(excerpt, source)).toContain('contiguous excerpt')
    }
    expect(readingExcerptIssue('纸张可以回收利用。', undefined)).toContain('saved source passage')
  })
  it('does not claim to prove that a cropped excerpt retains its full contextual meaning', () => {
    // Provenance alone cannot catch a misleading crop that drops negation.
    // Generation instructions and semantic review must retain qualifiers.
    expect(readingExcerptIssue('可以回收利用', '这类材料不可以回收利用。')).toBeNull()
  })
})
