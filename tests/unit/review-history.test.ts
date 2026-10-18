import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { nid } from '../../src/lib/id'
import { createDemoWorkspace, rehearsalProposal } from '../../src/lib/demo/seed'
import { DEMO_ITEMS, DEMO_NOW } from '../../src/lib/demo/material'
import { cardReviewHistory, sessionReflection } from '../../src/lib/teacher/reviewHistory'
import { correctionImpact } from '../../src/lib/learning/corrections'
import { LearningService } from '../../src/lib/learning/learningService'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { sessionSummary } from '../../src/lib/teacher/teacherContext'

const repositories: WorkspaceRepository[] = []
afterEach(() => { repositories.forEach(r => r.close()); repositories.length = 0 })
async function setup() {
  const repository = await WorkspaceRepository.open({ name: nid('review-history'), mode: 'demo', initial: createDemoWorkspace, broadcast: false }); repositories.push(repository)
  const clock = { now: () => DEMO_NOW }, learning = new LearningService(repository, clock)
  return { repository, learning, snapshot: await repository.snapshot() }
}
describe('saved review history and evidence-based reflection', () => {
  it('orders saved questions newest first and separates original assessments from effective corrections', async () => {
    const h = await setup(), before = cardReviewHistory(h.snapshot.state, 'demo-tea-card')
    expect(before).toHaveLength(3); expect(before[0]!.latest).toBe(true); expect(before[2]!.latest).toBe(false)
    const event = before[0]!.event!, sessionId = before[0]!.exercise.sessionId
    expect(sessionReflection(h.snapshot.state, sessionId, DEMO_NOW).strengthCount).toBe(1)
    const next = await h.learning.correctReview(h.snapshot, event.id, 'notRecalled')
    const row = cardReviewHistory(next.state, 'demo-tea-card')[0]!
    expect(row.attempts[0]!.assessment?.grade).toBe('correct')
    expect(row.event).toMatchObject({ kind: 'correction', outcome: 'notRecalled', supersedesEventId: event.id })
    expect(row.original).toEqual(event); expect(row.corrections).toHaveLength(1)
    const reflection = sessionReflection(next.state, sessionId, DEMO_NOW)
    expect(reflection).toMatchObject({ strengthCount: 0, difficultyCount: 1, goal: next.state.sessions.find(s => s.id === sessionId)!.goal })
    expect(reflection.difficulties[0]).toMatchObject({ corrected: true, source: 'learner correction' })
    expect(sessionSummary(next.state, sessionId, DEMO_NOW)).toMatchObject({ reviewed: 1, recalled: 0, notRecalled: 1 })
    const restored = parseBackup(JSON.stringify(exportBackup(next))).data
    expect(cardReviewHistory(restored, 'demo-tea-card')).toEqual(cardReviewHistory(next.state, 'demo-tea-card'))
  })

  it('flags historical disputes without rewriting later progress or using them as confident mistake evidence', async () => {
    const h = await setup(), row = cardReviewHistory(h.snapshot.state, 'demo-tea-card')[2]!
    const cards = h.snapshot.state.cards
    expect(correctionImpact(h.snapshot.state, row.event!.id).historical).toBe(true)
    const next = await h.learning.correctReview(h.snapshot, row.event!.id, 'recalled')
    expect(next.state.cards).toEqual(cards)
    expect(cardReviewHistory(next.state, 'demo-tea-card')[2]!.disputed).toBe(true)
    expect(sessionReflection(next.state, row.exercise.sessionId, DEMO_NOW)).toMatchObject({ strengthCount: 0, difficultyCount: 0, disputed: 1 })
    expect(sessionSummary(next.state, row.exercise.sessionId, DEMO_NOW)).toMatchObject({ reviewed: 1, notRecalled: 1 }) // Flagging does not pretend the grade was resolved.
  })

  it('blocks changing a card revision under another pending question but allows historical flags and an explicit skip', async () => {
    const h = await setup(), prior = cardReviewHistory(h.snapshot.state, 'demo-tea-card'), current = prior[0]!.event!
    let next = await h.learning.startSession(h.snapshot, 'demo-everyday')
    const sessionId = next.state.sessions.at(-1)!.id
    next = await h.learning.prepareExercise(next, sessionId, 'demo-tea-card', rehearsalProposal(DEMO_ITEMS.find(m => m.id === 'demo-tea')!, 'production'))
    expect(correctionImpact(next.state, current.id).blocked).toBe(true)
    await expect(h.learning.correctReview(next, current.id, 'notRecalled')).rejects.toThrow('pending question')
    expect((await h.repository.snapshot()).state.cards).toEqual(next.state.cards)
    next = await h.learning.correctReview(next, prior[2]!.event!.id, 'recalled')
    expect(next.state.cards).toEqual(h.snapshot.state.cards)
    expect(sessionReflection(next.state, sessionId, DEMO_NOW).nextStep).toContain('Continue your saved question')
    next = await h.learning.finishExercise(next, next.state.sessions.at(-1)!.activeExerciseId!, true)
    next = await h.learning.correctReview(next, current.id, 'notRecalled')
    expect(next.state.cards.find(c => c.id === 'demo-tea-card')!.box).toBe(1)
  })

  it('retains helped outcomes separately and never offers to convert them into independent recall', async () => {
    const h = await setup()
    let next = await h.learning.startSession(h.snapshot, 'demo-everyday'), sessionId = next.state.sessions.at(-1)!.id
    next = await h.learning.prepareExercise(next, sessionId, 'demo-tea-card', rehearsalProposal(DEMO_ITEMS.find(m => m.id === 'demo-tea')!, 'production'))
    next = await h.learning.requestHelp(next, next.state.sessions.at(-1)!.activeExerciseId!, 'hint')
    const row = cardReviewHistory(next.state, 'demo-tea-card')[0]!
    expect(row.aids).toEqual(['hint']); expect(row.attempts).toHaveLength(0)
    expect(correctionImpact(next.state, row.event!.id).canRecall).toBe(false)
    await expect(h.learning.correctReview(next, row.event!.id, 'recalled')).rejects.toThrow('help')
    expect(sessionReflection(next.state, sessionId, DEMO_NOW).difficulties[0]).toMatchObject({ aid: 'hint', source: 'explicit help' })
  })

  it('keeps scope, due-first limits and unresolved assessments visible without counting practice as retention', async () => {
    const h = await setup()
    let next = await h.learning.startSession(h.snapshot, 'demo-travel'), sessionId = next.state.sessions.at(-1)!.id
    let reflection = sessionReflection(next.state, sessionId, DEMO_NOW)
    expect(reflection).toMatchObject({ strengthCount: 0, difficultyCount: 0, dueInScope: 0, dueOutsideScope: 2 })
    expect(reflection.nextStep).toContain('new saved word')
    next = await h.learning.prepareExercise(next, sessionId, 'demo-metro-card', rehearsalProposal(DEMO_ITEMS.find(m => m.id === 'demo-metro')!, 'production'), true)
    const exercise = next.state.exercises.at(-1)!
    next = await h.learning.submitAttempt(next, { id: 'practice-answer', exerciseId: exercise.id, answer: '地铁在哪里', submittedAt: DEMO_NOW })
    next = await h.learning.markGradingUnavailable(next, 'practice-answer', 'Fixture interrupted grading')
    expect(sessionReflection(next.state, sessionId, DEMO_NOW)).toMatchObject({ unresolved: 1, strengthCount: 0, difficultyCount: 0 })
    next = await h.learning.assessAttempt(next, 'practice-answer', { exerciseId: exercise.id, grade: 'correct', criteria: exercise.rubric.map(r => ({ criterionId: r.id, met: true, evidence: 'Saved exact response.' })), feedback: 'Correct.' }, { source: 'learner' })
    reflection = sessionReflection(next.state, sessionId, DEMO_NOW)
    expect(reflection).toMatchObject({ unresolved: 0, strengthCount: 0, difficultyCount: 0 })
    expect(sessionSummary(next.state, sessionId, DEMO_NOW).practices).toBe(1)
  })
})
