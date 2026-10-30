import type { ChatOptions } from '../../ai/types'
import { modelIdentity } from '../../ai/modelIdentity'

/** Endpoint tool templates belong to the provider adapter, not model guidance. */
export function lessonProviderProtocol(provider?: Pick<ChatOptions, 'model' | 'compatibility'>) {
  const qwenTemplate = provider?.compatibility === 'featherless'
    && ['qwen3827b', 'qwen38flashnext'].includes(modelIdentity(provider.model))
  return qwenTemplate ? {
    protocol: { toolResponseDialect: 'qwen_xml' as const, normalizeParameterNameQuotes: true, allowAssistantPrefix: true, normalizeFunctionOpening: true },
    guidance: 'The listed tool is available for this request. Submit its result as one function call using your tool template: <tool_call><function=TOOL_NAME><parameter=FIELD_NAME>VALUE</parameter></function></tool_call>. Replace TOOL_NAME and FIELD_NAME with the offered tool and its schema fields. Include every required field; use JSON for array/object values. Do not write a signature, markdown, or explanatory prose outside the call.',
  } : { protocol: { toolResponseDialect: 'native' as const }, guidance: '' }
}
