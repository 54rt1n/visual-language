import { evaluationProviders, type EvaluationProvider } from './model-matrix'
import 'fake-indexeddb/auto'
import { deleteDB } from 'idb'
import { streamChat } from '../../src/lib/ai/client'
import type { ChatOptions, ChatResult } from '../../src/lib/ai/types'
import { sameRecord } from '../../src/lib/domain/common'
import { exerciseSchema, type LeitnerCard } from '../../src/lib/domain/learning'
import { createWorkspace } from '../../src/lib/domain/workspace'
import { mandarinPinyin } from '../../src/lib/mandarin/chineseParser'
import { LearningService } from '../../src/lib/learning/learningService'
import { DAY, LEITNER_INTERVALS } from '../../src/lib/learning/leitner'
import { defaultSettings, providerDefaults } from '../../src/lib/settings'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { TeacherService, type TeacherHost } from '../../src/lib/teacher/teacherService'
import { GRADING_PROMPT_VERSION, validateTeacherAssessment } from '../../src/lib/teacher/feedback'
import { CORPUS_VERSION, mandarinCases, references, type MandarinCase } from './mandarin-corpus'

export { CORPUS_VERSION, mandarinCases, references }
export type RunConfig = { mode: 'fixture' } | { mode: 'live'; provider: EvaluationProvider; model: string; apiKey: string; confirmed: true }
type CallEvidence = { requestHash: string; request: Pick<ChatOptions, 'messages' | 'temperature' | 'maxTokens'>; durationMs: number; requestedModel: string; returnedModel?: string; response?: string; completed: boolean }
export type CaseResult = Awaited<ReturnType<typeof runCase>>
const START = Date.UTC(2026, 8, 1, 12)
export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('')
}
/** Defense in depth for exported provider text. Never record headers, keys,
 * environment, reasoning, stack traces or transport error bodies. */
