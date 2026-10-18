import { lessonForSession, lessonView } from '../../src/lib/domain/lesson'
import { parseToolContext } from '../fixtures/tool-context'
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { LearningService } from '../../src/lib/learning/learningService'
import { LessonService } from '../../src/lib/learning/lessonService'
import { lessonActivity, lessonHistory, lessonProgression, learningStreak, pendingLessonReview, pendingRecallExercise } from '../../src/lib/learning/lessonPolicy'
import { TeacherService, type TeacherHost } from '../../src/lib/teacher/teacherService'
import { lessonReadiness, lessonSummary, growthEvidence } from '../../src/lib/learning/lessonProgress'
import { lessonStep } from '../../src/lib/learning/lessonProgress'
import { englishAnswers, quizLevels, withPinyin, type QuizLevel, type LessonSettings } from '../../src/lib/domain/lessonPlan'
import { validateWorkspace } from '../../src/lib/domain/workspace'
import { canvasGraph, updateGraphFromCanvas } from '../../src/lib/graph/canvas'
import { defaultSettings } from '../../src/lib/settings'
import type { ChatOptions } from '../../src/lib/ai/types'
import { nid } from '../../src/lib/id'
import { NOW, workspaceFixture } from './fixtures'

const repos: WorkspaceRepository[] = []
afterEach(() => { repos.forEach(r => r.close()); repos.length = 0 })
import { topicFixture, waypointResult } from '../fixtures/topic-lesson'
async function setup(level: QuizLevel = 'meaningPinyin', focus: LessonSettings['focus'] = 'characters') {
  const repository = await WorkspaceRepository.open({ name: nid('topic-test'), broadcast: false, initial: workspaceFixture }); repos.push(repository)
  const clock = { at: NOW, now() { return this.at } }, learning = new LearningService(repository, clock)
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(fn) { snapshot = await fn(snapshot, repository); return snapshot } }
  await host.apply(s => learning.addItem(s, { language: 'zh', kind: 'phrase', canonicalText: '谢谢', meaning: 'thank you', senseKey: 'thanks', sourceNodeIds: ['root'], sourceRootIds: ['root'] }))
  const original = structuredClone(snapshot.state.cards[0]!)
  await host.apply(s => learning.startLesson(s, 'root', [s.state.items[0]!.id], 'Recognize thanks in everyday situations.', { quizLevel: level, complexity: 'simple', scope: 'everyday', focus, topic: 'Expressing thanks' }))
  const sessionId = snapshot.state.sessions.at(-1)!.id
  const settings = defaultSettings(); settings.selected = 'featherless'; settings.profiles.featherless.apiKey = 'fixture'; settings.profiles.featherless.keyOrigin = 'https://api.featherless.ai'
  const transport = vi.fn(async (o: ChatOptions) => topicFixture(o))
  const teacher = new TeacherService(host, () => settings, { clock, transport, random: () => 0 })
  return { repository, host, clock, learning, teacher, transport, sessionId, original, settings, lesson: () => lessonForSession(snapshot.state, snapshot.state.sessions.find(s => s.id === sessionId))!, session: () => snapshot.state.sessions.find(s => s.id === sessionId)! }
}

async function finishPreparedLesson(h: Awaited<ReturnType<typeof setup>>, id = h.sessionId, wrong = false) {
  await h.teacher.prepareLesson(id)
  for (let guard = 0; guard < 27; guard++) {
    const session = h.host.current().state.sessions.find(s => s.id === id)!, step = lessonStep(h.host.current().state, session)
    if (!step) return
    if (step.stage !== 'learn') {
      const state = h.host.current().state, card = state.cards.find(c => c.id === step.cardId)!
      if (card.status === 'new') await h.host.apply(s => h.learning.introduce(s, card.id, id))
      const draft = lessonReadiness(h.host.current().state, session)[step.stage]!
      await h.teacher.presentQuizQuestion(id, draft.id, draft.quiz!.questions.findIndex(q => q.lessonStep === session.lessonAttempt!.stepIndex), session.lessonAttempt!.activity !== 'review')
      const exercise = h.host.current().state.exercises.at(-1)!, attemptId = nid('attempt')
      const incorrect = wrong && step.stage === 'check'
      const optionId = incorrect ? exercise.multipleChoice!.options.find(o => o.id !== exercise.multipleChoice!.correctOptionId)!.id : exercise.multipleChoice!.correctOptionId
      await h.host.apply(s => h.learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '', selectedOptionId: optionId, submittedAt: h.clock.at }))
      await h.teacher.gradeAttempt(attemptId)
    }
    await h.host.apply(s => h.learning.advanceLesson(s, id))
  }
  throw new Error('Fixture exceeded the lesson step limit.')
}

