import type { ChatOptions, ChatResult, ResponseDiagnostic } from '../../src/lib/ai/types'
import { streamChat } from '../../src/lib/ai/client'
import { classifyInferenceFailure, InferenceFailure, isProviderCapacity, type InferenceFailureRecord } from '../../src/lib/ai/inferenceFailure'
import { generateLesson, type GenerateLessonOptions } from '../../src/lib/teacher/lessonGeneration/workflow'
import type { WaypointLessonInput } from '../../src/lib/domain/lessonGraph'
import type { LessonGraphDraft, LessonPreparation } from '../../src/lib/domain/lessonPreparation'
import type { CheckpointCommit } from '../../src/lib/teacher/lessonGeneration/checkpoint'
import { requestFailure } from './request-failure'

export type RecoveryFault = 'unavailable' | 'timeout' | 'invalid_request' | 'cancel_resume' | 'stream_capacity'
export type RecoveryCall = {
  source: 'injected_fault' | 'model_transport'; run: 'initial' | 'resume';
  request: Pick<ChatOptions, 'messages' | 'tools' | 'generationTrace'>;
  parsedResponseReceived: boolean; durationMs: number; failure?: InferenceFailureRecord;
  submissionAccepted?: boolean;
  response?: Omit<ChatResult, 'reasoning'>; diagnostic?: ResponseDiagnostic;
}

/** Injection controls exercise production decoding/recovery; they are not spontaneous provider failures. */
export async function runLessonRecoveryControl(input: WaypointLessonInput, fault: RecoveryFault,
  options: GenerateLessonOptions, observe?: (state: unknown) => Promise<void>) {
  const controller = new AbortController(), calls: RecoveryCall[] = []
  const checkpointCommits: Array<CheckpointCommit & { run: 'initial' | 'resume' }> = []
  let run: 'initial' | 'resume' = 'initial', preparation: LessonPreparation | undefined
  let graphDraft: LessonGraphDraft | undefined, initialFailure: InferenceFailureRecord | undefined
  let resumedFailure: InferenceFailureRecord | undefined, cancellationAt: number | undefined
  const transport = options.transport ?? streamChat
  const save = async () => observe?.({ fault, calls, preparation, graphDraft, checkpointCommits, initialFailure, resumedFailure, cancellationAt })
  const configured = {
    ...options,
    onSubmission: async (event: Parameters<NonNullable<GenerateLessonOptions['onSubmission']>>[0]) => {
      const call = [...calls].reverse().find(c => c.run === run && c.request.generationTrace?.stage === event.stage &&
        c.request.generationTrace.attempt?.submission === event.submissionAttempt &&
        c.request.generationTrace.attempt?.request === event.requestAttempt)
      if (call) { call.submissionAccepted = event.accepted; if (event.failure) call.failure = event.failure }
      await options.onSubmission?.(event); await save()
    },
    onCheckpointCommitted: async (event: CheckpointCommit) => {
      checkpointCommits.push({ ...event, run }); await options.onCheckpointCommitted?.(event); await save()
    },
    signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]),
    transport: async (request: ChatOptions) => {
      if (calls.length >= 120) throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget', retryable: false,
        message: 'Recovery control reached its shared initial/resume request limit.' })
      const injected = fault === 'stream_capacity' ? calls.length < 3 : calls.length === 0 && fault !== 'cancel_resume'
      const call: RecoveryCall = { source: injected ? 'injected_fault' : 'model_transport', run,
        request: structuredClone({ messages: request.messages, tools: request.tools, generationTrace: request.generationTrace }),
        parsedResponseReceived: false, durationMs: 0 }
      calls.push(call); await save()
      const start = performance.now()
      try {
        const observed = { ...request, handlers: { ...request.handlers,
          onDiagnostic: (diagnostic: ResponseDiagnostic) => { call.diagnostic = diagnostic; request.handlers?.onDiagnostic?.(diagnostic) } } }
        const result = injected ? await streamChat({ ...observed, responseMode: 'complete', fetcher: async () => {
          if (fault === 'stream_capacity') {
            if (calls.length === 1) throw new TypeError('Injected stream termination.')
            return Response.json({ error: { code: 'concurrency_limit_exceeded', type: 'rate_limit_error' } },
              { status: 429, headers: { 'retry-after': '0' } })
          }
          if (fault === 'timeout') throw new DOMException('Injected recovery-control timeout.', 'TimeoutError')
          return Response.json({ error: { code: 'authored_injection', message: `Injected ${fault}.` } },
            { status: fault === 'invalid_request' ? 422 : 503, headers: { 'retry-after': '0' } })
        } }) : await transport(observed)
        call.parsedResponseReceived = true
        const { reasoning: _reasoning, ...response } = result
        call.response = response
        return result
      } catch (error) { call.submissionAccepted = false; call.failure = requestFailure(error, request); throw error }
      finally { call.durationMs = Math.round(performance.now() - start); await save() }
    },
    onGraphDraft: async (draft: LessonGraphDraft) => {
      graphDraft = structuredClone(draft); await options.onGraphDraft?.(draft); await save()
    },
    onLesson: async (lesson: LessonPreparation) => {
      preparation = structuredClone(lesson); await options.onLesson?.(lesson); await save()
    },
    onQuiz: async (phase: 'practice' | 'check', quiz: NonNullable<LessonPreparation['practice']>) => {
      if (!preparation) throw new Error('Missing reviewed-lesson checkpoint.')
      preparation = { ...preparation, [phase]: structuredClone(quiz) }
      await options.onQuiz?.(phase, quiz); await save()
      // Interrupt after accepted content is durably observed, before dependent requests.
      if (fault === 'cancel_resume' && run === 'initial' && phase === 'practice' && quiz.questions.length > 0) {
        cancellationAt = calls.length
        controller.abort(new DOMException('Authored cancellation after accepted question.', 'AbortError'))
      }
    },
  }
  try { preparation = await generateLesson(input, configured) }
  catch (error) { initialFailure = classifyInferenceFailure(error, configured.signal).failure }
  const stoppedAt = calls.length, preserved = structuredClone(preparation)
  if (fault === 'cancel_resume' && initialFailure?.category === 'cancelled' && preparation) {
    run = 'resume'
    // Cross a serialization boundary, as a persisted checkpoint does.
    const checkpoint = JSON.parse(JSON.stringify(preparation)) as LessonPreparation
    try { preparation = await generateLesson(input, { ...configured, signal: options.signal, checkpoint, graphDraft: undefined }) }
    catch (error) { resumedFailure = classifyInferenceFailure(error, options.signal).failure }
  }
  const complete = Boolean(preparation?.practice?.complete && preparation?.check?.complete)
  const duplicateQuestions = [preparation?.practice, preparation?.check].some(quiz => quiz &&
    new Set(quiz.questions.map(q => q.id)).size !== quiz.questions.length)
  const preservedAcceptedContent = !preserved || Boolean(preparation &&
    JSON.stringify(preparation.lesson) === JSON.stringify(preserved.lesson) &&
    preserved.practice?.questions.every(q => JSON.stringify(preparation!.practice?.questions.find(p => p.id === q.id)) === JSON.stringify(q)))
  const resumeReauthoredGraph = calls.some(call => call.run === 'resume' &&
    /"stage":"(?:buildWaypoint|reviseWaypoint)"/.test(JSON.stringify(call.request)))
  const passed = fault === 'invalid_request'
    ? calls.length === 1 && initialFailure?.category === 'http_rejected' && !complete
    : fault === 'cancel_resume'
      ? cancellationAt === stoppedAt && initialFailure?.category === 'cancelled' && !resumedFailure && complete &&
        checkpointCommits.some(c => c.run === 'initial' && c.checkpointId === 'practice-quiz' && c.persisted) &&
        preservedAcceptedContent && !duplicateQuestions && !resumeReauthoredGraph
      : fault === 'stream_capacity'
        ? !initialFailure && complete && !duplicateQuestions && calls[0]?.failure?.category === 'transport_error'
          && calls.slice(1, 3).every(c => c.source === 'injected_fault' && c.failure?.provider?.code === 'concurrency_limit_exceeded')
          && calls[3]?.request.generationTrace?.attempt?.submission === 1
        : !initialFailure && complete && calls[0]?.failure?.category === (fault === 'timeout' ? 'timeout' : 'provider_unavailable')
  await save()
  return { fault, passed, complete, calls, checkpointCommits, initialFailure, resumedFailure, cancellationAt, stoppedAt,
    preservedAcceptedContent, duplicateQuestions, resumeReauthoredGraph,
    preparation, evidenceScope: 'Authored fault injection through production workflow. Model transports are recorded separately; no independent teaching-quality or learner-event claim.' }
}

