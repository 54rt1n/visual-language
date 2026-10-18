import { validateLessonPreparation } from '../../src/lib/domain/lessonPreparation'
import { validateTargetCoverage } from '../../src/lib/domain/coverageEvidence'
import { remainingTargetIds } from '../../src/lib/teacher/questionGapTools'
import { lessonForSession } from '../../src/lib/domain/lesson'
import { LessonService } from '../../src/lib/learning/lessonService'
import { lessonProgression } from '../../src/lib/learning/lessonPolicy'
import { parseToolContext } from '../fixtures/tool-context'
import 'fake-indexeddb/auto'
import { topicFixture } from '../fixtures/topic-lesson'
import { lessonSourceFixture, sourceFixtureTools } from '../fixtures/lesson-source'
import { englishAnswers, quizLevels, type QuizLevel } from '../../src/lib/domain/lessonPlan'
import { lessonReadiness } from '../../src/lib/learning/lessonProgress'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nid } from '../../src/lib/id'
import { defaultSettings } from '../../src/lib/settings'
import { WorkspaceRepository } from '../../src/lib/storage/repository'
import { exportBackup, parseBackup } from '../../src/lib/storage/backup'
import { validateWorkspace } from '../../src/lib/domain/workspace'
import { DiscoveryService } from '../../src/lib/teacher/discoveryService'
import { TeacherService, type TeacherHost } from '../../src/lib/teacher/teacherService'
import { LearningService } from '../../src/lib/learning/learningService'
import { GraphService, deletionScope } from '../../src/lib/graph/graphService'
import { searchLearningHistory } from '../../src/lib/search/searchService'
import type { DiscoveryRequest } from '../../src/lib/domain/discovery'
import type { ChatOptions, ChatResult } from '../../src/lib/ai/types'
import { DAY } from '../../src/lib/learning/leitner'
import { NOW, workspaceFixture } from './fixtures'

const repositories: WorkspaceRepository[] = []
afterEach(() => { repositories.forEach(r => r.close()); repositories.length = 0; vi.restoreAllMocks() })
const json = (value: unknown): ChatResult => ({ content: JSON.stringify(value), reasoning: '', toolCalls: [], finishReason: 'stop', model: 'actual-discovery-fixture' })
const toolCall = (name: string, value: unknown): ChatResult => ({ ...json(null), content: '', finishReason: 'tool_calls', toolCalls: [{ id: nid('call'), type: 'function', function: { name, arguments: JSON.stringify(value) } }] })
function input(options: ChatOptions) {
  for (const m of [...options.messages].reverse()) if (m.role === 'user') try { return parseToolContext(m.content) } catch { /* repair/extract instructions */ }
  throw new Error('Missing fixture input.')
}
async function setup(kind: DiscoveryRequest['kind'] = 'topic', extract = false) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const repository = await WorkspaceRepository.open({ name: nid('discovery-test'), initial: workspaceFixture, broadcast: false }); repositories.push(repository)
  let snapshot = await repository.snapshot()
  const host: TeacherHost = { current: () => snapshot, async apply(command) { snapshot = await command(snapshot, repository); return snapshot } }
  const clock = { at: NOW, now() { return this.at } }, settings = defaultSettings(), learning = new LearningService(repository, clock)
  settings.selected = 'featherless'; settings.profiles.featherless.apiKey = 'PRIVATE_MODEL_KEY'; settings.profiles.featherless.keyOrigin = 'https://api.featherless.ai'; settings.tavily.apiKey = 'PRIVATE_SEARCH_KEY'
  await host.apply((s, r) => r.mutate(s.version, { id: nid('op'), kind: 'fixture-goal', intent: {}, at: NOW }, s => { s.learners[0]!.goal = 'PRIVATE_LEARNER_GOAL'; s.learners[0]!.level = 'intermediate' }))
  const controls = { failDraft: false, failReview: false, reject: false, unsupported: false, published: '2026-09-10', empty: false, question: 0, pointCount: 1, failStage: '', rejectScope: false }
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    expect(JSON.stringify(body)).not.toContain('PRIVATE_')
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
    if (String(url).endsWith('/extract')) return new Response(JSON.stringify({ results: [{ url: 'https://example.org/tea', raw_content: 'Expanded source fixture: 请给我一杯茶 politely asks for tea. 谢谢 means thanks. 再见 means goodbye.' }] }))
    expect(body.topic).toBe(kind === 'interest' ? 'news' : 'general')
    return new Response(JSON.stringify({ results: controls.empty ? [] : [{ url: 'https://example.org/tea', title: 'Public Mandarin source fixture', content: '请给我一杯茶 politely asks for a cup of tea. 谢谢 means thanks. 再见 means goodbye.', ...(controls.published ? { published_date: controls.published } : {}) }] }))
  }) as unknown as typeof fetch
  const transport = vi.fn(async (options: ChatOptions) => {
    const value = input(options), transcript = JSON.stringify(options.messages)
    expect(transcript).not.toMatch(/PRIVATE_MODEL_KEY|PRIVATE_SEARCH_KEY/)
    if (['solve_english_question', 'solve_visible_question'].includes(options.tools?.[0]?.function.name ?? '')) {
      expect(transcript).not.toContain('PRIVATE_LEARNER_GOAL')
      expect(value).not.toHaveProperty('learner')
      return topicFixture(options)
    }
    if (!sourceFixtureTools.includes(options.tools?.[0]?.function.name ?? '')) return topicFixture(options)
    const name = options.tools?.[0]?.function.name ?? ''
    if (controls.failStage === name) throw new Error('Fixture interrupted planning.')
    if (name === 'review_lesson_scope' && controls.rejectScope) return toolCall(name, { accepted: false, reason: 'Select a more useful distinct scope.' })
    if (name === 'review_lesson_source') {
      if (controls.failReview) throw new Error('Fixture interrupted content review.')
      return toolCall(name, { accepted: !controls.reject, reason: 'Fixture review of language and source support.' })
    }
    if (controls.failDraft) throw new Error('Fixture disconnected during generation.')
    const arguments_ = lessonSourceFixture(name, controls.pointCount)
    if (controls.unsupported && 'points' in arguments_ && arguments_.points) arguments_.points = [{ expression: 'not Mandarin', meaning: 'invalid', purpose: 'invalid' }]
    return toolCall(name, arguments_)
  })
  const service = new DiscoveryService(host, () => settings, { clock, transport, tavilyFetcher: fetcher })
  const id = await service.saveRequest({ kind, publicTopic: 'Mandarin tea', rootId: 'root', extract, refresh: false })
  return { repository, host, clock, settings, learning, controls, transport, fetcher, service, id }
}

