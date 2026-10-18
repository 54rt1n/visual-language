/** Authored creation replies; these test state/protocol plumbing, not language quality. */
export const sourceFixtureTools = ['ground_lesson', 'propose_lesson_points', 'review_lesson_scope', 'prepare_reading_source', 'prepare_scenario_source', 'review_lesson_source']
export const sourceFixturePoints = [
  { expression: '请给我一杯茶', meaning: 'please give me a cup of tea', purpose: 'Politely request a drink.' },
  { expression: '不要加糖', meaning: 'do not add sugar', purpose: 'Specify an ingredient to omit.' },
  { expression: '再来一杯', meaning: 'another cup, please', purpose: 'Request one more drink.' },
  { expression: '我要热茶', meaning: 'I want hot tea', purpose: 'Specify the drink temperature.' },
]
export function lessonSourceFixture(name: string, count = 1) {
  if (name === 'ground_lesson') return { outline: 'Order a drink, specify how it should be made, and request another when needed.' }
  if (name === 'propose_lesson_points') return { points: sourceFixturePoints.slice(0, count) }
  if (name === 'prepare_reading_source') return { passage: '我想喝茶。请给我一杯茶。不要加糖。再来一杯。我要热茶。', translation: 'I would like tea. Please give me a cup of tea. Do not add sugar. Another cup, please. I want hot tea.' }
  if (name === 'prepare_scenario_source') return { situation: 'A simulated visit to a café.', partnerRole: 'Café server', learnerRole: 'Customer', opening: '您想喝什么？', openingMeaning: 'What would you like to drink?', objective: 'Order a drink with useful preferences.' }
  if (name === 'review_lesson_source' || name === 'review_lesson_scope') return { accepted: true, reason: 'Authored scope/source-review fixture, not semantic evidence.' }
  throw new Error(`Unexpected source stage: ${name}`)
}
