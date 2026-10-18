import { lessonForSession, lessonSchema, type Lesson } from '../../src/lib/domain/lesson'
import { evaluationProviders } from './model-matrix'
import { defaultLessonExecutionPolicy } from '../../src/lib/teacher/lessonGeneration/executionPolicy'
import { defaultLessonWorkflowPolicy, lessonScopeWorkflowPolicy } from '../../src/lib/teacher/lessonGeneration/workflowBudget'
import type { CheckpointCommit } from '../../src/lib/teacher/lessonGeneration/checkpoint'
import type { LessonModelProfile } from '../../src/lib/teacher/lessonGeneration/modelProfiles'
import { featherlessTokenCounter, type TokenizationEvidence } from '../../src/lib/ai/featherlessTokenCounter'
import { parseToolContext } from '../fixtures/tool-context'
import { seedLessonReferences, restoreLessonSources } from './lesson-reference-seed'
import 'fake-indexeddb/auto'
import { deleteDB } from 'idb'
import { streamChat } from '../../src/lib/ai/client'
import type { ChatOptions, ChatResult, ProviderStreamError, ResponseDiagnostic } from '../../src/lib/ai/types'
import { type InferenceFailureRecord } from '../../src/lib/ai/inferenceFailure'
import { requestFailure } from './request-failure'
import { capacityLimitedRequest, lessonOperationalOutcome } from './provider-capacity'
import { sameRecord } from '../../src/lib/domain/common'
import { englishAnswers, withPinyin } from '../../src/lib/domain/lessonPlan'
import { preparedLessonSteps } from '../../src/lib/domain/lessonPlan'
import { validateGraphDraft, validateLessonPreparation } from '../../src/lib/domain/lessonPreparation'
import { createWorkspace, type Workspace } from '../../src/lib/domain/workspace'
import { LearningService } from '../../src/lib/learning/learningService'
import { lessonReadiness, lessonSummary } from '../../src/lib/learning/lessonProgress'
import { mandarinPinyin } from '../../src/lib/mandarin/chineseParser'
import { defaultSettings, providerDefaults } from '../../src/lib/settings'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { DiscoveryService } from '../../src/lib/teacher/discoveryService'
import { TeacherService, type TeacherHost, type TeacherOptions } from '../../src/lib/teacher/teacherService'
import { lessonSourceFixture, sourceFixtureTools } from '../fixtures/lesson-source'
import { topicFixture } from '../fixtures/topic-lesson'
import { digest, redact, type RunConfig as BaseRunConfig } from './mandarin-runner'
import { CORPUS_VERSION, SOURCE_ID, sourceProvenance, validateCorpus, type LessonCase } from './lesson-corpus'
export { digest, redact } from './mandarin-runner'
export type RunConfig = BaseRunConfig & { featherlessThinking?: boolean | 'coverage'; lessonModelProfile?: LessonModelProfile; tokenCounter?: 'featherless' }
export { CORPUS_VERSION, lessonCases, rawLessonCases, candidateModels, modelMatrix, sourceProvenance, validateCorpus } from './lesson-corpus'

export type ResumeLessonArtifacts = { plan: Lesson; sources: Workspace['sources']; quizzes?: Workspace['drafts']; originalRequestCount: number; originalDurationMs: number }
export const MAX_CALLS = defaultLessonWorkflowPolicy.maxRequests
export const rawLessonEvaluationPolicy = { execution: { ...defaultLessonExecutionPolicy },
  workflow: lessonScopeWorkflowPolicy(9), creation: { maxRequests: 32, timeoutMs: 900_000 },
  evaluation: { maxRequests: lessonScopeWorkflowPolicy(9).maxRequests + 32, timeBudgetMs: lessonScopeWorkflowPolicy(9).timeoutMs + 900_000 } }
export const lessonEvaluationPolicy = { execution: { ...defaultLessonExecutionPolicy },
  workflow: { ...defaultLessonWorkflowPolicy, lessonScopeWorkflowPolicy }, evaluation: { maxRequests: MAX_CALLS, timeBudgetMs: defaultLessonWorkflowPolicy.timeoutMs } }
