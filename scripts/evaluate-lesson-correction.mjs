import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer, loadEnv } from 'vite'

const options = {}, args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['from', 'profile', 'repeat', 'out', 'model', 'fault', 'history', 'trial', 'call', 'control', 'cue', 'candidate', 'repair-guidance-file', 'confirm-live', 'fixture'].includes(key) || key in options) throw new Error('Unknown or repeated option.')
  options[key] = ['confirm-live', 'fixture'].includes(key) ? true : args[++i]
  if (options[key] === undefined) throw new Error('Missing option value.')
}
const live = Boolean(options['confirm-live'])
if (!options.from || !options.profile || !options.out || live === Boolean(options.fixture) || live !== Boolean(options.model)) {
  throw new Error('Use --from TERMINAL_REPORT --profile PROFILE --out NEW.json [--fixture | --model MODEL --confirm-live] [--repeat 1..5] [--trial CASE/ARM/REPETITION] [--call 1..120 --control CASE (lesson report)] [--history fresh,replay] [--fault recorded|empty] [--cue original,explicit --repair-guidance-file FILE] [--candidate retain,omit-overlong].')
}
const repeat = Number(options.repeat ?? 1)
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error('Repeat must be one to five.')
const fault = options.fault ?? 'recorded'
if (!['recorded', 'empty'].includes(fault)) throw new Error('Fault must be recorded or empty.')
const histories = options.history?.split(',') ?? ['fresh']
if (!histories.length || new Set(histories).size !== histories.length || histories.some(h => !['fresh', 'replay'].includes(h))) throw new Error('History must list distinct fresh/replay arms.')
if (fault === 'empty' && histories.includes('replay')) throw new Error('Empty output must not be replayed.')
const cues = options.cue?.split(',') ?? ['original']
if (!cues.length || new Set(cues).size !== cues.length || cues.some(cue => !['original', 'explicit'].includes(cue))) throw new Error('Cue must list distinct original/explicit arms.')
const candidates = options.candidate?.split(',') ?? ['production']
if (!candidates.length || new Set(candidates).size !== candidates.length || candidates.some(candidate => !['production', 'retain', 'omit-overlong'].includes(candidate))) throw new Error('Candidate modes must be distinct production/retain/omit-overlong arms.')
if ([histories, cues, candidates].filter(values => values.length > 1).length > 1) throw new Error('Vary only one of history, correction cue or candidate projection.')
if (candidates.some(candidate => candidate !== 'production') && (histories.includes('replay') || fault !== 'recorded')) throw new Error('Candidate projection ablations require fresh history and a recorded rejected submission.')
if (cues.includes('explicit') !== Boolean(options['repair-guidance-file'])) throw new Error('Explicit cues require a repair-guidance file; original-only experiments omit it.')
const repairGuidance = options['repair-guidance-file'] ? (await readFile(resolve(options['repair-guidance-file']), 'utf8')).trim() : undefined
if (repairGuidance !== undefined && (!repairGuidance || repairGuidance.length > 2000)) throw new Error('Repair guidance must be nonempty and bounded to 2000 characters.')
const arms = histories.flatMap(history => cues.flatMap(cue => candidates.map(candidate => ({ history, cue, candidate }))))
const order = Array.from({ length: repeat }, (_, i) => (i % 2 ? [...arms].reverse() : arms)
  .map(arm => ({ repetition: i + 1, ...arm }))).flat()
