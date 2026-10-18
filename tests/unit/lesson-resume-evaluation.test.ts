import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { InferenceFailure } from '../../src/lib/ai/inferenceFailure'
import { lessonResumeSource, combineLessonResume } from '../evaluation/lesson-resume-source'
import { lessonFixture } from '../evaluation/lesson-runner'
import { describe, expect, it } from 'vitest'
import { lessonCases, runCase } from '../evaluation/lesson-runner'
import captured from '../evaluation/focused-cases/resume-coverage-checkpoint-qwen27b.json'
import type { ResumeLessonArtifacts } from '../evaluation/lesson-runner'
import streamCheckpoint from '../evaluation/focused-cases/resume-stream-checkpoint-qwen27b.json'
import { restoreLessonSources } from '../evaluation/lesson-reference-seed'
import { withAuthoredAnswerEvidence } from '../fixtures/topic-lesson'
import { lessonSchema } from '../../src/lib/domain/lesson'

function currentFixture(value: unknown) {
  const saved = structuredClone(value) as ResumeLessonArtifacts
  // Reuse captured generation content with explicitly authored current storage
  // metadata. This is test setup, not a saved-session migration path.
  const { stepIndex: _step, remediatedSteps: _retry, skippedSteps: _skip, ...content } = saved.plan as typeof saved.plan & { stepIndex?: number; remediatedSteps?: number[]; skippedSteps?: number[] }
  saved.plan = lessonSchema.parse({ ...content, id: 'captured-lesson', learnerId: 'captured-learner', createdAt: 0,
    opportunity: { id: 'captured-initial-check', kind: 'initial', eligibleAt: 0 },
    goal: content.preparation!.input.objective, preparation: withAuthoredAnswerEvidence(content.preparation!) })
  return saved
}
const resume = currentFixture(captured)
const entry = lessonCases.find(e => e.id === captured.caseId)!

