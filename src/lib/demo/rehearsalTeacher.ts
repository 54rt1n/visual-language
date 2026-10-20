import { lessonForSession, lessonView } from '../domain/lesson'
import { nid } from '../id'
import type { Clock } from '../learning/leitner'
import { LearningService } from '../learning/learningService'
import { presentQuizQuestion, shuffleOptions, validateQuizDraft } from '../learning/quiz'
import { reviewSettingsForCard } from '../learning/lessonProgress'
import { frozenQuizTarget } from '../teacher/quizRecovery'
import { teacherContext } from '../teacher/teacherContext'
import { englishAnswers, preparedLessonSteps } from '../domain/lessonPlan'
import { demoAnswerChoices, demoLessonPreparation, demoLessonQuizzes } from './lessonMaterial'
import { sameRecord } from '../domain/common'
import { mandarinPinyin } from '../mandarin/chineseParser'
import type { SavedDraft } from '../domain/workspace'
import { TeacherService, type TeacherHost } from '../teacher/teacherService'
import { DEMO_ITEMS, DEMO_MODEL } from './material'
import { requireDemo } from './demoService'
import { rehearsalProposal } from './seed'
import { completeWorkedExample } from '../teacher/feedback'

/** Explicit, authored demo-only content. This does not simulate an API, native
 * tool call, live semantic review, or Tavily result. Shared scoring/presentation
 * still uses the real transactional learning service. */