export function summarizeRecoveryControls(results: Awaited<ReturnType<typeof runLessonRecoveryControl>>[],
  plannedControls: number, liveDispatches: number) {
  const calls = results.flatMap(result => result.calls), model = calls.filter(call => call.source === 'model_transport')
  const usage = model.flatMap(call => call.response?.usage ?? call.diagnostic?.usage
    ? [call.response?.usage ?? call.diagnostic!.usage!] : [])
  return { plannedControls, attemptedControls: results.length, passedControls: results.filter(r => r.passed).length,
    completePreparations: results.filter(r => r.complete).length,
    expectedRequestRejections: results.filter(r => r.fault === 'invalid_request' && r.passed).length,
    resumedCompletions: results.filter(r => r.fault === 'cancel_resume' && r.passed).length,
    attemptsIncludingInjections: calls.length, injectedAttempts: calls.length - model.length,
    modelTransportAttempts: model.length, liveDispatches,
    parsedModelResponses: model.filter(c => c.parsedResponseReceived).length,
    acceptedModelSubmissions: model.filter(c => c.submissionAccepted === true).length,
    capacityEvents: calls.filter(c => isProviderCapacity(c.failure)).length,
    capacityLimitedModelRequests: model.filter(c => isProviderCapacity(c.failure)).length,
    rejectedModelAttempts: model.filter(c => c.submissionAccepted === false && !isProviderCapacity(c.failure)).length,
    unknownModelSubmissionOutcomes: model.filter(c => c.submissionAccepted === undefined).length,
    resumeModelTransportAttempts: model.filter(c => c.run === 'resume').length,
    checkpointAcknowledgements: results.flatMap(r => r.checkpointCommits).filter(c => c.persisted).length,
    modelUsage: { reportingAttempts: usage.length, unknownAttempts: model.length - usage.length,
      totalTokens: usage.length ? usage.reduce((sum, u) => sum + u.totalTokens, 0) : null } }
}
