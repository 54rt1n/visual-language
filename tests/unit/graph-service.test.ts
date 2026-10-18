import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { nid } from '../../src/lib/id'
import { GraphService, conversationAnchor, deletionScope, hiddenNodes, learningPreferencesForCard } from '../../src/lib/graph/graphService'
import { canvasGraph, updateGraphFromCanvas } from '../../src/lib/graph/canvas'
import { effectiveConfiguration } from '../../src/lib/graph/contracts'
import { wordExplanationRequest } from '../../src/lib/ai/wordExplanation'
import { searchLearningHistory } from '../../src/lib/search/searchService'
import { validateGraph } from '../../src/lib/graph/contracts'
import { conversationRequest } from '../../src/lib/ai/conversation'
import { teacherContext, teacherProvider } from '../../src/lib/teacher/teacherContext'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { LearningService } from '../../src/lib/learning/learningService'
import { DAY } from '../../src/lib/learning/leitner'
import { defaultSettings } from '../../src/lib/settings'
import { graphNodeSchema } from '../../src/lib/domain/graph'
import { exerciseProposal, NOW, workspaceFixture } from './fixtures'

const repositories: WorkspaceRepository[] = []
afterEach(() => { repositories.forEach(r => r.close()); repositories.length = 0 })
function initial() {
  const state = workspaceFixture()
  state.nodes.push(graphNodeSchema.parse({ id: 'user', type: 'user', rootId: 'root', position: { x: 0, y: 200 }, data: { text: 'Teach thanks.' }, bookmarked: false, collapsed: false }),
    graphNodeSchema.parse({ id: 'assistant', type: 'assistant', rootId: 'root', position: { x: 0, y: 400 }, data: { text: '谢谢 means thank you.', reasoning: '', state: 'complete', error: '', provider: 'fixture', model: 'fixture' }, bookmarked: false, collapsed: false }))
  state.edges.push({ id: 'root-user', source: 'root', target: 'user', data: { kind: 'conversation' } }, { id: 'user-assistant', source: 'user', target: 'assistant', data: { kind: 'conversation' } })
  return state
}
async function setup() {
  const repository = await WorkspaceRepository.open({ name: nid('graph-test'), initial, broadcast: false }); repositories.push(repository)
  const clock = { at: NOW, now() { return this.at } }, graph = new GraphService(repository, clock), learning = new LearningService(repository, clock)
  return { repository, clock, graph, learning, snapshot: await repository.snapshot() }
}
describe('durable graph controls and branch context', () => {
  it('creates/renames/switches topics and preserves flags and hidden records through canvas serialization', async () => {
    const h = await setup()
    let current = await h.graph.editText(h.snapshot, 'root', 'Everyday Mandarin')
    current = await h.graph.setFlag(current, 'assistant', 'bookmarked', true)
    current = await h.graph.setFlag(current, 'root', 'collapsed', true)
    const canvas = canvasGraph(current.state)
    expect(canvas.nodes.find(n => n.id === 'assistant')?.hidden).toBe(true)
    const copied = structuredClone(current.state)
    updateGraphFromCanvas(copied, canvas.nodes, canvas.edges, 'Keep this draft.', current.state.view.viewport)
    expect(copied.nodes).toHaveLength(3)
    expect(copied.nodes.find(n => n.id === 'assistant')!.bookmarked).toBe(true)
    expect(copied.nodes[0]!.collapsed).toBe(true)
    current = await h.graph.createTopic(current, 'Travel')
    expect(current.state.nodes.filter(n => n.type === 'root')).toHaveLength(2)
    expect(current.state.view.activeRootId).not.toBe('root')
    const newTopicId = current.state.view.activeRootId, nextCanvas = canvasGraph(current.state)
    expect(nextCanvas.nodes.filter(n => !n.hidden).map(n => n.id)).toEqual([newTopicId])
    expect(nextCanvas.edges.every(e => e.hidden)).toBe(true)
    const retained = structuredClone(current.state)
    updateGraphFromCanvas(retained, nextCanvas.nodes, nextCanvas.edges, '', current.state.view.viewport)
    expect(retained.nodes).toEqual(current.state.nodes)
    expect(retained.edges).toEqual(current.state.edges)
    current = await h.graph.reveal(current, 'assistant')
    expect(current.state.view).toMatchObject({ activeRootId: 'root', selectedNodeIds: ['assistant'] })
    expect([...hiddenNodes(current.state)]).toEqual([newTopicId])
    expect(parseBackup(JSON.stringify(exportBackup(current))).data.nodes).toEqual(current.state.nodes)
  })
  it('edits conversation text without rewriting saved meanings, sources or existing reply history', async () => {
    const h = await setup()
    let current = await h.learning.addItem(h.snapshot, { language: 'zh', kind: 'phrase', canonicalText: '谢谢', pinyin: 'xiè xie', senseKey: 'thanks', meaning: 'thank you', sourceNodeIds: ['assistant'], sourceRootIds: ['root'] })
    const before = structuredClone(current.state)
    current = await h.graph.editText(current, 'assistant', 'An edited local explanation.')
    expect(current.state.items).toEqual(before.items); expect(current.state.sources).toEqual(before.sources); expect(current.state.cards).toEqual(before.cards)
    expect(current.state.nodes.find(n => n.id === 'assistant')!.data).toMatchObject({ text: 'An edited local explanation.', editedAt: NOW, model: 'fixture' })
    const canvas = canvasGraph(current.state), copied = structuredClone(current.state)
    updateGraphFromCanvas(copied, canvas.nodes, canvas.edges, '', current.state.view.viewport)
    expect(copied.nodes.find(n => n.id === 'assistant')!.data).toMatchObject({ editedAt: NOW })
  })
  it('deletes only the confirmed subtree with tombstones, retaining pending learning and missing-source context', async () => {
    const h = await setup()
    let current = await h.learning.addItem(h.snapshot, { language: 'zh', kind: 'phrase', canonicalText: '谢谢', senseKey: 'thanks', meaning: 'thank you', sourceNodeIds: ['assistant'], sourceRootIds: ['root'] })
    const cardId = current.state.cards[0]!.id
    current = await h.learning.introduce(current, cardId); h.clock.at += DAY
    current = await h.learning.startSession(current)
    current = await h.learning.prepareExercise(current, current.state.sessions[0]!.id, cardId, exerciseProposal())
    current = await h.learning.saveAnswerDraft(current, current.state.exercises[0]!.id, '谢谢')
    const before = structuredClone(current.state), scope = deletionScope(current.state, 'assistant')
    expect(scope.nodeIds).toHaveLength(3) // reply, chunk and graph exercise; not durable exercise record.
    current = await h.graph.deleteSubtree(current, 'assistant', scope.nodeIds)
    for (const collection of ['items', 'cards', 'exercises', 'attempts', 'sessions', 'events', 'drafts', 'sources'] as const) expect(current.state[collection]).toEqual(before[collection])
    expect(current.state.nodes.map(n => n.id)).toEqual(['root', 'user'])
    expect(current.state.tombstones).toHaveLength(scope.nodeIds.length + scope.edgeIds.length)
    expect(current.state.tombstones.every(t => current.state.operations.some(o => o.id === t.operationId))).toBe(true)
    expect(teacherContext(current.state, cardId, h.clock.at).item.canonicalText).toBe('谢谢')
    expect(parseBackup(JSON.stringify(exportBackup(current))).data).toEqual(current.state)
  })
  it('refuses changed deletion scopes and deleting the last topic without writes', async () => {
    const h = await setup(), scope = deletionScope(h.snapshot.state, 'root')
    await expect(h.graph.deleteSubtree(h.snapshot, 'root', scope.nodeIds)).rejects.toThrow('at least one topic')
    await expect(h.graph.deleteSubtree(h.snapshot, 'assistant', ['different-node'])).rejects.toThrow('scope changed')
    expect((await h.repository.snapshot()).state).toEqual(h.snapshot.state)
    const current = await h.graph.createTopic(h.snapshot, 'Retained topic')
    const removed = await h.graph.deleteSubtree(current, 'root', deletionScope(current.state, 'root').nodeIds)
    expect(removed.state.nodes).toHaveLength(1); expect(removed.state.view.activeRootId).not.toBe('root')
  })
  it('selects the retained prompt after deleting its selected reply, preserving conversation ancestry', async () => {
    const h = await setup(), selected = await h.graph.reveal(h.snapshot, 'assistant')
    const removed = await h.graph.deleteSubtree(selected, 'assistant', deletionScope(selected.state, 'assistant').nodeIds)
    expect(removed.state.view).toMatchObject({ activeRootId: 'root', selectedNodeIds: ['user'] })
    const settings = defaultSettings(); settings.selected = 'custom'
    settings.profiles.custom = { baseUrl: 'https://fixture.example/v1', model: 'fixture', apiKey: 'fixture-key', keyOrigin: 'https://fixture.example' }
    const request = conversationRequest(removed.state, settings, removed.state.view.selectedNodeIds[0]!)
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'Teach thanks.' })
    expect(removed.state.nodes.find(node => node.id === 'user')).toEqual(selected.state.nodes.find(node => node.id === 'user'))
    expect(parseBackup(JSON.stringify(exportBackup(removed))).data.view.selectedNodeIds).toEqual(['user'])
  })
  it('resolves per-kind overrides on the trigger and uses approved provider settings for conversation and teacher', async () => {
    const h = await setup(), settings = defaultSettings()
    settings.profiles.custom = { baseUrl: 'https://fixture.example/v1', model: 'default', apiKey: 'custom-fixture-secret', keyOrigin: 'https://fixture.example' }
    let current = await h.graph.setConfiguration(h.snapshot, 'root', 'systemConfig', { prompt: 'Root learner instruction.' })
    current = await h.graph.setConfiguration(current, 'assistant', 'systemConfig', { prompt: 'Nearest learner instruction. Include pinyin and an English translation.' })
    current = await h.graph.setConfiguration(current, 'user', 'modelConfig', { provider: 'custom', model: 'branch-model', temperature: 0.2, maxTokens: 500 })
    current = await h.graph.setConfiguration(current, 'root', 'vocabularyConfig', { words: ['谢谢', '帮助'], instruction: 'Use these phrases naturally.' })
    const { id: _id, ...profile } = current.state.learners[0]!
    current = await h.graph.setConfiguration(current, 'assistant', 'learningConfig', { ...profile, level: 'intermediate', pinyinDisplay: 'always' })
    const request = conversationRequest(current.state, settings, 'assistant', 'user')
    expect(request).toMatchObject({ provider: 'custom', model: 'branch-model', apiKey: 'custom-fixture-secret', temperature: 0.2, maxTokens: 500 })
    expect(request.messages).toHaveLength(2)
    expect(request.messages[0]!.content).toContain('Nearest learner instruction.')
    expect(request.messages[0]!.content).not.toContain('Root learner instruction.')
    expect(request.messages[0]!.content).toContain('"level":"intermediate"')
    expect(request.messages[0]!.content).toContain('Output only Mandarin Chinese written in Hanzi')
    expect(request.messages[0]!.content).toContain('Do not output pinyin, romanization, Latin letters, English')
    expect(request.messages[0]!.content).not.toContain('"pinyinDisplay"')
    expect(request.messages[0]!.content).not.toContain('"explanationLanguage"')
    expect(request.messages[0]!.content).not.toContain('"languageBalance"')
    expect(request.messages[0]!.content.lastIndexOf('This output contract overrides')).toBeGreaterThan(request.messages[0]!.content.indexOf('Nearest learner instruction.'))
    expect(JSON.stringify(request.messages)).not.toContain('custom-fixture-secret')
    current = await h.learning.addItem(current, { language: 'zh', kind: 'phrase', canonicalText: '谢谢', senseKey: 'thanks', meaning: 'thank you', sourceNodeIds: ['assistant'], sourceRootIds: ['root'] })
    const cardId = current.state.cards[0]!.id, context = teacherContext(current.state, cardId, NOW)
    expect(teacherProvider(settings, context)).toMatchObject({ model: 'branch-model', provider: 'custom' })
    expect(learningPreferencesForCard(current.state, cardId).pinyinDisplay).toBe('always')
    const chunk = current.state.nodes.find(n => n.type === 'chunk')!
    expect(conversationAnchor(current.state, chunk.id)?.id).toBe('assistant')
    settings.profiles.custom.baseUrl = 'https://unapproved.example/v1'
    expect(() => conversationRequest(current.state, settings, 'assistant')).toThrow('not been approved')
  })
  it('branch-local edits do not mutate a setting shared with another target', async () => {
    const h = await setup()
    let current = await h.graph.setConfiguration(h.snapshot, 'user', 'systemConfig', { prompt: 'Shared instruction.' })
    const sharedId = effectiveConfiguration('user', current.state.nodes, current.state.edges).systemConfig!.id
    current = await h.repository.mutate(current.version, { id: 'shared-link', kind: 'fixture', intent: {}, at: NOW }, s => { s.edges.push({ id: 'shared-assistant', source: sharedId, target: 'assistant', data: { kind: 'context' } }) })
    current = await h.graph.setConfiguration(current, 'assistant', 'systemConfig', { prompt: 'This reply branch only.' })
    expect(effectiveConfiguration('assistant', current.state.nodes, current.state.edges).systemConfig!.id).not.toBe(sharedId)
    expect(effectiveConfiguration('user', current.state.nodes, current.state.edges).systemConfig!.data).toMatchObject({ prompt: 'Shared instruction.' })
    current = await h.graph.removeConfiguration(current, 'assistant', 'systemConfig')
    expect(effectiveConfiguration('assistant', current.state.nodes, current.state.edges).systemConfig!.id).toBe(sharedId)
    current = await h.graph.setFlag(current, 'user', 'collapsed', true)
    expect(hiddenNodes(current.state).has(sharedId)).toBe(false) // Its directly attached user remains visible.
    expect(hiddenNodes(current.state).has('assistant')).toBe(true)
    current = await h.graph.reveal(current, 'assistant')
    expect(hiddenNodes(current.state).size).toBe(0)
  })
  it('topic-root settings supply a new scoped session while all-topic sessions keep global limits', async () => {
    const h = await setup(), { id: _id, ...global } = h.snapshot.state.learners[0]!
    let current = await h.graph.setConfiguration(h.snapshot, 'root', 'learningConfig', { ...global, goal: 'Order tea.', maxReviewCards: 2, maxNewItems: 1 })
    current = await h.learning.startSession(current, 'root')
    expect(current.state.sessions[0]).toMatchObject({ goal: 'Order tea.', maxReviewCards: 2, maxNewItems: 1 })
    current = await h.learning.setSessionStatus(current, current.state.sessions[0]!.id, 'completed')
    current = await h.learning.startSession(current)
    expect(current.state.sessions[1]).toMatchObject({ goal: global.goal, maxReviewCards: 10, maxNewItems: 3 })
  })
})

