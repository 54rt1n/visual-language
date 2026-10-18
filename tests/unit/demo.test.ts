import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDemoWorkspace } from '../../src/lib/demo/seed'
import { DEMO_NOW } from '../../src/lib/demo/material'
import { DemoService } from '../../src/lib/demo/demoService'
import { RehearsalTeacher } from '../../src/lib/demo/rehearsalTeacher'
import { modeFromHash, WORKSPACE_DATABASES } from '../../src/lib/domain/workspaceMode'
import { validateWorkspace } from '../../src/lib/domain/workspace'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { LearningService } from '../../src/lib/learning/learningService'
import { DAY, dueQueue } from '../../src/lib/learning/leitner'
import { teacherContext, sessionSummary } from '../../src/lib/teacher/teacherContext'
import { workspaceClock } from '../../src/lib/teacher/host'
import type { WorkspaceState } from '../../src/lib/state/workspace.svelte'
import { searchLearningHistory } from '../../src/lib/search/searchService'
import { nid } from '../../src/lib/id'
import { workspaceFixture } from './fixtures'

const repositories: WorkspaceRepository[] = []
afterEach(() => { repositories.forEach(r => r.close()); repositories.length = 0; vi.restoreAllMocks() })
async function openDemo() {
  const repository = await WorkspaceRepository.open({ name: nid('test-demo'), mode: 'demo', initial: createDemoWorkspace, broadcast: false }); repositories.push(repository)
  let current = await repository.snapshot()
  const clock = { now: () => current.state.demo!.now }, demo = new DemoService(repository)
  const host = { current: () => current, apply: async (command: Parameters<WorkspaceState['apply']>[0]) => { current = await command(current, repository); return current } }
  return { repository, clock, demo, host, learning: new LearningService(repository, clock), teacher: new RehearsalTeacher(host, clock) }
}
async function fixtures(h: Awaited<ReturnType<typeof openDemo>>) { await h.host.apply(s => h.demo.setContentMode(s, 'fixtures')); await h.host.apply(s => h.learning.startSession(s)); return h.host.current().state.sessions.at(-1)!.id }
async function submit(h: Awaited<ReturnType<typeof openDemo>>, answer: string, option?: string) {
  const exercise = h.host.current().state.exercises.at(-1)!, id = nid('attempt')
  await h.host.apply(s => h.learning.submitAttempt(s, { id, exerciseId: exercise.id, submittedAt: h.clock.now(), answer, ...(option ? { selectedOptionId: option } : {}) }))
  await h.teacher.gradeAttempt(id)
}

