import { parseToolContext } from './tool-context'
import type { ChatOptions, ChatResult } from '../../src/lib/ai/types'
import { englishAnswers } from '../../src/lib/domain/lessonPlan'
import { nid } from '../../src/lib/id'
import { pendingQuestionContextHash, waypointQuestionHash, type LessonPreparation } from '../../src/lib/domain/lessonPreparation'
import { questionFromWaypoint, validateWaypointQuestion } from '../../src/lib/learning/waypointQuestion'

/** Explicit test setup for captured content. This authors plumbing metadata, never a historical model solve. */
export function withAuthoredAnswerEvidence(value: LessonPreparation): LessonPreparation {
  const preparation = structuredClone(value)
  const evidence = (question: Parameters<typeof waypointQuestionHash>[0]) => ({
    answerIds: [question.correctOptionId as 'A' | 'B' | 'C' | 'D'],
    reason: 'Authored current-format plumbing witness, not a captured model judgment.',
    model: 'authored-fixture', questionHash: waypointQuestionHash(question),
  })
  for (const phase of ['practice', 'check'] as const) {
    const quiz = preparation[phase]
    if (!quiz) continue
    for (const accepted of quiz.questions) accepted.answerReview = evidence(accepted.question)
    if (quiz.pending && quiz.pending.step !== 'solve') {
      const pending = quiz.pending, points = preparation.lesson.graph.waypoints.filter(w => pending.gap.waypointIds.includes(w.id))
      const input = { ...preparation.input, sources: preparation.input.sources.filter(source => points.some(w => w.sourceIds.includes(source.id))) }
      const question = validateWaypointQuestion(questionFromWaypoint(pending.candidate, pending.gap, preparation.lesson.graph, input), pending.gap.cardId, input, phase)
      pending.answerReview = evidence(question)
    }
    if (quiz.pending) quiz.pending.stateHash = pendingQuestionContextHash(quiz, phase === 'check' ? preparation.practice?.questions ?? [] : [])
  }
  return preparation
}

const json = (value: unknown): ChatResult => ({ content: JSON.stringify(value), reasoning: '', toolCalls: [], finishReason: 'stop', model: 'topic-fixture' })
export function topicFixture(options: ChatOptions): ChatResult {
  if (options.tools?.[0]?.function.name === 'solve_visible_question') return waypointResult(options, { answerIds: ['A'], reason: 'Authored plumbing fixture; not semantic evidence.' })
  if (options.tools?.[0]?.function.name === 'solve_english_question') return waypointResult(options, { answerId: 'unknown', reason: 'Authored plumbing fixture.' })
  const input = parseToolContext([...options.messages].reverse().find(m => m.role === 'user')!.content as string)
  if (['add_lesson_waypoint', 'revise_lesson_waypoint', 'verify_lesson_graph', 'verify_lesson_waypoint', 'evaluate_question_coverage', 'list_missing_questions', 'build_question_answers', 'revise_question_answers', 'verify_correct_question'].includes(input.generationMode)) return waypointFixture(options, input)
  if (input.quiz) return json({ verdict: 'supported', reasons: 'Authored fixture, not live language evidence.', questions: input.quiz.questions.map((q: any) => ({ cardId: q.cardId, oneCorrectAnswer: true, sourceSupported: true, skillAligned: true, answerHidden: true, levelAppropriate: true, lessonAligned: true, evidence: 'Fixture aligns with saved sense.' })) })
  if (input.reviewSettings?.length) { input.settings = input.reviewSettings[0].settings; input.generationMode = 'prepareReview' }
  const english = englishAnswers(input.settings.quizLevel), review = input.generationMode === 'prepareReview', check = input.generationMode !== 'preparePractice'
  const quiz = { title: 'Prepared fixture quiz', questions: input.targets.map((t: any, i: number) => ({ cardId: t.target.cardId,
    stem: english ? review ? 'In this later encounter, what does the expression mean?' : 'What does this expression mean here?' : t.target.hanzi !== '谢谢' ? `${check ? 'A new situation' : 'This situation'} calls for: ${t.target.meaning}. Which reply fits?` : review ? 'A neighbour helps carry your bags. Which reply thanks them?' : check ? 'Your colleague helps you with a task. Which reply thanks them?' : 'Someone holds a door for you. Which reply thanks them?',
    ...(english ? { passage: t.target.hanzi === '谢谢' ? check ? '谢谢你的帮助。' : '谢谢。' : `${t.target.hanzi}${check ? '！' : '。'}` } : {}),
    options: (english ? [t.target.meaning, 'hello', 'goodbye', 'I am sorry'] : [t.target.hanzi, '你好', '再见', '对不起']).map((text, i) => ({ id: `answer-${i}`, text })),
    correctOptionId: 'answer-0', explanation: `This expression conveys ${t.target.meaning}.`, objective: `Recognize ${t.target.meaning} in context.`, sourceIds: [input.sources[i].id],
    distractorFeedback: [1, 2, 3].map(i => ({ optionId: `answer-${i}`, explanation: 'This does not express thanks.' })),
    workedExample: { hanzi: `${t.target.hanzi}。`, meaning: t.target.meaning, explanation: `The phrase expresses ${t.target.meaning}.` },
  })) }
  return { ...json(null), content: '', finishReason: 'tool_calls', toolCalls: [{ id: nid('call'), type: 'function', function: { name: 'draft_multiple_choice_quiz', arguments: JSON.stringify(quiz) } }] }
}

