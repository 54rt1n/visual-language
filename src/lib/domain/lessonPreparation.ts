import { z } from 'zod'
import { blindQuestionResultSchema } from './blindQuestion'
import { questionAnswerReviewSchema, requireQuestionAnswerReview, validateQuestionAnswerEvidence } from './questionSolve'
import { englishAnswers } from './lessonSettings'
import { lessonGraphSchema, lessonWaypointSchema, waypointLessonInputSchema, validateLessonGraph, waypointContext, type LessonGraph, type WaypointLessonInput } from './lessonGraph'
import { quizDraftSchema } from '../learning/quiz'
import { validateWaypointQuestion, waypointQuestionSchema, waypointQuestionCandidateSchema, questionFromWaypoint } from '../learning/waypointQuestion'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sameRecord } from './common'
import { assertRecognitionCoverage, validateTargetCoverage } from './coverageEvidence'
const text = (max: number) => z.string().trim().min(1).max(max)
export const questionGapSchema = z.strictObject({
  waypointIds: z.array(text(20)).min(1).max(9), cardId: text(200),
  intent: text(300), whyMissing: text(500),
})
export type QuestionGap = z.infer<typeof questionGapSchema>
/** Recovery allowance for one unfinished question in one explicit preparation run. */
export const MAX_DIRECTION_REPLANS = 2
/** Bounded rejected evidence may be incomplete; pending/playable questions remain strict. */
export const rejectedQuestionCandidateSchema = waypointQuestionCandidateSchema.partial()
export const quizReplanLedgerSchema = z.strictObject({
  lessonHash: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(['practice', 'check']), limit: z.literal(MAX_DIRECTION_REPLANS),
  rejectedDirections: z.array(z.strictObject({ gap: questionGapSchema, candidate: rejectedQuestionCandidateSchema,
    reason: text(1000), model: text(200) })).min(1),
})
export type QuizReplanLedger = z.infer<typeof quizReplanLedgerSchema>
export type RejectedQuestionSubmission = Pick<QuizReplanLedger['rejectedDirections'][number], 'gap' | 'candidate'>
export const questionCandidateSignature = (gap: QuestionGap, candidate: z.infer<typeof rejectedQuestionCandidateSchema>) => JSON.stringify([
  gap.cardId, [...gap.waypointIds].sort(), ...(['stem', 'passage', 'answerA', 'answerB', 'answerC', 'answerD', 'correct', 'feedback'] as const)
    .map(key => candidate[key]?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() ?? ''),
])
export const waypointCoverageSchema = z.strictObject({
  waypointId: text(20), questionIds: z.array(z.string().regex(/^q[1-9]$/)).min(1).max(9),
  assessment: text(1000).describe('What these actual questions require the learner to understand about this waypoint.'),
})

export type ReviewedLessonGraph = { graph: LessonGraph; review: { decision: 'accept' | 'correct'; reason: string; model: string } }
const concealmentReviewSchema = blindQuestionResultSchema.extend({ questionHash: z.string().regex(/^[a-f0-9]{64}$/), model: text(200) })
const acceptedQuestionSchema = z.strictObject({
  answerReview: questionAnswerReviewSchema,
  concealmentReview: concealmentReviewSchema.optional(),
  id: z.string().regex(/^q[1-9]$/), gap: questionGapSchema, question: quizDraftSchema.shape.questions.element,
  coverageReview: z.strictObject({ questionHash: z.string().regex(/^[a-f0-9]{64}$/), waypointIds: z.array(lessonWaypointSchema.shape.id).max(9), cardIds: z.array(text(200)).max(9).optional(), assessment: text(1000) }).optional(),
  review: z.strictObject({ decision: z.enum(['accept', 'correct']), reason: text(1000), model: text(200) }),
})
export const waypointQuizSchema = z.strictObject({
  lessonHash: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(['practice', 'check']),
  questions: z.array(acceptedQuestionSchema).max(9), complete: z.boolean(), coverageReason: z.string().max(800),
  coverage: z.array(waypointCoverageSchema).max(9),
  replanning: quizReplanLedgerSchema.optional(),
  proposedDirections: text(1600).optional(),
  plannedGap: questionGapSchema.optional(),
  pending: z.strictObject({ stateHash: z.string().regex(/^[a-f0-9]{64}$/), gap: questionGapSchema,
    step: z.enum(['solve', 'review', 'revise', 'concealment', 'coverage']),
    candidate: waypointQuestionCandidateSchema, reviewRound: z.number().int().min(0).max(2),
    revision: text(1000).optional(), review: acceptedQuestionSchema.shape.review.optional(),
    coverageReview: acceptedQuestionSchema.shape.coverageReview.optional(),
    concealmentReview: concealmentReviewSchema.optional(),
    answerReview: questionAnswerReviewSchema.optional(),
  }).optional(),
})
export type AcceptedWaypointQuestion = z.infer<typeof acceptedQuestionSchema>
export type WaypointQuiz = z.infer<typeof waypointQuizSchema>

