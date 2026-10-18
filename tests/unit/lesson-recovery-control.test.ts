import { describe, expect, it } from 'vitest'
import { runLessonRecoveryControl, summarizeRecoveryControls, type RecoveryFault } from '../evaluation/lesson-recovery-control'
import { lessonFixture } from '../evaluation/lesson-runner'
import type { WaypointLessonInput } from '../../src/lib/domain/lessonGraph'
import { httpInferenceFailure } from '../../src/lib/ai/inferenceFailure'

const input: WaypointLessonInput = { kind: 'topic', objective: 'Understand thanks and apologies.', conversationContext: '谢谢。对不起。',
  settings: { quizLevel: 'meaningHanzi', complexity: 'phrases', scope: 'everyday', focus: 'characters', topic: 'Courtesy' },
  targets: [{ cardId: 'c1', hanzi: '谢谢', meaning: 'Thank you.' }, { cardId: 'c2', hanzi: '对不起', meaning: 'Sorry.' }],
  sources: [{ id: 's1', title: 'Courtesy', excerpt: '谢谢 means thank you; 对不起 means sorry.' }] }
const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', compatibility: 'featherless' as const }

describe('production workflow recovery controls', () => {
  it('does not count a recovered provider concurrency event as a rejected model submission', async () => {
    let blocked = false
    const result = await runLessonRecoveryControl(input, 'unavailable', { provider, executionPolicy: { retryDelayMs: 0 },
      transport: async request => {
        if (!blocked) { blocked = true; throw httpInferenceFailure(429, { message: 'Busy', retryAfterMs: 0,
          provider: { code: 'concurrency_limit_exceeded' } }) }
        return lessonFixture(request)
      },
    })
    expect(result.passed).toBe(true)
    expect(summarizeRecoveryControls([result], 1, 0)).toMatchObject({ completePreparations: 1,
      capacityEvents: 1, capacityLimitedModelRequests: 1, rejectedModelAttempts: 0 })
  })
  it('separates expected rejection, recovery, unknown usage and unattempted controls in the summary', async () => {
    const unavailable = await runLessonRecoveryControl(input, 'unavailable', { provider, transport: lessonFixture,
      executionPolicy: { retryDelayMs: 0 } })
    const rejected = await runLessonRecoveryControl(input, 'invalid_request', { provider, transport: lessonFixture })
    const summary = summarizeRecoveryControls([unavailable, rejected], 4, 0)
    expect(summary).toMatchObject({ plannedControls: 4, attemptedControls: 2, passedControls: 2,
      completePreparations: 1, expectedRequestRejections: 1, attemptsIncludingInjections: 32, injectedAttempts: 2,
      modelTransportAttempts: 30, liveDispatches: 0, parsedModelResponses: 30, acceptedModelSubmissions: 30,
      rejectedModelAttempts: 0, unknownModelSubmissionOutcomes: 0,
      modelUsage: { reportingAttempts: 0, unknownAttempts: 30, totalTokens: null } })
    const unknown = structuredClone(unavailable)
    delete unknown.calls[1]!.submissionAccepted
    expect(summarizeRecoveryControls([unknown], 1, 0)).toMatchObject({ acceptedModelSubmissions: 29,
      rejectedModelAttempts: 0, unknownModelSubmissionOutcomes: 1 })
  })
  it.each(['unavailable', 'timeout', 'invalid_request', 'cancel_resume', 'stream_capacity'] satisfies RecoveryFault[])(
    'verifies %s across the actual generation/checkpoint lifecycle', async fault => {
      const result = await runLessonRecoveryControl(input, fault, { provider, transport: lessonFixture,
        executionPolicy: { retryDelayMs: 0 } })
      expect(result.passed).toBe(true)
      if (fault === 'invalid_request') {
        expect(result.calls).toHaveLength(1)
        expect(result.calls[0]!.source).toBe('injected_fault')
      } else expect(result.complete).toBe(true)
      if (fault !== 'cancel_resume') expect(result.calls[0]!.failure).toMatchObject({ stage: 'buildWaypoint',
        attempt: 1, submissionAttempt: 1, requestAttempt: 1 })
      if (fault === 'cancel_resume') {
        expect(result.calls.some(c => c.run === 'resume')).toBe(true)
        expect(result.initialFailure?.category).toBe('cancelled')
        expect(result.preservedAcceptedContent).toBe(true)
        expect(result.resumeReauthoredGraph).toBe(false)
        expect(result.duplicateQuestions).toBe(false)
        expect(result.checkpointCommits).toContainEqual(expect.objectContaining({ checkpointId: 'practice-quiz',
          run: 'initial', persisted: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) }))
      }
      if (fault === 'stream_capacity') {
        expect(result.calls.slice(0, 3).map(c => c.source)).toEqual(['injected_fault', 'injected_fault', 'injected_fault'])
        expect(result.calls.slice(0, 4).map(c => c.request.generationTrace?.attempt)).toEqual(
          [1, 2, 3, 4].map(request => ({ submission: 1, request })))
        expect(result.calls.slice(0, 4).every(c => JSON.stringify(c.request.messages) === JSON.stringify(result.calls[0]!.request.messages))).toBe(true)
        expect(result.duplicateQuestions).toBe(false)
        expect(result.initialFailure).toBeUndefined()
      }
      expect(result.calls.filter(c => c.parsedResponseReceived).every(c => c.submissionAccepted === true)).toBe(true)
    },
  )
  it('does not call a failed resume a recovered cancellation', async () => {
    let resumed = false
    const result = await runLessonRecoveryControl(input, 'cancel_resume', { provider,
      executionPolicy: { requestAttempts: 1 },
      transport: async request => {
        if (resumed) throw new TypeError('Authored resume disconnection.')
        return lessonFixture(request)
      },
    }, async state => {
      if ((state as { calls: Array<{ run: string }> }).calls.some(c => c.run === 'resume')) resumed = true
    })
    expect(result.passed).toBe(false)
    expect(result.initialFailure?.category).toBe('cancelled')
    expect(result.resumedFailure?.category).toBe('transport_error')
    expect(result.complete).toBe(false)
  })
})
