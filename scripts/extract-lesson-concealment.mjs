import { readFile, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['report', 'out', 'help'].includes(key) || key in options) throw new Error('Unknown or repeated option.')
  options[key] = key === 'help' ? true : args[++i]
  if (options[key] === undefined) throw new Error('Missing option value.')
}
if (options.help) {
  console.log('node scripts/extract-lesson-concealment.mjs --report TERMINAL_REPORT.json --out NEW_REVIEW.json\nOffline, zero API calls. Writes a blind English-only review sheet and a sibling .mapping.json file. Keep the mapping out of reviewer context. Existing outputs are refused.')
  process.exit(0)
}
if (!options.report || !options.out?.endsWith('.json')) throw new Error('Specify --report and a new --out .json path.')
const output = resolve(options.out), mapping = output.replace(/\.json$/, '.mapping.json')
if ([output, mapping].includes(resolve(options.report))) throw new Error('Output must not replace source evidence.')
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
const handles = []
try {
  const { auditPacket } = await server.ssrLoadModule('/tests/evaluation/lesson-quality.ts')
  const { concealmentAudit } = await server.ssrLoadModule('/tests/evaluation/concealment-audit.ts')
  const result = concealmentAudit(await auditPacket(await readFile(resolve(options.report), 'utf8')))
  await mkdir(dirname(output), { recursive: true })
  for (const path of [output, mapping]) handles.push(await open(path, 'wx'))
  await handles[0].writeFile(JSON.stringify(result.review, null, 2) + '\n')
  await handles[1].writeFile(JSON.stringify(result.mapping, null, 2) + '\n')
  console.log(JSON.stringify({ output, mapping, questions: result.review.questions.length, liveCalls: 0 }))
} finally {
  await Promise.all(handles.map(handle => handle.close()))
  await server.close()
}
