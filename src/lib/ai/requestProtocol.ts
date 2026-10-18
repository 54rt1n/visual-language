import type { ChatOptions } from './types'
import { InferenceFailure } from './inferenceFailure'

/** Validate correlation and payload shape before any network request is sent. */
export function validateChatRequest(options: Pick<ChatOptions, 'model' | 'messages' | 'tools' | 'toolChoice' | 'maxTokens' | 'toolResponseDialect' | 'normalizeParameterNameQuotes' | 'allowAssistantPrefix' | 'normalizeFunctionOpening'>) {
  const fail = (message: string): never => { throw new InferenceFailure({ category: 'request_invalid', layer: 'request',
    message: `Invalid inference request: ${message}`, retryable: false }) }
  if (!options.model?.trim()) fail('select a model.')
  if (!Array.isArray(options.messages) || !options.messages.length) fail('messages must not be empty.')
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)) fail('maxTokens must be a positive integer.')
  const tools = new Set<string>()
  for (const tool of options.tools ?? []) {
    if (tool.type !== 'function' || !tool.function?.name?.trim() || tools.has(tool.function.name)) fail('tool names must be present and distinct.')
    if (!tool.function.parameters || typeof tool.function.parameters !== 'object' || Array.isArray(tool.function.parameters)) fail('a tool schema must be an object.')
    tools.add(tool.function.name)
  }
  if (typeof options.toolChoice === 'object' && !tools.has(options.toolChoice.function.name)) fail('the selected tool is not offered.')
  if (options.toolChoice === 'required' && !tools.size) fail('required tool choice needs at least one offered tool.')
  if (options.toolResponseDialect === 'qwen_xml' && !tools.size) fail('the selected tool-template decoder requires an offered schema.')
  if (options.normalizeParameterNameQuotes && options.toolResponseDialect !== 'qwen_xml') fail('parameter-name normalization requires an explicitly selected Qwen template dialect.')
  if (options.allowAssistantPrefix && options.toolResponseDialect !== 'qwen_xml') fail('assistant-prefix recognition requires an explicitly selected Qwen template dialect.')
  if (options.normalizeFunctionOpening && options.toolResponseDialect !== 'qwen_xml') fail('function-opening normalization requires an explicitly selected Qwen template dialect.')
  const pending = new Set<string>(), identities = new Set<string>()
  for (const message of options.messages) {
    if (message.role !== 'tool' && pending.size) fail('assistant tool calls must receive all their correlated results before another turn.')
    if (message.role === 'tool') {
      if (typeof message.content !== 'string' || !pending.delete(message.tool_call_id)) fail('a tool result has no matching pending call.')
    } else if (message.role === 'assistant') {
      const calls = message.tool_calls ?? []
      if (!Array.isArray(calls)) fail('assistant tool_calls must be an array.')
      if ((message.content !== null && typeof message.content !== 'string') || (!message.content?.trim() && !calls.length)) fail('an assistant turn needs text or native tool calls.')
      for (const call of calls) {
        if (!call.id?.trim() || identities.has(call.id) || call.type !== 'function' || !call.function?.name?.trim() || typeof call.function.arguments !== 'string') fail('a native tool call needs a distinct ID, function name, and argument string.')
        identities.add(call.id); pending.add(call.id)
      }
    } else if (message.role === 'system' || message.role === 'user') {
      if (typeof message.content !== 'string' || !message.content.trim()) fail('system and user turns need text.')
    } else fail('the message role is unsupported.')
  }
  if (pending.size) fail('a pending native tool call is missing its tool result.')
}

