import { sameRecord } from '../domain/common'
import { nid } from '../id'
import { effectiveConfiguration } from '../graph/contracts'
import { resolveProviderAccess } from '../settings'
import { discoveryRequestSchema, MAX_LESSON_POINTS, type DiscoveryRequest } from '../domain/discovery'
import { lessonForSession } from '../domain/lesson'
import { lessonSettingsSchema, type LessonSettings } from '../domain/lessonSettings'
import type { Workspace } from '../domain/workspace'
import { conversationSelection, lessonConversation } from '../learning/conversationPractice'
import { LearningService } from '../learning/learningService'
import { LessonService } from '../learning/lessonService'
import { lessonReadiness } from '../learning/lessonProgress'
import { realClock } from '../learning/leitner'
import type { Settings } from '../settings'
import { DiscoveryService } from './discoveryService'
import { TeacherService, type TeacherHost, type TeacherOptions } from './teacherService'

export function lessonCreationSettings(topic: string, overrides: Partial<LessonSettings> = {}): LessonSettings {
  return lessonSettingsSchema.parse({ quizLevel: 'meaningPinyin', complexity: 'simple', scope: 'everyday', focus: 'characters', topic: topic.slice(0, 200), ...overrides })
}

export function lessonConversationSetup(state: Workspace, nodeId: string, startNodeId?: string) {
  const source = lessonConversation(state, nodeId, startNodeId)
  return { ...source, settings: lessonCreationSettings(source.title) }
}

export function lessonCreationConnected(state: Workspace, settings: Settings, nodeId: string) {
  try {
    const configuration = state.nodes.some(node => node.id === nodeId) ? effectiveConfiguration(nodeId, state.nodes, state.edges) : {}
    const provider = configuration.modelConfig?.type === 'modelConfig' ? configuration.modelConfig.data.provider : settings.selected
    return Boolean(resolveProviderAccess(settings, provider).apiKey)
  } catch { return false }
}

/** Initial form values are shared with non-modal creation screens. */
export function lessonCreationSetup(state: Workspace, anchorId: string, itemId?: string) {
  const selection = conversationSelection(state, anchorId)
  const previous = state.lessons.filter(lesson => lesson.anchorId === anchorId).at(-1)?.settings
  return {
    itemIds: selection.source?.scope ? selection.items.map(item => item.id) : itemId ? [itemId] : selection.items.slice(0, MAX_LESSON_POINTS).map(item => item.id),
    goal: selection.source?.scenario?.objective ?? (selection.kind === 'reading'
      ? 'Understand the selected phrases in this passage and a fresh short reading.'
      : 'Understand these phrases and choose appropriate uses in conversation.'),
    settings: lessonCreationSettings(selection.title, previous),
  }
}

export type LessonCreationProgress = { phase: 'source'; stage: 'sources' | 'planning' | 'draft' | 'review' } | { phase: 'lesson'; stage: string; sessionId: string }
export type LessonCreationResult = { draftId?: string; lessonId: string; sessionId: string; anchorId: string }
type RunOptions = { signal?: AbortSignal; onProgress?: (progress: LessonCreationProgress) => void }
type CreationOptions = TeacherOptions & { teacher?: Pick<TeacherService, 'prepareLesson'>; onProgress?: RunOptions['onProgress'] }
type PauseTarget = { sessionId: string; learnerId: string }
type CreationOperation = { controller: AbortController; target?: PauseTarget; finished: Promise<void>; onProgress?: RunOptions['onProgress'] }

export class LessonCreationPauseError extends Error {
  constructor(cause: unknown) {
    super('Your pause could not be saved. Retry saving before closing.', { cause })
    this.name = 'LessonCreationPauseError'
  }
}

/** Application workflow only: generation, validation and durable checkpoints stay
 * in the existing services. Views own forms, focus and navigation. */
export class LessonCreationService {
  private readonly discovery: DiscoveryService
  private readonly teacher: Pick<TeacherService, 'prepareLesson'>
  private readonly clock
  private active?: CreationOperation
  private pendingPause?: PauseTarget

  constructor(private host: TeacherHost, settings: () => Settings, private options: CreationOptions = {}) {
    this.clock = options.clock ?? realClock
    this.teacher = options.teacher ?? new TeacherService(host, settings, options)
    this.discovery = new DiscoveryService(host, settings, { ...options,
      onProgress: stage => this.active?.onProgress?.({ phase: 'source', stage }) })
  }

  /** Editing generated work forks the request; unchanged saves retain its ID. */
  async saveRequest(request: DiscoveryRequest, draftId?: string) {
    const value = discoveryRequestSchema.parse({ ...request, publicTopic: request.publicTopic.trim() })
    const old = draftId ? this.host.current().state.drafts.find(draft => draft.id === draftId && draft.kind === 'discovery') : undefined
    if (draftId && !old) throw new Error('Choose an existing lesson request.')
    if (old && sameRecord(old.discoveryRequest, value)) return old.id
    return this.discovery.saveRequest(value, old?.status === 'editing' ? old.id : undefined)
  }

