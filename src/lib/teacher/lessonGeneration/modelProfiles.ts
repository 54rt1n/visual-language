import type { ChatOptions } from '../../ai/types'
import qwenProfile from './profiles/qwen-v7.json'
import glmProfile from './profiles/glm-native-v2.json'
import nemotronProfile from './profiles/nemotron-lightning-v3.json'
import { modelIdentity } from '../../ai/modelIdentity'
import { lessonProviderProtocol } from './providerProtocol'
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
    toolChoice: z.enum(['auto', 'required']).optional(),
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

/** Unknown models keep the shared guidance. */
export const defaultLessonModelProfile: LessonModelProfile = { id: 'shared', version: '1' }
type ProfileProvider = Pick<ChatOptions, 'model' | 'compatibility'>
const modelProfiles: Record<string, unknown> = {
  qwen3827b: qwenProfile, qwen38flashnext: qwenProfile,
  glm53flash: glmProfile, nemotron35lightning: nemotronProfile,
}

/** Model guidance follows model identity across providers; explicit overrides win. */
export function selectLessonModelProfile(profile?: LessonModelProfile, provider?: ProfileProvider): LessonModelProfile {
  return lessonModelProfileSchema.parse(profile ?? (provider && modelProfiles[modelIdentity(provider.model)]) ?? defaultLessonModelProfile)
}

export function resolveLessonModelProfile(profile: LessonModelProfile | undefined, stage: LessonStageId, provider?: ProfileProvider,
  quizLevel?: LessonSettings['quizLevel']) {
  const selected = selectLessonModelProfile(profile, provider)
  const adapter = lessonProviderProtocol(provider)
  const override = selected.stages?.[stage]
  const baseGuidance = [selected.guidance, override?.guidance].filter(Boolean).join('\n')
  const direction = quizLevel === undefined ? undefined : englishAnswers(quizLevel) ? 'comprehensionGuidance' : 'replyGuidance'
  const contextualGuidance = direction ? [selected[direction], override?.[direction]].filter(Boolean).join('\n') : ''
  const protocol = override?.protocol ?? selected.protocol ?? adapter.protocol
  return { profile: selected,
    nativeExamples: override?.nativeExamples ?? [],
    taskPlacement: override?.taskPlacement ?? selected.taskPlacement ?? 'system',
    protocol,
    guidance: [baseGuidance, contextualGuidance, protocol.toolResponseDialect === 'qwen_xml' ? adapter.guidance : ''].filter(Boolean).join('\n\n'),
    generation: { maxTokens: GENERATION_OUTPUT_TOKENS, temperature: 0.2,
      reasoning: stage === 'evaluateCoverage' ? 'on' as const : 'off' as const,
      ...selected.generation, ...override?.generation },
  }
}
