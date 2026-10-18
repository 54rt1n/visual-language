import { describe, expect, it } from 'vitest'
import { requestFailure } from '../evaluation/request-failure'
import { InferenceFailure } from '../../src/lib/ai/inferenceFailure'
import type { ChatOptions } from '../../src/lib/ai/types'

const generationTrace: NonNullable<ChatOptions['generationTrace']> = {
  workflowVersion: 'fixture', promptVersion: 'fixture', lessonDefinition: { kind: 'topic', version: 'fixture' },
  modelProfile: { id: 'fixture', version: 'fixture', hash: 'fixture' }, stage: 'buildQuestion',
  settings: { maxTokens: 4096, temperature: 0, reasoning: 'off' }, attempt: { submission: 2, request: 3 },
}
describe('request failure evidence attribution', () => {
  it('attributes the controlling evaluation deadline to a non-retryable whole-run budget', () => {
    const deadline = new AbortController(); deadline.abort(new DOMException('Expired', 'TimeoutError'))
    const signal = AbortSignal.any([deadline.signal])
    expect(requestFailure(new Error('Fetch aborted'), { generationTrace, handlers: { signal } }, deadline.signal)).toMatchObject({
      category: 'budget_exhausted', layer: 'budget', retryable: false, checkpointId: 'lesson-evaluation',
      stage: 'buildQuestion', submissionAttempt: 2, requestAttempt: 3 })
  })
  it('retains a request timeout when the whole-run deadline has not expired', () => {
    const deadline = new AbortController(), request = new AbortController()
    request.abort(new DOMException('Request expired', 'TimeoutError'))
    expect(requestFailure(new Error('Fetch aborted'), { generationTrace, handlers: { signal: request.signal } }, deadline.signal)).toMatchObject({
      category: 'timeout', layer: 'transport', retryable: true })
  })
  it('preserves user cancellation if it won before a later evaluation deadline', () => {
    const user = new AbortController(), deadline = new AbortController()
    const signal = AbortSignal.any([user.signal, deadline.signal])
    user.abort(new DOMException('User stopped', 'AbortError'))
    deadline.abort(new DOMException('Expired', 'TimeoutError'))
    expect(requestFailure(new Error('Fetch aborted'), { generationTrace, handlers: { signal } }, deadline.signal)).toMatchObject({
      category: 'cancelled', layer: 'transport', retryable: false })
  })
  it('uses the actual request identity while preserving diagnostics and the original exception', () => {
    const error = new InferenceFailure({ category: 'provider_unavailable', layer: 'request', message: 'Unavailable.',
      retryable: true, httpStatus: 503, requestId: 'provider-id', checkpointId: 'practice-quiz', provider: { code: 'upstream' } })
    const record = requestFailure(error, { generationTrace })
    expect(record).toMatchObject({ stage: 'buildQuestion', attempt: 2, submissionAttempt: 2, requestAttempt: 3,
      httpStatus: 503, requestId: 'provider-id', checkpointId: 'practice-quiz', provider: { code: 'upstream' } })
    expect(error.failure).not.toHaveProperty('stage')
  })
  it('does not invent absent attempt metadata or erase known context', () => {
    const error = new InferenceFailure({ category: 'timeout', layer: 'transport', message: 'Timeout.', retryable: true,
      stage: 'reviewGraph', requestAttempt: 2 })
    expect(requestFailure(error, {})).toEqual(error.failure)
    const { attempt: _attempt, ...stageOnly } = generationTrace
    expect(requestFailure(error, { generationTrace: stageOnly })).toMatchObject({ stage: 'buildQuestion', requestAttempt: 2 })
    expect(requestFailure(new Error('Unknown.'), { generationTrace: stageOnly })).not.toHaveProperty('requestAttempt')
  })
  it('preserves cancellation classification and explicit request correlation', () => {
    const controller = new AbortController(); controller.abort(new DOMException('Stop.', 'AbortError'))
    expect(requestFailure(new Error('Stopped.'), { generationTrace, handlers: { signal: controller.signal } })).toMatchObject({
      category: 'cancelled', retryable: false, stage: 'buildQuestion', submissionAttempt: 2, requestAttempt: 3 })
  })
})
