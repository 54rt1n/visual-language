import type { LessonGraph, WaypointLessonInput } from '../../domain/lessonGraph'
import type { WaypointQuiz } from '../../domain/lessonPreparation'
import { remainingTargetIds } from '../questionGapTools'
import { InferenceFailure } from '../../ai/inferenceFailure'

/** Reserve capacity for each understanding; a question may still demonstrate several. */
export function assessmentQuestionLimit(graph: LessonGraph, requested?: number, input?: WaypointLessonInput) {
  const limit = requested ?? Math.max(6, graph.waypoints.length, input?.sourceMaterial?.scope ? input.targets.length : 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 9) throw new InferenceFailure({ category: 'request_invalid', layer: 'validation',
    retryable: false, message: 'Choose a question limit from one to nine.' })
  return limit
}

export function assertAssessmentCapacity(graph: LessonGraph, quiz: WaypointQuiz, limit: number, input?: WaypointLessonInput) {
  const missing = graph.waypoints.filter(w => !quiz.coverage.some(c => c.waypointId === w.id))
  const reserved = Math.max(missing.length, remainingTargetIds(input, quiz).length)
  if (reserved > limit - quiz.questions.length) throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget', retryable: false,
    stage: 'quizPlanning', checkpointId: `${quiz.phase}-quiz`, message: `Reserve ${quiz.questions.length + reserved} question positions for the remaining lesson understandings, or reduce lesson scope before generating more questions.` })
}
