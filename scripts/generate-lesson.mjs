import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Runs the real evaluator, retaining each terminal attempt as separate evidence.
const options = {}, args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['provider', 'model', 'case', 'attempts', 'out', 'from', 'confirm-live', 'fixture', 'help'].includes(key) || key in options) throw new Error('Unknown/repeated option; use --help.')
  options[key] = ['confirm-live', 'fixture', 'help'].includes(key) ? true : args[++i]
  if (options[key] === undefined || typeof options[key] === 'string' && options[key].startsWith('--')) throw new Error('Missing option value.')
}
if (options.help) {
  console.log('npm run test:lesson-generation -- --provider PROVIDER --model MODEL --case CASE --confirm-live --out NEW_DIRECTORY [--attempts 1..3] [--from FAILED_REPORT]\nOr use --fixture without provider/model/confirmation. Default: three total attempts. Resume accepted checkpoints within remaining original budgets; never discard accepted work or retry authentication/configuration errors. Each attempt and the final completion result are retained.')
  process.exit(0)
}
const maximumAttempts = Number(options.attempts ?? 3)
if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3 || !options.out || !options.case) throw new Error('Choose --case, a new --out directory, and --attempts 1..3.')
if (options.fixture ? options.provider || options.model || options['confirm-live'] || options.from : !options.provider || !options.model || !options['confirm-live']) throw new Error('Use explicit confirmed live configuration or fixture mode.')
if (options.case.includes(',')) throw new Error('Generation tests require one case per job.')
const output = resolve(options.out)
let previous = options.from ? resolve(options.from) : undefined
let original
if (previous) {
  original = JSON.parse(await readFile(previous, 'utf8'))
  if (original.lessonModelProfile || ![undefined, 'application-default'].includes(original.requestedThinking) || ![undefined, 'tiktoken_estimate'].includes(original.requestedTokenCounter)) throw new Error('Retry requires the original default profile, thinking and token-counter settings; custom settings must use the evaluator resume command explicitly.')
  if (original.requestedProvider !== options.provider || original.requestedModel !== options.model || original.selectedCaseIds?.length !== 1 || original.selectedCaseIds[0] !== options.case) throw new Error('Retry must retain the original provider, model and single case.')
}
await mkdir(output, { recursive: false }) // Never overwrite an earlier job.
const job = { status: 'running', caseId: options.case, provider: options.provider ?? 'fixture', model: options.model ?? 'authored-fixture', maximumAttempts, attempts: [], completed: false }
const save = () => writeFile(join(output, 'generation.json'), JSON.stringify(job, null, 2) + '\n')
if (original) job.attempts.push({ report: previous, status: original.status, failure: original.results?.[0]?.failure, imported: true })
await save()
try {
  while (job.attempts.length < maximumAttempts && !job.completed) {
    const reportPath = join(output, `attempt-${job.attempts.length + 1}.json`)
    const command = ['scripts/evaluate-mandarin.mjs', '--suite', 'lessons', '--case', options.case, '--out', reportPath,
      ...(options.fixture ? ['--fixture'] : ['--provider', options.provider, '--model', options.model, '--confirm-live']),
      ...(previous ? ['--resume-from', previous, '--resume-trial', `${options.case}/r1`] : [])]
    const exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, command, { stdio: 'inherit' })
      let cancelled = false
      const interrupt = signal => { cancelled = true; child.kill(signal) }
      const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM')
      process.once('SIGINT', sigint); process.once('SIGTERM', sigterm)
      const clean = () => { process.removeListener('SIGINT', sigint); process.removeListener('SIGTERM', sigterm) }
      child.once('error', error => { clean(); reject(error) })
      child.once('exit', (code, signal) => { clean(); done(cancelled || signal ? 130 : code) })
    })
    let report
    try { report = JSON.parse(await readFile(reportPath, 'utf8')) } catch { /* setup failure retained below */ }
    const trial = report?.results?.[0]
    job.attempts.push({ report: reportPath, exitCode, status: report?.status ?? 'setup_failed', failure: trial?.failure ?? report?.setupFailure ?? null, resumed: Boolean(previous), resumeEvidence: trial?.resumeEvidence ?? null })
    job.completed = exitCode === 0 && report?.status === 'finished' && trial?.prepared === true && trial?.scriptedPlaybackCompleted === true && report.summary?.invariantFailures?.length === 0
    if (job.completed) {
      job.lessonReport = reportPath
      job.lessonArtifact = join(output, 'lesson.json')
      await writeFile(job.lessonArtifact, JSON.stringify({ format: 'visual-language-generated-lesson', caseId: options.case, provider: job.provider, model: job.model, sourceReport: reportPath, instructionalQuality: 'unrated', artifacts: trial.artifacts }, null, 2) + '\n')
    }
    await save()
    if (exitCode === 130) { job.stopReason = 'interrupted'; break }
    if (job.completed) break
    // Missing/invalid credentials and setup faults need intervention. Validated
    // checkpoints may resume content, stream and transport failures alike.
    const failure = trial?.failure
    if (report?.status !== 'finished' || !failure || [400, 401, 403, 404].includes(failure.httpStatus) || [400, 401, 403, 404].includes(failure.detail?.httpStatus)) { job.stopReason = 'configuration_or_setup_requires_intervention'; break }
    const budget = report.runtime?.generationPolicy?.evaluation
    if (!budget || trial.calls.length >= budget.maxRequests || trial.durationMs >= budget.timeBudgetMs) { job.stopReason = 'original_lesson_budget_exhausted'; break }
    previous = reportPath
  }
  job.status = job.completed ? 'completed' : job.stopReason === 'interrupted' ? 'interrupted' : 'incomplete'
  job.stopReason ??= job.completed ? 'lesson_prepared_and_playback_completed' : 'attempt_limit_reached'
  await save()
  console.log(JSON.stringify(job, null, 2))
  process.exitCode = job.completed ? 0 : 1
} catch (error) {
  job.status = 'harness_error'; job.stopReason = error instanceof Error ? error.message : 'Generation orchestration failed'
  await save(); throw error
}
