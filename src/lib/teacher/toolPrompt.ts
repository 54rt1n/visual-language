import type { ToolDefinition } from '../ai/types'

type Parameter = { type?: string | string[]; enum?: unknown[]; anyOf?: Parameter[]; items?: Parameter; description?: string;
  maxLength?: number; maxItems?: number }

function typeHint(parameter: Parameter): string {
  if (parameter.enum) return parameter.enum.map(value => JSON.stringify(value)).join(' | ')
  if (parameter.anyOf) return parameter.anyOf.map(typeHint).join(' | ')
  if (parameter.type === 'array') return `Array<${typeHint(parameter.items ?? {})}>`
  return Array.isArray(parameter.type) ? parameter.type.join(' | ') : parameter.type ?? 'object'
}

/** Describe the tool before the task; repeat only its signature after the context. */
export function toolPrompt(tool: ToolDefinition['function'], dialect: 'native' | 'qwen_xml' = 'native') {
  const properties = (tool.parameters.properties ?? {}) as Record<string, Parameter>
  const required = (tool.parameters.required ?? []) as string[]
  const fields = Object.entries(properties).map(([name, parameter]) => ({
    signature: `${name}${required.includes(name) ? '' : '?'}: ${typeHint(parameter)}`,
    description: parameter.description,
    limits: [typeof parameter.maxLength === 'number' ? `${name}: at most ${parameter.maxLength} characters` : '',
      typeof parameter.maxItems === 'number' ? `${name}: at most ${parameter.maxItems} items` : ''].filter(Boolean),
  }))
  const limits = fields.flatMap(field => field.limits)
  const signature = `${tool.name}(${fields.map(field => field.signature).join(', ')})`
  return {
    signature,
    description: [`Tool: ${tool.name}`, tool.description, ...fields.map(field => `${field.signature}${field.description ? ` — ${field.description}` : ''}`),
      ...(limits.length ? [`Limits: ${limits.join('; ')}.`] : [])].join('\n'),
    footer: `\n\nTool call:\n${signature}\n${limits.length ? `Limits: ${limits.join('; ')}.\n` : ''}` + (dialect === 'qwen_xml'
      ? `Submit one complete call opening with <tool_call><function=${tool.name}> and closing with </function></tool_call>. Parameter opening tags (copy exactly): ${Object.keys(properties).map(name => `<parameter=${name}>`).join(', ')}. Close every parameter with </parameter>. Use JSON for arrays/objects. Omit absent optional fields. The complete call is the entire response.`
      : 'Submit exactly one native tool call.'),
  }
}
