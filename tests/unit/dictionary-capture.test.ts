import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dictionaryCapture, dictionaryPinyin } from '../../src/lib/mandarin/dictionaryCapture'
import { createDictionaryIndex } from '../../src/lib/mandarin/dictionaryData'
import snapshot from '../../src/lib/mandarin/dictionarySnapshot.json'
import { readingSourceMatches } from '../../src/lib/mandarin/captureSource'
import { dictionaryCitationSchema } from '../../src/lib/domain/dictionaryCitation'
import { LearningService } from '../../src/lib/learning/learningService'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { nid } from '../../src/lib/id'
import { NOW, workspaceFixture } from './fixtures'

let dictionary: ReturnType<typeof createDictionaryIndex>
beforeAll(() => { dictionary = createDictionaryIndex(gunzipSync(readFileSync(`public/dictionaries/${snapshot.file}`)).toString(), snapshot.entries) })
const repositories: WorkspaceRepository[] = []
afterEach(() => { for (const repository of repositories) repository.close(); repositories.length = 0 })
function fixture() {
  const state = workspaceFixture()
  state.nodes.push({ id: 'user', rootId: 'root', type: 'user', position: { x: 0, y: 100 }, bookmarked: false, collapsed: false, data: { text: 'A useful sentence, please.' } },
    { id: 'response', rootId: 'root', type: 'assistant', position: { x: 0, y: 250 }, bookmarked: false, collapsed: false,
      data: { text: '我还没有还书。', reasoning: '', state: 'complete', error: '', provider: 'fixture', model: 'fixture' } })
  state.edges.push({ id: 'ru', source: 'root', target: 'user', data: { kind: 'conversation' } }, { id: 'ua', source: 'user', target: 'response', data: { kind: 'conversation' } })
  return state
}
async function setup() {
  const repository = await WorkspaceRepository.open({ name: nid('dictionary-test'), initial: fixture, broadcast: false }); repositories.push(repository)
  return { repository, service: new LearningService(repository, { now: () => NOW }), current: await repository.snapshot() }
}
function proposal() {
  const entry = dictionary.lookup('还').entries.find(entry => entry.pinyin === 'huan2')!
  const chosen = dictionaryCapture('还', entry, 'to return')
  return { language: 'zh' as const, kind: 'word' as const, canonicalText: chosen.text, senseKey: 'return something', meaning: chosen.meaning, pinyin: chosen.pinyin,
    sourceNodeIds: ['response'], sourceRootIds: ['root'], dictionarySources: [chosen.dictionary] }
}
const guard = { nodeId: 'response', sourceText: '我还没有还书。', start: 4, end: 5 }

