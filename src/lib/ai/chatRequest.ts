import type { ChatOptions } from './types'
import { normalizeEndpoint } from './http'
import { GENERATION_OUTPUT_TOKENS } from './generationBudget'
import { InferenceFailure } from './inferenceFailure'
import { validateChatRequest } from './requestProtocol'

/** One wire builder serves streaming and complete-response protocol controls. */
export function buildChatRequest(options: ChatOptions) {
  const instructions = options.messages.filter(message => message.role === 'system')
  const messages = options.compatibility === 'featherless' && instructions.length
    ? [{ role: 'system' as const, content: instructions.map(message => message.content).join('\n\n') }, ...options.messages.filter(message => message.role !== 'system')]
    : options.messages
  validateChatRequest({ ...options, messages })
  let endpoint: string
  try { endpoint = normalizeEndpoint(options.baseUrl) }
  catch (error) { throw new InferenceFailure({ category: 'request_invalid', layer: 'request', retryable: false,
    message: error instanceof Error ? error.message : 'The provider endpoint is invalid.' }, error) }
  return { endpoint, payload: {
    model: options.model, messages, stream: options.responseMode !== 'complete',
    max_tokens: options.maxTokens ?? GENERATION_OUTPUT_TOKENS,
    ...(options.compatibility === 'alibaba' ? { enable_thinking: false } : {}),
    ...(options.compatibility === 'featherless' ? { chat_template_kwargs: { enable_thinking: options.featherlessThinking ?? false } } : {}),
    ...(options.compatibility === 'minimax' ? { reasoning_split: true } : {}),
    ...(options.compatibility === 'openrouter' && options.reasoningEnabled !== undefined ? { reasoning: { enabled: options.reasoningEnabled } } : {}),
    ...(options.temperature === undefined || options.compatibility === 'anthropic' ? {} : { temperature: options.temperature }),
    ...(options.tools?.length ? { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' } : {}),
  } }
}