describe('isolated demo and authored rehearsal', () => {
  it('repairs legacy example material only in explicit prerecorded mode without altering prior progress', async () => {
    const h = await openDemo(), attemptId = h.host.current().state.attempts.find(a => a.cardId === 'demo-tea-card')!.id
    await expect(h.teacher.explainAttempt(attemptId)).rejects.toThrow()
    await h.host.apply(s => h.demo.setContentMode(s, 'fixtures'))
    await h.host.apply((s, r) => r.mutate(s.version, { id: 'legacy-example', kind: 'fixture', at: DEMO_NOW, intent: {} }, state => {
      for (const exercise of state.exercises) delete exercise.workedExample
      for (const attempt of state.attempts) if (attempt.assessment) delete attempt.assessment.workedExample
    }))
    const before = structuredClone(h.host.current().state), draft = await h.teacher.explainAttempt(attemptId)
    expect(draft).toMatchObject({ kind: 'feedback', status: 'validated', attemptId, generation: { provider: 'fixture', promptVersion: 'prerecorded-feedback-v1' } })
    expect(draft.workedExample!.meaning).toContain('tea')
    expect(draft.workedExample!.pinyin).toContain('chá')
    const restored = parseBackup(JSON.stringify(exportBackup(h.host.current()))).data
    expect(restored.cards).toEqual(before.cards); expect(restored.events).toEqual(before.events); expect(restored.attempts).toEqual(before.attempts)
    expect((await h.teacher.explainAttempt(attemptId)).id).toBe(draft.id)
    expect(h.host.current().state.drafts.filter(d => d.kind === 'feedback')).toHaveLength(1)
  })
  it('seeds policy-valid history, two roots, five independent cards and a searchable past mistake', () => {
    const state = createDemoWorkspace()
    expect(validateWorkspace(state)).toEqual(state)
    expect(state.demo).toEqual({ enabled: true, now: DEMO_NOW, contentMode: 'live' })
    expect(state.nodes.filter(n => n.type === 'root')).toHaveLength(2)
    expect(state.cards.map(c => c.box)).toEqual([1, 3, 2, 4, 1])
    expect(state.cards.at(-1)).toMatchObject({ status: 'new', dueAt: null, introducedAt: null, revision: 0 })
    expect(dueQueue(state.cards, DEMO_NOW, { learnerId: state.activeLearnerId }).cards.map(c => c.id)).toEqual(['demo-thanks-card', 'demo-tea-card'])
    expect(teacherContext(state, 'demo-tea-card', DEMO_NOW).mistakes[0]?.feedback).toContain('coffee')
    expect(searchLearningHistory(state, 'coffee', { kind: 'feedback' }, DEMO_NOW)).toHaveLength(1)
    expect(state.exercises.every(e => e.provider === 'fixture')).toBe(true)
    expect(modeFromHash('#demo')).toBe('demo'); expect(modeFromHash('#anything-else')).toBe('normal')
  })
  it('rejects cross-mode replace/flag changes and reset against a normal repository without any write', async () => {
    const normal = await WorkspaceRepository.open({ name: nid('normal'), initial: workspaceFixture, broadcast: false }); repositories.push(normal)
    const before = await normal.snapshot(), h = await openDemo()
    await expect(normal.replace(before.version, h.host.current().state)).rejects.toThrow('demo workspace')
    await expect(h.repository.replace(h.host.current().version, before.state)).rejects.toThrow('normal learning workspace')
    await expect(normal.mutate(before.version, { id: 'bad', kind: 'bad', at: DEMO_NOW, intent: {} }, state => { state.demo = { enabled: true, now: DEMO_NOW } })).rejects.toThrow('demo workspace')
    expect(() => new DemoService(normal).advance(before, 1)).toThrow('isolated demo database')
    expect(() => new DemoService(normal).reset(before)).toThrow('isolated demo database')
    await expect(WorkspaceRepository.open({ mode: 'demo', name: WORKSPACE_DATABASES.normal, initial: createDemoWorkspace })).rejects.toThrow('does not match')
    expect((await normal.snapshot()).state).toEqual(before.state)
  })
  it('advances only simulated now and preserves all card/event/answer timestamps, with bounded forward-only changes', async () => {
    const h = await openDemo(), before = h.host.current()
    await h.host.apply(s => h.demo.advance(s, 3))
    const next = h.host.current()
    expect(next.state.demo!.now).toBe(DEMO_NOW + 3 * DAY)
    for (const key of ['cards', 'events', 'exercises', 'attempts', 'nodes', 'sources'] as const) expect(next.state[key]).toEqual(before.state[key])
    for (const days of [-1, 0, 1.5, 366, NaN]) expect(() => h.demo.advance(next, days)).toThrow('1 to 365')
    await expect(h.demo.advance(before, 1)).rejects.toThrow('changed')
  })
  it('normal workspace clocks ignore a simulated marker; only an explicitly demo-bound host reads it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456789)
    const snapshot = { state: createDemoWorkspace() }
    expect(workspaceClock({ mode: 'normal', snapshot } as WorkspaceState).now()).toBe(123456789)
    expect(workspaceClock({ mode: 'demo', snapshot } as WorkspaceState).now()).toBe(DEMO_NOW)
  })
  it('requires explicit fixture opt-in, refuses edited material, and never fetches', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network should be called'))
    const h = await openDemo()
    await expect(h.teacher.teach('demo-goodbye-card')).rejects.toThrow('Enable prerecorded')
    await fixtures(h)
    await expect(h.teacher.draftQuiz(['demo-thanks-card'], { web: true })).rejects.toThrow('no web retrieval')
    await h.host.apply((s, r) => r.mutate(s.version, { id: 'edit', kind: 'test', at: DEMO_NOW, intent: {} }, state => { state.items.find(i => i.id === 'demo-goodbye')!.meaning = 'different sense' }))
    await expect(h.teacher.teach('demo-goodbye-card')).rejects.toThrow('no matching prerecorded')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('uses real transactions for recognition promotion, failed production reset, corrective practice and explicit introduction', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'))
    const h = await openDemo(), sessionId = await fixtures(h)
    const quiz = await h.teacher.draftQuiz(['demo-thanks-card'], { sessionId })
    expect(quiz.draft.generation?.provider).toBe('fixture')
    expect(quiz.draft.contentReview?.reasons).toContain('not native tool generation')
    await h.teacher.presentQuizQuestion(sessionId, quiz.draft.id, 0)
    await submit(h, '', quiz.draft.quiz!.questions[0]!.correctOptionId)
    expect(h.host.current().state.cards[0]).toMatchObject({ box: 2, dueAt: DEMO_NOW + 3 * DAY })
    await h.host.apply(s => h.learning.finishExercise(s, s.state.exercises.at(-1)!.id))
    await h.teacher.prepareFreeExercise(sessionId, 'demo-tea-card')
    await submit(h, '我要咖啡')
    const failed = h.host.current().state.cards.find(c => c.id === 'demo-tea-card')!
    expect(failed).toMatchObject({ box: 1, dueAt: DEMO_NOW + DAY })
    await h.host.apply(s => h.learning.finishExercise(s, s.state.exercises.at(-1)!.id))
    await h.teacher.prepareFreeExercise(sessionId, 'demo-tea-card', true)
    expect(h.host.current().state.exercises.at(-1)?.mode).toBe('practice')
    await submit(h, '请给我一杯茶')
    expect(h.host.current().state.cards.find(c => c.id === 'demo-tea-card')).toEqual(failed)
    await h.host.apply(s => h.learning.finishExercise(s, s.state.exercises.at(-1)!.id))
    const beforeTeaching = h.host.current().state.cards.at(-1)!
    await h.teacher.teach('demo-goodbye-card')
    expect(h.host.current().state.cards.at(-1)).toEqual(beforeTeaching)
    await h.host.apply(s => h.learning.introduce(s, 'demo-goodbye-card', sessionId))
    expect(h.host.current().state.cards.at(-1)).toMatchObject({ status: 'active', box: 1, dueAt: DEMO_NOW + DAY, revision: 1 })
    expect(sessionSummary(h.host.current().state, sessionId, DEMO_NOW)).toMatchObject({ reviewed: 2, recalled: 1, notRecalled: 1, practices: 1, introduced: 1 })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('blocks clock/content-mode changes during saved questions and restores a pending quiz without grading or reordering', async () => {
    const h = await openDemo(), sessionId = await fixtures(h), quiz = await h.teacher.draftQuiz(['demo-thanks-card'], { sessionId })
    await h.teacher.presentQuizQuestion(sessionId, quiz.draft.id, 0)
    await h.host.apply(s => h.learning.saveAnswerDraft(s, s.state.exercises.at(-1)!.id, '', nid('op'), 'choice-0'))
    await h.host.apply(s => h.learning.setSessionStatus(s, sessionId, 'paused'))
    const before = h.host.current()
    await expect(h.demo.advance(before, 1)).rejects.toThrow('saved question')
    await expect(h.demo.setContentMode(before, 'live')).rejects.toThrow('saved question')
    const backup = parseBackup(JSON.stringify(exportBackup(before))), fresh = await openDemo()
    const restored = await fresh.repository.replace(fresh.host.current().version, backup.data)
    expect(restored.state).toEqual(before.state)
    expect(restored.state.exercises.at(-1)!.multipleChoice!.options).toEqual(quiz.draft.quiz!.questions[0]!.options)
    const normal = await WorkspaceRepository.open({ name: nid('normal'), initial: workspaceFixture, broadcast: false }); repositories.push(normal)
    await expect(normal.replace((await normal.snapshot()).version, backup.data)).rejects.toThrow('demo workspace')
    await h.host.apply(s => h.learning.setSessionStatus(s, sessionId, 'completed'))
    await h.host.apply(s => h.demo.advance(s, 1))
    expect(h.clock.now()).toBe(DEMO_NOW + DAY)
  })
  it('resets only the demo and retains its pre-reset state as the demo checkpoint', async () => {
    const h = await openDemo()
    await h.host.apply(s => h.demo.advance(s, 7))
    const before = h.host.current()
    await h.host.apply(s => h.demo.reset(s))
    expect(h.clock.now()).toBe(DEMO_NOW)
    expect(h.host.current().hasCheckpoint).toBe(true)
    const recovered = await h.repository.rollback(h.host.current().version)
    expect(recovered.state).toEqual(before.state)
  })
})
