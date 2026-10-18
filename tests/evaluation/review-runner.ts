import { streamChat } from '../../src/lib/ai/client'
import type { ChatMessage, ChatResult } from '../../src/lib/ai/types'
import { providerDefaults } from '../../src/lib/settings'
import { lessonQuizContentReviewSchema } from '../../src/lib/teacher/contracts'
import { quizReviewInstructions, quizReviewSupported, FEEDBACK_GROUNDING_REVIEW } from '../../src/lib/teacher/quizReview'
import { parseCompletedJson, TEACHER_RULES } from '../../src/lib/teacher/teacherService'
import { digest, redact, type RunConfig } from './mandarin-runner'
import { CALIBRATED_REVIEW, EVIDENCE_FIRST_REVIEW, PRECISE_REVIEW } from './review-prompts'
import { assessOptionAudit, OPTION_AUDIT_REVIEW } from './review-audit'
import { combineQuestionSolve, parseQuestionSolve, questionSolveRequest, type AnswerSolve } from './review-question'
import { combineEnglishMask, englishMaskRequest, parseEnglishMask, type EnglishMask } from './review-english-mask'
import { type ReviewCase, type ReviewInput } from './review-corpus'
export { reviewCases, validateReviewCorpus } from './review-corpus'
export { digest, redact, type RunConfig } from './mandarin-runner'
export { questionSolveRequest } from './review-question'
export const variants = ['baseline', 'without-feedback-grounding', 'calibrated', 'focused', 'evidence-first', 'precise', 'option-audit', 'blind-audit', 'answer-audit', 'english-audit'] as const
export type ReviewVariant = typeof variants[number]
export const reviewCallLimit = (variant: ReviewVariant) => variant === 'blind-audit' || variant === 'answer-audit' || variant === 'english-audit' ? 2 : 1
const detailedVariant = (variant: ReviewVariant) => variant === 'option-audit' || variant === 'blind-audit' || variant === 'answer-audit'
export const independentReviewRequest = (input: ReviewInput, variant: ReviewVariant) => variant === 'english-audit' ? englishMaskRequest(input) : questionSolveRequest(input, variant === 'answer-audit')
/** Candidate context projection. Separate visible content from private teaching and the key. */
export function focusedReviewInput(input: ReviewInput) {
  return {
    generationMode: input.generationMode, phase: input.phase, objective: input.objective,
    lesson: { kind: input.lessonPlan.kind, settings: input.lessonPlan.settings, source: input.lessonPlan.source },
    taughtMaterial: input.lessonGuidance,
    questions: input.quiz.questions.map(q => ({
      cardId: q.cardId, target: input.targets.find(t => t.cardId === q.cardId),
      maximumMandarinComplexity: input.lessonPlan.settings.complexity,
      learnerSeesBeforeAnswering: { stem: q.stem, passage: q.passage, passagePinyin: q.passagePinyin, options: q.options },
      privateAnswerKey: q.correctOptionId,
      learnerSeesAfterAnswering: { explanation: q.explanation, distractorFeedback: q.distractorFeedback, workedExample: q.workedExample },
      sourceIds: q.sourceIds,
    })),
    sources: input.sources, practiceQuiz: input.practiceQuiz,
  }
}
export function reviewRequest(entry: ReviewCase, variant: ReviewVariant) {
  if (variant === 'english-audit') englishMaskRequest(entry.input) // Validate scope before opening reports or making calls.
  const messages: ChatMessage[] = [
    ...(variant === 'baseline' || variant === 'without-feedback-grounding' || variant === 'english-audit' ? quizReviewInstructions(true).map((task, i) => ({ role: 'system' as const, content: i === 0 ? `${TEACHER_RULES}\n${task}` : task })) : [{ role: 'system' as const, content: detailedVariant(variant) ? OPTION_AUDIT_REVIEW : variant === 'precise' ? PRECISE_REVIEW : variant === 'evidence-first' ? EVIDENCE_FIRST_REVIEW : CALIBRATED_REVIEW }]),
    { role: 'user', content: JSON.stringify(variant === 'focused' ? focusedReviewInput(entry.input) : entry.input) },
  ]
  if (variant === 'without-feedback-grounding') {
    // Explicit ablation of the promoted policy, never a second copy of it.
    const system = messages[messages.length - 2]!, suffix = `\n\n${FEEDBACK_GROUNDING_REVIEW}`
    if (!system.content?.endsWith(suffix)) throw new Error('The feedback-grounding policy must be the final review appendix for this ablation.')
    system.content = system.content.slice(0, -suffix.length)
  }
  return { messages, maxTokens: 3000, temperature: 0.2 }
}
export function assessReview(entry: ReviewCase, response: ChatResult, variant: ReviewVariant = 'baseline', independent?: unknown) {
  const value = parseCompletedJson(response), detailed = detailedVariant(variant) ? assessOptionAudit(value, entry.input) : undefined
  const masked = variant === 'english-audit' ? parseEnglishMask(independent, entry.input) : undefined
  const solved = reviewCallLimit(variant) === 2 && !masked ? parseQuestionSolve(independent, entry.input, variant === 'answer-audit') : undefined
  const assessed = detailed?.review ?? lessonQuizContentReviewSchema.parse(value)
  const review = masked ? combineEnglishMask(assessed, masked, entry.input) : solved ? combineQuestionSolve(assessed, solved, entry.input) : assessed, ids = entry.input.quiz.questions.map(q => q.cardId)
  if (JSON.stringify(review.questions.map(q => q.cardId).sort()) !== JSON.stringify([...ids].sort())) throw new Error('Review must cover each supplied target exactly once.')
  const accepted = quizReviewSupported(review, true), decisionCorrect = accepted === (entry.expected === 'accept')
  const defectDetected = entry.mustFail ? review.questions.find(q => q.cardId === entry.mustFail!.cardId)?.[entry.mustFail.criterion] === false : undefined
  return { review, ...(detailed ? { audit: detailed.audit } : {}), ...(solved ? { independent: solved } : {}), ...(masked ? { englishOnly: masked } : {}), accepted, decisionCorrect, defectDetected, pass: decisionCorrect && defectDetected !== false }
}
type ReviewCall = {
  stage: 'solve' | 'english-mask' | 'audit'; request: ReturnType<typeof reviewRequest>; requestHash: string; durationMs: number;
  wireRequest?: unknown; httpStatus?: number; response?: Omit<ChatResult, 'reasoning'>; error?: string;
}
export async function runReview(entry: ReviewCase, variant: ReviewVariant, config: RunConfig, signal?: AbortSignal, fixtureOverride?: typeof streamChat) {
  if (!variants.includes(variant)) throw new Error('Unknown reviewer variant.')
  if (config.mode === 'live' && (!config.confirmed || !config.apiKey.trim() || !config.model.trim() || !['featherless', 'nebius'].includes(config.provider) || fixtureOverride)) throw new Error('Live reviews require a supported provider, model, key and confirmation; no fixture substitution.')
  const request = reviewRequest(entry, variant), start = performance.now(), provider = config.mode === 'live' ? config.provider : 'featherless'
  const model = config.mode === 'live' ? config.model : 'authored-review-fixture', key = config.mode === 'live' ? config.apiKey : ''
  const result: {
    caseId: string; split: string; expected: string; variant: string; model: string; request: typeof request; inputHash: string; requestHash: string;
    durationMs: number; wireRequest?: unknown; httpStatus?: number; response?: Omit<ChatResult, 'reasoning'>; evaluation?: ReturnType<typeof assessReview>; error?: string; calls: ReviewCall[];
  } = { caseId: entry.id, split: entry.split, expected: entry.expected, variant, model, request, inputHash: await digest(JSON.stringify(entry.input)), requestHash: await digest(JSON.stringify(request)), durationMs: 0, calls: [] }
  try {
    const transport = config.mode === 'live' ? streamChat : fixtureOverride ?? (async options => {
      if (JSON.parse(options.messages.at(-1)!.content!).generationMode === 'inspectEnglishOnlyQuiz') {
        return { content: JSON.stringify({ questions: entry.input.quiz.questions.map(q => ({ cardId: q.cardId,
          inferredOptionId: entry.mustFail?.cardId === q.cardId && entry.mustFail.criterion === 'answerHidden' ? q.correctOptionId : null,
          evidence: 'Synthetic fixture inference, not model quality evidence.',
        })) }), reasoning: '', toolCalls: [], finishReason: 'stop', model }
      }
      if (JSON.parse(options.messages.at(-1)!.content!).generationMode === 'solveVisibleQuiz') {
        // Synthetic plumbing response, not an independent solver or quality score.
        const questions = entry.input.quiz.questions.map(q => ({ cardId: q.cardId, stimulusMeaning: q.passage?.trim() ? 'Synthetic full-passage meaning.' : null,
          options: q.options.map(o => ({ optionId: o.id, meaning: o.text, answersQuestion: o.id === q.correctOptionId, evidence: 'Synthetic choice check.' })),
          ...(variant === 'blind-audit' ? { answerHidden: true, levelAppropriate: true, freshContext: true } : {}), evidence: 'Synthetic question check.',
        }))
        return { content: JSON.stringify({ questions }), reasoning: '', toolCalls: [], finishReason: 'stop', model }
      }
      const questions = entry.input.quiz.questions.map(q => ({ cardId: q.cardId, oneCorrectAnswer: true, sourceSupported: true, skillAligned: true, answerHidden: true, levelAppropriate: true, lessonAligned: true, evidence: 'Synthetic expected response; no reviewer quality evidence.', ...(entry.mustFail?.cardId === q.cardId ? { [entry.mustFail.criterion]: false } : {}), ...(detailedVariant(variant) ? { optionReviews: q.options.map(o => ({ optionId: o.id, meaning: o.text, natural: true, feedbackAccurate: true, evidence: 'Synthetic option check.' })), workedExampleReview: { translationFaithful: true, sourceFaithful: true, evidence: 'Synthetic example check.' } } : {}) }))
      return { content: JSON.stringify({ verdict: entry.expected === 'accept' ? 'supported' : 'rejected', reasons: 'Authored fixture.', questions }), reasoning: '', toolCalls: [], finishReason: 'stop', model }
    })
    const invoke = async (stage: ReviewCall['stage'], nextRequest: typeof request) => {
      // One deadline per call, two calls at most; no repair or retry here.
      const combined = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
      combined.throwIfAborted()
      const call: ReviewCall = { stage, request: nextRequest, requestHash: await digest(JSON.stringify(nextRequest)), durationMs: 0 }
      result.calls.push(call); const began = performance.now()
      try {
        const response = await transport({ ...nextRequest, ...providerDefaults[provider], model, apiKey: key, handlers: { signal: combined }, fetcher: async (url, init) => {
          call.wireRequest = JSON.parse(String(init?.body)); const response = await fetch(url, init); call.httpStatus = response.status; return response
        } })
        combined.throwIfAborted()
        const { reasoning: _reasoning, ...recorded } = response
        call.response = recorded
        return response
      } catch (error) { call.error = error instanceof Error ? error.message.slice(0, 4000) : 'Review call failed.'; throw error }
      finally { call.durationMs = Math.round(performance.now() - began) }
    }
    let independent: AnswerSolve | EnglishMask | undefined
    if (variant === 'english-audit') independent = parseEnglishMask(parseCompletedJson(await invoke('english-mask', englishMaskRequest(entry.input))), entry.input)
    else if (reviewCallLimit(variant) === 2) independent = parseQuestionSolve(parseCompletedJson(await invoke('solve', questionSolveRequest(entry.input, variant === 'answer-audit'))), entry.input, variant === 'answer-audit')
    // Independent requests: neither model sees the other request's transcript/output.
    const response = await invoke('audit', request), last = result.calls.at(-1)!
    result.response = last.response; result.wireRequest = last.wireRequest; result.httpStatus = last.httpStatus
    result.evaluation = assessReview(entry, response, variant, independent)
  } catch (error) { result.error = error instanceof Error ? error.message.slice(0, 4000) : 'Review failed.' }
  result.durationMs = Math.round(performance.now() - start)
  return redact(result, [key])
}
export type ReviewResult = Awaited<ReturnType<typeof runReview>>
export function summarizeReviews(results: ReviewResult[]) {
  return [...new Set(results.map(r => `${r.model}\0${r.variant}\0${r.split}`))].map(group => {
    const rows = results.filter(r => `${r.model}\0${r.variant}\0${r.split}` === group), positive = rows.filter(r => r.expected === 'accept'), negative = rows.filter(r => r.expected === 'reject')
    const calls = rows.flatMap(r => r.calls), usage = calls.flatMap(c => c.response?.usage ? [c.response.usage] : [])
    return { model: rows[0]!.model, variant: rows[0]!.variant, split: rows[0]!.split, trials: rows.length, validResponses: rows.filter(r => r.evaluation).length,
      correctDecisions: rows.filter(r => r.evaluation?.decisionCorrect).length, positives: positive.length, negatives: negative.length,
      falseAccepts: negative.filter(r => r.evaluation?.accepted).length, falseRejects: positive.filter(r => r.evaluation && !r.evaluation.accepted).length,
      detectedDefects: negative.filter(r => r.evaluation?.defectDetected).length, passed: rows.filter(r => r.evaluation?.pass).length,
      errors: rows.filter(r => r.error).length, meanDurationMs: Math.round(rows.reduce((n, r) => n + r.durationMs, 0) / rows.length),
      calls: calls.length, tokens: usage.length ? usage.reduce((n, u) => n + u.totalTokens, 0) : null, callsWithUsage: usage.length }
  })
}
