import { z } from 'zod'
import type { ChatResult } from '../../ai/types'
import { InferenceFailure, type InferenceFailureCategory, type InferenceFailureRecord } from '../../ai/inferenceFailure'

export class SubmissionFailure extends InferenceFailure {
  constructor(failure: InferenceFailureRecord, readonly candidateArguments?: unknown, cause?: unknown) { super(failure, cause) }
}

export function canCorrectSubmission(category: InferenceFailureCategory) {
  return ['empty_output', 'tool_missing', 'tool_unexpected', 'arguments_invalid', 'schema_invalid', 'constraints_invalid', 'output_limit'].includes(category)
}

/** A native submission is a proposal; validation must finish before it is accepted. */
export function parseStageSubmission<T extends z.ZodType>(result: ChatResult, name: string, schema: T,
  validate?: (value: z.infer<T>) => void): z.infer<T> {
  const fail = (category: InferenceFailureCategory, message: string, fields?: string[], candidate?: unknown): never => {
    throw new SubmissionFailure({ category, layer: ['schema_invalid', 'constraints_invalid'].includes(category) ? 'validation' : 'protocol',
      message, retryable: false, finishReason: result.finishReason, ...(fields ? { fields } : {}) }, candidate)
  }
  if (!['stop', 'tool_calls'].includes(result.finishReason)) fail(result.finishReason === 'length' ? 'output_limit' : 'protocol_error', `${name} requires a completed native submission.`)
  if (!result.toolCalls.length) fail(result.content.trim() ? 'tool_missing' : 'empty_output',
    result.content.trim() ? `${name} received assistant text instead of a native tool call. No operation was applied.`
      : `${name} received no tool call or answer text. No operation was applied.`)
  const names = result.toolCalls.slice(0, 8).map(call => call.function.name.slice(0, 128))
  if (result.toolCalls.length !== 1) fail('tool_unexpected', `${name} received ${result.toolCalls.length} tool calls; this step accepts one. No operation was applied.`,
    [`Returned tools: ${JSON.stringify(names)}.`])
  if (result.toolCalls[0]!.function.name !== name) fail('tool_unexpected', `${name} received a call to ${JSON.stringify(names[0])} instead. No operation was applied.`)
  const call = result.toolCalls[0]!
  if (!call.id || call.type !== 'function') fail('protocol_error', 'The native submission has no valid identity.')
  let candidate: unknown
  try { candidate = JSON.parse(call.function.arguments) }
  catch { fail('arguments_invalid', `${name} arguments must be complete JSON.`) }
  const parsed = schema.safeParse(candidate)
  if (!parsed.success) fail('schema_invalid', `${name} tool arguments failed validation.`,
    parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join('.')}: ${issue.message}`), candidate)
  const value = parsed.data as z.infer<T>
  try { validate?.(value) }
  catch (error) {
    const fields = error instanceof z.ZodError ? error.issues.slice(0, 8).map(issue => `${issue.path.join('.')}: ${issue.message}`) : undefined
    fail('constraints_invalid', error instanceof Error ? error.message : 'The submission violates the stage constraints.', fields, candidate)
  }
  return value
}

