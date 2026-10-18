import { lessonForSession, lessonView, canKeepPracticeAlongsideReview } from '../domain/lesson'
import { changeLearningDayStart, resolveLearningCalendar } from './learningCalendar'
import { completeLessonActivity, recordLessonExposure, touchLessonActivity } from './lessonLifecycle'
import { nid } from '../id'
import { originalReview, type Workspace } from '../domain/workspace'
import { assessmentSchema, exerciseSchema, itemSchema, type Assessment, type Exercise, type LearningEvent, type LearningItem, type ReviewAttempt, type Skill } from '../domain/learning'
import { WorkspaceConflict, type WorkspaceRepository, type WorkspaceSnapshot, type WorkspaceVersion } from '../storage/repository'
import { deterministicAssessment, validateAssessment } from './assessment'
import { correctionImpact } from './corrections'
import { exerciseMode, introduce, realClock, resume, review, sessionQueue, suspend, type Clock } from './leitner'
import { learningPreferences } from '../graph/graphService'
import { conversationSelection } from './conversationPractice'
import { createLessonPlan, lessonSettingsSchema, type LessonSettings } from '../domain/lessonPlan'
import { lessonStep, lessonReadiness } from './lessonProgress'
import { dictionaryCitationKey } from '../domain/dictionaryCitation'
import { readingSourceMatches, type ReadingSourceGuard } from '../mandarin/captureSource'

function requireCard(state: Workspace, id: string) {
  const card = state.cards.find(c => c.id === id)
  if (!card) throw new Error('The learning card no longer exists.')
  return card
}
function requireSession(state: Workspace, id: string) {
  const session = state.sessions.find(s => s.id === id)
  if (!session) throw new Error('The lesson session no longer exists.')
  return session
}
function requireExercise(state: Workspace, id: string) {
  const exercise = state.exercises.find(e => e.id === id)
  if (!exercise) throw new Error('The saved question no longer exists.')
  return exercise
}
function replaceCard(state: Workspace, card: Workspace['cards'][number]) { state.cards[state.cards.findIndex(c => c.id === card.id)] = card }
function hasReview(state: Workspace, exerciseId: string) { return state.events.some(e => e.exerciseId === exerciseId && e.kind === 'review') }
function hasHelp(state: Workspace, exerciseId: string) { return state.events.some(e => e.exerciseId === exerciseId && e.aid) }