export class RehearsalTeacher extends TeacherService {
  constructor(private rehearsalHost: TeacherHost, clock: Clock) {
    super(rehearsalHost, () => { throw new Error('Prerecorded rehearsal never uses provider keys. Switch to live mode for model assessment.') }, { clock })
  }
  private material(cardId: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const state = this.rehearsalHost.current().state
    if (requireDemo(state).contentMode !== 'fixtures') throw new Error('Choose sample content in Demo options first.')
    if (this.rehearsalHost.current().state.demo?.enabled !== true) throw new Error('Prerecorded material is available only in the isolated demo.')
    const card = state.cards.find(c => c.id === cardId), item = state.items.find(i => i.id === card?.itemId), material = DEMO_ITEMS.find(m => m.id === item?.id)
    const source = state.sources.find(s => s.id === `${material?.id}-source`)
    const topicCard = card?.skill === 'recognition' && state.sessions.some(s => lessonForSession(state, s)?.cardIds.includes(card.id))
    if (!card || !material || (!topicCard && (card.id !== `${material.id}-card` || card.skill !== material.skill)) || item?.canonicalText !== material.text || item.meaning !== material.meaning || item.senseKey !== material.meaning || source?.kind !== 'local' || source.excerpt !== `${material.text} (${material.pinyin}) — ${material.meaning}. ${material.explanation}`) throw new Error('This item has no matching prerecorded demo material. Use live mode for new or edited learning material.')
    return { card, material, source }
  }
  private async saveDraft(draft: SavedDraft, signal?: AbortSignal) {
    signal?.throwIfAborted()
    await this.rehearsalHost.apply((snapshot, repository) => {
      if (repository.mode !== 'demo') throw new Error('Prerecorded material cannot be saved in the normal database.')
      return repository.mutate(snapshot.version, { id: nid('op'), kind: 'save-prerecorded-demo-material', at: this.clock.now(), intent: { draftId: draft.id } }, state => {
        if (requireDemo(state).contentMode !== 'fixtures') throw new Error('The rehearsal mode changed. No material was saved.')
        state.drafts.push(draft)
      })
    })
    return draft
  }
  override async teach(cardId: string, signal?: AbortSignal, sessionId?: string) {
    const { material, source } = this.material(cardId, signal), now = this.clock.now()
    return this.saveDraft({ id: nid('teaching'), kind: 'teaching', ...(sessionId ? { sessionId } : {}), text: '', status: 'validated', sourceIds: [source.id], cardIds: [cardId], createdAt: now, updatedAt: now,
      lesson: { itemId: material.id, explanation: material.explanation, exampleHanzi: material.example, exampleMeaning: material.translation, examplePinyin: mandarinPinyin(material.example), sourceIds: [source.id] },
      ...(sessionId ? { contentReview: { verdict: 'supported' as const, reasons: 'Authored demo fixture, not live model review.', provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-demo-v1' } } : {}),
      generation: { provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-demo-v1', createdAt: now } }, signal)
  }
  override async prepareLesson(sessionId: string, signal?: AbortSignal, onStage?: (stage: string) => void) {
    const session = this.rehearsalHost.current().state.sessions.find(s => s.id === sessionId)!, plan = lessonForSession(this.rehearsalHost.current().state, session)!
    const fresh = session.lessonAttempt!.checkPreparation
    if (fresh ? fresh.quiz?.complete : plan.preparation?.check?.complete) return
    if (session.status !== 'active' || plan.kind !== 'topic') throw new Error('This sample lesson requires an active topic lesson.')
    onStage?.('Opening the sample lesson…')
    const targets = plan.cardIds.map(id => this.material(id, signal))
    const input = { kind: plan.kind, settings: plan.settings, objective: session.goal, conversationContext: plan.context,
      targets: targets.map(t => ({ cardId: t.card.id, hanzi: t.material.text, meaning: t.material.meaning })),
      sources: targets.map(t => ({ id: t.source.id, title: t.source.title, excerpt: t.source.excerpt })) }
    const preparation = demoLessonPreparation(fresh ? plan.preparation!.input : input, Boolean(fresh), fresh ? plan.preparation!.lesson : undefined)
    signal?.throwIfAborted()
    await this.rehearsalHost.apply((s, r) => r.mutate(s.version, { id: nid('op'), kind: 'prepare-demo-lesson', intent: { sessionId }, at: this.clock.now() }, state => {
      signal?.throwIfAborted()
      if (r.mode !== 'demo' || requireDemo(state).contentMode !== 'fixtures') throw new Error('Sample preparation requires the demo workspace.')
      const saved = state.sessions.find(s => s.id === sessionId)!
      if (saved.status !== 'active' || !sameRecord(lessonForSession(state, saved), plan)) throw new Error('The lesson changed during preparation.')
      if (fresh) saved.lessonAttempt!.checkPreparation!.quiz = preparation.check
      else {
        lessonForSession(state, saved)!.preparation = preparation; lessonForSession(state, saved)!.brief = preparation.lesson.graph.overview
        lessonForSession(state, saved)!.steps = preparedLessonSteps(preparation, plan.settings, plan.kind)
      }
      state.drafts.push(...demoLessonQuizzes(state, lessonForSession(state, saved)!, sessionId, preparation, this.clock.now(), fresh ? ['check'] : ['practice', 'check']))
    }))
  }
  override async explainAttempt(attemptId: string, signal?: AbortSignal) {
    const state = this.rehearsalHost.current().state, attempt = state.attempts.find(a => a.id === attemptId)
    if (!attempt || attempt.status !== 'committed') throw new Error('Resolve the saved answer before requesting its prerecorded example.')
    const { material, source } = this.material(attempt.cardId, signal), at = this.clock.now()
    const saved = state.drafts.find(d => d.kind === 'feedback' && d.attemptId === attemptId)
    if (saved) return saved
    return this.saveDraft({ id: nid('feedback'), kind: 'feedback', attemptId, exerciseId: attempt.exerciseId, text: '', status: 'validated', cardIds: [attempt.cardId], sourceIds: [source.id],
      workedExample: completeWorkedExample({ hanzi: material.example, meaning: material.translation, explanation: material.explanation }), generation: { provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-feedback-v1', createdAt: at }, createdAt: at, updatedAt: at }, signal)
  }
  override async prepareFreeExercise(sessionId: string, cardId: string, practice = false, signal?: AbortSignal, options: NonNullable<Parameters<TeacherService['prepareFreeExercise']>[4]> = {}) {
    if (options.web || options.extract) throw new Error('Prerecorded rehearsal has no web retrieval. Switch to live mode for Tavily.')
    const { material, card } = this.material(cardId, signal)
    return this.rehearsalHost.apply((snapshot, repository) => {
      if (repository.mode !== 'demo') throw new Error('Prerecorded questions require the isolated demo database.')
      signal?.throwIfAborted()
      return new LearningService(repository, this.clock).prepareExercise(snapshot, sessionId, cardId, rehearsalProposal(material, card.skill, practice), practice)
    })
  }
  override async draftQuiz(cardIds: string[], options: NonNullable<Parameters<TeacherService['draftQuiz']>[1]> = {}) {
    if (options.web || options.extract) throw new Error('Prerecorded rehearsal has no web retrieval. Switch to live mode for Tavily and native model tool calls.')
    const targets = cardIds.map(id => this.material(id, options.signal)), sourceIds = targets.map(t => t.source.id), now = this.clock.now()
    const plan = lessonForSession(this.rehearsalHost.current().state, this.rehearsalHost.current().state.sessions.find(s => s.id === options.sessionId))
    const quiz = validateQuizDraft({ title: 'Prerecorded demo recognition quiz — no model call', questions: targets.map(({ card, material, source }) => {
      const options = material.choices.map((text, i) => ({ id: `choice-${i}`, text }))
      return { cardId: card.id, stem: `Which expression means “${material.meaning}”?`, options, correctOptionId: options[0]!.id, explanation: material.explanation, sourceIds: [source.id], objective: `Recognize ${material.meaning}.`,
        workedExample: { hanzi: material.example, meaning: material.translation, explanation: material.explanation },
        distractorFeedback: options.slice(1).map(option => ({ optionId: option.id, explanation: `This does not express ${material.meaning}. ${material.explanation}` })) }
    }) }, cardIds, sourceIds)
    const reviewSettings = new Map(targets.map(t => [t.card.id, plan ? undefined : reviewSettingsForCard(this.rehearsalHost.current().state, t.card.id)]))
    if ((plan && options.lessonPhase) || [...reviewSettings.values()].some(Boolean)) {
      quiz.questions = quiz.questions.map(q => {
        const settings = plan?.settings ?? reviewSettings.get(q.cardId)
        if (!settings) return q
        const { material } = targets.find(t => t.card.id === q.cardId)!, english = englishAnswers(settings.quizLevel)
        const choices = demoAnswerChoices(material, english)
        const check = options.lessonPhase === 'check'
        return presentQuizQuestion({ ...q, stem: english ? 'What does the quoted expression mean?' : `${check ? 'In a new conversation' : 'In the example situation'}, choose the expression for “${material.meaning}”.`,
          ...(english ? { passage: check ? `朋友说：“${material.text}。”` : material.text } : {}),
          options: choices.map((text, i) => ({ id: `choice-${i}`, text })) }, settings.quizLevel, plan?.steps.findIndex(s => s.cardId === q.cardId && s.phase === options.lessonPhase))
      })
    }
    quiz.questions = quiz.questions.map(q => shuffleOptions(q))
    const draft = await this.saveDraft({ id: nid('quiz'), kind: 'quiz', text: '', status: 'validated', quiz, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...(options.lessonPhase ? { lessonPhase: options.lessonPhase } : {}), sourceIds, cardIds,
      quizTargets: targets.map(t => ({ ...frozenQuizTarget(teacherContext(this.rehearsalHost.current().state, t.card.id, now)), ...(reviewSettings.get(t.card.id) ? { reviewSettings: reviewSettings.get(t.card.id) } : {}) })),
      createdAt: now, updatedAt: now, generation: { provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-demo-v1', createdAt: now },
      contentReview: { verdict: 'supported', reasons: 'Manually authored and checked demo fixture. This is not native tool generation or live model content review.', provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-demo-v1' } }, options.signal)
    return { draft, notices: [] }
  }
}
