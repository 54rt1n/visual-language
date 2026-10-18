import { describe, expect, it } from 'vitest'
import { readingHistory, readingSourceStatus, searchReadingHistory, type ReadingDraft } from '../../src/lib/mandarin/readingHistory'
import { sha256Hex } from '../../src/lib/crypto'
import { workspaceFixture } from './fixtures'

const sentence = '我喜欢咖啡，也想喝咖啡。'
async function fixture() {
  const state = workspaceFixture(), sourceHash = await sha256Hex(sentence)
  state.nodes.push({ id: 'reply', rootId: 'root', type: 'assistant', position: { x: 0, y: 200 }, bookmarked: false, collapsed: false,
    data: { text: sentence, reasoning: '', state: 'complete', error: '', provider: 'fixture', model: 'fixture' } })
  const draft: ReadingDraft = { id: 'first', kind: 'reading', status: 'validated', text: '', cardIds: [], sourceIds: [], createdAt: 1, updatedAt: 1,
    generation: { provider: 'fixture', model: 'fixture', promptVersion: 'word-reading-v2', createdAt: 1 },
    reading: { nodeId: 'reply', learnerId: 'learner', sourceHash, start: 3, end: 5, text: '咖啡', pinyin: 'kā fēi', contextStart: 0, context: sentence,
      meaning: 'coffee', explanation: 'A drink.', sentenceMeaning: 'I like coffee and would like to drink coffee.', uncertain: false, level: 'beginner', explanationLanguage: 'English',
      pronunciation: { pinyin: 'kā fēi', note: 'Both syllables have a first tone.' } } }
  state.drafts.push(draft)
  return { state, draft }
}

describe('saved explanation history', () => {
  it('groups versions newest first without merging repeated occurrences or changing records', async () => {
    const { state, draft } = await fixture()
    const newer = structuredClone(draft); newer.id = 'newer'; newer.createdAt = 2; newer.reading.meaning = 'coffee, the drink'
    const repeated = structuredClone(newer); repeated.id = 'repeated'; repeated.createdAt = 3; repeated.reading.start = 9; repeated.reading.end = 11
    state.drafts.push(newer, repeated)
    const before = structuredClone(state), groups = readingHistory(state)
    expect(groups.map(group => group.latest.id)).toEqual(['repeated', 'newer'])
    expect(groups[1]?.versions.map(version => version.id)).toEqual(['newer', 'first'])
    expect(groups[1]?.id).toBe('first')
    expect(state).toEqual(before)
  })

  it('retains separate histories for changed source text, levels and explanation languages', async () => {
    const { state, draft } = await fixture()
    for (const [id, change] of Object.entries({ source: { sourceHash: 'f'.repeat(64) }, intermediate: { level: 'intermediate' as const }, language: { explanationLanguage: 'Spanish' } })) {
      const copy = structuredClone(draft); copy.id = id; Object.assign(copy.reading, change); state.drafts.push(copy)
    }
    expect(readingHistory(state)).toHaveLength(4)
  })

  it('does not mix another learner or unrelated draft kinds into the library', async () => {
    const { state, draft } = await fixture()
    const other = structuredClone(draft); other.id = 'other'; other.reading.learnerId = 'another-learner'
    state.drafts.push(other, { id: 'composer', kind: 'composer', text: 'coffee', cardIds: [], sourceIds: [], createdAt: 3, updatedAt: 3 })
    expect(readingHistory(state).map(group => group.latest.id)).toEqual(['first'])
    state.activeLearnerId = 'another-learner'
    expect(readingHistory(state).map(group => group.latest.id)).toEqual(['other'])
  })

  it('searches Hanzi, tone-insensitive pinyin, sentence, meaning and contextual pronunciation notes', async () => {
    const { state } = await fixture(), groups = readingHistory(state)
    for (const query of ['咖啡', 'KA FEI', 'coffee drink', 'first tone', '我喜欢', 'would like']) expect(searchReadingHistory(groups, query)).toHaveLength(1)
    expect(searchReadingHistory(groups, 'not present')).toEqual([])
    expect(searchReadingHistory(groups, '')).toEqual(groups)
  })

  it('points an older-version match to its retained text without labeling it latest', async () => {
    const { state, draft } = await fixture()
    draft.reading.explanation = 'The earlier beverage explanation.'
    const newer = structuredClone(draft); newer.id = 'new'; newer.createdAt = 2; newer.reading.explanation = 'The revised use.'; newer.reading.uncertain = true
    state.drafts.push(newer)
    const found = searchReadingHistory(readingHistory(state), 'earlier beverage')
    expect(found[0]?.match.id).toBe('first'); expect(found[0]?.latest.id).toBe('new')
    expect(found[0]?.latest.reading.uncertain).toBe(true)
  })

  it('retains legacy notes without invented contextual pronunciation', async () => {
    const { state, draft } = await fixture(); delete draft.reading.pronunciation
    expect(readingHistory(state)[0]?.latest.reading.pronunciation).toBeUndefined()
    expect(searchReadingHistory(readingHistory(state), 'ka fei')).toHaveLength(1)
  })

  it('distinguishes unchanged, edited and removed source responses without dropping frozen notes', async () => {
    const { state, draft } = await fixture()
    expect(await readingSourceStatus(state, draft)).toMatchObject({ kind: 'unchanged', nodeId: 'reply' })
    const node = state.nodes.find(node => node.id === 'reply')!; if (node.type === 'assistant') node.data.text = 'A changed response.'
    expect(await readingSourceStatus(state, draft)).toMatchObject({ kind: 'changed', nodeId: 'reply' })
    state.nodes = state.nodes.filter(node => node.id !== 'reply')
    expect(await readingSourceStatus(state, draft)).toEqual({ kind: 'missing' })
    expect(readingHistory(state)[0]?.latest.reading.context).toBe(sentence)
    expect(searchReadingHistory(readingHistory(state), 'coffee')).toHaveLength(1)
  })

  it('checks the selected source span in addition to a declared matching hash', async () => {
    const { state, draft } = await fixture(); draft.reading.text = '银行'
    expect(await readingSourceStatus(state, draft)).toMatchObject({ kind: 'changed' })
  })
})