  capturePhrase(draftId: string, phraseId: string) {
    return this.discovery.capturePhrase(draftId, phraseId, ['recognition'])
  }

  async saveConversationRequest(nodeId: string, input: { kind: DiscoveryRequest['kind']; settings: LessonSettings; startNodeId?: string }, draftId?: string) {
    const settings = lessonSettingsSchema.parse(input.settings)
    let result = ''
    await this.host.apply(async (snapshot, repository) => {
      const state = snapshot.state, old = draftId ? state.drafts.find(draft => draft.id === draftId && draft.kind === 'discovery') : undefined
      if (draftId && (!old?.discoveryRequest?.origin || old.discoveryRequest.origin.anchorId !== nodeId || old.discoveryRequest.origin.learnerId !== state.activeLearnerId)) throw new Error('Choose your saved conversation lesson request.')
      const previous = old?.discoveryRequest?.origin, frozenSource = state.sources.find(source => source.id === previous?.sourceId), frozen = frozenSource?.conversation
      if (old && old.discoveryRequest?.kind === input.kind && sameRecord(old.creationSettings, settings)
        && (!input.startNodeId || frozen?.messages[0]?.nodeId === input.startNodeId)) { result = old.id; return snapshot }
      const first = input.startNodeId && frozen ? frozen.messages.findIndex(message => message.nodeId === input.startNodeId) : 0
      if (first < 0) throw new Error('Choose a starting message from the saved conversation.')
      const source = frozen ? { ...frozen, title: frozenSource!.title, messages: frozen.messages.slice(first) } : lessonConversation(state, nodeId, input.startNodeId)
      const at = this.clock.now(), sourceId = nid('conversation-source')
      const id = old?.status === 'editing' ? old.id : nid('discovery')
      const request = discoveryRequestSchema.parse({ kind: input.kind, publicTopic: settings.topic.trim() || source.title, rootId: source.rootId,
        extract: false, refresh: false, quizLevel: settings.quizLevel, origin: { kind: 'conversation', anchorId: nodeId, sourceId, learnerId: state.activeLearnerId } })
      const next = await repository.mutate(snapshot.version, { id: nid('op'), kind: 'save-conversation-lesson', intent: { id, request, settings }, at }, document => {
        document.sources.push({ id: sourceId, kind: 'conversation', title: source.title.slice(0, 200), excerpt: source.messages.at(-1)!.text.slice(0, 2000),
          retrievedAt: at, nodeId, conversation: { rootId: source.rootId, anchorId: nodeId, messages: source.messages } })
        const draft = { id, kind: 'discovery' as const, text: '', status: 'editing' as const, sourceIds: [sourceId], cardIds: [],
          discoveryRequest: request, creationSettings: settings, createdAt: old?.createdAt ?? at, updatedAt: at }
        const index = document.drafts.findIndex(saved => saved.id === id)
        if (index >= 0) document.drafts[index] = draft; else document.drafts.push(draft)
      })
      result = id
      return next
    })
    return result
  }

  /** A saved request becomes a complete lesson without a component handoff. */
  createFromRequest(draftId: string, options: RunOptions & { settings?: LessonSettings } = {}) {
    return this.run(options, async (signal, operation) => {
      const draft = this.host.current().state.drafts.find(draft => draft.id === draftId && draft.kind === 'discovery'), request = draft?.discoveryRequest
      if (!request) throw new Error('Choose an existing lesson request.')
      const status = this.status({ draftId }), saved = status.completed ? undefined : status.lesson
      const settings = options.settings ? lessonSettingsSchema.parse(options.settings) : saved?.settings ?? draft?.creationSettings
        ?? lessonCreationSettings(request.publicTopic, { quizLevel: request.quizLevel ?? 'meaningPinyin' })
      if (saved && !sameRecord(saved.settings, settings)) throw new Error('Start a new lesson request to change the saved lesson settings.')
      if (draft?.creationSettings && !sameRecord(draft.creationSettings, settings)) throw new Error('Save a new lesson request to change its settings.')
      await this.discovery.resume(draftId, signal)
      signal.throwIfAborted()
      const created = await this.discovery.startLesson(draftId, settings)
      return this.prepare(created.sessionId, signal, operation)
    })
  }

  createFromSelection(input: { anchorId: string; itemIds: string[]; goal: string; settings: LessonSettings }, options: RunOptions = {}) {
    return this.run(options, async (signal, operation) => {
      const before = new Set<string>()
      const next = await this.host.apply((snapshot, repository) => {
        for (const session of snapshot.state.sessions) before.add(session.id)
        return new LearningService(repository, this.clock).startLesson(snapshot, input.anchorId, input.itemIds, input.goal, input.settings)
      })
      const session = next.state.sessions.find(saved => saved.lessonAttempt && !before.has(saved.id))
      if (!session) throw new Error('The new lesson session was not saved.')
      return this.prepare(session.id, signal, operation)
    })
  }

