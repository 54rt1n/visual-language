import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nid } from '../../src/lib/id'
import { validateWorkspace } from '../../src/lib/domain/workspace'
import { WorkspaceRepository, type WorkspaceSnapshot } from '../../src/lib/storage/repository'
import { exportBackup, MAX_BACKUP_BYTES, parseBackup, previewBackup } from '../../src/lib/storage/backup'
import { initialWorkspaceFromStorage, migrateLegacyGraph } from '../../src/lib/storage/migration'
import { LearningService } from '../../src/lib/learning/learningService'
import { deterministicAssessment } from '../../src/lib/learning/assessment'
import { DAY } from '../../src/lib/learning/leitner'
import { exerciseProposal, NOW, workspaceFixture } from './fixtures'
import { defaultLearningCalendar } from '../../src/lib/domain/learningCalendar'

const repositories: WorkspaceRepository[] = []
describe('learning calendar persistence', () => {
  it('defaults to 3am and preserves the calendar preference in a full restore', async () => {
    const repository = await open(), before = await repository.snapshot()
    expect(before.state.learners[0]!.learningCalendar.startMinute).toBe(180)
    const saved = await repository.mutate(before.version, { id: nid('op'), kind: 'calendar-preference', intent: {}, at: NOW }, state => {
      state.learners[0]!.learningCalendar = { ...defaultLearningCalendar('America/Chicago'), startMinute: 240 }
    })
    const fresh = await open(), imported = parseBackup(JSON.stringify(exportBackup(saved)))
    const restored = await fresh.replace((await fresh.snapshot()).version, imported.data)
    expect(restored.state.learners[0]!.learningCalendar).toEqual({ startMinute: 240, timeZone: 'America/Chicago' })
    expect(restored.state.lessons).toEqual([])
  })
  it('rejects invalid cutoff and time zone without writing', async () => {
    const repository = await open(), before = await repository.snapshot()
    for (const patch of [{ startMinute: 1440 }, { timeZone: 'Not/A_Zone' }]) {
      await expect(repository.mutate(before.version, { id: nid('op'), kind: 'bad-calendar', intent: {}, at: NOW }, state => {
        Object.assign(state.learners[0]!.learningCalendar, patch)
      })).rejects.toThrow()
    }
    expect((await repository.snapshot()).state).toEqual(before.state)
  })
})
afterEach(() => { repositories.forEach(r => r.close()); repositories.length = 0; vi.restoreAllMocks() })
async function open(name = nid('test-db')) {
  const repository = await WorkspaceRepository.open({ name, initial: workspaceFixture, broadcast: false })
  repositories.push(repository)
  return repository
}
async function setup(skill: 'production' | 'recognition' = 'production') {
  const repository = await open(), clock = { at: NOW, now() { return this.at } }, service = new LearningService(repository, clock)
  let snapshot = await repository.snapshot()
  snapshot = await service.addItem(snapshot, { language: 'zh', kind: 'phrase', canonicalText: '谢谢', senseKey: 'thanks', meaning: 'thank you', pinyin: 'xiè xie', sourceNodeIds: [], sourceRootIds: ['root'] }, [skill])
  const cardId = snapshot.state.cards[0]!.id
  snapshot = await service.introduce(snapshot, cardId)
  clock.at += DAY
  snapshot = await service.startSession(snapshot)
  const sessionId = snapshot.state.sessions[0]!.id
  return { repository, service, clock, snapshot, cardId, sessionId }
}
async function prepare(h: Awaited<ReturnType<typeof setup>>, snapshot = h.snapshot, practice = false) {
  return h.service.prepareExercise(snapshot, h.sessionId, h.cardId, exerciseProposal(), practice)
}
async function answer(h: Awaited<ReturnType<typeof setup>>, snapshot: WorkspaceSnapshot, text = '谢谢') {
  const exercise = snapshot.state.exercises.at(-1)!, id = nid('attempt')
  snapshot = await h.service.submitAttempt(snapshot, { id, exerciseId: exercise.id, answer: text, submittedAt: h.clock.at })
  snapshot = await h.service.assessAttempt(snapshot, id, deterministicAssessment(exercise, text)!, { source: 'deterministic' })
  return snapshot
}

