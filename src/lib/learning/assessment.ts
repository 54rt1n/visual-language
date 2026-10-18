import { assessmentSchema, type Assessment, type Exercise } from '../domain/learning'

/** Conservative closed-answer normalization: never discard tones or fold Hanzi variants. */
export function normalizeAnswer(text: string) {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').replace(/[。.!！?？]+$/, '').toLocaleLowerCase()
}
export function validateAssessment(value: unknown, exercise: Exercise): Assessment {
  const assessment = assessmentSchema.parse(value)
  if (assessment.exerciseId !== exercise.id) throw new Error('Assessment targets a different exercise.')
  const criteria = new Map(assessment.criteria.map(c => [c.criterionId, c]))
  if (criteria.size !== assessment.criteria.length || assessment.criteria.some(c => !exercise.rubric.some(r => r.id === c.criterionId))) throw new Error('Assessment contains unknown or duplicate criteria.')
  const required = exercise.rubric.filter(c => c.required)
  if (assessment.grade !== 'uncertain' && exercise.rubric.some(c => !criteria.has(c.id) || criteria.get(c.id)!.met === null || !criteria.get(c.id)!.evidence.trim())) throw new Error('Assessment lacks criterion-level evidence.')
  if (assessment.grade === 'correct' && required.some(c => criteria.get(c.id)?.met !== true)) throw new Error('Correct assessment must satisfy all required criteria.')
  if (assessment.grade === 'incorrect' && !required.some(c => criteria.get(c.id)?.met === false)) throw new Error('Incorrect assessment needs evidence of an unmet required criterion.')
  return assessment
}
export function deterministicAssessment(exercise: Exercise, answer: string, selectedOptionId?: string): Assessment | null {
  let correct: boolean, feedback: string
  if (exercise.multipleChoice) {
    if (!selectedOptionId || !exercise.multipleChoice.options.some(o => o.id === selectedOptionId)) throw new Error('Select an option from the saved question.')
    correct = selectedOptionId === exercise.multipleChoice.correctOptionId
    feedback = correct ? exercise.multipleChoice.explanation : exercise.multipleChoice.distractorFeedback.find(f => f.optionId === selectedOptionId)!.explanation
  } else {
    if (exercise.answerPolicy !== 'exact') return null
    correct = [exercise.expectedAnswer, ...exercise.acceptedAlternatives].some(expected => normalizeAnswer(expected) === normalizeAnswer(answer))
    feedback = correct ? 'Your answer matches an accepted answer.' : `The expected answer is: ${exercise.expectedAnswer}`
  }
  return validateAssessment({ exerciseId: exercise.id, grade: correct ? 'correct' : 'incorrect',
    criteria: exercise.rubric.map(r => ({ criterionId: r.id, met: correct, evidence: exercise.multipleChoice ? `Selected saved option ${selectedOptionId}.` : 'Compared with the frozen accepted answers under the exact-answer rubric.' })), feedback }, exercise)
}