describe('prepared topic lesson harness', () => {
  it('keeps lesson questions and results off the conversation canvas without losing saved history', async () => {
    const h = await setup(), before = structuredClone(h.host.current().state)
    await finishPreparedLesson(h)
    const state = h.host.current().state
    expect(state.nodes).toEqual(before.nodes)
    expect(state.edges).toEqual(before.edges)
    expect(state.exercises).toHaveLength(2)
    expect(state.attempts).toHaveLength(2)
    expect(h.session().lessonAttempt!.completion!.answers).toHaveLength(1)

    // An existing saved question node is hidden without rewriting its exercise or answer.
    const restored = structuredClone(state)
    restored.nodes.push({ id: 'saved-lesson-question', rootId: 'root', type: 'exercise', data: { exerciseId: state.exercises[0]!.id }, position: { x: 780, y: 350 }, bookmarked: false, collapsed: false })
    restored.edges.push({ id: 'saved-lesson-question-edge', source: 'root', target: 'saved-lesson-question', data: { kind: 'derived' } })
    const canvas = canvasGraph(validateWorkspace(restored))
    expect(canvas.nodes.find(n => n.id === 'saved-lesson-question')!.hidden).toBe(true)
    expect(canvas.edges.find(e => e.id === 'saved-lesson-question-edge')!.hidden).toBe(true)
    updateGraphFromCanvas(restored, canvas.nodes, canvas.edges, '', restored.view.viewport)
    expect(restored.exercises).toEqual(state.exercises)
    expect(restored.attempts).toEqual(state.attempts)
    expect(restored.nodes.some(n => n.id === 'saved-lesson-question')).toBe(true)
    expect(parseBackup(JSON.stringify(exportBackup({ ...h.host.current(), state: restored }))).data.exercises).toEqual(state.exercises)
  })
  it('repairs an unfinished authored example without replacing accepted content', async () => {
    const h = await setup(), original = h.transport.getMockImplementation()!
    let submitted = false
    h.transport.mockImplementation(async options => {
      const result = await original(options)
      if (options.tools?.[0]?.function.name === 'add_lesson_waypoint' && !submitted) {
        submitted = true
        const candidate = JSON.parse(result.toolCalls[0]!.function.arguments)
        return waypointResult(options, { ...candidate, exampleHanzi: '谢谢…' })
      }
      return result
    })
    await h.teacher.prepareLesson(h.sessionId)
    expect(h.lesson().preparation!.lesson.graph.waypoints[0]!.exampleHanzi).toBe('谢谢')
    expect(h.transport.mock.calls.filter(([o]) => o.tools?.[0]?.function.name === 'add_lesson_waypoint')).toHaveLength(2)
  })
  it('keeps failed attempts and permits immediate fresh retries until a single point is earned', async () => {
    const h = await setup(), lessonId = h.lesson().id, cycle = h.lesson().opportunity!.id
    await finishPreparedLesson(h, h.sessionId, true)
    const first = structuredClone(h.session().lessonAttempt!)
    expect(first.completion).toMatchObject({ passed: false, pointAwarded: false, answers: [{ outcome: 'incorrect' }] })
    expect(h.lesson().opportunity!.id).toBe(cycle)
    expect(lessonProgression(h.host.current().state, lessonId).points).toBe(0)
    h.transport.mockClear()
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, lessonId))
    const retry = h.host.current().state.sessions.at(-1)!
    expect(retry.lessonAttempt).toMatchObject({ cycleId: cycle, activity: 'learn', quizOnly: true, checkPreparation: { previousQuestions: [{ stem: expect.any(String) }] } })
    await h.teacher.prepareLesson(retry.id)
    expect(lessonView(h.host.current().state, h.host.current().state.sessions.at(-1))!.steps.every(s => s.phase === 'check')).toBe(true)
    expect(lessonReadiness(h.host.current().state, h.host.current().state.sessions.at(-1)!).practice).toBeUndefined()
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.sessions.at(-1)!.lessonAttempt!.quizOnly).toBe(true)
    await finishPreparedLesson(h, retry.id)
    const proposal = h.transport.mock.calls.map(([o]) => parseToolContext(o.messages[1]!.content!)).find(i => i.generationMode === 'list_missing_questions')!
    expect(Object.keys(proposal.earlierCheckQuestions[0]).sort()).toEqual(['passageExcerpt', 'stem'])
    expect(proposal.earlierCheckQuestions[0].passageExcerpt.length).toBeLessThanOrEqual(240)
    expect(h.session().lessonAttempt).toEqual(first)
    expect(h.transport.mock.calls.some(([o]) => parseToolContext(o.messages[1]!.content!).generationMode === 'add_lesson_waypoint')).toBe(false)
    expect(lessonHistory(h.host.current().state, lessonId)).toHaveLength(2)
    expect(lessonProgression(h.host.current().state, lessonId)).toMatchObject({ points: 1, level: 1 })
    expect(h.lesson().opportunity).toMatchObject({ kind: 'review', previousSessionId: retry.id })
    await expect(h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, lessonId, 'learn'))).rejects.toThrow('not ready')
    expect(learningStreak(h.host.current().state, h.host.current().state.learners[0]!.learningCalendar.anchor!)).toMatchObject({ current: 1, best: 1 })
  })

  it('keeps practice unscored and gives a newly due review priority over saved practice', async () => {
    const h = await setup(); await finishPreparedLesson(h)
    const opportunity = structuredClone(h.lesson().opportunity!)
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id, 'practice'))
    const practiceId = h.host.current().state.sessions.at(-1)!.id
    expect(lessonActivity(h.host.current().state, h.lesson(), h.clock.at)).toMatchObject({ mode: 'practice', label: 'Continue' })
    h.clock.at = opportunity.eligibleAt
    expect(lessonActivity(h.host.current().state, h.lesson(), h.clock.at)).toMatchObject({ due: true, mode: 'review', label: 'Review', savedPractice: { id: practiceId } })
    await finishPreparedLesson(h, practiceId)
    expect(h.host.current().state.sessions.find(s => s.id === practiceId)!.lessonAttempt!.completion).toMatchObject({ pointAwarded: false })
    expect(h.lesson().opportunity).toEqual(opportunity)
    expect(lessonProgression(h.host.current().state, h.lesson().id).points).toBe(1)
  })

  it('retries a failed review immediately and schedules the next opportunity only after passing', async () => {
    const h = await setup(); await finishPreparedLesson(h)
    h.clock.at = h.lesson().opportunity!.eligibleAt
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    const reviewId = h.host.current().state.sessions.at(-1)!.id, cycle = h.lesson().opportunity!.id
    await finishPreparedLesson(h, reviewId, true)
    expect(h.lesson().opportunity!.id).toBe(cycle)
    expect(lessonProgression(h.host.current().state, h.lesson().id).points).toBe(1)
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    const retryId = h.host.current().state.sessions.at(-1)!.id
    await finishPreparedLesson(h, retryId)
    expect(lessonProgression(h.host.current().state, h.lesson().id).points).toBe(2)
    expect(h.lesson().opportunity!.eligibleAt).toBeGreaterThanOrEqual(h.clock.at + 6 * 3_600_000)
    const completed = structuredClone(h.host.current().state.sessions.find(s => s.id === retryId)!.lessonAttempt!)
    await h.host.apply(s => h.learning.advanceLesson(s, retryId))
    expect(h.host.current().state.sessions.find(s => s.id === retryId)!.lessonAttempt).toEqual(completed)
    const before = h.host.current()
    await expect(h.repository.mutate(before.version, { id: nid('op'), kind: 'rewrite-result', intent: {}, at: h.clock.at }, state => {
      state.sessions.find(s => s.id === reviewId)!.lessonAttempt!.completion!.completedAt += 1
    })).rejects.toThrow('immutable')
  })

  it('keeps a saved practice question and selection while opening a due review for the same lesson', async () => {
    const h = await setup(); await finishPreparedLesson(h)
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id, 'practice'))
    const practice = h.host.current().state.sessions.at(-1)!
    await h.host.apply(s => h.learning.advanceLesson(s, practice.id))
    const practiceQuiz = lessonReadiness(h.host.current().state, practice).practice!
    await h.teacher.presentQuizQuestion(practice.id, practiceQuiz.id, 0, true)
    const exercise = h.host.current().state.exercises.at(-1)!
    await h.host.apply(s => h.learning.saveAnswerDraft(s, exercise.id, '', nid('op'), exercise.multipleChoice!.correctOptionId))
    h.clock.at = h.lesson().opportunity!.eligibleAt
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    const review = h.host.current().state.sessions.at(-1)!
    await h.teacher.prepareLesson(review.id)
    await h.teacher.presentQuizQuestion(review.id, lessonReadiness(h.host.current().state, h.host.current().state.sessions.find(s => s.id === review.id)!).check!.id, 0)
    expect(h.host.current().state.sessions.find(s => s.id === practice.id)).toMatchObject({ status: 'paused', activeExerciseId: exercise.id, lessonAttempt: { activity: 'practice' } })
    expect(h.host.current().state.drafts.find(d => d.exerciseId === exercise.id && d.kind === 'answer')!.selectedOptionId).toBe(exercise.multipleChoice!.correctOptionId)
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id, 'practice'))
    expect(h.host.current().state.sessions.find(s => s.id === practice.id)!.status).toBe('active')
    expect(h.host.current().state.sessions.find(s => s.id === review.id)!.lessonAttempt!.exposures).toHaveLength(1)
  })

  it('archives and restores saved work, eligibility and earned history through a full backup', async () => {
    const h = await setup(); await finishPreparedLesson(h)
    h.clock.at = h.lesson().opportunity!.eligibleAt
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    const reviewId = h.host.current().state.sessions.at(-1)!.id
    await h.teacher.prepareLesson(reviewId)
    const session = h.host.current().state.sessions.find(s => s.id === reviewId)!, draft = lessonReadiness(h.host.current().state, session).check!
    await h.teacher.presentQuizQuestion(reviewId, draft.id, 0)
    const exercise = h.host.current().state.exercises.at(-1)!
    await h.host.apply(s => h.learning.saveAnswerDraft(s, exercise.id, '', nid('op'), exercise.multipleChoice!.correctOptionId))
    const opportunity = structuredClone(h.lesson().opportunity), activity = structuredClone(h.host.current().state.sessions.find(s => s.id === reviewId)!.lessonAttempt)
    await h.host.apply((s, r) => new LessonService(r, h.clock).archive(s, h.lesson().id))
    expect(lessonActivity(h.host.current().state, h.lesson(), h.clock.at).due).toBe(false)
    expect(h.host.current().state.sessions.find(s => s.id === reviewId)).toMatchObject({ status: 'paused', activeExerciseId: exercise.id, lessonAttempt: activity })
    await expect(h.host.apply(s => h.learning.setSessionStatus(s, reviewId, 'active'))).rejects.toThrow('Restore')
    await expect(h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))).rejects.toThrow('archived')
    const fresh = await WorkspaceRepository.open({ name: nid('lesson-lifecycle-restore'), initial: workspaceFixture, broadcast: false }); repos.push(fresh)
    const restored = await fresh.replace((await fresh.snapshot()).version, parseBackup(JSON.stringify(exportBackup(h.host.current()))).data)
    expect(restored.state).toEqual(h.host.current().state)
    await h.host.apply((s, r) => new LessonService(r, h.clock).archive(s, h.lesson().id, false))
    expect(h.lesson().opportunity).toEqual(opportunity)
    expect(lessonActivity(h.host.current().state, h.lesson(), h.clock.at).due).toBe(true)
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    expect(h.host.current().state.sessions.find(s => s.id === reviewId)!.activeExerciseId).toBe(exercise.id)
    expect(lessonProgression(h.host.current().state, h.lesson().id).points).toBe(1)
  })

  it('records material exposure on a pending review and keeps the retry opportunity open', async () => {
    const h = await setup(); await finishPreparedLesson(h)
    h.clock.at = h.lesson().opportunity!.eligibleAt
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    const id = h.host.current().state.sessions.at(-1)!.id, cycle = h.lesson().opportunity!.id
    expect(pendingLessonReview(h.host.current().state)?.id).toBe(id)
    await h.host.apply((s, r) => new LessonService(r, h.clock).revealMaterial(s, h.lesson().cardIds))
    expect(pendingLessonReview(h.host.current().state)).toBeUndefined()
    await finishPreparedLesson(h, id)
    expect(h.host.current().state.sessions.find(s => s.id === id)!.lessonAttempt!.completion).toMatchObject({ passed: false, pointAwarded: false, answers: [{ outcome: 'helped' }] })
    expect(h.host.current().state.exercises.at(-1)!.mode).toBe('practice')
    expect(h.lesson().opportunity!.id).toBe(cycle)
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    const retryId = h.host.current().state.sessions.at(-1)!.id
    await h.teacher.prepareLesson(retryId)
    const retry = h.host.current().state.sessions.find(s => s.id === retryId)!, quiz = lessonReadiness(h.host.current().state, retry).check!
    await h.teacher.presentQuizQuestion(retryId, quiz.id, 0)
    const exercise = h.host.current().state.exercises.at(-1)!, attemptId = nid('attempt')
    await h.host.apply(s => h.learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '', selectedOptionId: exercise.multipleChoice!.correctOptionId, submittedAt: h.clock.at }))
    expect(pendingLessonReview(h.host.current().state)).toBeUndefined()
    expect(pendingRecallExercise(h.host.current().state)).toBeUndefined()
    await h.host.apply((s, r) => new LessonService(r, h.clock).revealMaterial(s, h.lesson().cardIds))
    await h.teacher.gradeAttempt(attemptId)
    await h.host.apply(s => h.learning.advanceLesson(s, retryId))
    expect(h.host.current().state.sessions.find(s => s.id === retryId)!.lessonAttempt!.completion).toMatchObject({ passed: true, pointAwarded: true })
  })

  it('counts one streak day for multiple completions and retains the best after a gap or archive', async () => {
    const h = await setup(); await finishPreparedLesson(h, h.sessionId, true)
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    await finishPreparedLesson(h, h.host.current().state.sessions.at(-1)!.id)
    const streak = () => learningStreak(h.host.current().state, h.host.current().state.learners[0]!.learningCalendar.anchor!)
    expect(streak()).toMatchObject({ current: 1, best: 1 })
    for (const elapsed of [1, 2]) {
      h.clock.at += elapsed * 86_400_000
      await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id, 'practice'))
      await finishPreparedLesson(h, h.host.current().state.sessions.at(-1)!.id)
      expect(streak()).toMatchObject(elapsed === 1 ? { current: 2, best: 2 } : { current: 1, best: 2 })
    }
    await h.host.apply((s, r) => new LessonService(r, h.clock).archive(s, h.lesson().id))
    expect(streak()).toMatchObject({ current: 1, best: 2 })
  })
  it('stores one prepared lesson while activities keep independent progress through restore', async () => {
    const h = await setup()
    await h.teacher.prepareLesson(h.sessionId)
    const content = structuredClone(h.lesson()), first = h.session()
    const otherId = nid('session')
    await h.host.apply((s, r) => r.mutate(s.version, { id: nid('op'), kind: 'second-activity', intent: {}, at: NOW }, state => {
      const activity = structuredClone(first.lessonAttempt!); delete activity.cycleId
      state.sessions.push({ ...structuredClone(first), id: otherId, status: 'paused', lessonAttempt: { ...activity, activity: 'practice' } })
      for (const quiz of state.drafts.filter(d => d.sessionId === first.id && d.kind === 'quiz')) state.drafts.push({ ...structuredClone(quiz), id: nid('quiz'), sessionId: otherId })
    }))
    await h.host.apply(s => h.learning.advanceLesson(s, first.id, true))
    expect(h.session().lessonAttempt!.stepIndex).toBe(1)
    expect(h.host.current().state.sessions.find(s => s.id === otherId)!.lessonAttempt!.stepIndex).toBe(0)
    expect(h.host.current().state.lessons).toEqual([content])
    expect(h.session().lessonAttempt).not.toHaveProperty('preparation')
    const backup = parseBackup(JSON.stringify(exportBackup(h.host.current())))
    const fresh = await WorkspaceRepository.open({ name: nid('lesson-restore'), initial: workspaceFixture, broadcast: false }); repos.push(fresh)
    const restored = await fresh.replace((await fresh.snapshot()).version, backup.data)
    expect(restored.state).toEqual(h.host.current().state)
    const missing = structuredClone(restored.state); missing.sessions[0]!.lessonAttempt!.lessonId = 'missing'
    expect(() => validateWorkspace(missing)).toThrow('references missing lessons')
  })
  it('freezes accepted content while allowing archive changes', async () => {
    const h = await setup()
    await h.teacher.prepareLesson(h.sessionId)
    const before = h.host.current()
    await expect(h.repository.mutate(before.version, { id: nid('op'), kind: 'edit-prepared', intent: {}, at: NOW }, state => {
      state.lessons[0]!.title = 'Changed content'
    })).rejects.toThrow('immutable')
    expect((await h.repository.snapshot()).state).toEqual(before.state)
    const archived = await new LessonService(h.repository, h.clock).archive(before, h.lesson().id)
    expect(archived.state.lessons[0]!.archivedAt).toBe(NOW)
  })
  it('resumes cancellation after a persisted accepted question without duplicating content or learner events', async () => {
    const h = await setup(), controller = new AbortController()
    const events = structuredClone(h.host.current().state.events)
    const cards = structuredClone(h.host.current().state.cards)
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: h.transport,
      onCheckpointCommitted: event => {
        if (event.checkpointId === 'practice-quiz' && event.persisted && h.lesson().preparation?.practice?.questions.length) {
          controller.abort(new DOMException('Cancel after saved practice question.', 'AbortError'))
        }
      },
    })
    await expect(teacher.prepareLesson(h.sessionId, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const checkpoint = structuredClone(h.lesson().preparation!)
    expect(checkpoint.practice!.questions).toHaveLength(1)
    expect(h.host.current().state.events).toEqual(events)
    expect(h.host.current().state.cards).toEqual(cards)
    h.transport.mockClear()
    await new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: h.transport }).prepareLesson(h.sessionId)
    const restored = h.lesson().preparation!
    expect(restored.lesson).toEqual(checkpoint.lesson)
    expect(restored.practice!.questions).toEqual(checkpoint.practice!.questions)
    expect(h.transport.mock.calls.some(([o]) => parseToolContext(o.messages[1]!.content!).generationMode === 'add_lesson_waypoint')).toBe(false)
    expect(h.host.current().state.events).toEqual(events)
    expect(h.host.current().state.cards).toEqual(cards)
    expect(lessonReadiness(h.host.current().state, h.session()).ready).toBe(true)
    const drafts = h.host.current().state.drafts.filter(d => d.kind === 'quiz')
    expect(drafts).toHaveLength(2)
    expect(new Set(drafts.map(d => d.id)).size).toBe(2)
    const count = h.transport.mock.calls.length
    await teacher.prepareLesson(h.sessionId)
    expect(h.transport).toHaveBeenCalledTimes(count)
    expect(h.host.current().state.events).toEqual(events)
  })
  it('persists a reviewed candidate through coverage and resumes without reauthoring it', async () => {
    const h = await setup()
    let interrupt = true
    h.transport.mockImplementation(async o => {
      const input = parseToolContext(o.messages[1]!.content as string)
      if (input.generationMode === 'evaluate_question_coverage' && input.phase === 'practice' && interrupt) throw new Error('Interrupted after checkpoint')
      return topicFixture(o)
    })
    await expect(h.teacher.prepareLesson(h.sessionId)).rejects.toThrow('Interrupted after checkpoint')
    const checkpoint = structuredClone(h.lesson().preparation!)
    expect(checkpoint.practice?.questions).toHaveLength(0)
    expect(checkpoint.practice!.pending!.step).toBe('coverage')
    expect(checkpoint.practice?.complete).toBe(false)
    expect(lessonReadiness(h.host.current().state, h.session()).ready).toBe(false)
    expect(h.host.current().state.events).toHaveLength(0)
    expect(h.host.current().state.drafts.filter(d => d.kind === 'quiz')).toHaveLength(0)
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.lessons[0]!.preparation).toEqual(checkpoint)
    interrupt = false; h.transport.mockClear()
    await new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: h.transport }).prepareLesson(h.sessionId)
    expect(h.transport.mock.calls.map(([o]) => parseToolContext(o.messages[1]!.content as string).generationMode)).not.toContain('add_lesson_waypoint')
    expect(parseToolContext(h.transport.mock.calls[0]![0].messages[1]!.content!).generationMode).toBe('evaluate_question_coverage')
    expect(h.lesson().preparation!.practice!.questions[0]!.question).toMatchObject({
      stem: checkpoint.practice!.pending!.candidate.stem, explanation: checkpoint.practice!.pending!.candidate.feedback,
    })
    expect(lessonReadiness(h.host.current().state, h.session()).ready).toBe(true)
    const count = h.transport.mock.calls.length
    await h.teacher.prepareLesson(h.sessionId)
    expect(h.transport).toHaveBeenCalledTimes(count)
  })
  it('persists reviewed waypoint drafts and resumes them after interruption and backup', async () => {
    const h = await setup()
    h.transport.mockImplementation(async o => {
      const input = parseToolContext(o.messages[1]!.content!)
      if (input.generationMode === 'verify_lesson_graph') throw new Error('Interrupted before graph review')
      return topicFixture(o)
    })
    await expect(h.teacher.prepareLesson(h.sessionId)).rejects.toThrow('Interrupted before graph review')
    const draft = structuredClone(h.lesson().waypointDraft!)
    expect(draft.graph.waypoints).toHaveLength(1)
    expect(h.lesson().preparation).toBeUndefined()
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.lessons[0]!.waypointDraft).toEqual(draft)
    h.transport.mockImplementation(async o => topicFixture(o)); h.transport.mockClear()
    await new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: h.transport }).prepareLesson(h.sessionId)
    expect(parseToolContext(h.transport.mock.calls[0]![0].messages[1]!.content!).graph.waypoints).toEqual(draft.graph.waypoints)
    expect(h.transport.mock.calls.some(([o]) => parseToolContext(o.messages[1]!.content!).generationMode === 'verify_lesson_waypoint')).toBe(false)
    expect(h.lesson().waypointDraft).toBeUndefined()
    expect(lessonReadiness(h.host.current().state, h.session()).ready).toBe(true)
  })
  it('does not save a late graph review after cancellation', async () => {
    const h = await setup(), controller = new AbortController()
    h.transport.mockImplementation(async o => {
      const result = topicFixture(o)
      if (parseToolContext(o.messages[1]!.content as string).generationMode === 'verify_lesson_graph') controller.abort()
      return result
    })
    await expect(h.teacher.prepareLesson(h.sessionId, controller.signal)).rejects.toThrow()
    expect(h.lesson().preparation).toBeUndefined()
    expect(h.lesson().steps).toEqual([])
    expect(h.host.current().state.events).toHaveLength(0)
  })
  it('runs distinct questions for the same card using their saved question positions', async () => {
    const h = await setup()
    h.transport.mockImplementation(async o => {
      const input = parseToolContext(o.messages[1]!.content as string)
      if (o.tools?.[0]?.function.name === 'solve_visible_question') return waypointResult(o, { answerIds: [input.prompt.includes('second distinction') ? 'B' : 'A'], reason: 'Authored order-plumbing fixture.' })
      const result = input.generationMode === 'add_lesson_waypoint' && input.graph.waypoints.length === 1
        ? waypointResult(o, { cardIds: [input.targets[0].cardId], dependsOn: ['w1'], objective: 'Recognize a second distinction.', explanation: 'This is a second distinction.', exampleHanzi: input.targets[0].hanzi, exampleMeaning: input.targets[0].meaning, sourceIds: [input.sources[0].id] })
        : topicFixture(o)
      const call = result.toolCalls[0]!
      let value = JSON.parse(call.function.arguments)
      if (input.generationMode === 'verify_lesson_graph' && input.graph.waypoints.length === 1) {
        value = { decision: 'add', reason: 'Add the second distinction.' }
      }
      if (input.generationMode === 'build_question_answers' && input.gap.waypointIds.includes('w2')) {
        value.stem = `For this second distinction: ${value.stem}`
        ;[value.answerA, value.answerB] = [value.answerB, value.answerA]
        value.correct = 'B'
      }
      call.function.arguments = JSON.stringify(value); return result
    })
    await h.teacher.prepareLesson(h.sessionId)
    const plan = h.lesson()
    expect(plan.steps.map(s => `${s.phase}:${s.waypointId ?? s.questionId}`)).toEqual(['learn:w1', 'practice:q1', 'learn:w2', 'practice:q2', 'check:q1', 'check:q2'])
    const calls = h.transport.mock.calls.length
    while (h.session().status !== 'completed') {
      const step = lessonStep(h.host.current().state, h.session())!
      if (step.phase === 'learn') { await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId)); continue }
      const draft = lessonReadiness(h.host.current().state, h.session())[step.phase]!
      const index = draft.quiz!.questions.findIndex(q => q.lessonStep === h.session().lessonAttempt!.stepIndex)
      await h.teacher.presentQuizQuestion(h.sessionId, draft.id, index)
      const exercise = h.host.current().state.exercises.at(-1)!, attemptId = nid('attempt')
      expect(exercise.multipleChoice!.correctOptionId).toBe(step.questionId === 'q2' ? 'B' : 'A')
      await h.host.apply(s => h.learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '', selectedOptionId: exercise.multipleChoice!.correctOptionId, submittedAt: NOW }))
      await h.teacher.gradeAttempt(attemptId)
      await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))
    }
    expect(h.transport).toHaveBeenCalledTimes(calls)
    expect(lessonSummary(h.host.current().state, h.session())).toMatchObject({ total: 2, correct: 2 })
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.exercises).toHaveLength(4)
  })
  it('rejects corrupted preparation hashes, references, coverage, and accepted question content on import', async () => {
    const h = await setup(); await h.teacher.prepareLesson(h.sessionId)
    const mutations: Array<(state: any) => void> = [
      s => { s.lessons[0].preparation.practice.lessonHash = '0'.repeat(64) },
      s => { s.lessons[0].preparation.lesson.graph.waypoints[0].dependsOn = ['w1'] },
      s => { s.lessons[0].preparation.practice.coverage[0].questionIds = ['q9'] },
      s => { s.lessons[0].preparation.practice.questions[0].question.correctOptionId = 'missing' },
      s => { s.drafts.find((d: any) => d.lessonPhase === 'practice').quiz.questions[0].stem = 'Changed question.' },
      s => { s.drafts = s.drafts.filter((d: any) => d.lessonPhase !== 'practice') },
    ]
    for (const corrupt of mutations) { const state = structuredClone(h.host.current().state); corrupt(state); expect(() => validateWorkspace(state)).toThrow() }
  })
  it.each(Object.keys(quizLevels) as QuizLevel[])('prepares and runs %s without typing or generation during the lesson', async level => {
    const h = await setup(level), stage = vi.fn()
    await h.teacher.prepareLesson(h.sessionId, undefined, stage)
    expect(h.transport).toHaveBeenCalledTimes(englishAnswers(level) ? 15 : 13)
    expect(stage).toHaveBeenCalledTimes(englishAnswers(level) ? 15 : 13)
    expect(stage.mock.calls.slice(0, 2).map(([label]) => label)).toEqual(['Mapping out your lesson…', 'Checking the examples and learning steps…'])
    expect(h.host.current().state.events).toHaveLength(0)
    expect(lessonReadiness(h.host.current().state, h.session()).ready).toBe(true)
    expect(h.host.current().state.cards[0]).toEqual(h.original)
    expect(lessonStep(h.host.current().state, h.session())?.stage).toBe('learn')
    await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))
    const schedule = structuredClone(h.host.current().state.cards)
    for (const phase of ['practice', 'check'] as const) {
      const draft = lessonReadiness(h.host.current().state, h.session())[phase]!
      await h.teacher.presentQuizQuestion(h.sessionId, draft.id, 0)
      const exercise = h.host.current().state.exercises.at(-1)!, mc = exercise.multipleChoice!
      expect(mc.quizLevel).toBe(level)
      expect(Boolean(mc.passagePinyin)).toBe(englishAnswers(level) && withPinyin(level))
      expect(mc.options.every(o => Boolean(o.pinyin) === (!englishAnswers(level) && withPinyin(level)))).toBe(true)
      expect(mc.options.every(o => /\p{Script=Han}/u.test(o.text) !== englishAnswers(level))).toBe(true)
      await h.host.apply(s => h.learning.saveAnswerDraft(s, exercise.id, '', nid('op'), mc.correctOptionId))
      await h.host.apply(s => h.learning.setSessionStatus(s, h.sessionId, 'paused'))
      const restored = parseBackup(JSON.stringify(exportBackup(h.host.current()))).data
      expect(restored.exercises.at(-1)!.multipleChoice).toEqual(mc)
      await h.host.apply(s => h.learning.setSessionStatus(s, h.sessionId, 'active'))
      const attemptId = nid('attempt')
      await h.host.apply(s => h.learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '', selectedOptionId: mc.correctOptionId, submittedAt: NOW }))
      await h.teacher.gradeAttempt(attemptId)
      await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))
    }
    expect(h.transport).toHaveBeenCalledTimes(englishAnswers(level) ? 15 : 13)
    expect(h.host.current().state.cards).toEqual(schedule)
    expect(h.session().status).toBe('completed')
    expect(lessonSummary(h.host.current().state, h.session())).toMatchObject({ total: 1, correct: 1, helped: 0, unanswered: 0 })
  })

  it('keeps aided answers separate and rejects presentation/plan corruption on import', async () => {
    const h = await setup('responseHanzi')
    await h.teacher.prepareLesson(h.sessionId)
    await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))
    await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId, true))
    const draft = lessonReadiness(h.host.current().state, h.session()).check!
    await h.teacher.presentQuizQuestion(h.sessionId, draft.id, 0)
    const exercise = h.host.current().state.exercises.at(-1)!
    await h.host.apply(s => h.learning.requestHelp(s, exercise.id, 'reveal'))
    const attemptId = nid('attempt')
    await h.host.apply(s => h.learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '', selectedOptionId: exercise.multipleChoice!.correctOptionId, submittedAt: NOW }))
    await h.teacher.gradeAttempt(attemptId)
    await expect(h.host.apply(s => h.learning.completeSupportedRetry(s, h.sessionId, exercise.multipleChoice!.correctOptionId))).rejects.toThrow('practice question')
    await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))
    expect(lessonSummary(h.host.current().state, h.session())).toMatchObject({ correct: 0, helped: 1, total: 1 })
    for (const corrupt of [
      (s: any) => { s.exercises[0].multipleChoice.quizLevel = 'responsePinyin' },
      (s: any) => { s.lessons[0].steps[0].phase = 'check' },
      (s: any) => { s.exercises[0].lessonStep = 1 },
    ]) { const state = structuredClone(h.host.current().state); corrupt(state); expect(() => validateWorkspace(state)).toThrow() }
  })

  it('requires a targeted supported retry after an error, persists it, and never rewrites the first answer', async () => {
    const h = await setup()
    await h.teacher.prepareLesson(h.sessionId)
    await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))
    const draft = lessonReadiness(h.host.current().state, h.session()).practice!
    await h.teacher.presentQuizQuestion(h.sessionId, draft.id, 0)
    const exercise = h.host.current().state.exercises.at(-1)!, mc = exercise.multipleChoice!
    const wrong = mc.options.find(o => o.id !== mc.correctOptionId)!.id
    await h.host.apply(s => h.learning.submitAttempt(s, { id: 'missed', exerciseId: exercise.id, answer: '', selectedOptionId: wrong, submittedAt: NOW }))
    await h.teacher.gradeAttempt('missed')
    const first = structuredClone(h.host.current().state.attempts), schedule = structuredClone(h.host.current().state.cards), events = structuredClone(h.host.current().state.events)
    await expect(h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))).rejects.toThrow('supported retry')
    await expect(h.host.apply(s => h.learning.completeSupportedRetry(s, h.sessionId, wrong))).rejects.toThrow('different meaning')
    await h.host.apply(s => h.learning.completeSupportedRetry(s, h.sessionId, mc.correctOptionId))
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.sessions[0]!.lessonAttempt!.remediatedSteps).toEqual([1])
    await h.host.apply(s => h.learning.advanceLesson(s, h.sessionId))
    expect(h.host.current().state.attempts).toEqual(first)
    expect(h.host.current().state.cards).toEqual(schedule)
    expect(h.host.current().state.events).toEqual(events)
    expect(h.transport).toHaveBeenCalledTimes(15)
  })

  it.each(['characters', 'complexity', 'specificity'] as const)('uses the shared ten-point progression before suggesting a change on the %s path', async focus => {
    const h = await setup('meaningPinyin', focus), settings = h.lesson().settings
    await finishPreparedLesson(h)
    expect(growthEvidence(h.host.current().state, h.session())).toMatchObject({ points: 1, level: 1, ready: false })
    const graph = structuredClone(h.lesson().preparation!.lesson)
    for (let points = 2; points <= 10; points++) {
      h.clock.at = h.lesson().opportunity!.eligibleAt
      await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
      const id = h.host.current().state.sessions.at(-1)!.id
      await finishPreparedLesson(h, id)
      expect(lessonProgression(h.host.current().state, h.lesson().id)).toMatchObject({ points, level: points >= 10 ? 4 : points >= 6 ? 3 : points >= 3 ? 2 : 1 })
      expect(h.lesson().preparation!.lesson).toEqual(graph)
    }
    expect(growthEvidence(h.host.current().state, h.session())).toMatchObject({ points: 10, level: 4, ready: true,
      suggestion: { ...settings, ...(focus === 'characters' ? { quizLevel: 'meaningHanzi' } : focus === 'complexity' ? { complexity: 'connected' } : { scope: 'topic' }) } })
    h.clock.at = h.lesson().opportunity!.eligibleAt
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, h.lesson().id))
    await finishPreparedLesson(h, h.host.current().state.sessions.at(-1)!.id)
    expect(h.host.current().state.sessions.at(-1)!.lessonAttempt!.completion).toMatchObject({ passed: true, pointAwarded: false })
    expect(lessonProgression(h.host.current().state, h.lesson().id).points).toBe(10)
  }, 15_000) // Eleven complete lesson/review cycles need headroom on shared CI runners.

  it('freezes different presentation settings for cards in one Daily review batch', async () => {
    const h = await setup('meaningPinyin')
    await h.teacher.prepareLesson(h.sessionId)
    const firstId = h.lesson().cardIds[0]!
    await h.host.apply(s => h.learning.introduce(s, firstId))
    await h.host.apply(s => h.learning.addItem(s, { language: 'zh', kind: 'phrase', canonicalText: '请问', meaning: 'excuse me, may I ask', senseKey: 'polite question', sourceNodeIds: ['root'], sourceRootIds: ['root'] }))
    const secondItem = h.host.current().state.items.at(-1)!.id
    await h.host.apply(s => h.learning.startLesson(s, 'root', [secondItem], 'Ask politely.', { ...h.lesson().settings, quizLevel: 'responseHanzi' }))
    const secondSession = h.host.current().state.sessions.at(-1)!
    await h.teacher.prepareLesson(secondSession.id)
    const secondId = lessonForSession(h.host.current().state, secondSession)!.cardIds[0]!
    await h.host.apply(s => h.learning.introduce(s, secondId))
    h.clock.at += 2 * 86_400_000
    await h.host.apply(s => h.learning.startSession(s))
    const reviewId = h.host.current().state.sessions.at(-1)!.id
    h.transport.mockImplementation(async options => {
      const input = parseToolContext([...options.messages].reverse().find(m => m.role === 'user')!.content as string)
      if (input.quiz) return topicFixture(options)
      const responses = input.targets.map((target: any) => {
        const settings = input.reviewSettings.find((r: any) => r.cardId === target.target.cardId).settings
        return topicFixture({ ...options, messages: [{ role: 'user', content: JSON.stringify({ ...input, reviewSettings: [{ settings }], targets: [target] }) }] })
      })
      const response = responses[0]
      const quiz = JSON.parse(response.toolCalls[0].function.arguments)
      quiz.questions = responses.flatMap((r: any) => JSON.parse(r.toolCalls[0].function.arguments).questions)
      response.toolCalls[0].function.arguments = JSON.stringify(quiz)
      return response
    })
    const { draft } = await h.teacher.draftQuiz([firstId, secondId], { sessionId: reviewId })
    expect(draft.quiz!.questions.map(q => q.quizLevel)).toEqual(['meaningPinyin', 'responseHanzi'])
    expect(draft.quiz!.questions[0]!.passagePinyin).toBeTruthy()
    expect(draft.quiz!.questions[1]!.options.every(o => !o.pinyin)).toBe(true)
    expect(draft.quiz!.questions.every(q => q.lessonStep === undefined)).toBe(true)
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.drafts.find(d => d.id === draft.id)).toEqual(draft)
  })

})
