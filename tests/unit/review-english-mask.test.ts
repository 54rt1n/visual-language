import { describe, expect, it } from 'vitest'
import { englishMaskInput, englishMaskRequest, parseEnglishMask, combineEnglishMask } from '../evaluation/review-english-mask'
import { reviewCases, reviewRequest, runReview, reviewCallLimit } from '../evaluation/review-runner'
import { quizReviewSupported } from '../../src/lib/teacher/quizReview'

const entry = reviewCases.find(c => c.id === 'courtesy-neutral-context-valid')!
const mask = (inferredOptionId: string | null = null) => ({ questions: [{ cardId: entry.input.quiz.questions[0]!.cardId, inferredOptionId, evidence: 'Observable English evidence.' }] })

describe('English-only leakage diagnostic', () => {
  it('excludes the Mandarin stimulus and all private or contextual answer hints', () => {
    const input = structuredClone(entry.input), original = structuredClone(input)
    input.quiz.title = 'SECRET_TITLE'; input.objective = 'SECRET_OBJECTIVE'
    input.targets[0]!.meaning = 'SECRET_TARGET'; input.sources[0]!.excerpt = 'SECRET_SOURCE'
    input.lessonGuidance.overview = 'SECRET_GUIDANCE'
    input.quiz.questions[0]!.passage = 'SECRET_MANDARIN'; input.quiz.questions[0]!.passagePinyin = 'SECRET_PINYIN'
    input.quiz.questions[0]!.correctOptionId = 'SECRET_KEY'; input.quiz.questions[0]!.explanation = 'SECRET_FEEDBACK'
    input.quiz.questions[0]!.workedExample!.meaning = 'SECRET_EXAMPLE'
    input.quiz.questions[0]!.options[0]!.pinyin = 'SECRET_OPTION_PINYIN'
    input.practiceQuiz = { title: 'SECRET_PRIOR', questions: [] }
    expect(englishMaskInput(input)).toEqual(englishMaskInput(original))
    expect(JSON.stringify(englishMaskRequest(input))).not.toContain('SECRET_')
    expect(englishMaskInput(original).questions[0]).toEqual({ cardId: original.quiz.questions[0]!.cardId,
      stem: original.quiz.questions[0]!.stem, options: original.quiz.questions[0]!.options.map(o => ({ id: o.id, text: o.text })),
    })
  })
  it('requires English-choice scope and refuses Hanzi instead of silently masking it', () => {
    const reply = reviewCases.find(c => c.id === 'ticket-reply-valid')!
    expect(() => englishMaskInput(reply.input)).toThrow('English answer choices')
    expect(() => reviewRequest(reply, 'english-audit')).toThrow('English answer choices')
    const input = structuredClone(entry.input); input.quiz.questions[0]!.stem = 'What does 谢谢 mean?'
    expect(() => englishMaskInput(input)).toThrow('no Hanzi')
  })
  it('requires exact question coverage and an actual option ID or null', () => {
    expect(parseEnglishMask(mask(), entry.input)).toEqual(mask())
    expect(() => parseEnglishMask(mask('missing'), entry.input)).toThrow('actual option')
    expect(() => parseEnglishMask({ questions: [...mask().questions, ...mask().questions] }, entry.input)).toThrow('exactly once')
    expect(() => parseEnglishMask({ questions: [{ ...mask().questions[0], cardId: 'missing' }] }, entry.input)).toThrow('exactly once')
  })
  it('can veto a matching English-only answer but never overrides another review defect', async () => {
    const baseline = await runReview(entry, 'baseline', { mode: 'fixture' }), review = baseline.evaluation!.review
    const key = entry.input.quiz.questions[0]!.correctOptionId
    const vetoed = combineEnglishMask(review, mask(key), entry.input)
    expect(vetoed.questions[0]!.answerHidden).toBe(false)
    expect(quizReviewSupported(vetoed, true)).toBe(false)
    const original = structuredClone(review); original.questions[0]!.sourceSupported = false
    expect(quizReviewSupported(combineEnglishMask(original, mask(), entry.input), true)).toBe(false)
    expect(combineEnglishMask(review, mask(), entry.input)).toEqual(review)
    const other = entry.input.quiz.questions[0]!.options.find(o => o.id !== key)!.id
    expect(combineEnglishMask(review, mask(other), entry.input)).toEqual(review)
  })
  it('keeps the two calls independent and retains the unmodified production review', async () => {
    const baseline = await runReview(entry, 'baseline', { mode: 'fixture' })
    const inference = mask(entry.input.quiz.questions[0]!.correctOptionId); inference.questions[0]!.evidence = 'SECRET_MASK_RESULT'
    const seen: unknown[] = []
    const result = await runReview(entry, 'english-audit', { mode: 'fixture' }, undefined, async options => {
      seen.push(options.messages)
      return seen.length === 1 ? { content: JSON.stringify(inference), toolCalls: [], finishReason: 'stop', model: 'fixture', reasoning: '' } : { ...baseline.response!, reasoning: '' }
    })
    expect(reviewCallLimit('english-audit')).toBe(2)
    expect(result.calls.map(c => c.stage)).toEqual(['english-mask', 'audit'])
    expect(seen[1]).toEqual(reviewRequest(entry, 'baseline').messages)
    expect(JSON.stringify(seen[1])).not.toContain('SECRET_MASK_RESULT')
    expect(result.evaluation).toMatchObject({ accepted: false, englishOnly: inference })
  })
  it('stops after invalid masked output without running or fabricating an audit', async () => {
    let calls = 0
    const result = await runReview(entry, 'english-audit', { mode: 'fixture' }, undefined, async () => {
      calls++
      return { content: JSON.stringify(mask('missing')), toolCalls: [], finishReason: 'stop', model: 'fixture', reasoning: '' }
    })
    expect(calls).toBe(1); expect(result.calls).toHaveLength(1)
    expect(result.error).toContain('actual option'); expect(result.evaluation).toBeUndefined()
  })
})
