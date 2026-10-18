import { z } from 'zod'
import { lessonWaypointSchema, validateLessonGraph, type LessonGraph, type WaypointLessonInput } from '../domain/lessonGraph'

/** The author supplies one waypoint. The application owns its ID and overview. */
export const waypointProposalSchema = lessonWaypointSchema.omit({ id: true })
export const waypointReviewSchema = z.strictObject({
  decision: z.enum(['accept', 'revise', 'reject']), reason: z.string().trim().min(1).max(1000),
})
export const graphReviewSchema = z.strictObject({
  decision: z.enum(['accept', 'add', 'revise', 'reject']), reason: z.string().trim().min(1).max(1000),
  waypointId: lessonWaypointSchema.shape.id.optional(),
})

export function applyWaypoint(graph: LessonGraph, id: string, value: unknown, input: WaypointLessonInput) {
  const point = lessonWaypointSchema.parse({ ...(value as object), id })
  const next = { overview: graph.overview || 'Lesson in preparation.', waypoints: [...graph.waypoints] }
  const index = next.waypoints.findIndex(w => w.id === id)
  if (index < 0) next.waypoints.push(point); else next.waypoints[index] = point
  return validateLessonGraph(next, input, false)
}
export function proposalWaypoint(value: z.infer<typeof waypointProposalSchema>, id: string) {
  return lessonWaypointSchema.parse({ ...value, id })
}

/** A short learner-facing summary derived from the accepted learning objectives. */
export function lessonOverview(graph: Pick<LessonGraph, 'waypoints'>) {
  const summary = graph.waypoints.map(point => point.objective.trim()).join(' ')
  if (summary.length <= 1500) return summary
  const lastSpace = summary.lastIndexOf(' ', 1499)
  return summary.slice(0, lastSpace > 1200 ? lastSpace : 1499).trimEnd() + '…'
}
