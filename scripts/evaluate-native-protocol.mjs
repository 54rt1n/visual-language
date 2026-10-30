import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer, loadEnv } from 'vite'

const args = process.argv.slice(2), options = {}, flags = new Set(['fixture', 'confirm-live', 'help', 'allow-assistant-prefix', 'normalize-function-opening'])
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['provider', 'model', 'cases', 'response-mode', 'tool-choice', 'tool-dialect', 'footer-format', 'name-normalization', 'guidance-file', 'candidate-guidance-file', 'candidate-guidance-mode', 'candidate-description-file', 'thinking', 'repeat', 'out', ...flags].includes(key) || key in options) throw new Error('Unknown or repeated protocol option. Use --help.')
  options[key] = flags.has(key) ? true : args[++i]
  if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error('Missing protocol option value.')
}
if (options.help) {
  console.log('--candidate-description-file MANIFEST.json compares one existing field description against its declared baseline, with all cases preflighted before dispatch. Mutually exclusive with --candidate-guidance-file.')
  console.log('npm run eval:native-protocol -- [--fixture | --provider featherless --model MODEL --confirm-live] [--cases probe,waypoint-schema,graph-schema,waypoint-stage,graph-stage] [--response-mode stream,complete] [--tool-choice named,required,auto] [--tool-dialect native,qwen_xml] [--footer-format original,native,qwen_xml] [--name-normalization strict,quote] [--guidance-file FILE.txt[,FILE.txt...]] [--candidate-guidance-file FILE.txt] [--candidate-guidance-mode append|replace] [--allow-assistant-prefix] [--normalize-function-opening] [--thinking off,on] [--repeat 1..5] [--out NEW.json]\nNo mode previews zero calls. Default: probe, both response modes, named tool choice, thinking off, one repetition per condition. Up to three baseline guidance files compose in order. Candidate guidance creates counterbalanced baseline/candidate arms; append is default, replace substitutes the full guidance text. Maximum 120 first-attempt requests; controls never retry.')
  process.exit(0)
}
if (options.fixture && (options.provider || options.model || options['confirm-live'])) throw new Error('Choose fixture or live protocol mode.')
const live = Boolean(options['confirm-live']), fixture = Boolean(options.fixture), active = live || fixture
if (live && (options.provider !== 'featherless' || !options.model?.trim())) throw new Error('Live protocol controls require Featherless and an explicit model.')
if (!live && (options.provider || options.model)) throw new Error('Specify --confirm-live to use a provider/model.')
if (Boolean(options.out) !== active) throw new Error('An active run needs a new output path; preview has no output file.')
const repetitions = Number(options.repeat ?? 1)
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Repeat must be between one and five.')
function choices(value, defaults, allowed) {
  const selected = value?.split(',') ?? defaults
  if (new Set(selected).size !== selected.length || selected.some(item => !allowed.includes(item))) throw new Error('Protocol factors must be known and distinct.')
  return selected
}
const modes = choices(options['response-mode'], ['stream', 'complete'], ['stream', 'complete'])
const toolChoices = choices(options['tool-choice'], ['named'], ['named', 'required', 'auto'])
const thinking = choices(options.thinking, ['off'], ['off', 'on'])
const dialects = choices(options['tool-dialect'], ['native'], ['native', 'qwen_xml'])
const footers = choices(options['footer-format'], ['original'], ['original', 'native', 'qwen_xml'])
const normalizations = choices(options['name-normalization'], ['strict'], ['strict', 'quote'])
const guidanceFiles = options['guidance-file']?.split(',') ?? []
if (guidanceFiles.length > 3 || new Set(guidanceFiles).size !== guidanceFiles.length || guidanceFiles.some(file => !file.trim())) throw new Error('Select at most three distinct guidance files.')
const guidanceParts = await Promise.all(guidanceFiles.map(async file => (await readFile(resolve(file), 'utf8')).trim()))
if (guidanceParts.some(text => !text)) throw new Error('Guidance files must not be empty.')
const guidance = guidanceParts.length ? guidanceParts.join('\n\n') : undefined
const candidateGuidance = options['candidate-guidance-file'] ? (await readFile(resolve(options['candidate-guidance-file']), 'utf8')).trim() : undefined
const candidateGuidanceMode = options['candidate-guidance-mode'] ?? 'append'
if (!['append', 'replace'].includes(candidateGuidanceMode) || options['candidate-guidance-mode'] && candidateGuidance === undefined) throw new Error('Candidate guidance mode must be append or replace and needs a candidate guidance file.')
const candidateArmGuidance = candidateGuidance === undefined ? undefined : candidateGuidanceMode === 'replace'
  ? candidateGuidance : [guidance, candidateGuidance].filter(Boolean).join('\n\n')
