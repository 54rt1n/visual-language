import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nid } from '../../src/lib/id'
import { defaultSettings } from '../../src/lib/settings'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { LearningService } from '../../src/lib/learning/learningService'
import { GraphService } from '../../src/lib/graph/graphService'
import { LessonCreationPauseError, LessonCreationService, lessonCreationSettings, lessonCreationSetup, lessonConversationSetup, lessonCreationConnected, type LessonCreationProgress } from '../../src/lib/teacher/lessonCreationService'
import type { TeacherHost } from '../../src/lib/teacher/teacherService'
import type { ChatOptions } from '../../src/lib/ai/types'
import { buildChatRequest } from '../../src/lib/ai/chatRequest'
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
  return { repository, host, clock, settings, service, createService, transport, controls, progress, request, blocked }
}

async function conversation(h: Awaited<ReturnType<typeof setup>>) {
  await h.host.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind: 'conversation-fixture', intent: {}, at: NOW }, state => {
    const common = { rootId: 'root', position: { x: 0, y: 0 }, bookmarked: false, collapsed: false }
    state.nodes.push({ ...common, id: 'question', type: 'user', data: { text: 'Teach me how to order tea. EARLIER_MESSAGE' } },
      { ...common, id: 'tea-reply', type: 'assistant', data: { text: '请给我一杯茶。不要加糖。再来一杯。', reasoning: 'PRIVATE_REASONING', state: 'complete', error: '', provider: 'fixture', model: 'fixture' } },
      { ...common, id: 'sibling', type: 'assistant', data: { text: '旅行。SIBLING_CONTENT', reasoning: '', state: 'complete', error: '', provider: 'fixture', model: 'fixture' } },
      { ...common, id: 'later', type: 'user', data: { text: 'UNRELATED_LATER_MESSAGE' } })
    for (const [source, target] of [['root', 'question'], ['question', 'tea-reply'], ['question', 'sibling'], ['tea-reply', 'later']]) state.edges.push({ id: nid('edge'), source: source!, target: target!, data: { kind: 'conversation' } })
    state.view.selectedNodeIds = ['sibling']
  }))
}

