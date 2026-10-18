import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer, loadEnv } from 'vite'

const args = process.argv.slice(2), options = {}, flags = new Set(['confirm-live', 'help'])
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['case', 'model', 'thinking', 'max-questions', 'out', ...flags].includes(key) || key in options) throw new Error('Unknown or duplicate option. Use --help.')
  options[key] = flags.has(key) ? true : args[++i]
  if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error('Missing option value.')
}
if (options.help) {
  console.log('npm run eval:waypoints -- --case topic-meaningHanzi --out NEW.json [--max-questions 1..9] [--model MODEL --thinking on|off --confirm-live]\nDefault: preview, no API calls. Live: lesson DAG, graph verification, then one practice quiz via gap/build/verify steps. Sequential, no automatic retries. Saves requests, responses, usage and accepted checkpoints. Not a full application or learner-quality evaluation.')
  process.exit(0)
}
if (Boolean(options.model) !== Boolean(options['confirm-live'])) throw new Error('Live mode requires both --model and --confirm-live.')
if (options.thinking && !['on', 'off'].includes(options.thinking)) throw new Error('Thinking must be on or off.')
const maxQuestions = Number(options['max-questions'] ?? 3)
if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 9) throw new Error('Question limit must be 1..9.')
const live = Boolean(options['confirm-live'])
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true }, define: { __VL_TEST_KEYS__: '{}' } })
let file, stop
try {
  const { lessonCases, sourceProvenance } = await server.ssrLoadModule('/tests/evaluation/lesson-corpus.ts')
  const { prepareWaypointGraph, buildWaypointQuiz } = await server.ssrLoadModule('/src/lib/teacher/lessonGeneration/workflow.ts')
  const { streamChat } = await server.ssrLoadModule('/src/lib/ai/client.ts')
  const { providerDefaults } = await server.ssrLoadModule('/src/lib/settings.ts')
  const entry = lessonCases.find(c => c.id === (options.case ?? 'topic-meaningHanzi'))
  if (!entry) throw new Error('Unknown lesson case.')
  const input = { kind: entry.kind, settings: entry.settings, objective: entry.objective, conversationContext: `${entry.material.passageHanzi}\n${entry.material.passageMeaning}`,
    ...(entry.kind === 'topic' ? {} : { sourceMaterial: { draftId: 'authored-source', passageHanzi: entry.material.passageHanzi, passageMeaning: entry.material.passageMeaning, scenario: entry.material.roleplay } }),
    targets: entry.material.phrases.map((p, i) => ({ cardId: `target-${i + 1}`, hanzi: p.hanzi, meaning: p.meaning })),
    sources: [{ id: 'source-1', title: entry.material.title, excerpt: `${entry.material.passageHanzi}\n${entry.material.passageMeaning}\n${entry.material.phrases.map(p => `${p.hanzi}: ${p.meaning}. ${p.explanation}`).join('\n')}` }],
  }
  const env = live ? loadEnv('development', process.cwd(), '') : {}, apiKey = env.FEATHERLESS_API_KEY?.trim() ?? ''
  if (live && !apiKey) throw new Error('Missing FEATHERLESS_API_KEY.')
  if (live && !options.out) throw new Error('Live runs need a new --out report path.')
  const paths = ['scripts/evaluate-waypoints.mjs', 'src/lib/domain/lessonGraph.ts', 'src/lib/domain/lessonPreparation.ts', 'src/lib/domain/questionSolve.ts', 'src/lib/domain/lessonSettings.ts', 'src/lib/teacher/lessonGeneration/workflow.ts', 'src/lib/teacher/lessonGeneration/executeStage.ts', 'src/lib/teacher/lessonGeneration/prompts.ts', 'src/lib/teacher/lessonGeneration/definitions.ts', 'src/lib/teacher/lessonGeneration/stages.ts', 'src/lib/teacher/lessonGeneration/modelProfiles.ts', 'src/lib/teacher/lessonGeneration/assemblePrompt.ts', 'src/lib/ai/lessonGenerationAdapter.ts', 'src/lib/teacher/toolPrompt.ts', 'src/lib/teacher/lessonGraphTools.ts', 'src/lib/teacher/questionGapTools.ts', 'src/lib/learning/waypointQuestion.ts', 'src/lib/learning/quiz.ts', 'src/lib/ai/client.ts', 'tests/evaluation/lesson-corpus.ts']
  const codeHashes = Object.fromEntries(await Promise.all(paths.map(async p => [p, createHash('sha256').update(await readFile(p)).digest('hex')])))
  const report = { format: 'visual-language-waypoint-evaluation', version: 1, status: live ? 'running' : 'preview', caseId: entry.id,
    startedAt: new Date().toISOString(), sourceProvenance, input, codeHashes, model: options.model, thinking: options.thinking ?? 'application-default',
    maxQuestions, maximumCalls: live ? 120 : 0, calls: [], checkpoints: [], graphCheckpoints: [], humanReview: 'pending', releaseReady: false }
  if (options.out) {
    const path = resolve(options.out)
    if (!path.endsWith('.json')) throw new Error('Report must end with .json.')
    await mkdir(dirname(path), { recursive: true }); file = await open(path, 'wx', 0o600)
  }
  const save = async () => {
    if (!file) return
    const contents = JSON.stringify(report, null, 2) + '\n'
    await file.write(contents, 0, 'utf8'); await file.truncate(Buffer.byteLength(contents)); await file.sync()
  }
  await save()
  console.log(JSON.stringify({ caseId: entry.id, mode: live ? 'live' : 'preview', thinking: report.thinking, maxQuestions, maximumCalls: report.maximumCalls }))
  if (live) {
    const controller = new AbortController()
    stop = () => controller.abort(new DOMException('Evaluation interrupted', 'AbortError'))
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
    const transport = async request => {
      controller.signal.throwIfAborted()
      if (report.calls.length >= report.maximumCalls) throw new Error('Evaluation call budget exhausted.')
      const call = { stage: request.tools[0].function.name, request: { messages: request.messages, tools: request.tools, toolChoice: request.toolChoice, maxTokens: request.maxTokens, temperature: request.temperature, featherlessThinking: request.featherlessThinking, generationTrace: request.generationTrace }, durationMs: 0,
        streamActivity: { reasoningCharacters: 0, contentCharacters: 0 } }
      report.calls.push(call)
      const started = performance.now()
      try {
        const result = await streamChat({ ...request, handlers: { ...request.handlers,
          onReasoning: chunk => { call.streamActivity.reasoningCharacters += chunk.length }, onContent: chunk => { call.streamActivity.contentCharacters += chunk.length },
        }, fetcher: async (url, init) => {
          const body = JSON.parse(String(init.body))
          if (options.thinking) body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: options.thinking === 'on' }
          call.wireRequest = body
          const response = await fetch(url, { ...init, body: JSON.stringify(body) }); call.httpStatus = response.status; return response
        } })
        const { reasoning: _reasoning, ...publicResult } = result
        call.response = publicResult
        return result
      } catch (error) { call.error = String(error?.message ?? error).replaceAll(apiKey, '[redacted]'); throw error }
      finally { call.durationMs = Math.round(performance.now() - started); await save(); console.log(`${call.stage}: ${call.error ? 'failed' : 'received'} (${call.durationMs} ms)`) }
    }
    try {
      const config = { provider: { ...providerDefaults.featherless, model: options.model, apiKey }, transport, signal: controller.signal }
      report.lesson = await prepareWaypointGraph(input, { ...config, onCheckpoint: async draft => { report.graphCheckpoints.push(draft); await save() } }); await save()
      report.quiz = await buildWaypointQuiz(input, report.lesson, 'practice', { ...config, maxQuestions, onCheckpoint: async quiz => { report.checkpoints.push(quiz); await save() } })
      report.status = 'finished'
    } catch (error) { report.status = controller.signal.aborted ? 'interrupted' : 'failed'; report.error = String(error?.message ?? error).replaceAll(apiKey, '[redacted]'); process.exitCode = 1 }
    report.finishedAt = new Date().toISOString()
    report.reportedTokens = report.calls.reduce((n, c) => n + (c.response?.usage?.totalTokens ?? 0), 0)
    report.callsWithoutUsage = report.calls.filter(c => !c.response?.usage).length
    await save()
    console.log(JSON.stringify({ status: report.status, calls: report.calls.length, acceptedQuestions: report.quiz?.questions.length ?? report.checkpoints.at(-1)?.questions.length ?? 0, reportedTokens: report.reportedTokens, callsWithoutUsage: report.callsWithoutUsage, error: report.error }))
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
finally { if (stop) { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop) } await file?.close(); await server.close() }