describe('captured content with authored current-format solve evidence through the evaluator', () => {
  it.each([1, 2])('resumes graph construction after waypoint call %i fails without resetting accepted work', async failureOrdinal => {
    const graphEntry = lessonCases.find(e => e.id === 'scenario-meaningPinyin')!
    let authors = 0
    const failed = await runCase(graphEntry, { mode: 'fixture' }, undefined, async options => {
      if (options.tools?.[0]?.function.name === 'add_lesson_waypoint' && ++authors === failureOrdinal)
        throw new InferenceFailure({ category: 'protocol_error', layer: 'protocol', retryable: false, message: 'Synthetic graph stream failure.' })
      return lessonFixture(options)
    })
    expect(failed.failure).not.toBeNull()
    const source = lessonResumeSource({ format: 'visual-language-lessons-evaluation', version: 2, status: 'finished', results: [{ ...failed, repetition: 1 }] }, `${graphEntry.id}/r1`, lessonCases)
    const recovered = await runCase(graphEntry, { mode: 'fixture' }, undefined, undefined, undefined, undefined, source.artifacts)
    expect(recovered.prepared).toBe(true)
    expect(recovered.scriptedPlaybackCompleted).toBe(true)
    expect(recovered.resumeEvidence?.originalRequestCount).toBe(failed.calls.length)
    expect(recovered.resumeEvidence?.originalDurationMs).toBe(failed.durationMs)
    expect(recovered.resumeEvidence?.preservedGraphWaypoints).toBe(true)
    if (failureOrdinal === 2) {
      expect(failed.artifacts.plan!.waypointDraft!.graph.waypoints).toHaveLength(1)
      expect(recovered.artifacts.plan!.preparation!.lesson.graph.waypoints[0]).toEqual(failed.artifacts.plan!.waypointDraft!.graph.waypoints[0])
    }
    expect(combineLessonResume(source.trial, recovered).calls.length).toBe(failed.calls.length + recovered.calls.length)
  })

  it('the generation command produces an inspectable completed lesson and refuses to overwrite it', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'lesson-generation-test-')), output = join(temp, 'job')
    try {
      const command = ['scripts/generate-lesson.mjs', '--fixture', '--case', 'topic-meaningPinyin', '--out', output]
      await promisify(execFile)(process.execPath, command)
      const job = JSON.parse(await readFile(join(output, 'generation.json'), 'utf8'))
      expect(job).toMatchObject({ status: 'completed', completed: true, maximumAttempts: 3 })
      expect(job.attempts).toHaveLength(1)
      const lesson = JSON.parse(await readFile(job.lessonArtifact, 'utf8'))
      expect(lesson.artifacts.plan.preparation).toBeTruthy()
      expect(lesson.artifacts.practice.quiz.questions.length).toBeGreaterThan(0)
      expect(lesson.artifacts.check.quiz.questions.length).toBeGreaterThan(0)
      const incompatible = join(temp, 'custom-profile.json')
      await import('node:fs/promises').then(fs => fs.writeFile(incompatible, JSON.stringify({ lessonModelProfile: { id: 'custom', version: '1' } })))
      await expect(promisify(execFile)(process.execPath, ['scripts/generate-lesson.mjs', '--provider', 'minimax', '--model', 'MiniMax-M3', '--case', 'topic-meaningPinyin', '--confirm-live', '--from', incompatible, '--out', join(temp, 'rejected')])).rejects.toThrow('original default profile')
      await expect(readFile(join(temp, 'rejected', 'generation.json'))).rejects.toThrow()
      const before = await readFile(job.lessonArtifact, 'utf8')
      await expect(promisify(execFile)(process.execPath, command)).rejects.toThrow()
      expect(await readFile(job.lessonArtifact, 'utf8')).toBe(before)
    } finally { await rm(temp, { recursive: true, force: true }) }
  }, 20_000)
  it('finishes a lesson after a terminal stream failure by resuming accepted work', async () => {
    let failedOnce = false
    const failed = await runCase(entry, { mode: 'fixture' }, undefined, async options => {
      if (!failedOnce && options.tools?.[0]?.function.name === 'evaluate_question_coverage') {
        failedOnce = true
        throw new InferenceFailure({ category: 'protocol_error', layer: 'protocol', retryable: false, message: 'Synthetic interrupted coverage stream.' })
      }
      return lessonFixture(options)
    }, undefined, undefined, resume)
    expect(failed.failure).not.toBeNull()
    const recorded = { format: 'visual-language-lessons-evaluation', version: 2, status: 'finished', results: [{ ...failed, repetition: 1 }] }
    const before = JSON.stringify(recorded)
    const source = lessonResumeSource(recorded, `${entry.id}/r1`, lessonCases)
    const recovered = await runCase(entry, { mode: 'fixture' }, undefined, undefined, undefined, undefined, source.artifacts)
    const combined = combineLessonResume(source.trial, recovered)
    expect(combined.prepared).toBe(true)
    expect(combined.scriptedPlaybackCompleted).toBe(true)
    expect(combined.resumeEvidence).toMatchObject({ preservedLesson: true, preservedAcceptedQuestions: true, reauthoredGraph: false })
    expect(combined.calls.length).toBe(failed.calls.length + recovered.calls.length)
    expect(combined.calls.some(call => call.failure?.category === 'protocol_error')).toBe(true)
    expect(recovered.calls.some(call => call.mode === 'add_lesson_waypoint')).toBe(false)
    expect(JSON.stringify(recorded)).toBe(before)
  })
  it('restores a scenario checkpoint despite fresh evaluator root IDs', async () => {
    const saved = currentFixture(streamCheckpoint)
    const before = JSON.stringify(saved)
    const result = await runCase(lessonCases.find(e => e.id === streamCheckpoint.caseId)!, { mode: 'fixture' }, undefined, undefined, undefined, undefined, saved)
    expect(result.failure).toBeNull()
    expect(result.scriptedPlaybackCompleted).toBe(true)
    expect(result.resumeEvidence).toMatchObject({ preservedLesson: true, preservedAcceptedQuestions: true, reauthoredGraph: false })
    expect(result.calls.some(call => call.mode === 'add_lesson_waypoint')).toBe(false)
    for (const source of saved.sources) expect(result.artifacts.sources.find(s => s.id === source.id)).toEqual(source)
    expect(result.artifacts.practice!.quiz).toEqual(saved.quizzes![0]!.quiz)
    expect(result.artifacts.practice!.id).toBe(saved.quizzes![0]!.id)
    expect(JSON.stringify(saved)).toBe(before)
  })
  it('accepts only an incidental generated root anchor and rejects evidence changes atomically', () => {
    const saved = streamCheckpoint.sources as ResumeLessonArtifacts['sources']
    const current = saved.map(source => ({ ...source, ...(/^evaluation-card-source-/.test(source.id) ? { nodeId: 'root-fresh' } : {}) }))
    const before = JSON.stringify(current)
    expect(restoreLessonSources(current, saved, 'root-fresh')).toEqual(saved)
    const changed = structuredClone(saved)
    changed.find(s => s.id === 'evaluation-card-source-1')!.excerpt = 'Different meaning'
    expect(() => restoreLessonSources(current, changed, 'root-fresh')).toThrow('conflicts')
    const wrongCard = structuredClone(saved)
    wrongCard.find(s => s.id === 'evaluation-card-source-1')!.cardId = 'evaluation-card-2'
    expect(() => restoreLessonSources(current, wrongCard, 'root-fresh')).toThrow('conflicts')
    expect(JSON.stringify(current)).toBe(before)
  })
  it('starts at pending coverage, retains the valid question, and completes without rebuilding the graph', async () => {
    const result = await runCase(entry, { mode: 'fixture' }, undefined, undefined, undefined, undefined, resume)
    expect(result.failure).toBeNull()
    expect(result.prepared).toBe(true)
    expect(result.scriptedPlaybackCompleted).toBe(true)
    expect(result.calls[0]!.mode).toBe('evaluate_question_coverage')
    expect(result.resumeEvidence).toMatchObject({ preservedLesson: true, preservedAcceptedQuestions: true, reauthoredGraph: false })
    const first = result.artifacts.plan!.preparation!.practice!.questions[0]!.question
    expect(first.stem).toBe(resume.plan.preparation!.practice!.pending!.candidate.stem)
    expect(first.correctOptionId).toBe('B')
    expect(first.options.map(o => o.text)).toEqual(['谢谢', '对不起', '你好', '再见'])
    expect(captured.plan.preparation.practice!.pending!.candidate.stem).toBe(first.stem)
  })
  it('rejects a different corpus case or exhausted original request budget before model calls', async () => {
    await expect(runCase(lessonCases.find(e => e.id === 'topic-responseHanzi')!, { mode: 'fixture' }, undefined, undefined, undefined, undefined, resume)).rejects.toThrow('does not match')
    await expect(runCase(entry, { mode: 'fixture' }, undefined, undefined, undefined, undefined, { ...resume, originalRequestCount: 120 })).rejects.toThrow('remaining original')
  })
})
