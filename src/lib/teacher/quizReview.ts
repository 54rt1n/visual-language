import { z } from 'zod'
import { lessonQuizContentReviewSchema, quizContentReviewSchema, type QuizContentReview } from './contracts'
import { QUIZ_EVIDENCE_REVIEW } from './lessonPrompts'

/** Grounding policy promoted after paired review controls and recorded-lesson replay. */
export const FEEDBACK_GROUNDING_REVIEW = `Check question-specific claims separately from general language use. For EACH question, inspect the correct option, explanation, every distractor explanation and worked-example explanation. In its evidence, identify an actual teaching claim and what supports it, or name the missing support.
A neutral location or speaker role does not establish a preceding event, motive or other person's action. If feedback asserts such a detail without support in the visible question or original source, set sourceSupported false. Plausibility, a correct key, and a useful pedagogical story do not make an unsupported factual assertion valid. If the key itself adds an unsupported detail, also set oneCorrectAnswer false.
Allow accurate general usage guidance and clearly hypothetical examples (such as 'you could say this if ...'); these do not assert that an event occurred in this question. Preserve facts explicitly supplied by the question or source. For example, a closed sign does not establish a broken lock, although an explicitly hypothetical after-hours example can illustrate the meaning. Apply all other criteria independently; do not rewrite the candidate or excuse a defect as scaffolding.`

/** Shared by production and frozen reviewer calibration; does not include case labels. */
export function quizReviewInstructions(lesson: boolean): string[] {
  return [
    `Content review only. Independently check the saved quiz against its frozen target skills, senses, learner level and cited sources. Every question needs exactly one defensible correct choice, supported answer/feedback, no stem answer leak and suitable difficulty. For targets with reviewSettings, enforce their answer language, pinyin support, complexity and scope. Validate displayed pinyin pronunciation in context. Check its workedExample Mandarin sentence, full translation and language explanation against the same source and sense. If ambiguous, return uncertain or rejected. Return JSON matching ${JSON.stringify(z.toJSONSchema(lesson ? lessonQuizContentReviewSchema : quizContentReviewSchema))}.`,
    ...(lesson ? [`Also assess lessonAligned for every question: it must match the frozen lesson objective, exercise activity, language complexity, topic scope and answer format. A check question must use a meaningfully changed situation from the practice quiz, not merely paraphrase it. For English-answer questions, hide the Mandarin passage mentally: reject a stem that translates the situation and lets a learner infer the key from English alone. The Mandarin stimulus must respect the selected complexity and taught vocabulary. Mandarin-answer questions need one defensible reply. Validate pinyin pronunciation in context when present. Do not treat model-generated guidance or the answer key as proof of correctness.
${QUIZ_EVIDENCE_REVIEW}

${FEEDBACK_GROUNDING_REVIEW}`] : []),
  ]
}

export function quizReviewSupported(review: QuizContentReview, lesson: boolean) {
  return review.verdict === 'supported' && review.questions.every(q => q.oneCorrectAnswer && q.sourceSupported && q.skillAligned && q.answerHidden && q.levelAppropriate && q.evidence.trim() && (!lesson || q.lessonAligned === true))
}
