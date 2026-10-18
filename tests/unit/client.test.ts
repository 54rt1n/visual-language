import { describe, expect, it, vi } from 'vitest'
import { streamChat } from '../../src/lib/ai/client'
import { unusableReplyReason } from '../../src/lib/ai/replyQuality'
import { requestWithRecovery } from '../../src/lib/ai/requestRecovery'

const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ model: 'actual-model', choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`
function response(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text)
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close() } }))
}
const config = { baseUrl: 'https://api.example.com/v1', apiKey: 'test-only-key', model: 'requested-model', messages: [{ role: 'user' as const, content: 'Hello' }] }
const nativeCall = (args = '{"ok":true}', id = 'call-1') => ({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'confirm_transport', arguments: args } }] })

describe('provider-neutral SSE', () => {
  it('accepts a nullable tool_calls field on reasoning frames before a complete native tool call', async () => {
    const result = await streamChat({ ...config, fetcher: async () => response(event({ reasoning_content: 'Reviewing coverage.', tool_calls: null }) + event(nativeCall(), 'tool_calls') + 'data: [DONE]\n\n') })
    expect(result.reasoning).toBe('Reviewing coverage.')
    expect(result.toolCalls).toEqual([{ id: 'call-1', type: 'function', function: { name: 'confirm_transport', arguments: '{"ok":true}' } }])
    expect(result.finishReason).toBe('tool_calls')
  })
  it('records bounded field shapes when a native stream cannot be parsed', async () => {
    const onDiagnostic = vi.fn()
    await expect(streamChat({ ...config, handlers: { onDiagnostic }, fetcher: async () => response(event({ tool_calls: {} })) })).rejects.toMatchObject({ failure: { category: 'protocol_error' } })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ nativeShape: { eventIndex: 1, deltaType: 'object', toolCallsType: 'object' }, parserStatus: 'failed' }))
  })
  it('uses Anthropic browser headers without unsupported sampling overrides', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(event({ content: 'Hello' }, 'stop') + 'data: [DONE]\n\n'))
    await streamChat({ ...config, compatibility: 'anthropic', temperature: 0.2, fetcher })
    const init = fetcher.mock.calls[0]![1] as RequestInit
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-only-key', 'anthropic-dangerous-direct-browser-access': 'true' })
    expect(JSON.parse(init.body as string)).not.toHaveProperty('temperature')
  })
  it('requests separate MiniMax reasoning without displaying it as answer text', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(event({ reasoning_content: 'Private reasoning.' }) + event({ content: 'Hello' }, 'stop') + 'data: [DONE]\n\n'))
    const result = await streamChat({ ...config, compatibility: 'minimax', fetcher })
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ reasoning_split: true })
    expect(result.content).toBe('Hello')
    expect(result.reasoning).toBe('Private reasoning.')
  })
  it.each([undefined, '2'])('recovers from capacity-error SSE with cooldown hint %s without switching models', async retryAfterSeconds => {
    vi.useFakeTimers()
    try {
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (fetcher.mock.calls.length > 1) return response(event({ content: 'Ready.' }, 'stop') + 'data: [DONE]\n\n')
        const failed = response('data: {"error":{"message":"Qwen/Qwen3.8-Flash-Next is temporarily at capacity. Please try again shortly.","type":"server_error","code":"capacity_exhausted"}}\n\n')
        if (retryAfterSeconds) failed.headers.set('Retry-After', retryAfterSeconds)
        return failed
      })
      const result = requestWithRecovery((_attempt, signal) => streamChat({ ...config, fetcher, handlers: { signal } }),
        { attempts: 2, timeoutMs: 1000, retryDelayMs: 250 })
      const cooldown = retryAfterSeconds ? Number(retryAfterSeconds) * 1000 : 60_000
      await vi.advanceTimersByTimeAsync(cooldown - 1)
      expect(fetcher).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect((await result).content).toBe('Ready.')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[1]![1]!.body).toBe(fetcher.mock.calls[0]![1]!.body)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('preserves provider cooldown hints on classified rate-limit failures', async () => {
    await expect(streamChat({ ...config, fetcher: async () => Response.json({ error: { code: 'rate_limit' } },
      { status: 429, headers: { 'Retry-After': '12' } }) })).rejects.toMatchObject({ failure: {
      category: 'rate_limited', httpStatus: 429, retryable: true, retryAfterMs: 12_000,
    } })
  })
  it.each([
    ['concurrency_limit_exceeded', 'The provider is handling its maximum number of requests. Wait for a request to finish, then retry.'],
    ['rate_limit', 'The provider is limiting requests. Wait, then retry. Check account limits if this continues.'],
  ])('explains HTTP 429 %s without implying a depleted subscription', async (code, message) => {
    await expect(streamChat({ ...config, fetcher: async () => Response.json({ error: {
      code, message: 'Concurrency limit exceeded: 4 active units, request needs 4, plan limit 4.',
    } }, { status: 429, headers: { 'Retry-After': '60' } }) })).rejects.toMatchObject({
      message, failure: { message, category: 'rate_limited', retryable: true, retryAfterMs: 60_000, provider: { code } },
    })
  })
  it('retains provider usage when a finished template submission fails local parsing', async () => {
    const onDiagnostic = vi.fn()
    const content = '<tool_call><parameter=ack>true</parameter></function></tool_call>'
    const body = event({ content }, 'stop') + 'data: {"usage":{"prompt_tokens":100,"completion_tokens":30,"total_tokens":130}}\n\ndata: [DONE]\n\n'
    await expect(streamChat({ ...config, toolResponseDialect: 'qwen_xml', tools: [{ type: 'function', function: {
      name: 'record_probe', description: 'Probe', parameters: { type: 'object', properties: { ack: { type: 'boolean' } }, required: ['ack'] },
    } }], handlers: { onDiagnostic }, fetcher: async () => response(body) })).rejects.toMatchObject({ failure: { category: 'arguments_invalid' } })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ parserStatus: 'failed',
      usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } }))
  })
  it('uses the same native validation for explicit complete-response mode', async () => {
    const tool = { id: 'call-1', type: 'function', function: { name: 'confirm_transport', arguments: '{"ok":true}' } }
    const onWireEvent = vi.fn(), fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: 'actual-model',
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [tool] }, finish_reason: 'stop' }],
    })))
    const result = await streamChat({ ...config, compatibility: 'featherless', responseMode: 'complete', fetcher, handlers: { onWireEvent } })
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).stream).toBe(false)
    expect(result.toolCalls).toEqual([tool])
    expect(result.usage?.totalTokens).toBe(16)
    expect(onWireEvent).toHaveBeenCalledOnce()
  })
  it('retains bounded HTTP rejection details and request identity separately from user-facing errors', async () => {
    const onProviderError = vi.fn(), onDiagnostic = vi.fn()
    const body = { error: { message: `Bad messages for ${config.apiKey}`, type: 'validation_error', code: 'bad_turn', param: 'messages.2.content' } }
    const promise = streamChat({ ...config, handlers: { onProviderError, onDiagnostic }, fetcher: async () =>
      new Response(JSON.stringify(body), { status: 422, headers: { 'x-request-id': 'req-422' } }) })
    await expect(promise).rejects.toMatchObject({ failure: { category: 'http_rejected', layer: 'request', httpStatus: 422,
      retryable: false, requestId: 'req-422', provider: { code: 'bad_turn', param: 'messages.2.content', message: 'Bad messages for [redacted]' } } })
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ httpStatus: 422, requestId: 'req-422', parserStatus: 'failed' }))
    expect(onProviderError).toHaveBeenCalledWith(expect.objectContaining({ type: 'validation_error' }))
  })
  it('distinguishes incomplete streams from output limits in recorded diagnostics', async () => {
    const onDiagnostic = vi.fn()
    await expect(streamChat({ ...config, handlers: { onDiagnostic }, fetcher: async () => response(event({ content: 'partial' })) })).rejects.toMatchObject({
      failure: { category: 'stream_incomplete', layer: 'protocol', retryable: true },
    })
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ contentCharacters: 7, parserStatus: 'failed', terminalReceived: false })
    await expect(streamChat({ ...config, fetcher: async () => response(event({}, 'length') + 'data: [DONE]\n\n') })).rejects.toMatchObject({
      failure: { category: 'output_limit', retryable: false, finishReason: 'length' },
    })
  })
  it('reports bounded provider error fields without exposing the key or completing partial tools', async () => {
    const onProviderError = vi.fn()
    const error = { message: `Unsupported schema ${config.apiKey} ${'x'.repeat(1200)}`, type: 'invalid_request_error', code: 400, internal: 'not recorded', reasoning: 'not recorded' }
    await expect(streamChat({ ...config, handlers: { onProviderError }, fetcher: async () => response(event(nativeCall('{')) + `data: ${JSON.stringify({ error })}\n\n`, 7) })).rejects.toThrow('streaming error')
    expect(onProviderError).toHaveBeenCalledOnce()
    const recorded = onProviderError.mock.calls[0]![0]
    expect(recorded).toEqual({ message: expect.stringContaining('[redacted]'), type: 'invalid_request_error', code: '400' })
    expect(recorded.message).toHaveLength(1000)
    expect(JSON.stringify(recorded)).not.toContain(config.apiKey)
  })
  it('places Featherless system instructions first while preserving native tool correlation and caller messages', async () => {
    const messages = [
      { role: 'system' as const, content: 'Draft instructions' },
      { role: 'user' as const, content: 'Draft a quiz' },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'quiz', type: 'function' as const, function: { name: 'draft_quiz', arguments: '{}' } }] },
      { role: 'tool' as const, content: '{"ok":true}', tool_call_id: 'quiz' },
      { role: 'system' as const, content: 'Now review only' },
      { role: 'system' as const, content: 'Check lesson alignment' },
      { role: 'user' as const, content: 'Review the frozen candidate' },
    ], original = structuredClone(messages)
    const fetcher = vi.fn<typeof fetch>(async () => response(event({}, 'stop') + 'data: [DONE]\n\n'))
    await streamChat({ ...config, messages, compatibility: 'featherless', fetcher })
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).messages).toEqual([
      { role: 'system', content: 'Draft instructions\n\nNow review only\n\nCheck lesson alignment' }, ...messages.filter(m => m.role !== 'system'),
    ])
    expect(messages).toEqual(original)
    await streamChat({ ...config, messages, fetcher })
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string).messages).toEqual(original)
  })
  it('reads provider usage from a terminal event without choices', async () => {
    const text = event({ content: '你好' }, 'stop') + 'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n' + 'data: [DONE]\n\n'
    const result = await streamChat({ ...config, fetcher: async () => response(text, 3) })
    expect(result.usage).toEqual({ promptTokens: 12, completionTokens: 4, totalTokens: 16 })
  })
  it.each([null, {}, { prompt_tokens: -1, completion_tokens: 4, total_tokens: 3 }, { prompt_tokens: '12', completion_tokens: 4, total_tokens: 16 }])('leaves missing or malformed usage unknown (%s)', async usage => {
    const text = event({}, 'stop') + `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`
    expect((await streamChat({ ...config, fetcher: async () => response(text) })).usage).toBeUndefined()
  })
  it('preserves split UTF-8, CRLF framing, reasoning, heartbeat and model provenance', async () => {
    const onContent = vi.fn(), onReasoning = vi.fn(), onHeartbeat = vi.fn(), onModel = vi.fn()
    const fetcher = vi.fn(async () => response(': keepalive\r\n\r\n' + event({ content: '你好', reasoning_content: 'thinking' }) + event({}, 'stop') + 'data:[DONE]\n\n'))
    const result = await streamChat({ ...config, fetcher, handlers: { onContent, onReasoning, onHeartbeat, onModel } })
    expect(result).toMatchObject({ content: '你好', reasoning: 'thinking', model: 'actual-model', finishReason: 'stop' })
    expect(onContent).toHaveBeenCalledWith('你好')
    expect(onReasoning).toHaveBeenCalledWith('thinking')
    expect(onHeartbeat).toHaveBeenCalledOnce()
    expect(onModel).toHaveBeenCalledWith('actual-model')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
  })
  it('keeps Featherless chat concise, supports explicit reasoning and accepts completed native tool finishes', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(event({ content: '你好' }, 'stop') + 'data: [DONE]\n\n'))
    await streamChat({ ...config, compatibility: 'featherless', fetcher })
    const payload = JSON.parse(fetcher.mock.calls[0]![1]!.body as string)
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(payload).not.toHaveProperty('enable_thinking')
    await streamChat({ ...config, fetcher })
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).not.toHaveProperty('chat_template_kwargs')
    await streamChat({ ...config, compatibility: 'featherless', featherlessThinking: true, fetcher })
    expect(JSON.parse(fetcher.mock.calls[2]![1]!.body as string).chat_template_kwargs).toEqual({ enable_thinking: true })
    expect((await streamChat({ ...config, compatibility: 'featherless', fetcher: async () => response(event(nativeCall(), 'stop') + 'data: [DONE]\n\n') })).toolCalls).toHaveLength(1)
  })
  it('cancels a repeating content stream while preserving accumulated text and reported model', async () => {
    const cancel = vi.fn(), onModel = vi.fn(); let content = ''
    const bytes = new TextEncoder().encode(event({ content: '!'.repeat(32) }) + event({ content: '!'.repeat(32) }) + event({ content: 'not consumed' }))
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes) }, cancel })))
    await expect(streamChat({ ...config, fetcher, handlers: { onModel, onContent: chunk => { content += chunk; const problem = unusableReplyReason(content); if (problem) throw new Error(problem) } } })).rejects.toThrow('repeated symbols')
    expect(content).toBe('!'.repeat(64)); expect(cancel).toHaveBeenCalledOnce(); expect(onModel).toHaveBeenCalledWith('actual-model')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('collects interleaved tool-only calls by index before returning them', async () => {
    const text = event({ tool_calls: [
      { index: 1, id: 'second', type: 'function', function: { name: 'extract_sources', arguments: '{"sourceIds":' } },
      { index: 0, id: 'first', type: 'function', function: { name: 'search_web', arguments: '{"query":"' } },
    ] }) + event({ tool_calls: [
      { index: 0, function: { arguments: '你好"}' } }, { index: 1, function: { arguments: '["s1"]}' } },
    ] }) + event({}, 'tool_calls') + 'data: [DONE]\n\n'
    const result = await streamChat({ ...config, fetcher: async () => response(text, 7) })
    expect(result.content).toBe('')
    expect(result.toolCalls.map(c => c.id)).toEqual(['first', 'second'])
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ query: '你好' })
  })
  it('supports Alibaba’s completed native stop envelope only with explicit compatibility', async () => {
    const text = event(nativeCall()) + event({}, 'stop') + 'data: [DONE]\n\n'
    const fetcher = vi.fn<typeof fetch>(async () => response(text, 7))
    const tools = [{ type: 'function' as const, function: { name: 'confirm_transport', description: 'Diagnostic', parameters: { type: 'object' } } }]
    const toolChoice = { type: 'function' as const, function: { name: 'confirm_transport' } }
    const result = await streamChat({ ...config, compatibility: 'alibaba', tools, toolChoice, fetcher })
    expect(result).toMatchObject({ finishReason: 'stop', model: 'actual-model', toolCalls: [{ id: 'call-1', function: { name: 'confirm_transport', arguments: '{"ok":true}' } }] })
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ enable_thinking: false, tools, tool_choice: toolChoice })
    for (const compatibility of [undefined, 'standard'] as const) {
      await expect(streamChat({ ...config, compatibility, fetcher })).rejects.toThrow('completed tool-call finish')
    }
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).not.toHaveProperty('enable_thinking')
  })
  it.each([
    [event(nativeCall(), 'stop'), 'completed tool-call finish'],
    [event(nativeCall('{'), 'stop') + 'data: [DONE]\n\n', 'Incomplete tool arguments'],
    [event(nativeCall('{}', ''), 'stop') + 'data: [DONE]\n\n', 'identity'],
    [event(nativeCall(), 'length') + 'data: [DONE]\n\n', 'incomplete'],
    [event(nativeCall()) + 'data: [DONE]\n\n', 'before completion'],
  ])('retains truncation, sentinel, identity and JSON gates for Alibaba and Featherless (%s)', async (text, message) => {
    for (const compatibility of ['alibaba', 'featherless'] as const) await expect(streamChat({ ...config, compatibility, fetcher: async () => response(text) })).rejects.toThrow(message)
  })
  it('does not mistake Alibaba JSON-looking prose for a native tool', async () => {
    const result = await streamChat({ ...config, compatibility: 'alibaba', fetcher: async () => response(event({ content: JSON.stringify(nativeCall()) }, 'stop') + 'data: [DONE]\n\n') })
    expect(result.toolCalls).toEqual([])
  })
  it.each([
    [event({ content: 'partial' }), 'before completion'],
    [event({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{' } }] }, 'tool_calls'), 'Incomplete tool arguments'],
    [event({}, 'length'), 'incomplete'],
    ['data: not-json\n\n', 'malformed'],
    ['data: {"error":{"message":"secret-key"}}\n\n', 'streaming error'],
  ])('rejects incomplete/malformed streams without dispatch (%s)', async (text, message) => {
    await expect(streamChat({ ...config, fetcher: async () => response(text) })).rejects.toThrow(message)
  })
  it('does not expose error bodies which may echo credentials', async () => {
    await expect(streamChat({ ...config, fetcher: async () => new Response('secret-key', { status: 401 }) })).rejects.toThrow('API key is missing or invalid')
  })
  it('refuses credential-bearing or non-HTTPS endpoints before fetch', async () => {
    const fetcher = vi.fn()
    await expect(streamChat({ ...config, baseUrl: 'https://key:secret@example.com', fetcher })).rejects.toThrow('HTTPS endpoint')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('honors an already-cancelled request', async () => {
    const controller = new AbortController(); controller.abort()
    const fetcher: typeof fetch = async (_url, init) => { init?.signal?.throwIfAborted(); return response(event({}, 'stop')) }
    await expect(streamChat({ ...config, fetcher, handlers: { signal: controller.signal } })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
