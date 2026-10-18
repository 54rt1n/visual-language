import { describe, expect, it } from 'vitest'
import type { Exercise } from '../../src/lib/domain/learning'
import { completeWorkedExample, validateTeacherAssessment } from '../../src/lib/teacher/feedback'
import { freeExerciseProposalSchema } from '../../src/lib/teacher/contracts'
import { quizDraftSchema, quizProposalSchema } from '../../src/lib/learning/quiz'
import { workedExampleProposalSchema } from '../../src/lib/domain/workedExample'
import { THANKS_EXAMPLE, TEA_EXAMPLE } from '../fixtures/worked-examples'
import { exerciseProposal, NOW } from './fixtures'

// Authored contract cases, not evidence that a live model grades Mandarin correctly.
const exercise: Exercise = { ...exerciseProposal({ answerPolicy: 'contextual' }), id: 'tea-exercise', cardId: 'card', sessionId: 'session',
  mode: 'dueReview', cardRevision: 1, presentedAt: NOW, prompt: 'Ask politely for a cup of tea, not coffee.', expectedAnswer: '请给我一杯茶。',
  rubric: [{ id: 'tea', description: 'Requests tea, not coffee.', required: true }, { id: 'polite', description: 'Uses a polite request.', required: true }] }
const assessment = (grade: string, tea: boolean | null, polite: boolean | null, workedExample: unknown) => ({ exerciseId: exercise.id, grade,
  criteria: [{ criterionId: 'tea', met: tea, evidence: tea === null ? 'The intended referent is unclear.' : tea ? '茶 requests tea.' : '咖啡 requests coffee, not tea.' },
    { criterionId: 'polite', met: polite, evidence: polite === null ? 'The intended request is unclear.' : polite ? '请 makes the request polite.' : 'The answer does not use the required polite request.' }],
  feedback: 'Authored application-validation case.', workedExample })

describe('paired teaching material contracts', () => {
  it('computes pinyin from the actual sentence and keeps its full translation', () => {
    const example = completeWorkedExample(TEA_EXAMPLE)
    expect(example).toMatchObject(TEA_EXAMPLE); expect(example.pinyin).toContain('chá'); expect(example.pinyin).toContain('qǐng')
    expect(workedExampleProposalSchema.safeParse({ ...TEA_EXAMPLE, pinyin: 'invented' }).success).toBe(false)
    expect(workedExampleProposalSchema.safeParse({ ...TEA_EXAMPLE, meaning: ' ' }).success).toBe(false)
  })
  it('keeps partial success incorrect with criterion evidence and a paired correction', () => {
    const value = validateTeacherAssessment(assessment('incorrect', false, true, TEA_EXAMPLE), exercise)
    expect(value.grade).toBe('incorrect'); expect(value.criteria.map(c => c.met)).toEqual([false, true])
    expect(value.workedExample).toEqual(completeWorkedExample(TEA_EXAMPLE))
    expect(() => validateTeacherAssessment(assessment('correct', false, true, TEA_EXAMPLE), exercise)).toThrow('all required criteria')
  })
  it('requires explicit uncertainty without a fabricated corrective example', () => {
    expect(validateTeacherAssessment(assessment('uncertain', null, null, null), exercise)).toMatchObject({ grade: 'uncertain', workedExample: undefined })
    expect(() => validateTeacherAssessment(assessment('uncertain', null, null, TEA_EXAMPLE), exercise)).toThrow('uncertainty must not invent')
    expect(() => validateTeacherAssessment(assessment('correct', true, true, null), exercise)).toThrow('paired worked example')
  })
  it('still rejects wrong-exercise and missing-evidence grades even with a complete example', () => {
    expect(() => validateTeacherAssessment({ ...assessment('correct', true, true, TEA_EXAMPLE), exerciseId: 'another' }, exercise)).toThrow('different exercise')
    expect(() => validateTeacherAssessment({ ...assessment('correct', true, true, TEA_EXAMPLE), criteria: [] }, exercise)).toThrow('criterion-level evidence')
  })
  it('requires examples on newly generated free questions while leaving saved legacy questions readable', () => {
    const { format: _format, provider: _provider, model: _model, promptVersion: _version, sourceNodeIds: _nodes, ...proposal } = exerciseProposal()
    const sourced = { ...proposal, sourceIds: ['local-item'] }
    expect(freeExerciseProposalSchema.safeParse(sourced).success).toBe(false)
    expect(freeExerciseProposalSchema.safeParse({ ...sourced, workedExample: THANKS_EXAMPLE }).success).toBe(true)
  })
  it('requires a worked example on the native proposal but accepts an older stored quiz', () => {
    const quiz = { title: 'Legacy thanks', questions: [{ cardId: 'card', stem: 'Which expression means thank you?', options: ['谢谢', '你好', '再见', '不客气'].map((text, i) => ({ id: String(i), text })),
      correctOptionId: '0', explanation: '谢谢 expresses thanks.', distractorFeedback: ['1', '2', '3'].map(optionId => ({ optionId, explanation: 'Not the thanks expression.' })),
      sourceIds: ['local-item'], objective: 'Recognize thanks.' }] }
    expect(quizDraftSchema.safeParse(quiz).success).toBe(true)
    expect(quizProposalSchema.safeParse(quiz).success).toBe(false)
    expect(quizProposalSchema.safeParse({ ...quiz, questions: quiz.questions.map(q => ({ ...q, workedExample: THANKS_EXAMPLE })) }).success).toBe(true)
  })
})
