import type { ChatOptions } from './types'

/** Translate generation intent only where the provider has a supported wire setting. */
export function lessonGenerationSettings(compatibility: ChatOptions['compatibility'], settings: {
  maxTokens: number; temperature: number; reasoning: 'on' | 'off';
}) {
  return { maxTokens: settings.maxTokens, temperature: settings.temperature,
    ...(compatibility === 'featherless' ? { featherlessThinking: settings.reasoning === 'on' } : {}) }
}
