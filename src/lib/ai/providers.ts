/** Built-in connections use each vendor's documented OpenAI-compatible API. */
export const providerIds = ['nebius', 'featherless', 'openai', 'anthropic', 'google', 'alibaba', 'minimax', 'openrouter', 'custom'] as const
export type ProviderId = typeof providerIds[number]
export const compatibilityIds = ['standard', 'alibaba', 'featherless', 'anthropic', 'minimax'] as const
export type ProviderCompatibility = typeof compatibilityIds[number]
type ProviderDefinition = { name: string; baseUrl: string; model: string; compatibility?: ProviderCompatibility; modelList: boolean; note: string; keyUrl?: string; envKeys: readonly string[] }
export const providerCatalog: Record<ProviderId, ProviderDefinition> = {
  nebius: { keyUrl: 'https://tokenfactory.nebius.com/', name: 'Nebius', baseUrl: 'https://api.tokenfactory.nebius.com/v1', model: 'deepseek-ai/DeepSeek-V4-Flash-0731', modelList: true, note: 'Connect with your Nebius Token Factory account.', envKeys: ['NEBIUS_API_KEY'] },
  featherless: { keyUrl: 'https://featherless.ai/account/api-keys', name: 'Featherless', baseUrl: 'https://api.featherless.ai/v1', model: 'deepseek-ai/DeepSeek-V4-Flash-0731', compatibility: 'featherless', modelList: true, note: 'Uses your Featherless subscription and its available models.', envKeys: ['FEATHERLESS_API_KEY'] },
  openai: { keyUrl: 'https://platform.openai.com/api-keys', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', modelList: true, note: 'Uses the OpenAI Chat Completions API.', envKeys: ['OPENAI_API_KEY'] },
  anthropic: { keyUrl: 'https://platform.claude.com/settings/keys', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6', compatibility: 'anthropic', modelList: false, note: 'Uses Anthropic’s official OpenAI-compatible API. Enter your Claude model ID directly.', envKeys: ['ANTHROPIC_API_KEY'] },
  google: { keyUrl: 'https://aistudio.google.com/apikey', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', modelList: true, note: 'Uses Google’s official OpenAI-compatible Gemini API.', envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  alibaba: { keyUrl: 'https://modelstudio.console.alibabacloud.com/subscription/token-plan', name: 'Alibaba Cloud', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', compatibility: 'alibaba', modelList: false, note: 'Uses Alibaba Token Plan. For another plan, update Advanced connection settings.', envKeys: ['ALIBABA_TOKEN_KEY'] },
  minimax: { keyUrl: 'https://platform.minimax.io/console/access', name: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M2.7', compatibility: 'minimax', modelList: false, note: 'Uses MiniMax’s official OpenAI-compatible API. Select a model included in your account or plan.', envKeys: ['MINIMAX_API_KEY', 'MINIMAX_TOKEN_KEY'] },
  openrouter: { keyUrl: 'https://openrouter.ai/settings/keys', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', modelList: true, note: 'Uses models available through your OpenRouter account.', envKeys: ['OPENROUTER_API_KEY'] },
  custom: { name: 'Custom endpoint', baseUrl: '', model: '', modelList: true, note: 'Enter an OpenAI-compatible HTTPS endpoint and model ID.', envKeys: [] },
}
export const providerNames = Object.fromEntries(providerIds.map(id => [id, providerCatalog[id].name])) as Record<ProviderId, string>
export const providerDefaults = Object.fromEntries(providerIds.map(id => {
  const { baseUrl, model, compatibility } = providerCatalog[id]
  return [id, { baseUrl, model, ...(compatibility ? { compatibility } : {}) }]
})) as Record<ProviderId, { baseUrl: string; model: string; compatibility?: ProviderCompatibility }>

/** Development-only allowlist; callers must still gate this on the build mode. */
export function developmentProviderKeys(env: Record<string, string>) {
  return Object.fromEntries([...providerIds.map(id => [id, providerCatalog[id].envKeys.map(key => env[key]?.trim()).find(Boolean) ?? '']), ['tavily', env.TAVILY_API_KEY ?? '']])
}

export function providerHeaders(apiKey: string, compatibility?: ProviderCompatibility): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...(compatibility === 'anthropic' ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}) }
}
