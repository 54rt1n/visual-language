import { z } from 'zod'
import { lessonSchema, lessonForSession, lessonView, canKeepPracticeAlongsideReview } from './lesson'
import { defaultLearningCalendar } from './learningCalendar'
import { nid } from '../id'
import { normalizeEndpoint, publicSourceUrl } from '../ai/http'
import { validateGraph } from '../graph/contracts'
import { validateAssessment } from '../learning/assessment'
import { introduce, isDue, resume, review, suspend } from '../learning/leitner'
import { quizDraftSchema, validateQuizDraft, quizQuestionPrompt } from '../learning/quiz'
import { defaultSettings, providerCompatibilitySchema, providerDefaults, providerIds, publicProviderPreferences } from '../settings'
import { generationSchema, teachingMaterialSchema, quizTargetSchema } from '../teacher/contracts'
import { identifier, ids, policyVersion, revision, sameRecord, shortText, timestamp, uniqueIds } from './common'
import { edgeSchema, graphNodeSchema, graphViewSchema } from './graph'
import { attemptSchema, cardSchema, eventSchema, exerciseSchema, itemSchema, learnerSchema, learningContextSchema, sessionSchema, type LearningEvent } from './learning'
import { discoveryMaterialSchema, discoveryRequestSchema, discoveryPlanningSchema } from './discovery'
import { workedExampleSchema } from './workedExample'
import { readingNoteSchema } from './reading'
import { preparedLessonSteps } from './lessonPlan'
import { validateLessonPreparation, validateGraphDraft } from './lessonPreparation'