/** Replacement invalidates every witness together; only accepted quiz state and revision count survive. */
export function revisedQuestionPending(pending: NonNullable<WaypointQuiz['pending']>, candidate: NonNullable<WaypointQuiz['pending']>['candidate']): NonNullable<WaypointQuiz['pending']> {
  if (pending.step !== 'revise' || !pending.revision || pending.reviewRound >= 2) throw new Error('The pending question cannot be revised in this state.')
  return { stateHash: pending.stateHash, gap: pending.gap, candidate, step: 'solve', reviewRound: pending.reviewRound + 1 }
}

export const reviewedLessonGraphSchema = z.strictObject({ graph: lessonGraphSchema, review: z.strictObject({ decision: z.enum(['accept', 'correct']), reason: text(1000), model: text(200) }) })
export const lessonPreparationSchema = z.strictObject({ input: waypointLessonInputSchema, lesson: reviewedLessonGraphSchema, practice: waypointQuizSchema.optional(), check: waypointQuizSchema.optional() })
export type LessonPreparation = z.infer<typeof lessonPreparationSchema>

export function lessonPreparationHash(input: LessonPreparation['input'], graph: LessonGraph) {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({ input, graph }))))
}

/** Validate saved checkpoints at persistence/import boundaries, before trusting their completion. */
export function validateLessonPreparation(value: LessonPreparation) {
  const prep = lessonPreparationSchema.parse(value), { input } = prep, graph = validateLessonGraph(prep.lesson.graph, input)
  const hash = lessonPreparationHash(input, graph), signatures = new Set<string>()
  if (prep.check && !prep.practice?.complete) throw new Error('A lesson check requires completed practice preparation.')
  for (const phase of ['practice', 'check'] as const) {
    const quiz = prep[phase]
    if (!quiz) continue
    if (quiz.phase !== phase || quiz.lessonHash !== hash) throw new Error('The saved quiz belongs to a different lesson graph or phase.')
    validateQuizCoverageEvidence(quiz, graph, input)
    validatePendingQuestion(quiz, input, graph, phase === 'check' ? prep.practice?.questions ?? [] : [])
    const questionIds = new Set<string>()
    for (const [index, q] of quiz.questions.entries()) {
      if (q.id !== `q${index + 1}` || q.question.cardId !== q.gap.cardId) throw new Error('Saved question identity or target changed.')
      validateQuestionConcealment(q.question, q.concealmentReview, input)
      requireQuestionAnswerReview(q.question, q.answerReview, waypointQuestionHash(q.question))
      questionIds.add(q.id)
      const waypoints = waypointContext(graph, q.gap.waypointIds)
      if (new Set(q.gap.waypointIds).size !== q.gap.waypointIds.length || !graph.waypoints.some(w => q.gap.waypointIds.includes(w.id) && w.cardIds.includes(q.gap.cardId))) throw new Error('Saved question gap has invalid waypoint targets.')
      const sourceIds = input.sources.filter(s => waypoints.some(w => w.sourceIds.includes(s.id))).map(s => s.id)
      const canonical = validateWaypointQuestion(q.question, q.gap.cardId, { ...input, sources: input.sources.filter(s => sourceIds.includes(s.id)) }, phase)
      if (!sameRecord(JSON.parse(JSON.stringify(canonical)), JSON.parse(JSON.stringify(q.question)))) throw new Error('Saved question must preserve its validated content and pronunciation.')
      const signature = `${q.question.passage ?? ''}\n${q.question.stem}`.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
      if (signatures.has(signature)) throw new Error('Prepared lesson repeats a question.')
      signatures.add(signature)
    }
    const covered = new Set<string>()
    for (const coverage of quiz.coverage) {
      if (covered.has(coverage.waypointId) || !graph.waypoints.some(w => w.id === coverage.waypointId) || new Set(coverage.questionIds).size !== coverage.questionIds.length || coverage.questionIds.some(id => !questionIds.has(id))) throw new Error('Coverage must cite distinct waypoints and actual accepted questions.')
      covered.add(coverage.waypointId)
    }
    if (quiz.complete && (!quiz.questions.length || graph.waypoints.some(w => !covered.has(w.id)))) throw new Error('Completed quiz is missing coverage evidence.')
  }
  return prep
}

