import { SubmissionFailure } from './stageSubmission'
import { validateGap } from '../questionGapTools'
import type { LessonGraph, WaypointLessonInput } from '../../domain/lessonGraph'
import { InputValidationError } from '../../domain/validation'
import type { QuestionGap, WaypointQuiz, RejectedQuestionSubmission } from '../../domain/lessonPreparation'
import { MAX_DIRECTION_REPLANS, rejectedQuestionCandidateSchema, questionCandidateSignature as signature, type QuizReplanLedger } from '../../domain/lessonPreparation'
export { MAX_DIRECTION_REPLANS, type QuizReplanLedger } from '../../domain/lessonPreparation'
import { InferenceFailure } from '../../ai/inferenceFailure'

function validateLedger(quiz: Pick<WaypointQuiz, 'lessonHash' | 'phase'>, ledger: QuizReplanLedger) {
  if (ledger.lessonHash !== quiz.lessonHash || ledger.phase !== quiz.phase || ledger.limit !== MAX_DIRECTION_REPLANS) throw new InputValidationError('The direction recovery ledger does not match this lesson, phase or bounded policy.')
}

/** Reject unchanged failed submissions; a presentation failure does not invalidate its learning goal. */
export function assertNewQuestionCandidate(quiz: Pick<WaypointQuiz, 'lessonHash' | 'phase'>, gap: QuestionGap, candidate: RejectedQuestionSubmission['candidate'], ledger?: QuizReplanLedger) {
  if (!ledger) return
  validateLedger(quiz, ledger)
  const rejected = ledger.rejectedDirections.find(entry => signature(entry.gap, entry.candidate) === signature(gap, candidate))
  if (rejected) throw new InputValidationError(`This question candidate was already rejected: ${rejected.reason} Resolve the reported issue rather than repeating it unchanged.`)
}

/** Caller supplies a validated checkpoint and persists both returned values before another inference. */
export function replanQuizDirection(quiz: WaypointQuiz, ledger: QuizReplanLedger | undefined, reason: string, model: string, cause?: InferenceFailure, submission?: RejectedQuestionSubmission, recoveryStart = 0) {
  const rejected = submission ?? quiz.pending
  if (quiz.complete || !rejected) throw new InputValidationError('Only a pending direction or rejected submission in an incomplete quiz can be replanned.')
  if (submission && quiz.pending) throw new InputValidationError('Resolve the pending question before replanning a different rejected submission.')
  if (!reason.trim() || reason.trim().length > 1000 || !model.trim() || model.length > 200) throw new InputValidationError('Direction recovery needs bounded review feedback and model provenance.')
  const current: QuizReplanLedger = ledger ?? { lessonHash: quiz.lessonHash, phase: quiz.phase, limit: MAX_DIRECTION_REPLANS, rejectedDirections: [] }
  validateLedger(quiz, current)
  if (!Number.isInteger(recoveryStart) || recoveryStart < 0 || recoveryStart > current.rejectedDirections.length) throw new InputValidationError('The question recovery window is invalid.')
  assertNewQuestionCandidate(quiz, rejected.gap, rejected.candidate, current)
  if (current.rejectedDirections.length - recoveryStart >= current.limit) throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget',
    retryable: false, stage: cause?.failure.stage ?? 'reviewQuestion', checkpointId: `${quiz.phase}-quiz`,
    message: 'Creation paused while preparing the next question. Your accepted questions are saved. Continue to try again using the saved feedback.',
    fields: [reason, ...(cause?.failure.fields ?? [])],
    ...(cause ? { originatingFailure: cause.failure.originatingFailure ?? {
      category: cause.failure.category, layer: cause.failure.layer, message: cause.failure.message,
      stage: cause.failure.stage, requestAttempt: cause.failure.requestAttempt,
      submissionAttempt: cause.failure.submissionAttempt, fields: cause.failure.fields,
    } } : {}) }, cause)
  const { pending: _pending, proposedDirections: _proposals, plannedGap: _plan, ...accepted } = quiz
  return { quiz: structuredClone(accepted), ledger: { ...structuredClone(current), rejectedDirections: [...structuredClone(current.rejectedDirections),
    { gap: structuredClone(rejected.gap), candidate: structuredClone(rejected.candidate), reason: reason.trim(), model }] } }
}

/** Preserve bounded rejected author output; never turn a schema failure into a playable question. */
export function rejectedQuestionSubmission(error: unknown, graph: LessonGraph, input: WaypointLessonInput, gap: QuestionGap) {
  if (!(error instanceof SubmissionFailure) || error.failure.category !== 'schema_invalid' || !error.failure.correctionExhausted) return undefined
  const candidate = rejectedQuestionCandidateSchema.safeParse(error.candidateArguments)
  return candidate.success ? { gap: validateGap(gap, graph, input), candidate: candidate.data } : undefined
}
