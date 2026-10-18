import type { CaseResult } from './lesson-runner'
import { capacityLimitedRequest, lessonOperationalOutcome } from './provider-capacity'

/** Archived reports may lack newer observations; absence never proves success. */
export function lessonRecoveryEvidence(result: CaseResult) {
  const attempts = result.calls.map(call => call.request.generationTrace?.attempt)
  const recoveryObserved = result.calls.some((call, index) => call.repair
    || (attempts[index]?.submission ?? 1) > 1 || (attempts[index]?.request ?? 1) > 1)
  const recoveryEvidenceKnown = result.calls.length > 0 && attempts.every(attempt => attempt
    && Number.isInteger(attempt.submission) && attempt.submission >= 1
    && Number.isInteger(attempt.request) && attempt.request >= 1)
  return { recoveryObserved, recoveryEvidenceKnown,
    lessonReadyWithoutRecovery: result.prepared && recoveryEvidenceKnown && !recoveryObserved,
    lessonReadyAfterRecovery: result.prepared && recoveryObserved,
    lessonReadyWithUnknownRecovery: result.prepared && !recoveryObserved && !recoveryEvidenceKnown }
}

export function lessonReliability(results: CaseResult[], planned: number) {
  const calls = results.flatMap(result => result.calls), recovery = results.map(lessonRecoveryEvidence)
  const checkpointCases = results.filter(result => Array.isArray(result.checkpointCommits))
  const tokenizerCases = results.filter(result => Array.isArray(result.tokenizationChecks))
  const checks = tokenizerCases.flatMap(result => result.tokenizationChecks)
  return {
    plannedTrials: planned, trialsFinished: results.length, lessonsReady: results.filter(r => r.prepared).length,
    scriptedPlaybackCompleted: results.filter(r => r.scriptedPlaybackCompleted).length,
    harnessCapacityErrors: results.filter(r => lessonOperationalOutcome(r) === 'harness_capacity_error').length,
    capacityLimitedRequests: calls.filter(capacityLimitedRequest).length,
    lessonsReadyWithoutRecovery: recovery.filter(r => r.lessonReadyWithoutRecovery).length,
    lessonsReadyAfterRecovery: recovery.filter(r => r.lessonReadyAfterRecovery).length,
    lessonsReadyWithUnknownRecovery: recovery.filter(r => r.lessonReadyWithUnknownRecovery).length,
    trialsWithObservedRecovery: recovery.filter(r => r.recoveryObserved).length,
    trialsWithUnknownRecoveryEvidence: recovery.filter(r => !r.recoveryEvidenceKnown).length,
    requestsAttempted: calls.length, responsesReceived: calls.filter(c => c.parsedResponseReceived).length,
    parsedResponsesReceived: calls.filter(c => c.parsedResponseReceived).length,
    httpResponsesObserved: calls.filter(c => (c.httpStatus ?? c.diagnostic?.httpStatus) !== undefined).length,
    requestsWithoutUsableResponse: calls.filter(c => !c.parsedResponseReceived).length,
    submissionsAcceptedByExecutor: calls.filter(c => c.submissionAccepted === true).length,
    submissionsRejectedByExecutor: calls.filter(c => c.submissionAccepted === false && !capacityLimitedRequest(c)).length,
    submissionOutcomesUnknown: calls.filter(c => c.submissionAccepted === undefined).length,
    acknowledgedDurableCheckpoints: checkpointCases.flatMap(r => r.checkpointCommits).filter(c => c.persisted).length,
    trialsReportingCheckpointObservations: checkpointCases.length,
    trialsWithUnknownCheckpointObservations: results.length - checkpointCases.length,
    tokenization: { checksObserved: checks.length, uncachedChecks: checks.filter(c => !c.cached).length,
      cachedChecks: checks.filter(c => c.cached).length, failedChecks: checks.filter(c => c.failed).length,
      trialsReportingObservations: tokenizerCases.length, trialsWithUnknownObservations: results.length - tokenizerCases.length },
    lessonReadinessPercentOfPlanned: planned ? Math.round(results.filter(r => r.prepared).length / planned * 1000) / 10 : null,
    evidenceScope: 'Capacity limits are harness scheduling/recovery errors, not model or submission failures. All planned trials remain in operational readiness totals; capacity-blocked trials provide no completed model-quality outcome. Recovery means submission correction or transport retry. Semantic author/review revisions are ordinary workflow steps. Scripted playback does not measure learner accuracy or retention.'
  }
}
