import type { ToolCall, ToolDefinition } from './types'
import { InferenceFailure } from './inferenceFailure'
import { qwenToolEnvelope } from './qwenToolEnvelope'

type ParameterSchema = { type?: string; enum?: unknown[]; const?: unknown }
const name = '[A-Za-z_][A-Za-z0-9_-]{0,63}'
const envelope = new RegExp(`^<tool_call>\\s*<function=(${name})>([\\s\\S]*)</function>\\s*</tool_call>$`)
const parameter = new RegExp(`^\\s*<parameter=(${name})("?)>([\\s\\S]*?)</parameter>`)

/** Explicit decoder for the Qwen function/parameter template, never a prose/JSON fallback. */
export function decodeQwenTool(content: string, tools: ToolDefinition[], options: { normalizeParameterNameQuotes?: boolean;
  allowAssistantPrefix?: boolean; onAssistantPrefix?: (prefix: string) => void;
  normalizeFunctionOpening?: boolean; onFunctionOpeningNormalization?: (name: string) => void;
  onNormalization?: (field: string) => void } = {}): ToolCall | undefined {
  const parts = qwenToolEnvelope(content, options.allowAssistantPrefix)
  if (!parts) return undefined
  const text = parts.toolText
  function fail(message: string): never { throw new InferenceFailure({ category: 'arguments_invalid', layer: 'protocol',
    retryable: false, message: `Invalid Qwen tool-template submission: ${message}` }) }
  if (text.length > 32_000) fail('the complete tool block exceeds the argument limit.')
  let match = envelope.exec(text), normalizedOpening = false
  if (!match) {
    const incomplete = new RegExp(`^<tool_call>\\s*function=(${name})>`).exec(text)
    if (incomplete && tools.some(tool => tool.function.name === incomplete[1])) {
      if (!options.normalizeFunctionOpening) fail(`the function opening tag is missing its '<' character. Copy <function=${incomplete[1]}> exactly inside <tool_call>.`)
      const normalized = text.replace(/^(<tool_call>\s*)function=/, '$1<function=')
      if (normalized.length > 32_000) fail('the complete tool block exceeds the argument limit.')
      match = envelope.exec(normalized)
      normalizedOpening = Boolean(match)
    }
  }
  if (!match) fail('exactly one complete tool/function block is required, with no surrounding text.')
  if (/<\/?(?:tool_call|function)(?:[=>\s])/.test(match[2]!)) fail('nested or multiple calls are not supported.')
  const tool = tools.find(value => value.function.name === match[1])
  if (!tool) fail('the function is not offered for this request.')
  const properties = tool.function.parameters.properties as Record<string, ParameterSchema> | undefined
  if (!properties) fail('the offered tool has no parameter schema.')
  const args: Record<string, unknown> = Object.create(null)
  let body = match[2]!
  while (body.trim()) {
    const field = parameter.exec(body)
    if (!field) {
      const malformed = new RegExp(`^\\s*<parameter>(${name})>`).exec(body)
      if (malformed && Object.prototype.hasOwnProperty.call(properties, malformed[1]!)) {
        fail(`parameter ${malformed[1]} uses '>' instead of '=' before its name. Copy <parameter=${malformed[1]}> exactly.`)
      }
    }
    if (!field) fail('the function body must contain only complete parameter blocks.')
    const key = field[1]!, raw = field[3]!.trim()
    if (!Object.prototype.hasOwnProperty.call(properties, key) || Object.prototype.hasOwnProperty.call(args, key)) fail('parameters must be offered and distinct.')
    if (field[2]) {
      if (!options.normalizeParameterNameQuotes) fail(`parameter ${key} has an extra double quote in its opening tag. Copy <parameter=${key}> exactly, without quotes around the name; close it with </parameter>.`)
      options.onNormalization?.(key)
    }
    const schema = properties[key]!
    if (schema.type === 'string') {
      args[key] = raw
      if (raw.startsWith('"')) {
        // XML string parameters are full text, so a quoted expression may start ordinary prose.
        // Retain support for a completely JSON-encoded string without requiring that encoding.
        try { const parsed: unknown = JSON.parse(raw); if (typeof parsed === 'string') args[key] = parsed }
        catch { /* Complete parameter text remains a string; schema/review still decide validity. */ }
      }
    } else if (schema.type === 'boolean') {
      if (!/^(true|false)$/i.test(raw)) fail('boolean parameters must be true or false.')
      args[key] = raw.toLowerCase() === 'true'
    } else {
      try { args[key] = JSON.parse(raw) } catch { fail('array, object, and numeric parameters must use complete JSON values.') }
    }
    body = body.slice(field[0].length)
  }
  options.onAssistantPrefix?.(parts.prefix)
  if (normalizedOpening) options.onFunctionOpeningNormalization?.(tool.function.name)
  return { id: 'qwen_template_call_0', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }
}

