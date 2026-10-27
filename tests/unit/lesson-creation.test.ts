import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nid } from '../../src/lib/id'
import { defaultSettings } from '../../src/lib/settings'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { LearningService } from '../../src/lib/learning/learningService'
import { LessonCreationPauseError, LessonCreationService, lessonCreationSettings, lessonCreationSetup, type LessonCreationProgress } from '../../src/lib/teacher/lessonCreationService'
import type { TeacherHost } from '../../src/lib/teacher/teacherService'
import type { ChatOptions } from '../../src/lib/ai/types'
import { lessonSourceFixture, sourceFixtureTools } from '../fixtures/lesson-source'
import { topicFixture } from '../fixtures/topic-lesson'
import { NOW, workspaceFixture } from './fixtures'

const repositories: WorkspaceRepository[] = []
afterEach(() => { for (const repository of repositories) repository.close(); repositories.length = 0 })

async function setup() {
  const repository = await WorkspaceRepository.open({ name: nid('creation-test'), initial: workspaceFixture, broadcast: false })
  repositories.push(repository)
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(command) { snapshot = await command(snapshot, repository); return snapshot } }
  const settings = defaultSettings(), clock = { now: () => NOW }
  settings.selected = 'featherless'; settings.profiles.featherless.apiKey = 'fixture'; settings.profiles.featherless.keyOrigin = 'https://api.featherless.ai'
  let entered: () => void = () => {}
  const blocked = new Promise<void>(resolve => { entered = resolve })
  const controls = { fail: '', hold: '' }, progress: LessonCreationProgress[] = []
  const transport = vi.fn(async (options: ChatOptions) => {
    const name = options.tools?.[0]?.function.name ?? ''
    if (name === controls.fail) throw new Error('Interrupted question preparation.')
    if (name === controls.hold) {
      entered()
      return new Promise<never>((_resolve, reject) => {
        const signal = options.handlers?.signal
        const cancel = () => reject(new Error('Fixture creation paused.'))
        if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true })
      })
    }
    if (sourceFixtureTools.includes(name)) return { content: '', reasoning: '', finishReason: 'tool_calls', model: 'authored-creation-fixture',
      toolCalls: [{ id: nid('call'), type: 'function', function: { name, arguments: JSON.stringify(lessonSourceFixture(name)) } }] }
    return topicFixture(options)
  })
  const options = { clock, transport, onProgress: (event: LessonCreationProgress) => { progress.push(event) } }
  const createService = () => new LessonCreationService(host, () => settings, options)
  const service = createService()
  const request = { kind: 'topic' as const, rootId: 'root', publicTopic: 'Ordering tea', quizLevel: 'meaningPinyin' as const, extract: false, refresh: false }
  return { repository, host, clock, service, createService, transport, controls, progress, request, blocked }
}

