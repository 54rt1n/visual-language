import { z } from 'zod'
import { streamChat } from '../../ai/client'
import { ActionBudget } from '../../ai/tools'
import type { ChatOptions, ToolDefinition } from '../../ai/types'
import { InferenceFailure, classifyInferenceFailure, type InferenceFailureRecord } from '../../ai/inferenceFailure'
import { validateChatRequest } from '../../ai/requestProtocol'
import { requestWithRecovery } from '../../ai/requestRecovery'
import { lessonStageDispatchLimit, resolveLessonExecutionPolicy, type LessonExecutionPolicy } from './executionPolicy'
import { SubmissionFailure, canCorrectSubmission, parseStageSubmission } from './stageSubmission'
import { assembleLessonPrompt } from './assemblePrompt'
import { OUTPUT_LIMIT_REPAIR } from './prompts'
import { resolveLessonModelProfile, type LessonModelProfile } from './modelProfiles'
import { LESSON_WORKFLOW_VERSION, LESSON_PROMPT_VERSION, type LessonStage, type LessonStageContext } from './stages'
import { lessonDefinitions } from './definitions'
import { lessonGenerationSettings } from '../../ai/lessonGenerationAdapter'
import { sha256Hex } from '../../crypto'
import { enforceContextBudget, type InputTokenCounter } from '../../ai/contextBudget'
import type { CheckpointCommit } from './checkpoint'

export type LessonGenerationOptions = {
  provider: Pick<ChatOptions, 'baseUrl' | 'apiKey' | 'model' | 'compatibility'>;
  modelProfile?: LessonModelProfile;
  executionPolicy?: Partial<LessonExecutionPolicy>;
  inputTokenCounter?: InputTokenCounter;
  onSubmission?: (event: { stage: string; submissionAttempt: number; requestAttempt: number;
    accepted: boolean; failure?: InferenceFailureRecord }) => void | Promise<void>;
  onCheckpointCommitted?: (event: CheckpointCommit) => void | Promise<void>;
  transport?: typeof streamChat; signal?: AbortSignal; onStage?: (stage: string) => void;
}