  resume(sessionId: string, options: RunOptions = {}) {
    return this.run(options, async (signal, operation) => {
      return this.prepare(sessionId, signal, operation)
    })
  }

  retry(lessonId: string, options: RunOptions = {}) {
    return this.run(options, async (signal, operation) => {
      const next = await this.host.apply((snapshot, repository) => new LessonService(repository, this.clock).startActivity(snapshot, lessonId))
      const session = next.state.sessions.find(saved => saved.status === 'active' && saved.learnerId === next.state.activeLearnerId && saved.lessonAttempt?.lessonId === lessonId)
      if (!session) throw new Error('The lesson activity was not saved.')
      return this.prepare(session.id, signal, operation)
    })
  }

  /** Reconstruct readiness from saved records; no second job store is needed. */
  status(target: { draftId: string } | { sessionId: string }) {
    const state = this.host.current().state
    const matches = state.sessions.filter(saved => saved.learnerId === state.activeLearnerId
      && ('sessionId' in target ? saved.id === target.sessionId : lessonForSession(state, saved)?.source?.draftId === target.draftId))
    const session = matches.find(saved => saved.status !== 'completed') ?? matches.at(-1)
    const lesson = lessonForSession(state, session)
    const readiness = lesson && session ? lessonReadiness(state, session) : undefined
    return { phase: readiness?.ready ? 'ready' as const : lesson ? 'lesson' as const : 'source' as const,
      draftId: 'draftId' in target ? target.draftId : lesson?.source?.draftId,
      sessionId: session?.id, completed: session?.status === 'completed', lesson, readiness }
  }

  async pause() {
    const operation = this.active
    if (operation) {
      operation.controller.abort()
      await operation.finished
    }
    await this.savePendingPause()
  }

  private async savePendingPause() {
    const target = this.pendingPause
    if (!target) return
    try {
      await this.host.apply((snapshot, repository) => {
        const session = snapshot.state.sessions.find(saved => saved.id === target.sessionId && saved.learnerId === target.learnerId)
        return session?.status === 'active'
          ? new LearningService(repository, this.clock).setSessionStatus(snapshot, session.id, 'paused')
          : Promise.resolve(snapshot)
      })
      if (this.pendingPause === target) this.pendingPause = undefined
    } catch (cause) { throw new LessonCreationPauseError(cause) }
  }

  private async prepare(sessionId: string, signal: AbortSignal, operation: CreationOperation): Promise<LessonCreationResult> {
    let state = this.host.current().state
    const session = state.sessions.find(saved => saved.id === sessionId)
    if (!session || session.learnerId !== state.activeLearnerId || session.status === 'completed' || !lessonForSession(state, session)) throw new Error('Choose an unfinished lesson to continue.')
    operation.target = { sessionId, learnerId: session.learnerId }
    operation.onProgress?.({ phase: 'lesson', stage: 'Preparing your lesson…', sessionId })
    signal.throwIfAborted()
    if (session.status !== 'active') await this.host.apply((snapshot, repository) => new LearningService(repository, this.clock).setSessionStatus(snapshot, sessionId, 'active'))
    if (!this.status({ sessionId }).readiness?.ready) await this.teacher.prepareLesson(sessionId, signal,
      stage => operation.onProgress?.({ phase: 'lesson', stage, sessionId }))
    signal.throwIfAborted()
    state = this.host.current().state
    const saved = state.sessions.find(current => current.id === sessionId)!, lesson = lessonForSession(state, saved)!
    if (!lessonReadiness(state, saved).ready) throw new Error('The lesson is missing its prepared material or quizzes.')
    return { lessonId: lesson.id, sessionId, anchorId: lesson.anchorId, ...(lesson.source ? { draftId: lesson.source.draftId } : {}) }
  }

  private run(options: RunOptions, action: (signal: AbortSignal, operation: CreationOperation) => Promise<LessonCreationResult>) {
    if (this.active) return Promise.reject(new Error('Pause the current lesson creation before starting another.'))
    const operation: CreationOperation = { controller: new AbortController(), finished: Promise.resolve(), onProgress: options.onProgress ?? this.options.onProgress }
    const signal = options.signal ? AbortSignal.any([options.signal, operation.controller.signal]) : operation.controller.signal
    this.active = operation
    const result = Promise.resolve().then(async () => {
      try { await this.savePendingPause(); signal.throwIfAborted(); return await action(signal, operation) }
      catch (error) {
        if (operation.target) {
          this.pendingPause = operation.target
          await this.savePendingPause()
        }
        throw error
      } finally { if (this.active === operation) this.active = undefined }
    })
    operation.finished = result.then(() => {}, () => {})
    return result
  }
}