/** Commands are the only scheduling write path; model output is a proposal, never a mutation. */
export class LearningService {
  constructor(readonly repository: WorkspaceRepository, readonly clock: Clock = realClock) {}
  private change(expected: WorkspaceVersion, kind: string, intent: unknown, fn: (state: Workspace) => void, operationId = nid('op'), at = this.clock.now()) {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return this.repository.mutate(expected, { id: operationId, kind, intent, at }, state => {
      const learner = state.learners.find(l => l.id === state.activeLearnerId)!
      learner.learningCalendar = resolveLearningCalendar(learner.learningCalendar, at, browserZone)
      fn(state)
    })
  }
  setLearningDayStart(snapshot: WorkspaceSnapshot, startMinute: number) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'set-learning-day-start', { startMinute }, state => {
      const learner = state.learners.find(l => l.id === state.activeLearnerId)!
      learner.learningCalendar = changeLearningDayStart(learner.learningCalendar, at, startMinute)
    }, nid('op'), at)
  }
  async addItem(snapshot: WorkspaceSnapshot, input: Omit<LearningItem, 'id' | 'createdAt'>, skills: Skill[] = ['production'], operationId = nid('op'), discoveryCapture?: { draftId: string; phraseId: string }, readingCapture?: ReadingSourceGuard) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'add-learning-item', { input, skills, ...(discoveryCapture ? { discoveryCapture } : {}), ...(readingCapture ? { readingCapture } : {}) }, state => {
      if (readingCapture && (!input.sourceNodeIds.includes(readingCapture.nodeId) || !readingSourceMatches(state.nodes.find(node => node.id === readingCapture.nodeId), input.canonicalText, readingCapture))) throw new Error('The response changed. Select the word again before saving it.')
      if (!skills.length || new Set(skills).size !== skills.length) throw new Error('Choose distinct learning skills.')
      const proposed = itemSchema.parse({ ...input, canonicalText: input.canonicalText.normalize('NFC').trim(), senseKey: input.senseKey.normalize('NFC').trim().toLocaleLowerCase(), id: nid('item'), createdAt: at })
      let item = state.items.find(i => i.language === proposed.language && i.canonicalText.normalize('NFC').trim() === proposed.canonicalText && i.senseKey.normalize('NFC').trim().toLocaleLowerCase() === proposed.senseKey)
      if (!item) { item = proposed; state.items.push(item) }
      else {
        if (proposed.dictionarySources?.length) {
          if (item.meaning !== proposed.meaning || (item.pinyin ?? '') !== (proposed.pinyin ?? '')) throw new Error('This word and sense already have different saved wording or pronunciation. Use a distinct sense in Practice options; the existing card was not changed.')
          item.dictionarySources = [...new Map([...(item.dictionarySources ?? []), ...proposed.dictionarySources].map(citation => [dictionaryCitationKey(citation), citation])).values()]
          if (item.dictionarySources.length > 10) throw new Error('This item already has ten dictionary citations. Its existing records were not changed.')
        }
        item.sourceNodeIds = [...new Set([...item.sourceNodeIds, ...proposed.sourceNodeIds])]
        item.sourceRootIds = [...new Set([...item.sourceRootIds, ...proposed.sourceRootIds])]
      }
      for (const skill of skills) if (!state.cards.some(c => c.learnerId === state.activeLearnerId && c.itemId === item.id && c.skill === skill)) {
        state.cards.push({ id: nid('card'), learnerId: state.activeLearnerId, itemId: item.id, skill, box: 1, status: 'new',
          policyVersion: 'leitner-v1', introducedAt: null, dueAt: null, lastTransitionAt: null, revision: 0 })
      }
      // Capture is one transaction: item/card identities, visible derived chunk, and source snapshot.
      const source = state.nodes.find(n => proposed.sourceNodeIds.includes(n.id)) ?? state.nodes.find(n => item.sourceNodeIds.includes(n.id)) ?? state.nodes.find(n => n.type === 'root' && item.sourceRootIds.includes(n.id))
      if (source?.type === 'chunk' && source.data.wordSource && source.data.text === item.canonicalText && (!source.data.itemId || source.data.itemId === item.id)) {
        source.data.itemId = item.id; source.data.meaning = item.meaning; source.data.pinyin = item.pinyin ?? source.data.pinyin
      } else if (source && !state.nodes.some(n => n.type === 'chunk' && n.data.itemId === item.id && state.edges.some(e => e.source === source.id && e.target === n.id && e.data.kind === 'derived'))) {
        const id = nid('chunk'), siblings = state.edges.filter(e => e.source === source.id && e.data.kind === 'derived').length
        state.nodes.push({ id, rootId: source.rootId, type: 'chunk', position: { x: source.position.x + 380, y: source.position.y + siblings * 150 }, bookmarked: false, collapsed: false,
          data: { text: item.canonicalText, pinyin: item.pinyin ?? '', meaning: item.meaning, itemId: item.id } })
        state.edges.push({ id: nid('edge'), source: source.id, target: id, data: { kind: 'derived' } })
      }
      const firstCard = state.cards.find(c => c.learnerId === state.activeLearnerId && c.itemId === item.id)!
      const excerpt = `${item.canonicalText}${item.pinyin ? ` (${item.pinyin})` : ''}: ${item.meaning}`.slice(0, 2000)
      if (!state.sources.some(s => s.kind === 'local' && s.cardId === firstCard.id && s.excerpt === excerpt)) state.sources.push({ id: nid('source'), kind: 'local', title: `${item.canonicalText} — saved meaning`.slice(0, 200), excerpt, retrievedAt: at, cardId: firstCard.id, ...(source ? { nodeId: source.id } : {}) })
      if (readingCapture && source) {
        const context = readingCapture.sourceText.slice(Math.max(0, readingCapture.start - 500), Math.min(readingCapture.sourceText.length, readingCapture.end + 500))
        if (!state.sources.some(s => s.kind === 'local' && s.cardId === firstCard.id && s.title === 'Saved conversation context' && s.excerpt === context)) {
          state.sources.push({ id: nid('source'), kind: 'local', title: 'Saved conversation context', excerpt: context, retrievedAt: at, cardId: firstCard.id, nodeId: source.id })
        }
      }
      if (discoveryCapture) {
        const draft = state.drafts.find(d => d.id === discoveryCapture.draftId && d.kind === 'discovery' && d.status === 'validated'), lesson = draft?.discovery
        const phrase = lesson?.phrases.find(p => p.id === discoveryCapture.phraseId)
        if (!draft?.generation || !lesson || !phrase || input.canonicalText !== phrase.hanzi || input.meaning !== phrase.meaning || input.senseKey !== phrase.sense || !input.sourceNodeIds.includes(lesson.nodeId)) throw new Error('Capture must match a reviewed lesson phrase and its source.')
        const cardIds = state.cards.filter(c => c.learnerId === state.activeLearnerId && c.itemId === item.id && skills.includes(c.skill)).map(c => c.id)
        const previous = lesson.captures.find(c => c.phraseId === phrase.id)
        if (previous) previous.cardIds = [...new Set([...previous.cardIds, ...cardIds])]
        else lesson.captures.push({ phraseId: phrase.id, itemId: item.id, cardIds })
        draft.cardIds = [...new Set(lesson.captures.flatMap(c => c.cardIds))]; draft.updatedAt = at
        // Existing item meanings remain authoritative. Matching reviewed material can
        // support an explicit introduction; capture itself never introduces a card.
        if (item.meaning === phrase.meaning && phrase.examplePinyin.length <= 2000) {
          const id = `teaching-${draft.id}-${phrase.id}`, old = state.drafts.find(d => d.id === id)
          const teaching = { id, kind: 'teaching' as const, text: '', status: 'validated' as const, cardIds: [...new Set([...(old?.cardIds ?? []), ...cardIds])], sourceIds: phrase.sourceIds, createdAt: old?.createdAt ?? at, updatedAt: at,
            generation: { ...draft.generation, promptVersion: 'discovery-introduction-v1' }, lesson: { itemId: item.id, explanation: phrase.explanation, exampleHanzi: phrase.exampleHanzi, examplePinyin: phrase.examplePinyin, exampleMeaning: phrase.exampleMeaning, sourceIds: phrase.sourceIds } }
          if (old) state.drafts[state.drafts.indexOf(old)] = teaching; else state.drafts.push(teaching)
        }
      }
    }, operationId, at)
  }
  introduce(snapshot: WorkspaceSnapshot, cardId: string, sessionId?: string, operationId = nid('op')) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'introduce-card', { cardId, sessionId }, state => {
      const before = requireCard(state, cardId), after = introduce(before, at)
      if (sessionId) {
        const session = requireSession(state, sessionId)
        if (session.status === 'completed' || session.learnerId !== before.learnerId) throw new Error('This lesson cannot introduce the card.')
        if (session.lessonAttempt && lessonStep(state, session)?.cardId !== cardId) throw new Error('Introduce the current selected phrase first.')
        const queue = sessionQueue(state.cards, state.items, session, at)
        if (!session.lessonAttempt && !queue.canIntroduce && !session.introducedItemIds.includes(before.itemId)) throw new Error('Finish scoped due reviews before introducing new material, within the lesson limit.')
        if (!session.introducedItemIds.includes(before.itemId)) session.introducedItemIds.push(before.itemId)
        session.updatedAt = at
      }
      replaceCard(state, after)
      state.events.push({ id: nid('event'), cardId, kind: 'introduced', occurredAt: at, policyVersion: 'leitner-v1', before, after })
    }, operationId, at)
  }
  setSuspended(snapshot: WorkspaceSnapshot, cardId: string, suspended: boolean, operationId = nid('op')) {
    const at = this.clock.now()
    return this.change(snapshot.version, suspended ? 'suspend-card' : 'resume-card', { cardId, suspended }, state => {
      const before = requireCard(state, cardId), after = suspended ? suspend(before, at) : resume(before, at)
      if (state.sessions.some(s => s.activeExerciseId && requireExercise(state, s.activeExerciseId).cardId === cardId)) throw new Error('Finish or skip the active question before changing card availability.')
      replaceCard(state, after)
      state.events.push({ id: nid('event'), cardId, kind: suspended ? 'suspended' : 'resumed', occurredAt: at, policyVersion: 'leitner-v1', before, after })
    }, operationId, at)
  }
  startSession(snapshot: WorkspaceSnapshot, rootId: string | null = null, operationId = nid('op'), explicitGoal?: string) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'start-session', { rootId, ...(explicitGoal ? { explicitGoal } : {}) }, state => {
      if (rootId && !state.nodes.some(n => n.id === rootId && n.type === 'root')) throw new Error('Choose an existing topic.')
      if (state.sessions.some(s => s.learnerId === state.activeLearnerId && !s.lessonAttempt && s.status !== 'completed')) throw new Error('Resume or end the saved lesson before starting another.')
      for (const saved of state.sessions.filter(s => s.learnerId === state.activeLearnerId && s.status === 'active')) { saved.status = 'paused'; saved.updatedAt = at }
      const learner = learningPreferences(state, rootId ?? undefined)
      state.sessions.push({ id: nid('session'), learnerId: learner.id, rootId, createdAt: at, updatedAt: at, status: 'active',
        selectedCardIds: [], completedCardIds: [], skippedCardIds: [], introducedItemIds: [], activeExerciseId: null,
        maxReviewCards: learner.maxReviewCards, maxNewItems: learner.maxNewItems, goal: explicitGoal ?? learner.goal })
    }, operationId, at)
  }
  startLesson(snapshot: WorkspaceSnapshot, anchorId: string, itemIds: string[], goal: string, input: LessonSettings) {
    const settings = lessonSettingsSchema.parse(input), at = this.clock.now()
    return this.change(snapshot.version, 'start-lesson', { anchorId, itemIds, goal, settings }, state => {
      const selection = conversationSelection(state, anchorId)
      if (!itemIds.length || itemIds.length > 9 || new Set(itemIds).size !== itemIds.length || itemIds.some(id => !selection.items.some(i => i.id === id))) throw new Error('Choose one to nine saved phrases from this lesson source.')
      if (selection.source?.scope && (itemIds.length !== selection.source.scope.points.length || selection.items.some(i => !itemIds.includes(i.id)))) throw new Error('Use every teaching point in this reviewed lesson scope.')
      if (!goal.trim()) throw new Error('Enter a learning goal.')
      const cardIds = itemIds.map(itemId => {
        const existing = state.cards.find(c => c.learnerId === state.activeLearnerId && c.itemId === itemId && c.skill === 'recognition')
        if (existing?.status === 'suspended') throw new Error('Resume this phrase’s multiple-choice card in Library before starting a lesson.')
        if (existing) return existing.id
        const id = nid('card')
        state.cards.push({ id, learnerId: state.activeLearnerId, itemId, skill: 'recognition', box: 1, status: 'new', policyVersion: 'leitner-v1', introducedAt: null, dueAt: null, lastTransitionAt: null, revision: 0 })
        return id
      })
      if (state.sessions.some(s => s.activeExerciseId && cardIds.includes(requireExercise(state, s.activeExerciseId).cardId))) throw new Error('A selected phrase has an unfinished question. Resume that session and finish the question first.')
      for (const saved of state.sessions.filter(s => s.learnerId === state.activeLearnerId && s.status === 'active')) { saved.status = 'paused'; saved.updatedAt = at }
      const rootId = state.nodes.find(n => n.id === selection.anchorId)?.rootId ?? null
      const lessonId = nid('lesson'), cycleId = nid('lesson-cycle')
      state.lessons.push({ ...createLessonPlan(cardIds, settings, selection.kind), id: lessonId,
        learnerId: state.activeLearnerId, createdAt: at, goal: goal.trim(),
        ...(selection.source ? { source: selection.source } : {}), anchorId: selection.anchorId,
        title: selection.title.slice(0, 200), context: selection.context, cardIds,
        opportunity: { id: cycleId, kind: 'initial', eligibleAt: at } })
      state.sessions.push({ id: nid('session'), learnerId: state.activeLearnerId, rootId, createdAt: at, updatedAt: at, status: 'active',
        selectedCardIds: [], completedCardIds: [], skippedCardIds: [], introducedItemIds: [], activeExerciseId: null,
        maxReviewCards: cardIds.length, maxNewItems: cardIds.length, goal: goal.trim(),
        lessonAttempt: { lessonId, activity: 'learn', cycleId, stepIndex: 0, skippedSteps: [], remediatedSteps: [],
          interactionDay: state.learners.find(l => l.id === state.activeLearnerId)!.learningCalendar.anchor! } })
    }, nid('op'), at)
  }
  completeSupportedRetry(snapshot: WorkspaceSnapshot, sessionId: string, optionId: string) {
    return this.change(snapshot.version, 'complete-supported-retry', { sessionId, optionId }, state => {
      const session = requireSession(state, sessionId), plan = lessonView(state, session)
      const exercise = state.exercises.find(e => e.id === session.activeExerciseId)
      const attempt = state.attempts.find(a => a.exerciseId === exercise?.id && a.status === 'committed')
      if (!plan || lessonStep(state, session)?.stage !== 'practice' || session.status !== 'active' || !exercise?.multipleChoice || !attempt || (attempt.assessment?.grade === 'correct' && !attempt.helpUsed)) throw new Error('Answer the current practice question before a supported retry.')
      if (optionId !== exercise.multipleChoice.correctOptionId) throw new Error(exercise.multipleChoice.distractorFeedback.find(f => f.optionId === optionId)?.explanation ?? 'Choose the answer that matches the worked example.')
      if (!plan.remediatedSteps.includes(plan.stepIndex)) session.lessonAttempt!.remediatedSteps.push(plan.stepIndex)
      touchLessonActivity(state, session)
      session.updatedAt = this.clock.now()
    })
  }
  advanceLesson(snapshot: WorkspaceSnapshot, sessionId: string, skip = false) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'advance-lesson', { sessionId, skip }, state => {
      const session = requireSession(state, sessionId), plan = lessonView(state, session)
      if (session.lessonAttempt?.completion) return
      if (lessonForSession(state, session)?.archivedAt !== undefined) throw new Error('Restore this archived lesson before continuing it.')
      if (!plan || session.status !== 'active' || !lessonStep(state, session)) throw new Error('Resume the conversation practice first.')
      const step = lessonStep(state, session)!
      const attempt = state.attempts.find(a => a.exerciseId === session.activeExerciseId && a.status === 'committed')
      if (!skip && step.stage === 'practice' && attempt && (attempt.assessment?.grade !== 'correct' || attempt.helpUsed) && !plan.remediatedSteps.includes(plan.stepIndex)) throw new Error('Complete the supported retry before continuing.')
      if (!lessonReadiness(state, session).ready) throw new Error('Finish preparing the lesson and quizzes first.')
      if (!skip && step.stage === 'learn') {
        const waypoint = plan.preparation!.lesson.graph.waypoints.find(w => w.id === step.waypointId)!
        for (const cardId of waypoint.cardIds) {
          const before = requireCard(state, cardId)
          if (before.status === 'new') {
            const at = this.clock.now(), after = introduce(before, at)
            replaceCard(state, after)
            state.events.push({ id: nid('event'), cardId: before.id, kind: 'introduced', occurredAt: at, policyVersion: 'leitner-v1', before, after })
            if (!session.introducedItemIds.includes(before.itemId)) session.introducedItemIds.push(before.itemId)
          }
        }
      } else if (!skip && (!session.activeExerciseId || !state.attempts.some(a => a.exerciseId === session.activeExerciseId && a.status === 'committed'))) throw new Error('Check your answer before continuing.')
      if (skip) session.lessonAttempt!.skippedSteps.push(plan.stepIndex)
      session.activeExerciseId = null; session.lessonAttempt!.stepIndex++; session.updatedAt = at
      touchLessonActivity(state, session)
      if (!lessonStep(state, session)) completeLessonActivity(state, session, at)
    }, nid('op'), at)
  }
  setSessionStatus(snapshot: WorkspaceSnapshot, sessionId: string, status: 'active' | 'paused' | 'completed', operationId = nid('op')) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'session-status', { sessionId, status }, state => {
      const session = requireSession(state, sessionId)
      if (status === 'active' && lessonForSession(state, session)?.archivedAt !== undefined) throw new Error('Restore this archived lesson before continuing it.')
      if (session.status === 'completed' && status !== 'completed') throw new Error('Start a new session instead of reopening a finished one.')
      if (status === 'active') for (const other of state.sessions.filter(s => s.id !== sessionId && s.learnerId === session.learnerId && s.status === 'active')) { other.status = 'paused'; other.updatedAt = at }
      if (status === 'completed' && session.lessonAttempt && !session.lessonAttempt.completion) completeLessonActivity(state, session, at)
      if (status === 'completed') session.activeExerciseId = null
      session.status = status; session.updatedAt = at
      if (status === 'active') touchLessonActivity(state, session)
    }, operationId, at)
  }
  prepareExercise(snapshot: WorkspaceSnapshot, sessionId: string, cardId: string,
    proposal: Omit<Exercise, 'id' | 'sessionId' | 'cardId' | 'cardRevision' | 'mode' | 'presentedAt'>,
    practice = false, operationId = nid('op')) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'prepare-exercise', { sessionId, cardId, proposal, practice }, state => {
      const card = requireCard(state, cardId), session = requireSession(state, sessionId)
      if (card.status !== 'active' || session.status === 'completed' || session.learnerId !== card.learnerId) throw new Error('Introduce/resume this card in an active lesson before practicing.')
      if (session.activeExerciseId || state.sessions.some(s => s.activeExerciseId && requireExercise(state, s.activeExerciseId).cardId === cardId && !canKeepPracticeAlongsideReview(s, session))) throw new Error('Finish or skip the saved question before preparing another.')
      if (session.lessonAttempt && (session.status !== 'active' || lessonStep(state, session)?.cardId !== cardId)) throw new Error('This phrase is outside the current conversation practice step.')
      if (session.lessonAttempt && (!lessonReadiness(state, session).ready || lessonStep(state, session)?.stage === 'learn' || proposal.lessonStep !== session.lessonAttempt.stepIndex || proposal.format !== 'multipleChoice' || proposal.multipleChoice?.quizLevel !== lessonForSession(state, session)!.settings.quizLevel)) throw new Error('Use the prepared multiple-choice question for this lesson step.')
      const scoredReview = session.lessonAttempt?.activity === 'review'
      const exposure = session.lessonAttempt?.exposures?.find(e => e.cardId === cardId)
      const exposed = Boolean(exposure && !exposure.answeredQuestionIds.includes(lessonStep(state, session)?.questionId ?? ''))
      const mode = exerciseMode(card, proposal.format, at, practice || exposed || Boolean(session.lessonAttempt && !scoredReview))
      if (mode === 'dueReview') {
        const queue = sessionQueue(state.cards, state.items, session, at)
        if (!scoredReview && !queue.cards.some(c => c.id === cardId)) throw new Error('This card is outside the lesson’s due queue or review limit.')
        if (!session.selectedCardIds.includes(cardId)) session.selectedCardIds.push(cardId)
      }
      const exercise = exerciseSchema.parse({ ...proposal, id: nid('exercise'), sessionId, cardId, cardRevision: card.revision, mode, presentedAt: at })
      state.exercises.push(exercise)
      // Lesson questions belong to their saved activity, not the conversation canvas.
      if (!session.lessonAttempt) {
        const item = state.items.find(i => i.id === card.itemId)!
        const source = state.nodes.find(n => item.sourceNodeIds.includes(n.id)) ?? state.nodes.find(n => n.type === 'root' && (session.rootId ? n.id === session.rootId : item.sourceRootIds.includes(n.id))) ?? state.nodes.find(n => n.type === 'root')!
        const graphId = nid('exercise-node'), siblings = state.edges.filter(e => e.source === source.id && state.nodes.some(n => n.id === e.target && n.type === 'exercise')).length
        state.nodes.push({ id: graphId, rootId: source.rootId, type: 'exercise', data: { exerciseId: exercise.id }, position: { x: source.position.x + 780, y: source.position.y + siblings * 350 }, bookmarked: false, collapsed: false })
        state.edges.push({ id: nid('edge'), source: source.id, target: graphId, data: { kind: 'derived' } })
      }
      session.activeExerciseId = exercise.id; session.status = 'active'; session.updatedAt = at
      touchLessonActivity(state, session)
    }, operationId, at)
  }
  saveAnswerDraft(snapshot: WorkspaceSnapshot, exerciseId: string, text: string, operationId = nid('op'), selectedOptionId?: string) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'answer-draft', { exerciseId, text, selectedOptionId }, state => {
      const exercise = requireExercise(state, exerciseId), session = requireSession(state, exercise.sessionId)
      if (session.status === 'completed') throw new Error('A completed lesson keeps its original answers.')
      const draft = state.drafts.find(d => d.kind === 'answer' && d.exerciseId === exerciseId)
      if (draft) { draft.text = text; draft.selectedOptionId = selectedOptionId; draft.updatedAt = at }
      else state.drafts.push({ id: nid('draft'), kind: 'answer', exerciseId, text, ...(selectedOptionId ? { selectedOptionId } : {}), status: 'editing', sourceIds: [], cardIds: [], createdAt: at, updatedAt: at })
      touchLessonActivity(state, session)
    }, operationId, at)
  }
  submitAttempt(snapshot: WorkspaceSnapshot, input: { id: string; exerciseId: string; answer: string; selectedOptionId?: string; submittedAt: number }) {
    return this.change(snapshot.version, 'submit-attempt', input, state => {
      if (state.attempts.some(a => a.id === input.id)) throw new Error('This answer was already saved. Retry grading the saved attempt.')
      const exercise = requireExercise(state, input.exerciseId), session = requireSession(state, exercise.sessionId)
      if (session.activeExerciseId !== exercise.id || session.status === 'completed') throw new Error('This is not the active saved question.')
      if (state.attempts.some(a => a.exerciseId === exercise.id && ['pending', 'needsReview'].includes(a.status))) throw new Error('Retry or resolve the saved answer before submitting another.')
      const selected = exercise.multipleChoice?.options.find(o => o.id === input.selectedOptionId)
      if (exercise.multipleChoice && !selected) throw new Error('Choose an option from the saved quiz.')
      if (!exercise.multipleChoice && !input.answer.trim()) throw new Error('Enter an answer or choose “I don’t know”.')
      const exposure = session.lessonAttempt?.exposures?.find(e => e.cardId === exercise.cardId)
      const exposed = Boolean(exposure && !exposure.answeredQuestionIds.includes(lessonStep(state, session)?.questionId ?? ''))
      state.attempts.push({ ...input, answer: selected?.text ?? input.answer, cardId: exercise.cardId, helpUsed: hasHelp(state, exercise.id) || exposed, status: 'pending' })
      for (const draft of state.drafts.filter(d => d.exerciseId === exercise.id && d.kind === 'answer')) { draft.text = input.answer; draft.status = 'pending'; draft.updatedAt = input.submittedAt }
      session.updatedAt = input.submittedAt
      touchLessonActivity(state, session)
    }, `submit-${input.id}`, input.submittedAt)
  }
  assessAttempt(snapshot: WorkspaceSnapshot, attemptId: string, proposed: Assessment,
    provenance: { source: NonNullable<ReviewAttempt['assessmentSource']>; provider?: string; model?: string; promptVersion?: string }, operationId = nid('op')) {
    assessmentSchema.parse(proposed)
    return this.change(snapshot.version, 'assess-attempt', { attemptId, proposed, provenance }, state => {
      const attempt = state.attempts.find(a => a.id === attemptId)
      if (!attempt) throw new Error('Save the answer before grading it.')
      if (attempt.status === 'committed') return // New network completion cannot replay a committed answer.
      const exercise = requireExercise(state, attempt.exerciseId), before = requireCard(state, attempt.cardId)
      const activeSession = requireSession(state, exercise.sessionId)
      if (activeSession.activeExerciseId !== exercise.id || activeSession.status !== 'active') throw new Error('This question is paused or no longer active. Resume it explicitly before grading the saved answer.')
      const assessment = validateAssessment(proposed, exercise)
      // The application is authoritative for MC keys and explicit closed-answer rubrics.
      const local = deterministicAssessment(exercise, attempt.answer, attempt.selectedOptionId)
      if (local && provenance.source !== 'learner' && (assessment.grade !== local.grade || provenance.source !== 'deterministic')) throw new Error('This question must use its frozen deterministic answer key.')
      const eligible = exercise.mode === 'dueReview' && !hasReview(state, exercise.id)
      if (eligible && before.revision !== exercise.cardRevision) throw new WorkspaceConflict('The card changed after this question was presented. The answer remains saved; its grade cannot change the schedule.')
      attempt.assessment = assessment; attempt.assessmentSource = provenance.source
      delete attempt.gradingError
      attempt.gradingProvider = provenance.provider; attempt.gradingModel = provenance.model; attempt.gradingPromptVersion = provenance.promptVersion
      if (assessment.grade === 'uncertain') { attempt.status = 'needsReview'; return }
      const outcome = assessment.grade === 'correct' && !attempt.helpUsed ? 'recalled' : 'notRecalled'
      const after = review(before, outcome, attempt.submittedAt, eligible)
      replaceCard(state, after)
      state.events.push({ id: nid('event'), cardId: before.id, exerciseId: exercise.id, attemptId, kind: eligible ? 'review' : 'practice',
        outcome, occurredAt: attempt.submittedAt, policyVersion: 'leitner-v1', before, after })
      attempt.status = 'committed'
      const session = requireSession(state, exercise.sessionId)
      if (session.selectedCardIds.includes(before.id) && !session.completedCardIds.includes(before.id)) session.completedCardIds.push(before.id)
      session.updatedAt = attempt.submittedAt
    }, operationId)
  }
  markGradingUnavailable(snapshot: WorkspaceSnapshot, attemptId: string, reason: string, operationId = nid('op')) {
    return this.change(snapshot.version, 'grading-unavailable', { attemptId, reason }, state => {
      const attempt = state.attempts.find(a => a.id === attemptId)
      if (!attempt) throw new Error('The saved answer is missing.')
      if (attempt.status === 'committed') return
      attempt.status = 'needsReview'; attempt.gradingError = reason.slice(0, 1000)
    }, operationId)
  }
  requestHelp(snapshot: WorkspaceSnapshot, exerciseId: string, aid: NonNullable<LearningEvent['aid']>, operationId = nid('op')) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'exercise-help', { exerciseId, aid }, state => {
      const exercise = requireExercise(state, exerciseId), before = requireCard(state, exercise.cardId), session = requireSession(state, exercise.sessionId)
      if (session.activeExerciseId !== exercise.id) throw new Error('Help applies only to the active question.')
      if (at < exercise.presentedAt) throw new Error('The clock is earlier than the question’s presentation time.')
      if (state.events.some(e => e.exerciseId === exercise.id && e.aid === aid)) return
      if (state.attempts.some(a => a.exerciseId === exercise.id && a.status === 'pending')) throw new Error('Finish or cancel grading before revealing the answer.')
      recordLessonExposure(state, aid === 'source' ? lessonForSession(state, session)?.cardIds ?? [exercise.cardId] : [exercise.cardId])
      const eligible = exercise.mode === 'dueReview' && !hasReview(state, exercise.id)
      if (eligible && before.revision !== exercise.cardRevision) throw new WorkspaceConflict('The card has changed; reload its saved result.')
      const after = review(before, 'notRecalled', at, eligible)
      replaceCard(state, after)
      state.events.push({ id: nid('event'), cardId: before.id, exerciseId, kind: eligible ? 'review' : 'practice', outcome: 'notRecalled', aid,
        occurredAt: at, policyVersion: 'leitner-v1', before, after })
      for (const attempt of state.attempts.filter(a => a.exerciseId === exercise.id && a.status !== 'committed')) attempt.helpUsed = true
      if (eligible && !session.completedCardIds.includes(before.id)) session.completedCardIds.push(before.id)
      session.updatedAt = at
      touchLessonActivity(state, session)
    }, operationId, at)
  }
  finishExercise(snapshot: WorkspaceSnapshot, exerciseId: string, skip = false, operationId = nid('op')) {
    const at = this.clock.now()
    return this.change(snapshot.version, 'finish-exercise', { exerciseId, skip }, state => {
      const exercise = requireExercise(state, exerciseId), session = requireSession(state, exercise.sessionId)
      if (session.activeExerciseId !== exercise.id) return
      if (!skip && !state.events.some(e => e.exerciseId === exercise.id)) throw new Error('Answer the question or explicitly skip it.')
      if (skip && session.selectedCardIds.includes(exercise.cardId) && !session.skippedCardIds.includes(exercise.cardId) && !session.completedCardIds.includes(exercise.cardId)) session.skippedCardIds.push(exercise.cardId)
      session.activeExerciseId = null; session.updatedAt = at
    }, operationId, at)
  }
  correctReview(snapshot: WorkspaceSnapshot, eventId: string, outcome: 'recalled' | 'notRecalled', operationId = nid('op')) {
    return this.change(snapshot.version, 'correct-review', { eventId, outcome }, state => {
      const previous = state.events.find(e => e.id === eventId)
      if (!previous || !['review', 'correction'].includes(previous.kind)) throw new Error('Choose a saved review result to correct.')
      const original = originalReview(previous, state.events), before = requireCard(state, previous.cardId)
      if (correctionImpact(state, eventId).blocked) throw new Error('Finish or skip the pending question for this card before correcting its schedule.')
      if (original.aid && outcome === 'recalled') throw new Error('An answer revealed through help cannot become independent recall.')
      if (previous.after.revision !== before.revision || state.events.some(e => e.supersedesEventId === previous.id)) {
        previous.disputed = true
        if (original.attemptId) state.attempts.find(a => a.id === original.attemptId)!.disputed = true
        return // Retain a historical dispute without rewriting later transitions.
      }
      const after = { ...review(original.before, outcome, original.occurredAt, true), revision: before.revision + 1 }
      replaceCard(state, after)
      state.events.push({ id: nid('event'), cardId: before.id, exerciseId: original.exerciseId, attemptId: original.attemptId,
        kind: 'correction', outcome, occurredAt: original.occurredAt, policyVersion: 'leitner-v1', before, after, supersedesEventId: previous.id })
    }, operationId)
  }
}
