import { isProviderCapacity } from '../../src/lib/ai/inferenceFailure'
import type { CallEvidence, CaseResult } from './lesson-runner'

/** Capacity responses contain no model submission to evaluate. Keep the raw event for operations. */
export const providerCapacityError = isProviderCapacity

export function capacityLimitedRequest(call: CallEvidence) {
  return !call.parsedResponseReceived && (providerCapacityError(call.failure)
    || (call.httpStatus ?? call.diagnostic?.httpStatus) === 429)
}

export function lessonOperationalOutcome(result: Pick<CaseResult, 'prepared' | 'failure'>) {
  if (result.prepared) return 'ready' as const
  if (providerCapacityError(result.failure?.detail)) return 'harness_capacity_error' as const
  return result.failure ? 'workflow_error' as const : 'incomplete' as const
}
