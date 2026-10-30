import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer, loadEnv } from 'vite'

const args = process.argv.slice(2), options = {}, flags = new Set(['fixture', 'confirm-live', 'help'])
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['from', 'case', 'stage', 'occurrence', 'candidate', 'candidate-tool', 'candidate-thinking', 'expect-waypoints', 'model', 'repeat', 'out', ...flags].includes(key) || key in options) throw new Error('Unknown or repeated experiment option. Use --help.')
  options[key] = flags.has(key) ? true : args[++i]
  if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error('Missing option value.')
}
if (options.help) {
  console.log('npm run eval:lesson-stage -- --from TERMINAL_REPORT.json --case CASE --stage buildWaypoint|reviewWaypoint|reviewGraph|evaluateCoverage [--occurrence N] --candidate PROFILE.json [--candidate-tool submit_review_name | --candidate-thinking on] [--expect-waypoints w1,w2] [--fixture | --model MODEL --confirm-live] [--repeat 1|2] [--out NEW.json]\nPreview makes zero API calls. Fixture uses authored synthetic calls. Live uses Featherless and the existing local key. Candidate variants require an empty-guidance profile and change only the declared tool name or thinking setting. --expect-waypoints scores a frozen coverage case against declared semantic labels. Repetitions use AB or ABBA order. Baseline reconstructs current instructions with the explicit shared profile, not the provider default or original captured prompt. Coverage uses production submission validation. Maximum dispatches: 8 per operation including separate transport and capacity recovery; capacity events are not model-quality failures.')
  process.exit(0)
}
if (!options.from || !options.case || !options.stage || !options.candidate) throw new Error('Specify a terminal report, case, stage and candidate profile.')
if (options['candidate-tool'] && (!/^[_a-z][_a-z0-9]{2,63}$/.test(options['candidate-tool']) || !['reviewWaypoint', 'reviewGraph'].includes(options.stage))) throw new Error('A candidate tool name is allowed only for review stages and must be a simple function name.')
if (options['candidate-thinking'] && (options['candidate-thinking'] !== 'on' || !['reviewWaypoint', 'reviewGraph'].includes(options.stage))) throw new Error('Thinking experiments may enable thinking only for one review stage.')
if (options['candidate-tool'] && options['candidate-thinking']) throw new Error('Test only one candidate contract or setting change at a time.')
if (options['expect-waypoints'] && options.stage !== 'evaluateCoverage') throw new Error('Expected waypoint IDs apply only to coverage evaluation.')
if (options.fixture && (options['confirm-live'] || options.model)) throw new Error('Choose either fixture or live mode.')
if (Boolean(options['confirm-live']) !== Boolean(options.model)) throw new Error('Live mode needs --model and --confirm-live together.')
const live = Boolean(options['confirm-live']), fixture = Boolean(options.fixture), active = live || fixture
if (active !== Boolean(options.out)) throw new Error('Fixture or live mode needs a new --out JSON path; preview does not write one.')
const repeat = Number(options.repeat ?? 1)
if (![1, 2].includes(repeat)) throw new Error('Repeat must be one or two.')
const occurrence = Number(options.occurrence ?? 1)
if (!Number.isInteger(occurrence) || occurrence < 1) throw new Error('Occurrence must be a positive integer.')
const sha = value => createHash('sha256').update(value).digest('hex')
const sourceText = await readFile(resolve(options.from), 'utf8'), source = JSON.parse(sourceText)
if (!['finished', 'complete', 'completed'].includes(source.status)) throw new Error('Choose a terminal lesson report.')
const cases = source.results?.filter(row => row.caseId === options.case)
if (!cases?.length || cases.length !== 1) throw new Error('Choose exactly one case result in the source report.')
const calls = cases[0].calls.filter(call => call.request?.generationTrace?.stage === options.stage && !call.repair)
if (calls.length < occurrence) throw new Error('The case has no initial request at that stage occurrence.')
const frozenCall = calls[occurrence - 1], contextMessage = frozenCall.request.messages.filter(m => m.role === 'user').at(-1)?.content
if (!contextMessage?.includes('\n\nTool call:\n')) throw new Error('The frozen stage has no projected context and tool footer.')
let context = JSON.parse(contextMessage.split('\n\nTool call:\n', 1)[0])
if (context.generationMode !== frozenCall.mode || !context.kind || !context.settings) throw new Error('The frozen stage is not a lesson projection.')

