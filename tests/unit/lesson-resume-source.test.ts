import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lessonCases, lessonFixture, runCase } from '../evaluation/lesson-runner'
import { lessonResumeSource, combineLessonResume } from '../evaluation/lesson-resume-source'
import { parseToolContext } from '../fixtures/tool-context'
const entry = lessonCases.find(e => e.id === 'topic-responsePinyin')!
async function failedReport() {
  const result = await runCase(entry, { mode: 'fixture' }, undefined, async request => {
    if (parseToolContext(request.messages[1]!.content!).generationMode === 'evaluate_question_coverage') throw new Error('Authored checkpoint interruption.')
    return lessonFixture(request)
  })
  return { format: 'visual-language-lessons-evaluation', version: 2, status: 'finished', requestedProvider: null, requestedModel: null,
    codeHashes: { fixture: 'synthetic' }, results: [{ ...result, repetition: 1 }] }
}

describe('recorded recovery source and complete-chain accounting', () => {
  it('records a terminal setup failure without claiming inference calls or overwriting its source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lesson-resume-setup-'))
    try {
      const source = await failedReport()
      source.results[0]!.artifacts.sources[0]!.excerpt = 'Conflicting source evidence'
      const input = join(directory, 'source.json'), output = join(directory, 'resume.json'), text = JSON.stringify(source)
      await writeFile(input, text)
      await expect(promisify(execFile)(process.execPath, ['scripts/evaluate-mandarin.mjs', '--suite', 'lessons', '--fixture', '--resume-from', input,
        '--resume-trial', `${entry.id}/r1`, '--out', output], { cwd: process.cwd(), maxBuffer: 1_000_000 })).rejects.toMatchObject({ code: 1 })
      const report = JSON.parse(await readFile(output, 'utf8'))
      expect(report.status).toBe('failed')
      expect(report.setupFailure.message).toContain('conflicts with seeded evidence')
      expect(report.summary.liveModelCalls).toBe(0)
      expect(report.summary.transportCalls).toBe(0)
      expect(report.results).toEqual([])
      expect(await readFile(input, 'utf8')).toBe(text)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('rejects running, missing, successful and changed-corpus sources', async () => {
    const source = await failedReport()
    expect(() => lessonResumeSource({ ...source, status: 'running' }, `${entry.id}/r1`, lessonCases)).toThrow('terminal')
    expect(() => lessonResumeSource(source, `${entry.id}/r2`, lessonCases)).toThrow('exactly one')
    expect(() => lessonResumeSource({ ...source, results: [{ ...source.results[0], failure: null }] }, `${entry.id}/r1`, lessonCases)).toThrow('failed')
    expect(() => lessonResumeSource(source, `${entry.id}/r1`, [{ ...entry, objective: 'Changed objective.' }])).toThrow('differs')
  })
  it('retains the failed prefix unchanged when recovery succeeds', async () => {
    const source = await failedReport(), before = JSON.stringify(source)
    const selected = lessonResumeSource(source, `${entry.id}/r1`, lessonCases)
    const resumed = await runCase(entry, { mode: 'fixture' }, undefined, undefined, undefined, undefined, selected.artifacts)
    const result = combineLessonResume(selected.trial, resumed)
    expect(result.prepared).toBe(true)
    expect(result.calls.slice(0, selected.trial.calls.length)).toEqual(selected.trial.calls)
    expect(result.calls).toHaveLength(selected.trial.calls.length + resumed.calls.length)
    expect(result.calls.filter(c => c.failure)).toHaveLength(1)
    expect(result.durationMs).toBe(selected.trial.durationMs + resumed.durationMs)
    expect(JSON.stringify(source)).toBe(before)
  })
  it('runs the CLI with zero new API calls and separates recorded attempts from new dispatches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lesson-resume-cli-'))
    try {
      const source = await failedReport(), input = join(directory, 'source.json'), output = join(directory, 'resume.json')
      const text = JSON.stringify(source); await writeFile(input, text)
      await promisify(execFile)(process.execPath, ['scripts/evaluate-mandarin.mjs', '--suite', 'lessons', '--fixture', '--resume-from', input,
        '--resume-trial', `${entry.id}/r1`, '--out', output], { cwd: process.cwd(), maxBuffer: 1_000_000 })
      const result = JSON.parse(await readFile(output, 'utf8'))
      expect(result.status).toBe('finished')
      expect(result.summary.liveModelCalls).toBe(0)
      expect(result.runtime.generationPolicy).toMatchObject({ execution: { submissionAttempts: 2, requestAttempts: 2, requestTimeoutMs: 120_000, stageTimeoutMs: 510_000 },
        workflow: { maxRequests: 120, timeoutMs: 900_000 }, evaluation: { maxRequests: 120, timeBudgetMs: 900_000 } })
      expect(result.summary.recordedOriginalRequests).toBe(source.results[0]!.calls.length)
      expect(result.summary.requestsAttempted).toBe(result.results[0].calls.length)
      expect(result.summary.transportCalls).toBe(result.summary.resumedRequests)
      expect(result.results[0].calls.slice(0, source.results[0]!.calls.length)).toEqual(source.results[0]!.calls)
      expect(result.resumeSource.originalFailure.message).toContain('Authored checkpoint interruption')
      expect(await readFile(input, 'utf8')).toBe(text)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
