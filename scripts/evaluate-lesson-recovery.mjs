import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer, loadEnv } from 'vite'

const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  const name = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['from', 'case', 'profile', 'out', 'model', 'fault', 'fixture', 'confirm-live'].includes(name) || name in options) throw new Error('Unknown or repeated option.')
  options[name] = ['fixture', 'confirm-live'].includes(name) ? true : args[++i]
  if (options[name] === undefined) throw new Error('Missing option value.')
}
const live = Boolean(options['confirm-live'])
if (!options.from || !options.case || !options.profile || !options.out || live === Boolean(options.fixture) || live !== Boolean(options.model)) {
  throw new Error('Use --from TERMINAL_LESSON_REPORT --case CASE --profile PROFILE --out NEW.json [--fixture | --model MODEL --confirm-live] [--fault unavailable,timeout,invalid_request,cancel_resume,stream_capacity].')
}
const faults = options.fault?.split(',') ?? ['unavailable', 'timeout', 'invalid_request', 'cancel_resume']
if (!faults.length || new Set(faults).size !== faults.length || faults.some(f => !['unavailable', 'timeout', 'invalid_request', 'cancel_resume', 'stream_capacity'].includes(f))) throw new Error('Choose distinct supported faults.')
const sha = value => createHash('sha256').update(value).digest('hex')
const sourceText = await readFile(resolve(options.from), 'utf8'), source = JSON.parse(sourceText)
if (source.format !== 'visual-language-lessons-evaluation' || source.status !== 'finished') throw new Error('A terminal lesson report is required.')
const first = source.results.find(row => row.caseId === options.case)?.calls[0]
if (!first) throw new Error('Selected case has no recorded preparation context.')
const context = JSON.parse(first.request.messages.find(m => m.role === 'user').content.split('\n\nTool call:\n', 1)[0])
const input = Object.fromEntries(['kind', 'settings', 'objective', 'conversationContext', 'targets', 'sources'].map(key => [key, context[key]]))
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
let output, interrupt
try {
  const { runLessonRecoveryControl, summarizeRecoveryControls } = await server.ssrLoadModule('/tests/evaluation/lesson-recovery-control.ts')
  const { lessonFixture } = await server.ssrLoadModule('/tests/evaluation/lesson-runner.ts')
  const { streamChat } = await server.ssrLoadModule('/src/lib/ai/client.ts')
  const { waypointLessonInputSchema } = await server.ssrLoadModule('/src/lib/domain/lessonGraph.ts')
  const { lessonModelProfileSchema } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/modelProfiles.ts')
  const { providerDefaults } = await server.ssrLoadModule('/src/lib/settings.ts')
  waypointLessonInputSchema.parse(input)
  const profile = lessonModelProfileSchema.parse(JSON.parse(await readFile(resolve(options.profile), 'utf8')))
  const key = live ? loadEnv('development', process.cwd(), '').FEATHERLESS_API_KEY?.trim() : undefined
  if (live && !key) throw new Error('Missing FEATHERLESS_API_KEY.')
  const provider = { ...providerDefaults.featherless, model: options.model ?? 'authored-recovery-fixture', apiKey: key ?? 'fixture' }
  const controller = new AbortController()
  interrupt = () => controller.abort(new DOMException('Recovery evaluation interrupted', 'AbortError'))
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
  const files = [...new Set([...Object.keys(source.codeHashes), 'scripts/evaluate-lesson-recovery.mjs', 'tests/evaluation/lesson-recovery-control.ts', 'tests/evaluation/request-failure.ts'])]
  const report = { format: 'visual-language-lesson-recovery-evaluation', version: 2, status: 'running', startedAt: new Date().toISOString(),
    source: { path: resolve(options.from), sha256: sha(sourceText), caseId: options.case, inputHash: sha(JSON.stringify(input)) }, input,
    provider: live ? 'featherless' : 'fixture', model: provider.model, profile, profileHash: sha(JSON.stringify(profile)),
    faults, maximumModelTransportCalls: live ? faults.length * 120 : 0,
    codeHashes: Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))]))),
    evidenceScope: 'Authored fault injections are separate from live dispatches. Recovery/cancellation mechanics only; no independent language or learner-event evidence.',
    releaseReady: false, wireRequests: [], results: [] }
  const path = resolve(options.out)
  if (!path.endsWith('.json')) throw new Error('Output must be a new JSON path.')
  await mkdir(dirname(path), { recursive: true }); output = await open(path, 'wx', 0o600)
  const save = async () => {
    let text = JSON.stringify(report, null, 2) + '\n'
    if (key) text = text.replaceAll(key, '[redacted]')
    await output.write(text, 0, 'utf8'); await output.truncate(Buffer.byteLength(text)); await output.sync()
  }
  await save()
  for (const fault of faults) {
    if (controller.signal.aborted) break
    report.activeFault = fault
    const result = await runLessonRecoveryControl(input, fault, { provider, modelProfile: profile, signal: controller.signal,
      transport: live ? request => streamChat({ ...request, fetcher: async (url, init) => {
        const body = JSON.parse(String(init?.body))
        const wire = { fault, body, sha256: sha(JSON.stringify(body)), dispatched: true }
        report.wireRequests.push(wire); await save()
        const response = await fetch(url, init); wire.httpStatus = response.status; return response
      } }) : lessonFixture,
    }, async state => { report.activeControl = state; await save() })
    report.results.push(result); delete report.activeControl; delete report.activeFault; await save()
    console.log(JSON.stringify({ fault, passed: result.passed, complete: result.complete, calls: result.calls.length,
      initialFailure: result.initialFailure?.category ?? null, resumedFailure: result.resumedFailure?.category ?? null }))
  }
  report.status = controller.signal.aborted ? 'interrupted' : 'finished'; report.finishedAt = new Date().toISOString()
  report.summary = summarizeRecoveryControls(report.results, faults.length, report.wireRequests.length)
  await save()
  process.exitCode = report.status === 'finished' && report.results.length === faults.length && report.results.every(r => r.passed) ? 0 : 1
} finally {
  if (interrupt) { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt) }
  await output?.close(); await server.close()
}
