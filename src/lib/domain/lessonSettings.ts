import { z } from 'zod'
import { identifier, shortText, quizLevelSchema } from './common'
import { roleplayScenarioSchema, lessonScopeSchema } from './discovery'

export { quizLevelSchema } from './common'
export const lessonSettingsSchema = z.strictObject({
  quizLevel: quizLevelSchema,
  complexity: z.enum(['phrases', 'simple', 'connected']),
  scope: z.enum(['everyday', 'topic', 'specialist']),
  focus: z.enum(['characters', 'complexity', 'specificity']),
  topic: shortText(200),
})
export const lessonKindSchema = z.enum(['topic', 'scenario', 'reading'])
export type LessonKind = z.infer<typeof lessonKindSchema>
export const lessonKindLabels = { topic: 'Learn about a topic', scenario: 'Practice a scenario', reading: 'Read about an interest' }
export const lessonSourceSchema = z.strictObject({ draftId: identifier, scope: lessonScopeSchema.optional(), passageHanzi: shortText(2000), passageMeaning: shortText(3000), scenario: roleplayScenarioSchema.nullable() })
export type QuizLevel = z.infer<typeof quizLevelSchema>
export type LessonSettings = z.infer<typeof lessonSettingsSchema>

export const quizLevels: Record<QuizLevel, string> = {
  meaningPinyin: '1 · Understand with pinyin', responsePinyin: '2 · Choose Mandarin with pinyin',
  meaningHanzi: '3 · Understand without pinyin', responseHanzi: '4 · Choose Mandarin without pinyin',
}
export const complexityLabels = { phrases: 'Common phrases', simple: 'Simple sentences', connected: 'Connected sentences' }
export const scopeLabels = { everyday: 'Everyday language', topic: 'A familiar topic', specialist: 'A specific interest or situation' }
export const focusLabels = { characters: 'Character recognition', complexity: 'Language complexity', specificity: 'More specific language' }
export const phaseLabels = { learn: 'Learn', practice: 'Practice', check: 'Check' }
export function englishAnswers(level: QuizLevel) { return level === 'meaningPinyin' || level === 'meaningHanzi' }
export function withPinyin(level: QuizLevel) { return level === 'meaningPinyin' || level === 'responsePinyin' }

