import { z } from 'zod'
import { workedExampleProposalSchema } from '../domain/workedExample'
import { quizLevelSchema, englishAnswers, withPinyin, type QuizLevel } from '../domain/lessonSettings'
import type { LessonPlan } from '../domain/lessonPlan'
import { containsHanzi, mandarinPinyin } from '../mandarin/chineseParser'
import { InputValidationError } from '../domain/validation'
import { readingExcerptIssue } from './sourceExcerpt'

const text = (max: number) => z.string().trim().min(1).max(max)
export const quizDraftSchema = z.strictObject({
  title: text(120),
  questions: z.array(z.strictObject({
    cardId: text(200), stem: text(500), passage: text(2000).optional(),
    options: z.array(z.strictObject({ id: text(100), text: text(200), pinyin: text(1600).optional() })).length(4),
    quizLevel: quizLevelSchema.optional(), passagePinyin: text(16000).optional(),
    passageOrigin: z.enum(['source', 'new_example']).optional(),
    lessonStep: z.number().int().min(0).max(26).optional(),
    correctOptionId: text(100), explanation: text(1000),
    distractorFeedback: z.array(z.strictObject({ optionId: text(100), explanation: text(1000) })).length(3),
    sourceIds: z.array(text(200)).min(1).max(9), objective: text(300),
    workedExample: workedExampleProposalSchema.optional(),
  })).min(1).max(9),
})
export const quizProposalSchema = quizDraftSchema.extend({
  // The model authors content; the app freezes format, pronunciation and recipe
  // position afterwards. Advertising those fields caused otherwise usable native
  // proposals to fail presentation validation before app-owned pinyin was added.
  questions: z.array(quizDraftSchema.shape.questions.element.omit({ quizLevel: true, passagePinyin: true, passageOrigin: true, lessonStep: true }).extend({
    options: z.array(z.strictObject({ id: text(100), text: text(200) })).length(4),
    workedExample: workedExampleProposalSchema,
  })).min(1).max(3),
})
export type QuizDraft = z.infer<typeof quizDraftSchema>
export type QuizQuestion = QuizDraft['questions'][number]

/** Shared by production preparation and isolated prompt experiments. */
export function validatePreparedQuiz(value: unknown, targets: Array<{ cardId: string; hanzi: string }>, sourceIds: string[], plan: LessonPlan, phase: 'practice' | 'check', practice?: QuizDraft): QuizDraft {
  const cardIds = targets.map(t => t.cardId)
  const valid = validateQuizDraft(quizProposalSchema.parse(value), cardIds, sourceIds)
  if (JSON.stringify(valid.questions.map(q => q.cardId).sort()) !== JSON.stringify([...cardIds].sort())) throw new InputValidationError('The prepared quiz must cover every lesson target once.')
  valid.questions = valid.questions.map(q => {
    const index = plan.steps.findIndex(s => s.cardId === q.cardId && s.phase === phase)
    const presented = withQuizPresentation(q, plan.settings.quizLevel, index < 0 ? undefined : index)
    if (plan.kind === 'reading' && q.passage) presented.passageOrigin = readingExcerptIssue(q.passage, plan.source?.passageHanzi) ? 'new_example' : 'source'
    return presented
  })
  const issues: string[] = []
  const expression = (s: string) => s.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
  for (const [index, q] of valid.questions.entries()) {
    issues.push(...quizPresentationIssues(q).map(issue => `Question ${index + 1}: ${issue}`))
    if (plan.kind === 'reading') {
      const issue = readingExcerptIssue(q.workedExample!.hanzi, plan.source?.passageHanzi)
      if (issue) issues.push(`Question ${index + 1} workedExample.hanzi: ${issue}`)
    }
    // A necessary lower bound, not a grammar classifier: one sentence may still
    // contain several clauses. Leave that and vocabulary difficulty to review.
    const sentenceLimit = plan.settings.complexity === 'connected' ? 2 : 1
    const fields: Array<[string, string]> = [
      ['passage', q.passage ?? ''],
      ...q.options.map(o => [`option ${o.id}`, o.text] as [string, string]),
      ['workedExample.hanzi', q.workedExample?.hanzi ?? ''],
    ]
    for (const [field, text] of fields) {
      const sentences = text.split(/[。！？!?]+/u).filter(containsHanzi).length
      if (sentences > sentenceLimit) issues.push(`Question ${index + 1} ${field} has ${sentences} separate Mandarin sentences; ${plan.settings.complexity} permits at most ${sentenceLimit}. Shorten that entire field to the selected language ceiling.${field === 'passage' && !englishAnswers(plan.settings.quizLevel) ? ' Omit optional reply context when the English situation is sufficient.' : ''}`)
    }
    const target = targets.find(t => t.cardId === q.cardId)!
    const english = englishAnswers(plan.settings.quizLevel)
    const stimulus = english ? q.passage ?? '' : q.options.find(o => o.id === q.correctOptionId)!.text
    if (!expression(target.hanzi) || !expression(stimulus).includes(expression(target.hanzi))) issues.push(`Question ${index + 1} must use the selected expression “${target.hanzi}” in its ${english ? 'Mandarin passage' : 'correct Mandarin reply'}. Preserve its quantities and objects; change the setting instead.`)
  }
  const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  if (phase === 'check' && valid.questions.some(q => practice?.questions.some(p => normalize(`${p.passage ?? ''} ${p.stem}`) === normalize(`${q.passage ?? ''} ${q.stem}`)))) issues.push('The lesson check must use fresh questions.')
  if (issues.length) throw new InputValidationError(issues.join('\n'))
  return valid
}

