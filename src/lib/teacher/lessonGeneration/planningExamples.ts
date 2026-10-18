import { englishAnswers, type LessonSettings } from '../../domain/lessonSettings'
import { questionTeachingExample } from './teachingExamples'

export function questionPlanningExample(settings: LessonSettings, phase: 'practice' | 'check') {
  const example = questionTeachingExample(settings, phase)
  return { input: { ...example.input, remainingWaypointIds: ['w1'], coverage: [] },
    arguments: { waypointId: 'w1', cardId: example.input.target.cardId, directions: englishAnswers(settings.quizLevel)
      ? phase === 'practice' ? 'Interpret 请给我水 using a neutral question and four English meanings.'
        : 'Interpret 请给我茶 using the taught request pattern and tea vocabulary. Practice used water; give four English meanings.'
      : phase === 'practice' ? 'Select the polite Mandarin request for water from the taught replies.'
        : 'Select a polite Mandarin request for tea, applying the taught request pattern to the other taught drink.' } }
}

export function questionPlanningExamplesText(settings: LessonSettings, phase: 'practice' | 'check') {
  const example = questionPlanningExample(settings, phase)
  return `Worked planning example (separate material):\n${JSON.stringify(example.input)}\nComplete planning arguments:\n${JSON.stringify(example.arguments)}`
}