export function redact<T>(value: T, secrets: string[]): T {
  const clean = (text: string) => secrets.filter(Boolean).reduce((next, secret) => next.split(secret).join('[REDACTED]'), text)
  const visit = (value: unknown): unknown => typeof value === 'string' ? clean(value) : Array.isArray(value) ? value.map(visit) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, val]) => [clean(key), visit(val)])) : value
  return visit(value) as T
}
function oracle(entry: MandarinCase, exerciseId: string) {
  return { exerciseId, grade: entry.expected.grade, criteria: entry.question.rubric.map((criterion, i) => ({ criterionId: criterion.id, met: entry.expected.criteria[i]!, evidence: entry.expected.rationale })), feedback: entry.expected.rationale, workedExample: entry.expected.example }
}
export function validateCorpus(cases = mandarinCases) {
  if (!cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('The corpus needs unique, nonempty case IDs.')
  for (const entry of cases) {
    if (!/^[a-z0-9-]+$/.test(entry.id) || !entry.tags.length || !entry.answer.trim()) throw new Error('A case needs an ID, categories and an answer.')
    if (entry.annotationStatus !== 'project-authored-provisional' || entry.expected.criteria.length !== entry.question.rubric.length || !entry.referenceIds.length || entry.referenceIds.some(id => !references.some(r => r.id === id))) throw new Error('Case annotations or references are inconsistent.')
    const exercise = exerciseSchema.parse({ ...entry.question, id: 'validation-exercise', sessionId: 'session', cardId: 'card', cardRevision: 0, mode: 'dueReview', format: 'freeAnswer', sourceIds: [], sourceNodeIds: [], presentedAt: START, provider: 'fixture', model: 'fixture', promptVersion: CORPUS_VERSION })
    validateTeacherAssessment(oracle(entry, exercise.id), exercise)
  }
  return { cases: cases.length, exact: cases.filter(c => c.question.answerPolicy === 'exact').length, contextual: cases.filter(c => c.question.answerPolicy === 'contextual').length }
}
export function fixtureTransport(entry: MandarinCase): typeof streamChat {
  return async options => {
    const message = options.messages.find(message => message.role === 'user')!
    if (typeof message.content !== 'string') throw new Error('Fixture grading input must be text JSON.')
    const input = JSON.parse(message.content) as { exercise: { id: string } }
    return { content: JSON.stringify(oracle(entry, input.exercise.id)), reasoning: '', toolCalls: [], finishReason: 'stop', model: 'authored-oracle-fixture' }
  }
}
const cardView = (card: LeitnerCard) => ({ box: card.box, dueAt: card.dueAt, revision: card.revision, lastTransitionAt: card.lastTransitionAt })

/** Uses the real repository, teacher prompt/repair/validation and scheduler.
 * The database is a uniquely named in-memory fake, never a learner database.
 * Corpus oracle labels are used only by fixtures and post-response comparison. */
export async function runCase(entry: MandarinCase, config: RunConfig, signal?: AbortSignal, fixtureOverride?: typeof streamChat) {
  validateCorpus([entry]); signal?.throwIfAborted()
  if (config.mode === 'live' && (!config.confirmed || !config.apiKey.trim() || !config.model.trim() || !evaluationProviders.includes(config.provider) || fixtureOverride)) throw new Error('Live runs require an explicit supported provider, model and key; fixture substitution is forbidden.')
  const settings = defaultSettings(), provider = config.mode === 'live' ? config.provider : 'featherless'
  settings.selected = provider
  settings.profiles[provider] = { ...providerDefaults[provider], model: config.mode === 'live' ? config.model : 'authored-oracle-fixture', apiKey: config.mode === 'live' ? config.apiKey : 'fixture-never-network', keyOrigin: new URL(providerDefaults[provider].baseUrl).origin }
  const secrets = [settings.profiles[provider].apiKey]
  const name = `mandarin-evaluation-${crypto.randomUUID()}`
  const repository = await WorkspaceRepository.open({ name, initial: () => createWorkspace(START), broadcast: false })
  const clock = { at: START, now() { return this.at } }, learning = new LearningService(repository, clock)
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(command) { snapshot = await command(snapshot, repository); return snapshot } }
  const calls: CallEvidence[] = []
  try {
    const rootId = snapshot.state.view.activeRootId
    await host.apply(s => learning.addItem(s, { language: 'zh', kind: 'phrase', canonicalText: entry.target.hanzi, meaning: entry.target.meaning, senseKey: entry.target.sense, pinyin: mandarinPinyin(entry.target.hanzi), sourceNodeIds: [rootId], sourceRootIds: [rootId] }, [entry.target.skill]))
    const cardId = snapshot.state.cards[0]!.id
    await host.apply(s => learning.introduce(s, cardId)); clock.at += DAY
    await host.apply(s => learning.startSession(s))
    let sessionId = snapshot.state.sessions[0]!.id
    // A real deterministic seed review establishes box 2 and an auditable history.
    await host.apply(s => learning.prepareExercise(s, sessionId, cardId, { format: 'freeAnswer', prompt: 'Fixture seed: copy the saved form.', expectedAnswer: entry.target.hanzi, acceptedAlternatives: [], rubric: [{ id: 'seed', description: 'Match the saved exact form.', required: true }], allowedAids: [], answerPolicy: 'exact', sourceIds: [], sourceNodeIds: [rootId], provider: 'fixture', model: 'fixture', promptVersion: 'evaluation-seed-v1' }))
    const seedExercise = snapshot.state.exercises[0]!, seedAttempt = `seed-${crypto.randomUUID()}`
    await host.apply(s => learning.submitAttempt(s, { id: seedAttempt, exerciseId: seedExercise.id, answer: entry.target.hanzi, submittedAt: clock.at }))
    await new TeacherService(host, () => settings, { clock, transport: async () => { throw new Error('The exact seed must not make a model call.') } }).gradeAttempt(seedAttempt)
    await host.apply(s => learning.finishExercise(s, seedExercise.id))
    await host.apply(s => learning.setSessionStatus(s, sessionId, 'completed')); clock.at += 3 * DAY
    await host.apply(s => learning.startSession(s)); sessionId = snapshot.state.sessions.at(-1)!.id
    await host.apply(s => learning.prepareExercise(s, sessionId, cardId, { ...entry.question, format: 'freeAnswer', sourceIds: [], sourceNodeIds: [rootId], provider: 'project-authored', model: 'none', promptVersion: CORPUS_VERSION }, Boolean(entry.practice)))
    const exercise = snapshot.state.exercises.at(-1)!, beforeHelp = cardView(snapshot.state.cards[0]!)
    if (entry.aid) await host.apply(s => learning.requestHelp(s, exercise.id, entry.aid!))
    const attemptId = `case-${crypto.randomUUID()}`, submittedAt = clock.at
    await host.apply(s => learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: entry.answer, submittedAt }))
    const before = cardView(snapshot.state.cards[0]!), eventsBefore = snapshot.state.events.length
    clock.at += 90_000 // Delayed assessment must still schedule from submission.
    const transport = config.mode === 'fixture' ? fixtureOverride ?? fixtureTransport(entry) : streamChat
    let serviceFailed = false
    const teacher = new TeacherService(host, () => settings, { clock, transport: async (options: ChatOptions): Promise<ChatResult> => {
      if (calls.length >= 2) throw new Error('Evaluation request budget exhausted; no additional model call was made.')
      const request = structuredClone({ messages: options.messages, temperature: options.temperature, maxTokens: options.maxTokens })
      const started = performance.now(), call: CallEvidence = { request, requestHash: await digest(JSON.stringify(request)), requestedModel: options.model, durationMs: 0, completed: false }
      calls.push(call)
      try { const result = await transport(options); call.returnedModel = result.model; call.response = result.content.slice(0, 32_000); call.completed = true; return result }
      finally { call.durationMs = Math.round(performance.now() - started) }
    } })
    try { await teacher.gradeAttempt(attemptId, signal) } catch { serviceFailed = true }
    const attempt = snapshot.state.attempts.find(a => a.id === attemptId)!, actual = attempt.assessment
    const after = cardView(snapshot.state.cards[0]!), events = snapshot.state.events.slice(eventsBefore)
    const resolved = !serviceFailed && actual && actual.grade !== 'uncertain'
    const schedulingEligible = !entry.practice && !entry.aid
    let expectedAfter = before
    if (resolved && schedulingEligible) {
      const box = actual.grade === 'correct' ? Math.min(before.box + 1, 5) as LeitnerCard['box'] : 1
      expectedAfter = { box, dueAt: submittedAt + LEITNER_INTERVALS[box - 1]! * DAY, revision: before.revision + 1, lastTransitionAt: submittedAt }
    }
    const scheduleInvariant = sameRecord(after, expectedAfter) && events.length === (resolved ? 1 : 0) && events.every(e => e.kind === (schedulingEligible ? 'review' : 'practice') && e.occurredAt === submittedAt)
    const gradeAgreement = !serviceFailed && actual?.grade === entry.expected.grade
    const criterionAgreement = Boolean(actual && entry.question.rubric.every((criterion, i) => actual.criteria.find(c => c.criterionId === criterion.id)?.met === entry.expected.criteria[i]))
    const saved = parseBackup(JSON.stringify(exportBackup(snapshot, clock.at))).data
    // Optional undefined properties have no representation in JSON. Compare all
    // portable fields, including complete records/history, not JS property presence.
    const backupRoundTrip = sameRecord(saved, JSON.parse(JSON.stringify(snapshot.state)))
    return redact({ caseId: entry.id, annotationStatus: entry.annotationStatus, tags: entry.tags, skill: entry.target.skill, answerPolicy: entry.question.answerPolicy,
      caseSnapshot: { target: entry.target, question: entry.question, answer: entry.answer, referenceIds: entry.referenceIds, aid: entry.aid ?? null, practice: Boolean(entry.practice) },
      expected: entry.expected, actual: actual ?? null, attemptStatus: attempt.status, assessmentSource: attempt.assessmentSource ?? null,
      requestedProvider: config.mode === 'live' ? config.provider : null, requestedEndpoint: config.mode === 'live' ? settings.profiles[provider].baseUrl : null, gradingProvider: attempt.gradingProvider ?? null, gradingModel: attempt.gradingModel ?? null,
      gradingPromptVersion: attempt.gradingPromptVersion ?? GRADING_PROMPT_VERSION, submittedAt, beforeHelp, before, after, calls,
      serviceFailed, cancelled: Boolean(signal?.aborted), gradeAgreement, criterionAgreement, scheduleInvariant, backupRoundTrip,
      falsePromotion: Boolean(entry.expected.grade !== 'correct' || entry.aid || entry.practice) && after.box > before.box,
      answerPreserved: attempt.answer === entry.answer, helpRecorded: attempt.helpUsed === Boolean(entry.aid),
      humanReview: { status: 'pending', checks: ['criterion evidence accuracy', 'Mandarin example correctness', 'whole-sentence translation fidelity', 'supportive feedback and source support'] },
    }, secrets)
  } finally { repository.close(); await deleteDB(name) }
}

