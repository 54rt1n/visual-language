import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readingSelection, readingTokens } from '../../src/lib/mandarin/reading'
import { ReadingService } from '../../src/lib/mandarin/readingService'
import { readingHistory, readingSourceStatus, type ReadingDraft } from '../../src/lib/mandarin/readingHistory'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { defaultSettings } from '../../src/lib/settings'
import { LearningService } from '../../src/lib/learning/learningService'
import type { TeacherHost } from '../../src/lib/teacher/teacherService'
import type { ChatResult } from '../../src/lib/ai/types'
import { nid } from '../../src/lib/id'
import { DAY } from '../../src/lib/learning/leitner'
import { NOW, workspaceFixture, exerciseProposal } from './fixtures'

const repositories: WorkspaceRepository[] = []
afterEach(() => { repositories.splice(0).forEach(r => r.close()); vi.restoreAllMocks() })
const response = '我想喝咖啡，谢谢。银行行长喜欢音乐。'
const explanation = { meaning: 'coffee', explanation: '咖啡 is the drink you want after 喝 (to drink).', sentenceMeaning: 'I would like to drink coffee, thank you.', uncertain: false,
  pronunciation: { pinyin: 'kā fēi', note: 'Both syllables have a level first tone.' } }
const result = (value: unknown): ChatResult => ({ content: JSON.stringify(value), reasoning: '', model: 'reading-fixture', finishReason: 'stop', toolCalls: [] })

describe('Mandarin response word boundaries', () => {
  it('separates actual multi-character words, retains all punctuation and exact UTF-16 offsets', () => {
    const text = '🙂 我想喝咖啡，谢谢。 English\n銀行也有咖啡。', parsed = readingTokens(text)
    expect(parsed.wordsAvailable).toBe(true)
    expect(parsed.tokens.map(t => t.text).join('')).toBe(text)
    expect(parsed.tokens.filter(t => t.hanzi).map(t => t.text)).toContain('咖啡')
    expect(parsed.tokens.filter(t => t.hanzi).map(t => t.text)).toContain('谢谢')
    for (const token of parsed.tokens) expect(text.slice(token.start, token.end)).toBe(token.text)
    const repeated = parsed.tokens.filter(t => t.text === '咖啡')
    expect(repeated).toHaveLength(2); expect(repeated[0]!.start).not.toBe(repeated[1]!.start)
  })
  it('uses contextual readings for polyphonic words and permits phrase expansion', () => {
    const parsed = readingTokens(response)
    expect(parsed.tokens.find(t => t.text === '银行')?.pinyin).toBe('yín háng')
    expect(parsed.tokens.find(t => t.text === '行长')?.pinyin).toBe('háng zhǎng')
    expect(parsed.tokens.find(t => t.text === '音乐')?.pinyin).toBe('yīn yuè')
    const start = response.indexOf('银行'), phrase = readingSelection(response, start, start + 4)
    expect(phrase.text).toBe('银行行长'); expect(phrase.pinyin).toBe('yín háng háng zhǎng')
    expect(phrase.context).toBe('银行行长喜欢音乐。')
  })
  it('does not invent pinyin for unsupported characters', () => {
    expect(readingTokens('𠮷').tokens[0]).toMatchObject({ text: '𠮷', start: 0, end: 2, pinyin: '' })
    expect(() => readingSelection('𠮷', 0, 1)).toThrow('complete')
    expect(() => readingSelection('𠮷', 1, 2)).toThrow()
  })
  it('labels character fallback honestly when word segmentation is missing', () => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
    try { const parsed = readingTokens('你好🙂'); expect(parsed.wordsAvailable).toBe(false); expect(parsed.tokens.map(t => t.text)).toEqual(['你', '好', '🙂']) }
    finally { vi.unstubAllGlobals() }
  })
  it('bounds selection windows without altering source offsets', () => {
    const text = 'a'.repeat(2000) + '咖啡' + 'b'.repeat(2000)
    const selection = readingSelection(text, 2000, 2002)
    expect(selection.context.length).toBeLessThanOrEqual(1600)
    expect(selection.context.slice(selection.start - selection.contextStart, selection.end - selection.contextStart)).toBe('咖啡')
    for (const [start, end] of [[-1, 2], [2, 1], [0, 500], [0.5, 2], [0, 9999]]) expect(() => readingSelection(text, start!, end!)).toThrow()
    expect(() => readingTokens('a'.repeat(100_001))).toThrow()
  })
})