/** Every attempt projects accepted state afresh; failed assistant output is never replayed. */
export async function executeLessonStage<T extends z.ZodType>(options: LessonGenerationOptions, definition: LessonStage<T>,
  context: LessonStageContext, validate?: (value: z.infer<T>) => void) {
  const name = definition.toolName, schema = definition.schema(context)
  const resolved = resolveLessonModelProfile(options.modelProfile, definition.id, options.provider, context.settings.quizLevel)
  const policy = resolveLessonExecutionPolicy(options.executionPolicy)
  const observe: NonNullable<LessonGenerationOptions['onSubmission']> = async event => {
    try { await options.onSubmission?.(event) }
    catch (error) { throw new InferenceFailure({ category: 'persistence_error', layer: 'persistence', retryable: false,
      stage: definition.id, checkpointId: 'submission-observation', message: 'The inference outcome could not be recorded.',
      ...(event.failure ? { fields: [`Original inference failure: ${event.failure.category}: ${event.failure.message}`] } : {}) }, error) }
  }
  const generationTrace = { workflowVersion: LESSON_WORKFLOW_VERSION, promptVersion: LESSON_PROMPT_VERSION,
    lessonDefinition: { kind: context.kind, version: lessonDefinitions[context.kind].version },
    modelProfile: { id: resolved.profile.id, version: resolved.profile.version, hash: await sha256Hex(JSON.stringify(resolved.profile)) },
    stage: definition.id, settings: resolved.generation, protocol: resolved.protocol, taskPlacement: resolved.taskPlacement }
  options.signal?.throwIfAborted()
  options.onStage?.(name)
  const tool: ToolDefinition = { type: 'function', function: { name, description: definition.description, parameters: z.toJSONSchema(schema) } }
  const isolatedContext = definition.isolatedContext?.(context)
  const stageExamples = typeof definition.nativeExamples === 'function' ? definition.nativeExamples(context) : definition.nativeExamples ?? []
  const nativeExamples = !isolatedContext && resolved.protocol.toolResponseDialect === 'native' ? [...stageExamples, ...resolved.nativeExamples] : []
  for (const example of nativeExamples) schema.parse(example.arguments)
  const workedContent = resolved.protocol.toolResponseDialect === 'native' ? '' : stageExamples
    .map(example => `\nWorked input: ${JSON.stringify(example.context)}\nComplete submission arguments: ${JSON.stringify(example.arguments)}`).join('\n')
  const prompt = assembleLessonPrompt(tool.function, context, definition.instructions(context) + workedContent, {
    modelGuidance: resolved.guidance, dialect: resolved.protocol.toolResponseDialect,
    isolatedContext, preparation: definition.preparation, taskPlacement: resolved.taskPlacement, nativeExamples,
  })
  let messages = prompt.messages
  const budget = new ActionBudget(options.signal, policy.stageTimeoutMs, new InferenceFailure({
    category: 'budget_exhausted', layer: 'budget', retryable: false, stage: definition.id,
    message: 'Lesson generation reached its step time budget. Saved progress is available to resume.',
    fields: [`${policy.stageTimeoutMs} ms stage time budget.`] }))
  budget.limits.model = lessonStageDispatchLimit(policy)
  try {
    for (let attempt = 1; attempt <= policy.submissionAttempts; attempt++) {
      let requestAttemptUsed = 0, accepted = false
      try {
        const result = await requestWithRecovery(async (requestAttempt, signal) => {
          requestAttemptUsed = requestAttempt
          if (requestAttempt > 1) options.onStage?.(name)
          budget.use('model')
          const request: ChatOptions = { ...options.provider, messages: structuredClone(messages), tools: [tool],
            toolChoice: { type: 'function', function: { name } }, ...lessonGenerationSettings(options.provider.compatibility, resolved.generation),
            generationTrace: { ...generationTrace, attempt: { submission: attempt, request: requestAttempt } },
            ...resolved.protocol, timeoutMs: policy.requestTimeoutMs, handlers: { signal } }
          validateChatRequest(request)
          request.contextBudget = await enforceContextBudget(request, options.inputTokenCounter)
          return (options.transport ?? streamChat)(request)
        }, { signal: budget.signal, attempts: policy.requestAttempts, capacityWaits: policy.capacityWaits, timeoutMs: policy.requestTimeoutMs,
          retryDelayMs: policy.retryDelayMs, stage: definition.id,
          onCapacityWait: () => options.onStage?.('waiting_for_provider') })
        budget.signal.throwIfAborted()
        const value = parseStageSubmission(result, name, schema, validate)
        accepted = true
        await observe({ stage: definition.id, submissionAttempt: attempt, requestAttempt: requestAttemptUsed, accepted: true })
        budget.signal.throwIfAborted()
        return { value, model: result.model }
      } catch (error) {
        const failure = classifyInferenceFailure(error, budget.signal).withContext({ stage: definition.id, attempt, submissionAttempt: attempt, requestAttempt: requestAttemptUsed })
        if (!accepted) await observe({ stage: definition.id, submissionAttempt: attempt, requestAttempt: requestAttemptUsed,
          accepted: false, failure: failure.failure })
        if (!canCorrectSubmission(failure.failure.category) || budget.signal.aborted) throw failure
        if (attempt === policy.submissionAttempts) throw new SubmissionFailure({ ...failure.failure, correctionExhausted: true,
          message: `${name} correction budget exhausted: ${[failure.message, ...(failure.failure.fields ?? [])].join(' ')}` }, error instanceof SubmissionFailure ? error.candidateArguments : undefined, failure)
        const issue = [failure.message, ...(failure.failure.fields ?? []),
          ...(failure.failure.category === 'output_limit' ? [OUTPUT_LIMIT_REPAIR] : []),
          resolved.protocol.toolResponseDialect === 'qwen_xml'
            ? 'Submit one complete function call using the available tool template, with every required parameter. Do not add surrounding prose.'
            : 'Submit complete corrected arguments in the actual native function channel. Do not print a tool call or JSON in assistant text.'].join(' ')
        messages = [...prompt.prefix, prompt.project(issue, error instanceof SubmissionFailure ? error.candidateArguments : undefined)]
      }
    }
    throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget', retryable: false, stage: definition.id,
      message: `${name} did not produce an accepted operation.` })
  } finally { budget.dispose() }
}
