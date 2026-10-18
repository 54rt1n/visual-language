import { z } from 'zod'
import { normalizeEndpoint } from './ai/http'
import { compatibilityIds, providerDefaults, providerIds, providerNames, type ProviderId } from './ai/providers'
export { providerCatalog, providerDefaults, providerIds, providerNames, type ProviderId } from './ai/providers'

export const SETTINGS_KEY = 'vl-settings-v2'
export const LEGACY_SETTINGS_KEY = 'vl-settings-v1'
export const SPEECH_PREFERENCES_KEY = 'vl-speech-v1'
export const providerCompatibilitySchema = z.enum(compatibilityIds)
export type ProviderCompatibility = z.infer<typeof providerCompatibilitySchema>

const profileSchema = z.strictObject({
  baseUrl: z.string().max(2000), model: z.string().max(300),
  compatibility: providerCompatibilitySchema.optional(),
  apiKey: z.string().max(4096), keyOrigin: z.string().max(2000),
})
const emptyProfile = (id: ProviderId) => ({ ...providerDefaults[id], apiKey: '', keyOrigin: '' })
export const settingsSchema = z.strictObject({
  version: z.literal(2), selected: z.enum(providerIds),
  profiles: z.strictObject({ featherless: profileSchema, nebius: profileSchema, openrouter: profileSchema, custom: profileSchema,
    openai: profileSchema.default(() => emptyProfile('openai')), anthropic: profileSchema.default(() => emptyProfile('anthropic')),
    google: profileSchema.default(() => emptyProfile('google')), alibaba: profileSchema.default(() => emptyProfile('alibaba')),
    minimax: profileSchema.default(() => emptyProfile('minimax')) }),
  tavily: z.strictObject({ apiKey: z.string().max(4096) }),
})
export type Settings = z.infer<typeof settingsSchema>
export type ProviderProfile = Settings['profiles'][ProviderId]
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export const speechPreferencesSchema = z.strictObject({
  voiceURI: z.string().max(1000),
  rate: z.number().min(0.5).max(1.2),
})
export type SpeechPreferences = z.infer<typeof speechPreferencesSchema>

export function defaultSpeechPreferences(): SpeechPreferences {
  return { voiceURI: '', rate: 0.7 }
}

/** Device-local because browser voice identifiers do not transfer reliably. */
export function loadSpeechPreferences(storage: StorageLike = localStorage): SpeechPreferences {
  const raw = storage.getItem(SPEECH_PREFERENCES_KEY)
  return raw ? speechPreferencesSchema.parse(JSON.parse(raw)) : defaultSpeechPreferences()
}

export function saveSpeechPreferences(preferences: SpeechPreferences, storage: StorageLike = localStorage): void {
  storage.setItem(SPEECH_PREFERENCES_KEY, JSON.stringify(speechPreferencesSchema.parse(preferences)))
}

export function defaultSettings(): Settings {
  return {
    version: 2, selected: 'nebius',
    profiles: Object.fromEntries(providerIds.map(id => [id, { ...providerDefaults[id], apiKey: '', keyOrigin: '' }])) as Settings['profiles'],
    tavily: { apiKey: '' },
  }
}

/** No write on read: a corrupt/unsupported record must never be replaced by defaults. */
export function loadSettings(storage: StorageLike = localStorage): Settings {
  const raw = storage.getItem(SETTINGS_KEY)
  if (raw) return settingsSchema.parse(JSON.parse(raw))
  const next = defaultSettings()
  const legacy = storage.getItem(LEGACY_SETTINGS_KEY)
  if (!legacy) return next
  const old = z.object({ apiKey: z.string().default(''), baseUrl: z.string(), model: z.string() }).parse(JSON.parse(legacy))
  const baseUrl = normalizeEndpoint(old.baseUrl)
  const id = providerIds.find(id => providerDefaults[id].baseUrl === baseUrl) ?? 'custom'
  next.selected = id
  next.profiles[id] = { baseUrl, model: old.model, apiKey: old.apiKey, keyOrigin: new URL(baseUrl).origin }
  return next
}

export function saveSettings(settings: Settings, storage: StorageLike = localStorage): void {
  const validated = settingsSchema.parse(settings)
  for (const id of providerIds) {
    const profile = validated.profiles[id]
    if (profile.baseUrl) normalizeEndpoint(profile.baseUrl)
    if (profile.apiKey && new URL(normalizeEndpoint(profile.baseUrl)).origin !== profile.keyOrigin) {
      throw new Error(`Confirm the ${providerNames[id]} endpoint before saving its key.`)
    }
  }
  storage.setItem(SETTINGS_KEY, JSON.stringify(validated))
  // Preserve the legacy record for recovery; it is never included in backups.
}

/** Call only after the learner explicitly confirms this key/endpoint pairing. */
export function bindProfileKey(profile: ProviderProfile): ProviderProfile {
  const baseUrl = normalizeEndpoint(profile.baseUrl)
  return { ...profile, baseUrl, apiKey: profile.apiKey.trim(), keyOrigin: profile.apiKey.trim() ? new URL(baseUrl).origin : '' }
}

export function envApiKey(provider: ProviderId | 'tavily' = 'openrouter'): string {
  // Replaced with {} at production build time, independently of environment variable names.
  return typeof __VL_TEST_KEYS__ === 'undefined' ? '' : (__VL_TEST_KEYS__[provider] ?? '')
}

/** Resolve credentials without requiring a model, so a learner can discover one. */
export function resolveProviderAccess(settings: Settings, id = settings.selected) {
  const profile = settings.profiles[id]
  const baseUrl = normalizeEndpoint(profile.baseUrl)
  const origin = new URL(baseUrl).origin
  if (profile.apiKey && profile.keyOrigin !== origin) throw new Error('This endpoint has not been approved for the saved key. Confirm it in Settings.')
  // Development fallback is allowed ONLY for the original provider's own endpoint.
  const testKey = baseUrl === providerDefaults[id].baseUrl ? envApiKey(id) : ''
  const apiKey = profile.apiKey.trim() || testKey
  if (!apiKey) throw new Error(`Add your ${providerNames[id]} key in Settings.`)
  return { provider: id, baseUrl, apiKey, ...(profile.compatibility ? { compatibility: profile.compatibility } : {}) }
}

export function resolveProvider(settings: Settings, id = settings.selected) {
  const access = resolveProviderAccess(settings, id), model = settings.profiles[id].model.trim()
  if (!model) throw new Error('Choose a model in Settings.')
  return { ...access, model }
}

export function resolvedApiKey(settings: Settings): string {
  try { return resolveProvider(settings).apiKey } catch { return '' }
}

export function resolveTavilyKey(settings: Settings): string {
  const key = settings.tavily.apiKey.trim() || envApiKey('tavily')
  if (!key) throw new Error('Add your Tavily key in Settings to search the web.')
  return key
}

/** Explicit allowlist projection: no keys or key-binding authority enter workspace data. */
export function publicProviderPreferences(settings: Settings) {
  return {
    selected: settings.selected,
    profiles: Object.fromEntries(providerIds.map(id => {
      const { baseUrl, model, compatibility } = settings.profiles[id]
      return [id, { baseUrl: baseUrl ? normalizeEndpoint(baseUrl) : '', model, ...(compatibility ? { compatibility } : {}) }]
    })),
  }
}