async function setup(source = response, selected = '咖啡') {
  const state = workspaceFixture()
  state.nodes.push({ id: 'reply', rootId: 'root', type: 'assistant', position: { x: 0, y: 200 }, bookmarked: false, collapsed: false,
    data: { text: source, reasoning: '', state: 'complete', error: '', provider: 'fixture', model: 'fixture' } })
  state.edges.push({ id: 'edge', source: 'root', target: 'reply', data: { kind: 'conversation' } })
  state.view.composerDraft = 'Preserve this unsent draft.'
  const repository = await WorkspaceRepository.open({ name: nid('reading-test'), initial: () => state, broadcast: false }); repositories.push(repository)
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(command) { snapshot = await command(snapshot, repository); return snapshot } }
  const settings = defaultSettings(); settings.selected = 'featherless'; settings.profiles.featherless.apiKey = 'reading-test-secret'; settings.profiles.featherless.keyOrigin = 'https://api.featherless.ai'
  const transport = vi.fn(async () => result(explanation)), service = new ReadingService(host, () => settings, transport, () => NOW)
  const start = source.indexOf(selected), explain = (signal?: AbortSignal, refresh = false) => service.explain('reply', source, start, start + selected.length, signal, refresh)
  const mutate = (change: (value: typeof state) => void) => host.apply((s, r) => r.mutate(s.version, { id: nid('op'), kind: 'fixture', intent: {}, at: NOW }, change))
  return { repository, host, settings, transport, service, start, explain, mutate }
}

