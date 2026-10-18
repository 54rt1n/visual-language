import { streamChat } from '../../ai/client'
import { requestSignal } from '../../ai/http'
import { InferenceFailure } from '../../ai/inferenceFailure'
import { GENERATION_CONTEXT_TOKENS } from '../../ai/generationBudget'
import type { LessonGenerationOptions } from './executeStage'

export type LessonWorkflowPolicy = { maxRequests: number; timeoutMs: number; maxReservedTokens: number }
export const defaultLessonWorkflowPolicy: LessonWorkflowPolicy = { maxRequests: 120, timeoutMs: 900_000,
  maxReservedTokens: 120 * GENERATION_CONTEXT_TOKENS }

/** Larger accepted scopes reserve room for graph/quiz calls and bounded corrections. */
export function lessonScopeWorkflowPolicy(points: number): LessonWorkflowPolicy {
  const extra = Math.max(0, Math.min(9, points) - 3)
  const maxRequests = defaultLessonWorkflowPolicy.maxRequests + extra * 20
  return { maxRequests, timeoutMs: defaultLessonWorkflowPolicy.timeoutMs + extra * 150_000,
    maxReservedTokens: maxRequests * GENERATION_CONTEXT_TOKENS }
}

/** A complete preparation run has one budget across graph, practice and check. */
export function lessonWorkflowBudget(options: LessonGenerationOptions, overrides?: Partial<LessonWorkflowPolicy>) {
  const policy = { ...defaultLessonWorkflowPolicy, ...overrides }
  if (Object.values(policy).some(v => !Number.isSafeInteger(v) || v < 1)) throw new InferenceFailure({
    category: 'request_invalid', layer: 'validation', retryable: false, message: 'Lesson workflow budgets must be positive integers.' })
  const lifetime = requestSignal(options.signal, policy.timeoutMs, new InferenceFailure({
    category: 'budget_exhausted', layer: 'budget', retryable: false, checkpointId: 'lesson-workflow',
    message: 'Lesson preparation reached its overall time budget. Saved progress is available to resume.',
    fields: [`${policy.timeoutMs} ms whole-lesson time budget.`] }))
  let requests = 0, reservedTokens = 0
  const transport: typeof streamChat = async request => {
    lifetime.signal.throwIfAborted()
    const reservation = request.contextBudget ? request.contextBudget.inputTokens + request.contextBudget.outputReserveTokens : GENERATION_CONTEXT_TOKENS
    if (requests >= policy.maxRequests || reservedTokens + reservation > policy.maxReservedTokens) throw new InferenceFailure({
      category: 'budget_exhausted', layer: 'budget', retryable: false, stage: request.generationTrace?.stage,
      checkpointId: 'lesson-workflow', message: 'Lesson preparation reached its generation budget. Saved progress is available to resume.',
      fields: [`${requests} requests; ${reservedTokens} reserved input/output tokens.`] })
    requests++; reservedTokens += reservation
    return (options.transport ?? streamChat)({ ...request, handlers: { ...request.handlers,
      signal: AbortSignal.any([lifetime.signal, ...(request.handlers?.signal ? [request.handlers.signal] : [])]) } })
  }
  return { signal: lifetime.signal, transport, dispose: lifetime.dispose, usage: () => ({ requests, reservedTokens, policy }) }
}
