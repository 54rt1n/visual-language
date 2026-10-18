import type { ChatOptions } from './types'
import { GENERATION_CONTEXT_TOKENS, GENERATION_OUTPUT_TOKENS } from './generationBudget'
import { InferenceFailure } from './inferenceFailure'
import type { Tiktoken } from 'js-tiktoken/lite'

export type InputTokenCounter = (request: Pick<ChatOptions, 'model' | 'messages' | 'tools' | 'toolChoice' | 'compatibility' | 'featherlessThinking'>,
  signal?: AbortSignal) => Promise<number>
export type ContextBudgetEvidence = { model: string; method: 'tokenizer' | 'tiktoken_estimate'; inputTokens: number;
  encoding?: 'cl100k_base'; outputReserveTokens: number; totalLimitTokens: number }

let encoding: Promise<Tiktoken> | undefined
async function estimateInputTokens(request: ChatOptions) {
  // Load only the 100K encoding, on first generation. Other model families use
  // this as a BPE estimate; it is not their provider-rendered prompt count.
  encoding ??= Promise.all([import('js-tiktoken/lite'), import('js-tiktoken/ranks/cl100k_base')])
    .then(([{ Tiktoken }, ranks]) => new Tiktoken(ranks.default))
  const tokenizer = await encoding
  const serialized = JSON.stringify({ messages: request.messages, tools: request.tools, toolChoice: request.toolChoice })
  return tokenizer.encode(serialized, [], []).length + 16 * request.messages.length + 64 * (request.tools?.length ?? 0) + 128
}

/** Tokenize the assembled input and reserve output; provider counts override the local BPE estimate. */
export async function enforceContextBudget(request: ChatOptions, counter?: InputTokenCounter): Promise<ContextBudgetEvidence> {
  request.handlers?.signal?.throwIfAborted()
  const outputReserveTokens = request.maxTokens ?? GENERATION_OUTPUT_TOKENS
  let inputTokens = counter ? await counter(request, request.handlers?.signal) : await estimateInputTokens(request)
  let measured = Boolean(counter)
  // Verify a possible local overflow against the actual Featherless template.
  // Normal requests stay local; an estimate alone must not reject valid material
  // when the connected provider can supply its model's exact count.
  if (!counter && inputTokens + outputReserveTokens > GENERATION_CONTEXT_TOKENS
    && request.compatibility === 'featherless' && request.baseUrl.replace(/\/$/, '') === 'https://api.featherless.ai/v1') {
    const { featherlessTokenCounter } = await import('./featherlessTokenCounter')
    inputTokens = await featherlessTokenCounter(request, { fetcher: request.fetcher })(request, request.handlers?.signal)
    measured = true
  }
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new InferenceFailure({ category: 'protocol_error', layer: 'validation',
    retryable: false, message: 'The input tokenizer did not return a valid token count.' })
  const evidence: ContextBudgetEvidence = { model: request.model, method: measured ? 'tokenizer' : 'tiktoken_estimate',
    ...(!measured ? { encoding: 'cl100k_base' as const } : {}), inputTokens, outputReserveTokens, totalLimitTokens: GENERATION_CONTEXT_TOKENS }
  if (inputTokens + outputReserveTokens > GENERATION_CONTEXT_TOKENS) throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget',
    retryable: false, message: measured ? 'The model tokenizer reports that this request exceeds the lesson context limit. Your saved work is preserved.'
      : 'The tokenized request estimate exceeds the lesson context limit. Your saved work is preserved.',
    fields: [`${evidence.method}: ${inputTokens} input tokens + ${outputReserveTokens} reserved output tokens.`] })
  request.handlers?.signal?.throwIfAborted()
  return evidence
}
