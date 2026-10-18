import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer, loadEnv } from 'vite'

const options = {}, flags = new Set(['fixture', 'confirm-live', 'help']), args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['split', 'case', 'variant', 'models', 'provider', 'repeat', 'out', 'from', 'annotations', ...flags].includes(key) || key in options) throw new Error('Unknown or repeated option. Use --help.')
  options[key] = flags.has(key) ? true : args[++i]
  if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error('Missing option value.')
}
if (options.help) {
  console.log('npm run eval:reviews -- [--split calibration|regression|holdout|all] [--case ID,ID] [--variant baseline,without-feedback-grounding,calibrated,focused,evidence-first,precise,option-audit,blind-audit,answer-audit,english-audit] [--from LESSONS.json --annotations LABELS.json] [--repeat 1..3] [--out NEW.json] [--fixture | --provider featherless|nebius --models MODEL,MODEL --confirm-live]\nDefault: baseline calibration preview, zero calls; select candidate variants explicitly. One call per trial, or two independent calls for blind-audit/answer-audit/english-audit; no repair. english-audit requires English-answer cases. Synthetic fixture checks do not measure reviewer accuracy.')
  process.exit(0)
}
if (options.fixture && (options.provider || options.models || options['confirm-live'])) throw new Error('Fixture and live options cannot be mixed.')
if ((options.models || options['confirm-live']) && !options.provider) throw new Error('Choose a provider for live options.')
if (options.provider && (!['featherless', 'nebius'].includes(options.provider) || !options.models?.trim() || !options['confirm-live'])) throw new Error('Live runs require provider, models and --confirm-live.')
if (Boolean(options.from) !== Boolean(options.annotations)) throw new Error('Replay requires both --from and --annotations.')
if (options.from && options.split && !['replay', 'all'].includes(options.split)) throw new Error('Replay supports only --split replay or all.')
const repeat = Number(options.repeat ?? 1), split = options.split ?? (options.from ? 'replay' : 'calibration')
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3 || !['calibration', 'regression', 'holdout', 'replay', 'all'].includes(split)) throw new Error('Repeat must be 1..3 and split calibration, regression, holdout or all.')
const mode = options.fixture ? 'fixture' : options.provider ? 'live' : 'preview'
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, define: { __VL_TEST_KEYS__: '{}' } })
let output, stop
try {
  const runner = await server.ssrLoadModule('/tests/evaluation/review-runner.ts')
  const select = (raw, allowed) => {
    const values = raw ? raw.split(',') : allowed
    if (!values.length || new Set(values).size !== values.length || values.some(v => !allowed.includes(v))) throw new Error('Unknown or duplicate case, variant or model.')
    return values
  }
  const replay = options.from ? await (await server.ssrLoadModule('/tests/evaluation/review-replay.ts')).loadReviewReplay(await readFile(resolve(options.from), 'utf8'), JSON.parse(await readFile(resolve(options.annotations), 'utf8'))) : undefined
  if (split === 'replay' && !replay) throw new Error('Replay split requires --from and --annotations.')
  const eligible = (replay?.cases ?? runner.reviewCases).filter(c => split === 'all' || c.split === split)
  const cases = select(options.case, eligible.map(c => c.id)).map(id => eligible.find(c => c.id === id))
  const variants = select(options.variant ?? 'baseline', [...runner.variants]), models = options.models ? options.models.split(',').map(s => s.trim()) : [mode === 'fixture' ? 'authored-review-fixture' : 'selected-at-live-run']
  if (models.length > 4 || models.some(m => !m) || new Set(models).size !== models.length) throw new Error('Choose one to four distinct models.')
  const trials = cases.length * variants.length * models.length * repeat
  const calls = cases.length * variants.reduce((n, v) => n + runner.reviewCallLimit(v), 0) * models.length * repeat
  if (calls > 96) throw new Error('Maximum 96 calls per review experiment; narrow the matrix.')
  const counts = runner.validateReviewCorpus(cases)
  const env = mode === 'live' ? loadEnv('development', process.cwd(), '') : {}
  const apiKey = mode === 'live' ? env[options.provider === 'featherless' ? 'FEATHERLESS_API_KEY' : 'NEBIUS_API_KEY']?.trim() : ''
  if (mode === 'live' && !apiKey) throw new Error('Missing provider test key; no fallback.')
  const controller = new AbortController(); stop = () => controller.abort(new DOMException('Review evaluation interrupted', 'AbortError'))
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  const files = ['scripts/evaluate-reviews.mjs', 'tests/evaluation/review-corpus.ts', 'tests/evaluation/review-runner.ts', 'tests/evaluation/review-prompts.ts', 'tests/evaluation/review-audit.ts', 'tests/evaluation/review-question.ts', 'tests/evaluation/review-english-mask.ts', 'tests/evaluation/review-replay.ts', 'src/lib/teacher/quizReview.ts', 'src/lib/teacher/lessonPrompts.ts', 'src/lib/teacher/teacherService.ts', 'src/lib/teacher/contracts.ts', 'src/lib/ai/client.ts']
  const codeHashes = Object.fromEntries(await Promise.all(files.map(async p => [p, createHash('sha256').update(await readFile(p)).digest('hex')])))
  const report = { format: 'visual-language-review-evaluation', version: 2, mode, status: 'preview', startedAt: new Date().toISOString(), split, models, variants, repeat,
    plannedTrials: trials, transportCallLimit: calls, maximumLiveCalls: mode === 'live' ? calls : 0, codeHashes, ...(replay ? { replay: { ...replay.provenance, source: options.from, annotations: options.annotations } } : {}), corpusHash: await runner.digest(JSON.stringify(cases)), cases,
    previews: cases.flatMap(c => variants.map(v => ({ caseId: c.id, variant: v, request: runner.reviewRequest(c, v), ...(runner.reviewCallLimit(v) === 2 ? { independentRequest: runner.independentReviewRequest(c.input, v) } : {}) }))), results: [], summary: [],
    annotations: 'Project-authored provisional expected decisions, not linguist certification. Expected labels and rationales are never sent to the provider.', releaseReady: false }
  let path
  if (mode !== 'preview' || options.out) {
    path = resolve(options.out ?? `eval-results/reviews-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    if (!path.endsWith('.json')) throw new Error('Output must be a new .json file.')
    await mkdir(dirname(path), { recursive: true }); output = await open(path, 'wx', 0o600)
  }
  const checkpoint = async status => {
    report.status = status; report.summary = runner.summarizeReviews(report.results)
    if (output) { const text = JSON.stringify(runner.redact(report, [apiKey]), null, 2) + '\n'; await output.write(text, 0, 'utf8'); await output.truncate(Buffer.byteLength(text)); await output.sync() }
  }
  await checkpoint(mode === 'preview' ? 'preview' : 'running')
  console.log(JSON.stringify({ mode, counts, variants, models, repeat, plannedTrials: trials, potentialCalls: calls, maximumLiveCalls: report.maximumLiveCalls, path }, null, 2))
  if (mode !== 'preview') {
    for (let r = 0; r < repeat && !controller.signal.aborted; r++) for (const entry of cases) {
      const order = [...variants.slice(r % variants.length), ...variants.slice(0, r % variants.length)]
      for (const model of models) for (const variant of order) {
        if (controller.signal.aborted) break
        const result = await runner.runReview(entry, variant, mode === 'fixture' ? { mode } : { mode, provider: options.provider, model, apiKey, confirmed: true }, controller.signal)
        report.results.push({ ...result, repetition: r + 1 }); await checkpoint('running')
        console.log(`${entry.id} / ${variant} / ${model} [${r + 1}]: ${result.evaluation?.pass ? 'pass' : 'FAIL'} (${result.durationMs} ms)`)
      }
    }
    await checkpoint(controller.signal.aborted ? 'interrupted' : 'finished')
    console.log(JSON.stringify(report.summary, null, 2))
    process.exitCode = controller.signal.aborted ? 130 : report.results.length === trials && report.results.every(r => r.evaluation?.pass) ? 0 : 1
  }
} finally {
  if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
  await output?.close(); await server.close()
}