describe('shared lesson creation application workflow', () => {
  it('creates source, lesson and both quizzes without mounting a view or presenting a question', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request)
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.host.current().state.cards).toHaveLength(0)
    const result = await h.service.createFromRequest(id)
    const state = h.host.current().state, status = h.service.status({ draftId: id })
    expect(result).toEqual({ draftId: id, lessonId: state.lessons[0]!.id, sessionId: state.sessions[0]!.id, anchorId: state.lessons[0]!.anchorId })
    expect(status.phase).toBe('ready')
    expect(status.readiness).toMatchObject({ ready: true, teaching: true, practice: { status: 'validated' }, check: { status: 'validated' } })
    expect(status.lesson!.settings).toEqual(lessonCreationSettings(h.request.publicTopic))
    expect(state.exercises).toEqual([]); expect(state.attempts).toEqual([]); expect(state.events).toEqual([])
    expect(h.progress.some(event => event.phase === 'source')).toBe(true)
    expect(h.progress.some(event => event.phase === 'lesson' && event.sessionId === result.sessionId)).toBe(true)
    const calls = h.transport.mock.calls.length
    expect(await h.service.createFromRequest(id)).toEqual(result)
    expect(await h.createService().resume(result.sessionId)).toEqual(result)
    await expect(h.service.createFromRequest(id, { settings: lessonCreationSettings('Tea', { quizLevel: 'responseHanzi' }) })).rejects.toThrow('new lesson request')
    expect(h.transport).toHaveBeenCalledTimes(calls)
    expect(h.host.current().state.lessons).toHaveLength(1)
  }, 15_000)

  it('retains accepted checkpoints on failure and resumes through a new service instance', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request)
    h.controls.fail = 'list_missing_questions'
    await expect(h.service.createFromRequest(id)).rejects.toThrow('Interrupted question preparation')
    const before = h.service.status({ draftId: id })
    expect(before.phase).toBe('lesson')
    expect(before.lesson!.preparation!.lesson.graph.waypoints).not.toHaveLength(0)
    expect(h.host.current().state.sessions.find(session => session.id === before.sessionId)!.status).toBe('paused')
    const graph = structuredClone(before.lesson!.preparation!.lesson), calls = h.transport.mock.calls.length
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current(), NOW))).data).toEqual(h.host.current().state)
    h.controls.fail = ''
    const result = await h.createService().resume(before.sessionId!)
    expect(result.lessonId).toBe(before.lesson!.id)
    expect(h.service.status({ draftId: id }).phase).toBe('ready')
    expect(h.service.status({ draftId: id }).lesson!.preparation!.lesson).toEqual(graph)
    const resumed = h.transport.mock.calls.slice(calls).map(([request]) => request.tools?.[0]?.function.name)
    expect(resumed).not.toContain('ground_lesson'); expect(resumed).not.toContain('add_lesson_waypoint')
    expect(h.host.current().state.lessons).toHaveLength(1)
  })

  it('pauses one active creation safely and rejects a second concurrent creation', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request)
    h.controls.hold = 'build_question_answers'
    const outcome = h.service.createFromRequest(id).then(() => undefined, error => error)
    await h.blocked
    await expect(h.service.createFromRequest(id)).rejects.toThrow('Pause the current lesson creation')
    await h.service.pause()
    expect(await outcome).toBeInstanceOf(Error)
    const saved = h.service.status({ draftId: id })
    expect(saved.phase).toBe('lesson')
    expect(h.host.current().state.sessions.find(session => session.id === saved.sessionId)!.status).toBe('paused')
    h.controls.hold = ''
    expect((await h.createService().createFromRequest(id)).sessionId).toBe(saved.sessionId)
    expect(h.host.current().state.lessons).toHaveLength(1)
  })

  it('updates editing requests but forks generated material and preserves its original lesson', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request)
    const edited = { ...h.request, publicTopic: 'Polite tea orders' }
    expect(await h.service.saveRequest(edited, id)).toBe(id)
    await h.service.createFromRequest(id)
    const original = structuredClone(h.host.current().state.drafts.find(draft => draft.id === id))
    expect(await h.service.saveRequest({ ...edited, publicTopic: '  Polite tea orders  ' }, id)).toBe(id)
    const replacement = await h.service.saveRequest({ ...edited, publicTopic: 'Asking for directions' }, id)
    expect(replacement).not.toBe(id)
    expect(h.host.current().state.drafts.find(draft => draft.id === id)).toEqual(original)
    expect(h.host.current().state.drafts.find(draft => draft.id === replacement)!.status).toBe('editing')
    expect(h.host.current().state.lessons).toHaveLength(1)
  })

  it('creates a session for the current learner and never cleans up another learner’s session', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request), first = await h.service.createFromRequest(id)
    await h.host.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind: 'switch-learner', intent: {}, at: NOW }, state => {
      state.learners.push({ ...structuredClone(state.learners[0]!), id: 'second-learner' })
      state.activeLearnerId = 'second-learner'
    }))
    await expect(h.service.resume(first.sessionId)).rejects.toThrow('unfinished lesson')
    expect(h.service.status({ sessionId: first.sessionId }).lesson).toBeUndefined()
    const second = await h.service.createFromRequest(id)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(h.host.current().state.sessions.find(session => session.id === second.sessionId)!.learnerId).toBe('second-learner')
    expect(h.host.current().state.sessions.find(session => session.id === first.sessionId)!.status).toBe('active')
  })

  it('keeps a failed pause retryable after generation settles and saves it before new work', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request)
    h.controls.hold = 'build_question_answers'
    const controller = new AbortController()
    const outcome = h.service.createFromRequest(id, { signal: controller.signal }).catch(error => error)
    await h.blocked
    const apply = h.host.apply.bind(h.host), storageError = new Error('Storage unavailable during pause')
    h.host.apply = async () => { throw storageError }
    controller.abort()
    const error = await outcome
    expect(error).toBeInstanceOf(LessonCreationPauseError)
    expect(error.cause).toBe(storageError)
    const sessionId = h.service.status({ draftId: id }).sessionId!
    expect(h.host.current().state.sessions.find(session => session.id === sessionId)!.status).toBe('active')
    await expect(h.service.pause()).rejects.toBeInstanceOf(LessonCreationPauseError)
    const calls = h.transport.mock.calls.length
    await expect(h.service.resume(sessionId)).rejects.toBeInstanceOf(LessonCreationPauseError)
    expect(h.transport).toHaveBeenCalledTimes(calls)
    h.host.apply = apply
    await h.service.pause()
    expect(h.host.current().state.sessions.find(session => session.id === sessionId)!.status).toBe('paused')
    h.controls.hold = ''
    expect((await h.service.resume(sessionId)).sessionId).toBe(sessionId)
  })

  it('returns the selected lesson and settings even when another creation is queued first', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request), original = await h.service.createFromRequest(id)
    const state = h.host.current().state, setupValues = lessonCreationSetup(state, original.anchorId)
    const settings = lessonCreationSettings('Tea', { quizLevel: 'responseHanzi', complexity: 'phrases' })
    const apply = h.host.apply.bind(h.host)
    let queued = true
    h.host.apply = async command => {
      if (queued) {
        queued = false
        await apply((snapshot, repository) => new LearningService(repository, h.clock).startLesson(snapshot, original.anchorId,
          setupValues.itemIds, 'A different queued lesson.', lessonCreationSettings('Another lesson')))
      }
      return apply(command)
    }
    const result = await h.service.createFromSelection({ anchorId: original.anchorId, itemIds: setupValues.itemIds, goal: setupValues.goal, settings })
    expect(result.sessionId).not.toBe(original.sessionId)
    expect(h.service.status({ sessionId: result.sessionId }).phase).toBe('ready')
    expect(h.service.status({ sessionId: result.sessionId }).lesson!.settings).toEqual(settings)
    expect(h.service.status({ sessionId: result.sessionId }).lesson!.goal).toBe(setupValues.goal)
    expect(lessonCreationSetup(h.host.current().state, original.anchorId).settings).toEqual(settings)
  })

  it('does not pause an unrelated daily review when asked to resume an invalid lesson', async () => {
    const h = await setup()
    await h.host.apply((snapshot, repository) => new LearningService(repository, h.clock).startSession(snapshot))
    const before = structuredClone(h.host.current().state)
    await expect(h.service.resume(before.sessions[0]!.id)).rejects.toThrow('unfinished lesson')
    expect(h.host.current().state).toEqual(before)
    expect(h.transport).not.toHaveBeenCalled()
  })

  it('rejects invalid creation settings before acquiring source material or enrolling cards', async () => {
    const h = await setup(), id = await h.service.saveRequest(h.request)
    const before = structuredClone(h.host.current().state)
    const settings = { ...lessonCreationSettings('Tea'), complexity: 'unsupported' } as unknown as ReturnType<typeof lessonCreationSettings>
    await expect(h.service.createFromRequest(id, { settings })).rejects.toThrow()
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.host.current().state).toEqual(before)
  })
})
