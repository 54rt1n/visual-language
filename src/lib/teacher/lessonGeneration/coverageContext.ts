import { InputValidationError } from '../../domain/validation'
import { recognitionEligibleWaypoints, recognitionEligibleTargets, assertRecognitionCoverage } from '../../domain/coverageEvidence'
import type { LessonGraph, WaypointLessonInput } from '../../domain/lessonGraph'
type CoverageQuestion = Parameters<typeof recognitionEligibleWaypoints>[2] & { stem: string }
type CompactContext = Pick<WaypointLessonInput, 'settings' | 'targets'> & Partial<Pick<WaypointLessonInput, 'sourceMaterial'>> & { plannedTargetIds?: string[] } & { graph: LessonGraph }
/** Reuse compact lesson evidence; own eligibility and the key-free reviewed-question view. */
export function projectCoverageContext<T extends CompactContext>(context: T, question: CoverageQuestion, questionId: string) {
  const { question: _oldQuestion, recognitionEligibleWaypointIds: _oldEligibility, ...base } = context as T & {
    question?: unknown; recognitionEligibleWaypointIds?: unknown }
  const eligible = recognitionEligibleWaypoints(context, context.graph, question)
  return { ...base, ...(eligible === undefined ? {} : { recognitionEligibleWaypointIds: eligible }),
    ...(context.plannedTargetIds || context.sourceMaterial?.scope ? { eligibleTargetIds: context.settings.focus === 'characters' ? recognitionEligibleTargets(context, question) : context.targets.map(t => t.cardId) } : {}),
    question: { id: questionId, stem: question.stem, passage: question.passage,
      options: question.options.map(({ id, text }) => ({ id, text })) } }
}

export function validateCoverageSubmission(context: CompactContext, question: CoverageQuestion, waypointIds: string[], cardIds?: string[]) {
  if (new Set(waypointIds).size !== waypointIds.length || waypointIds.some(id => !context.graph.waypoints.some(point => point.id === id))) {
    throw new InputValidationError('Coverage references unknown or repeated waypoints.')
  }
  assertRecognitionCoverage(context, context.graph, question, waypointIds)
  if (cardIds) {
    const eligible = context.settings.focus === 'characters' ? recognitionEligibleTargets(context, question) : context.targets.map(t => t.cardId)
    if (new Set(cardIds).size !== cardIds.length || cardIds.some(id => !eligible.includes(id) || !context.graph.waypoints.some(w => waypointIds.includes(w.id) && w.cardIds.includes(id)))) throw new InputValidationError('Credit only distinct eligible targets taught by the evaluated waypoints.')
  }
}
