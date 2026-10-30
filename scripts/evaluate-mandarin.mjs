import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer, loadEnv } from 'vite'

// No live calls by default. Test tooling is outside the browser build; it cannot
// read a user's workspace, write their progress or establish deployed CORS.
const args = process.argv.slice(2), options = {}, boolean = new Set(['fixture', 'confirm-live', 'help'])
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['fixture', 'confirm-live', 'help', 'provider', 'model', 'case', 'repeat', 'out', 'suite', 'thinking', 'token-counter', 'lesson-profile', 'resume-from', 'resume-trial', 'entry'].includes(key) || key in options) throw new Error('Unknown or repeated evaluation option. Use --help.')
  options[key] = boolean.has(key) ? true : args[++i]
  if (options[key] === undefined || (typeof options[key] === 'string' && options[key].startsWith('--'))) throw new Error('An evaluation option needs a value.')
}
const suite = options.suite ?? 'mandarin'
if (options.entry && (suite !== 'lessons' || !['raw', 'authored'].includes(options.entry))) throw new Error('--entry raw|authored requires the lessons suite.')
if (!['mandarin', 'lessons'].includes(suite)) throw new Error('Suite must be mandarin or lessons.')
if (options.help) {
  console.log(`npm run eval:${suite} -- [--fixture | --provider featherless|nebius|alibaba|minimax|openrouter --model MODEL --confirm-live] [--case ID,ID] [--entry raw|authored (lessons only)] [--repeat 1..3] [--out FILE] [--resume-from TERMINAL_REPORT --resume-trial CASE_ID/rN (lessons, repeat 1)] [--thinking on|off|coverage (Featherless lessons only)] [--lesson-profile FILE (lessons only)] [--token-counter featherless (live lessons only)]\nWithout a run mode, validates/lists cases with zero API calls. Fixtures are not model accuracy. Live mode uses the matching local testing key and fixed provider endpoint; no provider fallback. New output files only.`)
  process.exit(0)
}
if (options.thinking !== undefined && (!['on', 'off', 'coverage'].includes(options.thinking) || suite !== 'lessons' || options.provider !== 'featherless' || !options['confirm-live'])) throw new Error('Thinking overrides require a live Featherless lesson run and on|off|coverage.')
if (options['token-counter'] && (options['token-counter'] !== 'featherless' || suite !== 'lessons' || options.provider !== 'featherless' || !options['confirm-live'])) throw new Error('Exact token counting requires a live Featherless lesson run.')
if (options['lesson-profile'] && suite !== 'lessons') throw new Error('Lesson profiles require the lessons suite.')
if (options.fixture && (options.provider || options.model || options['confirm-live'])) throw new Error('Fixture and live options cannot be mixed.')
if (options['confirm-live'] && !options.provider) throw new Error('Choose a provider before confirming live calls.')
if (options.model && !options.provider) throw new Error('A model needs an explicit provider.')
if (Boolean(options['resume-from']) !== Boolean(options['resume-trial']) || options['resume-from'] && suite !== 'lessons') throw new Error('Resume requires both --resume-from and --resume-trial in the lessons suite.')
const repetitions = Number(options.repeat ?? 1)
if (options['resume-from'] && repetitions !== 1) throw new Error('Recorded resume is one recovery trial, not a repeated fresh matrix.')
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Repeat must be between 1 and 3.')
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, define: { __VL_TEST_KEYS__: '{}' } })
let output, outputPath, signalHandler, failureCheckpoint
try {
  const runner = await server.ssrLoadModule(`/tests/evaluation/${suite === 'lessons' ? 'lesson' : 'mandarin'}-runner.ts`)
  let lessonModelProfile
  if (options['lesson-profile']) {
    const { lessonModelProfileSchema } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/modelProfiles.ts')
    lessonModelProfile = lessonModelProfileSchema.parse(JSON.parse(await readFile(resolve(options['lesson-profile']), 'utf8')))
  }
  const corpus = suite === 'lessons' ? options.entry === 'raw' ? runner.rawLessonCases : runner.lessonCases : runner.mandarinCases
  runner.validateCorpus()
  let resume, resumeMetadata, combineLessonResume
  if (options['resume-from']) {
    const sourceText = await readFile(resolve(options['resume-from']), 'utf8'), source = JSON.parse(sourceText)
    const helpers = await server.ssrLoadModule('/tests/evaluation/lesson-resume-source.ts')
    resume = helpers.lessonResumeSource(source, options['resume-trial'], corpus)
    combineLessonResume = helpers.combineLessonResume
    resumeMetadata = { sourceReport: resolve(options['resume-from']), sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
      originalCaseId: resume.entry.id, originalRepetition: resume.originalRepetition, originalFailure: resume.trial.failure,
      originalCodeHashes: source.codeHashes, originalRequestCount: resume.trial.calls.length, originalDurationMs: resume.trial.durationMs,
      originalProvider: source.requestedProvider, originalModel: source.requestedModel,
      accounting: 'Request outcomes and usage include original plus resumed attempts. Live dispatches count only this run. Original failed report remains unchanged.' }
    if (options.case && options.case !== resume.entry.id) throw new Error('Resume case selector must match its recorded trial.')
  }
  const ids = options.case?.split(',') ?? (resume ? [resume.entry.id] : undefined)
  if (ids && (new Set(ids).size !== ids.length || ids.some(id => !corpus.some(entry => entry.id === id)))) throw new Error('Case IDs must be known and unique; list cases without a run mode.')
  const cases = ids ? ids.map(id => corpus.find(entry => entry.id === id)) : corpus
  const evaluationMaxCalls = options.entry === 'raw' ? runner.rawLessonEvaluationPolicy.evaluation.maxRequests : runner.MAX_CALLS
  const planned = cases.length * repetitions, possibleCalls = suite === 'lessons' ? (resume ? runner.MAX_CALLS - resume.trial.calls.length : planned * evaluationMaxCalls) : cases.filter(entry => entry.question.answerPolicy === 'contextual').length * repetitions * 2
  if (!options.fixture && !options.provider) {
    if (options.out) throw new Error('Output is for an explicit fixture or live run, not a catalogue.')
    console.log(JSON.stringify({ corpusVersion: runner.CORPUS_VERSION, counts: runner.validateCorpus(cases), repetitions, maximumLiveModelCalls: possibleCalls, callsMade: 0,
      annotations: 'Project-authored provisional cases, not a linguist-certified benchmark.', candidateModels: runner.candidateModels, modelMatrix: runner.modelMatrix, cases: cases.map(entry => suite === 'lessons' ? { id: entry.id, kind: entry.kind, settings: entry.settings } : { id: entry.id, tags: entry.tags, answerPolicy: entry.question.answerPolicy }) }, null, 2))
  } else {
    let config = { mode: 'fixture' }
    if (!options.fixture) {
      const { evaluationProviders, evaluationApiKey } = await server.ssrLoadModule('/tests/evaluation/model-matrix.ts')
      if (!evaluationProviders.includes(options.provider) || !options.model?.trim() || !options['confirm-live']) throw new Error(`Live runs require --provider ${evaluationProviders.join('|')}, --model and --confirm-live. No calls made.`)
      const env = loadEnv('development', process.cwd(), ''), apiKey = evaluationApiKey(options.provider, env)
      if (!apiKey) throw new Error(`Missing testing key for ${options.provider}. No calls made; no fallback provider is used.`)
      config = { mode: 'live', provider: options.provider, model: options.model.trim(), apiKey, confirmed: true, ...(options.thinking ? { featherlessThinking: options.thinking === 'coverage' ? 'coverage' : options.thinking === 'on' } : {}) }
    }
    if (resume && config.mode === 'live' && (config.provider !== resumeMetadata.originalProvider || config.model !== resumeMetadata.originalModel)) throw new Error('Controlled live resume must retain the recorded provider and model.')
    if (lessonModelProfile) config.lessonModelProfile = lessonModelProfile
    if (options['token-counter']) config.tokenCounter = options['token-counter']
    const codeFiles = ['src/lib/teacher/teacherService.ts', 'src/lib/teacher/feedback.ts', 'src/lib/teacher/contracts.ts', 'src/lib/teacher/teacherContext.ts', 'src/lib/learning/assessment.ts', 'src/lib/learning/learningService.ts', 'src/lib/learning/leitner.ts', 'src/lib/domain/learning.ts', 'src/lib/ai/client.ts', 'src/lib/ai/generationBudget.ts', 'src/lib/ai/tools.ts', 'src/lib/domain/validation.ts', 'tests/evaluation/mandarin-runner.ts', ...(suite === 'lessons' ? ['tests/evaluation/lesson-runner.ts', 'tests/evaluation/lesson-reference-seed.ts', 'tests/evaluation/lesson-corpus.ts', 'tests/fixtures/topic-lesson.ts', 'tests/fixtures/tool-context.ts', 'src/lib/teacher/lessonPrompts.ts', 'src/lib/learning/sourceExcerpt.ts', 'src/lib/teacher/quizReview.ts', 'src/lib/teacher/discoveryService.ts', 'src/lib/learning/quiz.ts', 'src/lib/learning/lessonProgress.ts', 'src/lib/domain/lessonPlan.ts', 'src/lib/domain/lessonPreparation.ts', 'src/lib/domain/questionSolve.ts', 'src/lib/domain/coverageEvidence.ts', 'src/lib/domain/blindQuestion.ts', 'src/lib/domain/lessonSettings.ts', 'src/lib/domain/lessonGraph.ts', 'src/lib/teacher/lessonGeneration/workflow.ts', 'src/lib/teacher/lessonGeneration/executeStage.ts', 'src/lib/teacher/lessonGeneration/prompts.ts', 'src/lib/teacher/lessonGeneration/definitions.ts', 'src/lib/teacher/lessonGeneration/stages.ts', 'src/lib/teacher/lessonGeneration/modelProfiles.ts', 'src/lib/teacher/lessonGeneration/assemblePrompt.ts', 'src/lib/ai/lessonGenerationAdapter.ts', 'src/lib/teacher/toolPrompt.ts', 'src/lib/teacher/lessonGraphTools.ts', 'src/lib/teacher/questionGapTools.ts', 'src/lib/learning/waypointQuestion.ts', 'src/lib/ai/types.ts', 'src/lib/settings.ts'] : []), 'scripts/evaluate-mandarin.mjs']
    codeFiles.push('src/lib/teacher/lessonGeneration/sourcePreparation.ts', 'src/lib/domain/discovery.ts', 'tests/fixtures/lesson-source.ts', 'src/lib/teacher/lessonGeneration/teachingExamples.ts', 'src/lib/teacher/lessonGeneration/planningExamples.ts', 'tests/evaluation/model-matrix.ts', 'src/lib/ai/providers.ts', 'src/lib/ai/chatRequest.ts', 'src/lib/ai/completionEvent.ts', 'src/lib/ai/inferenceFailure.ts', 'src/lib/ai/providerDiagnostics.ts',
      'src/lib/ai/requestProtocol.ts', 'src/lib/ai/requestRecovery.ts', 'src/lib/ai/contextBudget.ts', 'src/lib/ai/featherlessTokenCounter.ts', 'src/lib/ai/generationBudget.ts', 'src/lib/ai/qwenToolProtocol.ts', 'src/lib/teacher/lessonGeneration/graphConstruction.ts', 'src/lib/teacher/lessonGeneration/checkpoint.ts', 'src/lib/teacher/lessonGeneration/assessmentPlan.ts', 'src/lib/teacher/lessonGeneration/workflowBudget.ts')
    if (suite === 'lessons') codeFiles.push('src/lib/teacher/lessonGeneration/executionPolicy.ts', 'src/lib/teacher/lessonGeneration/stageSubmission.ts')
    if (suite === 'lessons') codeFiles.push('src/lib/teacher/lessonGeneration/profiles/nemotron-lightning-v2.json', 'src/lib/ai/modelIdentity.ts', 'src/lib/teacher/lessonGeneration/providerProtocol.ts')
    codeFiles.push('src/lib/ai/qwenToolEnvelope.ts')
    codeFiles.push('src/lib/ai/http.ts', 'src/lib/ai/requestQueue.ts')
    if (suite === 'lessons') codeFiles.push('tests/evaluation/provider-capacity.ts', 'tests/evaluation/request-failure.ts')
    if (suite === 'lessons') codeFiles.push('src/lib/teacher/lessonGeneration/quizReplanning.ts', 'src/lib/teacher/lessonGeneration/coverageContext.ts', 'src/lib/teacher/lessonGeneration/profiles/qwen-v7.json', 'src/lib/teacher/lessonGeneration/profiles/glm-native-v2.json')
    if (resume) codeFiles.push('tests/evaluation/lesson-resume-source.ts')
    const codeHashes = Object.fromEntries(await Promise.all(codeFiles.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
    outputPath = resolve(options.out ?? `eval-results/${suite}-${config.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await mkdir(dirname(outputPath), { recursive: true })
    output = await open(outputPath, 'wx', 0o600) // Fail on an existing report before any paid calls.
    let activeCase
    const controller = new AbortController(), results = [], startedAt = new Date().toISOString()
    signalHandler = () => controller.abort(new DOMException('Evaluation interrupted', 'AbortError'))
    process.on('SIGINT', signalHandler); process.on('SIGTERM', signalHandler)
    const corpusHash = await runner.digest(JSON.stringify({ version: runner.CORPUS_VERSION, references: runner.references, cases: corpus }))
    const summarize = () => {
      const summary = runner.summarize(results, config, planned)
      if (resume && results.length) {
        const original = resume.trial.calls.length
        summary.transportCalls -= original
        if (config.mode === 'live') summary.liveModelCalls -= original
        summary.recordedOriginalRequests = original
        summary.resumedRequests = results[0].calls.length - original
      }
      return summary
    }
    const checkpoint = async (status, setupFailure) => {
      const report = { format: `visual-language-${suite}-evaluation`, version: suite === 'lessons' ? 2 : 1, status, startedAt, updatedAt: new Date().toISOString(),
        corpusVersion: runner.CORPUS_VERSION, entryPoint: options.entry === 'raw' ? 'raw-request' : 'authored-targets', corpusHash, codeHashes, selectedCaseIds: cases.map(entry => entry.id), fullCorpusSelected: cases.length === corpus.length, repetitions,
        lessonModelProfile: lessonModelProfile ?? null, requestedTokenCounter: options['token-counter'] ?? 'tiktoken_estimate', requestedThinking: options.thinking ?? 'application-default', requestedProvider: config.mode === 'live' ? config.provider : null, requestedModel: config.mode === 'live' ? config.model : null,
        runtime: { node: process.version, storage: 'isolated in-memory IndexedDB', browserCorsVerified: false,
          ...(suite === 'lessons' ? { generationPolicy: options.entry === 'raw' ? runner.rawLessonEvaluationPolicy : runner.lessonEvaluationPolicy } : {}) },
        maximumLiveModelCalls: config.mode === 'live' ? possibleCalls : 0, transportCallLimit: possibleCalls, summary: summarize(), ...(resumeMetadata ? { resumeSource: resumeMetadata } : {}), results, ...(activeCase ? { activeCase } : {}), ...(setupFailure ? { setupFailure } : {}) }
      const text = JSON.stringify(runner.redact(report, config.mode === 'live' ? [config.apiKey] : []), null, 2) + '\n'
      // Only this newly reserved report is updated; an interrupted write may be
      // incomplete evidence, never a learner backup or a successful acceptance run.
      await output.write(text, 0, 'utf8'); await output.truncate(Buffer.byteLength(text)); await output.sync()
    }
    failureCheckpoint = message => checkpoint('failed', { stage: 'evaluation-setup', message, retryable: false })
    await checkpoint('running')
    console.log(`${config.mode === 'fixture' ? 'Authored fixture contract run (zero live calls)' : `LIVE server-side ${suite} run (at most ${possibleCalls} model calls)`}: ${planned} cases. Report: ${outputPath}`)
    for (let repetition = 1; repetition <= repetitions && !controller.signal.aborted; repetition++) for (const entry of cases) {
      if (controller.signal.aborted) break
      activeCase = suite === 'lessons' ? { caseId: entry.id, repetition, calls: [] } : undefined
      let result = await runner.runCase(entry, config, controller.signal, undefined, suite === 'lessons' ? async call => {
        activeCase.calls.push(call); await checkpoint('running')
        console.log(`${entry.id}: ${call.mode} ${call.parsedResponseReceived ? 'parsed response received' : 'no parsed response'} (${call.durationMs} ms)`)
      } : undefined, suite === 'lessons' ? async call => {
        const index = activeCase.calls.findLastIndex(saved => saved.requestHash === call.requestHash)
        if (index >= 0) activeCase.calls[index] = call
        await checkpoint('running')
      } : undefined, resume?.artifacts)
      if (resume) result = combineLessonResume(resume.trial, result)
      activeCase = undefined
      results.push({ ...result, repetition }); await checkpoint(controller.signal.aborted ? 'interrupted' : 'running')
      console.log(suite === 'lessons' ? `${entry.id} [${repetition}]: ${result.failure ? result.failure.message : result.scriptedPlaybackCompleted ? 'prepared and exercised' : 'incomplete'} (${result.calls.length} calls)` : `${entry.id} [${repetition}]: ${result.serviceFailed ? 'service error' : result.actual?.grade} / expected ${entry.expected.grade}; schedule ${result.scheduleInvariant ? 'preserved' : 'MISMATCH'}`)
    }
    await checkpoint(controller.signal.aborted ? 'interrupted' : 'finished')
    const summary = summarize()
    console.log(JSON.stringify(summary, null, 2))
    const passed = suite === 'lessons'
      ? summary.allTrialsFinished && summary.lessonsReady === planned && summary.scriptedPlaybackCompleted === planned && !summary.failed.length
      : summary.complete && summary.all.gradeAgreement === planned && summary.all.criterionAgreement === planned
    process.exitCode = controller.signal.aborted ? 130 : passed && !summary.invariantFailures.length ? 0 : 1
  }
} catch (error) {
  // Validation messages are authored here; arbitrary transport responses never
  // reach this handler (the runner records only generic service failure).
  console.error(error instanceof Error ? error.message : 'Evaluation did not complete.')
  if (failureCheckpoint) await failureCheckpoint(error instanceof Error ? error.message : 'Evaluation did not complete.')
  process.exitCode = 1
} finally {
  if (signalHandler) { process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler) }
  await output?.close(); await server.close()
}
