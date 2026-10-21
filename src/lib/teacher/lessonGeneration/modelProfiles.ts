import type { ChatOptions } from '../../ai/types'
import featherlessQwenProfile from './profiles/featherless-qwen-v6.json'
import featherlessGlmProfile from './profiles/featherless-glm-native-v1.json'
import openrouterNemotronProfile from './profiles/openrouter-nemotron-lightning-v1.json'
import { z } from 'zod'
import { GENERATION_OUTPUT_TOKENS } from '../../ai/generationBudget'
import { englishAnswers, type LessonSettings } from '../../domain/lessonSettings'
import { lessonStageIds, type LessonStageId } from './stages'

const generationSettings = z.strictObject({
  maxTokens: z.number().int().min(1).max(GENERATION_OUTPUT_TOKENS).optional(),
  temperature: z.number().min(0).max(2).optional(),
  reasoning: z.enum(['on', 'off']).optional(),
})
const adaptation = z.strictObject({
  taskPlacement: z.enum(['system', 'user_context_tail']).optional(),
  guidance: z.string().trim().min(1).max(4000).optional(),
  comprehensionGuidance: z.string().trim().min(1).max(4000).optional(),
  replyGuidance: z.string().trim().min(1).max(4000).optional(),
  generation: generationSettings.optional(),
  protocol: z.strictObject({ toolResponseDialect: z.enum(['native', 'qwen_xml']), normalizeParameterNameQuotes: z.boolean().optional(),
    allowAssistantPrefix: z.boolean().optional(), normalizeFunctionOpening: z.boolean().optional() }).optional(),
})
const nativeExample = z.strictObject({ context: z.record(z.string(), z.unknown()), arguments: z.record(z.string(), z.unknown()) })
export type NativeLessonExample = z.infer<typeof nativeExample>
export const lessonModelProfileSchema = adaptation.extend({
  id: z.string().trim().min(1).max(100), version: z.string().trim().min(1).max(100),
  stages: z.partialRecord(z.enum(lessonStageIds), adaptation.extend({ nativeExamples: z.array(nativeExample).min(1).max(3).optional() })).optional(),
})
export type LessonModelProfile = z.infer<typeof lessonModelProfileSchema>
export type LessonTaskPlacement = NonNullable<LessonModelProfile['taskPlacement']>

/** Unknown provider/model combinations keep the shared native profile. */
export const defaultLessonModelProfile: LessonModelProfile = { id: 'shared', version: '1' }
type ProfileProvider = Pick<ChatOptions, 'model' | 'compatibility'>
const evaluatedFeatherlessModels = new Set(['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.8-Flash-Next'])

/** Explicit overrides win; exact evaluated provider/model IDs select their recorded profile. */
export function selectLessonModelProfile(profile?: LessonModelProfile, provider?: ProfileProvider): LessonModelProfile {
  const known = provider?.compatibility === 'featherless' && evaluatedFeatherlessModels.has(provider.model)
  const glm = provider?.compatibility === 'featherless' && provider.model === 'zai-org/GLM-5.3-Flash'
  const nemotron = provider?.compatibility === 'openrouter' && provider.model === 'nvidia/nemotron-3.5-lightning:free'
  return lessonModelProfileSchema.parse(profile ?? (known ? featherlessQwenProfile : glm ? featherlessGlmProfile : nemotron ? openrouterNemotronProfile : defaultLessonModelProfile))
}

export function resolveLessonModelProfile(profile: LessonModelProfile | undefined, stage: LessonStageId, provider?: ProfileProvider,
  quizLevel?: LessonSettings['quizLevel']) {
  const selected = selectLessonModelProfile(profile, provider)
  const override = selected.stages?.[stage]
  const baseGuidance = [selected.guidance, override?.guidance].filter(Boolean).join('\n')
  const direction = quizLevel === undefined ? undefined : englishAnswers(quizLevel) ? 'comprehensionGuidance' : 'replyGuidance'
  const contextualGuidance = direction ? [selected[direction], override?.[direction]].filter(Boolean).join('\n') : ''
  return { profile: selected,
    nativeExamples: override?.nativeExamples ?? [],
    taskPlacement: override?.taskPlacement ?? selected.taskPlacement ?? 'system',
    protocol: { toolResponseDialect: 'native' as const, ...selected.protocol, ...override?.protocol },
    guidance: [baseGuidance, contextualGuidance].filter(Boolean).join('\n\n'),
    generation: { maxTokens: GENERATION_OUTPUT_TOKENS, temperature: 0.2,
      reasoning: stage === 'evaluateCoverage' ? 'on' as const : 'off' as const,
      ...selected.generation, ...override?.generation },
  }
}