describe('contextual word explanations without enrollment', () => {
  it('reads a saved chunk locally and uses its source branch approval for an explicit explanation', async () => {
    const h = await setup(), text = '我想喝咖啡。'
    await h.mutate(state => {
      state.nodes.push({ id: 'chunk', rootId: 'root', type: 'chunk', position: { x: 300, y: 200 }, bookmarked: false, collapsed: false,
        data: { text, pinyin: 'wǒ xiǎng hē kā fēi', meaning: '', originalWordSegments: [{ text, startIndex: 0, endIndex: text.length, pinyin: 'wǒ xiǎng hē kā fēi' }] } },
      { id: 'model', rootId: 'root', type: 'modelConfig', position: { x: 0, y: 0 }, bookmarked: false, collapsed: false,
        data: { provider: 'featherless', model: 'chunk-branch', temperature: 0.7, maxTokens: 1000, requiresReview: true } })
      state.edges.push({ id: 'chunk-edge', source: 'reply', target: 'chunk', data: { kind: 'derived' } }, { id: 'model-edge', source: 'model', target: 'reply', data: { kind: 'context' } })
    })
    expect(await h.service.saved('chunk', text, 3, 5)).toBeUndefined()
    await expect(h.service.explain('chunk', text, 3, 5)).rejects.toThrow('Review the imported model')
    expect(h.transport).not.toHaveBeenCalled()
    await h.mutate(state => { const node = state.nodes.find(n => n.id === 'model')!; if (node.type === 'modelConfig') delete node.data.requiresReview })
    const before = h.host.current().state, note = await h.service.explain('chunk', text, 3, 5)
    expect(note.reading).toMatchObject({ nodeId: 'chunk', text: '咖啡', start: 3, end: 5, context: text })
    expect(note.reading).not.toHaveProperty('anchorId')
    const request = h.transport.mock.calls[0]![0] as unknown as { model: string; messages: { role: string; content: string }[] }
    expect(request.model).toBe('chunk-branch')
    expect(JSON.parse(request.messages.find(m => m.role === 'user')!.content).sentence).toBe(text)
    for (const field of ['nodes', 'edges', 'cards', 'items', 'events', 'sessions'] as const) expect(h.host.current().state[field]).toEqual(before[field])
    expect(await readingSourceStatus(h.host.current().state, note as ReadingDraft)).toMatchObject({ kind: 'unchanged', nodeId: 'chunk' })
    h.settings.profiles.featherless.apiKey = ''
    expect((await h.service.explain('chunk', text, 3, 5)).id).toBe(note.id)
    expect(h.transport).toHaveBeenCalledTimes(1)
    await h.mutate(state => { state.nodes = state.nodes.filter(n => n.id !== 'chunk'); state.edges = state.edges.filter(e => e.target !== 'chunk') })
    expect(await readingSourceStatus(h.host.current().state, note as ReadingDraft)).toEqual({ kind: 'missing' })
    expect(readingHistory(h.host.current().state)).toHaveLength(1)
  })
  it('rejects a chunk explanation when its conversation source changes while the model responds', async () => {
    const h = await setup()
    await h.mutate(state => {
      state.nodes.push({ id: 'chunk', rootId: 'root', type: 'chunk', position: { x: 300, y: 200 }, bookmarked: false, collapsed: false, data: { text: '咖啡', pinyin: 'kā fēi', meaning: '' } })
      state.edges.push({ id: 'chunk-edge', source: 'reply', target: 'chunk', data: { kind: 'derived' } })
    })
    h.transport.mockImplementation(async () => { await h.mutate(state => { state.edges.find(e => e.id === 'chunk-edge')!.source = 'root' }); return result(explanation) })
    await expect(h.service.explain('chunk', '咖啡', 0, 2)).rejects.toThrow('changed')
    expect(h.host.current().state.drafts).toHaveLength(0)
    expect(h.host.current().state.cards).toHaveLength(0)
  })
  it('saves one reusable note with provenance and survives a keyless backup without learning or graph mutations', async () => {
    const h = await setup(), before = h.host.current().state
    expect(await h.service.saved('reply', response, h.start, h.start + 2)).toBeUndefined(); expect(h.transport).not.toHaveBeenCalled()
    const draft = await h.explain(), after = h.host.current().state
    expect(draft.reading).toMatchObject({ ...explanation, text: '咖啡', pinyin: 'kā fēi', nodeId: 'reply' })
    expect(draft.generation).toMatchObject({ provider: 'featherless', model: 'reading-fixture' })
    for (const collection of ['nodes', 'edges', 'items', 'cards', 'events', 'attempts', 'sessions', 'exercises', 'view'] as const) expect(after[collection]).toEqual(before[collection])
    const request = h.transport.mock.calls[0]![0] as unknown as { messages: unknown; tools?: unknown; temperature: number }
    expect(request.tools).toBeUndefined(); expect(request.temperature).toBe(0.2)
    expect(JSON.stringify(request.messages)).not.toContain('reading-test-secret'); expect(JSON.stringify(request.messages)).not.toContain('Preserve this unsent draft')
    h.settings.profiles.featherless.apiKey = ''
    expect((await h.explain()).id).toBe(draft.id); expect(h.transport).toHaveBeenCalledTimes(1)
    const backup = parseBackup(JSON.stringify(exportBackup(h.host.current(), NOW)))
    expect(backup.data.drafts.find(d => d.id === draft.id)).toEqual(draft)
    expect(JSON.stringify(backup)).not.toContain('reading-test-secret')
  })
  it('keeps different occurrences and source edits distinct', async () => {
    const h = await setup(); await h.explain()
    await h.mutate(state => { const node = state.nodes.find(n => n.id === 'reply')!; if (node.type === 'assistant') node.data.text += '咖啡。' })
    await expect(h.explain()).rejects.toThrow('changed')
    const text = response + '咖啡。'
    expect(await h.service.saved('reply', text, h.start, h.start + 2)).toBeUndefined()
    expect(await h.service.saved('reply', text, text.lastIndexOf('咖啡'), text.lastIndexOf('咖啡') + 2)).toBeUndefined()
  })
  it('repairs malformed output once, never accepts extra grading fields', async () => {
    const h = await setup()
    h.transport.mockResolvedValue(result({ ...explanation, box: 5 }))
    await expect(h.explain()).rejects.toThrow('complete word explanation')
    expect(h.transport).toHaveBeenCalledTimes(2); expect(h.host.current().state.drafts).toHaveLength(0)
  })
  it('never spends a format-repair request after a storage failure', async () => {
    const h = await setup()
    const failed: TeacherHost = { current: h.host.current, apply: async () => { throw new Error('Quota exceeded') } }
    await expect(new ReadingService(failed, () => h.settings, h.transport).explain('reply', response, h.start, h.start + 2)).rejects.toThrow('Quota')
    expect(h.transport).toHaveBeenCalledTimes(1)
  })
  it('rejects late output after cancellation, source deletion, or workspace replacement', async () => {
    for (const reason of ['cancel', 'delete', 'replace']) {
      const h = await setup(), controller = new AbortController()
      h.transport.mockImplementation(async () => {
        if (reason === 'cancel') controller.abort()
        if (reason === 'delete') await h.mutate(state => { state.nodes = state.nodes.filter(n => n.id !== 'reply'); state.edges = [] })
        if (reason === 'replace') await h.host.apply((s, r) => r.replace(s.version, s.state))
        return result(explanation)
      })
      await expect(h.explain(controller.signal)).rejects.toThrow()
      expect(h.host.current().state.drafts.filter(d => d.kind === 'reading')).toHaveLength(0)
    }
  })
  it('blocks fresh and saved source explanations during independent recall', async () => {
    const h = await setup(); await h.explain()
    let now = NOW; const learning = new LearningService(h.repository, { now: () => now })
    await h.host.apply(s => learning.addItem(s, { language: 'zh', kind: 'word', canonicalText: '咖啡', meaning: 'coffee', senseKey: 'drink', sourceNodeIds: ['reply'], sourceRootIds: ['root'] }))
    const card = h.host.current().state.cards[0]!
    await h.host.apply(s => learning.introduce(s, card.id)); now += DAY
    await h.host.apply(s => learning.startSession(s))
    await h.host.apply(s => learning.prepareExercise(s, s.state.sessions[0]!.id, card.id, exerciseProposal({ expectedAnswer: '咖啡', prompt: 'Write coffee in Mandarin.' })))
    await expect(h.explain()).rejects.toThrow('explicitly reveal help')
    await expect(h.service.notes('reply', response)).rejects.toThrow('explicitly reveal help')
    expect(readingHistory(h.host.current().state)).toEqual([])
    expect(h.transport).toHaveBeenCalledTimes(1)
  })

  it('saves a compact contextual pronunciation rather than overwriting the automatic guess', async () => {
    const source = '我还没有还书。', h = await setup(source, '还书')
    h.transport.mockResolvedValue(result({ meaning: 'return the book', explanation: '还书 is the action of giving a borrowed book back.', sentenceMeaning: 'I have not returned the book yet.', uncertain: false,
      pronunciation: { pinyin: 'huán shū', note: '还 means return here, so it is huán, not hái (still).' } }))
    const draft = await h.explain()
    expect(draft.reading?.pinyin).toBe('hái shū') // Preserve the original automatic result as provenance.
    expect(draft.reading?.pronunciation?.pinyin).toBe('huán shū')
    expect(draft.generation?.promptVersion).toBe('word-reading-v2')
    expect((await h.service.notes('reply', source)).map(note => note.id)).toEqual([draft.id])
    expect(h.host.current().state.cards).toHaveLength(0); expect(h.host.current().state.events).toHaveLength(0)
    expect(h.host.current().state.nodes.find(node => node.id === 'reply')?.data).toMatchObject({ text: source })
    const request = h.transport.mock.calls[0]![0] as unknown as { messages: { content: string }[] }
    expect(request.messages[0]!.content).toContain('about 30 words')
    expect(request.messages[0]!.content).toContain('FROM ITS MEANING AND GRAMMAR')
    expect(request.messages[0]!.content).toContain('"maxLength":360')
  })

  it('repairs incompatible pronunciation or excessive detail once instead of saving it', async () => {
    for (const bad of [{ ...explanation, pronunciation: { pinyin: 'huán shū', note: 'Wrong characters.' } }, { ...explanation, explanation: 'x'.repeat(361) }]) {
      const h = await setup()
      h.transport.mockResolvedValueOnce(result(bad)).mockResolvedValueOnce(result(explanation))
      expect((await h.explain()).reading?.pronunciation?.pinyin).toBe('kā fēi')
      expect(h.transport).toHaveBeenCalledTimes(2)
      expect(h.host.current().state.drafts).toHaveLength(1)
    }
  })

  it('updates legacy notes only explicitly, preserves both versions and reuses the latest keylessly', async () => {
    const h = await setup(), first = await h.explain()
    await h.mutate(state => { delete state.drafts[0]!.reading!.pronunciation })
    const legacy = h.host.current().state.drafts[0]!
    expect((await h.explain()).id).toBe(first.id); expect(h.transport).toHaveBeenCalledTimes(1)
    const next = await h.explain(undefined, true)
    expect(next.id).not.toBe(first.id); expect(next.createdAt).toBeGreaterThan(first.createdAt)
    expect(h.host.current().state.drafts.find(draft => draft.id === first.id)).toEqual(legacy)
    expect(h.host.current().state.drafts).toHaveLength(2)
    expect((await h.service.notes('reply', response)).map(note => note.id)).toEqual([next.id])
    h.settings.profiles.featherless.apiKey = ''
    expect((await h.explain()).id).toBe(next.id); expect(h.transport).toHaveBeenCalledTimes(2)
    const restored = parseBackup(JSON.stringify(exportBackup(h.host.current(), NOW)))
    expect(restored.data.drafts).toHaveLength(2)
    expect(restored.data.drafts.find(draft => draft.id === next.id)?.reading?.pronunciation).toEqual(explanation.pronunciation)
  })

  it('canceled updates keep the previous explanation, and changed preferences hide cached pronunciation', async () => {
    const h = await setup(), first = await h.explain(), controller = new AbortController()
    h.transport.mockImplementation(async () => { controller.abort(); return result(explanation) })
    await expect(h.explain(controller.signal, true)).rejects.toThrow()
    expect((await h.explain()).id).toBe(first.id); expect(h.host.current().state.drafts).toHaveLength(1)
    await h.mutate(state => { state.learners[0]!.level = 'intermediate' })
    expect(await h.service.notes('reply', response)).toHaveLength(0)
  })

  it('does not replace a newer explicit refresh with an older request finishing late', async () => {
    const h = await setup(), first = await h.explain()
    let finish!: (value: ChatResult) => void
    h.transport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const slow = h.explain(undefined, true)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const newer = await h.explain(undefined, true)
    finish(result({ ...explanation, explanation: 'Late stale explanation.' }))
    await expect(slow).rejects.toThrow('updated while Zheng was responding')
    expect(h.host.current().state.drafts.map(draft => draft.id)).toEqual([first.id, newer.id])
    expect((await h.explain()).id).toBe(newer.id)
    expect(h.host.current().state.view.composerDraft).toBe('Preserve this unsent draft.')
  })

  it('rechecks cached-note access if the source changes while its hash is being computed', async () => {
    const h = await setup(); await h.explain()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }), digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => { await gate; return digest(...args) })
    const pending = h.service.saved('reply', response, h.start, h.start + 2)
    await h.mutate(state => { const node = state.nodes.find(n => n.id === 'reply')!; if (node.type === 'assistant') node.data.text = 'A different response.' })
    release()
    await expect(pending).rejects.toThrow('changed')
    expect(h.transport).toHaveBeenCalledTimes(1)
    expect(h.host.current().state.drafts).toHaveLength(1)
  })

  it('does not apply a note with mismatched frozen characters even if a backup declares the same hash', async () => {
    const h = await setup(); await h.explain()
    await h.mutate(state => {
      const note = state.drafts[0]!.reading!
      note.context = note.context.replace('咖啡', '银行'); note.text = '银行'; note.pinyin = 'yín háng'
      note.pronunciation = { pinyin: 'yín háng', note: 'Fixture for a different word.' }
    })
    expect(await h.service.saved('reply', response, h.start, h.start + 2)).toBeUndefined()
    expect(await h.service.notes('reply', response)).toHaveLength(0)
    expect((await h.explain()).reading?.text).toBe('咖啡')
    expect(h.host.current().state.drafts).toHaveLength(2)
    expect(h.transport).toHaveBeenCalledTimes(2)
  })
})