/** Accepted waypoint draft, distinct from a lesson approved for quiz preparation. */
export const lessonGraphDraftSchema = z.strictObject({
  input: waypointLessonInputSchema,
  graph: z.strictObject({ overview: z.string().max(1500), waypoints: z.array(lessonWaypointSchema).max(9) }),
  revision: z.strictObject({ waypointId: lessonWaypointSchema.shape.id.optional(), reason: text(1000) }).optional(),
  construction: z.strictObject({ limit: z.number().int().min(1).max(14), operations: z.number().int().min(0).max(14),
    states: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(15),
  }),
  pending: z.strictObject({ stateHash: z.string().regex(/^[a-f0-9]{64}$/), candidate: lessonWaypointSchema,
    reviewRound: z.number().int().min(0).max(2), revision: text(1000).optional(), requestedChange: text(1000).optional(),
  }).optional(),
})
export type LessonGraphDraft = z.infer<typeof lessonGraphDraftSchema>
export function validateGraphDraft(value: LessonGraphDraft) {
  const draft = lessonGraphDraftSchema.parse(value)
  if (draft.graph.waypoints.length) validateLessonGraph({ ...draft.graph, overview: draft.graph.overview || 'Lesson in preparation.' }, draft.input, false)
  if (draft.revision?.waypointId && !draft.graph.waypoints.some(w => w.id === draft.revision!.waypointId)) throw new Error('Draft revision references an unknown waypoint.')
  const hash = lessonPreparationHash(draft.input, draft.graph)
  if (draft.construction.operations > draft.construction.limit || new Set(draft.construction.states).size !== draft.construction.states.length
    || draft.construction.operations < draft.graph.waypoints.length || draft.construction.states.length > draft.construction.operations + 1
    || draft.construction.states.at(-1) !== hash) throw new Error('Graph construction history does not match the accepted state or budget.')
  if (draft.pending && (draft.pending.stateHash !== hash || draft.pending.candidate.id !== (draft.revision?.waypointId ?? `w${draft.graph.waypoints.length + 1}`))) throw new Error('Pending waypoint belongs to a different accepted graph or operation.')
  if (draft.pending) {
    const p = draft.pending
    if (p.revision && p.reviewRound >= 2) throw new Error('Pending waypoint has exhausted its revision budget.')
    const waypoints = draft.graph.waypoints.filter(w => w.id !== p.candidate.id)
    validateLessonGraph({ overview: 'Pending waypoint validation.', waypoints: [...waypoints, p.candidate] }, draft.input, false)
  }
  return draft
}