const sha = text => createHash('sha256').update(text).digest('hex')
const sourceText = await readFile(resolve(options.from), 'utf8'), source = JSON.parse(sourceText)
if (!['visual-language-native-protocol-evaluation', 'visual-language-lessons-evaluation'].includes(source.format) || source.status !== 'finished') throw new Error('Select a finished protocol or lesson report.')
const selector = options.trial?.split('/')
if (selector && (selector.length !== 3 || !['baseline', 'candidate'].includes(selector[1]) || !/^[1-5]$/.test(selector[2]))) throw new Error('Trial must be CASE/ARM/REPETITION.')
let frozen
if (source.format === 'visual-language-lessons-evaluation') {
  const ordinal = Number(options.call)
  if (source.version !== 2 || !selector || selector[1] !== 'baseline' || !options.control || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > 120) {
    throw new Error('Lesson reports require v2, an exact CASE/baseline/REPETITION, --call 1..120 and --control CASE.')
  }
  const trials = source.results.filter(row => row.caseId === selector[0] && row.repetition === Number(selector[2]))
  if (trials.length !== 1) throw new Error('Select exactly one recorded lesson trial.')
  const call = trials[0].calls[ordinal - 1]
  if (!call?.failure || call.submissionAccepted !== false || call.repair) throw new Error('Select a rejected first submission, not a correction or accepted call.')
  const raw = call.response?.toolProtocol?.rawContent
  frozen = { caseId: options.control, sourceCaseId: trials[0].caseId, sourceCallOrdinal: ordinal,
    request: call.request, failure: call.failure, wireEvidence: { content: raw ?? call.wireContent?.text,
      contentTruncated: raw === undefined && Boolean(call.wireContent?.truncated) } }
} else {
  if (options.call || options.control) throw new Error('Call/control selectors are only for lesson reports.')
  const failed = source.results.filter(row => row.failure && !row.contractAccepted && (!selector ||
    row.caseId === selector[0] && (row.arm ?? 'baseline') === selector[1] && row.repetition === Number(selector[2])))
  if (failed.length !== 1) throw new Error('Select a report containing exactly one failed control.')
  frozen = failed[0]
}
const recordedContent = frozen.wireEvidence?.content
const expectedFailure = fault === 'empty' ? 'empty_output' : frozen.failure.category
if (!['empty_output', 'tool_missing', 'tool_unexpected', 'arguments_invalid', 'schema_invalid', 'constraints_invalid'].includes(expectedFailure)) throw new Error('Select a correctible submission failure, not a transport fault.')
if (!recordedContent || frozen.wireEvidence.contentTruncated) throw new Error('Complete recorded content is required.')
const content = fault === 'empty' ? '' : recordedContent
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
let output, interrupt
try {
  const { protocolCase, protocolFixture } = await server.ssrLoadModule('/tests/evaluation/native-protocol-controls.ts')
  const { lessonStages } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/stages.ts')
  const { executeLessonStage } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/executeStage.ts')
  const { lessonModelProfileSchema } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/modelProfiles.ts')
  const { streamChat } = await server.ssrLoadModule('/src/lib/ai/client.ts')
  const { classifyInferenceFailure } = await server.ssrLoadModule('/src/lib/ai/inferenceFailure.ts')
  const { providerDefaults } = await server.ssrLoadModule('/src/lib/settings.ts')
  const { correctionContext, correctionCue, correctionCandidate } = await server.ssrLoadModule('/tests/evaluation/correction-context.ts')
  const { parseToolContext } = await server.ssrLoadModule('/tests/fixtures/tool-context.ts')
  const control = protocolCase(frozen.caseId)
  const definition = Object.values(lessonStages).find(stage => stage.toolName === control.tool.function.name)
  if (!definition || !['buildQuestion', 'reviewQuestion', 'evaluateCoverage'].includes(definition.id)) throw new Error('Only question authoring, review and coverage correction are supported.')
  if (frozen.request.tools?.length !== 1 || frozen.request.tools[0].function.name !== definition.toolName) {
    throw new Error('The recorded request and correction control must offer the same single stage tool.')
  }
  const context = parseToolContext(frozen.request.messages.filter(m => m.role === 'user').at(-1).content)
  delete context.generationMode
  const expectedContext = parseToolContext(control.messages.filter(m => m.role === 'user').at(-1).content)
  delete expectedContext.generationMode
  if (JSON.stringify(context) !== JSON.stringify(expectedContext)) throw new Error('The named control must have exactly the recorded lesson projection; labels/validators cannot be transferred to another context.')
  const profile = lessonModelProfileSchema.parse(JSON.parse(await readFile(resolve(options.profile), 'utf8')))
  const key = live ? loadEnv('development', process.cwd(), '').FEATHERLESS_API_KEY?.trim() : undefined
  if (live && !key) throw new Error('Missing FEATHERLESS_API_KEY.')
  const provider = { ...providerDefaults.featherless, model: options.model ?? 'authored-correction-fixture', apiKey: key ?? 'fixture' }
  const controller = new AbortController()
  interrupt = () => controller.abort(new DOMException('Correction experiment interrupted', 'AbortError'))
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const files = ['scripts/evaluate-lesson-correction.mjs', 'tests/evaluation/native-protocol-controls.ts', 'src/lib/teacher/lessonGeneration/executeStage.ts',
    'src/lib/teacher/lessonGeneration/stages.ts', 'src/lib/domain/questionSolve.ts', 'src/lib/teacher/lessonGeneration/prompts.ts', 'src/lib/teacher/lessonGeneration/assemblePrompt.ts',
    'src/lib/teacher/toolPrompt.ts', 'src/lib/ai/client.ts', 'src/lib/ai/qwenToolProtocol.ts', 'src/lib/teacher/lessonGeneration/stageSubmission.ts']
  files.push('tests/evaluation/correction-context.ts', 'tests/fixtures/tool-context.ts', 'src/lib/ai/requestProtocol.ts', 'src/lib/ai/contextBudget.ts',
    'src/lib/ai/qwenToolEnvelope.ts',
    'src/lib/ai/requestRecovery.ts', 'src/lib/teacher/lessonGeneration/executionPolicy.ts', 'src/lib/teacher/lessonGeneration/modelProfiles.ts')
  const report = { format: 'visual-language-lesson-correction-control', version: 6, status: 'running', startedAt: new Date().toISOString(),
    source: { path: resolve(options.from), sha256: sha(sourceText), caseId: frozen.caseId,
      sourceCaseId: frozen.sourceCaseId ?? frozen.caseId, sourceCallOrdinal: frozen.sourceCallOrdinal ?? null,
      content: recordedContent, contextHash: sha(JSON.stringify(context)) },
    injectedFault: { kind: fault, content, expectedFailure, origin: fault === 'empty' ? 'authored_empty_output_control' : 'recorded_provider_content' },
    profile, profileHash: sha(JSON.stringify(profile)), provider: live ? 'featherless' : 'fixture', requestedModel: options.model ?? null,
    order, requestVariable: candidates.length > 1 ? 'Only presence of rejected overlong explanation fields; accepted state, history and guidance remain unchanged.'
      : cues.length > 1 ? 'Only explicit correction-footer guidance; both arms use the same history.'
        : histories.length > 1 ? 'Only failed assistant-history replay.' : 'One declared correction configuration, no paired ablation.',
    repairGuidance: repairGuidance ? { file: options['repair-guidance-file'], sha256: sha(repairGuidance), text: repairGuidance } : null,
    cueSemantics: 'original uses the current production correction; explicit replaces any owned production repair cue with experimental guidance.',
    candidateSemantics: 'production leaves the compiled request intact; retain restores only original rejected overlong explanations; omit-overlong removes only those fields.',
    executionPolicy: { submissionAttempts: 2, requestAttempts: 1 },
    plannedOperations: order.length, maximumLiveRequests: live ? order.length : 0, codeHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))]))),
    evidenceScope: 'An explicitly labeled recorded or authored failure is injected through the real response decoder; only the following correction is live. This does not measure new first-attempt reliability or independent teaching quality.',
    releaseReady: false, operations: [] }
  const path = resolve(options.out)
  if (!path.endsWith('.json')) throw new Error('Output must be a new JSON path.')
  await mkdir(dirname(path), { recursive: true }); output = await open(path, 'wx', 0o600)
  const save = async () => {
    let text = JSON.stringify(report, null, 2) + '\n'
    if (key) text = text.replaceAll(key, '[redacted]')
    await output.write(text, 0, 'utf8'); await output.truncate(Buffer.byteLength(text)); await output.sync()
  }
  await save()
  for (const { repetition, history, cue, candidate } of order) {
    if (controller.signal.aborted) break
    let initialMessages
    const operation = { repetition, history, cue, candidate, accepted: false, calls: [], submissions: [] }
    report.operations.push(operation); await save()
    try {
      const result = await executeLessonStage({ provider, modelProfile: profile, signal: controller.signal,
        executionPolicy: { submissionAttempts: 2, requestAttempts: 1 },
        onSubmission: async event => {
          operation.submissions.push(event)
          if (!event.accepted && event.failure) operation.calls.at(-1).failure = event.failure
          await save()
        },
        transport: async request => {
          const injected = operation.calls.length === 0
          if (injected) initialMessages = structuredClone(request.messages)
          const call = { source: injected ? fault === 'empty' ? 'authored_empty_output_injection' : 'recorded_failure_injection' : live ? 'live_provider' : 'authored_fixture',
            messages: request.messages, generationTrace: request.generationTrace, contextBudget: request.contextBudget, liveDispatched: false,
            tools: request.tools, toolChoice: request.toolChoice, maxTokens: request.maxTokens, temperature: request.temperature }
          operation.calls.push(call); await save()
          const started = performance.now()
          try {
            let compiled = injected ? request : await correctionContext(request, initialMessages, content, history)
            if (!injected && cue === 'explicit') compiled = await correctionCue(compiled, repairGuidance)
            if (!injected) {
              const rejectedCall = operation.calls[0]?.response?.toolCalls?.[0]
              compiled = await correctionCandidate(compiled, candidate, rejectedCall ? JSON.parse(rejectedCall.function.arguments) : undefined)
            }
            call.messages = compiled.messages; call.contextBudget = compiled.contextBudget
            const observed = { ...compiled, handlers: { ...compiled.handlers,
              onDiagnostic: diagnostic => { call.diagnostic = diagnostic; compiled.handlers?.onDiagnostic?.(diagnostic) } } }
            const result = injected ? await streamChat({ ...observed, responseMode: 'complete', fetcher: async () => Response.json({
              model: provider.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
            }) }) : await (live ? streamChat : protocolFixture)({ ...observed,
              ...(live ? { fetcher: async (url, init) => {
                call.wireRequest = JSON.parse(String(init?.body)); call.wireRequestHash = sha(JSON.stringify(call.wireRequest))
                call.liveDispatched = true; await save()
                return fetch(url, init)
              } } : {}) })
            const { reasoning: _reasoning, ...recorded } = result
            call.response = recorded
            return result
          } catch (error) { call.failure = classifyInferenceFailure(error, controller.signal).failure; throw error }
          finally { call.durationMs = Math.round(performance.now() - started); await save() }
        },
      }, definition, context, control.validate)
      operation.accepted = true; operation.result = result.value
      operation.expectedFieldsMatch = Object.keys(control.expected).length ? Object.entries(control.expected).every(([k, v]) => JSON.stringify(result.value[k]) === JSON.stringify(v)) : null
    } catch (error) { operation.failure = classifyInferenceFailure(error, controller.signal).failure }
    await save()
    operation.correctionAccepted = operation.accepted && operation.calls.length === 2 && operation.calls[0]?.failure?.category === expectedFailure
    await save()
    console.log(JSON.stringify({ repetition, history, cue, candidate, accepted: operation.accepted, correctionAccepted: operation.correctionAccepted,
      expectedFieldsMatch: operation.expectedFieldsMatch ?? null, liveRequests: operation.calls.filter(c => c.liveDispatched).length, failure: operation.failure?.category ?? null }))
  }
  report.status = controller.signal.aborted ? 'interrupted' : 'finished'
  const summarize = operations => {
    const corrections = operations.flatMap(o => o.calls.slice(1)), usages = corrections.flatMap(c =>
      c.response?.usage ?? c.diagnostic?.usage ? [c.response?.usage ?? c.diagnostic.usage] : [])
    return { operationsAttempted: operations.length, correctionsAccepted: operations.filter(o => o.correctionAccepted).length,
    expectedLabelsMatched: operations.filter(o => o.expectedFieldsMatch === true).length,
    declaredExpectations: Object.keys(control.expected).length ? operations.length : 0,
    injectedFailuresRejected: operations.filter(o => o.calls[0]?.failure?.category === expectedFailure).length,
    correctionResponsesReceived: corrections.filter(c => c.response).length,
    correctionDurationsMs: corrections.map(c => c.durationMs),
    correctionUsage: { reportingCalls: usages.length, unknownCalls: corrections.length - usages.length,
      totalTokens: usages.length ? usages.reduce((sum, u) => sum + u.totalTokens, 0) : null },
    liveRequests: operations.flatMap(o => o.calls).filter(c => c.liveDispatched).length }
  }
  report.summary = { ...summarize(report.operations), arms: arms.map(({ history, cue, candidate }) => ({ history, cue, candidate,
    ...summarize(report.operations.filter(o => o.history === history && o.cue === cue && o.candidate === candidate)) })) }
  report.finishedAt = new Date().toISOString(); await save()
  process.exitCode = report.status === 'finished' && report.operations.length === order.length && report.operations.every(o => o.correctionAccepted && o.expectedFieldsMatch !== false) ? 0 : 1
} finally {
  if (interrupt) { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
  await output?.close(); await server.close()
}
