import { boundedJsonResponse, requestSignal, responseError } from './http'
import type { ChatOptions, ChatResult, ResponseDiagnostic, ToolCall } from './types'
import { InferenceFailure, classifyInferenceFailure, httpInferenceFailure } from './inferenceFailure'
import { buildChatRequest } from './chatRequest'
import { completionEvent } from './completionEvent'
import { decodeQwenTool } from './qwenToolProtocol'
import { providerErrorFields, providerRequestId, providerRetryAfter, readProviderError } from './providerDiagnostics'
import { providerRequestQueue } from './requestQueue'
import { providerHeaders } from './providers'

const MAX_STREAM_BYTES = 2_000_000
const MAX_ARGUMENT_CHARS = 32_000
type Delta = {
  content?: unknown
  reasoning?: unknown
  reasoning_content?: unknown
  tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> | null
}

/** SSE framing is independent of network chunks and UTF-8 boundaries. */
export async function streamChat(options: ChatOptions): Promise<ChatResult> {
  const { endpoint } = buildChatRequest(options)
  return providerRequestQueue.run({ baseUrl: endpoint, apiKey: options.apiKey }, options.handlers?.signal,
    () => streamChatNow(options))
}

async function streamChatNow(options: ChatOptions): Promise<ChatResult> {
  const { handlers = {} } = options
  const { endpoint, payload } = buildChatRequest(options)
  const lifetime = requestSignal(handlers.signal, options.timeoutMs ?? 120_000)
  const calls = new Map<number, ToolCall>()
  const result: ChatResult = { content: '', reasoning: '', toolCalls: [], finishReason: '', model: options.model }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let finished = false
  let responseRetryAfterMs: number | undefined
  let phase: 'transport' | 'protocol' = 'transport'
  let eventIndex = 0
  const diagnostic: ResponseDiagnostic = { terminalReceived: false, contentCharacters: 0, reasoningCharacters: 0,
    nativeToolCalls: 0, parserStatus: 'pending' }
  function consume(data: string, reportWire = true) {
    if (data === '[DONE]') { finished = true; diagnostic.terminalReceived = true; return }
    let parsed: { error?: unknown; model?: string; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }; choices?: Array<{ index?: number; delta?: Delta; finish_reason?: string | null }> }
    try { parsed = JSON.parse(data) } catch { throw new Error('The provider sent malformed stream data. No tools were executed.') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.choices !== undefined && !Array.isArray(parsed.choices)) {
      throw new InferenceFailure({ category: 'protocol_error', layer: 'protocol', retryable: false, message: 'The provider sent malformed stream data. No tools were executed.' })
    }
    eventIndex++
    if (reportWire) handlers.onWireEvent?.(parsed)
    if (parsed.error) {
      const fields = providerErrorFields(parsed.error, options.apiKey)
      handlers.onProviderError?.(fields)
      throw new InferenceFailure({ category: 'provider_stream_error', layer: 'transport',
        message: 'The provider reported a streaming error. No incomplete tools were executed.',
        retryable: !/invalid|validation/i.test(`${fields.type ?? ''} ${fields.code ?? ''}`), provider: fields,
        httpStatus: diagnostic.httpStatus, requestId: diagnostic.requestId, retryAfterMs: responseRetryAfterMs })
    }
    if (typeof parsed.model === 'string') { result.model = parsed.model; handlers.onModel?.(parsed.model) }
    // Some providers append usage in a final event with no choices. Missing or
    // malformed usage remains unknown; never estimate billing from text length.
    const usage = parsed.usage
    if (usage && [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
      result.usage = { promptTokens: usage.prompt_tokens as number, completionTokens: usage.completion_tokens as number, totalTokens: usage.total_tokens as number }
    }
    const choice = parsed.choices?.find(c => (c.index ?? 0) === 0)
    if (!choice) return
    if (choice.finish_reason) { result.finishReason = choice.finish_reason; diagnostic.finishReason = choice.finish_reason }
    const delta = choice.delta
    if (!delta) return
    if (typeof delta !== 'object' || Array.isArray(delta) || delta.tool_calls != null && !Array.isArray(delta.tool_calls)) {
      const shape = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
      diagnostic.nativeShape = { eventIndex, deltaType: shape(delta), toolCallsType: shape(delta.tool_calls) }
      throw new InferenceFailure({ category: 'protocol_error', layer: 'protocol', retryable: false, message: 'The provider sent malformed native stream fields.' })
    }
    if (typeof delta.content === 'string') { result.content += delta.content; diagnostic.contentCharacters += delta.content.length; handlers.onContent?.(delta.content) }
    const reasoning = delta.reasoning ?? delta.reasoning_content
    if (typeof reasoning === 'string') { result.reasoning += reasoning; diagnostic.reasoningCharacters += reasoning.length; handlers.onReasoning?.(reasoning) }
    for (const fragment of delta.tool_calls ?? []) {
      if (!fragment || typeof fragment !== 'object') throw new InferenceFailure({ category: 'protocol_error', layer: 'protocol', retryable: false, message: 'The provider sent a malformed native tool fragment.' })
      const index = fragment.index
      if (!Number.isInteger(index) || index! < 0 || index! > 15 || (fragment.type && fragment.type !== 'function')) throw new Error('The provider sent an invalid tool-call index or type.')
      const call = calls.get(index!) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (fragment.id) {
        if (call.id && call.id !== fragment.id) throw new Error('A streaming tool changed its ID.')
        call.id = fragment.id
      }
      if (fragment.function?.name) call.function.name += fragment.function.name
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments
      if (call.function.arguments.length > MAX_ARGUMENT_CHARS || call.function.name.length > 128) throw new Error('Tool arguments exceeded the safe size limit.')
      calls.set(index!, call)
      diagnostic.nativeToolCalls = calls.size
    }
  }
  try {
    const response = await (options.fetcher ?? fetch)(`${endpoint}/chat/completions`, {
      method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { ...providerHeaders(options.apiKey, options.compatibility), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: lifetime.signal,
    })
    diagnostic.httpStatus = response.status; diagnostic.requestId = providerRequestId(response)
    responseRetryAfterMs = providerRetryAfter(response)
    if (!response.ok) {
      const provider = await readProviderError(response, options.apiKey, lifetime.signal)
      handlers.onProviderError?.(provider)
      throw httpInferenceFailure(response.status, { message: responseError(response.status).message, requestId: diagnostic.requestId, provider,
        retryAfterMs: providerRetryAfter(response) })
    }
    phase = 'protocol'
    if (!payload.stream) {
      const complete = await boundedJsonResponse(response, lifetime.signal, MAX_STREAM_BYTES)
      handlers.onWireEvent?.(complete)
      consume(JSON.stringify(completionEvent(complete)), false)
      finished = true; diagnostic.terminalReceived = true
    } else {
      reader = response.body?.getReader()
      if (!reader) throw new Error('The provider did not return a readable stream.')
    }
    const decoder = new TextDecoder()
    let buffer = '', eventLines: string[] = [], total = 0
    const line = (value: string) => {
      if (!value) {
        if (eventLines.length) consume(eventLines.join('\n'))
        eventLines = []
      } else if (value.startsWith(':')) handlers.onHeartbeat?.()
      else if (value.startsWith('data:')) eventLines.push(value.slice(5).replace(/^ /, ''))
    }
    while (!finished) {
      lifetime.signal.throwIfAborted()
      const { done, value } = await reader!.read()
      if (value) total += value.byteLength
      if (total > MAX_STREAM_BYTES) throw new Error('The provider response exceeded the safe size limit.')
      buffer += decoder.decode(value, { stream: !done })
      let end: number
      while ((end = buffer.indexOf('\n')) !== -1) {
        const current = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        line(current)
        if (finished) break
      }
      if (done) { if (buffer.trim()) line(buffer.replace(/\r$/, '')); line(''); break }
    }
    lifetime.signal.throwIfAborted()
    if (!result.finishReason) throw new InferenceFailure({ category: 'stream_incomplete', layer: 'protocol', retryable: true,
      message: 'The stream ended before completion. Partial text is preserved; no tools were executed.' })
    if (!['stop', 'tool_calls'].includes(result.finishReason)) throw new InferenceFailure({ category: result.finishReason === 'length' ? 'output_limit' : 'protocol_error',
      layer: 'protocol', retryable: false, finishReason: result.finishReason,
      message: `The response was incomplete or used an unsupported finish status (${result.finishReason}). No tools were executed.` })
    result.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    // Alibaba and Featherless can emit native tool_calls with finish_reason=stop.
    // Require the terminal SSE sentinel for these explicit dialects; identity/JSON checks
    // below still apply. Preserve the actual finish reason as provider evidence.
    const nativeToolStop = (options.compatibility === 'alibaba' || options.compatibility === 'featherless') && result.finishReason === 'stop' && finished
    if (result.toolCalls.length && result.finishReason !== 'tool_calls' && !nativeToolStop) throw new Error('Tool arguments arrived without a completed tool-call finish status.')
    if (!result.toolCalls.length && result.finishReason === 'tool_calls') throw new Error('The provider completed a tool response without any tool calls.')
    const ids = new Set<string>()
    for (const call of result.toolCalls) {
      if (!call.id || !call.function.name || ids.has(call.id)) throw new Error('Missing or duplicate tool-call identity.')
      ids.add(call.id)
      try { JSON.parse(call.function.arguments) } catch { throw new InferenceFailure({ category: 'arguments_invalid', layer: 'protocol', retryable: false,
        message: 'Incomplete tool arguments. No tools were executed.' }) }
    }
    if (result.toolCalls.length) result.toolProtocol = { representation: 'native' }
    else if (options.toolResponseDialect === 'qwen_xml') {
      const normalizations: string[] = []
      let assistantPrefix = ''
      const call = decodeQwenTool(result.content, options.tools ?? [], { normalizeParameterNameQuotes: options.normalizeParameterNameQuotes,
        normalizeFunctionOpening: options.normalizeFunctionOpening,
        onFunctionOpeningNormalization: name => { normalizations.push(`function_opening_angle:${name}`) },
        allowAssistantPrefix: options.allowAssistantPrefix, onAssistantPrefix: prefix => { assistantPrefix = prefix },
        onNormalization: field => { normalizations.push(`parameter_name_quote:${field}`) } })
      if (call) {
        if (!finished) throw new InferenceFailure({ category: 'stream_incomplete', layer: 'protocol', retryable: true,
          message: 'The Qwen tool-template response ended without terminal completion.' })
        result.toolProtocol = { representation: 'qwen_xml', rawContent: result.content, ...(normalizations.length ? { normalizations } : {}) }
        result.toolCalls = [call]; result.content = assistantPrefix
      }
    }
    diagnostic.parserStatus = 'complete'
    return result
  } catch (error) {
    diagnostic.parserStatus = 'failed'
    const failure = classifyInferenceFailure(error, lifetime.signal)
    if (failure.failure.category !== 'unexpected_error') throw new InferenceFailure({ ...failure.failure,
      httpStatus: failure.failure.httpStatus ?? diagnostic.httpStatus, requestId: failure.failure.requestId ?? diagnostic.requestId }, failure)
    throw new InferenceFailure({ ...failure.failure, category: phase === 'protocol' ? 'protocol_error' : 'transport_error', layer: phase,
      retryable: phase === 'transport', httpStatus: diagnostic.httpStatus, requestId: diagnostic.requestId }, error)
  } finally {
    try { await reader?.cancel() } catch { /* aborted stream */ }
    reader?.releaseLock()
    lifetime.dispose()
    if (result.usage) diagnostic.usage = result.usage
    handlers.onDiagnostic?.(structuredClone(diagnostic))
  }
}