/** The retained ledger must come from evaluated accepted questions, not author tags. */
export function validateQuizCoverageEvidence(quiz: WaypointQuiz, graph: LessonGraph, input: WaypointLessonInput) {
  if (quiz.plannedGap) {
    const points = waypointContext(graph, quiz.plannedGap.waypointIds)
    if (!quiz.proposedDirections || !input.targets.some(t => t.cardId === quiz.plannedGap!.cardId)
      || !points.some(w => w.cardIds.includes(quiz.plannedGap!.cardId))) throw new Error('The planned question must reference its teaching point and target.')
    if (quiz.pending && !sameRecord(quiz.pending.gap, quiz.plannedGap)) throw new Error('The pending question differs from its selected learning point.')
  }
  for (const q of quiz.questions) {
    const review = q.coverageReview
    if (!review || !review.waypointIds.length) throw new Error('Accepted questions require evaluated question evidence before entering the quiz.')
    if (review && review.questionHash !== waypointQuestionHash(q.question)) throw new Error('Coverage evidence belongs to changed question content; evaluate it again.')
    if (review && (new Set(review.waypointIds).size !== review.waypointIds.length || review.waypointIds.some(id => !graph.waypoints.some(w => w.id === id)))) throw new Error('Question coverage review has invalid waypoint references.')
    assertRecognitionCoverage(input, graph, q.question, review.waypointIds)
    validateTargetCoverage(input, graph, q.question, review)
    const recorded = quiz.coverage.filter(c => c.questionIds.includes(q.id)).map(c => c.waypointId).sort()
    if (!sameRecord(recorded, [...(review?.waypointIds ?? [])].sort())) throw new Error('Coverage ledger must match evaluated question evidence.')
  }
  if (quiz.complete && input.sourceMaterial?.scope && input.targets.some(t => !quiz.questions.some(q => q.coverageReview?.cardIds?.includes(t.cardId)))) throw new Error('Completed quiz must assess every planned teaching target.')
  if (quiz.complete && (quiz.pending || quiz.proposedDirections || quiz.plannedGap || quiz.questions.some(q => !q.coverageReview))) throw new Error('A completed quiz cannot have pending proposals, candidates or unevaluated coverage.')
}

export function pendingQuestionContextHash(quiz: WaypointQuiz, previous: AcceptedWaypointQuestion[] = []) {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, canonical(v)])) : value
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(canonical({ lessonHash: quiz.lessonHash, phase: quiz.phase,
    questions: quiz.questions, coverage: quiz.coverage, proposedDirections: quiz.proposedDirections, plannedGap: quiz.plannedGap, replanning: quiz.replanning, previous })))))
}

