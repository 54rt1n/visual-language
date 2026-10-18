import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { importOriginalGraph, previewOriginalImport } from '../../src/lib/storage/originalImport'
import { parseBackup, exportBackup, MAX_BACKUP_BYTES } from '../../src/lib/storage/backup'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { primaryPath, effectiveConfiguration } from '../../src/lib/graph/contracts'
import { canvasGraph, updateGraphFromCanvas } from '../../src/lib/graph/canvas'
import { conversationRequest } from '../../src/lib/ai/conversation'
import { defaultSettings } from '../../src/lib/settings'
import { teacherContext, teacherProvider, safeTeacherInput } from '../../src/lib/teacher/teacherContext'
import { GraphService } from '../../src/lib/graph/graphService'
import { nid } from '../../src/lib/id'
import { originalFixture } from '../fixtures/original'
import { NOW, workspaceFixture } from './fixtures'
import { originalReadingTokens } from '../../src/lib/mandarin/originalReading'

describe('explicit original-project content import', () => {
  it('retains original segment records, missing readings and gaps through canvas saves and full backups', () => {
    const original = originalFixture(), source = original.nodes.find(node => node.id === 'mandarin')!
    const text = '我喝茶，茶！🙂', segments = [
      { text: '我', startIndex: 0, endIndex: 1 }, { text: '喝茶', startIndex: 1, endIndex: 3, pinyin: 'hē chá' },
      { text: '茶', startIndex: 4, endIndex: 5, pinyin: 'chá' },
    ]
    source.data = { chunkText: text, pinyin: 'wǒ hē chá chá', sourceNodeId: 'reply', wordSegments: segments.map(s => ({ ...s, apiKey: 'OMIT-NESTED-SECRET' })) }
    const before = JSON.stringify(original), state = importOriginalGraph(before, NOW).state
    const chunk = state.nodes.find(node => node.id === 'mandarin')!
    expect(chunk.data).toMatchObject({ text, originalWordSegments: segments })
    expect(JSON.stringify(state)).not.toContain('OMIT-NESTED-SECRET')
    const rendered = originalReadingTokens(text, segments)
    expect(rendered.map(t => t.text).join('')).toBe(text)
    expect(rendered.filter(t => t.imported).map(t => [t.text, t.start, t.end, t.pinyin])).toEqual([['我', 0, 1, ''], ['喝茶', 1, 3, 'hē chá'], ['茶', 4, 5, 'chá']])
    const canvas = canvasGraph(state)
    canvas.nodes.find(node => node.id === 'mandarin')!.position.x += 20
    updateGraphFromCanvas(state, canvas.nodes, canvas.edges, 'Unsent draft', state.view.viewport)
    expect(state.nodes.find(node => node.id === 'mandarin')!.data).toEqual(chunk.data)
    const backup = parseBackup(JSON.stringify(exportBackup({ state, version: { datasetId: 'original-test', generation: 1, revision: 0 }, hasCheckpoint: false }, NOW)))
    expect(backup.data.nodes.find(node => node.id === 'mandarin')!.data).toEqual(chunk.data)
    expect(JSON.stringify(original)).toBe(before)
    expect(state.events).toEqual([])
  })
  it('rejects bad segment text, order, overlaps, offsets and partial Unicode characters instead of dropping them', () => {
    const invalid = [
      [{ text: '谢', startIndex: -1, endIndex: 1 }], [{ text: '谢', startIndex: 0.5, endIndex: 1 }],
      [{ text: '谢', startIndex: 1, endIndex: 0 }], [{ text: '谢', startIndex: 0, endIndex: 3 }],
      [{ text: '茶', startIndex: 0, endIndex: 1 }],
      [{ text: '谢谢', startIndex: 0, endIndex: 2 }, { text: '谢', startIndex: 1, endIndex: 2 }],
      [{ text: '谢', startIndex: 1, endIndex: 2 }, { text: '谢', startIndex: 0, endIndex: 1 }],
    ]
    for (const wordSegments of invalid) {
      const fixture = originalFixture(); fixture.nodes.find(node => node.id === 'mandarin')!.data.wordSegments = wordSegments
      expect(() => importOriginalGraph(JSON.stringify(fixture))).toThrow('Unsupported or invalid original-project data')
    }
    const supplementary = originalFixture(), chunk = supplementary.nodes.find(node => node.id === 'mandarin')!
    chunk.data = { chunkText: '𠮷', pinyin: '', sourceNodeId: 'reply', wordSegments: [{ text: '\uD842', startIndex: 0, endIndex: 1 }] }
    expect(() => importOriginalGraph(JSON.stringify(supplementary))).toThrow()
    chunk.data.wordSegments = [{ text: '𠮷', startIndex: 0, endIndex: 2 }]
    expect(importOriginalGraph(JSON.stringify(supplementary)).state.nodes.find(node => node.id === 'mandarin')!.data).toMatchObject({ originalWordSegments: chunk.data.wordSegments })
  })
  it('distinguishes absent and empty original breakdowns without fabricating word records', () => {
    for (const empty of [true, false]) {
      const fixture = originalFixture(), source = fixture.nodes.find(node => node.id === 'mandarin')!
      if (empty) source.data.wordSegments = []; else delete source.data.wordSegments
      const node = importOriginalGraph(JSON.stringify(fixture)).state.nodes.find(node => node.id === 'mandarin')!
      if (empty) expect(node.data).toHaveProperty('originalWordSegments', []); else expect(node.data).not.toHaveProperty('originalWordSegments')
      expect(originalReadingTokens('谢谢', [])).toEqual([{ text: '谢谢', start: 0, end: 2, hanzi: false, pinyin: '', imported: false }])
    }
  })
  it('retains content, positions and flags, interrupts old streams, and converts inline configuration per kind', () => {
    const original = originalFixture(), text = JSON.stringify(original), imported = importOriginalGraph(text, NOW), state = imported.state
    expect(JSON.stringify(original)).toBe(text)
    expect(state.nodes.find(n => n.id === 'answer')).toMatchObject({ position: { x: 650, y: 0 }, bookmarked: true, data: { text: '请给我一杯茶。', state: 'interrupted', provider: 'original', model: 'original-actual-model' } })
    expect(primaryPath('reply', state.nodes, state.edges).map(n => n.id)).toEqual(['topic', 'question', 'answer', 'followup', 'reply'])
    const effective = effectiveConfiguration('reply', state.nodes, state.edges)
    expect(effective.systemConfig?.id).toBe('near-system')
    expect(effective.modelConfig?.id).toBe('model')
    expect(effective.vocabularyConfig?.data).toEqual({ words: ['茶', '谢谢'], instruction: '' })
    expect(effective.learningConfig?.data).toMatchObject({ level: 'native', pinyinDisplay: 'onDemand', languageBalance: 'mostlyTarget' })
    expect(state.edges.find(e => e.id === 'chunk-edge')?.data.kind).toBe('derived')
    const serialized = JSON.stringify(state)
    expect(serialized).not.toMatch(/OMIT-ORIGINAL-KEY|OMIT-RAW-ERROR-KEY|never-contact|apiKey|baseUrl.*never/)
    const canvas = canvasGraph(state)
    updateGraphFromCanvas(state, canvas.nodes, canvas.edges, '', state.view.viewport)
    expect(JSON.stringify(state)).toBe(serialized)
  })
  it('preserves real original SRS metadata without creating introductions, due dates or grades; missing meanings stay unassessed', () => {
    const imported = importOriginalGraph(JSON.stringify(originalFixture()), NOW), state = imported.state
    expect(imported.awaitingMeaning).toBe(1); expect(state.items).toHaveLength(1); expect(state.cards).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ id: 'thanks', createdAt: 1_700_000_000_000, sourceNodeIds: ['reply'], sourceRootIds: ['topic'], originalSrs: { masteryLevel: 'Confident', selfAssessmentCorrectCount: 20, reviewSchedule: { currentIntervalDays: 40, easeFactor: 2.5 } } })
    expect(state.cards[0]).toMatchObject({ box: 1, status: 'new', revision: 0, skill: 'production', introducedAt: null, dueAt: null, lastTransitionAt: null })
    expect(state.events).toEqual([]); expect(state.exercises).toEqual([]); expect(state.attempts).toEqual([])
    const tea = state.nodes.find(n => n.type === 'chunk' && n.data.originalVocabulary?.id === 'tea')!
    expect(tea.data).toMatchObject({ text: '茶', meaning: '', originalVocabulary: { masteryLevel: 'Learning' } })
    expect(tea.data).not.toHaveProperty('itemId')
    expect(state.nodes.find(n => n.id === tea.rootId)?.data).toEqual({ name: 'Imported vocabulary' })
  })
  it('locks imported models out of both conversation and teacher requests until an explicit branch review', async () => {
    const state = importOriginalGraph(JSON.stringify(originalFixture()), NOW).state, settings = defaultSettings()
    settings.profiles.custom = { baseUrl: 'https://approved.fixture.example/v1', model: 'global-model', apiKey: 'APPROVED-FIXTURE-KEY', keyOrigin: 'https://approved.fixture.example' }
    expect(() => conversationRequest(state, settings, 'reply')).toThrow('Review the imported model')
    const context = teacherContext(state, state.cards[0]!.id)
    expect(() => teacherProvider(settings, context)).toThrow('Review the imported model')
    expect(safeTeacherInput(context).learner).toMatchObject({ level: 'native', languageBalance: 'mostlyTarget' })
    const repository = await WorkspaceRepository.open({ name: nid('import-test'), initial: () => state, broadcast: false })
    try {
      const snapshot = await repository.snapshot(), service = new GraphService(repository, { now: () => NOW })
      const next = await service.setConfiguration(snapshot, 'reply', 'modelConfig', { provider: 'custom', model: 'reviewed-model', temperature: 0.3, maxTokens: 500 })
      expect(conversationRequest(next.state, settings, 'reply')).toMatchObject({ model: 'reviewed-model', apiKey: 'APPROVED-FIXTURE-KEY' })
      expect(teacherProvider(settings, teacherContext(next.state, next.state.cards[0]!.id))).toMatchObject({ model: 'reviewed-model' })
      expect(() => conversationRequest(next.state, settings, 'answer')).toThrow('Review the imported model')
    } finally { repository.close() }
  })
  it('deduplicates exact senses but retains every original entry and never collapses different long definitions', () => {
    const fixture = originalFixture()
    fixture.vocabulary.push({ ...fixture.vocabulary[0], id: 'thanks-copy', masteryLevel: 'Learning' })
    fixture.vocabulary.push(...['a', 'b'].map(suffix => ({ id: `long-${suffix}`, term: '谢谢', definition: 'd'.repeat(1100) + suffix, addedTimestamp: NOW })))
    const state = importOriginalGraph(JSON.stringify(fixture), NOW).state
    expect(state.items).toHaveLength(3); expect(state.cards).toHaveLength(3)
    expect(state.nodes.filter(n => n.type === 'chunk' && n.data.originalVocabulary)).toHaveLength(5)
    expect(new Set(state.items.map(i => i.senseKey)).size).toBe(3)
  })
  it('keeps defined non-Hanzi entries as unassessed content instead of inventing Mandarin production cards', () => {
    const fixture = originalFixture(); fixture.vocabulary.push({ id: 'english', term: 'hello', definition: 'a greeting', addedTimestamp: NOW })
    const imported = importOriginalGraph(JSON.stringify(fixture), NOW)
    expect(imported.state.cards).toHaveLength(1)
    expect(imported.state.nodes.find(n => n.type === 'chunk' && n.data.originalVocabulary?.id === 'english')?.data).toMatchObject({ text: 'hello', meaning: 'a greeting' })
    expect(imported.warnings.some(warning => warning.includes('no Hanzi'))).toBe(true)
  })
  it('rejects duplicate IDs, missing/cyclic/ambiguous ancestry, unsupported nodes/links, and oversized input', () => {
    const duplicate = originalFixture(); duplicate.nodes.push(duplicate.nodes[0]!); expect(() => importOriginalGraph(JSON.stringify(duplicate))).toThrow('Duplicate')
    const missing = originalFixture(); missing.edges[0]!.source = 'missing'; expect(() => importOriginalGraph(JSON.stringify(missing))).toThrow('missing')
    const cycle = originalFixture(); cycle.edges[0]!.source = 'reply'; expect(() => importOriginalGraph(JSON.stringify(cycle))).toThrow('cycle')
    const ambiguous = originalFixture(); ambiguous.edges.push({ id: 'extra', source: 'other-topic', target: 'reply', type: 'default' }); expect(() => importOriginalGraph(JSON.stringify(ambiguous))).toThrow('ambiguous')
    const unsupported = originalFixture(); unsupported.nodes[0]!.type = 'interactiveExercise'; expect(() => importOriginalGraph(JSON.stringify(unsupported))).toThrow('Unsupported')
    const annotation = originalFixture(); annotation.edges[0]!.type = 'annotationLink'; expect(() => importOriginalGraph(JSON.stringify(annotation))).toThrow('Annotation')
    const conflict = originalFixture(); conflict.edges.at(-1)!.source = 'answer'; expect(() => importOriginalGraph(JSON.stringify(conflict))).toThrow('conflicting')
    expect(() => importOriginalGraph('{')).toThrow('not valid JSON')
    expect(() => importOriginalGraph(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow('25 MiB')
  })
  it('bounds deep ancestry and rejects unowned messages rather than assigning them to a guessed topic', () => {
    const nodes = Array.from({ length: 202 }, (_, i) => ({ id: `n${i}`, type: i === 0 ? 'root' : 'user', position: { x: i, y: 0 }, data: i === 0 ? { name: 'deep' } : { content: 'hello' } }))
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, source: nodes[i]!.id, target: n.id }))
    expect(() => importOriginalGraph(JSON.stringify({ nodes, edges }))).toThrow('200')
    const fixture = originalFixture(); fixture.edges = fixture.edges.filter(e => e.target !== 'question')
    expect(() => importOriginalGraph(JSON.stringify(fixture))).toThrow('unambiguous topic')
  })
  it('previews without writing, replaces atomically, round-trips metadata, rejects stale previews, and restores the checkpoint', async () => {
    const repository = await WorkspaceRepository.open({ name: nid('import-test'), initial: workspaceFixture, broadcast: false })
    try {
      const before = await repository.snapshot(), text = JSON.stringify(originalFixture()), file = { size: text.length, text: async () => text }
      const preview = await previewOriginalImport(file, before.version, NOW)
      expect(preview.kind).toBe('original'); expect((await repository.snapshot()).state).toEqual(before.state)
      const next = await repository.replace(preview.expected, preview.backup.data)
      expect(parseBackup(JSON.stringify(exportBackup(next))).data).toEqual(next.state)
      await expect(repository.replace(preview.expected, preview.backup.data)).rejects.toThrow('changed')
      expect((await repository.rollback(next.version)).state).toEqual(before.state)
      await expect(previewOriginalImport({ size: MAX_BACKUP_BYTES + 1, text: async () => { throw new Error('should not read') } }, before.version)).rejects.toThrow('25 MiB')
    } finally { repository.close() }
  })
})
