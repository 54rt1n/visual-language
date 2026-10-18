import { describe, expect, it, vi } from 'vitest'
import { runCase, lessonCases, lessonFixture } from '../evaluation/lesson-runner'
import { scoreLessons } from '../evaluation/lesson-quality'
import { parseToolContext } from '../fixtures/tool-context'
import { waypointResult } from '../fixtures/topic-lesson'
import { httpInferenceFailure } from '../../src/lib/ai/inferenceFailure'

describe('provider failures through lesson evaluation and offline scoring', () => {
  it('keeps transport recovery, invalid submission, correction and semantic rejection distinct in one report', async () => {
    let attempts = 0
    const result = await runCase(lessonCases[0]!, { mode: 'fixture' }, undefined, async request => {
      attempts++
      if (attempts === 1) throw httpInferenceFailure(503, { message: 'Injected unavailable response.', retryAfterMs: 0 })
      if (parseToolContext(request.messages[1]!.content!).generationMode === 'verify_lesson_waypoint') {
        return waypointResult(request, { decision: 'reject', reason: 'Authored semantic rejection after recovery.' })
      }
      const response = await lessonFixture(request)
      if (attempts === 2) {
        const call = response.toolCalls[0]!
        call.function.arguments = JSON.stringify({ ...JSON.parse(call.function.arguments), unexpectedField: true })
      }
      return response
    })
    expect(result.calls).toHaveLength(4)
    const [unavailable, invalid, corrected, reviewed] = result.calls
    expect(unavailable).toMatchObject({ parsedResponseReceived: false, submissionAccepted: false,
      failure: { category: 'provider_unavailable', httpStatus: 503, stage: 'buildWaypoint',
        attempt: 1, submissionAttempt: 1, requestAttempt: 1 } })
    expect(invalid).toMatchObject({ parsedResponseReceived: true, submissionAccepted: false,
      failure: { category: 'schema_invalid', stage: 'buildWaypoint', submissionAttempt: 1, requestAttempt: 2 } })
    expect(corrected).toMatchObject({ parsedResponseReceived: true, submissionAccepted: true,
      request: { generationTrace: { attempt: { submission: 2, request: 1 } } } })
    expect(reviewed).toMatchObject({ parsedResponseReceived: true, submissionAccepted: true })
    expect(result.failure).toMatchObject({ detail: { category: 'review_rejected', layer: 'review', stage: 'reviewWaypoint' } })
    const source = JSON.stringify({ format: 'visual-language-lessons-evaluation', version: 2, status: 'finished',
      requestedProvider: 'fixture', requestedModel: 'mixed-lifecycle-control', corpusHash: 'mixed-lifecycle', codeHashes: {},
      selectedCaseIds: [result.caseId], repetitions: 1, results: [{ ...result, repetition: 1 }] })
    const score = await scoreLessons(source)
    expect(score.reliability).toMatchObject({ plannedTrials: 1, lessonsReady: 0, requestsAttempted: 4,
      parsedResponsesReceived: 3, submissionsAcceptedByExecutor: 2, requestsWithoutUsableResponse: 1 })
    expect(score.cases[0]!.failure).toMatchObject({ detail: { category: 'review_rejected' } })
    expect(score.releaseReady).toBe(false)
  })
  it('retains semantic rejection as a failed lesson despite valid parsed and accepted stage submissions', async () => {
    const result = await runCase(lessonCases[0]!, { mode: 'fixture' }, undefined, async request => {
      if (parseToolContext(request.messages[1]!.content!).generationMode === 'verify_lesson_waypoint') {
        return waypointResult(request, { decision: 'reject', reason: 'Authored rejection control.' })
      }
      return lessonFixture(request)
    })
    expect(result.failure).toMatchObject({ detail: { category: 'review_rejected', layer: 'review', stage: 'reviewWaypoint' } })
    expect(result.prepared).toBe(false)
    expect(result.calls).toHaveLength(2)
    expect(result.calls.every(call => call.parsedResponseReceived && call.submissionAccepted)).toBe(true)
    const source = JSON.stringify({ format: 'visual-language-lessons-evaluation', version: 2, status: 'finished',
      requestedProvider: 'fixture', requestedModel: 'authored-rejection-control', corpusHash: 'rejection-fixture', codeHashes: {},
      selectedCaseIds: [result.caseId], repetitions: 1, results: [{ ...result, repetition: 1 }] })
    const score = await scoreLessons(source)
    expect(score.reliability).toMatchObject({ plannedTrials: 1, lessonsReady: 0, requestsAttempted: 2,
      parsedResponsesReceived: 2, submissionsAcceptedByExecutor: 2, requestsWithoutUsableResponse: 0 })
    expect(score.cases[0]!.failure).toMatchObject({ detail: { category: 'review_rejected' } })
    expect(score.releaseReady).toBe(false)
  })
  it.each(['http_rejected', 'provider_stream_error', 'stream_incomplete', 'timeout'] as const)(
    'retains %s without counting it as a usable response or ready lesson', async category => {
      const key = 'diagnostic-fixture-key'
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        if (category === 'timeout') throw new DOMException('Injected timeout', 'TimeoutError')
        if (category === 'http_rejected') return Response.json({ error: { message: `Invalid turn for ${key}`, code: 'bad_turn' } },
          { status: 422, headers: { 'x-request-id': 'diagnostic-http-request' } })
        const frame = category === 'provider_stream_error'
          ? { error: { message: `Upstream error for ${key}`, code: 'upstream_failure' } }
          : { choices: [{ index: 0, delta: { content: 'Partial response' }, finish_reason: null }] }
        return new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { 'x-request-id': 'diagnostic-stream-request' } })
      })
      try {
        const result = await runCase(lessonCases[0]!, { mode: 'live', provider: 'featherless', model: 'authored-failure-control',
          apiKey: key, confirmed: true })
        expect(result.prepared).toBe(false)
        expect(result.calls.length).toBe(category === 'http_rejected' ? 1 : 2)
        expect(result.calls.every(call => !call.parsedResponseReceived && call.submissionAccepted === false && call.failure?.category === category)).toBe(true)
        if (category === 'http_rejected') expect(result.calls[0]!.failure).toMatchObject({ httpStatus: 422,
          requestId: 'diagnostic-http-request', provider: { code: 'bad_turn', message: 'Invalid turn for [redacted]' } })
        if (category === 'provider_stream_error') expect(result.calls[0]!.providerError).toMatchObject({ code: 'upstream_failure' })
        if (category === 'stream_incomplete') expect(result.calls[0]!.diagnostic).toMatchObject({ parserStatus: 'failed',
          terminalReceived: false, contentCharacters: 16 })
        const source = JSON.stringify({ format: 'visual-language-lessons-evaluation', version: 2, status: 'finished',
          requestedProvider: 'fixture', requestedModel: 'authored-failure-control', corpusHash: 'diagnostic-fixture', codeHashes: {},
          selectedCaseIds: [result.caseId], repetitions: 1, results: [{ ...result, repetition: 1 }] })
        expect(source).not.toContain(key)
        const score = await scoreLessons(source), stage = score.stages.find(s => s.stage === 'add_lesson_waypoint')!
        expect(stage.responseFailures.every(f => f.category === category)).toBe(true)
        expect(stage.operationalContractValidityPercent).toBe(0)
        expect(stage.responseValidityPercent).toBeNull()
        expect(score.reliability).toMatchObject({ plannedTrials: 1, lessonsReady: 0,
          requestsAttempted: result.calls.length, requestsWithoutUsableResponse: result.calls.length, responsesReceived: 0 })
      } finally { fetcher.mockRestore() }
    },
  )
})
