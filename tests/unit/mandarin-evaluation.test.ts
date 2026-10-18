import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import type { ChatOptions, ChatResult } from '../../src/lib/ai/types'
import { DAY } from '../../src/lib/learning/leitner'
import { fixtureTransport, mandarinCases, redact, runCase, summarize, validateCorpus } from '../evaluation/mandarin-runner'

const fixture = { mode: 'fixture' as const }
const byId = (id: string) => mandarinCases.find(entry => entry.id === id)!
describe('auditable Mandarin evaluation through the production grading path', () => {
  it('has explicit provisional annotations, complete criterion labels and required category coverage', () => {
    expect(validateCorpus()).toEqual({ cases: 27, exact: 8, contextual: 19 })
    const tags = new Set(mandarinCases.flatMap(entry => entry.tags))
    for (const tag of ['script-variant', 'pinyin-policy', 'tones', 'sense', 'paraphrase', 'partial-rubric', 'optional-criterion', 'uncertainty', 'untrusted-answer', 'aided', 'practice']) expect(tags.has(tag)).toBe(true)
    expect(() => validateCorpus([mandarinCases[0]!, mandarinCases[0]!])).toThrow('unique')
    const broken = structuredClone(byId('context-order-quantity')); broken.expected.grade = 'correct'
    expect(() => validateCorpus([broken])).toThrow('required criteria')
  })
  it.each(mandarinCases)('$id: authored fixture checks contracts, not semantic model accuracy', async entry => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture runs must not fetch'))
    const result = await runCase(entry, fixture)
    expect(network).not.toHaveBeenCalled()
    expect(result).toMatchObject({ caseId: entry.id, gradeAgreement: true, criterionAgreement: true, scheduleInvariant: true, backupRoundTrip: true, answerPreserved: true, helpRecorded: true, serviceFailed: false, falsePromotion: false })
    expect(result.beforeHelp.box).toBe(2)
    expect(result.calls).toHaveLength(entry.question.answerPolicy === 'exact' ? 0 : 1)
    expect(result.assessmentSource).toBe(entry.question.answerPolicy === 'exact' ? 'deterministic' : 'teacher')
    if (entry.expected.grade === 'uncertain') { expect(result.attemptStatus).toBe('needsReview'); expect(result.after).toEqual(result.before); expect(result.actual?.workedExample).toBeUndefined() }
    else if (entry.aid) { expect(result.after.box).toBe(1); expect(result.after).toEqual(result.before) }
    else if (entry.practice) { expect(result.after.box).toBe(2); expect(result.after).toEqual(result.before) }
    else { expect(result.after.box).toBe(entry.expected.grade === 'correct' ? 3 : 1); expect(result.after.dueAt).toBe(result.submittedAt + (entry.expected.grade === 'correct' ? 7 : 1) * DAY) }
    expect(summarize([result], fixture, 1)).toMatchObject({ releaseReady: false, humanReview: 'pending', evidence: expect.stringContaining('not model accuracy') })
  })
  it('does not send provisional oracle labels or rationales to the grader', async () => {
    const entry = byId('context-order-temperature'), respond = fixtureTransport(entry)
    const transport = vi.fn(async (options: ChatOptions) => {
      const serialized = JSON.stringify(options.messages)
      expect(serialized).not.toContain(entry.expected.rationale)
      expect(serialized).not.toContain(entry.annotationStatus)
      expect(serialized).not.toContain('fixture-never-network')
      expect(serialized).toContain(entry.answer)
      expect(serialized).toContain(entry.question.rubric[0]!.description)
      expect(options.temperature).toBe(0.2); expect(options.tools).toBeUndefined()
      return respond(options)
    })
    const result = await runCase(entry, fixture, undefined, transport)
    expect(transport).toHaveBeenCalledTimes(1); expect(result.gradeAgreement).toBe(true)
    expect(result.calls[0]!.requestHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it('reports a schema-valid semantic mistake and false promotion instead of calling it a passing evaluation', async () => {
    const entry = byId('context-order-quantity'), respond = fixtureTransport(entry)
    const result = await runCase(entry, fixture, undefined, async options => {
      const reply = await respond(options), value = JSON.parse(reply.content)
      value.grade = 'correct'; value.criteria.forEach((criterion: { met: boolean }) => { criterion.met = true })
      return { ...reply, content: JSON.stringify(value), model: 'deliberately-wrong-fixture' }
    })
    expect(result).toMatchObject({ gradeAgreement: false, criterionAgreement: false, serviceFailed: false, scheduleInvariant: true, falsePromotion: true })
    const summary = summarize([result], fixture, 1)
    expect(summary.contextualConfusion).toEqual({ incorrect: { correct: 1 } })
    expect(summary.falsePromotions).toEqual([entry.id]); expect(summary.releaseReady).toBe(false)
  })
  it('distinguishes malformed responses from genuine uncertainty and preserves the original answer after one repair', async () => {
    const malformed = vi.fn(async (): Promise<ChatResult> => ({ content: '{', reasoning: '', toolCalls: [], finishReason: 'stop', model: 'broken-fixture' }))
    const result = await runCase(byId('context-missing-passage'), fixture, undefined, malformed)
    expect(malformed).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ serviceFailed: true, actual: null, gradeAgreement: false, attemptStatus: 'needsReview', scheduleInvariant: true, answerPreserved: true, backupRoundTrip: true })
    expect(result.after).toEqual(result.before)
    expect(summarize([result], fixture, 1).contextualConfusion).toEqual({ uncertain: { 'service-error': 1 } })
  })
  it('records cancellation as interrupted service work, never a learner error or an uncertain model judgment', async () => {
    const controller = new AbortController()
    const result = await runCase(byId('context-gratitude-paraphrase'), fixture, controller.signal, async options => {
      controller.abort(new DOMException('Fixture cancelled', 'AbortError'))
      options.handlers!.signal!.throwIfAborted()
      throw new Error('Unreachable')
    })
    expect(result).toMatchObject({ cancelled: true, serviceFailed: true, gradeAgreement: false, scheduleInvariant: true, actual: null, answerPreserved: true })
    expect(result.calls).toHaveLength(1); expect(result.calls[0]!.completed).toBe(false)
  })
  it('redacts key echoes in model IDs, feedback, raw responses and object keys', async () => {
    const entry = byId('context-gratitude-paraphrase'), respond = fixtureTransport(entry), secret = 'fixture-never-network'
    const result = await runCase(entry, fixture, undefined, async options => {
      const reply = await respond(options), value = JSON.parse(reply.content); value.feedback = secret
      return { ...reply, content: JSON.stringify(value), model: secret }
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.gradingModel).toBe('[REDACTED]')
    expect(redact({ [secret]: [secret] }, [secret])).toEqual({ '[REDACTED]': ['[REDACTED]'] })
  })
  it('refuses missing live authority and fixture substitution before making a request', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live calls in tests'))
    await expect(runCase(byId('context-gratitude-paraphrase'), { mode: 'live', provider: 'nebius', apiKey: '', model: 'explicit-model', confirmed: true })).rejects.toThrow('explicit')
    await expect(runCase(byId('context-gratitude-paraphrase'), { mode: 'live', provider: 'nebius', apiKey: 'fixture', model: 'explicit-model', confirmed: true }, undefined, fixtureTransport(mandarinCases[0]!))).rejects.toThrow('substitution')
    expect(network).not.toHaveBeenCalled()
  })
  it('CLI catalogue is network-free and a fixture report never overwrites an existing file', async () => {
    const exec = promisify(execFile), directory = await mkdtemp(join(tmpdir(), 'mandarin-cli-test-')), output = join(directory, 'fixture.json')
    try {
      const listed = await exec('node', ['scripts/evaluate-mandarin.mjs', '--case', 'exact-whitespace'])
      expect(JSON.parse(listed.stdout)).toMatchObject({ callsMade: 0, counts: { cases: 1, exact: 1 } })
      await exec('node', ['scripts/evaluate-mandarin.mjs', '--fixture', '--case', 'exact-whitespace', '--out', output])
      const saved = await readFile(output, 'utf8'), report = JSON.parse(saved)
      expect(report).toMatchObject({ status: 'finished', fullCorpusSelected: false, runtime: { browserCorsVerified: false }, summary: { complete: true, liveModelCalls: 0, releaseReady: false } })
      expect(report.corpusHash).toMatch(/^[a-f0-9]{64}$/)
      await expect(exec('node', ['scripts/evaluate-mandarin.mjs', '--fixture', '--case', 'exact-whitespace', '--out', output])).rejects.toThrow()
      expect(await readFile(output, 'utf8')).toBe(saved)
      await expect(exec('node', ['scripts/evaluate-mandarin.mjs', '--provider', 'nebius', '--model', 'explicit-model'])).rejects.toThrow('confirm-live')
    } finally { await rm(directory, { recursive: true, force: true }) } // Exact test-created temporary directory only.
  }, 20_000)
})
