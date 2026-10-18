import { InferenceFailure } from './inferenceFailure'

/** Normalize the complete-response envelope into the same native delta validation path. */
export function completionEvent(value: unknown): Record<string, unknown> {
  const invalid = (): never => { throw new InferenceFailure({ category: 'protocol_error', layer: 'protocol', retryable: false,
    message: 'The provider sent a malformed complete-response envelope.' }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const response = value as Record<string, any>
  if (response.error) return { error: response.error }
  if (!Array.isArray(response.choices)) invalid()
  const choice = response.choices.find((item: any) => item?.index === 0 || item?.index === undefined)
  if (!choice?.message || typeof choice.message !== 'object' || Array.isArray(choice.message)) invalid()
  const message = choice.message
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) invalid()
  return { model: response.model, usage: response.usage, choices: [{ index: 0, finish_reason: choice.finish_reason,
    delta: { content: message.content, reasoning: message.reasoning, reasoning_content: message.reasoning_content,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call: any, index: number) => ({ ...call, index })) } : {}) },
  }] }
}