/** Freeze app-owned presentation separately from model-authored question content. */
export function presentQuizQuestion(question: QuizQuestion, level: QuizLevel, lessonStep?: number): QuizQuestion {
  const result = withQuizPresentation(question, level, lessonStep)
  validateQuizPresentation(result)
  return result
}

/** Keep source attribution in the learner view, outside model-authored Mandarin. */
export function quizPassageLabel(question: QuizQuestion): string | undefined {
  return question.passageOrigin === 'source' ? 'From your reading'
    : question.passageOrigin === 'new_example' ? 'New example' : undefined
}

export function quizQuestionPrompt(question: QuizQuestion): string {
  const label = quizPassageLabel(question)
  return question.passage ? `${label ? `${label}:\n` : ''}${question.passage}\n\n${question.stem}` : question.stem
}

/** Decorate before collecting issues; only validated questions leave public functions. */
function withQuizPresentation(question: QuizQuestion, level: QuizLevel, lessonStep?: number): QuizQuestion {
  const result: QuizQuestion = { ...question, quizLevel: level, lessonStep, passagePinyin: undefined,
    options: question.options.map(({ id, text }) => ({ id, text, pinyin: undefined as string | undefined })) }
  if (withPinyin(level)) {
    if (question.passage) result.passagePinyin = mandarinPinyin(question.passage)
    if (!englishAnswers(level)) result.options = result.options.map(o => ({ ...o, pinyin: mandarinPinyin(o.text) }))
  }
  return result
}

export function validateQuizPresentation(question: QuizQuestion) {
  const issues = quizPresentationIssues(question)
  if (issues.length) throw new InputValidationError(issues.join('\n'))
}

