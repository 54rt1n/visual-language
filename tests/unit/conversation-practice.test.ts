import { lessonForSession } from '../../src/lib/domain/lesson'
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { LearningService } from '../../src/lib/learning/learningService'
import { conversationSelection } from '../../src/lib/learning/conversationPractice'
import { lessonStep, lessonReadiness } from '../../src/lib/learning/lessonProgress'
import { TeacherService, type TeacherHost } from '../../src/lib/teacher/teacherService'
import { defaultSettings } from '../../src/lib/settings'
import { topicFixture } from '../fixtures/topic-lesson'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { GraphService, deletionScope } from '../../src/lib/graph/graphService'
import { DAY } from '../../src/lib/learning/leitner'
import { validateWorkspace } from '../../src/lib/domain/workspace'
import { nid } from '../../src/lib/id'
import { NOW, workspaceFixture } from './fixtures'

const repos: WorkspaceRepository[] = []
afterEach(() => { repos.forEach(r => r.close()); repos.length = 0 })
async function setup() {
  const repository = await WorkspaceRepository.open({ name: nid('conversation-test'), broadcast: false, initial: () => {
    const state = workspaceFixture()
    for (const id of ['left', 'right']) {
      state.nodes.push({ id, type: 'assistant', rootId: 'root', position: { x: 0, y: 0 }, bookmarked: false, collapsed: false, data: { reasoning: '', state: 'complete', error: '', provider: 'fixture', model: 'fixture', text: id === 'left' ? '谢谢。请给我一杯茶。' : '再见。' } })
      state.edges.push({ id: `edge-${id}`, source: 'root', target: id, data: { kind: 'conversation' } })
    }
    return state
  } }); repos.push(repository)
  const clock = { at: NOW, now() { return this.at } }, learning = new LearningService(repository, clock)
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(fn) { snapshot = await fn(snapshot, repository); return snapshot } }
  const apply = async (fn: (s: typeof snapshot) => Promise<typeof snapshot>) => host.apply(fn)
  for (const [word, source] of [['谢谢', 'left'], ['茶', 'left'], ['再见', 'right']] as const) await apply(s => learning.addItem(s, { language: 'zh', kind: 'word', canonicalText: word, meaning: word === '谢谢' ? 'thank you' : word === '茶' ? 'tea' : 'goodbye', senseKey: word, sourceNodeIds: [source], sourceRootIds: ['root'] }, ['recognition']))
  const settings = defaultSettings(); settings.selected = 'featherless'; settings.profiles.featherless.apiKey = 'fixture'; settings.profiles.featherless.keyOrigin = 'https://api.featherless.ai'
  const teacher = new TeacherService(host, () => settings, { clock, transport: async o => topicFixture(o) })
  const start = (itemIds = [snapshot.state.items[0]!.id]) => apply(s => learning.startLesson(s, 'left', itemIds, 'Understand thanks in context.', { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'everyday', focus: 'characters', topic: 'Thanks' }))
  return { repository, learning, teacher, clock, apply, current: () => snapshot, start }
}

