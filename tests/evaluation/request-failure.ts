import type { ChatOptions } from '../../src/lib/ai/types'
import { classifyInferenceFailure } from '../../src/lib/ai/inferenceFailure'

/** Attribute every logged attempt, including transient attempts hidden by a later successful retry. */
export function requestFailure(error: unknown, request: Pick<ChatOptions, 'handlers' | 'generationTrace'>, evaluationDeadline?: AbortSignal) {
  const failure = classifyInferenceFailure(error, request.handlers?.signal), trace = request.generationTrace
  if (evaluationDeadline?.aborted && evaluationDeadline.reason === request.handlers?.signal?.reason) {
    return { ...failure.failure, category: 'budget_exhausted' as const, layer: 'budget' as const, retryable: false,
      message: 'Evaluation reached its whole-run time budget. Saved progress is retained.', checkpointId: 'lesson-evaluation',
      ...(trace ? { stage: trace.stage, ...(trace.attempt ? { attempt: trace.attempt.submission,
        submissionAttempt: trace.attempt.submission, requestAttempt: trace.attempt.request } : {}) } : {}) }
  }
  if (!trace) return failure.failure
  return failure.withContext({ stage: trace.stage, ...(trace.attempt ? { attempt: trace.attempt.submission,
    submissionAttempt: trace.attempt.submission, requestAttempt: trace.attempt.request } : {}) }).failure
}