describe('shared lesson creation application workflow', () => {
  it('uses the Nemotron customizations throughout Nebius source, lesson and quiz preparation', async () => {
    const h = await setup()
    h.settings.selected = 'nebius'
    h.settings.profiles.nebius = { ...h.settings.profiles.nebius, model: 'nvidia/Nemotron-3_5-Lightning', apiKey: 'synthetic-nebius-key', keyOrigin: 'https://api.tokenfactory.nebius.com' }
    // The already-saved browser profile predates the Nebius wire adapter.
    delete h.settings.profiles.nebius.compatibility
    const original = h.transport.getMockImplementation()!
    h.transport.mockImplementation(async request => {
      expect(request.generationTrace?.modelProfile.id).toBe('nemotron-lightning')
      expect(request.toolResponseDialect).toBe('native')
      expect(buildChatRequest(request).payload).toMatchObject({ model: 'nvidia/Nemotron-3_5-Lightning', chat_template_kwargs: { enable_thinking: true } })
      return original(request)
    })
    const id = await h.service.saveRequest(h.request)
    await h.service.createFromRequest(id)
    expect(h.service.status({ draftId: id }).phase).toBe('ready')
    expect(h.transport.mock.calls.some(([request]) => request.tools?.[0]?.function.name === 'ground_lesson')).toBe(true)
    expect(h.service.status({ draftId: id }).readiness).toMatchObject({ teaching: true, practice: { status: 'validated' }, check: { status: 'validated' } })
  })
  it('rejects another learner’s validated conversation request before capture or generation', async () => {
    const h = await setup(); await conversation(h)
    const id = await h.service.saveConversationRequest('tea-reply', { kind: 'topic', settings: lessonCreationSettings('Tea') })
    await h.service.createFromRequest(id)
    await h.host.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind: 'switch-learner', intent: {}, at: NOW }, state => {
      state.learners.push({ ...structuredClone(state.learners[0]!), id: 'other-learner' }); state.activeLearnerId = 'other-learner'
    }))
    const before = structuredClone(h.host.current().state), calls = h.transport.mock.calls.length
    await expect(h.service.createFromRequest(id)).rejects.toThrow('another learner')
    expect(h.host.current().state).toEqual(before)
    expect(h.transport).toHaveBeenCalledTimes(calls)
  })

  it('keeps the clicked branch provider throughout generation when its phrase already exists elsewhere', async () => {
    const h = await setup(); await conversation(h)
    await h.host.apply((snapshot, repository) => new GraphService(repository, h.clock).setConfiguration(snapshot, 'root', 'modelConfig', { provider: 'featherless', model: 'model-earlier', temperature: 0.7, maxTokens: 4096 }))
    await h.host.apply((snapshot, repository) => new LearningService(repository, h.clock).addItem(snapshot, {
      language: 'zh', kind: 'phrase', canonicalText: '请给我一杯茶', pinyin: 'qǐng gěi wǒ yì bēi chá', meaning: 'please give me a cup of tea', senseKey: 'please give me a cup of tea', sourceNodeIds: ['question'], sourceRootIds: ['root'],
    }, ['recognition']))
    await h.host.apply((snapshot, repository) => new GraphService(repository, h.clock).setConfiguration(snapshot, 'tea-reply', 'modelConfig', { provider: 'featherless', model: 'model-clicked', temperature: 0.7, maxTokens: 4096 }))
    h.settings.selected = 'openai'
    expect(lessonCreationConnected(h.host.current().state, h.settings, 'tea-reply')).toBe(true)
    const id = await h.service.saveConversationRequest('tea-reply', { kind: 'topic', settings: lessonCreationSettings('Tea') })
    await h.service.createFromRequest(id)
    expect(new Set(h.transport.mock.calls.map(([request]) => request.model))).toEqual(new Set(['model-clicked']))
  })

  it.each(['topic', 'roleplay', 'interest'] as const)('prepares a %s lesson from frozen dialogue with no saved cards, web search or canvas publication', async kind => {
    const h = await setup()
    await conversation(h)
    h.settings.tavily.apiKey = 'must-not-be-used'
    const before = structuredClone(h.host.current().state)
    const preview = lessonConversationSetup(before, 'tea-reply')
    expect(preview.messages.map(message => message.nodeId)).toEqual(['question', 'tea-reply'])
    const id = await h.service.saveConversationRequest('tea-reply', { kind, settings: lessonCreationSettings('Ordering tea') })
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.host.current().state.cards).toHaveLength(0)
    const source = h.host.current().state.sources.find(source => source.kind === 'conversation')!
    expect(source.conversation!.messages).toEqual(preview.messages)
    await h.host.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind: 'edit-after-source-freeze', intent: {}, at: NOW }, state => {
      const node = state.nodes.find(node => node.id === 'tea-reply')!
      if (node.type === 'assistant') node.data.text = '你好。EDITED_AFTER_FREEZE'
    }))
    const canvas = structuredClone({ nodes: h.host.current().state.nodes, edges: h.host.current().state.edges })
    const result = await h.service.createFromRequest(id)
    const status = h.service.status({ draftId: id }), state = h.host.current().state
    expect(status.phase).toBe('ready')
    expect(result.anchorId).toBe('tea-reply')
    expect(status.lesson!.source!.draftId).toBe(id)
    expect(status.lesson!.kind).toBe(kind === 'roleplay' ? 'scenario' : kind === 'interest' ? 'reading' : 'topic')
    expect(status.lesson!.preparation!.practice!.questions.length).toBeGreaterThan(0)
    expect(status.lesson!.preparation!.check!.questions.length).toBeGreaterThan(0)
    const planning = h.transport.mock.calls.filter(([request]) => request.tools?.[0]?.function.name === 'ground_lesson').map(([request]) => JSON.stringify(request.messages)).join('')
    expect(planning).toContain('EARLIER_MESSAGE')
    expect(planning).toContain('请给我一杯茶')
    expect(planning).not.toMatch(/SIBLING_CONTENT|UNRELATED_LATER_MESSAGE|PRIVATE_REASONING|EDITED_AFTER_FREEZE/)
    expect({ nodes: state.nodes, edges: state.edges }).toEqual(canvas)
    expect(state.exercises).toEqual([]); expect(state.events).toEqual([])
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current(), NOW))).data).toEqual(state)
  })

  it('resumes frozen conversation acquisition and distinguishes two requests on the same reply', async () => {
    const h = await setup(); await conversation(h)
    const settings = lessonCreationSettings('Ordering tea')
    const id = await h.service.saveConversationRequest('tea-reply', { kind: 'topic', settings })
    h.controls.fail = 'propose_lesson_points'
    await expect(h.service.createFromRequest(id)).rejects.toThrow('Interrupted question preparation')
    expect(h.host.current().state.lessons).toHaveLength(0)
    expect(h.host.current().state.drafts.find(draft => draft.id === id)!.discoveryPlanning?.outline).toBeTruthy()
    h.controls.fail = ''
    const resumed = h.createService()
    expect(await resumed.saveConversationRequest('tea-reply', { kind: 'topic', settings }, id)).toBe(id)
    await resumed.createFromRequest(id)
    expect(h.transport.mock.calls.filter(([request]) => request.tools?.[0]?.function.name === 'ground_lesson')).toHaveLength(1)
    await h.host.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind: 'edit-frozen-origin', intent: {}, at: NOW }, state => {
      const node = state.nodes.find(node => node.id === 'tea-reply')!
      if (node.type === 'assistant') node.data.text = '你好。EDITED_AFTER_FROZEN_REQUEST'
    }))
    const other = await resumed.saveConversationRequest('tea-reply', { kind: 'roleplay', settings }, id)
    expect(other).not.toBe(id)
    const origin = h.host.current().state.drafts.find(draft => draft.id === other)!.discoveryRequest!.origin!
    expect(h.host.current().state.sources.find(source => source.id === origin.sourceId)!.conversation!.messages.at(-1)!.text).toBe('请给我一杯茶。不要加糖。再来一杯。')
    await resumed.createFromRequest(other)
    expect(resumed.status({ draftId: id }).lesson!.kind).toBe('topic')
    expect(resumed.status({ draftId: other }).lesson!.kind).toBe('scenario')
    expect(h.host.current().state.nodes).toHaveLength(5)
  })

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
