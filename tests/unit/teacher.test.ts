import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nid } from '../../src/lib/id'
import { defaultSettings } from '../../src/lib/settings'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { LearningService } from '../../src/lib/learning/learningService'
import { DAY } from '../../src/lib/learning/leitner'
import { TeacherService, type TeacherHost } from '../../src/lib/teacher/teacherService'
import { GraphService } from '../../src/lib/graph/graphService'
import { sessionSummary } from '../../src/lib/teacher/teacherContext'
import type { ChatOptions, ChatResult } from '../../src/lib/ai/types'
import type { QuizDraft } from '../../src/lib/learning/quiz'
import { highlightParts, historySources, searchLearningHistory } from '../../src/lib/search/searchService'
import { mandarinChunks, revealsProductionAnswer } from '../../src/lib/mandarin/chineseParser'
import { exerciseProposal, newCard, NOW, workspaceFixture } from './fixtures'
import { THANKS_EXAMPLE } from '../fixtures/worked-examples'
import { completeWorkedExample, feedbackMaterial } from '../../src/lib/teacher/feedback'
import { studentQuestion } from '../../src/lib/learning/quiz'
import { recoverableQuizzes } from '../../src/lib/teacher/quizRecovery'

const repositories: WorkspaceRepository[] = []
afterEach(() => { repositories.forEach(r => r.close()); repositories.length = 0 })
const json = (value: unknown): ChatResult => ({ content: JSON.stringify(value), reasoning: '', toolCalls: [], finishReason: 'stop', model: 'actual-fixture-model' })
const call = (name: string, value: unknown, id = nid('call')): ChatResult => ({ ...json(null), content: '', finishReason: 'tool_calls', toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(value) } }] })
function inputWith(options: ChatOptions, key: string) {
  for (const message of [...options.messages].reverse()) if (message.role === 'user') {
    try { const value = JSON.parse(message.content); if (value[key]) return value } catch { /* repair instructions are plain text */ }
  }
  throw new Error(`Fixture expected input ${key}`)
}
function quizFor(options: ChatOptions): QuizDraft {
  const input = inputWith(options, 'targets')
  return { title: 'Fixture recognition quiz', questions: input.targets.map((entry: { target: { cardId: string } }) => ({
    cardId: entry.target.cardId, stem: 'Which expression thanks someone?',
    options: [{ id: 'thanks', text: '谢谢' }, { id: 'hello', text: '你好' }, { id: 'bye', text: '再见' }, { id: 'welcome', text: '不客气' }],
    correctOptionId: 'thanks', explanation: '谢谢 expresses thanks.', objective: 'Recognize the Mandarin expression for thanks.',
    distractorFeedback: ['hello', 'bye', 'welcome'].map(optionId => ({ optionId, explanation: 'This expression does not mean thank you.' })),
    sourceIds: [input.sources[0].id], workedExample: THANKS_EXAMPLE,
  })) }
}
function contentReview(options: ChatOptions, supported = true) {
  const { quiz } = inputWith(options, 'quiz')
  return json({ verdict: supported ? 'supported' : 'uncertain', reasons: 'Labeled fixture content review; not live model evidence.',
    questions: quiz.questions.map((q: { cardId: string }) => ({ cardId: q.cardId, oneCorrectAnswer: true, sourceSupported: supported, skillAligned: true, answerHidden: true, levelAppropriate: true, evidence: 'Fixture source explicitly gives the meaning of thanks.' })) })
}
async function setup(skill: 'production' | 'recognition' = 'production', introduced = true) {
  const repository = await WorkspaceRepository.open({ name: nid('teacher-test'), initial: workspaceFixture, broadcast: false }); repositories.push(repository)
  const clock = { at: NOW, now() { return this.at } }, learning = new LearningService(repository, clock)
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(command) { snapshot = await command(snapshot, repository); return snapshot } }
  await host.apply(s => learning.addItem(s, { language: 'zh', kind: 'phrase', canonicalText: '谢谢', pinyin: 'xiè xie', senseKey: 'thanks', meaning: 'thank you', sourceNodeIds: ['root'], sourceRootIds: ['root'] }, [skill]))
  const cardId = snapshot.state.cards[0]!.id
  if (introduced) { await host.apply(s => learning.introduce(s, cardId)); clock.at += DAY }
  await host.apply(s => learning.startSession(s))
  const sessionId = snapshot.state.sessions[0]!.id, settings = defaultSettings()
  settings.selected = 'featherless'; settings.profiles.featherless.apiKey = 'fixture-secret-never-in-context'; settings.profiles.featherless.keyOrigin = 'https://api.featherless.ai'
  settings.tavily.apiKey = 'fixture-tavily-never-in-context'
  return { repository, host, learning, clock, cardId, sessionId, settings }
}

