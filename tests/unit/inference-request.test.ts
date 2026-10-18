import { describe, expect, it, vi } from 'vitest'
import { validateChatRequest } from '../../src/lib/ai/requestProtocol'
import { InferenceFailure, classifyInferenceFailure, httpInferenceFailure } from '../../src/lib/ai/inferenceFailure'
import { streamChat } from '../../src/lib/ai/client'
import type { ChatMessage } from '../../src/lib/ai/types'
import { z } from 'zod'
import { InputValidationError } from '../../src/lib/domain/validation'

const call = { id: 'c1', type: 'function' as const, function: { name: 'review', arguments: '{}' } }
const request = { model: 'fixture', messages: [{ role: 'user' as const, content: 'Review.' }] }

describe('inference request preflight', () => {
  it('allows correlated native tool turns and rejects empty or broken repair histories', () => {
    const valid: ChatMessage[] = [request.messages[0]!, { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":false}' }, { role: 'user', content: 'Correct the arguments.' }]
    expect(() => validateChatRequest({ ...request, messages: valid })).not.toThrow()
    const invalid: ChatMessage[][] = [
      [], [...request.messages, { role: 'assistant', content: null }],
      [...request.messages, { role: 'assistant', content: '  ' }],
      [...request.messages, { role: 'tool', tool_call_id: 'missing', content: '{}' }],
      valid.slice(0, 2), [...valid.slice(0, 2), valid[3]!], [...valid, valid[2]!],
    ]
    for (const messages of invalid) expect(() => validateChatRequest({ ...request, messages })).toThrow(InferenceFailure)
  })
  it('rejects selecting an unavailable tool before calling the provider', async () => {
    const fetcher = vi.fn()
    await expect(streamChat({ ...request, baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', fetcher,
      toolChoice: { type: 'function', function: { name: 'missing' } } })).rejects.toMatchObject({
        failure: { category: 'request_invalid', layer: 'request', retryable: false },
      })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects the recorded empty assistant shape before calling the provider', async () => {
    const fetcher = vi.fn()
    await expect(streamChat({ ...request, messages: [...request.messages, { role: 'assistant', content: null },
      { role: 'user', content: 'Submit the review.' }], baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', fetcher })).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('structured inference failures', () => {
  it('preserves a typed budget abort reason over the transport rejection', () => {
    const reason = new InferenceFailure({ category: 'budget_exhausted', layer: 'budget', retryable: false,
      checkpointId: 'lesson-workflow', message: 'Overall preparation deadline.' })
    const controller = new AbortController(); controller.abort(reason)
    expect(classifyInferenceFailure(new TypeError('Fetch aborted'), controller.signal)).toBe(reason)
  })
  it.each([
    [400, 'http_rejected', false], [408, 'http_rejected', true], [422, 'http_rejected', false],
    [429, 'rate_limited', true], [500, 'provider_unavailable', true], [501, 'provider_unavailable', false],
    [502, 'provider_unavailable', true], [503, 'provider_unavailable', true], [504, 'provider_unavailable', true],
  ] as const)('classifies HTTP %i with explicit retry eligibility', (status, category, retryable) => {
    const error = httpInferenceFailure(status, { message: 'Authored HTTP classification control.', requestId: 'request-1',
      provider: { code: 'authored-code' }, retryAfterMs: 20 })
    expect(JSON.parse(JSON.stringify(error.failure))).toMatchObject({ category, retryable, httpStatus: status,
      layer: 'request', requestId: 'request-1', provider: { code: 'authored-code' }, retryAfterMs: 20 })
    expect(classifyInferenceFailure(error)).toBe(error)
  })
  it('keeps invalid configuration and internal failures out of transport retries', () => {
    const invalid = z.object({ model: z.string() }).safeParse({ model: 1 })
    if (invalid.success) throw new Error('Expected invalid configuration.')
    expect(classifyInferenceFailure(invalid.error).failure).toMatchObject({ category: 'request_invalid',
      layer: 'validation', retryable: false, fields: [expect.stringContaining('model')] })
    expect(classifyInferenceFailure(new InputValidationError('Invalid lesson input.')).failure).toMatchObject({
      category: 'request_invalid', layer: 'validation', retryable: false })
    expect(classifyInferenceFailure(new Error('Authored internal failure.')).failure).toMatchObject({
      category: 'unexpected_error', layer: 'internal', retryable: false })
  })
  it('distinguishes cancellation from retryable timeout and retains stage context', () => {
    const cancelled = new AbortController(); cancelled.abort(new DOMException('Stop', 'AbortError'))
    expect(classifyInferenceFailure(new Error('Stopped'), cancelled.signal).failure).toMatchObject({ category: 'cancelled', retryable: false })
    const timeout = classifyInferenceFailure(new DOMException('Too slow', 'TimeoutError'))
    expect(timeout.failure).toMatchObject({ category: 'timeout', retryable: true })
    const contextual = timeout.withContext({ stage: 'reviewGraph', attempt: 2 })
    expect(contextual.failure).toMatchObject({ category: 'timeout', stage: 'reviewGraph', attempt: 2 })
    expect(timeout.failure).not.toHaveProperty('stage')
  })
})