if (candidateArmGuidance !== undefined && (!candidateArmGuidance || candidateArmGuidance.length > 4000)) throw new Error('Candidate arm guidance must contain one to 4000 characters.')
if (options['candidate-description-file'] && candidateGuidance) throw new Error('Compare one guidance or field-description factor at a time.')
const descriptionSource = options['candidate-description-file'] ? await readFile(resolve(options['candidate-description-file']), 'utf8') : undefined
const fieldDescription = descriptionSource ? JSON.parse(descriptionSource) : undefined
if (fieldDescription && (!/^[_a-z][_a-zA-Z0-9]*$/.test(fieldDescription.field) || typeof fieldDescription.baselineDescription !== 'string'
  || typeof fieldDescription.candidateDescription !== 'string' || !fieldDescription.candidateDescription.trim() || fieldDescription.candidateDescription.length > 1000)) throw new Error('A description experiment requires one known field and bounded baseline/candidate descriptions.')
const arms = candidateGuidance || fieldDescription ? ['baseline', 'candidate'] : ['baseline']
if (guidance !== undefined && (!guidance.length || guidance.length > 4000)) throw new Error('Guidance must contain one to 4000 characters.')
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
let output, interrupt
try {
  const { protocolCaseIds, protocolCase, runProtocolControl, protocolFixture, summarizeProtocolControls } = await server.ssrLoadModule('/tests/evaluation/native-protocol-controls.ts')
  const { providerDefaults } = await server.ssrLoadModule('/src/lib/settings.ts')
  const { LESSON_WORKFLOW_VERSION, LESSON_PROMPT_VERSION } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/stages.ts')
  const selected = choices(options.cases, ['probe'], protocolCaseIds)
  if (fieldDescription) for (const id of selected) {
    const properties = protocolCase(id).tool.function.parameters.properties
    if (properties?.[fieldDescription.field]?.description !== fieldDescription.baselineDescription) throw new Error('Field-description experiment does not match every selected case; no requests dispatched.')
  }
  const planned = selected.length * modes.length * toolChoices.length * thinking.length * dialects.length * footers.length * normalizations.length * repetitions * arms.length
  if (planned > 120) throw new Error('Reduce factors or repetitions to at most 120 first-attempt requests.')
  const key = live ? loadEnv('development', process.cwd(), '').FEATHERLESS_API_KEY?.trim() : undefined
  if (live && !key) throw new Error('Missing FEATHERLESS_API_KEY.')
  const provider = { ...providerDefaults.featherless, model: options.model ?? 'authored-protocol-fixture', apiKey: key ?? 'fixture' }
  const hashes = ['scripts/evaluate-native-protocol.mjs', 'tests/evaluation/native-protocol-controls.ts', 'src/lib/ai/client.ts',
    'src/lib/ai/chatRequest.ts', 'src/lib/ai/completionEvent.ts', 'src/lib/ai/requestProtocol.ts', 'src/lib/ai/providerDiagnostics.ts', 'src/lib/ai/qwenToolProtocol.ts',
    'src/lib/ai/inferenceFailure.ts', 'src/lib/teacher/lessonGeneration/stageSubmission.ts', 'src/lib/teacher/lessonGeneration/stages.ts', 'src/lib/domain/questionSolve.ts',
    'src/lib/teacher/lessonGeneration/prompts.ts', 'src/lib/teacher/lessonGeneration/assemblePrompt.ts', 'src/lib/teacher/toolPrompt.ts',
    'tests/evaluation/focused-cases/review-graph-qwen27b.json', 'tests/evaluation/focused-cases/review-waypoint-qwen-flash.json']
  hashes.push('tests/evaluation/focused-cases/build-waypoint-qwen27b-quoted-tags.json')
  hashes.push('tests/evaluation/focused-cases/build-question-qwen27b.json', 'tests/evaluation/focused-cases/coverage-phrase-specific.json')
  hashes.push('tests/evaluation/focused-cases/review-question-novelty-qwen27b.json')
  hashes.push('tests/evaluation/focused-cases/question-review-reason-length-qwen27b.json',
    'tests/evaluation/focused-cases/reading-english-leak-qwen27b.json', 'tests/evaluation/focused-cases/coverage-assessment-length-qwen27b.json')
  hashes.push('src/lib/domain/coverageEvidence.ts', 'tests/evaluation/focused-cases/coverage-situation-overcredit-qwen27b.json')
  hashes.push('src/lib/ai/qwenToolEnvelope.ts')
  hashes.push('src/lib/learning/waypointQuestion.ts', 'src/lib/learning/quiz.ts', 'src/lib/learning/sourceExcerpt.ts')
  hashes.push('tests/evaluation/focused-cases/transfer-meaning-drift-qwen27b.json')
  hashes.push('tests/evaluation/focused-cases/question-tool-format-qwen27b.json')
  hashes.push('tests/evaluation/focused-cases/english-stem-placement-qwen27b.json')
  hashes.push('tests/evaluation/focused-cases/review-reply-intent-qwen27b.json', 'tests/evaluation/focused-cases/coverage-reviewed-reply-eligibility-qwen27b.json', 'tests/evaluation/focused-cases/review-clause-joining-qwen27b.json', 'tests/evaluation/focused-cases/review-single-request-qwen27b.json', 'src/lib/domain/blindQuestion.ts', 'tests/evaluation/blind-question-view.ts', 'tests/evaluation/focused-cases/coverage-repair-echo-p12.json',
    'tests/evaluation/focused-cases/question-review-repair-p12.json')
  hashes.push('src/lib/teacher/lessonGeneration/coverageContext.ts', 'tests/evaluation/protocol-control-summary.ts', 'tests/fixtures/tool-context.ts', 'src/lib/teacher/lessonGeneration/profiles/qwen-v7.json', 'src/lib/teacher/lessonGeneration/providerProtocol.ts', 'src/lib/ai/modelIdentity.ts')
  hashes.push('tests/evaluation/focused-cases/question-review-reading-presentation-flashnext.json')
  hashes.push('tests/evaluation/focused-cases/question-plan-fresh-application-qwen27b.json')
  hashes.push('tests/evaluation/focused-cases/question-plan-reading-presentation-flashnext.json')
  hashes.push('tests/evaluation/focused-cases/question-build-reading-presentation-qwen27b.json')
  hashes.push('tests/evaluation/focused-cases/review-neutral-stem-reuse-qwen27b.json')
  hashes.push('tests/evaluation/focused-cases/question-authoring-transfer-v1.json', 'src/lib/domain/lessonGraph.ts',
    'src/lib/domain/lessonSettings.ts', 'src/lib/teacher/lessonGeneration/definitions.ts')
  const sha = value => createHash('sha256').update(value).digest('hex')
  const report = { format: 'visual-language-native-protocol-evaluation', version: 3, status: active ? 'running' : 'preview',
    startedAt: new Date().toISOString(), provider: live ? 'featherless' : fixture ? 'fixture' : null,
    requestedModel: options.model ?? null, workflowVersion: LESSON_WORKFLOW_VERSION, promptVersion: LESSON_PROMPT_VERSION,
    factors: { cases: selected, responseModes: modes, toolChoices, toolDialects: dialects, footerFormats: footers, parameterNameNormalizations: normalizations, thinking, repetitions,
      arms, armOrder: 'AB on odd repetitions, BA on even repetitions, per frozen case/factor combination',
      allowAssistantPrefix: Boolean(options['allow-assistant-prefix']),
      normalizeFunctionOpening: Boolean(options['normalize-function-opening']),
      candidateGuidanceMode,
      candidateGuidance: candidateGuidance ? { file: options['candidate-guidance-file'], sha256: sha(candidateGuidance), text: candidateGuidance } : null,
      candidateFieldDescription: fieldDescription ? { file: options['candidate-description-file'], sha256: sha(descriptionSource), field: fieldDescription.field,
        baselineDescription: fieldDescription.baselineDescription, candidateDescription: fieldDescription.candidateDescription } : null,
      guidance: guidance ? { file: options['guidance-file'], files: guidanceFiles.map((file, index) => ({ file, sha256: sha(guidanceParts[index]) })),
        sha256: sha(guidance), text: guidance } : null }, plannedRequests: planned,
    maximumLiveRequests: live ? planned : 0, retryPolicy: 'none_first_attempt_controls', results: [], summary: null,
    codeHashes: Object.fromEntries(await Promise.all(hashes.map(async file => [file, sha(await readFile(file))]))),
    semanticScope: 'Native envelope/schema and declared field agreement only. No teaching-quality approval.', releaseReady: false }
  const save = async () => {
    if (!output) return
    const body = (key ? JSON.stringify(report, null, 2).replaceAll(key, '[redacted]') : JSON.stringify(report, null, 2)) + '\n'
    await output.write(body, 0, 'utf8'); await output.truncate(Buffer.byteLength(body)); await output.sync()
  }
  if (active) {
    const path = resolve(options.out)
    if (!path.endsWith('.json')) throw new Error('Output must be a new JSON report.')
    await mkdir(dirname(path), { recursive: true }); output = await open(path, 'wx', 0o600)
  }
  await save()
  console.log(JSON.stringify({ status: report.status, plannedRequests: planned, maximumLiveRequests: report.maximumLiveRequests, factors: report.factors }))
  if (active) {
    const controller = new AbortController()
    interrupt = () => controller.abort(new DOMException('Protocol evaluation interrupted', 'AbortError'))
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
    outer: for (let repetition = 1; repetition <= repetitions; repetition++) for (const id of selected)
      for (const mode of modes) for (const toolChoice of toolChoices) for (const reason of thinking) for (const dialect of dialects) for (const footer of footers) for (const normalization of normalizations)
      for (const arm of (repetition % 2 ? arms : [...arms].reverse())) {
        if (controller.signal.aborted) break outer
        const result = await runProtocolControl(id, { provider, responseMode: mode, toolChoice, toolResponseDialect: dialect,
          modelGuidance: (arm === 'candidate' && candidateGuidance !== undefined ? candidateArmGuidance : guidance) || undefined,
          ...(arm === 'candidate' && fieldDescription ? { fieldDescription } : {}),
          allowAssistantPrefix: Boolean(options['allow-assistant-prefix']), normalizeParameterNameQuotes: normalization === 'quote', footerFormat: footer === 'original' ? undefined : footer, thinking: reason === 'on',
          normalizeFunctionOpening: Boolean(options['normalize-function-opening']),
          signal: controller.signal, ...(fixture ? { transport: protocolFixture } : {}) })
        report.results.push({ ...result, repetition, arm }); await save()
        console.log(JSON.stringify({ case: id, repetition, arm, mode, toolChoice, dialect, footer, normalization, representation: result.representation, thinking: reason, accepted: result.contractAccepted,
          expectedFieldsMatch: result.expectedFieldsMatch, durationMs: result.durationMs, failure: result.failure?.category ?? null }))
      }
    report.status = controller.signal.aborted ? 'interrupted' : 'finished'
    report.summary = summarizeProtocolControls(report.results, live)
    await save(); console.log(JSON.stringify({ status: report.status, summary: report.summary, out: resolve(options.out) }))
    if (report.status !== 'finished' || report.summary.contractsAccepted !== planned || report.summary.expectedFieldsMatched !== report.summary.declaredExpectations) process.exitCode = 1
  }
} finally {
  if (interrupt) { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
  await output?.close(); await server.close()
}
