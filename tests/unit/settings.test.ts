import { describe, expect, it } from 'vitest'
import { bindProfileKey, defaultSettings, defaultSpeechPreferences, LEGACY_SETTINGS_KEY, loadSettings, loadSpeechPreferences, publicProviderPreferences, resolveProvider, resolveProviderAccess, saveSettings, saveSpeechPreferences, SETTINGS_KEY, SPEECH_PREFERENCES_KEY } from '../../src/lib/settings'
import { preferencesSchema } from '../../src/lib/domain/workspace'

function memory() {
  const records = new Map<string, string>()
  return { records, getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value) } }
}
describe('browser key custody', () => {
  it('adds built-in profiles to four-provider settings and backups without changing saved choices or keys', () => {
    const storage = memory(), settings = defaultSettings()
    settings.selected = 'featherless'
    settings.profiles.featherless = bindProfileKey({ ...settings.profiles.featherless, model: 'saved-model', apiKey: 'saved-key' })
    const old = { ...settings, profiles: Object.fromEntries(['featherless', 'nebius', 'openrouter', 'custom'].map(id => [id, settings.profiles[id as keyof typeof settings.profiles]])) }
    const raw = JSON.stringify(old); storage.setItem(SETTINGS_KEY, raw)
    const loaded = loadSettings(storage)
    expect(loaded.selected).toBe('featherless')
    expect(loaded.profiles.featherless).toEqual(settings.profiles.featherless)
    expect(loaded.profiles.minimax.apiKey).toBe('')
    expect(loaded.profiles.anthropic.compatibility).toBe('anthropic')
    expect(storage.getItem(SETTINGS_KEY)).toBe(raw)
    const preferences = publicProviderPreferences(settings)
    const oldPublic = { ...preferences, profiles: Object.fromEntries(['featherless', 'nebius', 'openrouter', 'custom'].map(id => [id, preferences.profiles[id]])) }
    const restored = preferencesSchema.parse(oldPublic)
    expect(restored.selected).toBe('featherless')
    expect(restored.profiles.google.baseUrl).toContain('generativelanguage.googleapis.com')
    expect(JSON.stringify(restored)).not.toMatch(/saved-key|apiKey|keyOrigin/)
  })
  it('starts on Nebius without invented credentials', () => {
    expect(loadSettings(memory()).selected).toBe('nebius')
    expect(() => resolveProvider(defaultSettings())).toThrow('Add your Nebius key')
    expect(defaultSettings().profiles.featherless).toMatchObject({ model: 'deepseek-ai/DeepSeek-V4-Flash-0731', compatibility: 'featherless' })
  })
  it('does not overwrite an older saved model or opt it into a new wire dialect', () => {
    const storage = memory(), old = defaultSettings()
    old.profiles.featherless.model = 'Qwen/Qwen3-32B'; delete old.profiles.featherless.compatibility
    const raw = JSON.stringify(old); storage.setItem(SETTINGS_KEY, raw)
    expect(loadSettings(storage)).toEqual(old)
    expect(storage.getItem(SETTINGS_KEY)).toBe(raw)
  })
  it('allows model discovery with an approved key before a model is chosen', () => {
    const settings = defaultSettings()
    settings.selected = 'featherless'
    settings.profiles.featherless = bindProfileKey({ ...settings.profiles.featherless, model: '', apiKey: 'discovery-key' })
    expect(resolveProviderAccess(settings)).toMatchObject({ apiKey: 'discovery-key', compatibility: 'featherless' })
    expect(() => resolveProvider(settings)).toThrow('Choose a model')
    settings.profiles.featherless.baseUrl = 'https://changed.example/v1'
    expect(() => resolveProviderAccess(settings)).toThrow('not been approved')
  })
  it('migrates a custom endpoint and preserves the legacy record', () => {
    const storage = memory()
    const old = JSON.stringify({ apiKey: 'private-test-value', baseUrl: 'https://other.example/v1/', model: 'my-model' })
    storage.setItem(LEGACY_SETTINGS_KEY, old)
    const settings = loadSettings(storage); saveSettings(settings, storage)
    expect(settings.selected).toBe('custom')
    expect(resolveProvider(settings)).toMatchObject({ baseUrl: 'https://other.example/v1', apiKey: 'private-test-value' })
    expect(storage.getItem(LEGACY_SETTINGS_KEY)).toBe(old)
    expect(loadSettings(storage)).toEqual(settings)
  })
  it('does not silently overwrite corrupt settings', () => {
    const storage = memory(); storage.setItem(SETTINGS_KEY, 'broken')
    expect(() => loadSettings(storage)).toThrow()
    expect(storage.getItem(SETTINGS_KEY)).toBe('broken')
  })
  it('separates keys and blocks a changed origin until deliberately rebound', () => {
    const settings = defaultSettings()
    settings.profiles.featherless = bindProfileKey({ ...settings.profiles.featherless, apiKey: 'feather-key' })
    settings.profiles.nebius = bindProfileKey({ ...settings.profiles.nebius, apiKey: 'nebius-key' })
    expect(resolveProvider(settings, 'nebius').apiKey).toBe('nebius-key')
    settings.profiles.featherless.baseUrl = 'https://attacker.example/v1'
    expect(() => resolveProvider(settings, 'featherless')).toThrow('not been approved')
    expect(() => saveSettings(settings, memory())).toThrow('Confirm')
  })
  it('allowlists public preferences and excludes Tavily/model keys and binding authority', () => {
    const settings = defaultSettings(); settings.tavily.apiKey = 'tavily-private'
    settings.profiles.featherless = bindProfileKey({ ...settings.profiles.featherless, apiKey: 'model-private' })
    const text = JSON.stringify(publicProviderPreferences(settings))
    expect(text).not.toMatch(/private|apiKey|keyOrigin|tavily/)
  })
  it('round trips an explicitly opted-in Alibaba custom profile without exporting key authority', () => {
    const storage = memory(), settings = defaultSettings()
    settings.selected = 'custom'
    settings.profiles.custom = bindProfileKey({ baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3.8-max', compatibility: 'alibaba', apiKey: 'private-alibaba-test', keyOrigin: '' })
    saveSettings(settings, storage)
    expect(resolveProvider(loadSettings(storage))).toMatchObject({ provider: 'custom', model: 'qwen3.8-max', compatibility: 'alibaba' })
    const preferences = preferencesSchema.parse(publicProviderPreferences(settings))
    expect(preferences.profiles.custom.compatibility).toBe('alibaba')
    expect(JSON.stringify(preferences)).not.toMatch(/private|apiKey|keyOrigin/)
    settings.profiles.custom.baseUrl = 'https://other.example/v1'
    expect(() => resolveProvider(settings)).toThrow('not been approved')
  })
  it('retains old v2 profiles unchanged and rejects unknown compatibility modes', () => {
    const storage = memory(), old = defaultSettings()
    saveSettings(old, storage)
    expect(loadSettings(storage)).toEqual(old)
    expect(preferencesSchema.parse(publicProviderPreferences(old)).profiles.custom).not.toHaveProperty('compatibility')
    const changed = JSON.parse(storage.getItem(SETTINGS_KEY)!)
    changed.profiles.custom.compatibility = 'accept-any-stream'
    storage.setItem(SETTINGS_KEY, JSON.stringify(changed))
    expect(() => loadSettings(storage)).toThrow()
    const invalidPublic = publicProviderPreferences(old)
    invalidPublic.profiles.custom = { ...invalidPublic.profiles.custom!, compatibility: 'accept-any-stream' as 'alibaba' }
    expect(() => preferencesSchema.parse(invalidPublic)).toThrow()
  })
})

describe('device-local speech preferences', () => {
  it('defaults to relaxed speech and round trips a voice choice without entering provider settings', () => {
    const storage = memory()
    expect(loadSpeechPreferences(storage)).toEqual({ voiceURI: '', rate: 0.7 })
    saveSpeechPreferences({ voiceURI: 'Microsoft Xiaoxiao', rate: 0.6 }, storage)
    expect(loadSpeechPreferences(storage)).toEqual({ voiceURI: 'Microsoft Xiaoxiao', rate: 0.6 })
    expect(storage.getItem(SETTINGS_KEY)).toBeNull()
    expect(storage.getItem(SPEECH_PREFERENCES_KEY)).toContain('Microsoft Xiaoxiao')
    expect(defaultSpeechPreferences()).toEqual({ voiceURI: '', rate: 0.7 })
  })
  it('rejects corrupt or unsafe speech settings without overwriting them', () => {
    const storage = memory(), raw = JSON.stringify({ voiceURI: 'voice', rate: 4 })
    storage.setItem(SPEECH_PREFERENCES_KEY, raw)
    expect(() => loadSpeechPreferences(storage)).toThrow()
    expect(storage.getItem(SPEECH_PREFERENCES_KEY)).toBe(raw)
  })
})
