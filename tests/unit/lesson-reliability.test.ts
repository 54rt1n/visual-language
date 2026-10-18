import { describe, expect, it } from 'vitest'
import type { CaseResult } from '../evaluation/lesson-runner'
import { lessonReliability } from '../evaluation/lesson-reliability'

// Only observations consumed by the scorer are needed for these archived-report controls.
const trial = (prepared: boolean, calls: unknown[], extra = {}) => ({ prepared, scriptedPlaybackCompleted: prepared,
  calls, checkpointCommits: [], ...extra }) as CaseResult
const request = (completed: boolean, submission = 1, retry = 1) => ({ parsedResponseReceived: completed, repair: false,
  submissionAccepted: completed, request: { generationTrace: { attempt: { submission, request: retry } } } })

describe('lesson operational reliability', () => {
  it('reports failed tokenizer checks even when no inference request was dispatched', () => {
    const score = lessonReliability([trial(false, [], { tokenizationChecks: [
      { cached: false, failed: true }, { cached: false, failed: false }, { cached: true, failed: false },
    ] })], 1)
    expect(score).toMatchObject({ requestsAttempted: 0, lessonsReady: 0, tokenization: {
      checksObserved: 3, uncachedChecks: 2, cachedChecks: 1, failedChecks: 1,
      trialsReportingObservations: 1, trialsWithUnknownObservations: 0,
    } })
  })
  it('separates direct success, correction, transport recovery and failed trials', () => {
    const score = lessonReliability([
      trial(true, [request(true)], { checkpointCommits: [{ persisted: true }, { persisted: false }] }),
      trial(true, [request(false), request(true, 2)]),
      trial(true, [request(false), request(true, 1, 2)]),
      trial(false, [request(false)]),
    ], 6)
    expect(score).toMatchObject({ plannedTrials: 6, trialsFinished: 4, lessonsReady: 3,
      lessonsReadyWithoutRecovery: 1, lessonsReadyAfterRecovery: 2, lessonsReadyWithUnknownRecovery: 0,
      requestsAttempted: 6, responsesReceived: 3, requestsWithoutUsableResponse: 3,
      submissionsAcceptedByExecutor: 3, submissionsRejectedByExecutor: 3,
      acknowledgedDurableCheckpoints: 1, lessonReadinessPercentOfPlanned: 50 })
  })
  it('does not infer first-attempt success, submission acceptance or persistence from old reports', () => {
    const score = lessonReliability([trial(true, [{ parsedResponseReceived: true, request: {}, repair: false }], { checkpointCommits: undefined })], 1)
    expect(score).toMatchObject({ lessonsReady: 1, lessonsReadyWithoutRecovery: 0,
      lessonsReadyAfterRecovery: 0, lessonsReadyWithUnknownRecovery: 1,
      submissionOutcomesUnknown: 1, submissionsAcceptedByExecutor: 0,
      acknowledgedDurableCheckpoints: 0, trialsWithUnknownCheckpointObservations: 1 })
  })
  it('keeps capacity-blocked trials in readiness totals without calling them rejected submissions', () => {
    const capacity = { category: 'rate_limited', layer: 'request', httpStatus: 429,
      provider: { code: 'concurrency_limit_exceeded' } }
    const limited = { ...request(false), httpStatus: 429, failure: capacity }
    const score = lessonReliability([
      trial(false, [limited], { failure: { stage: 'buildQuestion', message: 'Busy', detail: capacity } }),
      trial(true, [limited, request(true, 1, 2)]),
      trial(false, [request(false)], { failure: { message: 'Invalid submission' } }),
    ], 3)
    expect(score).toMatchObject({ plannedTrials: 3, trialsFinished: 3, lessonsReady: 1,
      harnessCapacityErrors: 1, capacityLimitedRequests: 2, submissionsRejectedByExecutor: 1,
      requestsWithoutUsableResponse: 3, lessonsReadyAfterRecovery: 1 })
  })
  it('retains affirmative historical correction evidence when other attempt metadata is missing', () => {
    const score = lessonReliability([trial(true, [{ parsedResponseReceived: true, request: {}, repair: true }])], 1)
    expect(score).toMatchObject({ lessonsReadyAfterRecovery: 1, lessonsReadyWithUnknownRecovery: 0,
      trialsWithUnknownRecoveryEvidence: 1 })
  })
})
