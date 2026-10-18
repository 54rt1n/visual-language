import { describe, expect, it } from 'vitest'
import type { WaypointQuiz } from '../../src/lib/domain/lessonPreparation'
import { assertNewQuestionCandidate, replanQuizDirection } from '../../src/lib/teacher/lessonGeneration/quizReplanning'
import { InferenceFailure } from '../../src/lib/ai/inferenceFailure'

// Accepted content is opaque to the recovery policy; full schema validation belongs to the checkpoint caller.
const fixture = () => ({ lessonHash: 'a'.repeat(64), phase: 'check', complete: false, coverageReason: '',
  questions: [{ id: 'q1', question: { stem: 'Already accepted question.' } }],
  coverage: [{ waypointId: 'w1', questionIds: ['q1'], assessment: 'Previously evaluated.' }],
  proposedDirections: [{ cardId: 'c2', waypointIds: ['w2'], intent: 'An infeasible integration.', whyMissing: 'A proposed gap.' }],
  pending: { gap: { cardId: 'c2', waypointIds: ['w2'], intent: 'An infeasible integration.', whyMissing: 'A proposed gap.' },
    candidate: { stem: 'Pending rejected question.' }, step: 'review', reviewRound: 2, stateHash: 'b'.repeat(64) },
}) as unknown as WaypointQuiz