const START = Date.UTC(2026, 9, 8, 12)
export type CallEvidence = {
  stage: string; mode: string; repair: boolean; requestedModel: string; returnedModel?: string; durationMs: number; parsedResponseReceived: boolean;
  request: Pick<ChatOptions, 'messages' | 'tools' | 'toolChoice' | 'maxTokens' | 'temperature' | 'compatibility' | 'featherlessThinking' | 'generationTrace' | 'toolResponseDialect' | 'responseMode' | 'contextBudget' | 'normalizeParameterNameQuotes' | 'allowAssistantPrefix' | 'normalizeFunctionOpening'>;
  streamActivity: { reasoningCharacters: number; contentCharacters: number };
  requestHash: string; wireRequest?: Record<string, unknown>; wireRequestHash?: string; response?: Omit<ChatResult, 'reasoning'>; httpStatus?: number; error?: string;
  diagnostic?: ResponseDiagnostic; providerError?: ProviderStreamError; failure?: InferenceFailureRecord;
  wireContent?: { text: string; truncated: boolean };
  submissionAccepted?: boolean;
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : 'Unknown evaluation failure').slice(0, 4000)
function preparationInput(options: ChatOptions): Record<string, any> {
  for (const message of [...options.messages].reverse()) if (message.role === 'user') {
    try { const value = parseToolContext(message.content); if (value.generationMode) return value
      if (['solve_english_question', 'solve_visible_question'].includes(options.tools?.[0]?.function.name ?? '') && Array.isArray(value.choices)) return { ...value, generationMode: options.tools![0]!.function.name } } catch { /* bounded repair instruction */ }
  }
  throw new Error('Missing preparation input.')
}
/** Deliberately synthetic plumbing responses, never language-quality evidence. */
export const lessonFixture: typeof streamChat = async options => {
  const input = preparationInput(options)
  const sourceTool = options.tools?.[0]?.function.name ?? ''
  if (sourceFixtureTools.includes(sourceTool)) return { content: '', reasoning: '', finishReason: 'tool_calls', model: 'authored-creation-fixture', toolCalls: [{ id: crypto.randomUUID(), type: 'function', function: { name: sourceTool, arguments: JSON.stringify(lessonSourceFixture(sourceTool, 4)) } }] }
  if (['solve_english_question', 'solve_visible_question'].includes(options.tools?.[0]?.function.name ?? '')) return { ...topicFixture(options), model: 'authored-lesson-fixture' }
  if (['add_lesson_waypoint', 'revise_lesson_waypoint', 'verify_lesson_graph', 'verify_lesson_waypoint', 'evaluate_question_coverage', 'list_missing_questions', 'build_question_answers', 'revise_question_answers', 'verify_correct_question'].includes(input.generationMode)) return { ...topicFixture(options), model: 'authored-lesson-fixture' }
  throw new Error(`Unknown lesson fixture stage: ${input.generationMode}`)
}

