import { z } from 'zod'
import { englishAnswers, type LessonSettings } from '../domain/lessonPlan'
import { quizDraftSchema } from '../learning/quiz'

const question = quizDraftSchema.shape.questions.element.shape
const priorQuizQuestionsSchema = z.object({ title: quizDraftSchema.shape.title, questions: z.array(z.object({
  cardId: question.cardId, stem: question.stem, passage: question.passage,
  options: z.array(z.object({ id: question.options.element.shape.id, text: question.options.element.shape.text })).length(4),
})).min(1).max(3) })

/** Prior visible questions establish freshness; old feedback is not teaching authority. */
export function priorQuizQuestions(quiz: unknown) {
  return quiz === undefined ? undefined : priorQuizQuestionsSchema.parse(quiz)
}

export const QUIZ_SUBMISSION_RULES = `Submission checklist:
Every stem is English only, with zero Chinese characters even inside quotation marks. Refer to "the expression" instead of quoting Mandarin in the stem.
For English-answer questions, use a neutral comprehension question such as "What does the speaker mean?" Keep the situation in the Mandarin passage. If the passage were hidden, the English stem must not reveal the answer.
Keep the Mandarin stimulus at the selected complexity: a brief familiar expression for phrases, one short clause for simple, two linked clauses for connected. Reuse taught vocabulary; avoid adding an untaught narrative just to create context.
Submit one complete native draft_multiple_choice_quiz call. Include title and all questions; each question includes cardId, stem, options, correctOptionId, explanation, distractorFeedback, sourceIds, objective, workedExample, and passage when required. Use only declared fields. A repair is a complete replacement, including the answer key for every target, not a patch.`

export const QUIZ_EVIDENCE_REVIEW = `Review every learner-facing field, including explanations, distractor feedback, and worked examples; a correct answer key cannot compensate for misleading teaching.
Character-origin stories, component-based explanations of a phrase's meaning, and mnemonic claims need explicit supporting evidence in the supplied sources. A saved phrase definition does not support such a story. If one appears without evidence, mark sourceSupported false for that question and return uncertain or rejected; do not excuse it as merely interpretive.
Check the literal referents in the stem, correct reply and worked example. A changed situation must preserve the target's supported meaning; substituting a related object or ingredient can make the old reply wrong. The key must answer the actual question, not merely be the closest of four poor choices.
Assess the complexity of the entire Mandarin stimulus, not just the selected target. At phrases complexity, a multi-clause narrative with untaught supporting vocabulary is not level-appropriate. Mark levelAppropriate and lessonAligned false when the stimulus exceeds the selected complexity. Cite the concrete offending field in evidence.`

export function prepareReviewQuizInstructions(settings: LessonSettings) {
  return `GENERATION MODE: PREPARE DELAYED REVIEW QUIZ.
TOPIC RECIPE: Connect each target phrase to the lesson topic and a practical example.
Fill exactly one question for every supplied target, using the saved lesson guidance and objective.
Test delayed understanding in a fresh self-contained context. Do not show the earlier lesson, translations, hints, or worked examples before the answer. Preserve each target’s saved support level, complexity and topic scope.
${englishAnswers(settings.quizLevel) ? 'Activity: meaningChoice. Put the Mandarin sentence to interpret in passage. Write the question stem and all four answer choices in English. Assess the target phrase in context, not unrelated facts.' : 'Activity: replyChoice. Give a clear English situation/instruction in stem and four Hanzi-only replies in options. An optional passage may contain only Mandarin context, never a translation of the intended reply. Constrain the situation enough for exactly one reply to be correct.'}
The base Mandarin passage and choices must contain no Latin text, pinyin, or English translations. Do not output presentation metadata, lessonStep, quizLevel, passagePinyin or option pinyin; the application freezes and renders those fields.
Complexity: ${settings.complexity}. Topic scope: ${settings.scope}. Growth focus: ${settings.focus}. These are independent of the quiz format. Keep vocabulary and syntax within the lesson's teaching material; explain unfamiliar supporting words in the question without revealing the answer.
Give four plausible, distinct options, exactly one defensible key, feedback for every distractor, and a worked example for after submission. Avoid answer-position, length, or translation clues. Cite sources supporting the target use. Use draft_multiple_choice_quiz; do not choose the next activity or change learner progress.
${QUIZ_SUBMISSION_RULES}`
}