describe('learning words on the graph', () => {
  it('freezes the selected occurrence without enrollment, deduplicates, and rejects stale source text', async () => {
    const h = await setup(), source = '谢谢 means thank you.'
    let current = await h.graph.addLearningWord(h.snapshot, 'assistant', source, 0, 2, 'xiè xie', { x: 400, y: 400 })
    const id = current.state.view.selectedNodeIds[0]!
    expect(current.state.nodes.find(n => n.id === id)?.data).toMatchObject({ text: '谢谢', pinyin: 'xiè xie', wordSource: { nodeId: 'assistant', start: 0, end: 2, context: source } })
    for (const field of ['cards', 'items', 'events', 'attempts', 'drafts'] as const) expect(current.state[field]).toEqual(h.snapshot.state[field])
    current = await h.graph.addLearningWord(current, 'assistant', source, 0, 2, 'xiè xie', { x: 900, y: 400 })
    expect(current.state.nodes.filter(n => n.type === 'chunk')).toHaveLength(1)
    current = await h.graph.editText(current, 'assistant', '谢谢。')
    await expect(h.graph.addLearningWord(current, 'assistant', source, 0, 2, 'xiè xie', { x: 900, y: 400 })).rejects.toThrow('changed')
    expect(current.state.nodes.find(n => n.id === id)?.data).toMatchObject({ wordSource: { context: source } })
  })
  it('enrolls the existing word in a lesson without creating a duplicate graph node or awarding recall', async () => {
    const h = await setup()
    let current = await h.graph.addLearningWord(h.snapshot, 'assistant', '谢谢 means thank you.', 0, 2, 'xiè xie', { x: 400, y: 400 })
    const id = current.state.view.selectedNodeIds[0]!, count = current.state.nodes.length
    current = await h.learning.addItem(current, { language: 'zh', kind: 'word', canonicalText: '谢谢', pinyin: 'xiè xie', meaning: 'thank you', senseKey: 'thanks', sourceNodeIds: [id], sourceRootIds: ['root'] })
    expect(current.state.nodes).toHaveLength(count)
    expect(current.state.nodes.find(n => n.id === id)?.data).toMatchObject({ itemId: current.state.items[0]!.id, meaning: 'thank you' })
    expect(current.state.cards[0]).toMatchObject({ status: 'new', box: 1 })
    expect(current.state.events.filter(e => e.kind === 'review')).toHaveLength(0)
  })
  it('persists partial explanations and restores them without restarting, keeping them outside chat ancestry', async () => {
    const h = await setup()
    let current = await h.graph.addLearningWord(h.snapshot, 'assistant', '谢谢 means thank you.', 0, 2, 'xiè xie', { x: 400, y: 400 })
    const wordId = current.state.view.selectedNodeIds[0]!
    current = await h.graph.addWordExplanation(current, wordId, { x: 800, y: 400 }, 'custom', 'fixture')
    const id = current.state.view.selectedNodeIds[0]!, canvas = canvasGraph(current.state), copy = structuredClone(current.state)
    Object.assign(canvas.nodes.find(n => n.id === id)!.data, { text: 'A polite expression of gratitude.', streaming: true })
    updateGraphFromCanvas(copy, canvas.nodes, canvas.edges, '', copy.view.viewport)
    expect(copy.nodes.find(n => n.id === id)?.data).toMatchObject({ state: 'interrupted', text: 'A polite expression of gratitude.' })
    const restored = parseBackup(JSON.stringify(exportBackup({ ...current, state: copy }))).data
    expect(canvasGraph(restored).nodes.find(n => n.id === id)?.data.streaming).toBe(false)
    expect(conversationAnchor(restored, id)?.id).toBe('assistant')
    expect(searchLearningHistory(restored, 'gratitude').map(result => result.nodeId)).toContain(id)
    expect(() => validateGraph(restored.nodes, restored.edges.filter(edge => edge.target !== id))).toThrow('belong')
    const settings = defaultSettings(); settings.selected = 'custom'; settings.profiles.custom = { baseUrl: 'https://fixture.example/v1', model: 'fixture', apiKey: 'key', keyOrigin: 'https://fixture.example' }
    expect(JSON.stringify(conversationRequest(restored, settings, 'assistant').messages)).not.toContain('A polite expression')
    const scope = deletionScope(restored, wordId)
    expect(scope.nodeIds).toEqual([id, wordId].sort())
  })
})


