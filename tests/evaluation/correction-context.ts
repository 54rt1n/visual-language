import type { ChatMessage, ChatOptions } from '../../src/lib/ai/types'
import { InferenceFailure } from '../../src/lib/ai/inferenceFailure'
import { validateChatRequest } from '../../src/lib/ai/requestProtocol'
import { enforceContextBudget } from '../../src/lib/ai/contextBudget'
import { REPAIR_EXPLANATION } from '../../src/lib/teacher/lessonGeneration/prompts'

export type CorrectionHistory = 'fresh' | 'replay'
export type CorrectionCandidate = 'production' | 'retain' | 'omit-overlong'

/** One-variable ablation: remove only rejected overlong diagnostic strings, never accepted state. */
export async function correctionCandidate(request: ChatOptions, mode: CorrectionCandidate, rejectedArguments?: unknown): Promise<ChatOptions> {
  if (mode === 'production') return request
  const fail = (message: string): never => { throw new InferenceFailure({ category: 'request_invalid', layer: 'request',
    retryable: false, message }) }
  if (!['retain', 'omit-overlong'].includes(mode)) fail('Unknown correction candidate mode.')
  const messages = structuredClone(request.messages), user = messages.at(-1), marker = '\n\nTool call:\n'
  if (user?.role !== 'user' || !user.content?.includes(marker) || request.tools?.length !== 1) fail('Candidate ablation requires the owned correction projection and one tool.')
  const offset = user!.content!.indexOf(marker), footer = user!.content!.slice(offset)
  let projected: Record<string, unknown>
  try { projected = JSON.parse(user!.content!.slice(0, offset)) }
  catch { fail('Candidate ablation requires a JSON projection.') }
  if (!projected! || typeof projected! !== 'object' || Array.isArray(projected!)) fail('Candidate ablation requires an object projection.')
  const candidate = projected!.candidateSubmission as Record<string, unknown> | undefined
  if (!projected!.nativeSubmissionIssue || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('Only rejected candidate arguments can be pruned.')
  const properties = request.tools![0]!.function.parameters.properties as Record<string, { maxLength?: number }> | undefined
  const source = rejectedArguments ?? candidate
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('The original rejected arguments must be an object.')
  const original = source as Record<string, unknown>
  const omitted = ['reason', 'assessment'].filter(field => {
    const value = original[field], limit = properties?.[field]?.maxLength
    return typeof value === 'string' && typeof limit === 'number' && value.length > limit
  })
  if (!omitted.length) fail('No rejected explanation exceeds its declared schema limit.')
  const changed = omitted.some(field => mode === 'retain' ? candidate![field] !== original[field] : field in candidate!)
  if (!changed) return request
  for (const field of omitted) {
    if (mode === 'retain') candidate![field] = original[field]
    else delete candidate![field]
  }
  user!.content = JSON.stringify(projected!) + footer
  const compiled = { ...request, messages }
  validateChatRequest(compiled)
  compiled.contextBudget = await enforceContextBudget(compiled)
  return compiled
}

/** Change only the correction footer; source/accepted state and tool contracts remain intact. */
export async function correctionCue(request: ChatOptions, guidance: string): Promise<ChatOptions> {
  const marker = '\n\nTool call:\n'
  if (!guidance.trim() || request.messages.at(-1)?.role !== 'user' || !request.messages.at(-1)?.content?.includes(marker)) {
    throw new InferenceFailure({ category: 'request_invalid', layer: 'request', retryable: false, message: 'A correction cue needs guidance and the owned tool footer.' })
  }
  const messages = structuredClone(request.messages), user = messages.at(-1)!
  const offset = user.content!.indexOf(marker)
  const projection = user.content!.slice(0, offset), footer = user.content!.slice(offset + marker.length)
  // Replace the owned production cue rather than accidentally stacking two interventions.
  const originalFooter = footer.startsWith(`${REPAIR_EXPLANATION}\n`) ? footer.slice(REPAIR_EXPLANATION.length + 1) : footer
  user.content = `${projection}${marker}${guidance.trim()}\n${originalFooter}`
  const compiled = { ...request, messages }
  validateChatRequest(compiled)
  compiled.contextBudget = await enforceContextBudget(compiled)
  return compiled
}

/** Experimental history ablation only; production always supplies the fresh request. */
export async function correctionContext(request: ChatOptions, initialMessages: ChatMessage[], failedContent: string,
  history: CorrectionHistory): Promise<ChatOptions> {
  const fail = (message: string): never => { throw new InferenceFailure({ category: 'request_invalid', layer: 'request',
    retryable: false, message }) }
  if (request.messages[0]?.role !== 'system' || request.messages.at(-1)?.role !== 'user') {
    fail('The production correction must start with a fresh system/user projection.')
  }
  let messages = structuredClone(request.messages)
  if (history === 'replay') {
    if (!failedContent.trim()) fail('An empty assistant response cannot be replayed in this experiment.')
    if (initialMessages[0]?.role !== 'system' || initialMessages.at(-1)?.role !== 'user'
      || JSON.stringify(initialMessages.slice(0, -1)) !== JSON.stringify(request.messages.slice(0, -1))) fail('Replay requires the same initial prompt and demonstrations.')
    messages = [...structuredClone(initialMessages), { role: 'assistant', content: failedContent }, messages.at(-1)!]
  } else if (history !== 'fresh') fail('Unknown correction history mode.')
  const compiled = { ...request, messages }
  validateChatRequest(compiled)
  compiled.contextBudget = await enforceContextBudget(compiled)
  return compiled
}