const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, define: { __VL_TEST_KEYS__: '{}' } })
let output, stop
try {
  const { lessonStages } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/stages.ts')
  const { executeLessonStage } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/executeStage.ts')
  const { defaultLessonExecutionPolicy, lessonStageDispatchLimit } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/executionPolicy.ts')
  const { InferenceFailure, classifyInferenceFailure, isProviderCapacity } = await server.ssrLoadModule('/src/lib/ai/inferenceFailure.ts')
  const { parseToolContext } = await server.ssrLoadModule('/tests/fixtures/tool-context.ts')
  const { projectCoverageContext, validateCoverageSubmission } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/coverageContext.ts')
  const { questionFromWaypoint } = await server.ssrLoadModule('/src/lib/learning/waypointQuestion.ts')
  const { englishAnswers } = await server.ssrLoadModule('/src/lib/domain/lessonSettings.ts')
  context = parseToolContext(contextMessage)
  const { proposalWaypoint, applyWaypoint } = await server.ssrLoadModule('/src/lib/teacher/lessonGraphTools.ts')
  const { validateLessonGraph } = await server.ssrLoadModule('/src/lib/domain/lessonGraph.ts')
  const { lessonModelProfileSchema, defaultLessonModelProfile: sharedProfile, resolveLessonModelProfile } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/modelProfiles.ts')
  // This experiment controls the protocol explicitly; provider defaults are not an experimental variable.
  const defaultLessonModelProfile = { ...sharedProfile, protocol: { toolResponseDialect: 'native' } }
  const { streamChat } = await server.ssrLoadModule('/src/lib/ai/client.ts')
  const { providerDefaults } = await server.ssrLoadModule('/src/lib/settings.ts')
  const { lessonFixture } = await server.ssrLoadModule('/tests/evaluation/lesson-runner.ts')
  const definition = lessonStages[options.stage]
  if (!['buildWaypoint', 'reviewWaypoint', 'reviewGraph', 'evaluateCoverage'].includes(options.stage) || !definition || definition.toolName !== context.generationMode) throw new Error('Select a supported stage matching the frozen tool.')
  const expectedWaypointIds = options['expect-waypoints']?.split(',')
  if (expectedWaypointIds && (new Set(expectedWaypointIds).size !== expectedWaypointIds.length || expectedWaypointIds.some(id => !context.graph?.waypoints?.some(w => w.id === id)))) throw new Error('Expected coverage must list distinct IDs from the frozen graph.')
  if (options['candidate-tool'] === definition.toolName) throw new Error('Choose a different candidate tool name.')
  // The coverage projection intentionally omits the key. Resolve it only from
  // the source checkpoint, bind its complete visible fields, and keep it local.
  let reviewedCoverageQuestion = context.question
  if (options.stage === 'evaluateCoverage' && context.settings.focus === 'characters' && !englishAnswers(context.settings.quizLevel)) {
    const preparation = cases[0].artifacts?.plan?.preparation, quiz = preparation?.[context.phase]
    const questions = quiz?.questions.filter(entry => entry.id === context.question.id).map(entry => entry.question) ?? []
    if (quiz?.pending?.step === 'coverage' && context.question.id === `q${quiz.questions.length + 1}`) {
      questions.push(questionFromWaypoint(quiz.pending.candidate, quiz.pending.gap, preparation.lesson.graph, preparation.input))
    }
    reviewedCoverageQuestion = questions.find(question => JSON.stringify(projectCoverageContext(context, question, context.question.id).question) === JSON.stringify(context.question))
    if (!reviewedCoverageQuestion) throw new Error('Reply-recognition coverage requires an exactly matching reviewed question in the source checkpoint; its hidden key cannot be inferred from the projection.')
  }
  const validate = value => {
    if (options.stage === 'buildWaypoint') {
      const point = proposalWaypoint(value, context.nextWaypointId)
      applyWaypoint(context.graph, point.id, point, context)
    } else if (options.stage === 'reviewWaypoint') {
      if (value.decision === 'accept') applyWaypoint(context.graph, context.candidate.id, context.candidate, context)
    } else if (options.stage === 'reviewGraph') {
      const graph = validateLessonGraph(context.graph, context, false)
      if (value.waypointId && !graph.waypoints.some(w => w.id === value.waypointId)) throw new Error('Review identifies an unknown waypoint.')
      if (value.decision !== 'revise' && value.waypointId) throw new Error('Only revise may identify a waypoint.')
      if (value.decision === 'revise' && !value.waypointId) throw new Error('Revise must identify the waypoint to replace; use add for a missing point.')
      if (value.decision === 'accept') validateLessonGraph(graph, context)
      if (value.decision === 'add' && graph.waypoints.length >= 9) throw new Error('The graph has reached its nine-waypoint limit; revise an existing point.')
    } else {
      validateCoverageSubmission(context, reviewedCoverageQuestion, value.waypointIds)
    }
  }
  const candidateText = await readFile(resolve(options.candidate), 'utf8')
  const fileProfile = lessonModelProfileSchema.parse({ protocol: { toolResponseDialect: 'native' }, ...JSON.parse(candidateText) })
  const candidate = options['candidate-thinking'] ? lessonModelProfileSchema.parse({ ...fileProfile,
    stages: { ...(fileProfile.stages ?? {}), [definition.id]: { generation: { reasoning: 'on' } } } }) : fileProfile
  if (candidate.id === defaultLessonModelProfile.id && candidate.version === defaultLessonModelProfile.version) throw new Error('Give the candidate a distinct profile identity.')
  if (fileProfile.generation || Object.values(fileProfile.stages ?? {}).some(stage => stage.generation)) throw new Error('Generation settings must be declared by the experiment, not the candidate file.')
  const baselineResolved = resolveLessonModelProfile(defaultLessonModelProfile, definition.id, undefined, context.settings.quizLevel)
  const candidateResolved = resolveLessonModelProfile(candidate, definition.id, undefined, context.settings.quizLevel)
  if ((options['candidate-tool'] || options['candidate-thinking']) && candidateResolved.guidance !== baselineResolved.guidance) throw new Error('Contract and thinking experiments require identical resolved guidance, including answer-direction examples.')
  if (JSON.stringify(candidateResolved.protocol) !== JSON.stringify(baselineResolved.protocol) || candidateResolved.taskPlacement !== baselineResolved.taskPlacement) throw new Error('Experiment arms must preserve resolved protocol and task placement.')
  const baselineSettings = baselineResolved.generation
  const candidateSettings = candidateResolved.generation
  if (JSON.stringify({ ...baselineSettings, reasoning: 'off' }) !== JSON.stringify({ ...candidateSettings, reasoning: 'off' })) throw new Error('The profiles resolve to different generation settings beyond thinking mode.')
  if (!options['candidate-thinking'] && JSON.stringify(baselineSettings) !== JSON.stringify(candidateSettings)) throw new Error('The profiles resolve to different generation settings.')
  const key = live ? loadEnv('development', process.cwd(), '').FEATHERLESS_API_KEY?.trim() : undefined
  if (live && !key) throw new Error('Missing FEATHERLESS_API_KEY.')
  const redact = value => key ? String(value).replaceAll(key, '[redacted]') : String(value)
  const provider = { ...providerDefaults.featherless, apiKey: key ?? 'synthetic-fixture-key', model: options.model ?? 'authored-lesson-fixture' }
  const order = repeat === 2 ? ['baseline', 'candidate', 'candidate', 'baseline'] : ['baseline', 'candidate']
  const maximumDispatchesPerOperation = lessonStageDispatchLimit(defaultLessonExecutionPolicy)
  const files = ['scripts/experiment-lesson-stage.mjs', 'src/lib/teacher/lessonGeneration/workflow.ts', 'src/lib/teacher/lessonGeneration/executeStage.ts', 'src/lib/teacher/lessonGeneration/stages.ts', 'src/lib/domain/questionSolve.ts', 'src/lib/teacher/lessonGeneration/prompts.ts', 'src/lib/teacher/lessonGeneration/definitions.ts', 'src/lib/teacher/lessonGeneration/modelProfiles.ts', 'src/lib/teacher/lessonGeneration/assemblePrompt.ts', 'src/lib/teacher/lessonGraphTools.ts', 'src/lib/domain/lessonGraph.ts', 'src/lib/teacher/toolPrompt.ts', 'src/lib/ai/lessonGenerationAdapter.ts', 'src/lib/ai/client.ts', 'src/lib/ai/tools.ts']
  files.push('src/lib/ai/chatRequest.ts', 'src/lib/ai/completionEvent.ts', 'src/lib/ai/inferenceFailure.ts', 'src/lib/ai/providerDiagnostics.ts',
    'src/lib/ai/requestProtocol.ts', 'src/lib/ai/requestRecovery.ts', 'src/lib/ai/contextBudget.ts', 'src/lib/ai/generationBudget.ts', 'src/lib/ai/qwenToolProtocol.ts', 'src/lib/teacher/lessonGeneration/executionPolicy.ts', 'src/lib/teacher/lessonGeneration/stageSubmission.ts', 'src/lib/teacher/lessonGeneration/graphConstruction.ts', 'src/lib/teacher/lessonGeneration/checkpoint.ts', 'src/lib/teacher/lessonGeneration/assessmentPlan.ts', 'src/lib/teacher/lessonGeneration/workflowBudget.ts')
  files.push('src/lib/ai/qwenToolEnvelope.ts')
  files.push('tests/fixtures/tool-context.ts', 'src/lib/teacher/lessonGeneration/coverageContext.ts', 'src/lib/domain/coverageEvidence.ts', 'src/lib/learning/waypointQuestion.ts', 'src/lib/learning/quiz.ts', 'src/lib/domain/lessonSettings.ts')
  const report = { format: 'visual-language-lesson-stage-ab', version: 1, status: active ? 'running' : 'preview', startedAt: new Date().toISOString(),
    source: { path: resolve(options.from), sha256: sha(sourceText), caseId: options.case, stage: definition.id, occurrence, frozenRequestHash: sha(JSON.stringify(frozenCall.request)), contextHash: sha(JSON.stringify(context)) },
    scope: { request: 'reconstructed_current_guidance', baseline: 'explicit_shared_profile',
      validation: options.stage === 'evaluateCoverage' ? 'production_coverage_submission' : 'stage_content',
      semanticQuality: 'unrated' },
    experiment: options['candidate-tool'] ? { kind: 'tool_name', baseline: definition.toolName, candidate: options['candidate-tool'] }
      : options['candidate-thinking'] ? { kind: 'thinking', baseline: baselineSettings.reasoning, candidate: candidateSettings.reasoning } : { kind: 'guidance' },
    model: options.model ?? null, provider: active ? live ? 'featherless' : 'fixture' : null, order, settings: baselineSettings,
    expectedWaypointIds: expectedWaypointIds ?? null,
    arms: { baseline: { profile: defaultLessonModelProfile, profileHash: sha(JSON.stringify(defaultLessonModelProfile)) }, candidate: { profile: candidate, profileHash: sha(JSON.stringify(candidate)) } },
    codeHashes: Object.fromEntries(await Promise.all(files.map(async path => [path, sha(await readFile(path))]))),
    executionPolicy: defaultLessonExecutionPolicy,
    maximumDispatchesPerOperation,
    maximumModelCalls: active ? order.length * maximumDispatchesPerOperation : 0,
    operations: [], summary: null, humanReview: 'pending', releaseReady: false }
  const save = async () => {
    if (!output) return
    const body = JSON.stringify(report, null, 2) + '\n'
    await output.write(body, 0, 'utf8'); await output.truncate(Buffer.byteLength(body)); await output.sync()
  }
  if (active) {
    const path = resolve(options.out)
    if (!path.endsWith('.json')) throw new Error('Output must be a new JSON path.')
    await mkdir(dirname(path), { recursive: true }); output = await open(path, 'wx', 0o600)
  }
  await save()
  console.log(JSON.stringify({ stage: definition.id, caseId: options.case, mode: live ? 'live' : fixture ? 'fixture' : 'preview', order, maximumModelCalls: report.maximumModelCalls }))
  if (!active) { report.status = 'preview'; process.exitCode = 0 }
  else {
    const controller = new AbortController()
    stop = () => controller.abort(new DOMException('Experiment interrupted', 'AbortError'))
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
    let invariantRequest
    for (const arm of order) {
      if (controller.signal.aborted) break
      const operation = { arm, startedAt: new Date().toISOString(), modelCalls: [], submissions: [], accepted: false, failure: null, durationMs: 0 }
      report.operations.push(operation); await save()
      const started = performance.now()
      const profile = arm === 'baseline' ? defaultLessonModelProfile : candidate
      const armDefinition = arm === 'candidate' && options['candidate-tool'] ? { ...definition, toolName: options['candidate-tool'] } : definition
      const armContext = structuredClone(context)
      delete armContext.generationMode
      try {
        const result = await executeLessonStage({ provider, modelProfile: profile, signal: controller.signal,
          onSubmission: event => { operation.submissions.push(event) },
          transport: async request => {
            if (operation.modelCalls.length >= maximumDispatchesPerOperation) throw new InferenceFailure({
              category: 'budget_exhausted', layer: 'budget', retryable: false, stage: definition.id,
              message: 'Stage experiment reached its declared dispatch limit.' })
            const initial = operation.modelCalls.length === 0
            const shape = { user: request.messages.filter(m => m.role === 'user').at(-1)?.content, tools: request.tools,
              toolChoice: request.toolChoice, maxTokens: request.maxTokens, temperature: request.temperature, thinking: request.featherlessThinking }
            const normalized = options['candidate-tool'] && arm === 'candidate'
              ? JSON.parse(JSON.stringify(shape).replaceAll(options['candidate-tool'], definition.toolName)) : { ...shape }
            if (options['candidate-thinking'] && arm === 'candidate') normalized.thinking = invariantRequest?.thinking ?? false
            if (initial && invariantRequest && JSON.stringify(normalized) !== JSON.stringify(invariantRequest)) throw new Error('Experiment arms changed context, tool contract or generation settings beyond the declared tool name.')
            if (initial) invariantRequest = normalized
            const modelCall = { request: { messages: request.messages, tools: request.tools, toolChoice: request.toolChoice,
              maxTokens: request.maxTokens, temperature: request.temperature, featherlessThinking: request.featherlessThinking,
              generationTrace: request.generationTrace, contextBudget: request.contextBudget, toolResponseDialect: request.toolResponseDialect, responseMode: request.responseMode, normalizeParameterNameQuotes: request.normalizeParameterNameQuotes, allowAssistantPrefix: request.allowAssistantPrefix }, response: null, error: null, durationMs: 0 }
            operation.modelCalls.push(modelCall); await save()
            const calledAt = performance.now()
            try {
              const fixtureRequest = fixture && options['candidate-tool'] && arm === 'candidate' ? {
                ...request,
                messages: request.messages.map(message => ({ ...message, content: typeof message.content === 'string'
                  ? message.content.replaceAll(options['candidate-tool'], definition.toolName) : message.content })),
                tools: request.tools.map(tool => ({ ...tool, function: { ...tool.function, name: definition.toolName } })),
              } : request
              const rawResponse = await (live ? streamChat : lessonFixture)({ ...fixtureRequest,
                handlers: { ...fixtureRequest.handlers,
                  onDiagnostic: diagnostic => { modelCall.diagnostic = diagnostic; fixtureRequest.handlers?.onDiagnostic?.(diagnostic) },
                  onProviderError: error => { modelCall.providerError = error; fixtureRequest.handlers?.onProviderError?.(error) },
                },
                ...(live ? { fetcher: async (url, init) => {
                  modelCall.wireRequest = JSON.parse(String(init?.body))
                  modelCall.wireRequestHash = sha(JSON.stringify(modelCall.wireRequest))
                  const received = await fetch(url, init)
                  modelCall.httpStatus = received.status
                  return received
                } } : {}),
              })
              const response = fixtureRequest !== request ? { ...rawResponse, toolCalls: rawResponse.toolCalls.map(call => ({ ...call,
                function: { ...call.function, name: armDefinition.toolName } })) } : rawResponse
              const { reasoning: _reasoning, ...recorded } = response
              modelCall.response = recorded
              modelCall.protocolEnvelope = ['stop', 'tool_calls'].includes(response.finishReason) && response.toolCalls.length === 1 && response.toolCalls[0].function.name === armDefinition.toolName
              modelCall.nativeEnvelope = modelCall.protocolEnvelope && response.toolProtocol?.representation !== 'qwen_xml'
              if (modelCall.protocolEnvelope) {
                try { modelCall.schemaValid = armDefinition.schema(armContext).safeParse(JSON.parse(response.toolCalls[0].function.arguments)).success }
                catch { modelCall.schemaValid = false }
              } else modelCall.schemaValid = false
              return response
            } catch (error) { modelCall.error = redact(error?.message ?? error); modelCall.failure = classifyInferenceFailure(error, request.handlers?.signal).failure; throw error }
            finally { modelCall.durationMs = Math.round(performance.now() - calledAt); await save() }
          },
        }, armDefinition, armContext, validate)
        operation.accepted = true; operation.result = result
        if (expectedWaypointIds) operation.coverageMatch = JSON.stringify([...result.value.waypointIds].sort()) === JSON.stringify([...expectedWaypointIds].sort())
      } catch (error) { operation.failure = redact(error?.message ?? error); operation.failureDetail = classifyInferenceFailure(error, controller.signal).failure }
      finally { operation.durationMs = Math.round(performance.now() - started); await save() }
      console.log(JSON.stringify({ arm, accepted: operation.accepted, ...(expectedWaypointIds ? { coverageMatch: operation.coverageMatch ?? null } : {}), calls: operation.modelCalls.length, durationMs: operation.durationMs,
        failure: operation.failure }))
    }
    report.status = controller.signal.aborted ? 'interrupted' : 'complete'
    report.summary = Object.fromEntries(['baseline', 'candidate'].map(arm => {
      const rows = report.operations.filter(op => op.arm === arm)
      return [arm, { operations: rows.length, accepted: rows.filter(op => op.accepted).length,
        ...(expectedWaypointIds ? { coverageMatches: rows.filter(op => op.coverageMatch).length } : {}),
        nativeFirstCalls: rows.filter(op => op.modelCalls[0]?.nativeEnvelope).length,
        schemaFirstCalls: rows.filter(op => op.modelCalls[0]?.schemaValid).length,
        corrections: rows.reduce((n, op) => n + op.submissions.filter(event => event.submissionAttempt > 1).length, 0),
        dispatches: rows.reduce((n, op) => n + op.modelCalls.length, 0),
        requestRecoveryDispatches: rows.flatMap(op => op.modelCalls).filter(call => call.request.generationTrace.attempt.request > 1).length,
        capacityEvents: rows.flatMap(op => op.modelCalls).filter(call => call.failure && isProviderCapacity(call.failure)).length,
        reportedTokens: rows.some(op => op.modelCalls.some(call => call.response?.usage))
          ? rows.flatMap(op => op.modelCalls.map(call => call.response?.usage?.totalTokens)).reduce((sum, n) => sum + (n ?? 0), 0) : null,
        callsWithoutUsage: rows.flatMap(op => op.modelCalls).filter(call => !call.response?.usage).length }]
    }))
    await save()
    console.log(JSON.stringify({ status: report.status, summary: report.summary, out: resolve(options.out) }))
    if (report.status !== 'complete') process.exitCode = 1
  }
} finally {
  if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
  await output?.close(); await server.close()
}