export async function runCase(entry: LessonCase, config: RunConfig, signal?: AbortSignal, fixtureOverride?: typeof streamChat,
  onCall?: (call: CallEvidence) => void | Promise<void>, onCallUpdate?: (call: CallEvidence) => void | Promise<void>, resume?: ResumeLessonArtifacts) {
  validateCorpus([entry])
  const envelope = (entry.rawRequest ? rawLessonEvaluationPolicy : lessonEvaluationPolicy).evaluation
  if (resume && entry.rawRequest) throw new Error('Raw-entry evaluation checkpoints resume in the application; this authored-target resume adapter does not import creation drafts.')
  if (resume && (!Number.isInteger(resume.originalRequestCount) || resume.originalRequestCount < 1 || resume.originalRequestCount >= MAX_CALLS || !Number.isFinite(resume.originalDurationMs) || resume.originalDurationMs < 0 || resume.originalDurationMs >= lessonEvaluationPolicy.evaluation.timeBudgetMs)) throw new Error('A resume must retain remaining original request and duration budgets.')
  if (config.mode === 'live' && (!config.confirmed || !config.apiKey.trim() || !config.model.trim() || !evaluationProviders.includes(config.provider) || fixtureOverride)) throw new Error('Live evaluation needs a supported provider, model, key and explicit confirmation; no fixture substitution.')
  if (config.featherlessThinking !== undefined && (config.mode !== 'live' || config.provider !== 'featherless')) throw new Error('Thinking overrides require a live Featherless lesson run.')
  if (config.tokenCounter && (config.mode !== 'live' || config.provider !== 'featherless')) throw new Error('Exact Featherless token counts require a live Featherless run.')
  const settings = defaultSettings(), provider = config.mode === 'live' ? config.provider : 'featherless'
  settings.selected = provider
  settings.profiles[provider] = { ...providerDefaults[provider], model: config.mode === 'live' ? config.model : 'authored-lesson-fixture', apiKey: config.mode === 'live' ? config.apiKey : 'fixture-never-network', keyOrigin: new URL(providerDefaults[provider].baseUrl).origin }
  const name = `lesson-evaluation-${crypto.randomUUID()}`, repository = await WorkspaceRepository.open({ name, initial: () => createWorkspace(START), broadcast: false })
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(command) { snapshot = await command(snapshot, repository); return snapshot } }
  const clock = { now: () => START }, learning = new LearningService(repository, clock), calls: CallEvidence[] = []
  const started = performance.now(), stages: Array<{ label: string; startedMs: number; durationMs: number }> = []
  let stage = 'setup', failure: { stage: string; message: string; detail?: InferenceFailureRecord } | null = null
  const invariants: Record<string, boolean> = {}
  // Covers all stages, including bounded repairs. Each production request also
  // retains its own timeout; there is no retry of a failed case in this runner.
  const deadline = AbortSignal.timeout(Math.ceil(envelope.timeBudgetMs - (resume?.originalDurationMs ?? 0))), runSignal = AbortSignal.any([deadline, ...(signal ? [signal] : [])])
  try {
    const transport = config.mode === 'fixture' ? fixtureOverride ?? lessonFixture : streamChat
    const tokenizationChecks: TokenizationEvidence[] = [], checkpointCommits: CheckpointCommit[] = []
    const exactCounter = config.tokenCounter ? featherlessTokenCounter(settings.profiles[provider], { onCheck: e => { tokenizationChecks.push(e) } }) : undefined
    const teacherOptions: TeacherOptions = { clock, random: () => 0.42, lessonModelProfile: config.lessonModelProfile,
      onCheckpointCommitted: event => { checkpointCommits.push(event) },
      onSubmission: async event => {
        const call = [...calls].reverse().find(c => c.request.generationTrace?.stage === event.stage
          && c.request.generationTrace.attempt?.submission === event.submissionAttempt
          && c.request.generationTrace.attempt?.request === event.requestAttempt)
        if (call) { call.submissionAccepted = event.accepted; if (event.failure) call.failure = event.failure; await onCallUpdate?.(structuredClone(call)) }
      },
      inputTokenCounter: exactCounter ? (request, signal) => exactCounter({ ...request, ...(config.featherlessThinking === undefined ? {} : {
        featherlessThinking: config.featherlessThinking === 'coverage' ? request.tools?.[0]?.function.name === 'evaluate_question_coverage' : config.featherlessThinking,
      }) }, signal) : undefined,
      transport: async options => {
      runSignal.throwIfAborted()
      if (calls.length >= envelope.maxRequests - (resume?.originalRequestCount ?? 0)) throw new Error('Evaluation call budget exhausted.')
      const request = structuredClone({ messages: options.messages, tools: options.tools, toolChoice: options.toolChoice, maxTokens: options.maxTokens, temperature: options.temperature, compatibility: options.compatibility, featherlessThinking: options.featherlessThinking, generationTrace: options.generationTrace, toolResponseDialect: options.toolResponseDialect, responseMode: options.responseMode, contextBudget: options.contextBudget, normalizeParameterNameQuotes: options.normalizeParameterNameQuotes, allowAssistantPrefix: options.allowAssistantPrefix, normalizeFunctionOpening: options.normalizeFunctionOpening })
      const input = preparationInput(options), mode = input.generationMode
      const current = options.messages.at(-1)
      const repair = options.messages.some(m => m.role === 'tool' && m.content?.includes('"ok":false'))
        || current?.role === 'user' && current.content.includes('"nativeSubmissionIssue"')
      const call: CallEvidence = { stage, mode, repair, requestedModel: options.model, request, requestHash: await digest(JSON.stringify(request)), durationMs: 0, parsedResponseReceived: false, streamActivity: { reasoningCharacters: 0, contentCharacters: 0 } }
      calls.push(call); const start = performance.now()
      try {
        const result = await transport({ ...options, handlers: { ...options.handlers,
          onModel: model => { call.returnedModel = model; options.handlers?.onModel?.(model) },
          onDiagnostic: diagnostic => { call.diagnostic = diagnostic; options.handlers?.onDiagnostic?.(diagnostic) },
          onProviderError: error => { call.providerError = error; options.handlers?.onProviderError?.(error) },
          onReasoning: chunk => { call.streamActivity.reasoningCharacters += chunk.length; options.handlers?.onReasoning?.(chunk) },
          onContent: chunk => {
            call.streamActivity.contentCharacters += chunk.length
            call.wireContent ??= { text: '', truncated: false }
            const remaining = 8000 - call.wireContent.text.length
            call.wireContent.text += chunk.slice(0, remaining)
            if (chunk.length > remaining) call.wireContent.truncated = true
            options.handlers?.onContent?.(chunk)
          },
        }, fetcher: async (url, init) => {
          call.wireRequest = JSON.parse(String(init?.body)) as Record<string, unknown>
          if (config.featherlessThinking !== undefined) call.wireRequest.chat_template_kwargs = { ...(call.wireRequest.chat_template_kwargs as Record<string, unknown>), enable_thinking: config.featherlessThinking === 'coverage' ? mode === 'evaluate_question_coverage' : config.featherlessThinking }
          call.wireRequestHash = await digest(JSON.stringify(call.wireRequest))
          const response = await fetch(url, { ...init, body: JSON.stringify(call.wireRequest) }); call.httpStatus = response.status; return response
        } })
        const { reasoning: _reasoning, ...response } = result
        call.response = response; call.returnedModel = result.model; call.parsedResponseReceived = true
        return result
      } catch (error) { call.submissionAccepted = false; call.error = errorMessage(error); call.failure = requestFailure(error, options, deadline); throw error }
      finally { call.durationMs = Math.round(performance.now() - start); await onCall?.(structuredClone(call)) }
    } }
    const rootId = snapshot.state.view.activeRootId, nodeId = 'evaluation-source-node', draftId = 'evaluation-source-draft'
    if (entry.rawRequest) {
      await host.apply((s, r) => r.mutate(s.version, { id: crypto.randomUUID(), kind: 'set-creation-learner', intent: {}, at: START }, state => {
        state.learners[0]!.level = entry.settings.complexity === 'connected' ? 'intermediate' : 'beginner'
      }))
      const discovery = new DiscoveryService(host, () => settings, { ...teacherOptions,
        onProgress: label => { stage = label } })
      const id = await discovery.saveRequest({ ...entry.rawRequest, rootId, quizLevel: entry.settings.quizLevel, extract: false, refresh: false })
      try {
        await discovery.resume(id, runSignal)
        await discovery.startLesson(id, entry.settings)
      } catch (error) {
        failure = { stage, message: errorMessage(error), detail: { stage, ...requestFailure(error, { handlers: { signal: runSignal } }, deadline) } }
        const portable = parseBackup(JSON.stringify(exportBackup(snapshot, START))).data
        invariants.backupRoundTrip = sameRecord(portable, JSON.parse(JSON.stringify(snapshot.state)))
        return redact({ caseId: entry.id, entryPoint: 'raw-request', caseSnapshot: { id: entry.id, kind: entry.kind, settings: entry.settings, rawRequest: entry.rawRequest },
          sourceProvenance: 'Raw application creation interrupted; accepted draft checkpoints are retained below.',
          durationMs: Math.round(performance.now() - started), stages, calls, failure, cancelled: Boolean(signal?.aborted), timedOut: deadline.aborted,
          prepared: false, scriptedPlaybackCompleted: false, invariants, tokenizationChecks, checkpointCommits,
          readiness: { teaching: false, practice: 'missing', check: 'missing' }, qualitySignals: { repeatedCheckTargets: [], note: 'No completion claim.' },
          artifacts: { creation: snapshot.state.drafts.find(d => d.id === id), plan: undefined, sources: snapshot.state.sources, teaching: [], practice: null, check: null, exercises: snapshot.state.exercises, attempts: snapshot.state.attempts },
          scriptedInteraction: null, humanReview: { status: 'pending', releaseReady: false, checks: entry.reviewerFocus },
        }, [settings.profiles[provider].apiKey])
      }
    } else {
    await host.apply((s, r) => r.mutate(s.version, { id: crypto.randomUUID(), kind: 'seed-evaluation-source', intent: { caseId: entry.id }, at: START }, state => {
      state.learners[0]!.level = entry.settings.complexity === 'connected' ? 'intermediate' : 'beginner'
      if (entry.kind === 'topic') {
        state.nodes.push({ id: nodeId, rootId, type: 'assistant', position: { x: 200, y: 0 }, bookmarked: false, collapsed: false, data: { text: `${entry.material.passageHanzi}\n${entry.material.passageMeaning}`, reasoning: '', state: 'complete', error: '', provider: 'project-authored', model: 'none' } })
        state.edges.push({ id: 'source-edge', source: rootId, target: nodeId, data: { kind: 'conversation' } })
      } else {
        state.sources.push({ id: SOURCE_ID, kind: 'web', url: `https://example.org/evaluation/${entry.kind}`, title: 'Authored evaluation snapshot (not retrieved)', excerpt: `${entry.material.passageHanzi}\n${entry.material.passageMeaning}`, retrievedAt: START, nodeId })
        state.nodes.push({ id: nodeId, rootId, type: 'lesson', position: { x: 200, y: 0 }, bookmarked: false, collapsed: false, data: { draftId } })
        state.edges.push({ id: 'source-edge', source: rootId, target: nodeId, data: { kind: 'derived' } })
        state.drafts.push({ id: draftId, kind: 'discovery', status: 'validated', text: sourceProvenance, sourceIds: [SOURCE_ID], cardIds: [], createdAt: START, updatedAt: START,
          discoveryRequest: { kind: entry.kind === 'scenario' ? 'roleplay' : 'interest', publicTopic: entry.settings.topic, rootId, extract: false, refresh: false },
          discovery: { ...entry.material, nodeId, passagePinyin: mandarinPinyin(entry.material.passageHanzi), captures: [], phrases: entry.material.phrases.map((p, i) => ({ ...p, id: `phrase-${i}`, pinyin: mandarinPinyin(p.hanzi), examplePinyin: mandarinPinyin(p.exampleHanzi) })) },
          generation: { provider: 'fixture', model: 'authored-source', promptVersion: CORPUS_VERSION, createdAt: START },
          contentReview: { verdict: 'supported', reasons: 'Authored seed only; not independent language review.', provider: 'fixture', model: 'authored-source', promptVersion: CORPUS_VERSION } })
      }
    }))
    for (const [i, phrase] of entry.material.phrases.entries()) {
      if (entry.kind === 'topic') await host.apply(s => learning.addItem(s, { language: 'zh', kind: 'phrase', canonicalText: phrase.hanzi, meaning: phrase.meaning, senseKey: phrase.sense, pinyin: mandarinPinyin(phrase.hanzi), sourceNodeIds: [nodeId], sourceRootIds: [rootId] }, ['recognition']))
      else await new DiscoveryService(host, () => settings, { clock }).capturePhrase(draftId, `phrase-${i}`, ['recognition'])
    }
    const seeded = structuredClone(snapshot.state)
    seedLessonReferences(seeded, START)
    // Fresh isolated evaluation dataset: replacing it avoids inserting renamed
    // cards alongside their old keys in the repository's unique card index.
    snapshot = await repository.replace(snapshot.version, seeded)
    await host.apply(s => learning.startLesson(s, nodeId, s.state.items.map(i => i.id), entry.objective, entry.settings))
    }
    const teacher = new TeacherService(host, () => settings, teacherOptions)
    const sessionId = snapshot.state.sessions.at(-1)!.id, session = () => snapshot.state.sessions.find(s => s.id === sessionId)!
    if (resume) {
      const plan = lessonSchema.parse(structuredClone(resume.plan))
      const input = plan.preparation?.input ?? plan.waypointDraft?.input
      if (plan.kind !== entry.kind || !sameRecord(plan.settings, entry.settings)
        || input && (!sameRecord([...input.targets.map(t => t.cardId)].sort(), [...lessonForSession(snapshot.state, session())!.cardIds].sort())
        || input.objective !== entry.objective)) throw new Error('Resume checkpoint does not match the selected evaluation case.')
      if (plan.preparation) {
        validateLessonPreparation(plan.preparation)
        if (plan.preparation.practice?.complete && plan.preparation.check?.complete) throw new Error('Resume requires incomplete lesson preparation.')
        plan.steps = preparedLessonSteps(plan.preparation, plan.settings, plan.kind)
      }
      if (plan.waypointDraft) validateGraphDraft(plan.waypointDraft)
      await host.apply((s, r) => r.mutate(s.version, { id: crypto.randomUUID(), kind: 'restore-evaluation-preparation', intent: { caseId: entry.id }, at: START }, state => {
        state.sources = restoreLessonSources(state.sources, resume.sources, state.view.activeRootId)
        const lesson = lessonForSession(state, state.sessions.find(s => s.id === sessionId))!
        const { id, learnerId, createdAt, opportunity } = lesson
        Object.assign(lesson, plan, { id, learnerId, createdAt, opportunity })
        for (const quiz of resume.quizzes ?? []) {
          if (quiz.kind !== 'quiz' || quiz.status !== 'validated' || !quiz.lessonPhase || !plan.preparation![quiz.lessonPhase]?.complete) throw new Error('Resume quiz does not belong to a completed saved phase.')
          state.drafts.push({ ...structuredClone(quiz), sessionId })
        }
      }))
    }
    const originalCards = structuredClone(snapshot.state.cards), originalEvents = structuredClone(snapshot.state.events)
    try {
      await teacher.prepareLesson(sessionId, runSignal, label => {
        if (stages.length) stages.at(-1)!.durationMs = Math.round(performance.now() - started - stages.at(-1)!.startedMs)
        stage = label; stages.push({ label, startedMs: Math.round(performance.now() - started), durationMs: 0 })
      })
    } catch (error) { failure = { stage, message: errorMessage(error), detail: { stage, ...requestFailure(error, { handlers: { signal: runSignal } }, deadline) } } }
    if (stages.length) stages.at(-1)!.durationMs = Math.round(performance.now() - started - stages.at(-1)!.startedMs)
    invariants.preparationPreservesCardsAndEvents = sameRecord(originalCards, snapshot.state.cards) && sameRecord(originalEvents, snapshot.state.events)
    const ready = lessonReadiness(snapshot.state, session()), preparedCalls = calls.length
    const normalizeQuestion = (q: { stem: string; passage?: string }) => `${q.stem} ${q.passage ?? ''}`.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
    const repeatedCheckTargets = ready.check?.quiz?.questions.filter(q => ready.practice?.quiz?.questions.some(p => p.cardId === q.cardId && normalizeQuestion(p) === normalizeQuestion(q))).map(q => q.cardId) ?? []
    let interaction: ReturnType<typeof lessonSummary> | null = null
    if (ready.ready && !failure) {
      stage = 'scripted interaction'
      invariants.presentationMatchesFormat = true; invariants.firstAnswersPreserved = true; invariants.practiceDoesNotReschedule = true
      try {
        while (session().status === 'active') {
          const step = lessonForSession(snapshot.state, session())!.steps[session().lessonAttempt!.stepIndex]!
          if (step.phase === 'learn') { await host.apply(s => learning.advanceLesson(s, sessionId)); continue }
          const draft = ready[step.phase]!, index = draft.quiz!.questions.findIndex(q => q.lessonStep === session().lessonAttempt!.stepIndex)
          await teacher.presentQuizQuestion(sessionId, draft.id, index)
          const exercise = snapshot.state.exercises.at(-1)!, mc = exercise.multipleChoice!, level = entry.settings.quizLevel
          const passage = draft.quiz!.questions[index]!.passage
          invariants.presentationMatchesFormat &&= mc.quizLevel === level && mc.passagePinyin === (passage && withPinyin(level) ? mandarinPinyin(passage) : undefined) && mc.options.every(o => o.pinyin === (!englishAnswers(level) && withPinyin(level) ? mandarinPinyin(o.text) : undefined))
          // Scripted wrong practice then supported correction; one aided check
          // and one unaided check. These are mechanics probes, not user scores.
          const helped = step.phase === 'check' && index === 0
          if (helped) await host.apply(s => learning.requestHelp(s, exercise.id, 'reveal'))
          const selectedOptionId = step.phase === 'practice' ? mc.options.find(o => o.id !== mc.correctOptionId)!.id : mc.correctOptionId
          const attemptId = crypto.randomUUID(), schedule = structuredClone(snapshot.state.cards)
          await host.apply(s => learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '', selectedOptionId, submittedAt: START }))
          await teacher.gradeAttempt(attemptId, runSignal)
          const attempts = structuredClone(snapshot.state.attempts), events = structuredClone(snapshot.state.events)
          if (step.phase === 'practice') await host.apply(s => learning.completeSupportedRetry(s, sessionId, mc.correctOptionId))
          invariants.firstAnswersPreserved &&= sameRecord(attempts, snapshot.state.attempts) && sameRecord(events, snapshot.state.events)
          await host.apply(s => learning.advanceLesson(s, sessionId))
          invariants.practiceDoesNotReschedule &&= sameRecord(schedule, snapshot.state.cards)
        }
        interaction = lessonSummary(snapshot.state, session())
        invariants.scriptedCheckSummary = interaction?.correct === ready.check!.quiz!.questions.length - 1 && interaction.helped === 1 && interaction.unanswered === 0
        invariants.noInteractiveGeneration = calls.length === preparedCalls
      } catch (error) { failure = { stage, message: errorMessage(error) } }
    }
    const portable = parseBackup(JSON.stringify(exportBackup(snapshot, START))).data
    invariants.backupRoundTrip = sameRecord(portable, JSON.parse(JSON.stringify(snapshot.state)))
    return redact({ caseId: entry.id, entryPoint: entry.rawRequest ? 'raw-request' : 'authored-targets', caseSnapshot: entry.rawRequest ? { id: entry.id, kind: entry.kind, settings: entry.settings, rawRequest: entry.rawRequest } : entry, sourceProvenance: entry.rawRequest ? 'Real application creation path from raw request; source, plan and targets generated during this run.' : sourceProvenance, durationMs: Math.round(performance.now() - started), stages, calls, failure,
      cancelled: Boolean(signal?.aborted), timedOut: deadline.aborted, prepared: ready.ready, scriptedPlaybackCompleted: session().status === 'completed', invariants, tokenizationChecks, checkpointCommits,
      readiness: { teaching: ready.teaching, practice: ready.practice?.status ?? 'missing', check: ready.check?.status ?? 'missing' },
      qualitySignals: { repeatedCheckTargets, note: 'Text repetition is a review flag; absence does not prove meaningful transfer.' },
      ...(resume ? { resumeEvidence: { originalRequestCount: resume.originalRequestCount, originalDurationMs: resume.originalDurationMs,
        preservedLesson: resume.plan.preparation ? sameRecord(resume.plan.preparation.lesson, lessonForSession(snapshot.state, session())!.preparation?.lesson) : null,
        preservedGraphWaypoints: (resume.plan.waypointDraft?.graph.waypoints ?? []).every(w =>
          (lessonForSession(snapshot.state, session())!.preparation?.lesson.graph.waypoints ?? lessonForSession(snapshot.state, session())!.waypointDraft?.graph.waypoints ?? []).some(current => sameRecord(current, w))),
        preservedAcceptedQuestions: ['practice', 'check'].every(phase => {
          const original = resume.plan.preparation?.[phase as 'practice' | 'check']?.questions ?? []
          const current = lessonForSession(snapshot.state, session())!.preparation?.[phase as 'practice' | 'check']?.questions ?? []
          return original.every(q => current.some(saved => sameRecord(saved, q)))
        }), reauthoredGraph: calls.some(c => ['add_lesson_waypoint', 'revise_lesson_waypoint'].includes(c.mode)) } } : {}),
      artifacts: { ...(entry.rawRequest ? { creation: snapshot.state.drafts.find(d => d.kind === 'discovery') } : {}), plan: lessonForSession(snapshot.state, session()), sources: snapshot.state.sources, teaching: snapshot.state.drafts.filter(d => d.kind === 'teaching' && d.sessionId === sessionId), practice: ready.practice ?? null, check: ready.check ?? null, exercises: snapshot.state.exercises, attempts: snapshot.state.attempts },
      scriptedInteraction: interaction, humanReview: { status: 'pending', releaseReady: false, checks: ['Natural Mandarin, faithful translations and correct pinyin', 'Exactly one defensible correct answer and plausible distractors', 'Teaching covers tested vocabulary and intended complexity/scope', 'Check transfers learning to a changed situation', 'Feedback explains each specific misconception', ...entry.reviewerFocus] },
    }, [settings.profiles[provider].apiKey])
  } finally { repository.close(); await deleteDB(name) }
}
export type CaseResult = Awaited<ReturnType<typeof runCase>>
export function summarize(results: CaseResult[], config: RunConfig, planned: number) {
  const calls = results.flatMap(r => r.calls), usages = calls.flatMap(c => c.response?.usage ?? c.diagnostic?.usage ? [c.response?.usage ?? c.diagnostic!.usage!] : [])
  const trialsFinished = results.filter(r => !r.cancelled).length
  return { mode: config.mode, planned, attempted: results.length, trialsFinished, allTrialsFinished: trialsFinished === planned,
    lessonsReady: results.filter(r => r.prepared).length, scriptedPlaybackCompleted: results.filter(r => r.scriptedPlaybackCompleted).length,
    requestsAttempted: calls.length, parsedResponsesReceived: calls.filter(c => c.parsedResponseReceived).length, requestsWithoutParsedResponse: calls.filter(c => !c.parsedResponseReceived).length,
    httpResponsesObserved: calls.filter(c => (c.httpStatus ?? c.diagnostic?.httpStatus) !== undefined).length,
    checkpointsPersisted: results.reduce((sum, result) => sum + result.checkpointCommits.filter(c => c.persisted).length, 0),
    submissionsAccepted: calls.filter(c => c.submissionAccepted === true).length,
    submissionOutcomesUnknown: calls.filter(c => c.submissionAccepted === undefined).length,
    failed: results.filter(r => r.failure && lessonOperationalOutcome(r) !== 'harness_capacity_error').map(r => ({ caseId: r.caseId, ...r.failure })),
    harnessErrors: results.filter(r => lessonOperationalOutcome(r) === 'harness_capacity_error').map(r => ({ caseId: r.caseId, category: 'provider_capacity', ...r.failure })),
    capacityLimitedRequests: calls.filter(capacityLimitedRequest).length,
    transportCalls: calls.length, liveModelCalls: config.mode === 'live' ? calls.length : 0,
    repairCalls: calls.filter(c => c.repair).length, returnedModels: [...new Set(calls.flatMap(c => c.returnedModel ? [c.returnedModel] : []))],
    preparationDurationMs: results.map(r => ({ caseId: r.caseId, durationMs: r.stages.reduce((n, s) => n + s.durationMs, 0) })),
    usage: { callsReportingUsage: usages.length, callsWithoutUsage: calls.length - usages.length, reportedTokens: usages.length ? usages.reduce((sum, u) => ({ promptTokens: sum.promptTokens + u.promptTokens, completionTokens: sum.completionTokens + u.completionTokens, totalTokens: sum.totalTokens + u.totalTokens }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 }) : null },
    invariantFailures: results.flatMap(r => Object.entries(r.invariants).filter(([, pass]) => !pass).map(([check]) => ({ caseId: r.caseId, check }))),
    evidence: config.mode === 'fixture' ? 'Synthetic contract evidence only; no model quality claim.' : 'Live preparation and model self-review; scripted learner interactions are not learner accuracy or retention.',
    humanReview: 'pending', releaseReady: false }
}
