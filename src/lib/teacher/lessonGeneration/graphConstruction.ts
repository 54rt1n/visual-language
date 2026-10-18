import { InferenceFailure } from '../../ai/inferenceFailure'
import type { LessonGraphDraft } from '../../domain/lessonPreparation'

/** Authoring is bounded independently of readiness review, which always sees the last accepted graph. */
export function graphConstructionBudget(limit = 14, checkpoint?: LessonGraphDraft['construction']) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 14) throw new InferenceFailure({ category: 'request_invalid',
    layer: 'validation', retryable: false, message: 'Choose a graph authoring limit from one to fourteen.' })
  if (checkpoint && checkpoint.limit !== limit) throw new InferenceFailure({ category: 'request_invalid', layer: 'validation',
    retryable: false, message: 'A saved graph must retain its original authoring limit.' })
  let operations = checkpoint?.operations ?? 0
  const states = new Set<string>(checkpoint?.states)
  return {
    author() {
      if (operations >= limit) throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget', retryable: false,
        stage: 'graphConstruction', message: 'Lesson construction reached its authoring limit before readiness was established. Accepted learning points remain saved.' })
      operations++
    },
    snapshot() { return { limit, operations, states: [...states] } },
    observe(state: string) {
      if (states.has(state)) throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget', retryable: false,
        stage: 'graphConstruction', message: 'Lesson construction repeated an accepted graph without progress. Accepted learning points remain saved.' })
      states.add(state)
    },
  }
}
