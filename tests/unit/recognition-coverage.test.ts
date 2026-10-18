import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertRecognitionCoverage, recognitionEligibleWaypoints } from '../../src/lib/domain/coverageEvidence'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import { validateLessonPreparation, waypointQuestionHash, type LessonPreparation } from '../../src/lib/domain/lessonPreparation'
import { withAuthoredAnswerEvidence } from '../fixtures/topic-lesson'

const fixture = () => withAuthoredAnswerEvidence(JSON.parse(readFileSync('tests/evaluation/focused-cases/coverage-situation-preparation-qwen27b.json', 'utf8')).preparation as LessonPreparation)

describe('necessary recognition visibility evidence', () => {
  it('rejects the captured credit for an unshown expression without rejecting the visible one', () => {
    const p = fixture(), question = p.check!.questions[0]!.question
    expect(() => assertRecognitionCoverage(p.input, p.lesson.graph, question, ['w1'])).not.toThrow()
    expect(() => assertRecognitionCoverage(p.input, p.lesson.graph, question, ['w1', 'w2'])).toThrow('w2 cannot receive character-recognition credit')
    expect(() => assertRecognitionCoverage(p.input, p.lesson.graph, question, [])).not.toThrow()
  })
  it('does not credit recognition of a wrong Mandarin reply simply because it is visible', () => {
    const p = fixture(), input = { ...p.input, settings: { ...p.input.settings, quizLevel: 'responseHanzi' as const } }
    const question = { options: [{ id: 'A', text: '谢谢' }, { id: 'B', text: '对不起' }], correctOptionId: 'A' }
    expect(() => assertRecognitionCoverage(input, p.lesson.graph, question, ['w1'])).not.toThrow()
    expect(() => assertRecognitionCoverage(input, p.lesson.graph, question, ['w2'])).toThrow('w2 cannot receive')
  })
  it('leaves broader language/usage assessment to the reviewer outside character focus', () => {
    const p = fixture(), input = { ...p.input, settings: { ...p.input.settings, focus: 'complexity' as const } }
    expect(() => assertRecognitionCoverage(input, p.lesson.graph, p.check!.questions[0]!.question, ['w1', 'w2'])).not.toThrow()
  })
  it('rejects persisted false-ready coverage and permits a corrected incomplete checkpoint', () => {
    const p = fixture()
    for (const quiz of [p.practice, p.check]) for (const q of quiz?.questions ?? []) q.concealmentReview = { answerId: 'unknown', reason: 'Authored diagnostic plumbing; not a captured semantic rating.', model: 'authored-fixture', questionHash: waypointQuestionHash(q.question) }
    expect(() => validateLessonPreparation(p)).toThrow('w2 cannot receive')
    p.check!.complete = false
    p.check!.coverage = p.check!.coverage.filter(entry => entry.waypointId === 'w1')
    p.check!.questions[0]!.coverageReview!.waypointIds = ['w1']
    p.check!.questions[0]!.coverageReview!.assessment = 'Only the displayed thanks expression is assessed.'
    const corrected = validateLessonPreparation(JSON.parse(JSON.stringify(p)))
    expect(corrected.check!.complete).toBe(false)
    expect(corrected.check!.coverage.map(entry => entry.waypointId)).toEqual(['w1'])
  })
})

describe('recognition eligibility constrains claims without granting coverage', () => {
  it('excludes a visible wrong reply while retaining the reviewed correct expression', () => {
    const p = fixture(), input = { ...p.input, settings: { ...p.input.settings, quizLevel: 'responseHanzi' as const } }
    const question = { options: [{ id: 'A', text: '谢谢' }, { id: 'B', text: '对不起' }], correctOptionId: 'B' }
    expect(recognitionEligibleWaypoints(input, p.lesson.graph, question)).toEqual(['w2'])
    const schema = lessonStages.evaluateCoverage.schema({ ...input, recognitionEligibleWaypointIds: ['w2'] })
    expect(schema.safeParse({ waypointIds: ['w1'], assessment: 'The wrong reply appears.' }).success).toBe(false)
    expect(schema.safeParse({ waypointIds: ['w1', 'w2'], assessment: 'Both replies appear.' }).success).toBe(false)
    expect(schema.safeParse({ waypointIds: ['w2'], assessment: 'The learner selects the apology.' }).success).toBe(true)
    expect(schema.safeParse({ waypointIds: [], assessment: 'No understanding demonstrated.' }).success).toBe(true)
  })
  it('permits only empty claims when no target is eligible and leaves other learning focus unchanged', () => {
    const p = fixture(), q = { options: [{ id: 'A', text: '你好' }], correctOptionId: 'A' }
    expect(recognitionEligibleWaypoints(p.input, p.lesson.graph, q)).toEqual([])
    const schema = lessonStages.evaluateCoverage.schema({ ...p.input, recognitionEligibleWaypointIds: [] })
    expect(schema.safeParse({ waypointIds: [], assessment: 'No target visible.' }).success).toBe(true)
    expect(schema.safeParse({ waypointIds: ['w1'], assessment: 'Unsupported claim.' }).success).toBe(false)
    expect(recognitionEligibleWaypoints({ ...p.input, settings: { ...p.input.settings, focus: 'complexity' } }, p.lesson.graph, q)).toBeUndefined()
  })
})
