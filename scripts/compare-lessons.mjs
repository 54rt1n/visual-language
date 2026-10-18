import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['scores', 'out'].includes(key) || key in options) throw new Error('Use --scores A.json,B.json --out NEW.json.')
  options[key] = args[++i]
}
if (!options.scores || !options.out) throw new Error('Use --scores A.json,B.json --out NEW.json.')
const server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
try {
  const { compareQualityScores } = await server.ssrLoadModule('/tests/evaluation/lesson-quality.ts')
  const scores = await Promise.all(options.scores.split(',').map(async path => JSON.parse(await readFile(resolve(path), 'utf8'))))
  const comparison = compareQualityScores(scores), output = resolve(options.out), markdown = output.replace(/\.json$/i, '') + '.md'
  if (markdown === output) throw new Error('Comparison output must use a .json suffix.')
  await mkdir(dirname(output), { recursive: true })
  const handles = []
  try {
    handles.push(await open(output, 'wx', 0o600)); handles.push(await open(markdown, 'wx', 0o600))
    await handles[0].writeFile(JSON.stringify(comparison, null, 2) + '\n')
    const rows = comparison.models.flatMap(m => m.stages.map(s => `| ${m.model} | ${s.phase}: ${s.stage} | ${s.reachedCases}/${s.plannedCases} | ${s.contractPasses}/${s.attempts} (${s.completedResponses} received) | ${s.submissionsAcceptedByExecutor ?? 'unknown'}/${s.attempts} | ${s.semantic.observedScore ?? 'unrated'} / ${s.semantic.auditCoverage ?? 0}% | ${s.durationsMs.median ?? '—'} | ${s.tokenUsage.totalTokens ?? 'unknown'} |`))
    await handles[1].writeFile(`# Lesson model comparison\n\nMatched experiment: ${comparison.matchedExperiment}. Same provider: ${comparison.sameProvider}. Reviewer matched: ${comparison.reviewerMatched}.\n\n${comparison.models.map(m => `- ${m.model}: ${m.prepared}/${m.planned} lessons ready; ${m.reliability ? `${m.reliability.lessonsReadyWithoutRecovery} without recovery, ${m.reliability.lessonsReadyAfterRecovery} after recovery, ${m.reliability.lessonsReadyWithUnknownRecovery} with unknown recovery history` : 'recovery history unknown'}; quality ${m.quality.observedScore ?? 'unrated'}/100, ${m.quality.auditCoverage ?? 0}% audited (${m.quality.status}).`).join('\n')}\n\n| Model | Stage | Cases reached | Schema/content contracts / all requests (responses received) | Executor accepted | Semantic score / coverage | Median ms | Tokens |\n|---|---|---|---|---|---|---:|---:|\n${rows.join('\n')}\n\n${comparison.interpretation}\n\n${comparison.mismatches.length ? 'Mismatches: ' + JSON.stringify(comparison.mismatches) : ''}\n`)
  } finally { for (const handle of handles) await handle.close() }
  console.log(JSON.stringify({ output, markdown, matchedExperiment: comparison.matchedExperiment, models: comparison.models.map(m => ({ model: m.model, prepared: m.prepared, planned: m.planned })) }, null, 2))
} finally { await server.close() }