function quizPresentationIssues(question: QuizQuestion): string[] {
  const issues: string[] = []
  if (!question.quizLevel) return ['A question needs its saved quiz format.']
  const english = englishAnswers(question.quizLevel), supported = withPinyin(question.quizLevel)
  const feedback = [question.explanation, ...question.distractorFeedback.map(f => f.explanation)]
  if (feedback.some(text => /\(\s*[A-D]\s*\)|\b(?:[Oo]ption|[Aa]nswer|[Cc]hoice)s?\s+[A-D]\b/u.test(text))) issues.push('Feedback must refer to choices by their content, not letters: choices are shuffled and may appear without letter labels.')
  if (question.passageOrigin && !question.passage) issues.push('A reading passage label requires a passage.')
  if (containsHanzi(question.stem)) issues.push('Lesson instructions must be in English. Put the complete Mandarin expression in passage and refer to it as "this expression" in stem. Example: passage="请给我菜单。", stem="In which situation would you say this?".')
  if (english && !question.passage) issues.push('English answers need a Mandarin passage to interpret.')
  const mandarinOnly = (value: string) => containsHanzi(value) && !/\p{Script=Latin}/u.test(value)
  if (question.passage && !mandarinOnly(question.passage)) issues.push('The Mandarin passage must not contain English or supplied pinyin.')
  if (question.options.some(o => english ? containsHanzi(o.text) || !/[a-z]/i.test(o.text) : !mandarinOnly(o.text))) issues.push('Quiz choices must match the requested answer language.')
  if (!english && question.passage) {
    const normalize = (value: string) => value.normalize('NFKC').replace(/[\p{P}\p{Z}\s]/gu, '')
    const key = question.options.find(o => o.id === question.correctOptionId)
    const passage = normalize(question.passage)
    const clauses = question.passage.split(/[，,。！？!?；;：:\n]+/u).map(normalize).filter(Boolean)
    const matching = question.options.filter(o => clauses.includes(normalize(o.text)))
    // Catch a complete reply clause inside a longer excerpt, without treating
    // 好 inside 你好 as an uttered reply. Multiple mentioned alternatives and
    // echoes without clause boundaries still require semantic review.
    if (key && (passage === normalize(key.text) || matching.length === 1 && matching[0]!.id === key.id)) issues.push('The Mandarin context repeats the correct reply. Ask for a reply to the English situation without displaying the answer first.')
  }
  if (question.passagePinyin !== (supported && question.passage ? mandarinPinyin(question.passage) : undefined)) issues.push('Passage pronunciation does not match the saved quiz format.')
  if (question.options.some(o => o.pinyin !== (supported && !english ? mandarinPinyin(o.text) : undefined))) issues.push('Option pronunciation does not match the saved quiz format.')
  return issues
}

/** Structural validation only. A separate bounded semantic review gates activation. */
export function validateQuizDraft(value: unknown, allowedCards: string[], allowedSources: string[]): QuizDraft {
  const draft = quizDraftSchema.parse(value)
  const cards = new Set<string>()
  for (const question of draft.questions) {
    if (question.quizLevel) validateQuizPresentation(question)
    else if (question.lessonStep !== undefined || question.passagePinyin || question.passageOrigin || question.options.some(o => o.pinyin)) throw new InputValidationError('Quiz presentation metadata requires a lesson format.')
    if (!allowedCards.includes(question.cardId) || cards.has(question.cardId)) throw new InputValidationError('Quiz targets must be distinct cards selected for this teacher action.')
    cards.add(question.cardId)
    if (question.sourceIds.some(id => !allowedSources.includes(id)) || new Set(question.sourceIds).size !== question.sourceIds.length) throw new InputValidationError('Quiz sources must resolve to distinct saved/retrieved context.')
    const optionIds = question.options.map(o => o.id)
    const labels = question.options.map(o => o.text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase())
    if (new Set(optionIds).size !== 4 || new Set(labels).size !== 4) throw new InputValidationError('Quiz options must have four distinct IDs and labels.')
    if (!optionIds.includes(question.correctOptionId)) throw new InputValidationError('The answer key must identify an existing option.')
    const distractors = optionIds.filter(id => id !== question.correctOptionId).sort()
    const feedbackIds = question.distractorFeedback.map(f => f.optionId).sort()
    if (JSON.stringify(distractors) !== JSON.stringify(feedbackIds)) throw new InputValidationError('Each distractor needs exactly one explanation.')
  }
  return draft
}

export function shuffleOptions(question: QuizQuestion, random = Math.random): QuizQuestion {
  const clone = structuredClone(question)
  for (let i = clone.options.length - 1; i > 0; i--) {
    const sample = random()
    if (sample < 0 || sample >= 1 || !Number.isFinite(sample)) throw new Error('Invalid shuffle source.')
    const j = Math.floor(sample * (i + 1))
    ;[clone.options[i], clone.options[j]] = [clone.options[j]!, clone.options[i]!]
  }
  return clone
}

export function scoreOption(question: Pick<QuizQuestion, 'options' | 'correctOptionId'>, optionId: string): boolean {
  if (!question.options.some(o => o.id === optionId)) throw new Error('Choose one of this question’s options.')
  return question.correctOptionId === optionId
}

export function studentQuestion(question: QuizQuestion) {
  return { stem: question.stem, passage: question.passage, options: question.options.map(({ id, text }) => ({ id, text })) }
}