export function validatePendingQuestion(quiz: WaypointQuiz, input: LessonPreparation['input'], graph: LessonGraph, previous: AcceptedWaypointQuestion[] = []) {
  if (quiz.replanning) {
    const ledger = quiz.replanning
    if (ledger.lessonHash !== quiz.lessonHash || ledger.phase !== quiz.phase) throw new Error('Direction recovery belongs to a different lesson or phase.')
    const signatures = new Set<string>()
    for (const rejected of ledger.rejectedDirections) {
      const signature = questionCandidateSignature(rejected.gap, rejected.candidate)
      if (signatures.has(signature)) throw new Error('Direction recovery must retain distinct rejected candidates.')
      signatures.add(signature)
      waypointContext(graph, rejected.gap.waypointIds)
      if (new Set(rejected.gap.waypointIds).size !== rejected.gap.waypointIds.length || !input.targets.some(t => t.cardId === rejected.gap.cardId)
        || !graph.waypoints.some(w => rejected.gap.waypointIds.includes(w.id) && w.cardIds.includes(rejected.gap.cardId))) throw new Error('Rejected direction references an unavailable waypoint or target.')
    }
    if (quiz.pending && signatures.has(questionCandidateSignature(quiz.pending.gap, quiz.pending.candidate))) throw new Error('Pending question repeats a rejected candidate.')
  }
  const pending = quiz.pending
  if (!pending) return
  if ((pending.step === 'revise') !== Boolean(pending.revision) || pending.step === 'coverage' && !pending.review
    || pending.coverageReview && pending.step !== 'coverage'
    || pending.step === 'concealment' && (!pending.review || !englishAnswers(input.settings.quizLevel))
    || pending.concealmentReview && !['concealment', 'coverage'].includes(pending.step)) throw new Error('Pending question step does not match its review state.')
  if (pending.revision && pending.reviewRound >= 2) throw new Error('Pending question has an exhausted revision budget.')
  if (pending.stateHash !== pendingQuestionContextHash(quiz, previous) || !quiz.proposedDirections) throw new Error('Pending question belongs to a different accepted quiz state.')
  waypointQuestionSchema(input.settings).parse(pending.candidate)
  if (pending.step === 'solve' && (pending.review || pending.coverageReview || pending.concealmentReview)) throw new Error('An unsolved candidate cannot retain downstream review evidence.')
  if (pending.answerReview || ['review', 'concealment', 'coverage'].includes(pending.step)) {
    const points = waypointContext(graph, pending.gap.waypointIds)
    const focused = { ...input, sources: input.sources.filter(s => points.some(w => w.sourceIds.includes(s.id))) }
    const question = validateWaypointQuestion(questionFromWaypoint(pending.candidate, pending.gap, graph, focused), pending.gap.cardId, focused, quiz.phase)
    if (!pending.answerReview) throw new Error('A reviewed question requires visible answer evidence.')
    validateQuestionAnswerEvidence(question, pending.answerReview, waypointQuestionHash(question))
    if (['review', 'concealment', 'coverage'].includes(pending.step)) requireQuestionAnswerReview(question, pending.answerReview, waypointQuestionHash(question))
  }
  if (pending.concealmentReview || pending.step === 'coverage') {
    const points = waypointContext(graph, pending.gap.waypointIds)
    const focused = { ...input, sources: input.sources.filter(s => points.some(w => w.sourceIds.includes(s.id))) }
    validateQuestionConcealment(validateWaypointQuestion(questionFromWaypoint(pending.candidate, pending.gap, graph, focused), pending.gap.cardId, focused, quiz.phase), pending.concealmentReview, input)
  }
  const { gap } = pending
  waypointContext(graph, gap.waypointIds)
  if (new Set(gap.waypointIds).size !== gap.waypointIds.length || !input.targets.some(t => t.cardId === gap.cardId)
    || !graph.waypoints.some(w => gap.waypointIds.includes(w.id) && w.cardIds.includes(gap.cardId))) throw new Error('Pending question references an unavailable waypoint or target.')
  if (pending.coverageReview) {
    const review = pending.coverageReview
    if (new Set(review.waypointIds).size !== review.waypointIds.length || review.waypointIds.some(id => !graph.waypoints.some(w => w.id === id))) throw new Error('Pending coverage has invalid waypoint references.')
    const context = waypointContext(graph, gap.waypointIds), focused = { ...input, sources: input.sources.filter(s => context.some(w => w.sourceIds.includes(s.id))) }
    const question = validateWaypointQuestion(questionFromWaypoint(pending.candidate, gap, graph, focused), gap.cardId, focused, quiz.phase)
    if (review.questionHash !== waypointQuestionHash(question)) throw new Error('Pending coverage evidence belongs to changed question content.')
    assertRecognitionCoverage(input, graph, question, review.waypointIds)
    validateTargetCoverage(input, graph, question, review)
  }
}

export function waypointQuestionHash(question: AcceptedWaypointQuestion['question']) {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(quizDraftSchema.shape.questions.element.parse(question)))))
}

/** Concealment is a necessary acceptance check, not independent language-quality approval. */
export function validateQuestionConcealment(question: Parameters<typeof waypointQuestionHash>[0], review: z.infer<typeof concealmentReviewSchema> | undefined, input: WaypointLessonInput) {
  if (!englishAnswers(input.settings.quizLevel)) {
    if (review) throw new Error('Mandarin-answer questions cannot carry an English-only concealment review.')
    return
  }
  if (!review || review.answerId !== 'unknown') throw new Error('English-answer questions require an English-only concealment check with no uniquely inferable answer.')
  if (review.questionHash !== waypointQuestionHash(question)) throw new Error('Concealment evidence belongs to changed question content; evaluate it again.')
}
