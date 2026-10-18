import { InferenceFailure } from '../../ai/inferenceFailure'
export type LessonExecutionPolicy = {
  submissionAttempts: number
  requestAttempts: number
  capacityWaits: number
  requestTimeoutMs: number
  stageTimeoutMs: number
  retryDelayMs: number
}

/** Workflow recovery policy is explicit and independent of model language profiles. */
export const defaultLessonExecutionPolicy: LessonExecutionPolicy = {
  submissionAttempts: 2, requestAttempts: 2, capacityWaits: 2, requestTimeoutMs: 120_000,
  stageTimeoutMs: 510_000, retryDelayMs: 250,
}

/** Capacity dispatches have a separate allowance; they are not model-quality attempts. */
export function lessonStageDispatchLimit(policy: LessonExecutionPolicy) {
  return policy.submissionAttempts * (policy.requestAttempts + policy.capacityWaits)
}

export function resolveLessonExecutionPolicy(value?: Partial<LessonExecutionPolicy>): LessonExecutionPolicy {
  const invalid = (message: string): never => { throw new InferenceFailure({ category: 'request_invalid', layer: 'validation', retryable: false, message }) }
  const policy = { ...defaultLessonExecutionPolicy, ...value }
  for (const [key, number] of Object.entries(policy)) {
    if (!Number.isInteger(number) || number < (key === 'retryDelayMs' || key === 'capacityWaits' ? 0 : 1)) invalid(`Invalid lesson execution policy: ${key}.`)
  }
  if (policy.submissionAttempts > 3 || policy.requestAttempts > 3) invalid('Lesson recovery attempts must remain bounded to three per layer.')
  if (policy.capacityWaits > 3) invalid('Provider capacity waits must remain bounded to three.')
  const required = policy.submissionAttempts * policy.requestAttempts * policy.requestTimeoutMs
    + policy.submissionAttempts * (policy.requestAttempts - 1) * policy.retryDelayMs
  if (policy.stageTimeoutMs <= required) invalid('The stage deadline must reserve time for its request/correction budgets and overhead.')
  return policy
}

