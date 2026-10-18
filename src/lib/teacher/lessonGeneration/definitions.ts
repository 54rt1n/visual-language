import type { LessonKind } from '../../domain/lessonPlan'
import type { WaypointLessonInput } from '../../domain/lessonGraph'
import { InputValidationError } from '../../domain/validation'

export type LessonDefinition = { kind: LessonKind; version: string; material: 'conversation' | 'scenario' | 'passage'; guidance: string }

export const lessonDefinitions: Record<LessonKind, LessonDefinition> = {
  topic: { kind: 'topic', version: '2', material: 'conversation', guidance: 'TOPIC CONTEXT: The selected conversation expressions support present-day meanings, uses and useful contrasts. Unrelated vocabulary and invented character origins are unsupported. Practice concerns those understandings; checks apply the same sense in a fresh situation within the selected scope.' },
  scenario: { kind: 'scenario', version: '2', material: 'scenario', guidance: 'SCENARIO CONTEXT: sourceMaterial.scenario defines the learner role, partner role and practical goal. Useful turns and their underlying understandings are the lesson subject. Practice concerns the original exchange; checks use a changed external circumstance within it. Roles, target objects, quantities, preferences and intent stay fixed, including who requests, gives and receives each item.' },
  reading: { kind: 'reading', version: '3', material: 'passage', guidance: 'READING CONTEXT: sourceMaterial.passageHanzi is the source authority for its expressions, instructions, qualifiers and relationships. Teaching examples are short contiguous source excerpts. Practice concerns source language or taught replies about explicitly supplied facts. Checks use a fresh reading task or a new example of the same taught understanding. The app labels contiguous source passages as "From your reading" and other passages as "New example". Source entities, quantities, negation and conditions remain factual when discussing the original reading; labeled new examples may change settings and objects while retaining the taught sense. English alternatives may describe fitting situations. Outside subject knowledge is not assumed, and hypothetical situations are not facts about the source.' },
}

export function validateLessonBrief(input: WaypointLessonInput) {
  const definition = lessonDefinitions[input.kind]
  if (definition.material === 'passage' && !input.sourceMaterial || definition.material === 'scenario' && !input.sourceMaterial?.scenario) throw new InputValidationError('This lesson kind needs its saved source material.')
  return definition
}