describe('explicit dictionary-sense capture', () => {
  it('keeps the selected reading/definition and attribution, not automatic character pinyin', () => {
    const input = proposal()
    expect(input).toMatchObject({ canonicalText: '还', meaning: 'to return', pinyin: 'huán' })
    expect(input.dictionarySources[0]).toMatchObject({ numberedPinyin: 'huan2', definition: 'to return', snapshotDate: snapshot.date, snapshotSha256: snapshot.sha256, license: snapshot.license })
    expect(dictionaryPinyin('nu:3')).toBe('nǚ')
    expect(dictionaryPinyin('hai2 zi5')).toBe('hái zi')
    const entry = dictionary.lookup('銀行').entries[0]!
    expect(dictionaryCapture('銀行', entry, 'bank').text).toBe('銀行')
    expect(() => dictionaryCapture('银行行长', entry, 'bank')).toThrow('exact word')
    expect(() => dictionaryCapture('银行', entry, 'invented meaning')).toThrow('exact word')
    expect(() => dictionaryCapture('银行', entry, entry.senses.find(sense => sense.startsWith('CL:'))!)).toThrow('exact word')
  })
  it('formats neutral tones for a new capture while preserving the original numbered citation', () => {
    const entry = dictionary.lookup('孩子').entries.find(entry => /zi5/.test(entry.pinyin))!
    const chosen = dictionaryCapture('孩子', entry, entry.senses[0]!)
    expect(chosen.pinyin).toBe('hái zi')
    expect(chosen.dictionary.numberedPinyin).toBe(entry.pinyin)
  })
  it('guards source identity, exact occurrence and the full source before a handoff', () => {
    const node = fixture().nodes.find(node => node.id === 'response')!
    expect(readingSourceMatches(node, '还', guard)).toBe(true)
    expect(readingSourceMatches(node, '还', { ...guard, start: 1, end: 2 })).toBe(true) // Separate valid occurrence.
    expect(readingSourceMatches(node, '还', { ...guard, start: 2, end: 3 })).toBe(false)
    expect(readingSourceMatches(node, '还', { ...guard, sourceText: '我还没有还书！' })).toBe(false)
    expect(readingSourceMatches({ ...node, id: 'other' }, '还', guard)).toBe(false)
    expect(readingSourceMatches(undefined, '还', guard)).toBe(false)
  })
  it('saves a new unintroduced card and edited wording with its original citation through keyless restore', async () => {
    const h = await setup(), input = { ...proposal(), meaning: 'to return something' }
    const saved = await h.service.addItem(h.current, input, ['production'], 'dictionary-capture', undefined, guard)
    expect(saved.state.items[0]).toMatchObject({ meaning: 'to return something', pinyin: 'huán', dictionarySources: input.dictionarySources })
    expect(saved.state.cards).toHaveLength(1)
    expect(saved.state.cards[0]).toMatchObject({ box: 1, status: 'new', introducedAt: null, dueAt: null, revision: 0 })
    expect(saved.state.events).toEqual([]); expect(saved.state.sessions).toEqual([]); expect(saved.state.drafts).toEqual([])
    const chunk = saved.state.nodes.find(node => node.type === 'chunk')!
    expect(chunk.data).toMatchObject({ text: '还', pinyin: 'huán', meaning: 'to return something' })
    expect(saved.state.edges.some(edge => edge.source === 'response' && edge.target === chunk.id && edge.data.kind === 'derived')).toBe(true)
    const replay = await h.service.addItem(h.current, input, ['production'], 'dictionary-capture', undefined, guard)
    expect(replay.state).toEqual(saved.state)
    const portable = parseBackup(JSON.stringify(exportBackup(saved, NOW)))
    const fresh = await setup(), restored = await fresh.repository.replace(fresh.current.version, portable.data)
    expect(restored.state.items).toEqual(saved.state.items); expect(restored.state.cards).toEqual(saved.state.cards)
  })
  it('deduplicates citations/cards without changing progress and connects a later source', async () => {
    const h = await setup(), input = proposal()
    let saved = await h.service.addItem(h.current, input)
    saved = await h.service.introduce(saved, saved.state.cards[0]!.id)
    const beforeCards = saved.state.cards, beforeEvents = saved.state.events
    saved = await h.repository.mutate(saved.version, { id: 'second-source', kind: 'fixture', at: NOW, intent: {} }, state => {
      state.nodes.push({ ...state.nodes.find(node => node.id === 'response')!, id: 'other-response' })
      state.edges.push({ id: 'other-edge', source: 'user', target: 'other-response', data: { kind: 'conversation' } })
    })
    const again = await h.service.addItem(saved, { ...input, sourceNodeIds: ['other-response'] })
    expect(again.state.cards).toEqual(beforeCards); expect(again.state.events).toEqual(beforeEvents)
    expect(again.state.items).toHaveLength(1); expect(again.state.items[0]!.dictionarySources).toHaveLength(1)
    expect(again.state.edges.some(edge => edge.source === 'other-response' && edge.data.kind === 'derived')).toBe(true)
  })
  it('does not overwrite an existing meaning or pronunciation under the same item identity', async () => {
    const h = await setup(), input = proposal()
    const saved = await h.service.addItem(h.current, { ...input, dictionarySources: undefined, pinyin: 'hái' })
    await expect(h.service.addItem(saved, input)).rejects.toThrow('different saved wording or pronunciation')
    expect((await h.repository.snapshot()).state).toEqual(saved.state)
  })
  it('checks the source again inside the transaction and writes nothing for stale context', async () => {
    const h = await setup()
    const changed = await h.repository.mutate(h.current.version, { id: 'edit-source', kind: 'fixture', at: NOW, intent: {} }, state => {
      const node = state.nodes.find(node => node.id === 'response')!; if (node.type === 'assistant') node.data.text = '我还没有还书！'
    })
    await expect(h.service.addItem(changed, proposal(), ['production'], 'stale-capture', undefined, guard)).rejects.toThrow('response changed')
    expect((await h.repository.snapshot()).state).toEqual(changed.state)
  })
  it('rejects mismatched/duplicate citations, arbitrary URLs and auth-shaped fields without state changes', async () => {
    const h = await setup(), input = proposal(), citation = input.dictionarySources[0]!
    for (const modified of [{ ...citation, source: 'https://example.com?key=secret' }, { ...citation, apiKey: 'never-store' }, { ...citation, snapshotSha256: 'invalid' }]) expect(dictionaryCitationSchema.safeParse(modified).success).toBe(false)
    await expect(h.service.addItem(h.current, { ...input, canonicalText: '银行' })).rejects.toThrow('match the saved word')
    await expect(h.service.addItem(h.current, { ...input, dictionarySources: [citation, citation] })).rejects.toThrow('distinct')
    expect((await h.repository.snapshot()).state).toEqual(h.current.state)
  })
})
