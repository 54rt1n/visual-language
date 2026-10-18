import { describe, expect, it, vi } from 'vitest'
import { assessReview, focusedReviewInput, reviewCases, reviewRequest, runReview, summarizeReviews, validateReviewCorpus } from '../evaluation/review-runner'
import type { ChatResult } from '../../src/lib/ai/types'
import { questionSolveInput, parseQuestionSolve, questionSolveRequest } from '../evaluation/review-question'
import { reviewCallLimit } from '../evaluation/review-runner'
import { loadReviewReplay } from '../evaluation/review-replay'
import { digest } from '../evaluation/mandarin-runner'
import { priorQuizQuestions } from '../../src/lib/teacher/lessonPrompts'

const response = (supported = true): ChatResult => ({ content: JSON.stringify({ verdict: supported ? 'supported' : 'rejected', reasons: 'Test reason.', questions: [{ cardId: 'target-1', oneCorrectAnswer: true, sourceSupported: true, skillAligned: true, answerHidden: true, levelAppropriate: supported, lessonAligned: true, evidence: 'Test evidence.' }] }), reasoning: '', toolCalls: [], finishReason: 'stop', model: 'fixture' })
describe('reviewer calibration', () => {
  it('has balanced, structurally valid calibration and separately reported regression cases', () => {
    expect(validateReviewCorpus()).toEqual({ cases: 34, positives: 17, negatives: 17 })
    expect(validateReviewCorpus(reviewCases.filter(c => c.split === 'calibration'))).toEqual({ cases: 14, positives: 7, negatives: 7 })
    expect(validateReviewCorpus(reviewCases.filter(c => c.split === 'regression'))).toEqual({ cases: 12, positives: 6, negatives: 6 })
    expect(validateReviewCorpus(reviewCases.filter(c => c.split === 'holdout'))).toEqual({ cases: 8, positives: 4, negatives: 4 })
  })
  it.each(reviewCases)('keeps expected labels outside requests and exercises $id', async entry => {
    for (const variant of ['baseline', 'without-feedback-grounding', 'calibrated', 'evidence-first', 'precise', 'option-audit', 'blind-audit', 'answer-audit'] as const) {
      const request = reviewRequest(entry, variant), payload = JSON.parse(request.messages.at(-1)!.content!)
      expect(payload).toEqual(JSON.parse(JSON.stringify(entry.input)))
      for (const field of ['expected', 'mustFail', 'rationale', 'split']) expect(payload).not.toHaveProperty(field)
      expect(request.messages.some(m => m.content?.includes(entry.rationale))).toBe(false)
      const result = await runReview(entry, variant, { mode: 'fixture' })
      expect(result.evaluation?.pass).toBe(true)
      expect(result.response?.model).toBe('authored-review-fixture')
    }
  })
  it('distinguishes decision agreement from detecting the expected defect', () => {
    const negative = reviewCases.find(c => c.mustFail?.criterion === 'sourceSupported')!
    expect(assessReview(negative, response(false))).toMatchObject({ decisionCorrect: true, defectDetected: false, pass: false })
    const valid = response(), parsed = JSON.parse(valid.content)
    parsed.questions[0].sourceSupported = false; valid.content = JSON.stringify(parsed)
    expect(assessReview(negative, valid)).toMatchObject({ accepted: false, defectDetected: true, pass: true })
    // The app also rejects a positive overall verdict when one criterion fails.
    expect(assessReview(reviewCases[0]!, valid).pass).toBe(false)
  })
  it('ablates only the promoted feedback policy without changing scoring or context', () => {
    const entry = reviewCases.find(c => c.id === 'courtesy-invented-event-feedback')!
    const baseline = reviewRequest(entry, 'without-feedback-grounding'), candidate = reviewRequest(entry, 'baseline')
    expect(candidate.messages).toHaveLength(baseline.messages.length)
    expect(candidate.messages.slice(0, -2)).toEqual(baseline.messages.slice(0, -2))
    expect(candidate.messages.at(-1)).toEqual(baseline.messages.at(-1))
    expect(candidate.messages.at(-2)!.content!.startsWith(baseline.messages.at(-2)!.content! + '\n\n')).toBe(true)
    expect(candidate.messages.at(-2)!.content).toContain('set sourceSupported false')
    expect(candidate.maxTokens).toBe(baseline.maxTokens)
    expect(candidate.temperature).toBe(baseline.temperature)
    expect(reviewCallLimit('without-feedback-grounding')).toBe(1)
    // An appendix must not silently introduce a new scoring policy.
    expect(assessReview(entry, response(), 'without-feedback-grounding')).toEqual(assessReview(entry, response(), 'baseline'))
  })
  it('separates visible questions from the private key and feedback without losing evidence', () => {
    const entry = reviewCases[0]!, original = structuredClone(entry.input), focused = focusedReviewInput(entry.input)
    expect(focused.sources).toEqual(entry.input.sources)
    expect(focused.questions[0]!.learnerSeesBeforeAnswering).not.toHaveProperty('correctOptionId')
    expect(focused.questions[0]!.privateAnswerKey).toBe(entry.input.quiz.questions[0]!.correctOptionId)
    expect(focused.questions[0]!.learnerSeesAfterAnswering.workedExample).toEqual(entry.input.quiz.questions[0]!.workedExample)
    expect(focused.questions[0]!.maximumMandarinComplexity).toBe('phrases')
    expect(entry.input).toEqual(original)
    expect(reviewRequest(entry, 'focused').messages.filter(m => m.role === 'system')).toEqual(reviewRequest(entry, 'calibrated').messages.filter(m => m.role === 'system'))
  })
  it('requires the designated defect on its actual target, not on a different question', () => {
    const entry = reviewCases.find(c => c.id === 'cafe-second-feedback-wrong')!
    const result = response(false), value = JSON.parse(result.content)
    value.questions = ['target-1', 'target-2'].map(cardId => ({ ...value.questions[0], cardId, levelAppropriate: true, sourceSupported: cardId !== 'target-1' }))
    result.content = JSON.stringify(value)
    expect(assessReview(entry, result)).toMatchObject({ decisionCorrect: true, defectDetected: false, pass: false })
    value.questions[0].sourceSupported = true; value.questions[1].sourceSupported = false
    result.content = JSON.stringify(value)
    expect(assessReview(entry, result)).toMatchObject({ decisionCorrect: true, defectDetected: true, pass: true })
    expect(() => validateReviewCorpus([{ ...entry, mustFail: { cardId: 'missing', criterion: 'sourceSupported' } }])).toThrow('name a question')
  })
  it('does not let a supported verdict override failed or unresolved option and example checks', async () => {
    const entry = reviewCases.find(c => c.id === 'tea-natural-options-valid')!
    const fixture = await runReview(entry, 'option-audit', { mode: 'fixture' })
    const original = fixture.response!, parsed = JSON.parse(original.content)
    for (const mutate of [
      (q: any) => { q.optionReviews[1].natural = false },
      (q: any) => { q.optionReviews[1].natural = null },
      (q: any) => { q.optionReviews[2].feedbackAccurate = false },
      (q: any) => { q.workedExampleReview.translationFaithful = false },
      (q: any) => { q.workedExampleReview.sourceFaithful = null },
    ]) {
      const value = structuredClone(parsed); mutate(value.questions[0])
      const result = assessReview(entry, { ...original, content: JSON.stringify(value) }, 'option-audit')
      expect(result.review.verdict).toBe('supported')
      expect(result.accepted).toBe(false)
    }
    for (const mutate of [
      (q: any) => { q.optionReviews.pop() },
      (q: any) => { q.optionReviews[1].optionId = q.optionReviews[0].optionId },
      (q: any) => { q.optionReviews[1].optionId = 'invented' },
    ]) {
      const value = structuredClone(parsed); mutate(value.questions[0])
      expect(() => assessReview(entry, { ...original, content: JSON.stringify(value) }, 'option-audit')).toThrow()
    }
    expect(() => assessReview(entry, original)).toThrow()
    expect(() => assessReview(entry, response(), 'option-audit')).toThrow()
  })
  it('rejects native calls, partial output and missing or duplicate target reviews', () => {
    const entry = reviewCases[0]!
    expect(() => assessReview(entry, { ...response(), finishReason: 'length' })).toThrow()
    const result = response(), value = JSON.parse(result.content)
    value.questions.push(value.questions[0]); result.content = JSON.stringify(value)
    expect(() => assessReview(entry, result)).toThrow('each supplied target')
    expect(() => assessReview(entry, { ...response(), toolCalls: [{ id: 'x', type: 'function', function: { name: 'draft', arguments: '{}' } }] })).toThrow()
    const missing = response(), parsed = JSON.parse(missing.content)
    delete parsed.questions[0].lessonAligned; missing.content = JSON.stringify(parsed)
    expect(() => assessReview(entry, missing)).toThrow('lessonAligned')
  })
  it('reports false accepts/rejects and errors separately, without retrying transport failures', async () => {
    const negative = reviewCases.find(c => c.expected === 'reject')!
    const positive = await runReview(reviewCases[0]!, 'baseline', { mode: 'fixture' }, undefined, async () => response(false))
    const missed = await runReview(negative, 'baseline', { mode: 'fixture' }, undefined, async () => response())
    const transport = vi.fn(async () => { throw new Error('network unavailable') })
    const failed = await runReview(negative, 'baseline', { mode: 'fixture' }, undefined, transport)
    expect(transport).toHaveBeenCalledOnce()
    expect(summarizeReviews([positive, missed, failed])[0]).toMatchObject({ trials: 3, falseAccepts: 1, falseRejects: 1, errors: 1, passed: 0 })
    await expect(runReview(negative, 'baseline', { mode: 'live', provider: 'featherless', model: 'x', apiKey: 'x', confirmed: true }, undefined, transport)).rejects.toThrow('no fixture substitution')
  })
  it('honors cancellation before dispatch', async () => {
    const controller = new AbortController(); controller.abort()
    const transport = vi.fn(async () => response())
    const result = await runReview(reviewCases[0]!, 'baseline', { mode: 'fixture' }, controller.signal, transport)
    expect(transport).not.toHaveBeenCalled(); expect(result.error).toBeTruthy()
  })
  it('withholds all proposed answers and teaching from the independent solve', () => {
    const original = structuredClone(reviewCases[0]!.input), changed = structuredClone(original)
    changed.quiz.questions[0]!.correctOptionId = 'choice-3'
    changed.quiz.questions[0]!.explanation = 'SECRET_KEY_HINT'
    changed.quiz.questions[0]!.workedExample.meaning = 'SECRET_KEY_HINT'
    changed.quiz.questions[0]!.distractorFeedback[0]!.explanation = 'SECRET_KEY_HINT'
    changed.targets[0]!.meaning = 'SECRET_KEY_HINT'
    changed.sources[0]!.excerpt = 'SECRET_KEY_HINT'
    changed.lessonGuidance.overview = 'SECRET_KEY_HINT'
    changed.objective = 'SECRET_KEY_HINT'
    expect(questionSolveInput(changed)).toEqual(questionSolveInput(original))
    expect(JSON.stringify(questionSolveInput(changed))).not.toContain('SECRET_KEY_HINT')
    const check = structuredClone(original); check.phase = 'check'; check.practiceQuiz = changed.quiz
    const projected = questionSolveInput(check)
    expect(projected.previousQuestions).toBeDefined()
    expect(JSON.stringify(projected)).not.toContain('SECRET_KEY_HINT')
    expect(projected.questions[0]!.passage).toBe(original.quiz.questions[0]!.passage)
  })
  it('requires exact independent coverage and blocks zero, multiple, wrong or unresolved choices', async () => {
    const entry = reviewCases[0]!, trial = await runReview(entry, 'blind-audit', { mode: 'fixture' })
    expect(trial.evaluation?.pass).toBe(true)
    expect(trial.calls.map(c => c.stage)).toEqual(['solve', 'audit'])
    const solved = JSON.parse(trial.calls[0]!.response!.content)
    for (const mutate of [
      (q: any) => { q.options[0].answersQuestion = false },
      (q: any) => { q.options[1].answersQuestion = true },
      (q: any) => { q.options[0].answersQuestion = false; q.options[1].answersQuestion = true },
      (q: any) => { q.options[1].answersQuestion = null },
      (q: any) => { q.levelAppropriate = false },
      (q: any) => { q.answerHidden = false },
      (q: any) => { q.freshContext = null },
    ]) {
      const changed = structuredClone(solved); mutate(changed.questions[0])
      expect(assessReview(entry, trial.response!, 'blind-audit', changed).accepted).toBe(false)
    }
    for (const mutate of [
      (s: any) => { s.questions.push(s.questions[0]) },
      (s: any) => { s.questions[0].stimulusMeaning = null },
      (s: any) => { s.questions[0].options.pop() },
      (s: any) => { s.questions[0].options[1].optionId = 'choice-1' },
      (s: any) => { s.questions[0].options[1].optionId = 'unknown' },
    ]) {
      const changed = structuredClone(solved); mutate(changed)
      expect(() => parseQuestionSolve(changed, entry.input)).toThrow()
    }
    expect(() => assessReview(entry, trial.response!, 'blind-audit')).toThrow()
    const failedTeaching = structuredClone(trial.response!), teaching = JSON.parse(failedTeaching.content)
    teaching.questions[0].workedExampleReview.sourceFaithful = false; failedTeaching.content = JSON.stringify(teaching)
    expect(assessReview(entry, failedTeaching, 'blind-audit', solved).accepted).toBe(false)
  })
  it('records both calls and usage without passing either transcript to the other stage', async () => {
    const entry = reviewCases[0]!, fixture = await runReview(entry, 'blind-audit', { mode: 'fixture' })
    let index = 0
    const result = await runReview(entry, 'blind-audit', { mode: 'fixture' }, undefined, async request => {
      expect(request.messages).toHaveLength(2)
      expect(request.messages).toEqual(fixture.calls[index]!.request.messages)
      return { ...fixture.calls[index++]!.response!, reasoning: 'not recorded', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } }
    })
    expect(result.evaluation?.pass).toBe(true)
    expect(result.request).toEqual(reviewRequest(entry, 'option-audit'))
    expect(JSON.stringify(result)).not.toContain('not recorded')
    expect(summarizeReviews([result])[0]).toMatchObject({ trials: 1, calls: 2, callsWithUsage: 2, tokens: 60 })
    expect(reviewCallLimit('blind-audit')).toBe(2); expect(reviewCallLimit('option-audit')).toBe(1)
    const failing = vi.fn(async () => ({ ...response(), content: '{}' }))
    const failed = await runReview(entry, 'blind-audit', { mode: 'fixture' }, undefined, failing)
    expect(failing).toHaveBeenCalledOnce(); expect(failed.calls).toHaveLength(1); expect(failed.evaluation).toBeUndefined()
    const controller = new AbortController()
    const aborted = await runReview(entry, 'blind-audit', { mode: 'fixture' }, controller.signal, async () => {
      controller.abort(); return { ...fixture.calls[0]!.response!, reasoning: '' }
    })
    expect(aborted.calls).toHaveLength(1); expect(aborted.error).toBeTruthy()
  })
  it('limits answer-only solving to visible choices and preserves every content-review gate', async () => {
    const entry = reviewCases[0]!, fixture = await runReview(entry, 'answer-audit', { mode: 'fixture' })
    expect(fixture.evaluation?.pass).toBe(true)
    expect(reviewCallLimit('answer-audit')).toBe(2)
    expect(fixture.request).toEqual(reviewRequest(entry, 'option-audit'))
    const payload = JSON.parse(questionSolveRequest(entry.input, true).messages[1]!.content)
    expect(Object.keys(payload).sort()).toEqual(['generationMode', 'questions'])
    expect(payload.questions).toEqual(questionSolveInput(entry.input).questions.map(q => ({ ...q, passage: q.passage ?? null })))
    const solved = JSON.parse(fixture.calls[0]!.response!.content)
    expect(solved.questions[0]).not.toHaveProperty('answerHidden')
    expect(() => parseQuestionSolve(solved, entry.input)).toThrow()
    const broad = await runReview(entry, 'blind-audit', { mode: 'fixture' })
    expect(() => parseQuestionSolve(JSON.parse(broad.calls[0]!.response!.content), entry.input, true)).toThrow()
    for (const criterion of ['oneCorrectAnswer', 'sourceSupported', 'skillAligned', 'answerHidden', 'levelAppropriate', 'lessonAligned']) {
      const audit = JSON.parse(fixture.response!.content); audit.questions[0][criterion] = false
      expect(assessReview(entry, { ...fixture.response!, content: JSON.stringify(audit) }, 'answer-audit', solved).accepted).toBe(false)
    }
    const ambiguous = structuredClone(solved); ambiguous.questions[0].options[1].answersQuestion = true
    expect(assessReview(entry, fixture.response!, 'answer-audit', ambiguous)).toMatchObject({ accepted: false, review: { questions: [{ oneCorrectAnswer: false }] } })
  })
  it('represents an absent passage explicitly without substituting the English stem', () => {
    const input = reviewCases.find(c => c.id === 'sugar-referent-changed')!.input
    const request = questionSolveRequest(input, true), payload = JSON.parse(request.messages[1]!.content)
    expect(payload.questions[0].passage).toBeNull()
    expect(payload.questions[0].stem).toBe(input.quiz.questions[0]!.stem)
    const withPassage = structuredClone(input); withPassage.quiz.questions[0]!.passage = '不要加糖。'
    expect(JSON.parse(questionSolveRequest(withPassage, true).messages[1]!.content).questions[0].passage).toBe('不要加糖。')
  })
  it('replays exact annotated review inputs without trusting the recorded model verdict', async () => {
    const entry = reviewCases[0]!, input = { ...entry.input, traceMetadata: 'preserve original payload' }
    const source = JSON.stringify({ format: 'visual-language-lessons-evaluation', version: 1,
      results: [{ caseId: 'original-workflow', calls: [{ mode: 'review-practice', request: reviewRequest({ ...entry, input }, 'baseline'), response: response(false) }] }] })
    const annotations = { format: 'visual-language-review-annotations', version: 1, sourceSha256: await digest(source),
      cases: [{ id: 'replayed-practice', resultIndex: 0, callIndex: 0, inputHash: await digest(JSON.stringify(input)), expected: 'accept', rationale: 'Independent annotation.' }] }
    const replay = await loadReviewReplay(source, annotations)
    expect(replay.cases[0]).toMatchObject({ expected: 'accept', split: 'replay', input: JSON.parse(JSON.stringify(input)) })
    const request = reviewRequest(replay.cases[0]!, 'answer-audit')
    expect(request.messages.at(-1)!.content).toBe(JSON.stringify(input))
    expect(JSON.stringify(request)).not.toContain('Independent annotation.')
    await expect(loadReviewReplay(source + ' ', annotations)).rejects.toThrow('source hash')
    await expect(loadReviewReplay(source, { ...annotations, cases: [{ ...annotations.cases[0], inputHash: '0'.repeat(64) }] })).rejects.toThrow('input hash')
    await expect(loadReviewReplay(source, { ...annotations, cases: [...annotations.cases, { ...annotations.cases[0], id: 'duplicate-call' }] })).rejects.toThrow('duplicate a source call')
    await expect(loadReviewReplay(source, { ...annotations, cases: [{ ...annotations.cases[0], callIndex: 99 }] })).rejects.toThrow('recorded quiz review call')
    await expect(loadReviewReplay(source, { ...annotations, cases: [{ ...annotations.cases[0], expected: 'reject' }] })).rejects.toThrow('specific expected defect')
    const check = JSON.parse(source); check.results[0].calls[0].mode = 'review-check'
    const changed = JSON.stringify(check)
    await expect(loadReviewReplay(changed, { ...annotations, sourceSha256: await digest(changed) })).rejects.toThrow('phase')
    const checkInput = { ...input, phase: 'check', practiceQuiz: priorQuizQuestions(input.quiz) }
    check.results[0].calls[0].request.messages.at(-1).content = JSON.stringify(checkInput)
    const checkSource = JSON.stringify(check)
    const checkReplay = await loadReviewReplay(checkSource, { ...annotations, sourceSha256: await digest(checkSource), cases: [{ ...annotations.cases[0], inputHash: await digest(JSON.stringify(checkInput)) }] })
    expect(checkReplay.cases[0]!.input.practiceQuiz).toEqual(checkInput.practiceQuiz)
    expect(checkReplay.cases[0]!.input.practiceQuiz!.questions[0]).not.toHaveProperty('correctOptionId')
  })
  it('does not pool calibration performance with held-out results', async () => {
    const calibration = await runReview(reviewCases[0]!, 'evidence-first', { mode: 'fixture' })
    const holdout = await runReview(reviewCases.find(c => c.split === 'holdout')!, 'evidence-first', { mode: 'fixture' }, undefined, async () => response(false))
    expect(summarizeReviews([calibration, holdout])).toMatchObject([
      { split: 'calibration', trials: 1, passed: 1, falseRejects: 0 },
      { split: 'holdout', trials: 1, passed: 0, falseRejects: 1 },
    ])
  })
})
