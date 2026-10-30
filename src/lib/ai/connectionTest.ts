import { streamChat } from './client'
import { GENERATION_OUTPUT_TOKENS } from './generationBudget'
import { InferenceFailure } from './inferenceFailure'
import { unusableReplyReason } from './replyQuality'
import type { ChatOptions } from './types'

/** A text probe can establish connectivity even when the model exhausts its
 * output allowance. Generation and tool callers retain strict completion checks.
 */
export async function testProviderConnection(
  config: Pick<ChatOptions, 'baseUrl' | 'apiKey' | 'model' | 'compatibility'>,
  signal?: AbortSignal,
  fetcher?: typeof fetch,
) {
  let content = '', outputLimited = false
  try {
    const result = await streamChat({ ...config,
      messages: [{ role: 'user', content: 'Reply with a short Mandarin greeting and its English meaning. Nothing else.' }],
      maxTokens: GENERATION_OUTPUT_TOKENS, reasoningEnabled: false, temperature: 0.2, fetcher,
      handlers: { signal, onContent: chunk => { content += chunk } },
    })
    content = result.content
  } catch (error) {
    if (!(error instanceof InferenceFailure) || error.failure.category !== 'output_limit') throw error
    outputLimited = true
  }
  const problem = outputLimited && !content.trim() ? undefined : unusableReplyReason(content, true)
  return { content, outputLimited, problem }
}