export function summarize(results: CaseResult[], config: RunConfig, planned: number) {
  const contextual = results.filter(r => r.answerPolicy === 'contextual')
  const count = (rows: CaseResult[]) => ({ total: rows.length, gradeAgreement: rows.filter(r => r.gradeAgreement).length, criterionAgreement: rows.filter(r => r.criterionAgreement).length, serviceFailures: rows.filter(r => r.serviceFailed).length })
  const confusion: Record<string, Record<string, number>> = {}
  for (const result of contextual) { const expected = result.expected.grade, actual = result.serviceFailed ? 'service-error' : result.actual?.grade ?? 'missing'; (confusion[expected] ??= {})[actual] = (confusion[expected]?.[actual] ?? 0) + 1 }
  return { mode: config.mode, evidence: config.mode === 'fixture' ? 'Authored oracle fixtures: application contract evidence only, not model accuracy.' : 'Live server-side production grading path against provisional annotations; not browser CORS, human semantic review or release acceptance.',
    planned, completed: results.length, complete: results.length === planned, transportCalls: results.reduce((n, r) => n + r.calls.length, 0),
    liveModelCalls: config.mode === 'live' ? results.reduce((n, r) => n + r.calls.length, 0) : 0,
    all: count(results), contextual: count(contextual), exact: count(results.filter(r => r.answerPolicy === 'exact')), contextualConfusion: confusion,
    byTag: Object.fromEntries([...new Set(results.flatMap(r => r.tags))].sort().map(tag => [tag, count(results.filter(r => r.tags.includes(tag)))])),
    invariantFailures: results.filter(r => !r.scheduleInvariant || !r.backupRoundTrip || !r.answerPreserved || !r.helpRecorded).map(r => r.caseId),
    falsePromotions: results.filter(r => r.falsePromotion).map(r => r.caseId),
    gradeDisagreements: results.filter(r => !r.gradeAgreement).map(r => r.caseId),
    criterionDisagreements: results.filter(r => !r.criterionAgreement).map(r => r.caseId),
    releaseReady: false, humanReview: 'pending',
  }
}
