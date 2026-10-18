import { nid } from '../id'
import { ImportedModelReviewRequired } from '../domain/original'
import { effectiveConfiguration } from '../graph/contracts'
import { originalReview, type SourceSnapshot, type Workspace } from '../domain/workspace'
import { isDue } from '../learning/leitner'
import { resolveProvider, type Settings } from '../settings'

export function effectiveReviewEvents(state: Workspace) {
  const superseded = new Set(state.events.flatMap(e => e.supersedesEventId ? [e.supersedesEventId] : []))
  return state.events.filter(e => (e.kind === 'review' || e.kind === 'correction') && !superseded.has(e.id))
}
export function recentReviewEvents(state: Workspace, cardId: string) {
  return effectiveReviewEvents(state).filter(e => e.cardId === cardId).reverse().sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 3)
}
export function teacherContext(state: Workspace, cardId: string, now = Date.now(), sourceLessonId?: string) {
  const card = state.cards.find(c => c.id === cardId)
  if (!card) throw new Error('Choose an existing learning card.')
  const item = state.items.find(i => i.id === card.itemId)!, learner = state.learners.find(l => l.id === card.learnerId)!
  const sourceNode = item.sourceNodeIds.map(id => state.nodes.find(n => n.id === id && ['root', 'user', 'assistant'].includes(n.type))).find(Boolean) ?? state.nodes.find(n => n.type === 'root' && item.sourceRootIds.includes(n.id))
  const configuration = sourceNode ? effectiveConfiguration(sourceNode.id, state.nodes, state.edges) : {}
  const effectiveLearner = configuration.learningConfig?.type === 'learningConfig' ? { ...learner, ...configuration.learningConfig.data } : learner
  const citedIds = new Set([
    ...state.exercises.filter(e => e.cardId === card.id).flatMap(e => e.sourceIds),
    ...state.drafts.filter(d => d.cardIds.includes(card.id)).flatMap(d => d.sourceIds),
  ])
  const retained = state.sources.filter(s => s.cardId === card.id || citedIds.has(s.id) || (s.nodeId && item.sourceNodeIds.includes(s.nodeId)))
  const summary = `${item.canonicalText}${item.pinyin ? ` (${item.pinyin})` : ''} — ${item.meaning}. Sense: ${item.senseKey}. Assessed skill: ${card.skill}.`.slice(0, 500)
  const saved = retained.find(s => s.kind === 'local' && s.cardId === card.id && s.excerpt === summary)
  const itemSource: SourceSnapshot = saved ?? { id: nid('source'), kind: 'local', title: `${item.canonicalText} — learning card`.slice(0, 200), excerpt: summary, retrievedAt: now, cardId: card.id, ...(sourceNode ? { nodeId: sourceNode.id } : {}) }
  const lesson = sourceLessonId ? state.drafts.find(d => d.id === sourceLessonId && d.kind === 'discovery' && d.status === 'validated' && d.cardIds.includes(cardId)) : undefined
  if (sourceLessonId && !lesson?.discovery) throw new Error('This card was not explicitly captured from the requested lesson.')
  const preferred = lesson ? state.sources.filter(s => lesson.sourceIds.includes(s.id)) : retained.filter(s => s.id !== itemSource.id).sort((a, b) => b.retrievedAt - a.retrievedAt)
  const sources = [itemSource, ...preferred].slice(0, 3).map(s => ({ ...s, excerpt: s.excerpt.slice(0, 500) }))
  const mistakes = recentReviewEvents(state, card.id).filter(e => e.outcome === 'notRecalled').map(event => {
    const attempt = state.attempts.find(a => a.id === originalReview(event, state.events).attemptId)
    return { occurredAt: event.occurredAt, answer: attempt?.answer.slice(0, 500), feedback: attempt?.assessment?.feedback.slice(0, 500), aid: event.aid }
  })
  const recentQuestions = state.exercises.filter(e => e.cardId === card.id).reverse().sort((a, b) => b.presentedAt - a.presentedAt).slice(0, 3).map(e => ({ format: e.format, prompt: e.prompt.slice(0, 500) }))
  const savedLesson = lesson?.discovery ? { id: lesson.id, kind: lesson.discoveryRequest!.kind, title: lesson.discovery.title, adaptedPassage: lesson.discovery.passageHanzi, translation: lesson.discovery.passageMeaning, roleplay: lesson.discovery.roleplay } : undefined
  return { card, item, learner: effectiveLearner, configuration, sources, mistakes, recentQuestions, savedLesson, due: isDue(card, now) }
}
export function teacherProvider(settings: Settings, context: Pick<ReturnType<typeof teacherContext>, 'configuration'>) {
  const config = context.configuration.modelConfig
  if (config?.type === 'modelConfig' && config.data.requiresReview) throw new ImportedModelReviewRequired()
  const provider = resolveProvider(settings, config?.type === 'modelConfig' ? config.data.provider : settings.selected)
  return { ...provider, ...(config?.type === 'modelConfig' ? { model: config.data.model, temperature: config.data.temperature, maxTokens: config.data.maxTokens } : {}) }
}
export function safeTeacherInput(context: ReturnType<typeof teacherContext>) {
  const { card, item, learner, configuration, sources, mistakes, recentQuestions, savedLesson } = context
  return {
    learner: { level: learner.level, goal: learner.goal, explanationLanguage: learner.explanationLanguage, pinyinDisplay: learner.pinyinDisplay, languageBalance: learner.languageBalance ?? 'balanced' },
    target: { cardId: card.id, skill: card.skill, hanzi: item.canonicalText, pinyin: item.pinyin, sense: item.senseKey, meaning: item.meaning },
    sources: sources.map(({ id, title, excerpt, kind }) => ({ id, title, excerpt, kind })), mistakes, recentQuestions,
    ...(savedLesson ? { savedLesson } : {}),
    ...(configuration.systemConfig?.type === 'systemConfig' ? { learnerInstruction: configuration.systemConfig.data.prompt } : {}),
    ...(configuration.vocabularyConfig?.type === 'vocabularyConfig' ? { vocabularyPreferences: configuration.vocabularyConfig.data } : {}),
  }
}
export function sessionSummary(state: Workspace, sessionId: string, now = Date.now()) {
  const session = state.sessions.find(s => s.id === sessionId)
  if (!session) throw new Error('The lesson session is missing.')
  const exerciseIds = new Set(state.exercises.filter(e => e.sessionId === sessionId).map(e => e.id))
  const reviewed = effectiveReviewEvents(state).filter(e => e.exerciseId && exerciseIds.has(e.exerciseId))
  return {
    reviewed: reviewed.length, recalled: reviewed.filter(e => e.outcome === 'recalled').length,
    notRecalled: reviewed.filter(e => e.outcome === 'notRecalled').length,
    practices: state.events.filter(e => e.kind === 'practice' && e.attemptId && e.exerciseId && exerciseIds.has(e.exerciseId)).length,
    introduced: session.introducedItemIds.length, skipped: session.skippedCardIds.length,
    dueNow: state.cards.filter(c => c.learnerId === session.learnerId && isDue(c, now)).length,
    nextDueAt: state.cards.filter(c => c.learnerId === session.learnerId && c.status === 'active' && c.dueAt! > now).reduce<number | null>((next, c) => next === null ? c.dueAt : Math.min(next, c.dueAt!), null),
    changes: reviewed.map(event => { const original = originalReview(event, state.events), card = state.cards.find(c => c.id === event.cardId)!, item = state.items.find(i => i.id === card.itemId)!; return { cardId: card.id, text: item.canonicalText, skill: card.skill, outcome: event.outcome, beforeBox: original.before.box, afterBox: event.after.box, dueAt: event.after.dueAt } }),
  }
}