describe('conversation lesson entry', () => {
  it('selects ancestors and derived saves, excludes siblings and suspended cards, and deduplicates captures', async () => {
    const h = await setup(), state = h.current().state
    const selected = conversationSelection(state, 'left')
    expect(selected.items.map(i => i.canonicalText)).toEqual(['谢谢', '茶'])
    expect(selected.context).toContain('请给我一杯茶'); expect(selected.context).not.toContain('再见')
    const item = state.items[0]!
    await h.apply(s => h.learning.addItem(s, { language: item.language, kind: item.kind, canonicalText: item.canonicalText, meaning: item.meaning, senseKey: item.senseKey, sourceNodeIds: item.sourceNodeIds, sourceRootIds: item.sourceRootIds }, ['recognition']))
    expect(h.current().state.cards).toHaveLength(3)
    await h.apply(s => h.learning.setSuspended(s, selected.cards[1]!.id, true))
    expect(conversationSelection(h.current().state, 'left').cards).toHaveLength(1)
    await expect(h.start([state.items[2]!.id])).rejects.toThrow('lesson source')
  })
  it('introduces the selected phrase despite an unrelated due backlog, only after prepared learning', async () => {
    const h = await setup(), ids = h.current().state.cards.map(c => c.id)
    await h.apply(s => h.learning.introduce(s, ids[2]!)); h.clock.at += DAY
    await h.start(); const sessionId = h.current().state.sessions.at(-1)!.id
    await expect(h.apply(s => h.learning.introduce(s, ids[1]!, sessionId))).rejects.toThrow('selected phrase')
    await h.teacher.prepareLesson(sessionId)
    expect(lessonStep(h.current().state, h.current().state.sessions.at(-1)!)?.stage).toBe('learn')
    expect(h.current().state.cards[0]!.status).toBe('new')
    await h.apply(s => h.learning.advanceLesson(s, sessionId))
    expect(h.current().state.cards[0]!.dueAt).toBe(h.clock.now() + DAY)
    expect(h.current().state.cards[1]!.status).toBe('new')
  })
  it('uses practice-only credit for overdue cards and rejects imported scheduling drift', async () => {
    const h = await setup(), cardId = h.current().state.cards[0]!.id
    await h.apply(s => h.learning.introduce(s, cardId)); h.clock.at += DAY
    const before = structuredClone(h.current().state.cards[0])
    await h.start(); const session = h.current().state.sessions.at(-1)!
    await h.teacher.prepareLesson(session.id)
    await h.apply(s => h.learning.advanceLesson(s, session.id))
    const quiz = lessonReadiness(h.current().state, h.current().state.sessions.at(-1)!).practice!
    await h.teacher.presentQuizQuestion(session.id, quiz.id, 0, false)
    const exercise = h.current().state.exercises.at(-1)!
    expect(exercise.mode).toBe('practice')
    await h.apply(s => h.learning.requestHelp(s, exercise.id, 'reveal'))
    expect(h.current().state.cards[0]).toEqual(before)
    const malformed = structuredClone(h.current().state); malformed.exercises[0]!.mode = 'dueReview'
    expect(() => validateWorkspace(malformed)).toThrow()
  })
  it('keeps the prepared plan, question and choice across pause, backup, source deletion and session switching', async () => {
    const h = await setup()
    await h.start(); const sessionId = h.current().state.sessions.at(-1)!.id
    await h.teacher.prepareLesson(sessionId)
    await h.apply(s => h.learning.advanceLesson(s, sessionId))
    const session = () => h.current().state.sessions.find(s => s.id === sessionId)!
    await h.teacher.presentQuizQuestion(sessionId, lessonReadiness(h.current().state, session()).practice!.id, 0)
    const exercise = h.current().state.exercises.at(-1)!
    await h.apply(s => h.learning.saveAnswerDraft(s, exercise.id, '', nid('op'), exercise.multipleChoice!.correctOptionId))
    await h.apply(s => h.learning.setSessionStatus(s, sessionId, 'paused'))
    await h.apply(s => h.learning.startSession(s))
    expect(session().activeExerciseId).toBe(exercise.id)
    await h.apply(s => h.learning.setSessionStatus(s, sessionId, 'active'))
    expect(h.current().state.sessions.at(-1)!.status).toBe('paused')
    await expect(h.start()).rejects.toThrow('unfinished question')
    const graph = new GraphService(h.repository, h.clock), scope = deletionScope(h.current().state, 'left')
    await h.apply(s => graph.deleteSubtree(s, 'left', scope.nodeIds))
    const backup = parseBackup(JSON.stringify(exportBackup(h.current())))
    expect(lessonForSession(backup.data, backup.data.sessions.find(s => s.id === sessionId))!.context).toContain('请给我一杯茶')
    expect(backup.data.drafts.find(d => d.exerciseId === exercise.id)?.selectedOptionId).toBe(exercise.multipleChoice!.correctOptionId)
    await h.apply(s => h.learning.advanceLesson(s, sessionId, true))
    expect(session().lessonAttempt!.skippedSteps).toEqual([1])
    const malformed = structuredClone(backup.data); malformed.sessions.find(s => s.id === sessionId)!.lessonAttempt!.stepIndex = 9
    expect(() => validateWorkspace(malformed)).toThrow('Invalid lesson progress')
  })
})
