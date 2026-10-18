import { sameRecord } from '../../src/lib/domain/common'
import { lessonSchema } from '../../src/lib/domain/lesson'
import { validateGraphDraft, validateLessonPreparation } from '../../src/lib/domain/lessonPreparation'
import type { LessonCase } from './lesson-corpus'
import type { CaseResult, ResumeLessonArtifacts } from './lesson-runner'

/** Resume only an exact terminal failed trial; its negative evidence stays immutable. */
export function lessonResumeSource(value: any, selector: string, corpus: LessonCase[]) {
  if (value.format !== 'visual-language-lessons-evaluation' || value.version !== 2 || value.status !== 'finished' || value.activeCase) throw new Error('Resume requires a terminal finished lesson report.')
  const match = /^(.*)\/r([1-3])$/.exec(selector)
  if (!match) throw new Error('Resume trial must be CASE_ID/rN.')
  const trials = value.results.filter((t: any) => t.caseId === match[1] && (t.repetition ?? 1) === Number(match[2]))
  if (trials.length !== 1) throw new Error('Resume must select exactly one recorded trial.')
  const trial = trials[0] as CaseResult
  const entry = corpus.find(c => c.id === trial.caseId)
  if (!entry || !sameRecord(entry, trial.caseSnapshot)) throw new Error('Resume corpus case differs from its recorded snapshot.')
  if (!trial.failure || trial.prepared || trial.scriptedPlaybackCompleted) throw new Error('Resume requires a failed, incomplete preparation.')
  const plan = lessonSchema.parse(trial.artifacts.plan)
  if (plan.preparation) validateLessonPreparation(plan.preparation)
  if (plan.waypointDraft) validateGraphDraft(plan.waypointDraft)
  const quizzes = [trial.artifacts.practice, trial.artifacts.check].filter((draft): draft is NonNullable<typeof draft> => Boolean(draft))
  const artifacts: ResumeLessonArtifacts = { plan, sources: structuredClone(trial.artifacts.sources), quizzes: structuredClone(quizzes), originalRequestCount: trial.calls.length, originalDurationMs: trial.durationMs }
  return { entry, trial: structuredClone(trial), artifacts, originalRepetition: Number(match[2]) }
}

/** Report the whole initial/resume chain; the initial failed attempts are not new dispatches. */
export function combineLessonResume(original: CaseResult, resumed: CaseResult): CaseResult {
  return { ...resumed, durationMs: original.durationMs + resumed.durationMs,
    calls: [...structuredClone(original.calls), ...resumed.calls],
    checkpointCommits: [...structuredClone(original.checkpointCommits), ...resumed.checkpointCommits],
    stages: [...structuredClone(original.stages), ...resumed.stages.map(s => ({ ...s, startedMs: original.durationMs + s.startedMs }))] }
}
