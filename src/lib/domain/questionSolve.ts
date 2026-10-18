import { z } from 'zod'
import { quizPassageLabel, quizQuestionPrompt, type QuizQuestion } from '../learning/quiz'

export const visibleQuestionResultSchema = z.strictObject({
  answerIds: z.array(z.enum(['A', 'B', 'C', 'D'])).max(4)
    .refine(ids => new Set(ids).size === ids.length, 'Answer IDs must be distinct.')
    .describe('Every defensible choice, with distinct IDs. Multiple or no answers are valid observations.'),
  reason: z.string().trim().min(1).max(1000),
})
export const questionAnswerReviewSchema = visibleQuestionResultSchema.extend({
  questionHash: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().trim().min(1).max(200),
})
export type QuestionAnswerReview = z.infer<typeof questionAnswerReviewSchema>

/** Allowlist the actual display, including app-owned pronunciation, never its key or teaching context. */
export function visibleQuestionView(question: QuizQuestion) {
  const label = quizPassageLabel(question)
  return { prompt: quizQuestionPrompt(question),
    choices: question.options.map(({ id, text, pinyin }) => ({ id, text, ...(pinyin ? { pinyin } : {}) })),
    ...(question.passagePinyin ? { passagePinyin: question.passagePinyin } : {}),
    ...(label ? { passageLabel: label } : {}),
  }
}

/** Structural evidence is valid even when the observed answer set is empty, ambiguous or disagrees with the key. */
export function validateQuestionAnswerEvidence(question: QuizQuestion, evidence: QuestionAnswerReview, questionHash: string) {
  const review = questionAnswerReviewSchema.parse(evidence)
  if (review.questionHash !== questionHash) throw new Error('Visible answer evidence belongs to changed question content.')
  if (new Set(review.answerIds).size !== review.answerIds.length || review.answerIds.some(id => !question.options.some(option => option.id === id))) {
    throw new Error('Visible answer evidence must cite distinct actual choices.')
  }
  return review
}

/** A semantic disagreement is author revision work, never a key-revealing solver submission correction. */
export function questionAnswerIssue(question: QuizQuestion, evidence: Pick<QuestionAnswerReview, 'answerIds' | 'reason'>) {
  const issue = evidence.answerIds.length !== 1
    ? `Visible-only solving supports ${evidence.answerIds.length ? `multiple choices (${evidence.answerIds.join(', ')})` : 'no choice'}. Make exactly one reply or meaning defensible in the complete visible question.`
    : evidence.answerIds[0] !== question.correctOptionId
      ? `Visible-only solving supports choice ${evidence.answerIds[0]}, which disagrees with the declared key. Correct the question, choices or key without changing the intended learning task.` : undefined
  return issue ? `${issue} ${evidence.reason}`.slice(0, 1000) : undefined
}

export function requireQuestionAnswerReview(question: QuizQuestion, evidence: QuestionAnswerReview, questionHash: string) {
  const review = validateQuestionAnswerEvidence(question, evidence, questionHash), issue = questionAnswerIssue(question, review)
  if (issue) throw new Error(issue)
}
