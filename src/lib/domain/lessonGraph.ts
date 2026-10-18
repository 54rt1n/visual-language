import { z } from 'zod'
import { lessonKindSchema, lessonSettingsSchema, lessonSourceSchema } from './lessonSettings'
import { InputValidationError } from './validation'
import { containsHanzi } from '../mandarin/chineseParser'
import { readingExcerptIssue } from '../learning/sourceExcerpt'

const text = (max: number) => z.string().trim().min(1).max(max)
const references = (max: number) => z.array(text(200)).min(1).max(max)

export const waypointLessonInputSchema = z.strictObject({
  kind: lessonKindSchema, settings: lessonSettingsSchema, objective: text(2000),
  conversationContext: z.string().max(8000), sourceMaterial: lessonSourceSchema.optional(),
  targets: z.array(z.strictObject({ cardId: text(200), hanzi: text(200), meaning: text(1000), teachingPointId: text(200).optional() })).min(1).max(9),
  sources: z.array(z.strictObject({ id: text(200), title: text(200), excerpt: text(4000) })).min(1).max(9),
})
export type WaypointLessonInput = z.infer<typeof waypointLessonInputSchema>

/** Waypoints describe learning outcomes, not a fixed one-node-per-card recipe. */
export const lessonWaypointSchema = z.strictObject({
  id: z.string().regex(/^w[1-9]$/).describe('Local waypoint reference, w1 through w9.'),
  cardIds: references(9),
  dependsOn: z.array(z.string().regex(/^w[1-9]$/)).max(8),
  objective: text(300).describe('One concrete understanding the learner should gain.'),
  explanation: text(1000), exampleHanzi: text(1000), exampleMeaning: text(1000),
  sourceIds: references(3),
})
export const lessonGraphSchema = z.strictObject({
  overview: text(1500), waypoints: z.array(lessonWaypointSchema).min(1).max(9),
})
export type LessonGraph = z.infer<typeof lessonGraphSchema>
export type LessonWaypoint = z.infer<typeof lessonWaypointSchema>

function distinct(ids: string[], label: string) {
  if (new Set(ids).size !== ids.length) throw new InputValidationError(`Duplicate ${label}.`)
}

/** Stable topological order; independent roots are valid learning paths. */
export function orderedWaypoints(graph: LessonGraph): LessonWaypoint[] {
  distinct(graph.waypoints.map(w => w.id), 'waypoint IDs')
  const ids = new Set(graph.waypoints.map(w => w.id)), visited = new Set<string>(), ordered: LessonWaypoint[] = []
  for (const w of graph.waypoints) {
    distinct(w.dependsOn, 'prerequisites')
    if (w.dependsOn.some(id => id === w.id || !ids.has(id))) throw new InputValidationError('A waypoint has an unknown or self prerequisite.')
  }
  while (ordered.length < graph.waypoints.length) {
    const next = graph.waypoints.find(w => !visited.has(w.id) && w.dependsOn.every(id => visited.has(id)))
    if (!next) throw new InputValidationError('Lesson waypoints must form an acyclic graph.')
    visited.add(next.id); ordered.push(next)
  }
  return ordered
}

export function validateLessonGraph(value: unknown, input: WaypointLessonInput, requireAllTargets = true): LessonGraph {
  const graph = lessonGraphSchema.parse(value)
  distinct(input.targets.map(t => t.cardId), 'target IDs'); distinct(input.sources.map(s => s.id), 'source IDs')
  orderedWaypoints(graph)
  const scope = input.sourceMaterial?.scope
  if (scope) {
    distinct(scope.points.map(p => p.id), 'planned point IDs')
    distinct(input.targets.map(t => t.teachingPointId ?? ''), 'planned target mappings')
    if (scope.points.length !== input.targets.length || scope.points.some(p => !input.targets.some(t => t.teachingPointId === p.id && t.hanzi === p.expression && t.meaning === p.meaning))) {
      throw new InputValidationError('The lesson targets must preserve every accepted teaching point.')
    }
  }
  const covered = new Set<string>(), issues: string[] = []
  for (const w of graph.waypoints) {
    distinct(w.cardIds, 'waypoint targets'); distinct(w.sourceIds, 'waypoint sources')
    if (w.cardIds.some(id => !input.targets.some(t => t.cardId === id))) throw new InputValidationError('A waypoint references an unavailable target.')
    if (w.sourceIds.some(id => !input.sources.some(s => s.id === id))) throw new InputValidationError('A waypoint references an unavailable source.')
    w.cardIds.forEach(id => covered.add(id))
    if (!containsHanzi(w.exampleHanzi)) throw new InputValidationError('Each waypoint needs a Mandarin teaching example.')
    if (/\p{Script=Latin}/u.test(w.exampleHanzi)) issues.push(`Waypoint ${w.id} exampleHanzi must not contain English labels or supplied pinyin.`)
    const sentenceLimit = input.settings.complexity === 'connected' ? 2 : 1
    const sentences = w.exampleHanzi.split(/[。！？!?]+/u).filter(containsHanzi).length
    if (sentences > sentenceLimit) issues.push(`Waypoint ${w.id} exampleHanzi has ${sentences} separate Mandarin sentences; ${input.settings.complexity} permits at most ${sentenceLimit}. Shorten the example itself, not just its punctuation.`)
    if (input.kind === 'reading') {
      const issue = readingExcerptIssue(w.exampleHanzi, input.sourceMaterial?.passageHanzi)
      if (issue) issues.push(`Waypoint ${w.id}: ${issue}`)
    }
  }
  if (requireAllTargets && input.targets.some(t => !covered.has(t.cardId))) throw new InputValidationError('The lesson graph must teach every selected target.')
  if (issues.length) throw new InputValidationError(issues.join('\n'))
  return graph
}

/** Include transitive prerequisites, excluding unrelated branches. */
export function waypointContext(graph: LessonGraph, ids: string[]) {
  const order = orderedWaypoints(graph), selected = new Set<string>()
  const include = (id: string) => {
    if (selected.has(id)) return
    const node = order.find(w => w.id === id)
    if (!node) throw new InputValidationError('Unknown question waypoint.')
    selected.add(id); node.dependsOn.forEach(include)
  }
  ids.forEach(include)
  return order.filter(w => selected.has(w.id))
}
