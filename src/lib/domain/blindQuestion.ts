import { z } from 'zod'

export const blindQuestionResultSchema = z.strictObject({
  answerId: z.enum(['A', 'B', 'C', 'D', 'unknown']),
  reason: z.string().trim().min(1).max(1000),
})
/** Construct by allowlist: caller-owned keys, feedback and lesson context never enter the blind view. */
export function blindQuestionView(candidate: { stem: string; answerA: string; answerB: string; answerC: string; answerD: string }) {
  const view = { stem: candidate.stem, choices: (['A', 'B', 'C', 'D'] as const)
    .map(id => ({ id, text: candidate[`answer${id}`] })) }
  if ([view.stem, ...view.choices.map(choice => choice.text)].some(text => typeof text !== 'string' || !text.trim() || /\p{Script=Han}/u.test(text))) {
    throw new Error('The blind question view requires nonempty English fields without Hanzi.')
  }
  return view
}
