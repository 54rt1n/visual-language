import { z } from 'zod'
import { streamChat } from './client'
import { InputValidationError } from '../domain/validation'
import type { ChatMessage, ChatOptions, ChatResult, ToolCall, ToolDefinition } from './types'

export type ApplicationTool = {
  definition: ToolDefinition
  validate: (value: unknown) => unknown
  execute: (value: unknown, callId: string, signal: AbortSignal) => Promise<unknown>
}

export function defineTool<T extends z.ZodType>(name: string, description: string, schema: T,
  execute: (input: z.infer<T>, callId: string, signal: AbortSignal) => Promise<unknown>): ApplicationTool {
  return {
    definition: { type: 'function', function: { name, description, parameters: z.toJSONSchema(schema) } },
    validate: value => schema.parse(value),
    execute: (value, id, signal) => execute(value as z.infer<T>, id, signal),
  }
}

export class ActionBudget {
  readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout>
  private counts = new Map<string, number>()
  private onAbort: () => void
  readonly limits: Record<string, number> = { model: 4, search_web: 2, extract_sources: 1, quizRepair: 1, dispatch: 12 }
  constructor(private parent?: AbortSignal, timeoutMs = 240_000, timeoutReason?: unknown) {
    this.onAbort = () => this.controller.abort(parent?.reason)
    if (parent?.aborted) this.onAbort()
    else parent?.addEventListener('abort', this.onAbort, { once: true })
    this.timer = setTimeout(() => this.controller.abort(timeoutReason ?? new DOMException('Teacher action timed out. Your work is preserved.', 'TimeoutError')), timeoutMs)
  }
  get signal() { return this.controller.signal }
  use(kind: keyof ActionBudget['limits']) {
    this.signal.throwIfAborted()
    const count = this.used(kind)
    if (count >= this.limits[kind]!) throw new Error(`The ${kind} action budget is exhausted. Continue only when ready.`)
    this.counts.set(kind, count + 1)
  }
  used(kind: string) { return this.counts.get(kind) ?? 0 }
  dispose() { clearTimeout(this.timer); this.parent?.removeEventListener('abort', this.onAbort) }
}

/** Cache successful AND failed calls for the lifetime of one user action. */
export class ToolDispatcher {
  private results = new Map<string, { signature: string; pending: Promise<string> }>()
  constructor(private tools: ApplicationTool[], private budget: ActionBudget) {}
  dispatch(call: ToolCall): Promise<string> {
    const signature = JSON.stringify(call.function)
    const previous = this.results.get(call.id)
    if (previous) {
      if (signature !== previous.signature) return Promise.reject(new Error('A repeated tool-call ID changed its arguments.'))
      return previous.pending
    }
    this.budget.use('dispatch')
    const pending = this.run(call)
    this.results.set(call.id, { signature, pending })
    return pending
  }
  private async run(call: ToolCall): Promise<string> {
    const tool = this.tools.find(t => t.definition.function.name === call.function.name)
    if (!tool) return JSON.stringify({ ok: false, error: 'This tool is not allowed during the current stage.' })
    let input: unknown
    try { input = tool.validate(JSON.parse(call.function.arguments)) }
    catch (error) {
      const fields = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 8) : ['Arguments must be valid JSON.']
      return JSON.stringify({ ok: false, error: 'Tool arguments failed validation.', fields, correction: 'Submit complete corrected arguments in a new call, including all required fields. Do not send a partial patch.' })
    }
    this.budget.signal.throwIfAborted()
    try {
      const result = await tool.execute(input, call.id, this.budget.signal)
      this.budget.signal.throwIfAborted()
      return JSON.stringify({ ok: true, result })
    } catch (error) {
      if (this.budget.signal.aborted) throw error
      if (error instanceof InputValidationError) return JSON.stringify({ ok: false, error: error.message, correction: 'Submit the complete corrected tool arguments in a new call. Keep all selected targets.' })
      // Tools handle safe user-facing detail separately; never return an arbitrary exception to a model.
      return JSON.stringify({ ok: false, error: 'Tool could not complete. Use existing supported context or report the limitation.' })
    }
  }
}

export async function runToolLoop(options: ChatOptions & {
  applicationTools: ApplicationTool[]
  budget: ActionBudget
  dispatcher?: ToolDispatcher
  onToolResult?: (call: ToolCall, result: string) => void
  complete?: (result: ChatResult) => boolean
  transport?: typeof streamChat
  /** Constrained generation can require the same named tool on its bounded repair. */
  continuationToolChoice?: ChatOptions['toolChoice']
}): Promise<{ result: ChatResult; messages: ChatMessage[] }> {
  const messages = [...options.messages]
  const dispatcher = options.dispatcher ?? new ToolDispatcher(options.applicationTools, options.budget)
  const transport = options.transport ?? streamChat
  let first = true
  while (true) {
    options.budget.use('model')
    const result = await transport({ ...options, messages, tools: options.applicationTools.map(t => t.definition),
      toolChoice: first ? options.toolChoice : options.continuationToolChoice ?? 'auto', handlers: { ...options.handlers, signal: options.budget.signal } })
    first = false
    if (result.content.trim() || result.toolCalls.length) messages.push({ role: 'assistant', content: result.content || null, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
      ...(options.compatibility === 'minimax' && result.toolCalls.length && result.reasoning ? { reasoning_content: result.reasoning } : {}) })
    for (const call of result.toolCalls) {
      const content = await dispatcher.dispatch(call)
      messages.push({ role: 'tool', tool_call_id: call.id, content })
      options.onToolResult?.(call, content)
    }
    if (!result.toolCalls.length || options.complete?.(result)) return { result, messages }
  }
}