describe('transactional learning and complete recovery', () => {
  it('preserves operation identity across native and fallback crypto without duplicate writes', async () => {
    const nativeCrypto = globalThis.crypto, repository = await open(), before = await repository.snapshot()
    const first = { id: 'native-operation', kind: 'rename', at: NOW, intent: { name: 'Native save' } }
    const nativeSaved = await repository.mutate(before.version, first, state => { state.name = 'Native save' })
    try {
      vi.stubGlobal('crypto', { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) })
      const replay = await repository.mutate(before.version, first, () => { throw new Error('A repeated operation must not write.') })
      expect(replay.state).toEqual(nativeSaved.state)
      await expect(repository.mutate(replay.version, { ...first, intent: { name: 'Changed payload' } }, () => {})).rejects.toThrow('reused')
      const second = { id: 'fallback-operation', kind: 'rename', at: NOW, intent: { name: 'Fallback save' } }
      const fallbackSaved = await repository.mutate(replay.version, second, state => { state.name = 'Fallback save' })
      vi.unstubAllGlobals()
      expect((await repository.mutate(replay.version, second, () => { throw new Error('A repeated operation must not write.') })).state).toEqual(fallbackSaved.state)
    } finally { vi.unstubAllGlobals() }
  })
  it('commits card/event/attempt/session together and resumes an identical saved exercise', async () => {
    const h = await setup(), prepared = await prepare(h)
    expect((await h.repository.snapshot()).state).toEqual(prepared.state)
    const result = await answer(h, prepared)
    expect(result.state.cards[0]).toMatchObject({ box: 2, revision: 2, dueAt: h.clock.at + 3 * DAY })
    expect(result.state.attempts[0]!.status).toBe('committed')
    expect(result.state.sessions[0]!.completedCardIds).toEqual([h.cardId])
    expect(result.state.events.filter(e => e.kind === 'review')).toHaveLength(1)
    expect(validateWorkspace((await h.repository.snapshot()).state)).toEqual(result.state)
  })
  it('deduplicates the same submission ID, refuses changed payloads and stale revisions', async () => {
    const h = await setup(), prepared = await prepare(h), exercise = prepared.state.exercises[0]!
    const input = { id: 'stable-attempt', exerciseId: exercise.id, answer: '谢谢', submittedAt: h.clock.at }
    const submitted = await h.service.submitAttempt(prepared, input)
    expect((await h.service.submitAttempt(prepared, input)).state).toEqual(submitted.state)
    await expect(h.service.submitAttempt(prepared, { ...input, answer: 'changed' })).rejects.toThrow('reused')
    await expect(h.service.saveAnswerDraft(prepared, exercise.id, 'stale tab')).rejects.toThrow('changed')
    const graded = await h.service.assessAttempt(submitted, input.id, deterministicAssessment(exercise, input.answer)!, { source: 'deterministic' })
    const replay = await h.service.assessAttempt(graded, input.id, deterministicAssessment(exercise, input.answer)!, { source: 'deterministic' })
    expect(replay.state.cards).toEqual(graded.state.cards)
    expect(replay.state.events).toEqual(graded.state.events)
  })
  it('records help only once and all ensuing answers are practice', async () => {
    const h = await setup(), prepared = await prepare(h), exercise = prepared.state.exercises[0]!
    const helped = await h.service.requestHelp(prepared, exercise.id, 'hint')
    const helpedAgain = await h.service.requestHelp(helped, exercise.id, 'reveal')
    expect(helpedAgain.state.events.filter(e => e.kind === 'review')).toEqual(helped.state.events.filter(e => e.kind === 'review'))
    expect(helpedAgain.state.cards).toEqual(helped.state.cards)
    const answered = await answer(h, helpedAgain)
    expect(answered.state.cards).toEqual(helped.state.cards)
    expect(answered.state.events.at(-1)!.kind).toBe('practice')
    expect(answered.state.attempts[0]!.helpUsed).toBe(true)
    await expect(h.service.correctReview(answered, helped.state.events.at(-1)!.id, 'recalled')).rejects.toThrow('help')
  })
  it('fixes the latest result from its original before state/time, without replaying later history', async () => {
    const h = await setup(), wrong = await answer(h, await prepare(h), '对不起'), original = wrong.state.events.at(-1)!
    h.clock.at += 5000
    const fixed = await h.service.correctReview(wrong, original.id, 'recalled')
    expect(fixed.state.cards[0]).toMatchObject({ box: 2, revision: 3, dueAt: original.occurredAt + 3 * DAY })
    expect(fixed.state.events.at(-1)!.supersedesEventId).toBe(original.id)
    const twice = await h.service.correctReview(fixed, fixed.state.events.at(-1)!.id, 'notRecalled')
    expect(twice.state.cards[0]).toMatchObject({ box: 1, revision: 4, dueAt: original.occurredAt + DAY })
    const historical = await h.service.correctReview(twice, original.id, 'recalled')
    expect(historical.state.cards).toEqual(twice.state.cards)
    expect(historical.state.events.find(e => e.id === original.id)!.disputed).toBe(true)
  })
  it('preserves an uncertain answer without penalty; retry uses the original submission time', async () => {
    const h = await setup()
    let current = await h.service.prepareExercise(h.snapshot, h.sessionId, h.cardId, exerciseProposal({ answerPolicy: 'contextual' }))
    const exercise = current.state.exercises[0]!, submittedAt = h.clock.at
    current = await h.service.submitAttempt(current, { id: 'pending', exerciseId: exercise.id, answer: '谢谢你的帮助。', submittedAt })
    const before = current.state.cards
    current = await h.service.assessAttempt(current, 'pending', { exerciseId: exercise.id, grade: 'uncertain', criteria: [], feedback: 'The context is ambiguous.' }, { source: 'teacher', provider: 'fixture', model: 'fixture' })
    expect(current.state.cards).toEqual(before); expect(current.state.attempts[0]!.status).toBe('needsReview')
    h.clock.at += 5 * DAY
    current = await h.service.assessAttempt(current, 'pending', { exerciseId: exercise.id, grade: 'correct', criteria: [{ criterionId: 'meaning', met: true, evidence: 'The answer expresses thanks for help.' }], feedback: 'Correct.' }, { source: 'teacher', provider: 'fixture', model: 'fixture' })
    expect(current.state.cards[0]!.dueAt).toBe(submittedAt + 3 * DAY)
    expect(current.state.attempts[0]!.answer).toBe('谢谢你的帮助。')
  })
  it('rolls back all records on a quota-like storage failure', async () => {
    const h = await setup(), prepared = await prepare(h), exercise = prepared.state.exercises[0]!
    const current = await h.service.submitAttempt(prepared, { id: 'pending', exerciseId: exercise.id, answer: '谢谢', submittedAt: h.clock.at })
    const original = IDBObjectStore.prototype.put
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'events') throw new DOMException('Simulated quota exhaustion', 'QuotaExceededError')
      return original.apply(this, args)
    })
    await expect(h.service.assessAttempt(current, 'pending', deterministicAssessment(exercise, '谢谢')!, { source: 'deterministic' })).rejects.toMatchObject({ name: 'QuotaExceededError' })
    spy.mockRestore()
    expect((await h.repository.snapshot()).state).toEqual(current.state)
  })
  it('pausing prevents a late grading completion from changing the schedule', async () => {
    const h = await setup(), prepared = await prepare(h), exercise = prepared.state.exercises[0]!
    let current = await h.service.submitAttempt(prepared, { id: 'late', exerciseId: exercise.id, answer: '谢谢', submittedAt: h.clock.at })
    const before = current.state.cards
    current = await h.service.setSessionStatus(current, h.sessionId, 'paused')
    await expect(h.service.assessAttempt(current, 'late', deterministicAssessment(exercise, '谢谢')!, { source: 'deterministic' })).rejects.toThrow('paused')
    current = await h.service.markGradingUnavailable(current, 'late', 'Request was cancelled. Retry when ready.')
    expect(current.state.cards).toEqual(before)
    expect(current.state.attempts[0]).toMatchObject({ status: 'needsReview', answer: '谢谢' })
    current = await h.service.setSessionStatus(current, h.sessionId, 'active')
    current = await h.service.assessAttempt(current, 'late', deterministicAssessment(exercise, '谢谢')!, { source: 'deterministic' })
    expect(current.state.cards[0]!.box).toBe(2)
  })
  it.each(['recognition', 'production'] as const)('gates MC activation on reviewed content; %s credit follows the assessed skill', async skill => {
    const h = await setup(skill), options = [{ id: 'a', text: '谢谢' }, { id: 'b', text: '你好' }, { id: 'c', text: '再见' }, { id: 'd', text: '不客气' }]
    const question = { cardId: h.cardId, stem: 'Choose “thank you”.', options, correctOptionId: 'a', explanation: '谢谢 expresses thanks.',
      distractorFeedback: options.slice(1).map(o => ({ optionId: o.id, explanation: `${o.text} does not express thanks.` })), sourceIds: ['source'], objective: 'Recognize thanks.' }
    const proposal = exerciseProposal({ format: 'multipleChoice', prompt: question.stem, sourceIds: ['source'], multipleChoice: { quizId: 'quiz', options, correctOptionId: 'a', explanation: question.explanation, distractorFeedback: question.distractorFeedback } })
    await expect(h.service.prepareExercise(h.snapshot, h.sessionId, h.cardId, proposal)).rejects.toThrow('content-reviewed')
    let current = await h.repository.mutate(h.snapshot.version, { id: 'fixture-quiz', kind: 'fixture-only', at: h.clock.at, intent: {} }, state => {
      state.sources.push({ id: 'source', kind: 'local', title: 'Fixture source', excerpt: '谢谢 means thank you.', retrievedAt: h.clock.at })
      state.drafts.push({ id: 'quiz', kind: 'quiz', text: '', quiz: { title: 'Fixture quiz', questions: [question] }, status: 'validated', sourceIds: ['source'], cardIds: [h.cardId], createdAt: h.clock.at, updatedAt: h.clock.at,
        contentReview: { verdict: 'supported', reasons: 'Deterministic test fixture, not live semantic review.', provider: 'fixture', model: 'fixture', promptVersion: 'fixture-v1' } })
    })
    current = await h.service.prepareExercise(current, h.sessionId, h.cardId, proposal)
    const exercise = current.state.exercises[0]!, before = current.state.cards
    current = await h.service.submitAttempt(current, { id: 'choice', exerciseId: exercise.id, answer: 'ignored display text', selectedOptionId: 'a', submittedAt: h.clock.at })
    current = await h.service.assessAttempt(current, 'choice', deterministicAssessment(exercise, '谢谢', 'a')!, { source: 'deterministic' })
    expect(current.state.attempts[0]!.answer).toBe('谢谢')
    if (skill === 'recognition') expect(current.state.cards[0]!.box).toBe(2)
    else expect(current.state.cards).toEqual(before)
    expect(parseBackup(JSON.stringify(exportBackup(current))).data).toEqual(current.state)
  })
  it('round-trips every collection including draft and pending answer, preserving timestamps and IDs', async () => {
    const h = await setup(), prepared = await prepare(h), exercise = prepared.state.exercises[0]!
    let current = await h.service.saveAnswerDraft(prepared, exercise.id, '谢谢')
    current = await h.service.submitAttempt(current, { id: 'pending', exerciseId: exercise.id, answer: '谢谢', submittedAt: h.clock.at })
    const text = JSON.stringify(exportBackup(current, NOW)), parsed = parseBackup(text)
    expect(text).not.toMatch(/apiKey|Authorization|keyOrigin|__VL_TEST_KEYS__/)
    const fresh = await open(), empty = await fresh.snapshot(), restored = await fresh.replace(empty.version, parsed.data)
    expect(restored.state).toEqual(current.state)
    expect((await fresh.snapshot()).state).toEqual(current.state)
    expect(restored.hasCheckpoint).toBe(true)
    const repeated = await fresh.replace(restored.version, parsed.data)
    expect(repeated.state.events).toEqual(current.state.events)
    const rolledBack = await fresh.rollback(repeated.version)
    expect(rolledBack.state).toEqual(current.state)
    // All writes authorized against an old dataset are rejected, even at an identical numeric revision.
    await expect(fresh.mutate(restored.version, { id: 'stale', kind: 'edit', at: NOW, intent: {} }, s => { s.name = 'lost update' })).rejects.toThrow('replaced')
  })
  it('preview/cancel do not write, changed previews refuse replacement, and recovery restores previous data', async () => {
    const repository = await open(), initial = await repository.snapshot(), text = JSON.stringify(exportBackup(initial, NOW))
    const preview = await previewBackup({ size: text.length, text: async () => text }, initial.version)
    expect((await repository.snapshot()).state).toEqual(initial.state)
    const changed = await repository.mutate(initial.version, { id: 'rename', kind: 'rename', at: NOW, intent: 'new' }, s => { s.name = 'New name' })
    await expect(repository.replace(preview.expected, preview.backup.data)).rejects.toThrow('changed')
    const replaced = await repository.replace(changed.version, preview.backup.data)
    const recovered = await repository.rollback(replaced.version)
    expect(recovered.state.name).toBe('New name')
  })
  it('rejects malformed, oversized, newer, credential-bearing and relationally inconsistent backups', async () => {
    const repository = await open(), backup = exportBackup(await repository.snapshot(), NOW)
    expect(() => parseBackup('{')).toThrow('valid JSON')
    expect(() => parseBackup(JSON.stringify({ ...backup, formatVersion: 99 }))).toThrow()
    expect(() => parseBackup(JSON.stringify({ ...backup, data: { ...backup.data, apiKey: 'must-not-import' } }))).toThrow()
    expect(() => parseBackup(JSON.stringify({ ...backup, workspaceId: 'wrong' }))).toThrow('identity')
    expect(() => parseBackup(JSON.stringify({ ...backup, data: { ...backup.data, view: { ...backup.data.view, activeRootId: 'missing' } } }))).toThrow('topic')
    const text = vi.fn()
    await expect(previewBackup({ size: MAX_BACKUP_BYTES + 1, text }, (await repository.snapshot()).version)).rejects.toThrow('25 MiB')
    expect(text).not.toHaveBeenCalled()
  })
})

