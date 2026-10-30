import { z } from 'zod'
import type { LessonGraph, WaypointLessonInput } from '../domain/lessonGraph'
import type { QuestionGap } from '../domain/lessonPreparation'
import { InputValidationError } from '../domain/validation'
import { englishAnswers, type LessonSettings } from '../domain/lessonSettings'
import { validatePreparedQuiz, type QuizQuestion } from './quiz'

const text = (max: number) => z.string().trim().min(1).max(max)
const choices = ['A', 'B', 'C', 'D'] as const
/** Stored author output remains a candidate until review, separate from playable quiz content. */
export const waypointQuestionCandidateSchema = z.strictObject({
  stem: text(500), passage: text(2000).optional(), answerA: text(200), answerB: text(200),
  answerC: text(200), answerD: text(200), correct: z.enum(choices), feedback: text(1000),
})

export function waypointQuestionSchema(settings: LessonSettings, phase?: 'practice' | 'check') {
  const english = englishAnswers(settings.quizLevel)
  const answer = text(200).describe(english ? 'An English meaning, intention or situation matching the expression.' : 'A Mandarin reply; the application supplies its pronunciation.')
  return waypointQuestionCandidateSchema.extend({
    stem: waypointQuestionCandidateSchema.shape.stem.describe(english
      ? phase === 'check'
        ? 'English-only instruction for a fresh task compared with practiceQuestions. After a meaning question, ask "In which situation would you say this?" and provide four English situations. The Mandarin text belongs in passage.'
        : 'English-only instruction referring to passage as "this expression". Examples: "What does this expression mean?" or "In which situation would you say this?". The Mandarin text belongs in passage.'
      : 'English-only situation and communicative goal, such as "You want a cup of tea. Which reply asks for it?". Mandarin replies belong in the answer fields.'),
    passage: (english ? waypointQuestionCandidateSchema.shape.passage.unwrap() : waypointQuestionCandidateSchema.shape.passage).describe(english ? 'Mandarin expression to interpret, including the selected target.' : 'Optional Mandarin context before the requested reply; omit if unnecessary.'),
    answerA: answer, answerB: answer, answerC: answer, answerD: answer,
    correct: waypointQuestionCandidateSchema.shape.correct.describe('The only correct choice.'),
    feedback: waypointQuestionCandidateSchema.shape.feedback.describe('English explanation shown after answering. Explain the key and meaningful contrasts. Refer to answer text because choices are shuffled.'),
  })
}

export function questionFromWaypoint(value: unknown, gap: QuestionGap, graph: LessonGraph, input: WaypointLessonInput): QuizQuestion {
  const authored = waypointQuestionSchema(input.settings).parse(value)
  const waypoint = graph.waypoints.find(w => gap.waypointIds.includes(w.id) && w.cardIds.includes(gap.cardId))
  if (!waypoint) throw new InputValidationError('The question needs a teaching waypoint for its target.')
  return {
    cardId: gap.cardId, stem: authored.stem, ...(authored.passage ? { passage: authored.passage } : {}),
    options: choices.map(id => ({ id, text: authored[`answer${id}`] })), correctOptionId: authored.correct,
    explanation: authored.feedback,
    // Playback selects feedback by option ID; this explanation applies to any answer.
    distractorFeedback: choices.filter(id => id !== authored.correct).map(optionId => ({ optionId, explanation: authored.feedback })),
    objective: gap.intent, sourceIds: input.sources.map(s => s.id),
    workedExample: { hanzi: waypoint.exampleHanzi, meaning: waypoint.exampleMeaning, explanation: waypoint.explanation },
  }
}

type QuestionComparison = Pick<QuizQuestion, 'stem' | 'passage'> & Partial<Pick<QuizQuestion, 'options' | 'correctOptionId'>>

/** Detect text duplicates and unchanged fixed-expression assessments, independent of choice order. */
export function assertDistinctQuestion(question: QuestionComparison,
  previous: ReadonlyArray<QuestionComparison>, settings?: Pick<LessonSettings, 'quizLevel' | 'complexity'>) {
  const signature = (q: Pick<QuizQuestion, 'stem' | 'passage'>) => `${q.passage ?? ''}\n${q.stem}`
    .normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
  if (previous.some(existing => signature(existing) === signature(question))) throw new InputValidationError('This question repeats an existing question.')
  if (!settings || settings.complexity !== 'phrases' || !englishAnswers(settings.quizLevel) || !question.passage || !question.options?.length) return
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
  const answers = (q: QuestionComparison) => JSON.stringify(q.options?.map(option => normalize(option.text)).sort())
  const key = (q: QuestionComparison) => q.options?.find(option => option.id === q.correctOptionId)?.text
  const correct = key(question)
  if (correct && previous.some(existing => existing.passage && existing.options?.length
    && normalize(existing.passage) === normalize(question.passage!)
    && answers(existing) === answers(question) && key(existing) && normalize(key(existing)!) === normalize(correct))) {
    throw new InputValidationError('This fixed-expression question repeats the same Mandarin, answer choices and correct answer with a different heading. Keep the expression in passage and ask "When would someone say this?" with four English descriptions of circumstances.')
  }
}

/** Validate saved/content questions directly, without converting back into a model tool call. */
export function validateWaypointQuestion(question: QuizQuestion, cardId: string, input: WaypointLessonInput, phase: 'practice' | 'check') {
  const target = input.targets.find(t => t.cardId === cardId)
  if (!target) throw new InputValidationError('Saved question target is unavailable.')
  // The saved quiz renderer displays plain passage text, with no selected-span markers.
  if (/\b(?:underlined|highlighted|bold(?:ed)?|italic(?:ized|ised)?|circled|marked|colou?red|shaded)\s+(?:(?:Mandarin|Chinese|target|key|selected)\s+){0,2}(?:word|phrase|expression|character|text|sentence|clause|part|term)s?\b/i.test(question.stem)) {
    throw new InputValidationError('The quiz does not underline, highlight or mark an expression. Put the expression to interpret in passage and refer to it as this expression or the passage.')
  }
  const { quizLevel: _level, passagePinyin: _pinyin, passageOrigin: _origin, lessonStep: _step, ...content } = question
  const proposal = { ...content, options: content.options.map(({ id, text }) => ({ id, text })) }
  const scopedIds = input.sources.map(s => s.id).filter(id => /^source-[1-9]\d*$/.test(id))
  const visible = [content.stem, content.passage, content.objective, content.explanation, ...content.options.map(o => o.text), ...content.distractorFeedback.map(f => f.explanation), ...Object.values(content.workedExample ?? {})].join('\n')
  if (/<\/?(?:answer[A-D]|stem|passage|feedback|correct|parameter|arg_key|arg_value|tool_call|function)\b[^>]*>/i.test(visible)) throw new InputValidationError('Remove tool serialization tags from learner-facing text; return clean question and answer text.')
  if ((visible.match(/(?<![\p{L}\p{N}_-])source-[1-9]\d*(?![\p{L}\p{N}_-])/gu) ?? []).some(id => scopedIds.includes(id))) throw new InputValidationError('Remove internal source references from learner-facing text.')
  const canonical = validatePreparedQuiz({ title: 'Lesson question', questions: [proposal] }, [target], input.sources.map(s => s.id),
    { version: 1, kind: input.kind, settings: input.settings, source: input.sourceMaterial, steps: [] }, phase).questions[0]!
  delete canonical.lessonStep
  return canonical
}
