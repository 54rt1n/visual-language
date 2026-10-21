import { providerCatalog } from '../../src/lib/ai/providers'

export const evaluationProviders = ['featherless', 'nebius', 'alibaba', 'minimax', 'openrouter'] as const
export type EvaluationProvider = typeof evaluationProviders[number]
export const modelMatrix: ReadonlyArray<{ provider: EvaluationProvider; model: string }> = [
  { provider: 'featherless', model: 'deepseek-ai/DeepSeek-V4-Flash-0731' },
  { provider: 'featherless', model: 'Qwen/Qwen3.8-Flash-Next' },
  { provider: 'featherless', model: 'Qwen/Qwen3.8-27B' },
  { provider: 'featherless', model: 'zai-org/GLM-5.3-Flash' },
  { provider: 'alibaba', model: 'qwen3.8-max' },
  { provider: 'minimax', model: 'MiniMax-M2.7' },
  { provider: 'minimax', model: 'MiniMax-M3' },
  { provider: 'minimax', model: 'MiniMax-M3.1-Flash-Preview' },
  { provider: 'nebius', model: 'deepseek-ai/DeepSeek-V4-Flash-0731' },
  { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' },
]
export const candidateModels = [...new Set(modelMatrix.map(entry => entry.model))]

/** Resolve only this provider's credentials; no cross-provider fallback. */
export function evaluationApiKey(provider: EvaluationProvider, env: Record<string, string>): string {
  return providerCatalog[provider].envKeys.map(name => env[name]?.trim()).find(Boolean) ?? ''
}
