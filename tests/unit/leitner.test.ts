import { describe, expect, it } from 'vitest'
import { DAY, dueQueue, exerciseMode, introduce, isDue, LEITNER_INTERVALS, resume, review, sessionQueue, suspend } from '../../src/lib/learning/leitner'
import { deterministicAssessment, normalizeAnswer, validateAssessment } from '../../src/lib/learning/assessment'
import { activeCard, exerciseProposal, newCard, NOW } from './fixtures'
import type { Exercise, LearningSession } from '../../src/lib/domain/learning'

describe('leitner-v1 pure policy', () => {
  it('requires explicit introduction and schedules the first exact 24-hour interval', () => {
    const original = newCard(), result = introduce(original, NOW)
    expect(original.status).toBe('new')
    expect(result).toMatchObject({ status: 'active', box: 1, revision: 1, introducedAt: NOW, dueAt: NOW + DAY })
    expect(() => introduce(result, NOW)).toThrow('new card')
  })
  it.each([1, 2, 3, 4, 5] as const)('promotes box %s once and resets a failed review', box => {
    const card = activeCard({ box }), destination = Math.min(box + 1, 5)
    expect(review(card, 'recalled', NOW, true)).toMatchObject({ box: destination, dueAt: NOW + LEITNER_INTERVALS[destination - 1]! * DAY, revision: 2 })
    expect(review(card, 'notRecalled', NOW, true)).toMatchObject({ box: 1, dueAt: NOW + DAY, revision: 2 })
  })
  it('never transitions for uncertain, early, or corrective practice', () => {
    const card = activeCard()
    expect(review(card, 'unresolved', NOW, true)).toEqual(card)
    expect(review(card, 'recalled', NOW, false)).toEqual(card)
    expect(exerciseMode(card, 'freeAnswer', NOW - 1)).toBe('practice')
    expect(review(card, 'recalled', NOW + DAY, false)).toEqual(card)
    expect(exerciseMode(card, 'multipleChoice', NOW)).toBe('practice')
    expect(exerciseMode({ ...card, skill: 'recognition' }, 'multipleChoice', NOW)).toBe('dueReview')
  })
  it('uses inclusive due boundaries, actual late submission time, and detects clock rollback', () => {
    const card = activeCard()
    expect(isDue(card, NOW - 1)).toBe(false); expect(isDue(card, NOW)).toBe(true)
    expect(review(card, 'recalled', NOW + 10 * DAY, true).dueAt).toBe(NOW + 13 * DAY)
    expect(() => review(card, 'recalled', NOW - 2 * DAY, true)).toThrow('clock')
  })
  it('preserves due dates on suspension and handles unintroduced suspension', () => {
    const card = activeCard(), stopped = suspend(card, NOW)
    expect(stopped.dueAt).toBe(card.dueAt); expect(isDue(stopped, NOW)).toBe(false)
    expect(isDue(resume(stopped, NOW + DAY), NOW + DAY)).toBe(true)
    expect(resume(suspend(newCard(), NOW), NOW).status).toBe('new')
  })
  it('sorts all due cards by due time, box, ID and reports out-of-topic counts', () => {
    const cards = [activeCard({ id: 'b' }), activeCard({ id: 'a' }), activeCard({ id: 'earlier', dueAt: NOW - 1 }), activeCard({ id: 'higher', box: 3 }), activeCard({ id: 'outside', itemId: 'outside' })]
    const items = [{ id: 'item', sourceRootIds: ['root'] }] as Parameters<typeof dueQueue>[2]['items']
    const queue = dueQueue(cards, NOW, { learnerId: 'learner', rootId: 'root', items, excludedIds: ['b'] })
    expect(queue.cards.map(c => c.id)).toEqual(['earlier', 'a', 'higher']); expect(queue.outsideScopeCount).toBe(1)
  })
  it('hitting a limit or skipping a due card does not unlock new material', () => {
    const session = { learnerId: 'learner', rootId: null, selectedCardIds: ['card'], completedCardIds: [], skippedCardIds: ['card'], maxReviewCards: 1, introducedItemIds: [], maxNewItems: 3 } as unknown as LearningSession
    const result = sessionQueue([activeCard(), activeCard({ id: 'second' })], [], session, NOW)
    expect(result.cards).toEqual([]); expect(result.remainingDueCount).toBe(2); expect(result.canIntroduce).toBe(false)
    expect(sessionQueue([], [], session, NOW).canIntroduce).toBe(true)
  })
})

describe('Mandarin assessment boundary', () => {
  const exercise = { ...exerciseProposal(), id: 'exercise', cardId: 'card', sessionId: 'session', cardRevision: 1, mode: 'dueReview', presentedAt: NOW } as Exercise
  it('accepts only frozen alternatives and does not erase tones or conflate senses', () => {
    expect(deterministicAssessment(exercise, '  谢谢！ ')?.grade).toBe('correct')
    expect(deterministicAssessment(exercise, '謝謝')?.grade).toBe('correct')
    expect(deterministicAssessment(exercise, '对不起')?.grade).toBe('incorrect')
    expect(normalizeAnswer('mǎ')).not.toBe(normalizeAnswer('mā'))
    expect(normalizeAnswer('ma3')).not.toBe(normalizeAnswer('ma'))
    expect(deterministicAssessment({ ...exercise, answerPolicy: 'contextual' }, '谢谢你帮我。')).toBeNull()
  })
  it('requires evidence for all criteria and rejects invented scheduling fields', () => {
    const valid = deterministicAssessment(exercise, '谢谢')!
    expect(() => validateAssessment({ ...valid, criteria: [] }, exercise)).toThrow('evidence')
    expect(() => validateAssessment({ ...valid, criteria: [{ criterionId: 'invented', met: true, evidence: 'Yes' }] }, exercise)).toThrow('unknown')
    expect(() => validateAssessment({ ...valid, dueAt: NOW }, exercise)).toThrow()
    expect(() => validateAssessment({ ...valid, criteria: [{ criterionId: 'meaning', met: false, evidence: 'Wrong sense' }] }, exercise)).toThrow('required')
  })
})
