import { InferenceFailure } from './inferenceFailure'

/** Explicit Qwen-envelope recognition; the caller must still decode the complete offered function. */
export function qwenToolEnvelope(content: string, allowAssistantPrefix = false) {
  const text = content.trim(), offset = text.indexOf('<tool_call>')
  if (offset < 0 || offset > 0 && !allowAssistantPrefix) return undefined
  const fail = (message: string): never => { throw new InferenceFailure({ category: 'arguments_invalid', layer: 'protocol',
    retryable: false, message: `Invalid Qwen tool-template submission: ${message}` }) }
  if (text.length > 32_000) fail('the complete response exceeds the argument limit.')
  const prefix = text.slice(0, offset)
  if (/```|<\/?(?:tool_call|function|parameter)(?:[=>\s])/.test(prefix)) fail('assistant content before the call must not contain fenced examples or other tool-template markup.')
  return { prefix, toolText: text.slice(offset) }
}
