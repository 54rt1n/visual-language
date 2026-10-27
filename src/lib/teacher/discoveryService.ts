import { nid } from '../id'
import { streamChat } from '../ai/client'
import { ActionBudget } from '../ai/tools'
import { discoveryMaterialSchema, discoveryRequestSchema, type DiscoveryRequest, type DiscoveryProposal } from '../domain/discovery'
import type { SavedDraft, SourceSnapshot, Workspace } from '../domain/workspace'
import type { Skill } from '../domain/learning'
import { effectiveConfiguration } from '../graph/contracts'
import { learningPreferences } from '../graph/graphService'
import { containsHanzi, mandarinPinyin } from '../mandarin/chineseParser'
import { realClock } from '../learning/leitner'
import { LearningService } from '../learning/learningService'
import { resolveTavilyKey, type Settings } from '../settings'
import { searchWeb, extractSources, searchCacheKey } from '../search/tavily'
import { SearchResultCache } from '../search/resultCache'
import { prepareLessonSource, reviewLessonSource } from './lessonGeneration/sourcePreparation'
import type { LessonSettings } from '../domain/lessonSettings'
import { type TeacherHost, type TeacherOptions } from './teacherService'
import { teacherProvider } from './teacherContext'

function sourceIds(proposal: DiscoveryProposal) { return [...new Set([...proposal.sourceIds, ...proposal.phrases.flatMap(p => p.sourceIds)])] }
function freezeSources(state: Workspace, sources: SourceSnapshot[]) { for (const source of sources) if (!state.sources.some(s => s.id === source.id)) state.sources.push(source) }
function recentPublished(source: SourceSnapshot) {
  const date = source.publishedAt ? Date.parse(source.publishedAt) : NaN
  return Number.isFinite(date) && date <= Date.now() + 86_400_000 && date >= Date.now() - 30 * 86_400_000
}
function validateProposal(proposal: DiscoveryProposal, request: DiscoveryRequest, sources: SourceSnapshot[]) {
  if ([proposal.title, proposal.explanation, proposal.passageMeaning, ...proposal.phrases.flatMap(p => [p.meaning, p.sense, p.explanation, p.exampleMeaning]), ...Object.values(proposal.roleplay ?? {})].some(text => !text.trim())) throw new Error('Lesson content cannot be blank.')
  if ((request.kind === 'roleplay') !== Boolean(proposal.roleplay)) throw new Error('The lesson did not supply the requested kind of material.')
  if (!containsHanzi(proposal.passageHanzi) || proposal.phrases.some(p => !containsHanzi(p.hanzi) || !containsHanzi(p.exampleHanzi)) || (proposal.roleplay && !containsHanzi(proposal.roleplay.openingHanzi))) throw new Error('The lesson needs Mandarin passages, phrases and examples.')
  if (new Set(proposal.phrases.map(p => `${p.hanzi.normalize('NFKC').trim()}\0${p.sense.normalize('NFKC').trim().toLowerCase()}`)).size !== proposal.phrases.length) throw new Error('The lesson repeated a phrase/sense proposal.')
  if (sourceIds(proposal).some(id => !sources.some(s => s.id === id))) throw new Error('The lesson cited unavailable evidence.')
  if (!proposal.sourceIds.length) throw new Error('The lesson needs saved source material.')
  if (request.kind === 'interest' && sources.some(s => s.kind === 'web') && !proposal.sourceIds.some(id => sources.some(s => s.id === id && s.kind === 'web' && recentPublished(s)))) throw new Error('Current-interest reading needs a dated source from the last 30 days.')
}

/** Native material acquisition with optional web examples, separate from review scheduling. No proposed phrase becomes
 * a learning card and no lesson becomes graph material until its respective gate. */