describe('word explanation requests', () => {
  it('uses frozen occurrence context, branch model and explanation language without the Hanzi-only chat contract', async () => {
    const h = await setup(), settings = defaultSettings()
    settings.selected = 'custom'; settings.profiles.custom = { baseUrl: 'https://fixture.example/v1', model: 'fixture', apiKey: 'key', keyOrigin: 'https://fixture.example' }
    let current = await h.graph.addLearningWord(h.snapshot, 'assistant', '谢谢 means thank you.', 0, 2, 'xiè xie', { x: 400, y: 400 })
    const id = current.state.view.selectedNodeIds[0]!
    current = await h.graph.setConfiguration(current, 'assistant', 'modelConfig', { provider: 'custom', model: 'branch-model', temperature: 0.8, maxTokens: 8000 })
    const { id: _id, ...preferences } = current.state.learners[0]!
    current = await h.graph.setConfiguration(current, 'assistant', 'learningConfig', { ...preferences, explanationLanguage: 'French', level: 'intermediate' })
    current = await h.graph.editText(current, 'assistant', 'An edited reply.')
    const request = wordExplanationRequest(current.state, settings, id)
    expect(request).toMatchObject({ model: 'branch-model', maxTokens: 1800, timeoutMs: 60000 })
    expect(request.messages[0]!.content).toContain('French')
    expect(request.messages[0]!.content).toContain('intermediate')
    expect(JSON.parse(request.messages[1]!.content)).toEqual({ word: '谢谢', context: '谢谢 means thank you.', startInContext: 0, endInContext: 2 })
    expect(JSON.stringify(request.messages)).not.toContain('An edited reply.')
    current = await h.graph.setConfiguration(current, 'assistant', 'modelConfig', { provider: 'custom', model: 'imported', temperature: 0.2, maxTokens: 1000, requiresReview: true })
    expect(() => wordExplanationRequest(current.state, settings, id)).toThrow()
  })
})
