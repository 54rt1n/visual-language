import { z } from 'zod'
import { lessonPlanSchema } from '../../src/lib/domain/lessonPlan'
import { quizDraftSchema } from '../../src/lib/learning/quiz'
import { priorQuizQuestions } from '../../src/lib/teacher/lessonPrompts'
import { digest } from './mandarin-runner'
import { validateReviewCorpus, type ReviewCase, type ReviewInput } from './review-corpus'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().min(1)
export const reviewReplayAnnotationsSchema = z.strictObject({
  format: z.literal('visual-language-review-annotations'), version: z.literal(1), sourceSha256: hash,
  cases: z.array(z.strictObject({
    id: text, resultIndex: z.number().int().nonnegative(), callIndex: z.number().int().nonnegative(),
    inputHash: hash, expected: z.enum(['accept', 'reject']), rationale: text,
    mustFail: z.strictObject({ cardId: text, criterion: z.enum(['oneCorrectAnswer', 'sourceSupported', 'skillAligned', 'answerHidden', 'levelAppropriate', 'lessonAligned']) }).optional(),
  })).min(1).max(96),
})
const reportSchema = z.looseObject({
  format: z.literal('visual-language-lessons-evaluation'), version: z.literal(1),
  results: z.array(z.looseObject({ caseId: text, calls: z.array(z.looseObject({
    mode: text, request: z.looseObject({ messages: z.array(z.looseObject({ role: text, content: z.string().nullable().optional() })) }),
  })) })),
})
// Validate the fields the lab consumes, but replay the original JSON object intact.
const inputSchema = z.looseObject({
  generationMode: z.literal('reviewLessonQuiz'), phase: z.enum(['practice', 'check']), objective: text,
  lessonPlan: z.looseObject(lessonPlanSchema.shape), quiz: quizDraftSchema, practiceQuiz: z.unknown().optional(),
  sources: z.array(z.looseObject({ id: text, kind: text, title: text, excerpt: z.string() })).min(1),
  targets: z.array(z.looseObject({ cardId: text, hanzi: text, pinyin: z.string(), meaning: text, sense: text, skill: text, level: text, explanationLanguage: text })).min(1),
  lessonGuidance: z.looseObject({ overview: text, introductions: z.array(z.looseObject({ exampleHanzi: text, exampleMeaning: text, explanation: text })).min(1) }),
})

/** Explicit external annotations, never previous model verdicts or inferred labels. */
export async function loadReviewReplay(sourceText: string, annotationValue: unknown) {
  const annotations = reviewReplayAnnotationsSchema.parse(annotationValue)
  const sourceSha256 = await digest(sourceText)
  if (sourceSha256 !== annotations.sourceSha256) throw new Error('Replay source hash does not match annotations.')
  const report = reportSchema.parse(JSON.parse(sourceText))
  const seen = new Set<string>()
  const cases: ReviewCase[] = []
  const selected: Array<{ id: string; sourceCaseId: string; resultIndex: number; callIndex: number; inputHash: string }> = []
  for (const label of annotations.cases) {
    const position = `${label.resultIndex}:${label.callIndex}`
    if (seen.has(position)) throw new Error('Replay annotations must not duplicate a source call.')
    seen.add(position)
    const result = report.results[label.resultIndex], call = result?.calls[label.callIndex]
    if (!result || !call || !['review-practice', 'review-check'].includes(call.mode)) throw new Error('Replay annotation must select a recorded quiz review call.')
    const messages = call.request.messages
    const user = messages.at(-1)
    if (user?.role !== 'user' || !user.content || messages.filter(m => m.role === 'user').length !== 1) throw new Error('Replay expects a standalone final user review payload.')
    const input: unknown = JSON.parse(user.content)
    const validated = inputSchema.parse(input)
    if (call.mode !== `review-${validated.phase}` || validated.phase === 'check' && !validated.practiceQuiz) throw new Error('Replay phase and prior practice must match the recorded review mode.')
    if (validated.practiceQuiz !== undefined) priorQuizQuestions(validated.practiceQuiz)
    if (await digest(JSON.stringify(input)) !== label.inputHash) throw new Error('Replay input hash does not match its annotation.')
    cases.push({ id: label.id, split: 'replay', expected: label.expected, rationale: label.rationale,
      ...(label.mustFail ? { mustFail: label.mustFail } : {}), input: input as ReviewInput })
    selected.push({ id: label.id, sourceCaseId: result.caseId, resultIndex: label.resultIndex, callIndex: label.callIndex, inputHash: label.inputHash })
  }
  validateReviewCorpus(cases)
  return { cases, provenance: { sourceSha256, annotationsHash: await digest(JSON.stringify(annotations)), selected } }
}