describe('inactive native quiz recovery', () => {
  async function interrupted() {
    const h = await setup('recognition')
    const transport = vi.fn(async (options: ChatOptions) => {
      if (options.tools) return call('draft_multiple_choice_quiz', quizFor(options))
      throw new Error('Content-review network interruption')
    })
    const tavilyFetcher = vi.fn(() => { throw new Error('Recovery must not search.') }) as unknown as typeof fetch
    const random = vi.fn(() => 0), teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport, tavilyFetcher, random })
    await expect(teacher.draftQuiz([h.cardId], { sessionId: h.sessionId })).rejects.toThrow('interruption')
    const draft = h.host.current().state.drafts.find(d => d.kind === 'quiz')!
    return { ...h, teacher, transport, tavilyFetcher, random, draft }
  }
  it('reviews the frozen candidate once without search or generation, keeping target preferences and options through restore', async () => {
    const h = await interrupted(), before = structuredClone(h.host.current().state)
    expect(h.draft.status).toBe('pending'); expect(before.exercises).toHaveLength(0)
    await h.host.apply((s, r) => r.mutate(s.version, { id: 'edit-later-preferences', kind: 'fixture', at: h.clock.at, intent: {} }, state => {
      state.items[0]!.meaning = 'A later edited description'; state.learners[0]!.level = 'advanced'
    }))
    h.transport.mockImplementation(async options => {
      expect(options.tools).toBeUndefined()
      const input = inputWith(options, 'quiz')
      expect(input.quiz).toEqual(h.draft.quiz)
      expect(input.targets[0]).toMatchObject({ cardId: h.cardId, meaning: 'thank you', level: 'beginner' })
      expect(input.sources.map((s: { id: string }) => s.id)).toEqual(h.draft.sourceIds)
      return contentReview(options)
    })
    const reviewed = await h.teacher.reviewQuiz(h.draft.id)
    expect(reviewed.status).toBe('validated'); expect(h.transport).toHaveBeenCalledTimes(3)
    expect(h.tavilyFetcher).not.toHaveBeenCalled()
    expect(h.host.current().state.cards).toEqual(before.cards); expect(h.host.current().state.events).toEqual(before.events)
    const samples = h.random.mock.calls.length
    expect((await h.teacher.reviewQuiz(h.draft.id)).quiz).toEqual(reviewed.quiz)
    expect(h.random).toHaveBeenCalledTimes(samples); expect(h.transport).toHaveBeenCalledTimes(3)
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.drafts.find(d => d.id === reviewed.id)).toEqual(reviewed)
  })
  it('keeps malformed and cancelled content reviews inactive and ignores a late review after explicit discard', async () => {
    const h = await interrupted(), before = structuredClone(h.host.current().state)
    h.transport.mockImplementation(async () => json({ verdict: 'supported', questions: [] }))
    await expect(h.teacher.reviewQuiz(h.draft.id)).rejects.toThrow()
    expect(h.host.current().state).toEqual(before)
    const controller = new AbortController()
    h.transport.mockImplementation(async options => { controller.abort(); return contentReview(options) })
    await expect(h.teacher.reviewQuiz(h.draft.id, controller.signal)).rejects.toThrow()
    expect(h.host.current().state).toEqual(before)
    h.transport.mockImplementation(async options => { await h.teacher.discardQuiz(h.draft.id); return contentReview(options) })
    await expect(h.teacher.reviewQuiz(h.draft.id)).rejects.toThrow('discarded')
    expect(h.host.current().state.drafts.find(d => d.id === h.draft.id)).toMatchObject({ status: 'pending', discardedAt: h.clock.at })
    expect(recoverableQuizzes(h.host.current().state)).toHaveLength(0)
    expect(h.host.current().state.cards).toEqual(before.cards); expect(h.host.current().state.events).toEqual(before.events)
    const count = h.transport.mock.calls.length
    await expect(h.teacher.regenerateQuiz(h.draft.id)).rejects.toThrow('discarded')
    expect(h.transport).toHaveBeenCalledTimes(count)
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.drafts.find(d => d.id === h.draft.id)!.quiz).toEqual(h.draft.quiz)
  })
  it('keeps unsupported review reasons private and permits an explicit later review', async () => {
    const h = await interrupted()
    h.transport.mockImplementation(async options => { const value = JSON.parse(contentReview(options, false).content); value.reasons = 'ANSWER_LEAK: 谢谢 is the answer.'; return json(value) })
    await expect(h.teacher.reviewQuiz(h.draft.id)).rejects.toThrow('not activated')
    const rejected = h.host.current().state.drafts.find(d => d.id === h.draft.id)!
    expect(rejected).toMatchObject({ status: 'rejected', contentReview: { verdict: 'uncertain', reasons: 'ANSWER_LEAK: 谢谢 is the answer.' } })
    expect(rejected.quiz).toEqual(h.draft.quiz)
    h.transport.mockImplementation(async options => contentReview(options))
    expect((await h.teacher.reviewQuiz(h.draft.id)).status).toBe('validated')
  })
  it('does not archive the old candidate when regeneration fails before saving a replacement', async () => {
    const h = await interrupted(), before = structuredClone(h.host.current().state)
    h.transport.mockImplementation(async () => { throw new Error('Generation failed') })
    await expect(h.teacher.regenerateQuiz(h.draft.id)).rejects.toThrow('Generation failed')
    expect(h.host.current().state).toEqual(before)
    h.transport.mockImplementation(async options => call('draft_multiple_choice_quiz', quizFor(options))) // Identical question is not a regeneration.
    await expect(h.teacher.regenerateQuiz(h.draft.id)).rejects.toThrow()
    expect(h.host.current().state).toEqual(before)
  })
  it('stops on a failed candidate save without archiving or spending a model repair on a storage error', async () => {
    const h = await interrupted(), before = structuredClone(h.host.current().state), count = h.transport.mock.calls.length
    h.transport.mockImplementation(async options => {
      expect(options.tools).toBeDefined()
      const quiz = quizFor(options); quiz.questions[0]!.stem = 'A colleague helps you. Choose the expression of gratitude.'
      const result = call('draft_multiple_choice_quiz', quiz)
      return { ...result, toolCalls: [...result.toolCalls, { ...result.toolCalls[0]!, id: 'duplicate-after-failed-save' }] }
    })
    const mutate = vi.spyOn(h.repository, 'mutate').mockRejectedValueOnce(new DOMException('Fixture storage quota', 'QuotaExceededError'))
    try { await expect(h.teacher.regenerateQuiz(h.draft.id)).rejects.toThrow('could not be saved') } finally { mutate.mockRestore() }
    expect(h.host.current().state).toEqual(before); expect(h.transport).toHaveBeenCalledTimes(count + 1)
  })
  it('atomically retains an archived predecessor when a replacement saves but its review is interrupted', async () => {
    const h = await interrupted(), before = structuredClone(h.host.current().state)
    h.transport.mockImplementation(async options => {
      if (!options.tools) throw new Error('Replacement review interrupted')
      expect(options.tools.map(t => t.function.name)).toEqual(['draft_multiple_choice_quiz'])
      const input = inputWith(options, 'targets')
      expect(input.sources.map((s: { id: string }) => s.id)).toEqual(h.draft.sourceIds)
      expect(input.targets[0].target).toMatchObject({ cardId: h.cardId, meaning: 'thank you' })
      const quiz = quizFor(options); quiz.questions[0]!.stem = 'A friend helped you. Which expression conveys thanks?'
      return call('draft_multiple_choice_quiz', quiz)
    })
    await expect(h.teacher.regenerateQuiz(h.draft.id)).rejects.toThrow('Replacement review interrupted')
    const replacement = recoverableQuizzes(h.host.current().state)[0]!
    expect(replacement).toMatchObject({ status: 'pending', replacesDraftId: h.draft.id, sessionId: h.sessionId, quizTargets: h.draft.quizTargets })
    expect(h.host.current().state.drafts.find(d => d.id === h.draft.id)).toMatchObject({ discardedAt: h.clock.at, quiz: h.draft.quiz })
    expect(h.host.current().state.cards).toEqual(before.cards); expect(h.host.current().state.events).toEqual(before.events)
    h.transport.mockImplementation(async options => contentReview(options))
    await h.teacher.reviewQuiz(replacement.id)
    const restored = parseBackup(JSON.stringify(exportBackup(h.host.current())))
    expect(restored.data.drafts.filter(d => d.kind === 'quiz')).toHaveLength(2)
    expect(h.tavilyFetcher).not.toHaveBeenCalled()
    const malformed = structuredClone(restored)
    malformed.data.drafts.find(d => d.id === replacement.id)!.replacesDraftId = 'missing'
    expect(() => parseBackup(JSON.stringify(malformed))).toThrow('archived predecessor')
    await expect(h.teacher.discardQuiz(replacement.id)).rejects.toThrow('frozen')
    await expect(h.teacher.regenerateQuiz(replacement.id)).rejects.toThrow('frozen')
  })
  it('uses an unpresented reviewed quiz in a new session without a key, respecting actual current eligibility', async () => {
    const h = await interrupted()
    h.transport.mockImplementation(async options => contentReview(options))
    await h.teacher.reviewQuiz(h.draft.id)
    await h.host.apply(s => h.learning.setSessionStatus(s, h.sessionId, 'completed'))
    await h.host.apply(s => h.learning.startSession(s))
    const sessionId = h.host.current().state.sessions.at(-1)!.id, before = structuredClone(h.host.current().state.cards), calls = h.transport.mock.calls.length
    h.settings.profiles.featherless.apiKey = ''
    await h.teacher.useReviewedQuiz(sessionId, h.draft.id)
    expect(h.host.current().state.exercises[0]).toMatchObject({ sessionId, cardId: h.cardId, mode: 'dueReview', multipleChoice: { quizId: h.draft.id } })
    expect(h.host.current().state.cards).toEqual(before); expect(h.transport).toHaveBeenCalledTimes(calls)
    await expect(h.teacher.useReviewedQuiz(sessionId, h.draft.id)).rejects.toThrow('pending question')
    await expect(h.teacher.discardQuiz(h.draft.id)).rejects.toThrow('frozen')
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.exercises).toHaveLength(1)
  })
  it('restores a legacy candidate without target snapshots and adds them only on explicit review', async () => {
    const h = await interrupted(), legacy = exportBackup(h.host.current())
    delete legacy.data.drafts.find(d => d.id === h.draft.id)!.quizTargets
    const restored = parseBackup(JSON.stringify(legacy))
    await h.host.apply((s, r) => r.replace(s.version, restored.data))
    expect(h.host.current().state.drafts.find(d => d.id === h.draft.id)!.quizTargets).toBeUndefined()
    h.transport.mockImplementation(async options => contentReview(options))
    const reviewed = await h.teacher.reviewQuiz(h.draft.id)
    expect(reviewed.quizTargets?.[0]).toMatchObject({ cardId: h.cardId, skill: 'recognition', meaning: 'thank you' })
    expect(h.transport).toHaveBeenCalledTimes(3)
  })
  it('does not change learning state when a recovered quiz lies outside the new topic scope', async () => {
    const h = await interrupted()
    h.transport.mockImplementation(async options => contentReview(options)); await h.teacher.reviewQuiz(h.draft.id)
    await h.host.apply(s => h.learning.setSessionStatus(s, h.sessionId, 'completed'))
    await h.host.apply((s, r) => new GraphService(r, h.clock).createTopic(s, 'Unrelated topic'))
    const rootId = h.host.current().state.nodes.find(n => n.type === 'root' && n.id !== 'root')!.id
    await h.host.apply(s => h.learning.startSession(s, rootId))
    const before = structuredClone(h.host.current().state), sessionId = before.sessions.at(-1)!.id
    await expect(h.teacher.useReviewedQuiz(sessionId, h.draft.id)).rejects.toThrow('outside the focused lesson topic')
    expect(h.host.current().state).toEqual(before)
  })
})