export class DiscoveryService {
  readonly clock
  private transport
  private sourceCache = new SearchResultCache()
  constructor(private host: TeacherHost, private settings: () => Settings, private options: TeacherOptions & { onProgress?: (stage: 'sources' | 'planning' | 'draft' | 'review') => void } = {}) {
    this.clock = options.clock ?? realClock; this.transport = options.transport ?? streamChat
  }
  private save(kind: string, intent: unknown, change: (state: Workspace) => void) {
    return this.host.apply((s, r) => r.mutate(s.version, { id: nid('op'), kind, intent, at: this.clock.now() }, change))
  }
  private draft(id: string) {
    const draft = this.host.current().state.drafts.find(d => d.id === id && d.kind === 'discovery')
    if (!draft?.discoveryRequest) throw new Error('Save a discovery request first.')
    return draft
  }
  private context(id: string) {
    const state = this.host.current().state, draft = this.draft(id), request = draft.discoveryRequest!
    if (state.demo?.enabled && state.demo.contentMode === 'fixtures') throw new Error('Prerecorded rehearsal has no generated discovery lessons. Switch to live mode explicitly.')
    if (!state.nodes.some(n => n.id === request.rootId && n.type === 'root')) throw new Error('This lesson’s topic was removed. Create a new request in an existing topic.')
    const configuration = effectiveConfiguration(request.rootId, state.nodes, state.edges)
    return { draft, request, configuration, learner: learningPreferences(state, request.rootId), provider: teacherProvider(this.settings(), { configuration }) }
  }
  async saveRequest(request: DiscoveryRequest, draftId?: string) {
    const value = discoveryRequestSchema.parse({ ...request, publicTopic: request.publicTopic.trim() })
    const id = draftId ?? nid('discovery'), at = this.clock.now()
    await this.save('save-discovery-request', { id, request: value }, state => {
      if (!state.nodes.some(n => n.id === value.rootId && n.type === 'root')) throw new Error('Choose an existing topic.')
      const old = state.drafts.find(d => d.id === id)
      if (old && (old.kind !== 'discovery' || old.status !== 'editing' || old.discovery)) throw new Error('Create a new request instead of changing generated lesson material.')
      const draft: SavedDraft = { id, kind: 'discovery', text: '', status: 'editing', discoveryRequest: value, sourceIds: [], cardIds: [], createdAt: old?.createdAt ?? at, updatedAt: at }
      if (old) state.drafts[state.drafts.indexOf(old)] = draft; else state.drafts.push(draft)
    })
    return id
  }
  async capturePhrase(id: string, phraseId: string, skills: Skill[]) {
    const draft = this.draft(id), phrase = draft.discovery?.phrases.find(p => p.id === phraseId)
    if (draft.status !== 'validated' || !phrase || !draft.discovery) throw new Error('Choose a phrase from a reviewed lesson.')
    if (!this.host.current().state.nodes.some(n => n.id === draft.discoveryRequest!.rootId && n.type === 'root')) throw new Error('The lesson’s topic was removed. Recreate the lesson in an existing topic before capturing new items.')
    return this.host.apply((snapshot, repository) => new LearningService(repository, this.clock).addItem(snapshot, {
      language: 'zh', kind: 'phrase', canonicalText: phrase.hanzi, pinyin: phrase.pinyin, senseKey: phrase.sense, meaning: phrase.meaning,
      sourceNodeIds: [draft.discovery!.nodeId], sourceRootIds: [draft.discoveryRequest!.rootId],
    }, skills, nid('op'), { draftId: id, phraseId }))
  }
  /** Continue from the last saved stage rather than repeat completed work. */
  async resume(id: string, signal?: AbortSignal) {
    const draft = this.draft(id)
    if (draft.status === 'validated') return draft
    if (draft.discovery && draft.status !== 'rejected') return this.review(id, signal)
    return this.generate(id, signal, Boolean(draft.sourceIds.length))
  }
  async generate(id: string, signal?: AbortSignal, useSavedSources = false) {
    const context = this.context(id)
    if (!context.request.publicTopic.trim()) throw new Error('Enter a topic before creating a lesson.')
    if (context.draft.status === 'validated') throw new Error('Create a new request to generate another version.')
    const budget = new ActionBudget(signal, 900_000)
    budget.limits.model = 32
    try {
      budget.signal.throwIfAborted()
      await this.save('begin-discovery-generation', { id }, state => {
        const draft = state.drafts.find(d => d.id === id)!
        draft.status = 'pending'; draft.text = ''; draft.sourceIds = []; delete draft.discovery; delete draft.generation; delete draft.contentReview
      })
      let sources = useSavedSources ? this.host.current().state.sources.filter(s => context.draft.sourceIds.includes(s.id)).slice(0, 3) : []
      let key = ''
      if (!useSavedSources) { try { key = resolveTavilyKey(this.settings()) } catch { /* AI-written lessons need no search account. */ } }
      if (key) {
        this.options.onProgress?.('sources')
        const input = { query: `${context.request.publicTopic} Mandarin language examples`.slice(0, 300), purpose: 'Language examples for the requested lesson', current: context.request.kind === 'interest' }
        budget.use('search_web')
        const access = { apiKey: key, signal: budget.signal, fetcher: this.options.tavilyFetcher, now: () => this.clock.now(), onRequest: this.options.onTavilyRequest }
        const found = await searchWeb(input, access, this.sourceCache.get(searchCacheKey(input)), context.request.refresh)
        this.sourceCache.set(found); sources = found.sources.slice(0, 3)
        if (context.request.kind === 'interest') sources = sources.filter(recentPublished)
        if (!sources.length) throw new Error(context.request.kind === 'interest' ? 'No dated source from the last 30 days was found. Try another topic or refresh the search.' : 'The search returned no usable examples. Try another topic or refresh the search.')
        if (context.request.extract) {
          budget.use('extract_sources')
          const extracted = await extractSources(sources.slice(0, 2).map(s => s.id), sources, access)
          sources = [...extracted.sources, ...sources.filter(s => !extracted.sources.some(e => e.url === s.url))].slice(0, 3)
        }
      }
      if (sources.length) await this.save('freeze-discovery-sources', { id }, state => {
        freezeSources(state, sources); state.drafts.find(d => d.id === id)!.sourceIds = sources.map(s => s.id)
      })
      this.options.onProgress?.('planning')
      const result = await prepareLessonSource(context.request, context.learner, sources, { provider: context.provider, transport: async request => { budget.use('model'); return this.transport(request) }, signal: budget.signal,
        modelProfile: this.options.lessonModelProfile, inputTokenCounter: this.options.inputTokenCounter, onSubmission: this.options.onSubmission, onCheckpointCommitted: this.options.onCheckpointCommitted,
        checkpoint: this.draft(id).discoveryPlanning,
        onStage: name => this.options.onProgress?.(name.startsWith('prepare_') ? 'draft' : 'planning'),
        onPlanning: planning => this.save('checkpoint-discovery-scope', { id }, state => {
          const draft = state.drafts.find(d => d.id === id)!
          draft.discoveryPlanning = planning; draft.updatedAt = this.clock.now()
        }).then(() => {}),
        additionalContext: { ...(context.configuration.systemConfig?.type === 'systemConfig' ? { learnerInstruction: context.configuration.systemConfig.data.prompt } : {}),
          ...(context.configuration.vocabularyConfig?.type === 'vocabularyConfig' ? { vocabularyPreferences: context.configuration.vocabularyConfig.data } : {}) } })
      const proposal = result.proposal
      if (!sources.length) {
        sources = [{ id: nid('source'), kind: 'local', adapted: true, title: 'AI-written Mandarin practice', excerpt: proposal.passageHanzi, retrievedAt: this.clock.now() }]
        proposal.sourceIds = sources.map(s => s.id)
        for (const phrase of proposal.phrases) phrase.sourceIds = [...proposal.sourceIds]
      }
      validateProposal(proposal, context.request, sources)
      const at = this.clock.now(), material = discoveryMaterialSchema.parse({ ...proposal, nodeId: nid('lesson-node'), passagePinyin: mandarinPinyin(proposal.passageHanzi), captures: [],
        phrases: proposal.phrases.map((p, index) => ({ ...p, id: result.planning.accepted!.points[index]!.id, pinyin: mandarinPinyin(p.hanzi), examplePinyin: mandarinPinyin(p.exampleHanzi) })) })
      budget.signal.throwIfAborted()
      await this.save('save-discovery-candidate', { id }, state => {
        const draft = state.drafts.find(d => d.id === id)!
        freezeSources(state, sources); draft.discovery = material; draft.sourceIds = sourceIds(proposal); draft.updatedAt = at
        draft.generation = { provider: context.provider.provider, model: result.model, promptVersion: 'lesson-source-v2', createdAt: at }
      })
      return await this.reviewWithBudget(id, budget)
    } finally { budget.dispose() }
  }
  async review(id: string, signal?: AbortSignal) {
    const budget = new ActionBudget(signal, 900_000)
    try { return await this.reviewWithBudget(id, budget) } finally { budget.dispose() }
  }
  private async reviewWithBudget(id: string, budget: ActionBudget) {
    const context = this.context(id), draft = context.draft
    if (draft.status === 'validated') return draft
    if (!draft.discovery || !draft.generation) throw new Error('Create the lesson material first.')
    const sources = this.host.current().state.sources.filter(s => draft.sourceIds.includes(s.id))
    validateProposal(draft.discovery, context.request, sources)
    this.options.onProgress?.('review')
    const result = await reviewLessonSource(context.request, context.learner, draft.discovery, sources, { provider: context.provider, transport: async request => { budget.use('model'); return this.transport(request) }, signal: budget.signal,
      modelProfile: this.options.lessonModelProfile, inputTokenCounter: this.options.inputTokenCounter, onSubmission: this.options.onSubmission,
      checkpoint: draft.discoveryPlanning })
    const supported = result.value.accepted
    budget.signal.throwIfAborted()
    await this.save('review-discovery-material', { id, supported }, state => {
      const current = state.drafts.find(d => d.id === id)!
      if (current.status === 'validated' || current.discovery?.nodeId !== draft.discovery!.nodeId) throw new Error('The lesson changed. Reopen the saved version.')
      current.status = supported ? 'validated' : 'rejected'; current.updatedAt = this.clock.now()
      current.contentReview = { verdict: supported ? 'supported' : 'rejected', reasons: result.value.reason, provider: context.provider.provider, model: result.model, promptVersion: 'lesson-source-review-v2' }
      if (supported) {
        const root = state.nodes.find(n => n.id === context.request.rootId && n.type === 'root')
        if (!root) throw new Error('The destination topic was removed.')
        const bottom = Math.max(root.position.y, ...state.nodes.filter(n => n.rootId === root.id).map(n => n.position.y + 260))
        state.nodes.push({ id: current.discovery!.nodeId, rootId: root.id, type: 'lesson', position: { x: root.position.x + 430, y: bottom + 70 }, bookmarked: false, collapsed: false, data: { draftId: id } })
        state.edges.push({ id: nid('edge'), source: root.id, target: current.discovery!.nodeId, data: { kind: 'derived' } })
      }
    })
    if (!supported) throw new Error(`The lesson material needs another attempt: ${result.value.reason}`)
    return this.draft(id)
  }
  /** One creation entry: acquired material feeds the same saved lesson harness as conversation lessons. */
  async startLesson(id: string, settings: LessonSettings) {
    const draft = this.draft(id)
    if (draft.status !== 'validated' || !draft.discovery) throw new Error('Finish preparing the source material first.')
    for (const phrase of draft.discovery.phrases) await this.capturePhrase(id, phrase.id, ['recognition'])
    const state = this.host.current().state
    const existing = state.sessions.find(s => s.status !== 'completed' && s.learnerId === state.activeLearnerId && state.lessons.some(l => l.id === s.lessonAttempt?.lessonId && l.source?.draftId === id))
    if (existing) {
      if (existing.status !== 'active') await this.host.apply((s, r) => new LearningService(r, this.clock).setSessionStatus(s, existing.id, 'active'))
      return { nodeId: draft.discovery.nodeId, sessionId: existing.id }
    }
    const next = await this.host.apply((s, r) => new LearningService(r, this.clock).startLesson(s, draft.discovery!.nodeId,
      s.state.drafts.find(d => d.id === id)!.discovery!.captures.map(c => c.itemId), draft.discovery!.roleplay?.objective ?? `Learn useful Mandarin for ${draft.discoveryRequest!.publicTopic}.`, settings))
    return { nodeId: draft.discovery.nodeId, sessionId: next.state.sessions.at(-1)!.id }
  }
}
