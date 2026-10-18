import { englishAnswers } from './lessonSettings'
import type { LessonGraph, WaypointLessonInput } from './lessonGraph'
import { InputValidationError } from './validation'

type VisibleQuestion = { passage?: string; options: Array<{ id: string; text: string }>; correctOptionId: string }
const hanzi = (text: string) => (text.normalize('NFKC').match(/\p{Script=Han}/gu) ?? []).join('')

/** Necessary symbol-visibility evidence, not a semantic correctness judgment. */
export function recognitionEligibleWaypoints(input: Pick<WaypointLessonInput, 'settings' | 'targets'>,
  graph: LessonGraph, question: VisibleQuestion): string[] | undefined {
  if (input.settings.focus !== 'characters') return undefined
  const visibleTargets = new Set(recognitionEligibleTargets(input, question))
  return graph.waypoints.filter(point => point.cardIds.some(cardId => visibleTargets.has(cardId))).map(point => point.id)
}

/** Visible target expressions, independent of waypoint grouping. */
export function recognitionEligibleTargets(input: Pick<WaypointLessonInput, 'settings' | 'targets'>, question: VisibleQuestion): string[] {
  const evidence = hanzi(englishAnswers(input.settings.quizLevel) ? question.passage ?? ''
    : question.options.find(option => option.id === question.correctOptionId)?.text ?? '')
  return input.targets.filter(target => {
    const expression = hanzi(target.hanzi)
    return expression.length > 0 && evidence.includes(expression)
  }).map(target => target.cardId)
}

export function validateTargetCoverage(input: WaypointLessonInput, graph: LessonGraph, question: VisibleQuestion,
  review: { waypointIds: string[]; cardIds?: string[] }) {
  if (!input.sourceMaterial?.scope || review.cardIds === undefined) return
  const eligible = input.settings.focus === 'characters' ? recognitionEligibleTargets(input, question) : input.targets.map(t => t.cardId)
  if (new Set(review.cardIds).size !== review.cardIds.length || review.cardIds.some(id => !eligible.includes(id)
    || !graph.waypoints.some(w => review.waypointIds.includes(w.id) && w.cardIds.includes(id)))) {
    throw new InputValidationError('Evaluated target coverage must identify distinct visible planned targets actually taught by the credited waypoints.')
  }
}

/** Eligibility is necessary visibility evidence only; the reviewer must still establish understanding. */
export function assertRecognitionCoverage(input: Pick<WaypointLessonInput, 'settings' | 'targets'>,
  graph: LessonGraph, question: VisibleQuestion, waypointIds: string[]) {
  const eligible = recognitionEligibleWaypoints(input, graph, question)
  if (eligible === undefined) return
  for (const id of waypointIds) {
    const waypoint = graph.waypoints.find(point => point.id === id)
    if (!waypoint) throw new InputValidationError('Coverage references an unavailable waypoint.')
    if (!eligible.includes(id)) throw new InputValidationError(
      `${id} cannot receive character-recognition credit: its expression is absent from the interpreted passage or reviewed correct reply. English meanings and wrong reply choices do not establish recognition. Return only supported waypoint IDs.`)
  }
}
