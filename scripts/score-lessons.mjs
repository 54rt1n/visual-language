import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['report', 'annotations', 'packet', 'out', 'help'].includes(key) || key in options) throw new Error('Unknown or duplicate scoring option.')
  options[key] = key === 'help' ? true : args[++i]
  if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error('Missing scoring option value.')
}
if (options.help) {
  console.log('npm run eval:lesson-quality -- --report TERMINAL_LESSON_REPORT.json --out NEW_SCORE.json [--packet NEW_AUDIT_PACKET.json] [--annotations RATINGS.json]\nOffline; zero API calls. Writes JSON and sibling Markdown, refusing existing outputs. Without annotations semantic quality is unrated. Ratings must bind the exact report hash and contain verifiable evidence. The packet supports independent human/model/agent annotation.')
  process.exit(0)
}
if (!options.report || !options.out) throw new Error('Scoring requires --report and --out; use --help.')
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
try {
  const { auditPacket, scoreLessons, scoreMarkdown } = await server.ssrLoadModule('/tests/evaluation/lesson-quality.ts')
  const source = await readFile(resolve(options.report), 'utf8')
  const annotations = options.annotations ? JSON.parse(await readFile(resolve(options.annotations), 'utf8')) : undefined
  const score = await scoreLessons(source, annotations)
  score.scorerCodeHashes = Object.fromEntries(await Promise.all(['scripts/score-lessons.mjs', 'tests/fixtures/tool-context.ts', 'tests/evaluation/lesson-quality.ts', 'src/lib/teacher/lessonGeneration/stages.ts', 'tests/evaluation/lesson-reliability.ts', 'tests/evaluation/provider-capacity.ts', 'src/lib/teacher/lessonGraphTools.ts', 'src/lib/teacher/questionGapTools.ts', 'src/lib/domain/lessonPreparation.ts', 'src/lib/domain/questionSolve.ts', 'src/lib/domain/coverageEvidence.ts', 'src/lib/domain/blindQuestion.ts', 'src/lib/domain/lessonGraph.ts', 'src/lib/learning/waypointQuestion.ts', 'src/lib/ai/qwenToolProtocol.ts', 'src/lib/ai/qwenToolEnvelope.ts'].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  const output = resolve(options.out), markdown = output.replace(/\.json$/i, '') + '.md'
  const outputs = [[output, score], ...(options.packet ? [[resolve(options.packet), await auditPacket(source)]] : [])]
  if (new Set([...outputs.map(([path]) => path), markdown]).size !== outputs.length + 1) throw new Error('All output paths must be distinct.')
  for (const [path] of outputs) await mkdir(dirname(path), { recursive: true })
  await mkdir(dirname(markdown), { recursive: true })
  // Reserve every output before writing; existing evidence is never overwritten.
  const handles = []
  try {
    const { open } = await import('node:fs/promises')
    for (const [path] of outputs) handles.push(await open(path, 'wx', 0o600))
    handles.push(await open(markdown, 'wx', 0o600))
    for (const [index, [, value]] of outputs.entries()) await handles[index].writeFile(JSON.stringify(value, null, 2) + '\n')
    await handles.at(-1).writeFile(scoreMarkdown(score))
  } finally { for (const handle of handles) await handle.close() }
  console.log(JSON.stringify({ report: output, markdown, prepared: score.prepared, planned: score.planned, quality: score.instructionalQuality, liveCalls: 0 }, null, 2))
} finally { await server.close() }
