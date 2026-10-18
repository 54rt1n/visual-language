import { z } from 'zod'
import { waypointContext, type LessonGraph, type WaypointLessonInput } from '../domain/lessonGraph'
import { questionGapSchema, type QuestionGap, type WaypointQuiz } from '../domain/lessonPreparation'
import { InputValidationError } from '../domain/validation'
export const questionDirectionsSchema = z.strictObject({
  waypointId: z.string().regex(/^w[1-9]$/).describe('One remaining waypoint to assess next.'),
  cardId: z.string().trim().min(1).max(200).describe('One target taught by that waypoint.'),
  directions: z.string().trim().min(1).max(1600).describe('Up to three feasible question ideas for the selected waypoint and target, in priority order.'),
})
export const questionCoverageReviewSchema = z.strictObject({
  waypointIds: z.array(z.string().regex(/^w[1-9]$/)).max(9),
  cardIds: z.array(z.string().min(1).max(200)).max(9).optional(),
  assessment: z.string().trim().min(1).max(1000),
})

export function validateGap(value: QuestionGap, graph: LessonGraph, input: Pick<WaypointLessonInput, 'targets'>) {
  const gap = questionGapSchema.parse(value)
  if (new Set(gap.waypointIds).size !== gap.waypointIds.length) throw new InputValidationError('A question gap repeats a waypoint reference.')
  const selected = waypointContext(graph, gap.waypointIds)
  const targetIds = input.targets.map(target => target.cardId)
  if (!targetIds.includes(gap.cardId)) throw new InputValidationError(`Unknown question cardId ${JSON.stringify(gap.cardId)}. Choose exactly one supplied target ID: ${JSON.stringify(targetIds)}. Do not join multiple IDs.`)
  if (!selected.some(waypoint => waypoint.cardIds.includes(gap.cardId))) {
    const allowed = [...new Set(selected.flatMap(waypoint => waypoint.cardIds))].filter(id => targetIds.includes(id))
    const teaching = graph.waypoints.filter(waypoint => waypoint.cardIds.includes(gap.cardId)).map(waypoint => waypoint.id)
    throw new InputValidationError(`Question cardId ${JSON.stringify(gap.cardId)} is not taught by selected waypoints ${JSON.stringify(gap.waypointIds)}. These waypoints teach ${JSON.stringify(allowed)}. This target is taught by ${JSON.stringify(teaching)}; match the references to the question's intended target.`)
  }
  return gap
}
/** The graph owns intent and coverage metadata; the planner selects references only. */
export function plannedQuestionGap(selection: { waypointId: string; cardId: string }, graph: LessonGraph, input: Pick<WaypointLessonInput, 'targets'>) {
  const waypoint = graph.waypoints.find(w => w.id === selection.waypointId)
  return validateGap({ waypointIds: [selection.waypointId], cardId: selection.cardId,
    intent: waypoint?.objective ?? '', whyMissing: 'This waypoint still needs evidence from an accepted question in this quiz.' }, graph, input)
}

export function remainingTargetIds(input: WaypointLessonInput | undefined, quiz: Pick<WaypointQuiz, 'questions'>) {
  return input?.sourceMaterial?.scope ? input.targets.filter(t => !quiz.questions.some(q => q.coverageReview?.cardIds?.includes(t.cardId))).map(t => t.cardId) : []
}

export function remainingWaypointIds(graph: LessonGraph, quiz: Pick<WaypointQuiz, 'coverage' | 'questions'>, input?: WaypointLessonInput): string[] {
  const accepted = new Set(quiz.questions.map(question => question.id))
  const assessed = new Set(quiz.coverage.filter(entry => entry.questionIds.some(id => accepted.has(id))).map(entry => entry.waypointId))
  const missing = remainingTargetIds(input, quiz)
  return graph.waypoints.filter(waypoint => !assessed.has(waypoint.id) || waypoint.cardIds.some(id => missing.includes(id))).map(waypoint => waypoint.id)
}

export function assertUnassessedQuestionGap(gap: QuestionGap, graph: LessonGraph, quiz: Pick<WaypointQuiz, 'coverage' | 'questions'>, input?: WaypointLessonInput): void {
  const remaining = remainingWaypointIds(graph, quiz, input)
  const newPoint = gap.waypointIds.some(id => remainingWaypointIds(graph, quiz).includes(id))
  if (!newPoint && input?.sourceMaterial?.scope && !remainingTargetIds(input, quiz).includes(gap.cardId)) throw new InputValidationError('Choose a planned target still missing evaluated question evidence.')
  if (!gap.waypointIds.some(id => remaining.includes(id))) throw new InputValidationError(`Select at least one remaining waypoint: ${remaining.join(', ')}. This direction only targets understandings already assessed in this quiz.`)
}

export function validateCoverage(coverage: WaypointQuiz['coverage'], graph: LessonGraph, questions: Array<{ id: string }>, complete: boolean) {
  const ids = coverage.map(c => c.waypointId)
  if (new Set(ids).size !== ids.length || ids.some(id => !graph.waypoints.some(w => w.id === id))) throw new InputValidationError('Coverage must reference distinct lesson waypoints.')
  for (const c of coverage) if (new Set(c.questionIds).size !== c.questionIds.length || c.questionIds.some(id => !questions.some(q => q.id === id))) throw new InputValidationError('Coverage must cite actual accepted questions.')
  if (complete && (!questions.length || graph.waypoints.some(w => !ids.includes(w.id)))) throw new InputValidationError('Completion omitted coverage evidence or has no accepted questions.')
}