describe('worked-example persistence and recovery', () => {
  async function pendingLegacy() {
    const h = await setup()
    await h.host.apply(s => h.learning.prepareExercise(s, h.sessionId, h.cardId, exerciseProposal({ answerPolicy: 'contextual' })))
    const exercise = h.host.current().state.exercises[0]!
    await h.host.apply(s => h.learning.submitAttempt(s, { id: 'legacy', exerciseId: exercise.id, answer: '你好', submittedAt: h.clock.at }))
    return { ...h, exercise }
  }
  async function committedLegacy() {
    const h = await pendingLegacy()
    await h.host.apply(s => h.learning.assessAttempt(s, 'legacy', { exerciseId: h.exercise.id, grade: 'incorrect',
      criteria: [{ criterionId: 'meaning', met: false, evidence: 'A greeting does not express thanks.' }], feedback: 'Try the thanks expression.', correctedExample: '谢谢你的帮助。' }, { source: 'teacher', provider: 'fixture', model: 'old-model', promptVersion: 'legacy-grade-v1' }))
    return h
  }
  it.each([
    ['missing example', undefined],
    ['missing translation', { hanzi: THANKS_EXAMPLE.hanzi, explanation: THANKS_EXAMPLE.explanation }],
    ['English instead of Mandarin', { ...THANKS_EXAMPLE, hanzi: 'Thank you.' }],
    ['null example on a resolved grade', null],
  ])('preserves the saved answer and schedule after one failed repair: %s', async (_label, workedExample) => {
    const h = await pendingLegacy(), before = structuredClone(h.host.current().state)
    const transport = vi.fn(async () => json({ exerciseId: h.exercise.id, grade: 'incorrect', criteria: [{ criterionId: 'meaning', met: false, evidence: 'Greeting instead of thanks.' }], feedback: 'Use thanks.', workedExample }))
    await expect(new TeacherService(h.host, () => h.settings, { clock: h.clock, transport }).gradeAttempt('legacy')).rejects.toThrow('schedule were preserved')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(h.host.current().state.cards).toEqual(before.cards)
    expect(h.host.current().state.events).toEqual(before.events)
    expect(h.host.current().state.attempts[0]).toMatchObject({ answer: '你好', status: 'needsReview' })
    expect(h.host.current().state.attempts[0]!.assessment).toBeUndefined()
  })
  it('stores a separate explicit repair for an older result, retains legacy text and restores without regeneration', async () => {
    const h = await committedLegacy(), before = structuredClone(h.host.current().state)
    expect(feedbackMaterial(before, h.exercise, before.attempts[0])).toBeUndefined()
    const legacy = parseBackup(JSON.stringify(exportBackup(h.host.current())))
    expect(legacy.data.attempts[0]!.assessment!.correctedExample).toBe(THANKS_EXAMPLE.hanzi)
    const transport = vi.fn(async (options: ChatOptions) => {
      expect(options.tools).toBeUndefined()
      const input = inputWith(options, 'originalAssessment')
      expect(input.originalAssessment.grade).toBe('incorrect')
      expect(input.answer).toBe('你好')
      expect(input.effectiveResult).toEqual([{ outcome: 'notRecalled', corrected: false, disputed: false }])
      return json(THANKS_EXAMPLE)
    })
    const tavilyFetcher = vi.fn(() => { throw new Error('Feedback repair cannot search.') }) as unknown as typeof fetch
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport, tavilyFetcher })
    const draft = await teacher.explainAttempt('legacy')
    expect(draft).toMatchObject({ kind: 'feedback', attemptId: 'legacy', status: 'validated', workedExample: completeWorkedExample(THANKS_EXAMPLE), generation: { model: 'actual-fixture-model' } })
    const restored = parseBackup(JSON.stringify(exportBackup(h.host.current()))).data
    expect(restored.cards).toEqual(before.cards); expect(restored.events).toEqual(before.events); expect(restored.attempts).toEqual(before.attempts)
    expect(feedbackMaterial(restored, restored.exercises[0]!, restored.attempts[0])?.example.meaning).toBe(THANKS_EXAMPLE.meaning)
    expect(restored.sources.filter(s => draft.sourceIds.includes(s.id))).toHaveLength(draft.sourceIds.length)
    expect(draft.sourceIds.length).toBeGreaterThan(0)
    const invalid = structuredClone(exportBackup(h.host.current()))
    invalid.data.drafts.find(d => d.id === draft.id)!.attemptId = 'missing-attempt'
    expect(() => parseBackup(JSON.stringify(invalid))).toThrow('committed answer')
    h.settings.profiles.featherless.apiKey = ''
    const reopened = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport, tavilyFetcher })
    expect((await reopened.explainAttempt('legacy')).id).toBe(draft.id)
    expect(transport).toHaveBeenCalledTimes(1); expect(tavilyFetcher).not.toHaveBeenCalled()
  })
  it('rejects implicit regrading fields and cancels a late result without saving teaching material', async () => {
    const h = await committedLegacy(), before = structuredClone(h.host.current().state)
    const transport = vi.fn(async () => json({ ...THANKS_EXAMPLE, grade: 'correct' }))
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    await expect(teacher.explainAttempt('legacy')).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(2)
    expect(h.host.current().state).toEqual(before)
    const controller = new AbortController()
    transport.mockImplementation(async () => { controller.abort(); return json(THANKS_EXAMPLE) })
    await expect(teacher.explainAttempt('legacy', controller.signal)).rejects.toThrow()
    expect(h.host.current().state).toEqual(before)
    expect(h.host.current().state.drafts.filter(d => d.kind === 'feedback')).toHaveLength(0)
  })
  it('does not prepare feedback for an unanswered assessment', async () => {
    const h = await pendingLegacy(), transport = vi.fn(async () => json(THANKS_EXAMPLE))
    await expect(new TeacherService(h.host, () => h.settings, { clock: h.clock, transport }).explainAttempt('legacy')).rejects.toThrow('Resolve the saved answer')
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('active teacher orchestration', () => {
  it('captures a derived source-linked chunk and teaches without inventing progress', async () => {
    const h = await setup('production', false), before = h.host.current().state.cards
    const transport = vi.fn(async (options: ChatOptions) => {
      const input = inputWith(options, 'target')
      expect(JSON.stringify(options.messages)).not.toContain('fixture-secret')
      return json({ explanation: 'Use this to thank someone.', exampleHanzi: '谢谢你的帮助。', exampleMeaning: 'Thank you for your help.', sourceIds: [input.sources[0].id] })
    })
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    const material = await teacher.teach(h.cardId)
    expect(material.lesson?.examplePinyin).toContain('xiè')
    expect(material.generation?.model).toBe('actual-fixture-model')
    expect(h.host.current().state.cards).toEqual(before)
    expect(h.host.current().state.nodes.filter(n => n.type === 'chunk')).toHaveLength(1)
    expect(h.host.current().state.edges[0]?.data.kind).toBe('derived')
    await h.host.apply(s => h.learning.introduce(s, h.cardId, h.sessionId))
    expect(h.host.current().state.cards[0]).toMatchObject({ box: 1, status: 'active', dueAt: NOW + DAY })
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('freezes the rubric before display and persists answers before model grading', async () => {
    const h = await setup()
    const transport = vi.fn(async (options: ChatOptions) => {
      if (options.messages[0]!.content!.includes('Prepare one')) {
        const input = inputWith(options, 'target')
        const { format: _format, sourceNodeIds: _nodes, provider: _provider, model: _model, promptVersion: _version, ...proposal } = exerciseProposal({ answerPolicy: 'contextual' })
        return json({ ...proposal, sourceIds: [input.sources[0].id], workedExample: THANKS_EXAMPLE })
      }
      const input = inputWith(options, 'exercise')
      expect((await h.repository.snapshot()).state.attempts[0]).toMatchObject({ answer: '谢谢你的帮助。', status: 'pending' })
      return json({ exerciseId: input.exercise.id, grade: 'correct', criteria: [{ criterionId: 'meaning', met: true, evidence: 'Thanks are expressed in Mandarin.' }], feedback: 'Correct contextual thanks.', workedExample: THANKS_EXAMPLE })
    })
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    await teacher.prepareFreeExercise(h.sessionId, h.cardId)
    const exercise = h.host.current().state.exercises[0]!
    expect((await h.repository.snapshot()).state.exercises[0]).toEqual(exercise)
    expect(exercise.workedExample).toEqual(completeWorkedExample(THANKS_EXAMPLE))
    expect(h.host.current().state.nodes.some(n => n.type === 'exercise' && n.data.exerciseId === exercise.id)).toBe(true)
    await h.host.apply(s => h.learning.submitAttempt(s, { id: 'answer', exerciseId: exercise.id, answer: '谢谢你的帮助。', submittedAt: h.clock.at }))
    await teacher.gradeAttempt('answer')
    await teacher.gradeAttempt('answer')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(h.host.current().state.cards[0]).toMatchObject({ box: 2, dueAt: h.clock.at + 3 * DAY })
    expect(h.host.current().state.attempts[0]!.assessment!.workedExample).toEqual(completeWorkedExample(THANKS_EXAMPLE))
    expect(sessionSummary(h.host.current().state, h.sessionId, h.clock.at)).toMatchObject({ reviewed: 1, recalled: 1 })
  })
  it('invalid grading exhausts one repair, retains the answer and retries at the original time', async () => {
    const h = await setup()
    await h.host.apply(s => h.learning.prepareExercise(s, h.sessionId, h.cardId, exerciseProposal({ answerPolicy: 'contextual' })))
    const exercise = h.host.current().state.exercises[0]!, submittedAt = h.clock.at
    await h.host.apply(s => h.learning.submitAttempt(s, { id: 'pending', exerciseId: exercise.id, answer: '谢谢', submittedAt }))
    const before = h.host.current().state.cards, transport = vi.fn(async () => json({ grade: 'invented' }))
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    await expect(teacher.gradeAttempt('pending')).rejects.toThrow('schedule were preserved')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(h.host.current().state.cards).toEqual(before)
    expect(h.host.current().state.attempts[0]).toMatchObject({ answer: '谢谢', status: 'needsReview' })
    h.clock.at += 5 * DAY
    transport.mockImplementation(async () => json({ exerciseId: exercise.id, grade: 'correct', criteria: [{ criterionId: 'meaning', met: true, evidence: 'Matches the thanks sense.' }], feedback: 'Correct.', workedExample: THANKS_EXAMPLE }))
    await teacher.gradeAttempt('pending')
    expect(h.host.current().state.cards[0]!.dueAt).toBe(submittedAt + 3 * DAY)
  })
  it('performs the native quiz round trip, freezes shuffled options and grades locally', async () => {
    const h = await setup('recognition'), before = h.host.current().state.cards
    const transport = vi.fn(async (options: ChatOptions) => {
      if (options.tools) return call('draft_multiple_choice_quiz', quizFor(options), 'quiz-native')
      expect(options.messages.some(m => m.role === 'assistant' && m.tool_calls?.[0]?.id === 'quiz-native')).toBe(true)
      expect(options.messages.some(m => m.role === 'tool' && m.tool_call_id === 'quiz-native' && JSON.parse(m.content).ok)).toBe(true)
      expect(JSON.stringify(options.messages)).not.toContain('fixture-secret-never-in-context')
      return contentReview(options)
    })
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport, random: () => 0 })
    const { draft } = await teacher.draftQuiz([h.cardId], { sessionId: h.sessionId })
    expect(h.host.current().state.cards).toEqual(before)
    expect(draft.quiz!.questions[0]!.options[0]!.id).not.toBe('thanks')
    expect(studentQuestion(draft.quiz!.questions[0]!)).not.toHaveProperty('workedExample')
    await teacher.presentQuizQuestion(h.sessionId, draft.id, 0)
    const exercise = h.host.current().state.exercises[0]!
    await h.host.apply(s => h.learning.saveAnswerDraft(s, exercise.id, '', 'draft-option', 'thanks'))
    const restored = parseBackup(JSON.stringify(exportBackup(h.host.current())))
    expect(restored.data.exercises[0]!.multipleChoice!.options).toEqual(draft.quiz!.questions[0]!.options)
    expect(restored.data.drafts.find(d => d.kind === 'answer')?.selectedOptionId).toBe('thanks')
    expect(restored.data.exercises[0]!.workedExample).toEqual(completeWorkedExample(THANKS_EXAMPLE))
    const mismatched = structuredClone(exportBackup(h.host.current()))
    mismatched.data.exercises[0]!.workedExample!.meaning = 'A different translation was not reviewed.'
    expect(() => parseBackup(JSON.stringify(mismatched))).toThrow('preserve its reviewed worked example')
    await h.host.apply(s => h.learning.submitAttempt(s, { id: 'choice', exerciseId: exercise.id, answer: '', selectedOptionId: 'thanks', submittedAt: h.clock.at }))
    await teacher.gradeAttempt('choice')
    expect(transport).toHaveBeenCalledTimes(2)
    expect(h.host.current().state.cards[0]!.box).toBe(2)
    expect(h.host.current().state.attempts[0]!.assessmentSource).toBe('deterministic')
    expect(feedbackMaterial(h.host.current().state, exercise, h.host.current().state.attempts[0])?.example).toEqual(completeWorkedExample(THANKS_EXAMPLE))
    await expect(teacher.presentQuizQuestion('another-session', draft.id, 0)).rejects.toThrow('different lesson')
  })
  it('honors a branch output-token cap for native drafting and independent content review', async () => {
    const h = await setup('recognition')
    await h.host.apply((s, r) => new GraphService(r, h.clock).setConfiguration(s, 'root', 'modelConfig', { provider: 'featherless', model: 'capped-fixture', temperature: 0.6, maxTokens: 256 }))
    const transport = vi.fn(async (options: ChatOptions) => {
      expect(options.model).toBe('capped-fixture'); expect(options.maxTokens).toBe(256)
      expect(options.temperature).toBe(0.2)
      return options.tools ? call('draft_multiple_choice_quiz', quizFor(options)) : contentReview(options)
    })
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    await teacher.draftQuiz([h.cardId])
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('rejects text-only quiz JSON and uncertain content without activating a question', async () => {
    const h = await setup('recognition')
    let mode = 'text'
    const transport = vi.fn(async (options: ChatOptions) => options.tools ? mode === 'text' ? json(quizFor(options)) : call('draft_multiple_choice_quiz', quizFor(options)) : contentReview(options, false))
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    await expect(teacher.draftQuiz([h.cardId])).rejects.toThrow('native quiz tool call')
    mode = 'native'
    await expect(teacher.draftQuiz([h.cardId])).rejects.toThrow('not activated')
    expect(h.host.current().state.exercises).toHaveLength(0)
    expect(h.host.current().state.drafts.at(-1)).toMatchObject({ status: 'rejected', contentReview: { verdict: 'uncertain' } })
    expect(h.host.current().state.cards[0]!.box).toBe(1)
  })
  it('uses one quiz format repair within the four-call budget', async () => {
    const h = await setup('recognition'); let drafts = 0
    const transport = vi.fn(async (options: ChatOptions) => {
      if (!options.tools) return contentReview(options)
      const quiz = quizFor(options)
      if (drafts++ === 0) quiz.questions[0]!.options[1]!.text = quiz.questions[0]!.options[0]!.text
      return call('draft_multiple_choice_quiz', quiz)
    })
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    expect((await teacher.draftQuiz([h.cardId])).draft.status).toBe('validated')
    expect(transport).toHaveBeenCalledTimes(3)
  })
  it('keeps private history out of web retrieval and bounds source excerpts in the replay', async () => {
    const h = await setup('recognition')
    const fetchedAt = NOW + 40 * DAY
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(fetchedAt)
    await h.host.apply((s, r) => r.mutate(s.version, { id: 'private-goal', kind: 'test', intent: {}, at: h.clock.at }, s => { s.learners[0]!.goal = 'PRIVATE_LEARNER_GOAL' }))
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).not.toContain('PRIVATE_LEARNER_GOAL')
      expect(String(init?.body)).not.toContain('fixture-secret')
      return new Response(JSON.stringify({ results: [{ title: 'Public thanks example', url: 'https://example.org/thanks', content: '谢谢 means thank you. '.repeat(100), score: 0.8 }] }), { headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const transport = vi.fn(async (options: ChatOptions) => {
      if (options.tools?.some(t => t.function.name === 'search_web')) {
        expect(JSON.stringify(options.messages)).not.toContain('PRIVATE_LEARNER_GOAL')
        return call('search_web', { query: '谢谢 Mandarin thanks fixture', purpose: 'Find a public example' })
      }
      if (options.tools) return call('draft_multiple_choice_quiz', quizFor(options))
      const excerpts = options.messages.flatMap(m => [...(m.content ?? '').matchAll(/"excerpt":/g)])
      expect(excerpts.length).toBeLessThanOrEqual(3)
      return contentReview(options)
    })
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport, tavilyFetcher: fetcher })
    await teacher.draftQuiz([h.cardId], { web: true, refresh: true })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(transport).toHaveBeenCalledTimes(3)
    expect(h.host.current().state.sources.find(s => s.kind === 'web')?.retrievedAt).toBe(fetchedAt)
    wallClock.mockRestore()
  })
})

describe('Mandarin capture and local retrieval', () => {
  it.each(['assessment', 'question', 'legacy'] as const)('finds the %s worked example, translation, pinyin and explanation after backup restore', async origin => {
    const h = await setup(), example = completeWorkedExample(THANKS_EXAMPLE)
    await h.host.apply(s => h.learning.prepareExercise(s, h.sessionId, h.cardId, exerciseProposal({ answerPolicy: origin === 'assessment' ? 'contextual' : 'exact', ...(origin === 'question' ? { workedExample: example } : {}) })))
    const exercise = h.host.current().state.exercises[0]!, attemptId = `search-${origin}`
    await h.host.apply(s => h.learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '谢谢', submittedAt: h.clock.at }))
    if (origin === 'assessment') await h.host.apply(s => h.learning.assessAttempt(s, attemptId, { exerciseId: exercise.id, grade: 'correct', criteria: [{ criterionId: 'meaning', met: true, evidence: 'Diagnostic criterion evidence: accurate gratitude.' }], feedback: 'Correct expression.', workedExample: example }, { source: 'teacher', provider: 'fixture', model: 'fixture' }))
    else {
      const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: async () => json(THANKS_EXAMPLE) })
      await teacher.gradeAttempt(attemptId)
      if (origin === 'legacy') await teacher.explainAttempt(attemptId)
    }
    const state = parseBackup(JSON.stringify(exportBackup(h.host.current()))).data, before = JSON.stringify(state)
    for (const query of ['你的帮助', 'ni de bang zhu', 'for your help', 'specifies']) {
      expect(searchLearningHistory(state, query, { rootId: 'root', cardId: h.cardId, kind: 'feedback' }, h.clock.at)).toEqual([expect.objectContaining({ attemptId, cardId: h.cardId, rootId: 'root' })])
      expect(historySources(state, query, { cardId: h.cardId }, h.clock.at)).toEqual([expect.objectContaining({ kind: 'local', cardId: h.cardId, excerpt: expect.stringContaining(THANKS_EXAMPLE.meaning) })])
    }
    if (origin === 'assessment') expect(searchLearningHistory(state, 'diagnostic criterion', { kind: 'feedback' }, h.clock.at)).toHaveLength(1)
    expect(searchLearningHistory(state, 'for your help', { rootId: 'other-topic' }, h.clock.at)).toHaveLength(0)
    expect(JSON.stringify(state)).toBe(before)
  })
  it('preserves source offsets, tone-marked pinyin and supplementary Hanzi', () => {
    const text = 'Hi 😊 你好！谢谢。𠮷'
    const chunks = mandarinChunks(text)
    expect(chunks.map(c => c.text)).toEqual(['你好', '谢谢', '𠮷'])
    expect(chunks[0]!.pinyin).toBe('nǐ hǎo')
    for (const chunk of chunks) expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text)
  })
  it.each(['Write 谢谢.', 'Write xiè xie.', 'Write xie4 xie.', 'Write xiexie.'])('blocks answer-bearing production prompt: %s', prompt => {
    expect(revealsProductionAnswer(prompt, ['谢谢'])).toBe(true)
  })
  it('allows a contextual prompt and preserves text-only highlight content', () => {
    expect(revealsProductionAnswer('Thank someone in Mandarin.', ['谢谢'])).toBe(false)
    const original = '<img src=x onerror=alert(1)> nǐ hǎo 😊'
    const parts = highlightParts(original, 'ni hao')
    expect(parts.map(p => p.text).join('')).toBe(original)
    expect(parts.filter(p => p.match).map(p => p.text)).toEqual(['nǐ', 'hǎo'])
  })
  it('finds cards by pinyin, meaning and due state across inactive topics', async () => {
    const h = await setup()
    expect(searchLearningHistory(h.host.current().state, 'xie', { kind: 'item', due: 'due' }, h.clock.at)[0]).toMatchObject({ cardId: h.cardId, box: 1 })
    expect(searchLearningHistory(h.host.current().state, 'thank you', { rootId: 'root', kind: 'item' }, h.clock.at)).toHaveLength(1)
    expect(searchLearningHistory(h.host.current().state, 'thank you', { rootId: 'missing' }, h.clock.at)).toHaveLength(0)
  })
  it('finds retained web citations through their exercise/topic without relabeling them local', async () => {
    const h = await setup()
    await h.host.apply((s, r) => r.mutate(s.version, { id: 'citation', kind: 'fixture', intent: {}, at: h.clock.at }, s => { s.sources.push({ id: 'web-source', kind: 'web', title: 'Public usage context', url: 'https://example.org/thanks', excerpt: 'A public thanks example.', retrievedAt: h.clock.at }) }))
    await h.host.apply(s => h.learning.prepareExercise(s, h.sessionId, h.cardId, exerciseProposal({ sourceIds: ['web-source'] })))
    expect(searchLearningHistory(h.host.current().state, 'public thanks', { rootId: 'root', kind: 'source', due: 'due' }, h.clock.at)[0]).toMatchObject({ sourceId: 'web-source', cardId: h.cardId, rootId: 'root' })
    expect(historySources(h.host.current().state, 'public thanks', { cardId: h.cardId }, h.clock.at)[0]).toMatchObject({ id: 'web-source', kind: 'web', url: 'https://example.org/thanks' })
  })
  it('searches a representative 5000-card fixture without quadratic card/source joins', () => {
    const state = workspaceFixture()
    for (let i = 0; i < 5000; i++) {
      state.items.push({ id: `item-${i}`, language: 'zh', kind: 'phrase', canonicalText: `谢谢${i}`, pinyin: 'xiè xie', senseKey: `thanks-${i}`, meaning: 'thank you', sourceNodeIds: ['root'], sourceRootIds: ['root'], createdAt: NOW })
      state.cards.push(newCard({ id: `card-${i}`, itemId: `item-${i}` }))
      state.sources.push({ id: `source-${i}`, kind: 'local', title: 'Saved thanks', excerpt: '谢谢 means thank you', cardId: `card-${i}`, retrievedAt: NOW })
    }
    const start = performance.now(), found = searchLearningHistory(state, 'thank you', { rootId: 'root' }, NOW)
    expect(found).toHaveLength(50)
    expect(performance.now() - start).toBeLessThan(2000) // Generous regression guard, not a device-speed claim.
  })
})