describe('legacy migration does not discard source data', () => {
  const raw = JSON.stringify({ nodes: [{ id: 'root', type: 'root', position: { x: 0, y: 0 }, data: { name: 'Original topic' } },
    { id: 'a', type: 'assistant', position: { x: 0, y: 200 }, selected: true, data: { content: '你好', reasoning: 'Saved thinking', streaming: true } }],
    edges: [{ id: 'e', source: 'root', target: 'a' }] })
  it('maps content to text, retains graph location, and marks interrupted streams without resuming', () => {
    const migrated = migrateLegacyGraph(raw, NOW)
    expect(migrated.nodes[1]!.data).toMatchObject({ text: '你好', reasoning: 'Saved thinking', state: 'interrupted' })
    expect(migrated.view.selectedNodeIds).toEqual(['a']); expect(migrated.cards).toEqual([])
  })
  it('leaves legacy localStorage untouched after initialization and rejects malformed originals', async () => {
    const setItem = vi.fn(), storage = { getItem: (key: string) => key === 'vl-graph-v1' ? raw : null, setItem }
    const repo = await WorkspaceRepository.open({ name: nid('migrate'), initial: () => initialWorkspaceFromStorage(storage, NOW), broadcast: false })
    repositories.push(repo)
    expect((await repo.snapshot()).state.nodes[1]!.data).toMatchObject({ text: '你好' }); expect(setItem).not.toHaveBeenCalled()
    await expect(WorkspaceRepository.open({ name: nid('broken'), initial: () => migrateLegacyGraph('{'), broadcast: false })).rejects.toThrow()
    expect(setItem).not.toHaveBeenCalled()
  })
})