describe('bounded quiz direction recovery policy', () => {
  it('records incomplete rejected evidence directly without creating or replacing a pending question', () => {
    const original = fixture(), { pending, ...quiz } = original
    const submission = { gap: pending!.gap, candidate: { passage: '请给我一杯茶。' } }
    const before = structuredClone(quiz)
    const result = replanQuizDirection(quiz, undefined, 'The question is missing an answer.', 'requested-model', undefined, submission)
    expect(quiz).toEqual(before)
    expect(result.quiz.questions).toEqual(before.questions)
    expect(result.quiz).not.toHaveProperty('pending')
    expect(result.ledger.rejectedDirections[0]!.candidate).toEqual(submission.candidate)
    expect(() => replanQuizDirection(original, undefined, 'Another submission.', 'requested-model', undefined, submission)).toThrow('Resolve the pending question')
  })
  it('allows a corrected candidate for the same learning intent without resetting recovery quota', () => {
    const quiz = fixture(), first = replanQuizDirection(quiz, undefined, 'Move Mandarin out of the English stem.', 'reviewer')
    quiz.pending!.candidate = { ...quiz.pending!.candidate, stem: 'The server asks whether you want sugar. Choose the reply declining sugar.' }
    expect(() => assertNewQuestionCandidate(quiz, quiz.pending!.gap, quiz.pending!.candidate, first.ledger)).not.toThrow()
    const second = replanQuizDirection(quiz, first.ledger, 'Another issue remains.', 'reviewer')
    expect(second.ledger.rejectedDirections).toHaveLength(2)
    expect(second.ledger.rejectedDirections[0]!.gap).toEqual(second.ledger.rejectedDirections[1]!.gap)
    quiz.pending!.candidate.stem = 'Third candidate for the same intent.'
    expect(() => replanQuizDirection(quiz, second.ledger, 'Still needs work.', 'reviewer')).toThrow('Creation paused')
    expect(quiz.questions).toHaveLength(1)
  })
  it.each(['reviseQuestion', 'reviewQuestion'])('retains the originating %s failure when the durable replan quota is exhausted', stage => {
    const quiz = fixture()
    const first = replanQuizDirection(quiz, undefined, 'Not feasible.', 'reviewer')
    quiz.pending!.gap.intent = 'Second direction.'
    quiz.pending!.candidate.stem = 'Second direction.'
    const second = replanQuizDirection(quiz, first.ledger, 'Still invalid.', 'reviewer')
    quiz.pending!.gap.intent = 'Third direction.'
    quiz.pending!.candidate.stem = 'Third direction.'
    const cause = new InferenceFailure({ category: 'constraints_invalid', layer: 'validation', stage,
      retryable: false, correctionExhausted: true, requestAttempt: 2, fields: ['Mandarin passage exceeds the ceiling.'], message: 'Revision failed.' })
    try {
      replanQuizDirection(quiz, second.ledger, cause.message, 'requested-model', cause)
      throw new Error('Expected quota exhaustion.')
    } catch (error) {
      expect(error).toMatchObject({ failure: { category: 'budget_exhausted', stage, checkpointId: 'check-quiz',
        fields: ['Revision failed.', 'Mandarin passage exceeds the ceiling.'] } })
      expect((error as Error).cause).toBe(cause)
      expect(JSON.parse(JSON.stringify((error as InferenceFailure).failure))).toMatchObject({ originatingFailure: {
        category: 'constraints_invalid', layer: 'validation', stage, requestAttempt: 2,
        fields: ['Mandarin passage exceeds the ceiling.'],
      } })
    }
  })
  it('keeps accepted content and evidence, records the rejected candidate and clears its pending route', () => {
    const quiz = fixture(), original = structuredClone(quiz)
    const result = replanQuizDirection(quiz, undefined, 'Two clauses exceed the selected ceiling.', 'reviewer')
    expect(quiz).toEqual(original)
    expect(result.quiz.questions).toEqual(original.questions)
    expect(result.quiz.coverage).toEqual(original.coverage)
    expect(result.quiz).not.toHaveProperty('pending')
    expect(result.quiz).not.toHaveProperty('proposedDirections')
    expect(result.quiz.questions).toHaveLength(1) // The rejected candidate never consumes q2.
    expect(result.ledger.rejectedDirections[0]).toEqual({ gap: original.pending!.gap, candidate: original.pending!.candidate,
      reason: 'Two clauses exceed the selected ceiling.', model: 'reviewer' })
  })
  it('preserves the quota across serialization and stops before a third new direction', () => {
    const quiz = fixture()
    const first = replanQuizDirection(quiz, undefined, 'Not feasible.', 'reviewer')
    quiz.pending!.gap.intent = 'Second rejected direction.'
    quiz.pending!.candidate.stem = 'Second rejected direction.'
    const second = replanQuizDirection(quiz, JSON.parse(JSON.stringify(first.ledger)), 'Still not feasible.', 'reviewer')
    quiz.pending!.gap.intent = 'Third direction.'
    quiz.pending!.candidate.stem = 'Third direction.'
    expect(() => replanQuizDirection(quiz, second.ledger, 'No more attempts.', 'reviewer')).toThrow(expect.objectContaining({
      failure: expect.objectContaining({ category: 'budget_exhausted', checkpointId: 'check-quiz' }) }))
    expect(second.ledger.rejectedDirections).toHaveLength(2)
  })
  it('starts a new bounded window without forgetting earlier rejected signatures', () => {
    const quiz = fixture(), original = structuredClone(quiz.pending!)
    const first = replanQuizDirection(quiz, undefined, 'First issue.', 'reviewer')
    quiz.pending!.candidate.stem = 'Second candidate.'
    const second = replanQuizDirection(quiz, first.ledger, 'Second issue.', 'reviewer')
    quiz.pending!.candidate.stem = 'Third candidate after Continue.'
    const third = replanQuizDirection(quiz, second.ledger, 'A new issue.', 'reviewer', undefined, undefined, 2)
    expect(third.ledger.rejectedDirections).toHaveLength(3)
    expect(() => assertNewQuestionCandidate(quiz, original.gap, original.candidate, third.ledger)).toThrow('already rejected')
    expect(() => replanQuizDirection(quiz, third.ledger, 'Invalid window.', 'reviewer', undefined, undefined, 4)).toThrow('window is invalid')
  })
  it('blocks repeating the same candidate under different intent or whyMissing metadata', () => {
    const quiz = fixture(), result = replanQuizDirection(quiz, undefined, 'Unsupported integration.', 'reviewer')
    const gap = { ...quiz.pending!.gap, intent: '  AN INFEASIBLE   INTEGRATION. ', whyMissing: 'New wording.' }
    expect(() => assertNewQuestionCandidate(quiz, gap, quiz.pending!.candidate, result.ledger)).toThrow('already rejected')
    expect(() => assertNewQuestionCandidate(quiz, { ...gap, intent: 'Pretend this unchanged question is a new task.' }, quiz.pending!.candidate, result.ledger)).toThrow('already rejected')
    expect(() => replanQuizDirection(quiz, result.ledger, 'Repeated.', 'reviewer')).toThrow('already rejected')
  })
  it('rejects a foreign phase/lesson, changed quota and completed checkpoints', () => {
    const quiz = fixture(), { ledger } = replanQuizDirection(quiz, undefined, 'Not feasible.', 'reviewer')
    for (const changed of [{ ...ledger, phase: 'practice' as const }, { ...ledger, lessonHash: 'c'.repeat(64) }, { ...ledger, limit: 3 }]) {
      expect(() => assertNewQuestionCandidate(quiz, quiz.pending!.gap, quiz.pending!.candidate, changed)).toThrow('does not match')
    }
    expect(() => replanQuizDirection({ ...quiz, complete: true }, undefined, 'Not feasible.', 'reviewer')).toThrow('incomplete quiz')
  })
})
