import { describe, expect, it, vi } from 'vitest'
import { featherlessTokenCounter } from '../../src/lib/ai/featherlessTokenCounter'
import { enforceContextBudget } from '../../src/lib/ai/contextBudget'
import type { ChatOptions } from '../../src/lib/ai/types'

const provider = { baseUrl: 'https://api.featherless.ai/v1', apiKey: 'fixture-key', model: 'test-model', compatibility: 'featherless' as const }
const request: ChatOptions = { ...provider, messages: [{ role: 'system', content: 'Tools first.' }, { role: 'user', content: '请给我一杯茶。' }], maxTokens: 4096 }
describe('exact provider template token counts', () => {
  it('uses the actual request template and caches only identical requests', async () => {
    const checks: unknown[] = []
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ token_count: 700, formatted_prompt: 'Not retained in evidence.' })))
    const counter = featherlessTokenCounter(provider, { fetcher, onCheck: e => { checks.push(e) } })
    expect(await enforceContextBudget(request, counter)).toMatchObject({ method: 'tokenizer', inputTokens: 700 })
    await enforceContextBudget(request, counter)
    await enforceContextBudget({ ...request, featherlessThinking: true }, counter)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.featherless.ai/debug/chat-format')
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ model: provider.model, messages: request.messages, chat_template_kwargs: { enable_thinking: false } })
    expect(checks).toEqual([expect.objectContaining({ cached: false, inputTokens: 700, failed: false }), expect.objectContaining({ cached: true }), expect.objectContaining({ cached: false })])
    expect(JSON.stringify(checks)).not.toContain(provider.apiKey)
  })
  it('blocks oversized measured input without a generation call or estimator fallback', async () => {
    const counter = featherlessTokenCounter(provider, { fetcher: async () => new Response('{"token_count":30000}') })
    await expect(enforceContextBudget(request, counter)).rejects.toMatchObject({ failure: { category: 'budget_exhausted' } })
  })
  it('preserves tokenizer rejection diagnostics instead of allowing generation', async () => {
    const counter = featherlessTokenCounter(provider, { fetcher: async () => new Response('{"error":{"message":"Model unavailable","code":"not_found"}}', { status: 404, headers: { 'x-request-id': 'tokenize-404' } }) })
    await expect(counter(request)).rejects.toMatchObject({ failure: { httpStatus: 404, requestId: 'tokenize-404', provider: { code: 'not_found' } } })
  })
})