const endpoint = z.string().max(2000).refine(value => { try { return !value || normalizeEndpoint(value) === value } catch { return false } }, 'Unsafe provider endpoint.')
const publicProfile = z.strictObject({ baseUrl: endpoint, model: z.string().max(200), compatibility: providerCompatibilitySchema.optional() })
export const preferencesSchema = z.strictObject({
  selected: z.enum(providerIds),
  profiles: z.strictObject({ featherless: publicProfile, nebius: publicProfile, openrouter: publicProfile, custom: publicProfile,
    openai: publicProfile.default(() => ({ ...providerDefaults.openai })), anthropic: publicProfile.default(() => ({ ...providerDefaults.anthropic })),
    google: publicProfile.default(() => ({ ...providerDefaults.google })), alibaba: publicProfile.default(() => ({ ...providerDefaults.alibaba })),
    minimax: publicProfile.default(() => ({ ...providerDefaults.minimax })) }),
})
export const sourceSchema = z.strictObject({
  id: identifier, kind: z.enum(['web', 'local']), title: shortText(200),
  url: z.string().max(4000).refine(value => { try { publicSourceUrl(value); return true } catch { return false } }, 'Unsafe source URL.').optional(),
  excerpt: z.string().max(2000), retrievedAt: timestamp, publishedAt: z.string().max(100).optional(), query: z.string().max(300).optional(),
  nodeId: identifier.optional(), cardId: identifier.optional(), adapted: z.boolean().optional(),
}).refine(source => source.kind !== 'web' || Boolean(source.url), 'Web sources require a citation URL.')
export const draftSchema = z.strictObject({
  id: identifier, kind: z.enum(['composer', 'answer', 'quiz', 'teaching', 'discovery', 'feedback', 'reading']), exerciseId: identifier.optional(), sessionId: identifier.optional(), selectedOptionId: identifier.optional(), text: z.string().max(12_000),
  quiz: quizDraftSchema.optional(), status: z.enum(['editing', 'pending', 'validated', 'rejected']), sourceIds: ids(20), cardIds: ids(27),
  lesson: teachingMaterialSchema.optional(), generation: generationSchema.optional(),
  discoveryPlanning: discoveryPlanningSchema.optional(), discoveryRequest: discoveryRequestSchema.optional(), discovery: discoveryMaterialSchema.optional(),
  sourceLessonId: identifier.optional(),
  lessonPhase: z.enum(['practice', 'check']).optional(),
  attemptId: identifier.optional(), workedExample: workedExampleSchema.optional(),
  reading: readingNoteSchema.optional(),
  quizTargets: z.array(quizTargetSchema).min(1).max(9).optional(),
  discardedAt: timestamp.optional(), replacesDraftId: identifier.optional(),
  learningContext: learningContextSchema.optional(),
  createdAt: timestamp, updatedAt: timestamp,
  contentReview: z.strictObject({ verdict: z.enum(['supported', 'uncertain', 'rejected']), reasons: shortText(4000),
    provider: shortText(100), model: shortText(200), promptVersion: shortText(100) }).optional(),
})
export const operationSchema = z.strictObject({ id: identifier, deviceId: identifier, baseRevision: revision, occurredAt: timestamp, kind: shortText(100), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
export const tombstoneSchema = z.strictObject({ id: identifier, entityType: z.enum(['node', 'edge', 'item', 'draft']), entityId: identifier, deletedAt: timestamp, operationId: identifier })
export const workspaceSchema = z.strictObject({
  id: identifier, name: shortText(200), createdAt: timestamp, revision, schemaVersion: z.literal(1),
  activeLearnerId: identifier, demo: z.strictObject({ enabled: z.boolean(), now: timestamp, contentMode: z.enum(['live', 'fixtures']).optional() }).nullable(),
  view: graphViewSchema, preferences: preferencesSchema,
  nodes: z.array(graphNodeSchema).min(1).max(12_000), edges: z.array(edgeSchema).max(30_000),
  learners: z.array(learnerSchema).min(1).max(20), items: z.array(itemSchema).max(20_000), cards: z.array(cardSchema).max(60_000),
  exercises: z.array(exerciseSchema).max(50_000), attempts: z.array(attemptSchema).max(100_000), events: z.array(eventSchema).max(100_000),
  lessons: z.array(lessonSchema).max(10_000),
  sessions: z.array(sessionSchema).max(10_000), sources: z.array(sourceSchema).max(30_000), drafts: z.array(draftSchema).max(10_000),
  operations: z.array(operationSchema).max(200_000), tombstones: z.array(tombstoneSchema).max(30_000),
})
export type Workspace = z.infer<typeof workspaceSchema>
export const collectionNames = ['nodes', 'edges', 'learners', 'items', 'cards', 'exercises', 'attempts', 'events', 'sessions', 'lessons', 'sources', 'drafts', 'operations', 'tombstones'] as const
export type CollectionName = typeof collectionNames[number]
export type SourceSnapshot = z.infer<typeof sourceSchema>
export type SavedDraft = z.infer<typeof draftSchema>

/** Find the initial review behind a (possibly repeatedly corrected) effective event. */
export function originalReview(event: LearningEvent, events: LearningEvent[]): LearningEvent {
  const visited = new Set<string>(), byId = new Map(events.map(e => [e.id, e]))
  let current = event
  while (current.supersedesEventId) {
    if (visited.has(current.id)) throw new Error('Correction history contains a cycle.')
    visited.add(current.id)
    const previous = byId.get(current.supersedesEventId)
    if (!previous) throw new Error('Correction references a missing event.')
    current = previous
  }
  if (current.kind !== 'review') throw new Error('Only review outcomes can be corrected.')
  return current
}

/** Runtime validation at every persistence/import boundary, including relational integrity. */
export function validateWorkspace(value: unknown): Workspace {
  const state = workspaceSchema.parse(value)
  const sets = Object.fromEntries(collectionNames.map(name => [name, uniqueIds(state[name], name)])) as Record<CollectionName, Set<string>>
  const requireRef = (name: CollectionName, id: string, label: string) => { if (!sets[name].has(id)) throw new Error(`${label} references missing ${name}.`) }
  const distinct = (list: string[], label: string) => { if (new Set(list).size !== list.length) throw new Error(`${label} must be distinct.`) }
  validateGraph(state.nodes, state.edges)
  requireRef('learners', state.activeLearnerId, 'Workspace')
  if (!state.nodes.some(n => n.id === state.view.activeRootId && n.type === 'root')) throw new Error('The active topic is missing.')
  state.view.selectedNodeIds.forEach(id => requireRef('nodes', id, 'Selection'))
  const cards = new Map(state.cards.map(c => [c.id, c])), exercises = new Map(state.exercises.map(e => [e.id, e])), sessions = new Map(state.sessions.map(s => [s.id, s])), attempts = new Map(state.attempts.map(a => [a.id, a]))
  const identities = new Set<string>()
  for (const item of state.items) {
    const identity = JSON.stringify([item.language, item.canonicalText.normalize('NFC').trim(), item.senseKey.normalize('NFC').trim().toLocaleLowerCase()])
    if (identities.has(identity)) throw new Error('Duplicate learning item/sense identity.')
    identities.add(identity)
    distinct(item.sourceNodeIds, 'Item source nodes'); distinct(item.sourceRootIds, 'Item source roots')
    // Deleted graph links are intentionally tolerated. Text/meaning and frozen sources survive.
  }
  identities.clear()
  for (const card of state.cards) {
    requireRef('learners', card.learnerId, 'Card'); requireRef('items', card.itemId, 'Card')
    const key = JSON.stringify([card.learnerId, card.itemId, card.skill])
    if (identities.has(key)) throw new Error('Duplicate learner/item/skill identity.')
    identities.add(key)
  }
  for (const node of state.nodes) {
    if (node.type === 'exercise') requireRef('exercises', node.data.exerciseId, 'Exercise graph node')
    if (node.type === 'chunk' && node.data.itemId) requireRef('items', node.data.itemId, 'Chunk')
    if (node.type === 'lesson') {
      const lesson = state.drafts.find(d => d.id === node.data.draftId && d.kind === 'discovery' && d.status === 'validated')
      if (lesson?.discovery?.nodeId !== node.id || lesson.discoveryRequest?.rootId !== node.rootId) throw new Error('A lesson node must reference its validated lesson in the same topic.')
    }
  }
  for (const source of state.sources) if (source.cardId) requireRef('cards', source.cardId, 'Source')
  for (const exercise of state.exercises) {
    requireRef('cards', exercise.cardId, 'Exercise'); requireRef('sessions', exercise.sessionId, 'Exercise')
    const card = cards.get(exercise.cardId)!
    if (exercise.sourceLessonId) {
      const lesson = state.drafts.find(d => d.id === exercise.sourceLessonId && d.kind === 'discovery' && d.status === 'validated')
      if (!lesson?.cardIds.includes(card.id) || exercise.mode !== 'practice') throw new Error('Discovery questions require a captured skill card and practice-only mode.')
    }
    if (sessions.get(exercise.sessionId)!.learnerId !== card.learnerId || exercise.cardRevision > card.revision) throw new Error('Exercise learner/revision is inconsistent.')
    if (exercise.mode === 'dueReview' && exercise.format === 'multipleChoice' && card.skill !== 'recognition') throw new Error('Multiple choice cannot schedule a meaning/production review.')
    if (exercise.multipleChoice) {
      const mc = exercise.multipleChoice
      const draft = state.drafts.find(d => d.id === mc.quizId && d.kind === 'quiz' && d.status === 'validated' && d.contentReview?.verdict === 'supported')
      if (draft?.sessionId && draft.sessionId !== exercise.sessionId) throw new Error('A quiz question belongs to a different lesson session.')
      const question = draft?.quiz?.questions.find(q => q.cardId === exercise.cardId && q.lessonStep === exercise.lessonStep)
      if (exercise.lessonStep !== question?.lessonStep || mc.quizLevel !== question?.quizLevel || mc.passagePinyin !== question?.passagePinyin) throw new Error('A quiz exercise must preserve its lesson step and presentation.')
      if (exercise.sourceLessonId !== draft?.sourceLessonId) throw new Error('A quiz exercise must preserve its source-lesson practice provenance.')
      if (question?.workedExample ? !exercise.workedExample || !sameRecord(question.workedExample, { hanzi: exercise.workedExample.hanzi, meaning: exercise.workedExample.meaning, explanation: exercise.workedExample.explanation }) : exercise.workedExample) throw new Error('A quiz exercise must preserve its reviewed worked example.')
      if (!question || mc.correctOptionId !== question.correctOptionId || !sameRecord(mc.options, question.options) || mc.explanation !== question.explanation || !sameRecord(mc.distractorFeedback, question.distractorFeedback) || !sameRecord(exercise.sourceIds, question.sourceIds) || exercise.prompt !== quizQuestionPrompt(question) || exercise.expectedAnswer !== question.options.find(o => o.id === question.correctOptionId)!.text) throw new Error('A quiz exercise must exactly match a frozen, content-reviewed draft.')
    }
    exercise.sourceIds.forEach(id => requireRef('sources', id, 'Exercise'))
    if (exercise.lessonStep !== undefined) {
      const plan = lessonView(state, sessions.get(exercise.sessionId))
      const step = plan?.steps[exercise.lessonStep]
      if (!step || step.cardId !== card.id || step.phase === 'learn' || exercise.format !== 'multipleChoice' || (exercise.mode !== 'practice' && plan!.activity !== 'review') || exercise.multipleChoice?.quizLevel !== plan!.settings.quizLevel) throw new Error('Exercise does not match its topic lesson plan.')
    }
    if (exercise.learningContext && exercise.learningContext.webUsed !== exercise.sourceIds.some(id => state.sources.find(s => s.id === id)?.kind === 'web')) throw new Error('Exercise web attribution must match its cited sources.')
    distinct(exercise.sourceIds, 'Exercise sources')
    // Find the exact historical card version used when the prompt was presented.
    const captured = card.revision === exercise.cardRevision ? card : state.events.find(e => e.cardId === card.id && e.before.revision === exercise.cardRevision && e.kind !== 'practice')?.before
    if (!captured || (exercise.mode === 'dueReview' && !isDue(captured, exercise.presentedAt))) throw new Error('Exercise eligibility does not match its saved card revision.')
  }
  identities.clear()
  for (const plan of state.lessons) {
    requireRef('learners', plan.learnerId, 'Lesson')
    distinct(plan.cardIds, 'Lesson cards')
    plan.cardIds.forEach(id => { requireRef('cards', id, 'Prepared lesson'); if (cards.get(id)!.learnerId !== plan.learnerId) throw new Error('Lesson belongs to another learner.') })
    if ((plan.kind === 'scenario' && !plan.source?.scenario) || (plan.kind === 'reading' && !plan.source) || (plan.kind !== 'scenario' && plan.source?.scenario)) throw new Error('The lesson recipe needs matching frozen source material.')
    if (plan.source) {
      const source = state.drafts.find(d => d.id === plan.source!.draftId)
      if (!sameRecord(plan.source.scope, source?.discoveryPlanning?.accepted)) throw new Error('A lesson must preserve its accepted teaching scope.')
      if (source?.status !== 'validated' || !source.discovery || plan.kind !== (source.discoveryRequest?.kind === 'roleplay' ? 'scenario' : source.discoveryRequest?.kind === 'interest' ? 'reading' : 'topic') || source.discovery.passageHanzi !== plan.source.passageHanzi || source.discovery.passageMeaning !== plan.source.passageMeaning || !sameRecord(source.discovery.roleplay, plan.source.scenario) || plan.cardIds.some(id => !source.cardIds.includes(id))) throw new Error('The lesson must preserve its reviewed discovery source and selected targets.')
    }
    if (plan.waypointDraft) {
      const draft = validateGraphDraft(plan.waypointDraft)
      if (plan.preparation || !sameRecord([...plan.cardIds].sort(), draft.input.targets.map(t => t.cardId).sort()) || !sameRecord(plan.settings, draft.input.settings) || plan.kind !== draft.input.kind || plan.goal !== draft.input.objective || plan.context !== draft.input.conversationContext || !sameRecord(plan.source, draft.input.sourceMaterial)) throw new Error('Waypoint draft must preserve its selected lesson material.')
      for (const source of draft.input.sources) {
        const saved = state.sources.find(s => s.id === source.id)
        if (!saved || saved.title !== source.title || saved.excerpt !== source.excerpt) throw new Error('Waypoint draft source changed or is unavailable.')
      }
    }
    if (plan.preparation) {
      const prep = validateLessonPreparation(plan.preparation)
      if (!sameRecord([...plan.cardIds].sort(), prep.input.targets.map(t => t.cardId).sort()) || !sameRecord(plan.settings, prep.input.settings) || plan.kind !== prep.input.kind || plan.goal !== prep.input.objective || plan.context !== prep.input.conversationContext || !sameRecord(plan.source, prep.input.sourceMaterial) || plan.brief !== prep.lesson.graph.overview) throw new Error('Lesson preparation must preserve its selected material and settings.')
      for (const source of prep.input.sources) {
        const saved = state.sources.find(s => s.id === source.id)
        if (!saved || saved.title !== source.title || saved.excerpt !== source.excerpt) throw new Error('Lesson preparation source changed or is unavailable.')
      }
    } else if (plan.brief || plan.steps.length) throw new Error('An unprepared lesson cannot have authored steps or progress.')
    if (plan.cardIds.some(id => cards.get(id)!.skill !== 'recognition') || !sameRecord(plan.steps, plan.preparation ? preparedLessonSteps(plan.preparation, plan.settings, plan.kind) : [])) throw new Error('A lesson must follow its reviewed waypoint order and saved questions.')
    if (plan.opportunity?.previousSessionId) {
      const previous = sessions.get(plan.opportunity.previousSessionId)
      if (!previous?.lessonAttempt || previous.lessonAttempt.lessonId !== plan.id || previous.status !== 'completed') throw new Error('Review opportunity references a different or unfinished lesson activity.')
    }
  }
  const openLessonCycles = new Set<string>(), passedLessonCycles = new Set<string>()
  const activeQuestions = new Map<string, (typeof state.sessions)[number][]>()
  for (const session of state.sessions) {
    requireRef('learners', session.learnerId, 'Session')
    for (const list of [session.selectedCardIds, session.completedCardIds, session.skippedCardIds]) {
      distinct(list, 'Session card IDs'); list.forEach(id => { requireRef('cards', id, 'Session'); if (cards.get(id)!.learnerId !== session.learnerId) throw new Error('Session card belongs to another learner.') })
    }
    if (session.lessonAttempt) {
      requireRef('lessons', session.lessonAttempt.lessonId, 'Session')
      const lesson = lessonForSession(state, session)!
      if (lesson.learnerId !== session.learnerId || lesson.goal !== session.goal) throw new Error('Lesson activity must preserve its learner and objective.')
      if (lesson.archivedAt !== undefined && session.status === 'active') throw new Error('An archived lesson keeps its unfinished activities paused.')
      const activity = session.lessonAttempt
      if (activity.activity !== 'practice' && !activity.cycleId) throw new Error('A scored lesson activity requires its saved opportunity.')
      const key = `${lesson.id}:${activity.cycleId}`
      if (session.status !== 'completed' && activity.activity !== 'practice') {
        if (openLessonCycles.has(key) || activity.cycleId !== lesson.opportunity?.id) throw new Error('A lesson opportunity can have only one unfinished scored activity.')
        openLessonCycles.add(key)
      }
      if (activity.completion?.passed && activity.activity !== 'practice') {
        if (passedLessonCycles.has(key)) throw new Error('A lesson opportunity can award only one point.')
        passedLessonCycles.add(key)
      }
      if (activity.activity === 'review' && !activity.checkPreparation) throw new Error('A review requires its own check preparation.')
      if (activity.checkPreparation?.quiz) {
        if (!lesson.preparation?.check?.complete) throw new Error('A fresh check requires the saved prepared lesson.')
        if (activity.checkPreparation.quiz.questions.length > lesson.preparation.check.questions.length) throw new Error('A fresh check cannot exceed the original assessment length.')
        validateLessonPreparation({ ...lesson.preparation, check: activity.checkPreparation.quiz })
      }
      if (activity.exposures && (new Set(activity.exposures.map(e => e.cardId)).size !== activity.exposures.length || activity.exposures.some(e => !lesson.cardIds.includes(e.cardId)))) throw new Error('Recall exposure must reference distinct lesson targets.')
    }
    if (session.lessonAttempt?.completion && (session.status !== 'completed' || session.lessonAttempt.completion.completedAt < session.createdAt)) throw new Error('Completion evidence requires a completed lesson activity.')
    const plan = lessonView(state, session)
    if (plan) {
      if (state.exercises.some(e => e.sessionId === session.id && ((e.mode !== 'practice' && plan.activity !== 'review') || !plan.cardIds.includes(e.cardId)))) throw new Error('Prepared lesson exercises must use selected skills; scored reviews require a review activity.')
      if (new Set(plan.remediatedSteps).size !== plan.remediatedSteps.length) throw new Error('Supported retries must be distinct.')
      for (const index of plan.remediatedSteps) {
        const exercise = state.exercises.find(e => e.sessionId === session.id && e.lessonStep === index)
        if (index > plan.stepIndex || !exercise || !state.attempts.some(a => a.exerciseId === exercise.id && a.status === 'committed' && (a.assessment?.grade !== 'correct' || a.helpUsed))) throw new Error('Supported retry must follow a reached, answered lesson question needing support.')
      }
      const length = plan.steps.length
      if (!plan.preparation?.check?.complete && (plan.stepIndex || state.exercises.some(e => e.sessionId === session.id))) throw new Error('Finish preparing the lesson before playback.')
      const lessonExercises = state.exercises.filter(e => e.sessionId === session.id)
      if (lessonExercises.some(e => e.lessonStep === undefined || e.lessonStep > plan.stepIndex) || new Set(lessonExercises.map(e => e.lessonStep)).size !== lessonExercises.length) throw new Error('Lesson questions require distinct, reached steps.')
      if (plan.stepIndex > length || plan.skippedSteps.some(step => step >= plan.stepIndex) || new Set(plan.skippedSteps).size !== plan.skippedSteps.length) throw new Error('Invalid lesson progress.')
      if (session.activeExerciseId) {
        const exercise = exercises.get(session.activeExerciseId)
        if (!exercise || (exercise.mode !== 'practice' && plan.activity !== 'review') || exercise.cardId !== plan.steps[plan.stepIndex]?.cardId || plan.stepIndex === length || exercise.lessonStep !== plan.stepIndex) throw new Error('Lesson exercise does not match its selected step.')
      }
      const completion = session.lessonAttempt!.completion
      if (completion) {
        const checks = plan.steps.filter(s => s.phase === 'check')
        if (!checks.length || completion.answers.length !== checks.length || completion.answers.some((a, i) => a.questionId !== checks[i]!.questionId || a.cardId !== checks[i]!.cardId)
          || completion.passed !== completion.answers.every(a => a.outcome === 'correct') || plan.stepIndex !== length) throw new Error('Completion must preserve every check result and the perfect-score pass rule.')
        for (const answer of completion.answers) {
          const exercise = answer.exerciseId ? exercises.get(answer.exerciseId) : undefined
          const attempt = answer.attemptId ? state.attempts.find(a => a.id === answer.attemptId) : undefined
          if ((answer.exerciseId && (!exercise || exercise.sessionId !== session.id || exercise.cardId !== answer.cardId))
            || (answer.attemptId && (!attempt || attempt.exerciseId !== exercise?.id))
            || (['correct', 'incorrect', 'helped'].includes(answer.outcome) && attempt?.status !== 'committed')) throw new Error('Completion answers must retain their original activity and submitted evidence.')
          if (answer.outcome === 'correct' && (attempt?.helpUsed || attempt?.assessment?.grade !== 'correct'
            || attempt.selectedOptionId !== exercise?.multipleChoice?.correctOptionId)) throw new Error('A correct check result requires its original unaided correct selection.')
        }
        if (completion.pointAwarded && (!completion.passed || plan.activity === 'practice')) throw new Error('Only a scored perfect pass can earn a lesson point.')
      }
    }
    if (session.selectedCardIds.length > session.maxReviewCards || session.introducedItemIds.length > session.maxNewItems) throw new Error('Session exceeds its configured limits.')
    if ([...session.completedCardIds, ...session.skippedCardIds].some(id => !session.selectedCardIds.includes(id))) throw new Error('Session outcomes must refer to selected cards.')
    session.introducedItemIds.forEach(id => requireRef('items', id, 'Session'))
    if (session.activeExerciseId) {
      requireRef('exercises', session.activeExerciseId, 'Session')
      const exercise = exercises.get(session.activeExerciseId)!
      const others = activeQuestions.get(exercise.cardId) ?? []
      if (exercise.sessionId !== session.id || session.status === 'completed' || others.some(other => !canKeepPracticeAlongsideReview(other, session))) throw new Error('Duplicate or inconsistent active exercise.')
      activeQuestions.set(exercise.cardId, [...others, session])
    }
  }
  for (const lesson of state.lessons) {
    const completed = state.sessions.filter(s => s.lessonAttempt?.lessonId === lesson.id && s.lessonAttempt.completion)
    const passes = completed.filter(s => s.lessonAttempt!.activity !== 'practice' && s.lessonAttempt!.completion!.passed).length
    if (completed.filter(s => s.lessonAttempt!.completion!.pointAwarded).length !== Math.min(10, passes)) throw new Error('Saved lesson points must match qualifying successful opportunities.')
  }
  const pendingExercise = new Set<string>()
  for (const attempt of state.attempts) {
    requireRef('exercises', attempt.exerciseId, 'Attempt')
    const exercise = exercises.get(attempt.exerciseId)!
    if (attempt.cardId !== exercise.cardId || attempt.submittedAt < exercise.presentedAt) throw new Error('Attempt card or timestamp is inconsistent.')
    if (exercise.multipleChoice && !attempt.helpUsed && !exercise.multipleChoice.options.some(o => o.id === attempt.selectedOptionId)) throw new Error('Attempt option does not belong to its frozen question.')
    if (attempt.assessment) validateAssessment(attempt.assessment, exercise)
    if (attempt.status === 'committed' && (!attempt.assessment || !attempt.assessmentSource || attempt.assessment.grade === 'uncertain' || !state.events.some(e => e.attemptId === attempt.id))) throw new Error('Committed attempt lacks a resolved event/assessment.')
    if (attempt.status === 'pending') {
      if (pendingExercise.has(attempt.exerciseId)) throw new Error('An exercise cannot have two pending answers.')
      pendingExercise.add(attempt.exerciseId)
    }
  }
  const eventById = new Map(state.events.map(e => [e.id, e])), scheduledExercises = new Set<string>(), superseded = new Set<string>()
  const transitions = new Map<string, LearningEvent[]>()
  for (const event of state.events) {
    requireRef('cards', event.cardId, 'Event')
    if (event.before.id !== event.cardId || event.after.id !== event.cardId) throw new Error('Event card identity does not match.')
    for (const key of ['learnerId', 'itemId', 'skill', 'introducedAt'] as const) if (event.kind !== 'introduced' && event.before[key] !== event.after[key]) throw new Error('An event changed immutable card identity.')
    if (event.exerciseId) { requireRef('exercises', event.exerciseId, 'Event'); if (exercises.get(event.exerciseId)!.cardId !== event.cardId) throw new Error('Event exercise/card mismatch.') }
    if (event.exerciseId && event.occurredAt < exercises.get(event.exerciseId)!.presentedAt) throw new Error('An exercise event predates presentation.')
    if (event.attemptId) { requireRef('attempts', event.attemptId, 'Event'); if (attempts.get(event.attemptId)!.exerciseId !== event.exerciseId) throw new Error('Event attempt/exercise mismatch.') }
    if (event.attemptId && event.occurredAt !== attempts.get(event.attemptId)!.submittedAt) throw new Error('A graded event must retain the original submission timestamp.')
    if (event.kind === 'review' || event.kind === 'correction') {
      if (!event.exerciseId || !event.outcome || event.outcome === 'unresolved' || exercises.get(event.exerciseId)!.mode !== 'dueReview') throw new Error('Review events require a resolved, eligible exercise.')
      if (event.kind === 'review') {
        if (scheduledExercises.has(event.exerciseId)) throw new Error('An exercise has more than one scheduling event.')
        scheduledExercises.add(event.exerciseId)
        if (event.before.revision !== exercises.get(event.exerciseId)!.cardRevision) throw new Error('Review used a stale card revision.')
      }
    }
    let expected = event.before
    if (event.kind === 'introduced') expected = introduce(event.before, event.occurredAt)
    if (event.kind === 'suspended') expected = suspend(event.before, event.occurredAt)
    if (event.kind === 'resumed') expected = resume(event.before, event.occurredAt)
    if (event.kind === 'review') expected = review(event.before, event.outcome!, event.occurredAt, true)
    if (event.kind === 'correction') {
      const previous = event.supersedesEventId && eventById.get(event.supersedesEventId)
      if (!previous || !['review', 'correction'].includes(previous.kind) || previous.cardId !== event.cardId || previous.exerciseId !== event.exerciseId || superseded.has(previous.id) || !sameRecord(previous.after, event.before)) throw new Error('Invalid or historical correction chain.')
      superseded.add(previous.id)
      const original = originalReview(previous, state.events)
      if (event.occurredAt !== original.occurredAt) throw new Error('Correction must retain the original review timestamp.')
      expected = { ...review(original.before, event.outcome!, original.occurredAt, true), revision: event.before.revision + 1 }
    } else if (event.supersedesEventId) throw new Error('Only corrections may supersede an event.')
    if (!sameRecord(expected, event.after)) throw new Error('Event state does not match the Leitner policy.')
    if (event.kind !== 'practice') transitions.set(event.cardId, [...(transitions.get(event.cardId) ?? []), event])
  }
  for (const card of state.cards) {
    const chain = (transitions.get(card.id) ?? []).sort((a, b) => a.after.revision - b.after.revision)
    for (let i = 0; i < chain.length; i++) {
      const event = chain[i]!
      if (event.before.revision !== i || event.after.revision !== i + 1 || (i > 0 && !sameRecord(chain[i - 1]!.after, event.before))) throw new Error('Review history has a missing or inconsistent transition.')
    }
    if (card.revision !== chain.length || (chain.length && !sameRecord(chain.at(-1)!.after, card)) || (!chain.length && card.status !== 'new')) throw new Error('Current card is inconsistent with its event history.')
  }
  const preparedPhases = new Set<string>()
  for (const draft of state.drafts) {
    if (draft.lessonPhase) {
      const plan = lessonView(state, sessions.get(draft.sessionId ?? ''))
      const checkpoint = plan?.preparation?.[draft.lessonPhase]
      if (draft.kind !== 'quiz' || !plan || !draft.quiz || !checkpoint?.complete || draft.status !== 'validated' || !sameRecord([...draft.cardIds].sort(), [...new Set(checkpoint.questions.map(q => q.question.cardId))].sort()) || draft.quiz.questions.length !== checkpoint.questions.length) throw new Error('A prepared quiz must match its completed waypoint checkpoint.')
      for (const [index, question] of draft.quiz.questions.entries()) {
        const accepted = checkpoint.questions[index]!
        const expected = { ...accepted.question, lessonStep: plan.steps.findIndex(s => s.phase === draft.lessonPhase && s.questionId === accepted.id) }
        const stable = (q: typeof question) => JSON.parse(JSON.stringify({ ...q, options: [...q.options].sort((a, b) => a.id.localeCompare(b.id)) }))
        if (!sameRecord(stable(question), stable(expected))) throw new Error('Prepared questions must preserve their accepted content and presentation.')
      }
      if (draft.discardedAt === undefined) {
        const key = `${draft.sessionId}:${draft.lessonPhase}`
        if (preparedPhases.has(key)) throw new Error('A lesson phase can have only one current quiz candidate.')
        preparedPhases.add(key)
      }
    } else if (draft.quiz?.questions.some(q => q.lessonStep !== undefined)) throw new Error('Lesson quiz presentation requires its generation phase.')
    if (draft.kind === 'teaching' && draft.sessionId && sessions.get(draft.sessionId)?.lessonAttempt) {
      const plan = lessonView(state, sessions.get(draft.sessionId))!
      if (draft.cardIds.length !== 1 || !plan.cardIds.includes(draft.cardIds[0]!) || draft.lesson?.itemId !== cards.get(draft.cardIds[0]!)?.itemId || draft.status !== 'validated' || draft.contentReview?.verdict !== 'supported') throw new Error('Prepared teaching material must match a lesson target and pass content review.')
    }
    if (draft.kind === 'quiz') {
      if (!draft.lessonPhase && draft.quiz?.questions.some(q => q.quizLevel !== draft.quizTargets?.find(t => t.cardId === q.cardId)?.reviewSettings?.quizLevel)) throw new Error('Review presentation must preserve its frozen target settings.')
      if (draft.quizTargets) {
        if (!sameRecord(draft.quizTargets.map(t => t.cardId).sort(), [...draft.cardIds].sort()) || new Set(draft.quizTargets.map(t => t.cardId)).size !== draft.cardIds.length || draft.quizTargets.some(t => cards.get(t.cardId)?.skill !== t.skill)) throw new Error('Frozen quiz targets must match its distinct skill cards.')
      }
      if (draft.discardedAt !== undefined && (draft.discardedAt < draft.createdAt || draft.status === 'validated' || state.exercises.some(e => e.multipleChoice?.quizId === draft.id))) throw new Error('Only an unused inactive quiz can be discarded.')
      if (draft.replacesDraftId) {
        const prior = state.drafts.find(d => d.id === draft.replacesDraftId && d.kind === 'quiz')
        if (!prior || prior.id === draft.id || prior.discardedAt === undefined || prior.createdAt > draft.createdAt || !sameRecord([...prior.cardIds].sort(), [...draft.cardIds].sort()) || prior.sourceLessonId !== draft.sourceLessonId) throw new Error('A replacement quiz must retain its archived predecessor and targets.')
        if (draft.sourceIds.some(id => !prior.sourceIds.includes(id)) || (prior.quizTargets && !sameRecord(draft.quizTargets, prior.quizTargets)) || prior.lessonPhase !== draft.lessonPhase || (prior.lessonPhase && prior.sessionId !== draft.sessionId)) throw new Error('Quiz regeneration must preserve frozen target preferences and reuse its predecessor sources.')
        if (state.drafts.some(other => other.id !== draft.id && other.replacesDraftId === prior.id)) throw new Error('An archived quiz candidate cannot have multiple replacements.')
        const visited = new Set([draft.id]); let cursor: typeof prior | undefined = prior
        while (cursor) { if (visited.has(cursor.id)) throw new Error('Quiz replacement history cannot contain a cycle.'); visited.add(cursor.id); cursor = state.drafts.find(d => d.id === cursor!.replacesDraftId) }
      }
    } else if (draft.quizTargets || draft.discardedAt !== undefined || draft.replacesDraftId) throw new Error('Quiz recovery metadata belongs only to quiz drafts.')
    if (draft.kind === 'reading') {
      if (!draft.reading || !draft.generation || draft.status !== 'validated' || draft.cardIds.length || draft.sourceIds.length || draft.exerciseId || draft.sessionId) throw new Error('Reading notes need frozen text and provenance, not assessment records.')
      requireRef('learners', draft.reading.learnerId, 'Reading note')
      // Source deletion/edits do not destroy historical notes; lookup requires an exact source hash.
    } else if (draft.reading) throw new Error('Word explanations belong only to reading notes.')
    if (draft.kind === 'feedback') {
      const attempt = state.attempts.find(a => a.id === draft.attemptId)
      if (!attempt || attempt.status !== 'committed' || draft.exerciseId !== attempt.exerciseId || !sameRecord(draft.cardIds, [attempt.cardId]) || !draft.workedExample || !draft.generation || draft.status !== 'validated' || !draft.sourceIds.length) throw new Error('Feedback material needs its committed answer, worked example, sources and provenance.')
    } else if (draft.attemptId || draft.workedExample) throw new Error('Separate worked feedback belongs only to a feedback draft.')
    if (draft.exerciseId) requireRef('exercises', draft.exerciseId, 'Draft')
    if (draft.sessionId) requireRef('sessions', draft.sessionId, 'Draft')
    if (draft.selectedOptionId && (!draft.exerciseId || draft.kind !== 'answer' || !exercises.get(draft.exerciseId)?.multipleChoice?.options.some(o => o.id === draft.selectedOptionId))) throw new Error('An answer draft references an unavailable option.')
    draft.sourceIds.forEach(id => requireRef('sources', id, 'Draft')); draft.cardIds.forEach(id => requireRef('cards', id, 'Draft'))
    if (!['discovery', 'quiz'].includes(draft.kind) && draft.cardIds.length > 3) throw new Error('Only discovery lessons may link more than three skill cards.')
    if (draft.sourceLessonId) {
      const lesson = state.drafts.find(d => d.id === draft.sourceLessonId && d.kind === 'discovery' && d.status === 'validated')
      if (draft.kind !== 'quiz' || !lesson || draft.cardIds.some(id => !lesson.cardIds.includes(id))) throw new Error('A lesson quiz must target explicitly captured skill cards from its saved lesson.')
    }
    if (draft.kind === 'discovery') {
      if (!draft.discoveryRequest) throw new Error('A discovery lesson needs its saved request.')
      if (draft.status === 'validated' && (!draft.discovery || !draft.generation || draft.contentReview?.verdict !== 'supported')) throw new Error('A published discovery lesson needs content, provenance and a supported review.')
      const planning = draft.discoveryPlanning
      if (planning?.accepted) {
        const accepted = planning.accepted
        distinct(accepted.points.map(p => p.id), 'Accepted teaching point IDs')
        if (!sameRecord(accepted.request, draft.discoveryRequest) || accepted.outline !== planning.outline || !sameRecord(accepted.points, planning.candidate) || planning.revision) throw new Error('Accepted lesson scope must preserve its reviewed request, outline and points.')
        if (draft.discoveryRequest.kind === 'interest' && (!planning.reading || accepted.points.some(p => !planning.reading!.passage.includes(p.expression)))) throw new Error('Reading teaching points must quote the fixed passage.')
      }
      if (draft.discovery) {
        const lesson = draft.discovery, phrases = new Map(lesson.phrases.map(p => [p.id, p]))
        if (planning?.accepted && (lesson.phrases.length !== planning.accepted.points.length || planning.accepted.points.some(p => {
          const phrase = phrases.get(p.id)
          return !phrase || phrase.hanzi !== p.expression || phrase.meaning !== p.meaning || phrase.explanation !== p.purpose
        }))) throw new Error('Lesson material must preserve every accepted teaching point.')
        if (planning?.reading && (lesson.passageHanzi !== planning.reading.passage || lesson.passageMeaning !== planning.reading.translation)) throw new Error('Reading material must preserve the frozen passage.')
        if (!lesson.sourceIds.some(id => state.sources.some(s => s.id === id && (s.kind === 'web' || s.kind === 'local' && s.adapted)))) throw new Error('A lesson must retain its web sources or clearly labeled AI-written material.')
        distinct(lesson.phrases.map(p => p.id), 'Lesson phrase IDs'); distinct(lesson.captures.map(c => c.phraseId), 'Captured lesson phrases')
        if ((draft.discoveryRequest.kind === 'roleplay') !== Boolean(lesson.roleplay)) throw new Error('Role-play material must match its requested lesson kind.')
        for (const id of [...lesson.sourceIds, ...lesson.phrases.flatMap(p => p.sourceIds)]) if (!draft.sourceIds.includes(id)) throw new Error('A lesson cites a source outside its frozen evidence.')
        for (const capture of lesson.captures) {
          requireRef('items', capture.itemId, 'Lesson capture')
          if (!phrases.has(capture.phraseId) || !capture.cardIds.length) throw new Error('A lesson capture needs a proposed phrase and explicit skill cards.')
          const item = state.items.find(i => i.id === capture.itemId)!, phrase = phrases.get(capture.phraseId)!
          if (item.canonicalText.normalize('NFC').trim() !== phrase.hanzi.normalize('NFC').trim() || item.senseKey.normalize('NFC').trim().toLowerCase() !== phrase.sense.normalize('NFC').trim().toLowerCase()) throw new Error('A lesson capture must retain its proposed phrase/sense identity.')
          distinct(capture.cardIds, 'Captured skill cards')
          for (const id of capture.cardIds) { requireRef('cards', id, 'Lesson capture'); if (cards.get(id)!.itemId !== capture.itemId) throw new Error('Captured lesson skills must belong to the captured item.') }
        }
        if (!sameRecord([...new Set(lesson.captures.flatMap(c => c.cardIds))].sort(), [...draft.cardIds].sort())) throw new Error('A lesson must link exactly its captured skill cards.')
      } else if (draft.cardIds.length) throw new Error('An unfinished discovery request cannot create cards.')
    } else if (draft.discovery || draft.discoveryRequest || draft.discoveryPlanning) throw new Error('Discovery material belongs only to discovery drafts.')
    if (draft.learningContext && draft.learningContext.webUsed !== draft.sourceIds.some(id => state.sources.find(s => s.id === id)?.kind === 'web')) throw new Error('Draft web attribution must match its cited sources.')
    if (draft.kind === 'quiz' && draft.quiz && !draft.lessonPhase) validateQuizDraft(draft.quiz, draft.cardIds, draft.sourceIds)
    if (draft.kind === 'quiz' && draft.status === 'validated' && (!draft.quiz || draft.contentReview?.verdict !== 'supported')) throw new Error('Quiz activation requires a supported content review.')
    if (draft.lesson) {
      if (draft.kind !== 'teaching') throw new Error('Teaching material belongs only to a teaching draft.')
      requireRef('items', draft.lesson.itemId, 'Teaching material')
      if (draft.cardIds.some(id => cards.get(id)!.itemId !== draft.lesson!.itemId)) throw new Error('Teaching material targets a different item.')
      draft.lesson.sourceIds.forEach(id => { requireRef('sources', id, 'Teaching material'); if (!draft.sourceIds.includes(id)) throw new Error('Teaching source was not part of its saved context.') })
    }
    if (draft.kind === 'teaching' && draft.status === 'validated' && (!draft.lesson || !draft.generation)) throw new Error('Validated teaching material requires saved content and provenance.')
  }
  for (const session of state.sessions) {
    for (const phase of ['practice', 'check'] as const) {
      if (phase === 'practice' && (session.lessonAttempt?.activity === 'review' || session.lessonAttempt?.quizOnly)) continue
      if (lessonView(state, session)?.preparation?.[phase]?.complete && !preparedPhases.has(`${session.id}:${phase}`)) throw new Error('A completed lesson phase must retain its playable quiz.')
    }
  }
  for (const tombstone of state.tombstones) requireRef('operations', tombstone.operationId, 'Deletion record')
  return state
}

export function createWorkspace(now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Workspace {
  const rootId = nid('root'), learnerId = nid('learner')
  return validateWorkspace({ id: nid('workspace'), name: 'My Mandarin workspace', createdAt: now, revision: 0, schemaVersion: 1, activeLearnerId: learnerId, demo: null,
    nodes: [{ id: rootId, rootId, type: 'root', position: { x: 0, y: 0 }, bookmarked: false, collapsed: false, data: { name: 'Conversation' } }], edges: [],
    learners: [{ id: learnerId, level: 'beginner', goal: 'Use practical Mandarin with confidence.', explanationLanguage: 'English', pinyinDisplay: 'always', maxReviewCards: 10, maxNewItems: 3, learningCalendar: defaultLearningCalendar(timeZone) }],
    view: { activeRootId: rootId, selectedNodeIds: [], viewport: { x: 80, y: 220, zoom: 0.9 }, teacherCollapsed: false, teacherPortraits: true, composerDraft: '' },
    preferences: publicProviderPreferences(defaultSettings()),
    items: [], cards: [], exercises: [], attempts: [], events: [], sessions: [], lessons: [], sources: [], drafts: [], operations: [], tombstones: [],
  })
}
export const supportedPolicies = [policyVersion.value] as const