/** Authored transport fixture for the staged pipeline; never language-quality evidence. */
export function waypointFixture(options: ChatOptions, input = parseToolContext(options.messages.filter(m => m.role === 'user').at(-1)!.content as string)): ChatResult {
  if (options.tools?.[0]?.function.name === 'solve_visible_question') return waypointResult(options, { answerIds: ['A'], reason: 'Authored plumbing fixture; not semantic evidence.' })
  if (options.tools?.[0]?.function.name === 'solve_english_question') return waypointResult(options, { answerId: 'unknown', reason: 'Authored plumbing fixture.' })
  const name = input.generationMode
  let value: unknown
  if (name === 'add_lesson_waypoint' || name === 'revise_lesson_waypoint') {
    const missing = input.revision?.waypointId
      ? input.targets.find((t: any) => input.graph.waypoints.find((w: any) => w.id === input.revision.waypointId)?.cardIds.includes(t.cardId))
      : input.targets.find((t: any) => !input.graph.waypoints.some((w: any) => w.cardIds.includes(t.cardId)))
    if (!missing) throw new Error('Authored fixture has no remaining waypoint.')
    value = { cardIds: [missing.cardId], dependsOn: [], objective: `Understand ${missing.meaning}.`, explanation: `This expression conveys ${missing.meaning}.`, exampleHanzi: missing.hanzi, exampleMeaning: missing.meaning, sourceIds: [input.sources[input.targets.indexOf(missing)]?.id ?? input.sources[0].id] }
  } else if (name === 'verify_lesson_graph') value = input.targets.every((t: any) => input.graph.waypoints.some((w: any) => w.cardIds.includes(t.cardId)))
    ? { decision: 'accept', reason: 'Authored fixture graph review.' }
    : { decision: 'add', reason: 'Add an understanding for the next selected target.' }
  else if (name === 'verify_lesson_waypoint') value = { decision: 'accept', reason: 'Authored fixture waypoint review.' }
  else if (name === 'list_missing_questions') {
    const w = input.graph.waypoints.find((w: any) => input.remainingWaypointIds.includes(w.id))
    value = { waypointId: w.id, cardId: w.cardIds.find((id: string) => input.remainingTargetIds?.includes(id)) ?? w.cardIds[0], directions: `Assess ${w.id}: ${w.objective}` }
  }
  else if (name === 'evaluate_question_coverage') {
    const ordinal = input.graph.waypoints[Number(input.question.id.slice(1)) - 1]?.id
    const eligible = input.recognitionEligibleWaypointIds
    const waypointId = eligible ? eligible.includes(ordinal) ? ordinal : eligible[0] : ordinal
    value = { waypointIds: waypointId ? [waypointId] : [], ...(input.eligibleTargetIds ? { cardIds: input.eligibleTargetIds } : {}), assessment: 'Authored fixture coverage, not semantic evidence.' }
  }
  else if (name === 'revise_question_answers') value = input.candidateToRevise
  else if (name === 'build_question_answers') {
    const t = input.targets.find((t: any) => t.cardId === input.gap.cardId), english = englishAnswers(input.settings.quizLevel), check = input.phase === 'check'
    const courtesySituations: Record<string, string> = { '谢谢': 'Someone has helped you.', '对不起': 'You made a mistake.',
      '你好': 'You are meeting someone.', '再见': 'You are leaving a conversation.' }
    const situation = english && check && input.settings.complexity === 'phrases' ? courtesySituations[t.hanzi] : undefined
    const choices = situation ? [situation, ...Object.values(courtesySituations).filter(text => text !== situation)]
      : english ? [t.meaning, 'hello', 'goodbye', 'you are welcome'] : [t.hanzi, '你好', '再见', '不客气']
    value = { stem: english ? situation ? 'When would someone say this expression?' : check ? 'In this later encounter, which meaning fits the expression?' : 'What does the expression mean?' : `${check ? 'In another encounter' : 'In this situation'}, choose the reply for: ${t.meaning}`,
      ...(english ? { passage: t.hanzi } : {}), answerA: choices[0], answerB: choices[1], answerC: choices[2], answerD: choices[3], correct: 'A',
      feedback: `This expression conveys ${t.meaning}; the other choices convey different meanings.` }
  } else if (name === 'verify_correct_question') value = { decision: 'accept', reason: 'Authored fixture question review.' }
  else throw new Error('Unknown waypoint fixture stage.')
  return waypointResult(options, value)
}

/** Serialize authored fixture outcomes as the actual native operations. */
export function waypointResult(options: ChatOptions, value: any): ChatResult {
  const calls = [{ name: options.tools![0]!.function.name, value }]
  return { ...json(null), content: '', finishReason: 'tool_calls', toolCalls: calls.map(c => ({ id: nid('call'), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.value) } })) }
}