describe('sourced discovery lessons', () => {
  it.each(['服务员，请…', '一个 / 两个'])('repairs notation %s before saving concrete teaching points', async expression => {
    const h = await setup(), original = h.transport.getMockImplementation()!
    let submitted = false
    h.transport.mockImplementation(async options => {
      const name = options.tools?.[0]?.function.name
      if (name === 'propose_lesson_points' && !submitted) {
        submitted = true
        return toolCall(name, { points: [{ expression, meaning: 'A request or quantity.', purpose: 'Order food.' }] })
      }
      return original(options)
    })
    const saved = await h.service.generate(h.id)
    expect(saved.status).toBe('validated')
    expect(saved.discoveryPlanning!.accepted!.points.every(p => p.expression !== expression)).toBe(true)
    expect(h.transport.mock.calls.filter(([o]) => o.tools?.[0]?.function.name === 'propose_lesson_points')).toHaveLength(2)
  })
  it.each(['topic', 'roleplay', 'interest'] as const)('creates and prepares a %s lesson without a Tavily account', async kind => {
    const h = await setup(kind)
    h.settings.tavily.apiKey = ''
    h.controls.pointCount = 4
    const draft = await h.service.generate(h.id)
    expect(draft.discoveryPlanning!.accepted!.points).toHaveLength(4)
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.host.current().state.sources.filter(s => draft.sourceIds.includes(s.id))).toMatchObject([{ kind: 'local', adapted: true, title: 'AI-written Mandarin practice' }])
    const created = await h.service.startLesson(h.id, { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'everyday', focus: 'characters', topic: 'Tea' })
    expect(await h.service.startLesson(h.id, { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'everyday', focus: 'characters', topic: 'Tea' })).toEqual(created)
    const session = () => h.host.current().state.sessions.find(s => s.id === created.sessionId)!
    expect(lessonForSession(h.host.current().state, session())!.kind).toBe(kind === 'roleplay' ? 'scenario' : kind === 'interest' ? 'reading' : 'topic')
    await new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: h.transport }).prepareLesson(created.sessionId)
    expect(lessonReadiness(h.host.current().state, session()).ready).toBe(true)
    expect(h.host.current().state.lessons).toHaveLength(1)
    const prepared = h.host.current().state.lessons[0]!.preparation!
    expect(prepared.input.targets).toHaveLength(4)
    expect(prepared.lesson.graph.waypoints).toHaveLength(4)
    expect(prepared.practice!.coverage).toHaveLength(4)
    expect(prepared.check!.coverage).toHaveLength(4)
    expect(prepared.input.sourceMaterial!.scope).toEqual(draft.discoveryPlanning!.accepted)
    expect(validateWorkspace(h.host.current().state)).toEqual(h.host.current().state)
    expect(h.host.current().state.events).toHaveLength(0)
    expect(h.fetcher).not.toHaveBeenCalled()
  })

  it.each(['propose_lesson_points', 'review_lesson_scope'] as const)('resumes saved reading planning at %s without rewriting its outline or passage', async failStage => {
    const h = await setup('interest'); h.controls.pointCount = 4; h.controls.failStage = failStage
    await expect(h.service.generate(h.id)).rejects.toThrow('Fixture interrupted planning')
    const saved = structuredClone(h.host.current().state.drafts.find(d => d.id === h.id)!.discoveryPlanning!)
    expect(saved.reading!.passage).toContain('不要加糖')
    const before = h.transport.mock.calls.length
    h.controls.failStage = ''
    const result = await h.service.resume(h.id)
    expect(result.discoveryPlanning!.outline).toEqual(saved.outline)
    expect(result.discoveryPlanning!.reading).toEqual(saved.reading)
    if (saved.candidate) expect(result.discoveryPlanning!.accepted!.points).toEqual(saved.candidate)
    const resumed = h.transport.mock.calls.slice(before).map(([o]) => o.tools![0]!.function.name)
    expect(resumed).not.toContain('ground_lesson'); expect(resumed).not.toContain('prepare_reading_source')
    if (saved.candidate) expect(resumed).not.toContain('propose_lesson_points')
  })

  it('prevents a one-point graph becoming ready for a reviewed four-point scope even when the reviewer insists', async () => {
    const h = await setup(); h.controls.pointCount = 4
    await h.service.generate(h.id)
    const { sessionId } = await h.service.startLesson(h.id, { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'topic', focus: 'characters', topic: 'Tea' })
    const transport = async (o: ChatOptions) => o.tools?.[0]?.function.name === 'verify_lesson_graph'
      ? toolCall('verify_lesson_graph', { decision: 'accept', reason: 'Premature acceptance fixture.' }) : h.transport(o)
    await expect(new TeacherService(h.host, () => h.settings, { clock: h.clock, transport }).prepareLesson(sessionId)).rejects.toThrow('decision: Invalid option: expected one of "add"|"revise"|"reject"')
    const session = h.host.current().state.sessions.find(s => s.id === sessionId)!
    const lesson = lessonForSession(h.host.current().state, session)!
    expect(lesson.waypointDraft!.graph.waypoints).toHaveLength(1)
    expect(lesson.source!.scope!.points).toHaveLength(4)
    expect(lessonReadiness(h.host.current().state, session).ready).toBe(false)
    expect(lesson.preparation).toBeUndefined()
    const projected = input(h.transport.mock.calls.find(([o]) => o.tools?.[0]?.function.name === 'verify_lesson_waypoint')![0])
    expect(projected.originalRequest.publicTopic).toBe('Mandarin tea')
    expect(projected.acceptedScope.points).toHaveLength(4)
    expect(projected.missingTeachingPoints).toHaveLength(4)
  })

  it('retries an exhausted scope review explicitly while retaining grounding', async () => {
    const h = await setup(); h.controls.rejectScope = true
    await expect(h.service.generate(h.id)).rejects.toThrow('scope needs revision')
    const planning = structuredClone(h.host.current().state.drafts.find(d => d.id === h.id)!.discoveryPlanning!)
    expect(planning.rounds).toBe(2)
    h.controls.rejectScope = false
    const resumed = await h.service.resume(h.id)
    expect(resumed.discoveryPlanning!.outline).toBe(planning.outline)
    expect(resumed.discoveryPlanning!.rounds).toBe(3)
    expect(resumed.discoveryPlanning!.accepted).toBeDefined()
    expect(h.transport.mock.calls.filter(([o]) => o.tools?.[0]?.function.name === 'ground_lesson')).toHaveLength(1)
  })

  it('preserves accepted scope through interrupted material authoring', async () => {
    const h = await setup('roleplay'); h.controls.pointCount = 4; h.controls.failStage = 'prepare_scenario_source'
    await expect(h.service.generate(h.id)).rejects.toThrow('Fixture interrupted planning')
    const scope = structuredClone(h.host.current().state.drafts.find(d => d.id === h.id)!.discoveryPlanning!.accepted!)
    h.controls.failStage = ''
    const before = h.transport.mock.calls.length, resumed = await h.service.resume(h.id)
    expect(resumed.discoveryPlanning!.accepted).toEqual(scope)
    expect(h.transport.mock.calls.slice(before).map(([o]) => o.tools![0]!.function.name)).toEqual(['prepare_scenario_source', 'review_lesson_source'])
  })

  it('uses semantic waypoint review to remove nominal links before filling the remaining scope', async () => {
    const h = await setup(); h.controls.pointCount = 4
    await h.service.generate(h.id)
    const { sessionId } = await h.service.startLesson(h.id, { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'topic', focus: 'characters', topic: 'Tea' })
    let offeredNominalLinks = false, reviewedNominalLinks = false
    const transport = async (o: ChatOptions) => {
      const c = input(o), name = o.tools?.[0]?.function.name
      if (name === 'add_lesson_waypoint' && !offeredNominalLinks) {
        offeredNominalLinks = true
        const result = topicFixture(o), args = JSON.parse(result.toolCalls[0]!.function.arguments)
        args.cardIds = c.targets.map((t: { cardId: string }) => t.cardId)
        return toolCall(name, args)
      }
      if (name === 'verify_lesson_waypoint' && c.candidate.cardIds.length === 4) {
        reviewedNominalLinks = true
        expect(o.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(t => JSON.parse(t.function.arguments).decision === 'revise'))).toBe(true)
        expect(o.messages[0]!.content).toContain('actual content and purpose')
        return toolCall(name, { decision: 'revise', reason: 'The explanation and example teach only the drink request. Retain that target and teach the other purposes subsequently.' })
      }
      if (name === 'revise_lesson_waypoint' && c.candidateToRevise) {
        const { id: _id, ...candidate } = c.candidateToRevise
        return toolCall(name, { ...candidate, cardIds: [candidate.cardIds[0]] })
      }
      return h.transport(o)
    }
    await new TeacherService(h.host, () => h.settings, { clock: h.clock, transport }).prepareLesson(sessionId)
    expect(reviewedNominalLinks).toBe(true)
    const lesson = h.host.current().state.lessons[0]!
    expect(lesson.preparation!.lesson.graph.waypoints).toHaveLength(4)
    expect(lesson.preparation!.lesson.graph.waypoints.every(w => w.cardIds.length === 1)).toBe(true)
  })

  it('repairs an author jumping to a later teaching point before saving the lesson sequence', async () => {
    const h = await setup(); h.controls.pointCount = 4
    await h.service.generate(h.id)
    const { sessionId } = await h.service.startLesson(h.id, { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'topic', focus: 'characters', topic: 'Tea' })
    let jumped = false, repaired = false
    const transport = async (o: ChatOptions) => {
      const c = input(o), name = o.tools?.[0]?.function.name
      if (name === 'add_lesson_waypoint' && !jumped) {
        jumped = true
        const later = c.targets.at(-1), result = topicFixture(o), args = JSON.parse(result.toolCalls[0]!.function.arguments)
        return toolCall(name, { ...args, cardIds: [later.cardId], exampleHanzi: later.hanzi, exampleMeaning: later.meaning })
      }
      if (name === 'add_lesson_waypoint' && c.nativeSubmissionIssue) {
        repaired = true
        expect(c.nextTeachingPoint.cardId).toBe(c.targets[0].cardId)
      }
      return h.transport(o)
    }
    await new TeacherService(h.host, () => h.settings, { clock: h.clock, transport }).prepareLesson(sessionId)
    const prepared = h.host.current().state.lessons[0]!.preparation!
    expect(repaired).toBe(true)
    expect(prepared.lesson.graph.waypoints.map(w => w.cardIds[0])).toEqual(prepared.input.targets.map(t => t.cardId))
  })

  it('retains complete planning examples for the existing XML model profile', async () => {
    const h = await setup(); h.settings.profiles.featherless.model = 'Qwen/Qwen3.8-27B'
    await h.service.generate(h.id)
    const proposal = h.transport.mock.calls.find(([o]) => o.tools?.[0]?.function.name === 'propose_lesson_points')![0]
    expect(proposal.toolResponseDialect).toBe('qwen_xml')
    expect(proposal.messages[0]!.content).toContain('Complete submission arguments:')
    expect(proposal.messages[0]!.content).toContain('可以借多久')
    expect(proposal.messages[0]!.content).toContain('I am a student and I am learning Chinese')
    expect(proposal.messages.some(m => m.role === 'assistant' && m.tool_calls?.length)).toBe(false)
  })
  it('keeps a multi-target waypoint open until every planned expression has evaluated quiz evidence and rechecks retained questions', async () => {
    const h = await setup(); h.controls.pointCount = 2
    await h.service.generate(h.id)
    const { sessionId } = await h.service.startLesson(h.id, { quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'topic', focus: 'characters', topic: 'Tea' })
    let interrupt = true
    const transport = async (o: ChatOptions) => {
      const c = input(o), name = o.tools?.[0]?.function.name
      if (name === 'add_lesson_waypoint') return toolCall(name, { cardIds: c.targets.map((t: { cardId: string }) => t.cardId), dependsOn: [],
        objective: 'Order tea with a no-sugar preference.', explanation: '请给我一杯茶 politely requests one cup of tea; 不要加糖 tells the server to omit sugar.',
        exampleHanzi: '请给我一杯茶', exampleMeaning: 'Please give me a cup of tea.', sourceIds: [c.sources[0].id] })
      if (name === 'list_missing_questions' && c.currentQuestions.length === 1 && interrupt) throw new Error('Paused before the second target.')
      return h.transport(o)
    }
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport })
    await expect(teacher.prepareLesson(sessionId)).rejects.toThrow('Paused before the second target.')
    const plan = h.host.current().state.lessons[0]!, prep = structuredClone(plan.preparation!)
    expect(prep.lesson.graph.waypoints).toHaveLength(1)
    expect(prep.practice!.questions).toHaveLength(1)
    expect(prep.practice!.complete).toBe(false)
    expect(remainingTargetIds(prep.input, prep.practice!)).toEqual([prep.input.targets[1]!.cardId])
    const incomplete = structuredClone(prep); incomplete.practice!.complete = true
    expect(() => validateLessonPreparation(incomplete)).toThrow('every planned teaching target')
    const first = prep.practice!.questions[0]!
    expect(() => validateTargetCoverage(prep.input, prep.lesson.graph, first.question,
      { waypointIds: ['w1'], cardIds: prep.input.targets.map(t => t.cardId) })).toThrow('visible planned targets')
    // One question can legitimately test both expressions; target evidence is not a question quota.
    expect(() => validateTargetCoverage(prep.input, prep.lesson.graph,
      { ...first.question, passage: '请给我一杯茶，不要加糖' }, { waypointIds: ['w1'], cardIds: prep.input.targets.map(t => t.cardId) })).not.toThrow()
    await expect(h.host.apply(s => h.learning.startLesson(s, plan.anchorId, [h.host.current().state.items[0]!.id], plan.goal, plan.settings))).rejects.toThrow('every teaching point')
    await h.host.apply((s, r) => r.mutate(s.version, { id: nid('op'), kind: 'fixture-older-coverage', intent: {}, at: NOW }, state => {
      delete state.lessons[0]!.preparation!.practice!.questions[0]!.coverageReview!.cardIds
    }))
    interrupt = false
    const before = h.transport.mock.calls.length
    await teacher.prepareLesson(sessionId)
    const resumed = h.host.current().state.lessons[0]!.preparation!
    expect(resumed.lesson).toEqual(prep.lesson)
    expect(resumed.practice!.questions[0]!.question).toEqual(first.question)
    expect(resumed.practice!.questions).toHaveLength(2); expect(resumed.check!.questions).toHaveLength(2)
    expect(resumed.practice!.complete && resumed.check!.complete).toBe(true)
    expect(h.transport.mock.calls.slice(before)[0]![0].tools![0]!.function.name).toBe('evaluate_question_coverage')
    expect(remainingTargetIds(resumed.input, resumed.practice!)).toEqual([])
    expect(remainingTargetIds(resumed.input, resumed.check!)).toEqual([])
  })

  it('keeps root model, system, vocabulary and learning preferences out of public search but applies them to drafting', async () => {
    const h = await setup()
    await h.host.apply((s, r) => new GraphService(r, h.clock).setConfiguration(s, 'root', 'modelConfig', { provider: 'featherless', model: 'selected-root-model', temperature: 0.8, maxTokens: 4096 }))
    await h.host.apply((s, r) => new GraphService(r, h.clock).setConfiguration(s, 'root', 'systemConfig', { prompt: 'PRIVATE_ROOT_INSTRUCTION' }))
    await h.host.apply((s, r) => new GraphService(r, h.clock).setConfiguration(s, 'root', 'vocabularyConfig', { words: ['茶'], instruction: 'PRIVATE_VOCABULARY_INSTRUCTION' }))
    const { id: _learnerId, ...profile } = h.host.current().state.learners[0]!
    await h.host.apply((s, r) => new GraphService(r, h.clock).setConfiguration(s, 'root', 'learningConfig', { ...profile, languageBalance: 'mostlyTarget' }))
    await h.service.generate(h.id)
    const calls = h.transport.mock.calls.map(([options]) => options)
    const draft = calls.find(options => options.tools?.[0]?.function.name === 'ground_lesson')!
    expect(draft).toMatchObject({ model: 'selected-root-model', temperature: 0.2, maxTokens: 4096 })
    expect(input(draft)).toMatchObject({ learnerInstruction: 'PRIVATE_ROOT_INSTRUCTION', vocabularyPreferences: { words: ['茶'], instruction: 'PRIVATE_VOCABULARY_INSTRUCTION' }, learner: { languageBalance: 'mostlyTarget' } })
    const review = calls.find(options => options.tools?.[0]?.function.name === 'review_lesson_source')!
    expect(input(review).learner).toMatchObject({ goal: 'PRIVATE_LEARNER_GOAL', languageBalance: 'mostlyTarget' })
  })

  it.each(['topic', 'roleplay', 'interest'] as const)('publishes reviewed %s material with bounded retrieval, graph/search links and no cards or credit', async kind => {
    const h = await setup(kind, true)
    const draft = await h.service.generate(h.id)
    expect(draft).toMatchObject({ status: 'validated', generation: { model: 'actual-discovery-fixture' }, contentReview: { verdict: 'supported' } })
    expect(draft.discovery!.passagePinyin).toContain('chá')
    expect(h.transport).toHaveBeenCalledTimes(kind === 'topic' ? 4 : 5); expect(h.fetcher).toHaveBeenCalledTimes(2)
    const state = h.host.current().state
    expect(state.cards).toHaveLength(0); expect(state.events).toHaveLength(0)
    expect(state.nodes.find(n => n.id === draft.discovery!.nodeId)?.type).toBe('lesson')
    expect(state.edges.find(e => e.target === draft.discovery!.nodeId)?.data.kind).toBe('derived')
    expect(searchLearningHistory(state, 'qing gei', { kind: 'lesson', rootId: 'root' }, NOW)[0]).toMatchObject({ nodeId: draft.discovery!.nodeId })
    expect(searchLearningHistory(state, 'Expanded source', { kind: 'source', rootId: 'root' }, NOW)[0]).toMatchObject({ nodeId: draft.discovery!.nodeId, rootId: 'root' })
    expect(parseBackup(JSON.stringify(exportBackup(h.host.current()))).data.drafts.find(d => d.id === h.id)).toEqual(draft)
    await expect(h.service.saveRequest({ ...draft.discoveryRequest!, publicTopic: 'Overwrite a published lesson' }, h.id)).rejects.toThrow('new request')
  })

  it('atomically captures explicit skills and reviewed teaching material without introducing or duplicating cards', async () => {
    const h = await setup()
    const draft = await h.service.generate(h.id)
    for (const phrase of draft.discovery!.phrases) await h.service.capturePhrase(h.id, phrase.id, ['recognition', 'production', 'meaning'])
    await h.service.capturePhrase(h.id, draft.discovery!.phrases[0]!.id, ['recognition'])
    const state = h.host.current().state
    expect(state.cards).toHaveLength(3); expect(state.items).toHaveLength(1); expect(state.events).toHaveLength(0)
    expect(state.cards.every(c => c.status === 'new' && c.dueAt === null && c.revision === 0)).toBe(true)
    expect(state.drafts.find(d => d.id === h.id)?.cardIds).toHaveLength(3)
    expect(state.drafts.filter(d => d.kind === 'teaching')).toHaveLength(1)
    const before = h.host.current()
    await expect(h.host.apply(s => h.learning.addItem(s, { language: 'zh', kind: 'phrase', canonicalText: '错误', meaning: 'unrelated', senseKey: 'unrelated', sourceNodeIds: [draft.discovery!.nodeId], sourceRootIds: ['root'] }, ['production'], nid('op'), { draftId: h.id, phraseId: draft.discovery!.phrases[0]!.id }))).rejects.toThrow('match a reviewed lesson phrase')
    expect(h.host.current()).toEqual(before); expect((await h.repository.snapshot()).state).toEqual(before.state)
  })



  it('keeps a generated candidate inactive across interrupted content review and explicitly resumes review without another search', async () => {
    const h = await setup(); h.controls.failReview = true
    await expect(h.service.generate(h.id)).rejects.toThrow('interrupted content review')
    const saved = h.host.current().state.drafts.find(d => d.id === h.id)!
    expect(saved.status).toBe('pending'); expect(saved.discovery).toBeDefined()
    expect(h.host.current().state.nodes.filter(n => n.type === 'lesson')).toHaveLength(0)
    const backup = parseBackup(JSON.stringify(exportBackup(h.host.current())))
    const fresh = await WorkspaceRepository.open({ name: nid('recovered-discovery'), initial: () => backup.data, broadcast: false }); repositories.push(fresh)
    let snapshot = await fresh.snapshot()
    const host: TeacherHost = { current: () => snapshot, async apply(command) { snapshot = await command(snapshot, fresh); return snapshot } }
    h.controls.failReview = false
    const review = new DiscoveryService(host, () => h.settings, { clock: h.clock, transport: h.transport, tavilyFetcher: h.fetcher })
    const count = h.transport.mock.calls.length
    await review.resume(h.id)
    expect(h.transport.mock.calls.length - count).toBe(1); expect(h.fetcher).toHaveBeenCalledTimes(1)
    expect(host.current().state.drafts.find(d => d.id === h.id)?.discovery).toEqual(saved.discovery)
    expect(host.current().state.nodes.filter(n => n.type === 'lesson')).toHaveLength(1)
  })

  it('retains retrieved evidence after a draft disconnect and can generate from those saved sources without Tavily', async () => {
    const h = await setup(); h.controls.failDraft = true
    await expect(h.service.generate(h.id)).rejects.toThrow('disconnected')
    const sources = h.host.current().state.drafts.find(d => d.id === h.id)!.sourceIds
    expect(sources.length).toBeGreaterThan(0)
    h.controls.failDraft = false; h.settings.tavily.apiKey = ''
    const before = h.transport.mock.calls.length
    const draft = await h.service.resume(h.id)
    expect(draft.sourceIds).toEqual(sources)
    expect(h.transport.mock.calls.length - before).toBe(4); expect(h.fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['', '2020-01-01', '2030-01-01'])('does not present undated/stale/future material as current news: %s', async published => {
    const h = await setup('interest'); h.controls.published = published
    await expect(h.service.generate(h.id)).rejects.toThrow('last 30 days')
    expect(h.transport).not.toHaveBeenCalled()
    expect(h.host.current().state.nodes.filter(n => n.type === 'lesson')).toHaveLength(0)
    expect(h.host.current().state.cards).toHaveLength(0)
  })

  it('rejects non-Mandarin material with one bounded repair and rejects unsupported content without graph publication', async () => {
    const h = await setup(); h.controls.unsupported = true
    await expect(h.service.generate(h.id)).rejects.toThrow('Use concrete Mandarin expressions')
    expect(h.transport).toHaveBeenCalledTimes(3)
    h.controls.unsupported = false; h.controls.reject = true
    await expect(h.service.generate(h.id, undefined, true)).rejects.toThrow('needs another attempt')
    expect(h.host.current().state.drafts.find(d => d.id === h.id)?.status).toBe('rejected')
    await expect(h.service.capturePhrase(h.id, h.host.current().state.drafts.find(d => d.id === h.id)!.discovery!.phrases[0]!.id, ['recognition'])).rejects.toThrow('reviewed lesson')
    expect(h.host.current().state.nodes.filter(n => n.type === 'lesson')).toHaveLength(0)
  })

  it('retains lesson evidence and captured learning when its graph branch is deleted', async () => {
    const h = await setup(), draft = await h.service.generate(h.id)
    await h.service.capturePhrase(h.id, draft.discovery!.phrases[0]!.id, ['production'])
    const before = h.host.current().state.cards, scope = deletionScope(h.host.current().state, draft.discovery!.nodeId)
    await h.host.apply((s, r) => new GraphService(r, h.clock).deleteSubtree(s, draft.discovery!.nodeId, scope.nodeIds))
    expect(h.host.current().state.cards).toEqual(before)
    expect(searchLearningHistory(h.host.current().state, 'Mandarin tea', { kind: 'lesson' }, NOW)[0]?.missingSource).toBe(true)
    expect(() => validateWorkspace(h.host.current().state)).not.toThrow()
  })






  it.each((['topic', 'roleplay', 'interest'] as const).flatMap(kind => (Object.keys(quizLevels) as QuizLevel[]).map(level => ({ kind, level }))))('runs $kind / $level through the shared prepared lesson, with frozen source and no typing', async ({ kind, level }) => {
    const h = await setup(kind), draft = await h.service.generate(h.id)
    await h.service.capturePhrase(h.id, draft.discovery!.phrases[0]!.id, ['recognition'])
    const itemId = h.host.current().state.items[0]!.id
    await h.host.apply(s => h.learning.startLesson(s, draft.discovery!.nodeId, [itemId], 'Understand a polite tea request.', { quizLevel: level, complexity: 'simple', scope: 'everyday', focus: 'characters', topic: 'Tea' }))
    const sessionId = h.host.current().state.sessions.at(-1)!.id
    const session = () => h.host.current().state.sessions.find(s => s.id === sessionId)!
    expect(lessonForSession(h.host.current().state, session())).toMatchObject({ kind: kind === 'roleplay' ? 'scenario' : kind === 'interest' ? 'reading' : 'topic', source: { draftId: h.id, passageHanzi: draft.discovery!.passageHanzi } })
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: h.transport })
    const calls = h.transport.mock.calls.length, searches = h.fetcher.mock.calls.length
    await teacher.prepareLesson(sessionId)
    expect(h.transport).toHaveBeenCalledTimes(calls + (englishAnswers(level) ? 15 : 13))
    const prepared = h.transport.mock.calls.slice(calls).map(([o]) => input(o))
    expect(prepared[0]).toMatchObject({ kind: lessonForSession(h.host.current().state, session())!.kind, sourceMaterial: { passageHanzi: draft.discovery!.passageHanzi } })
    expect(prepared.find(p => p.generationMode === 'build_question_answers')).toHaveProperty('graph.waypoints')
    expect(h.fetcher).toHaveBeenCalledTimes(searches)
    expect(h.host.current().state.events).toHaveLength(0)
    expect(h.host.current().state.cards[0]!.dueAt).toBeNull()
    await h.host.apply(s => h.learning.advanceLesson(s, sessionId))
    const schedule = structuredClone(h.host.current().state.cards)
    h.clock.at += 2 * DAY
    for (const phase of ['practice', 'check'] as const) {
      await teacher.presentQuizQuestion(sessionId, lessonReadiness(h.host.current().state, session())[phase]!.id, 0)
      const exercise = h.host.current().state.exercises.at(-1)!
      expect(exercise).toMatchObject({ format: 'multipleChoice', mode: 'practice', sourceLessonId: h.id })
      const attemptId = nid('attempt')
      await h.host.apply(s => h.learning.submitAttempt(s, { id: attemptId, exerciseId: exercise.id, answer: '', selectedOptionId: exercise.multipleChoice!.correctOptionId, submittedAt: h.clock.at }))
      await teacher.gradeAttempt(attemptId)
      await h.host.apply(s => h.learning.advanceLesson(s, sessionId))
    }
    expect(h.host.current().state.cards).toEqual(schedule)
    expect(h.transport).toHaveBeenCalledTimes(calls + (englishAnswers(level) ? 15 : 13))
    expect(session().status).toBe('completed')
    const backup = parseBackup(JSON.stringify(exportBackup(h.host.current())))
    expect(backup.data.sessions.at(-1)).toEqual(session())
    for (const corrupt of [
      (state: any) => { state.lessons.at(-1).source.passageHanzi = '不同' },
      (state: any) => { state.exercises[0].mode = 'dueReview' },
      (state: any) => { delete state.exercises[0].sourceLessonId },
    ]) { const state = structuredClone(h.host.current().state); corrupt(state); expect(() => validateWorkspace(state)).toThrow() }
    const savedLesson = structuredClone(lessonForSession(h.host.current().state, session())!)
    h.clock.at = savedLesson.opportunity!.eligibleAt
    await h.host.apply((s, r) => new LessonService(r, h.clock).startActivity(s, savedLesson.id))
    const reviewId = h.host.current().state.sessions.at(-1)!.id
    await teacher.prepareLesson(reviewId)
    const reviewSession = h.host.current().state.sessions.find(s => s.id === reviewId)!
    const check = lessonReadiness(h.host.current().state, reviewSession).check!
    expect(check.sourceLessonId).toBeUndefined()
    await teacher.presentQuizQuestion(reviewId, check.id, 0)
    const reviewExercise = h.host.current().state.exercises.at(-1)!, reviewAttemptId = nid('attempt')
    expect(reviewExercise.mode).toBe('dueReview')
    await h.host.apply(s => h.learning.submitAttempt(s, { id: reviewAttemptId, exerciseId: reviewExercise.id, answer: '', selectedOptionId: reviewExercise.multipleChoice!.correctOptionId, submittedAt: h.clock.at }))
    await teacher.gradeAttempt(reviewAttemptId)
    await h.host.apply(s => h.learning.advanceLesson(s, reviewId))
    expect(lessonProgression(h.host.current().state, savedLesson.id).points).toBe(2)
    expect(lessonForSession(h.host.current().state, session())!.preparation).toEqual(savedLesson.preparation)
  })
  it('preparation failure preserves an unintroduced lesson and explicit retry reuses completed stages', async () => {
    const h = await setup(), draft = await h.service.generate(h.id)
    await h.service.capturePhrase(h.id, draft.discovery!.phrases[0]!.id, ['recognition'])
    await h.host.apply(s => h.learning.startLesson(s, draft.discovery!.nodeId, [s.state.items[0]!.id], 'Tea requests', { quizLevel: 'responseHanzi', complexity: 'simple', scope: 'everyday', focus: 'characters', topic: 'Tea' }))
    const sessionId = h.host.current().state.sessions.at(-1)!.id
    const teacher = new TeacherService(h.host, () => h.settings, { clock: h.clock, transport: h.transport })
    const respond = h.transport.getMockImplementation()!
    h.transport.mockImplementation(async options => { if (input(options).generationMode === 'build_question_answers') throw new Error('disconnected'); return respond(options) })
    await expect(teacher.prepareLesson(sessionId)).rejects.toThrow('disconnected')
    expect(h.host.current().state.cards[0]!.status).toBe('new')
    expect(h.host.current().state.events).toHaveLength(0)
    expect(h.host.current().state.lessons.at(-1)!.brief).toBeTruthy()
    const calls = h.transport.mock.calls.length
    h.transport.mockImplementation(respond)
    await teacher.prepareLesson(sessionId)
    expect(h.transport).toHaveBeenCalledTimes(calls + 9)
  })

})
