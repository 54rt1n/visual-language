import { lessonView, type Lesson } from '../domain/lesson'
import { englishAnswers, preparedLessonSteps } from '../domain/lessonPlan'
import { lessonPreparationHash, waypointQuestionHash, type LessonPreparation, type WaypointQuiz } from '../domain/lessonPreparation'
import type { WaypointLessonInput } from '../domain/lessonGraph'
import type { SavedDraft, Workspace } from '../domain/workspace'
import { presentQuizQuestion, shuffleOptions } from '../learning/quiz'
import { frozenQuizTarget } from '../teacher/quizRecovery'
import { teacherContext } from '../teacher/teacherContext'
import { nid } from '../id'
import { DEMO_ITEMS, DEMO_MODEL, type DemoMaterial } from './material'

export const DEMO_LESSON_ID = 'demo-order-tea-lesson'

const meanings: Record<string, string[]> = {
  'demo-thanks': ['thank you', 'hello', 'goodbye', 'I am sorry'],
  'demo-tea': ['please give me a cup of tea', 'please give me a cup of water', 'please give me a cup of coffee', 'please give me a bowl of rice'],
  'demo-metro': ['where is the subway', 'where is the station', 'where is the restroom', 'where is the restaurant'],
  'demo-excuse': ['excuse me, may I ask', 'thank you', 'goodbye', 'I am sorry'],
  'demo-goodbye': ['goodbye', 'thank you', 'hello', 'I am sorry'],
}
export function demoAnswerChoices(material: DemoMaterial, english: boolean): readonly string[] {
  return english ? meanings[material.id]! : material.id === 'demo-excuse' ? ['请问', '谢谢', '再见', '对不起'] : material.choices
}

/** Authored sample content uses the same saved graph and quiz format as live lessons. */
export function demoLessonPreparation(input: WaypointLessonInput, fresh = false, acceptedLesson?: LessonPreparation['lesson']): LessonPreparation {
  const targets = input.targets.map(target => {
    const material = DEMO_ITEMS.find(m => m.text === target.hanzi && m.meaning === target.meaning)
    const source = input.sources.find(s => s.id === `${material?.id}-source`)
    if (!material || !source) throw new Error('This lesson has no matching sample content.')
    return { target, material, source }
  })
  const graph = acceptedLesson?.graph ?? {
    overview: 'Learn the expressions, try them with help, then take a short quiz.',
    waypoints: targets.map(({ target, material, source }, i) => ({ id: `w${i + 1}`, cardIds: [target.cardId], dependsOn: i ? [`w${i}`] : [],
      objective: `Understand ${material.meaning}.`, explanation: material.explanation,
      exampleHanzi: material.text, exampleMeaning: material.meaning, sourceIds: [source.id] })),
  }
  const preparation: LessonPreparation = { input, lesson: acceptedLesson ?? { graph, review: { decision: 'accept', reason: 'Authored sample lesson.', model: DEMO_MODEL } } }
  const lessonHash = lessonPreparationHash(input, graph), english = englishAnswers(input.settings.quizLevel)
  for (const phase of ['practice', 'check'] as const) {
    const questions: WaypointQuiz['questions'] = targets.map(({ target, material, source }, index) => {
      const choices = demoAnswerChoices(material, english)
      const options = choices.map((text, i) => ({ id: 'ABCD'[i]!, text }))
      const check = phase === 'check'
      const passage = check ? `${fresh ? '同事' : material.id === 'demo-tea' ? '客人' : '朋友'}说：“${material.text}。”` : material.text
      const question = presentQuizQuestion({ cardId: target.cardId,
        stem: english ? check ? 'What does the speaker mean?' : 'What does this expression mean?'
          : `${check ? fresh ? 'In a new conversation' : 'In this situation' : 'Choose the reply'}: ${material.meaning}`,
        ...(english ? { passage } : {}), options, correctOptionId: 'A', explanation: material.explanation, sourceIds: [source.id], objective: graph.waypoints[index]!.objective,
        distractorFeedback: options.slice(1).map(o => ({ optionId: o.id, explanation: `This expresses a different meaning from ${material.meaning}.` })),
        workedExample: { hanzi: material.example, meaning: material.translation, explanation: material.explanation } }, input.settings.quizLevel)
      return { id: `q${index + 1}`, gap: { cardId: target.cardId, waypointIds: [`w${index + 1}`], intent: graph.waypoints[index]!.objective, whyMissing: 'Sample lesson coverage.' }, question,
        answerReview: { answerIds: ['A'], reason: 'Authored sample answer.', model: DEMO_MODEL, questionHash: waypointQuestionHash(question) },
        ...(english ? { concealmentReview: { answerId: 'unknown' as const, reason: 'The English prompt requires reading the Mandarin expression.', model: DEMO_MODEL, questionHash: waypointQuestionHash(question) } } : {}),
        coverageReview: { questionHash: waypointQuestionHash(question), waypointIds: [`w${index + 1}`], assessment: graph.waypoints[index]!.objective },
        review: { decision: 'accept', reason: 'Authored sample question.', model: DEMO_MODEL } }
    })
    preparation[phase] = { lessonHash, phase, questions, complete: true, coverageReason: 'Every sample learning point has a question.',
      coverage: graph.waypoints.map((w, i) => ({ waypointId: w.id, questionIds: [`q${i + 1}`], assessment: w.objective })) }
  }
  return preparation
}

