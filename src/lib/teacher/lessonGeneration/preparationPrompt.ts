import { englishAnswers, withPinyin, type LessonSettings } from '../../domain/lessonSettings'

export function preparationSettings(settings: LessonSettings) {
  const focus = { characters: 'Recognize Mandarin words and characters', complexity: 'Understand and use Mandarin expressions and sentence patterns', specificity: 'Use Mandarin for the chosen topic or situation' }[settings.focus]
  const examples = { phrases: 'short fixed expressions', simple: 'one short Mandarin clause', connected: 'up to two short linked Mandarin clauses' }[settings.complexity]
  return `${focus}. Teach through written examples (${examples}) with English explanations. Practice and assessment use multiple-choice questions with ${englishAnswers(settings.quizLevel) ? 'English' : 'Mandarin'} answers. Mandarin is shown ${withPinyin(settings.quizLevel) ? 'with pinyin' : 'without pinyin'}. The app supplies pronunciation. Exercises use text selections rather than picture matching or spoken/typed answers.`
}

/** Readable lesson evidence; structured records are reserved for plans under review. */
export function preparationEvidence(context: Record<string, unknown>) {
  return Object.entries(context).filter(([, value]) => value !== undefined).map(([key, value]) => {
    const label = key.replace(/([a-z])([A-Z])/g, '$1 $2')
    const heading = label[0]!.toUpperCase() + label.slice(1)
    return `## ${heading}\n${typeof value === 'string' ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``}`
  }).join('\n\n')
}
