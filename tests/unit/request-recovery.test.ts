import { describe, expect, it, vi } from 'vitest'
import { InferenceFailure } from '../../src/lib/ai/inferenceFailure'
import { requestWithRecovery } from '../../src/lib/ai/requestRecovery'
import { lessonStageDispatchLimit, resolveLessonExecutionPolicy } from '../../src/lib/teacher/lessonGeneration/executionPolicy'
import { executeLessonStage } from '../../src/lib/teacher/lessonGeneration/executeStage'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import type { ChatOptions } from '../../src/lib/ai/types'
import { waypointResult } from '../fixtures/topic-lesson'
import { providerRetryAfter } from '../../src/lib/ai/providerDiagnostics'

const policy = { attempts: 2, timeoutMs: 1000, retryDelayMs: 0 }
const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture' }
const context = { kind: 'topic' as const, settings: { quizLevel: 'meaningHanzi' as const, complexity: 'phrases' as const,
  scope: 'everyday' as const, focus: 'characters' as const, topic: 'Courtesy' } }

describe('classified generation-request recovery', () => {
  it('accounts for capacity, transport and submission recovery in the enforced stage dispatch limit', async () => {
    vi.useFakeTimers()
    try {
      const executionPolicy = resolveLessonExecutionPolicy({ retryDelayMs: 0 })
      const observations: Array<{ submissionAttempt: number; accepted: boolean }> = []
      let dispatched!: () => void
      const started = new Promise<void>(resolve => { dispatched = resolve })
      const transport = vi.fn(async (request: ChatOptions) => {
        dispatched()
        const index = (transport.mock.calls.length - 1) % 4
        if (index === 0 || index === 2) throw new InferenceFailure({ category: 'rate_limited', layer: 'request',
          retryable: true, httpStatus: 429, message: 'Capacity fixture', provider: { code: 'concurrency_limit_exceeded' } })
        if (index === 1) throw new TypeError('Transport fixture')
        return waypointResult(request, transport.mock.calls.length === 4
          ? { decision: 'accept' } : { decision: 'accept', reason: 'Complete fixture submission.' })
      })
      const pending = executeLessonStage({ provider, transport, executionPolicy,
        onSubmission: event => { observations.push(event) } }, lessonStages.reviewWaypoint, context)
      await started
      await vi.advanceTimersByTimeAsync(240_000)
      expect((await pending).value.decision).toBe('accept')
      expect(transport).toHaveBeenCalledTimes(lessonStageDispatchLimit(executionPolicy))
      expect(transport).toHaveBeenCalledTimes(8)
      expect(transport.mock.calls.map(([request]) => request.generationTrace!.attempt)).toEqual([
        ...[1, 2].flatMap(submission => [1, 2, 3, 4].map(request => ({ submission, request }))),
      ])
      expect(observations).toMatchObject([{ submissionAttempt: 1, accepted: false }, { submissionAttempt: 2, accepted: true }])
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it.each([undefined, 2000])('waits for a capacity cooldown (%s) before retrying the same model', async retryAfterMs => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(async () => {
        if (request.mock.calls.length === 1) throw new InferenceFailure({ category: 'provider_stream_error', layer: 'transport',
          retryable: true, message: 'Provider at capacity.', httpStatus: 200, retryAfterMs,
          provider: { code: 'capacity_exhausted', type: 'server_error' } })
        return 'accepted'
      })
      const pending = requestWithRecovery(request, policy), delay = retryAfterMs ?? 60_000
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(request).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toBe('accepted')
      expect(request).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('preserves capacity evidence after its separate bounded wait allowance', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(async () => { throw new InferenceFailure({ category: 'provider_stream_error', layer: 'transport',
        retryable: true, message: 'Provider at capacity.', httpStatus: 200, requestId: 'captured-capacity-request',
        provider: { code: 'capacity_exhausted', type: 'server_error' } }) })
      const rejected = expect(requestWithRecovery(request, { ...policy, stage: 'buildQuestion' })).rejects.toMatchObject({
        failure: { category: 'provider_stream_error', httpStatus: 200, requestId: 'captured-capacity-request',
          requestAttempt: 3, stage: 'buildQuestion', provider: { code: 'capacity_exhausted' } },
      })
      await vi.advanceTimersByTimeAsync(120_000)
      await rejected
      expect(request).toHaveBeenCalledTimes(3)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('waits for capacity after an interrupted stream without spending the remaining transport attempt', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController(), waits = vi.fn()
      const request = vi.fn(async () => {
        if (request.mock.calls.length === 1) throw new TypeError('Stream terminated')
        if (request.mock.calls.length <= 3) throw new InferenceFailure({ category: 'rate_limited', layer: 'request',
          retryable: true, httpStatus: 429, message: 'Busy', provider: { code: 'concurrency_limit_exceeded' } })
        return 'accepted'
      })
      const pending = requestWithRecovery(request, { ...policy, signal: controller.signal, onCapacityWait: waits })
      await vi.advanceTimersByTimeAsync(1)
      expect(request).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(119_998)
      expect(request).toHaveBeenCalledTimes(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toBe('accepted')
      expect(request.mock.calls.map(args => args[0])).toEqual([1, 2, 3, 4])
      expect(waits.mock.calls).toEqual([[60_000], [60_000]])
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('cancels capacity cooldown without dispatching a second request', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const request = vi.fn(async () => { throw new InferenceFailure({ category: 'provider_stream_error', layer: 'transport',
        retryable: true, message: 'Provider at capacity.', provider: { code: 'capacity_exhausted' } }) })
      const rejected = expect(requestWithRecovery(request, { ...policy, signal: controller.signal })).rejects.toMatchObject({
        failure: { category: 'cancelled', retryable: false, requestAttempt: 1 },
      })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort(new DOMException('Cancelled', 'AbortError'))
      await rejected
      expect(request).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it.each([undefined, 2000])('waits for rate-limit cooldown (%s) before retrying', async retryAfterMs => {
    vi.useFakeTimers()
    try {
      const request = vi.fn(async () => {
        if (request.mock.calls.length === 1) throw new InferenceFailure({ category: 'rate_limited', layer: 'request',
          retryable: true, message: 'HTTP 429', httpStatus: 429, retryAfterMs })
        return 'accepted'
      })
      const pending = requestWithRecovery(request, policy), delay = retryAfterMs ?? 60_000
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(request).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toBe('accepted')
      expect(request).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('parses provider retry seconds and HTTP dates without accepting malformed hints', () => {
    const response = (value: string) => new Response('', { headers: { 'Retry-After': value } })
    expect(providerRetryAfter(response('12'))).toBe(12_000)
    expect(providerRetryAfter(response('Thu, 01 Jan 1970 00:00:10 GMT'), 0)).toBe(10_000)
    expect(providerRetryAfter(response('invalid'))).toBeUndefined()
    expect(providerRetryAfter(response('-1'))).toBeUndefined()
  })
  it.each(['timeout', 'transport', 'provider'])('recovers once from a transient %s failure', async kind => {
    const request = vi.fn(async () => {
      if (request.mock.calls.length === 1) {
        if (kind === 'timeout') throw new DOMException('Request deadline', 'TimeoutError')
        if (kind === 'transport') throw new TypeError('Network disconnected')
        throw new InferenceFailure({ category: 'provider_unavailable', layer: 'transport', message: 'HTTP 503', retryable: true, httpStatus: 503 })
      }
      return 'accepted'
    })
    expect(await requestWithRecovery(request, policy)).toBe('accepted')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('preserves the last transient cause and bounded attempt count on exhaustion', async () => {
    const request = vi.fn(async () => { throw new TypeError('Network unavailable') })
    await expect(requestWithRecovery(request, { ...policy, stage: 'reviewGraph' })).rejects.toMatchObject({
      failure: { category: 'transport_error', stage: 'reviewGraph', requestAttempt: 2, retryable: true },
    })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('never repeats an unchanged rejected request', async () => {
    const request = vi.fn(async () => { throw new InferenceFailure({ category: 'http_rejected', layer: 'request', message: 'HTTP 422', retryable: false, httpStatus: 422 }) })
    await expect(requestWithRecovery(request, policy)).rejects.toMatchObject({ failure: { httpStatus: 422, requestAttempt: 1 } })
    expect(request).toHaveBeenCalledOnce()
  })
  it('cancels during backoff without starting another request', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const request = vi.fn(async () => { throw new TypeError('Disconnected') })
      const pending = requestWithRecovery(request, { ...policy, retryDelayMs: 500, signal: controller.signal })
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(1)
      controller.abort(new DOMException('Cancelled', 'AbortError'))
      await rejected
      expect(request).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('repeats only the transport request, accepting a single stage result', async () => {
    const requests: ChatOptions[] = []
    const transport = vi.fn(async (request: ChatOptions) => {
      requests.push(request)
      if (requests.length === 1) throw new TypeError('Disconnected before response')
      return waypointResult(request, { decision: 'accept', reason: 'Reviewed.' })
    })
    const validate = vi.fn()
    const result = await executeLessonStage({ provider, transport, executionPolicy: { retryDelayMs: 0 } }, lessonStages.reviewWaypoint, context, validate)
    expect(result.value.decision).toBe('accept')
    expect(validate).toHaveBeenCalledOnce()
    expect(requests[1]!.messages).toEqual(requests[0]!.messages)
    expect(requests[1]!.generationTrace!.attempt).toEqual({ submission: 1, request: 2 })
  })
  it('recovers the interrupted-stream/concurrency sequence within one unchanged lesson submission', async () => {
    vi.useFakeTimers()
    try {
      let dispatched!: () => void
      const started = new Promise<void>(resolve => { dispatched = resolve })
      const requests: ChatOptions[] = [], events: unknown[] = [], stages: string[] = []
      const transport = vi.fn(async (request: ChatOptions) => {
        requests.push(request); dispatched()
        if (requests.length === 1) throw new TypeError('Stream terminated')
        if (requests.length <= 3) throw new InferenceFailure({ category: 'rate_limited', layer: 'request',
          retryable: true, httpStatus: 429, message: 'Busy', provider: { code: 'concurrency_limit_exceeded' } })
        return waypointResult(request, { decision: 'accept', reason: 'Reviewed.' })
      })
      const result = executeLessonStage({ provider, transport, executionPolicy: { retryDelayMs: 0 },
        onStage: stage => { stages.push(stage) }, onSubmission: event => { events.push(event) },
      }, lessonStages.reviewWaypoint, context)
      await started
      await vi.advanceTimersByTimeAsync(120_000)
      expect((await result).value.decision).toBe('accept')
      expect(requests.map(r => r.generationTrace?.attempt)).toEqual([1, 2, 3, 4].map(request => ({ submission: 1, request })))
      expect(requests.every(r => JSON.stringify(r.messages) === JSON.stringify(requests[0]!.messages))).toBe(true)
      expect(events).toEqual([expect.objectContaining({ submissionAttempt: 1, requestAttempt: 4, accepted: true })])
      expect(stages.filter(s => s === 'waiting_for_provider')).toHaveLength(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('requires coherent bounded stage and request budgets', () => {
    expect(resolveLessonExecutionPolicy().stageTimeoutMs).toBeGreaterThan(4 * resolveLessonExecutionPolicy().requestTimeoutMs)
    expect(() => resolveLessonExecutionPolicy({ requestAttempts: 20 })).toThrow('bounded')
    expect(() => resolveLessonExecutionPolicy({ stageTimeoutMs: 120_000 })).toThrow('reserve time')
  })
  it('honors the stage deadline during capacity cooldown without dispatching a retry', async () => {
    vi.useFakeTimers()
    try {
      let dispatched!: () => void
      const started = new Promise<void>(resolve => { dispatched = resolve })
      const transport = vi.fn(async () => {
        dispatched()
        throw new InferenceFailure({ category: 'provider_stream_error', layer: 'transport', retryable: true,
          message: 'Provider at capacity.', provider: { code: 'capacity_exhausted' } })
      })
      const pending = executeLessonStage({ provider, transport,
        executionPolicy: { submissionAttempts: 1, requestAttempts: 2, requestTimeoutMs: 10, stageTimeoutMs: 50, retryDelayMs: 0 },
      }, lessonStages.reviewWaypoint, context)
      const rejected = expect(pending).rejects.toMatchObject({ failure: {
        category: 'budget_exhausted', layer: 'budget', retryable: false, stage: 'reviewWaypoint', requestAttempt: 1,
      } })
      await started
      await vi.advanceTimersByTimeAsync(51)
      await rejected
      expect(transport).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('does not return a stage result after its observation exceeds the stage deadline', async () => {
    vi.useFakeTimers()
    try {
      let observed!: () => void
      const started = new Promise<void>(resolve => { observed = resolve })
      const transport = vi.fn(async (request: ChatOptions) => waypointResult(request, { decision: 'accept', reason: 'Reviewed.' }))
      const pending = executeLessonStage({ provider, transport,
        executionPolicy: { submissionAttempts: 1, requestAttempts: 1, requestTimeoutMs: 10, stageTimeoutMs: 50, retryDelayMs: 0 },
        onSubmission: async () => { observed(); await new Promise(resolve => setTimeout(resolve, 60)) },
      }, lessonStages.reviewWaypoint, context)
      const rejected = expect(pending).rejects.toMatchObject({ failure: {
        category: 'budget_exhausted', layer: 'budget', retryable: false, stage: 'reviewWaypoint',
      } })
      await started
      await vi.advanceTimersByTimeAsync(61)
      await rejected
      expect(transport).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
