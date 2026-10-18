import type { ChatOptions } from './types'
import type { InputTokenCounter } from './contextBudget'
import { buildChatRequest } from './chatRequest'
import { boundedJsonResponse, requestSignal } from './http'
import { InferenceFailure, httpInferenceFailure } from './inferenceFailure'
import { providerRequestId, providerRetryAfter, readProviderError } from './providerDiagnostics'

type Provider = Pick<ChatOptions, 'baseUrl' | 'apiKey' | 'model' | 'compatibility'>
export type TokenizationEvidence = { model: string; durationMs: number; cached: boolean; inputTokens?: number;
  httpStatus?: number; requestId?: string; failed: boolean }

/** Counts the provider-rendered prompt, including native tool schema and thinking template. */
export function featherlessTokenCounter(provider: Provider, options: { fetcher?: typeof fetch;
  onCheck?: (evidence: TokenizationEvidence) => void } = {}): InputTokenCounter {
  const cache = new Map<string, number>()
  return async (request, signal) => {
    if (provider.compatibility !== 'featherless') throw new InferenceFailure({ category: 'request_invalid', layer: 'validation',
      retryable: false, message: 'The Featherless tokenizer requires Featherless compatibility.' })
    const { endpoint, payload } = buildChatRequest({ ...provider, ...request })
    const key = JSON.stringify(payload), started = performance.now()
    const evidence: TokenizationEvidence = { model: request.model, durationMs: 0, cached: cache.has(key), failed: true }
    const lifetime = requestSignal(signal, 15_000)
    try {
      lifetime.signal.throwIfAborted()
      if (cache.has(key)) { evidence.inputTokens = cache.get(key)!; evidence.failed = false; return evidence.inputTokens }
      const response = await (options.fetcher ?? fetch)(`${endpoint.replace(/\/v1$/, '')}/debug/chat-format`, {
        method: 'POST', credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: lifetime.signal,
      })
      evidence.httpStatus = response.status; evidence.requestId = providerRequestId(response)
      if (!response.ok) throw httpInferenceFailure(response.status, { requestId: evidence.requestId, retryAfterMs: providerRetryAfter(response), provider: await readProviderError(response, provider.apiKey, lifetime.signal),
        message: 'The provider could not tokenize the lesson request. Generation has not started.' })
      const value = await boundedJsonResponse(response, lifetime.signal) as { token_count?: unknown }
      if (!Number.isSafeInteger(value?.token_count) || Number(value.token_count) < 0) throw new InferenceFailure({
        category: 'protocol_error', layer: 'validation', retryable: false, message: 'The provider tokenizer did not return a valid prompt count.' })
      evidence.inputTokens = Number(value.token_count); evidence.failed = false
      if (cache.size >= 16) cache.delete(cache.keys().next().value!)
      cache.set(key, evidence.inputTokens)
      return evidence.inputTokens
    } finally { evidence.durationMs = Math.round(performance.now() - started); options.onCheck?.(evidence); lifetime.dispose() }
  }
}