export function demoLessonQuizzes(state: Workspace, lesson: Lesson, sessionId: string, preparation: LessonPreparation, at: number, phases: ('practice' | 'check')[] = ['practice', 'check']): SavedDraft[] {
  const steps = lessonView(state, state.sessions.find(s => s.id === sessionId))!.steps
  return phases.map(phase => ({ id: nid('quiz'), kind: 'quiz', text: '', sessionId, lessonPhase: phase, status: 'validated',
    cardIds: lesson.cardIds, sourceIds: preparation.input.sources.map(s => s.id),
    quiz: { title: phase === 'check' ? 'Sample lesson quiz' : 'Sample lesson practice', questions: preparation[phase]!.questions.map(q => shuffleOptions({ ...q.question, lessonStep: steps.findIndex(s => s.phase === phase && s.questionId === q.id) })) },
    quizTargets: lesson.cardIds.map(id => frozenQuizTarget(teacherContext(state, id, at))), createdAt: at, updatedAt: at,
    generation: { provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-waypoints-v1', createdAt: at },
    contentReview: { verdict: 'supported', reasons: 'Authored sample content.', provider: 'fixture', model: DEMO_MODEL, promptVersion: 'prerecorded-waypoints-v1' } }))
}

/** Add samples to an older demo without replacing its history or user's lessons. */
export function addDemoLesson(state: Workspace) {
  if (!state.demo?.enabled) throw new Error('Sample lessons belong only in the demo workspace.')
  if (state.lessons.some(l => l.id === DEMO_LESSON_ID)) return
  const at = state.demo.now, learnerId = state.activeLearnerId
  const materials = [DEMO_ITEMS.find(m => m.id === 'demo-tea')!, DEMO_ITEMS.find(m => m.id === 'demo-thanks')!]
  if (materials.some(m => !state.sources.some(s => s.id === `${m.id}-source`)
    || !state.items.some(i => i.id === m.id && i.canonicalText === m.text && i.meaning === m.meaning))) throw new Error('Reset the demo to restore its sample phrases before opening this lesson.')
  const cards = materials.map(material => {
    const existing = state.cards.find(c => c.itemId === material.id && c.learnerId === learnerId && c.skill === 'recognition')
    if (existing) return existing
    const card = { id: `${material.id}-recognition-card`, learnerId, itemId: material.id, skill: 'recognition' as const, box: 1 as const, status: 'new' as const,
      policyVersion: 'leitner-v1' as const, introducedAt: null, dueAt: null, lastTransitionAt: null, revision: 0 }
    state.cards.push(card); return card
  })
  const input: WaypointLessonInput = { kind: 'topic', settings: { quizLevel: 'meaningPinyin', complexity: 'phrases', scope: 'everyday', focus: 'characters', topic: 'Ordering tea' },
    objective: 'Order a cup of tea politely and thank the person who helps you.', conversationContext: 'Learn two useful expressions for a visit to a tea shop.',
    targets: materials.map((m, i) => ({ cardId: cards[i]!.id, hanzi: m.text, meaning: m.meaning })),
    sources: materials.map(m => { const source = state.sources.find(s => s.id === `${m.id}-source`)!; return { id: source.id, title: source.title, excerpt: source.excerpt } }) }
  const preparation = demoLessonPreparation(input), sessionId = 'demo-order-tea-session', cycleId = 'demo-order-tea-cycle'
  const lesson: Lesson = { version: 1, id: DEMO_LESSON_ID, kind: 'topic', learnerId, createdAt: at, title: 'Order a cup of tea', goal: input.objective,
    anchorId: 'demo-everyday-reply', context: input.conversationContext, cardIds: cards.map(c => c.id), settings: input.settings,
    preparation, brief: preparation.lesson.graph.overview, steps: preparedLessonSteps(preparation, input.settings, 'topic'),
    opportunity: { id: cycleId, kind: 'initial', eligibleAt: at } }
  state.lessons.push(lesson)
  state.sessions.push({ id: sessionId, learnerId, rootId: 'demo-everyday', createdAt: at, updatedAt: at, status: 'paused',
    selectedCardIds: [], completedCardIds: [], skippedCardIds: [], introducedItemIds: [], activeExerciseId: null,
    maxReviewCards: cards.length, maxNewItems: cards.length, goal: lesson.goal,
    lessonAttempt: { lessonId: lesson.id, activity: 'learn', cycleId, stepIndex: 0, remediatedSteps: [], skippedSteps: [] } })
  state.drafts.push(...demoLessonQuizzes(state, lesson, sessionId, preparation, at))
}
