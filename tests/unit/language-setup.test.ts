import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectLanguageDevice, languageSetupGuides, operatingSystems } from '../../src/lib/mandarin/languageSetup'
import { inspectMandarinVoices, mandarinSpeechAvailability, selectMandarinVoice, speakMandarin, watchMandarinSpeech } from '../../src/lib/mandarin/tts'

const voice = (name: string, lang: string, localService = true): SpeechSynthesisVoice => ({ name, lang, localService, default: false, voiceURI: name })

describe('best-effort device labels for language setup', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36', 'windows', 'Chrome / Chromium'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0', 'windows', 'Microsoft Edge'],
    ['Mozilla/5.0 (Windows NT 10.0) Firefox/140.0', 'windows', 'Firefox'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1', 'macos', 'Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/140.0 Mobile Safari/604.1', 'ios', 'Chrome / Chromium'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) FxiOS/140.0 Mobile Safari/604.1', 'ios', 'Firefox'],
    ['Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Safari/537.36', 'android', 'Chrome / Chromium'],
    ['Mozilla/5.0 (X11; CrOS x86_64) Chrome/140.0 Safari/537.36', 'chromeos', 'Chrome / Chromium'],
    ['Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0', 'linux', 'Firefox'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 OPR/120.0', 'windows', 'Opera'],
    ['unrecognized browser', 'unknown', 'Unknown browser'],
  ])('detects %s without inferring speech support', (userAgent, os, browser) => {
    expect(detectLanguageDevice({ userAgent })).toEqual({ os, browser })
  })
  it('recognizes iPad desktop mode and low-entropy client hints', () => {
    expect(detectLanguageDevice({ userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1', platform: 'MacIntel', maxTouchPoints: 5 }).os).toBe('ios')
    expect(detectLanguageDevice({ userAgent: '', userAgentData: { platform: 'Windows', brands: [{ brand: 'Microsoft Edge' }] } })).toEqual({ os: 'windows', browser: 'Microsoft Edge' })
  })
  it('provides local instructions and explicit HTTPS sources for every supported label', () => {
    expect(Object.keys(languageSetupGuides).sort()).toEqual(Object.keys(operatingSystems).sort())
    for (const guide of Object.values(languageSetupGuides)) {
      expect(guide.steps).toHaveLength(3); expect(new URL(guide.source).protocol).toBe('https:')
    }
  })
})

describe('browser speech lifecycle', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
  function fixture() {
    const synthesis = Object.assign(new EventTarget(), { getVoices: () => [voice('Huihui', 'zh-CN')], speak: vi.fn(), cancel: vi.fn() })
    class Utterance { text: string; constructor(text: string) { this.text = text } }
    const window = Object.assign(new EventTarget(), { speechSynthesis: synthesis, SpeechSynthesisUtterance: Utterance })
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    vi.stubGlobal('window', window); vi.stubGlobal('document', document)
    vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
    return { synthesis, window, document }
  }
  it('rechecks on voice, connection and return events and releases every listener', () => {
    const { synthesis, window, document } = fixture(), update = vi.fn()
    const stop = watchMandarinSpeech(update); expect(update).toHaveBeenCalledTimes(1)
    synthesis.dispatchEvent(new Event('voiceschanged'))
    for (const event of ['focus', 'online', 'offline']) window.dispatchEvent(new Event(event))
    document.dispatchEvent(new Event('visibilitychange')); expect(update).toHaveBeenCalledTimes(6)
    document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); expect(update).toHaveBeenCalledTimes(6)
    stop(); document.visibilityState = 'visible'
    synthesis.dispatchEvent(new Event('voiceschanged'))
    for (const event of ['focus', 'online', 'offline']) window.dispatchEvent(new Event(event))
    document.dispatchEvent(new Event('visibilitychange')); expect(update).toHaveBeenCalledTimes(6)
  })
  it('surfaces a failed browser voice query as status rather than throwing', () => {
    const { synthesis } = fixture()
    synthesis.getVoices = () => { throw new Error('service failed') }
    expect(mandarinSpeechAvailability()).toMatchObject({ status: 'error', available: false })
  })
  it('releases timeout and abort handlers when speak throws synchronously', async () => {
    vi.useFakeTimers()
    const { synthesis } = fixture(), controller = new AbortController()
    synthesis.speak.mockImplementation(() => { throw new Error('speech service refused') })
    await expect(speakMandarin('你好', controller.signal)).rejects.toThrow('speech service refused')
    expect(vi.getTimerCount()).toBe(0)
    controller.abort(); expect(synthesis.cancel).toHaveBeenCalledTimes(1)
  })
  it('uses the selected browser voice and learner-controlled rate', async () => {
    const { synthesis } = fixture(), preferred = voice('Xiaoxiao', 'zh-CN')
    synthesis.getVoices = () => [voice('Huihui', 'zh-CN'), preferred]
    synthesis.speak.mockImplementation(utterance => { utterance.onend?.call(utterance, new Event('end') as SpeechSynthesisEvent) })
    await speakMandarin('你好', undefined, { voiceURI: preferred.voiceURI, rate: 0.55 })
    const utterance = synthesis.speak.mock.calls[0]![0] as SpeechSynthesisUtterance
    expect(utterance.voice).toBe(preferred); expect(utterance.rate).toBe(0.55)
    expect(selectMandarinVoice(synthesis.getVoices(), 'missing')?.name).toBe('Huihui')
  })
})

describe('Mandarin voice status', () => {
  const english = voice('English', 'en-US'), cantonese = voice('Cantonese', 'zh-HK'), local = voice('Huihui', 'zh-CN'), remote = voice('Online Mandarin', 'cmn-CN', false)
  it('distinguishes absent API, an empty list and missing Mandarin', () => {
    expect(inspectMandarinVoices([], true, false)).toMatchObject({ status: 'unsupported', available: false, supported: false })
    expect(inspectMandarinVoices([], true)).toMatchObject({ status: 'empty', available: false, supported: true })
    expect(inspectMandarinVoices([english, cantonese], true)).toMatchObject({ status: 'missing', available: false, matching: [] })
  })
  it('recognizes common tags and excludes Cantonese without substituting English', () => {
    const voices = ['zh', 'zh-CN', 'zh-TW', 'zh-SG', 'zh-Hans-CN', 'zh-Hant-TW', 'cmn', 'cmn-CN', 'zh_CN'].map(lang => voice(lang, lang))
    const result = inspectMandarinVoices([...voices, voice('Cantonese', 'zh-CN'), voice('Yue', 'zh'), english, cantonese, voice('善怡', 'zh-HK'), voice('zh-HK', 'zh_HK'), voice('粵語', 'yue-HK')], true)
    expect(result.voices).toHaveLength(voices.length); expect(result.available).toBe(true)
  })
  it('retains online-only voice diagnostics while offline and prefers a local voice', () => {
    expect(inspectMandarinVoices([remote], false)).toMatchObject({ status: 'offline', available: false, voices: [], matching: [remote] })
    expect(inspectMandarinVoices([remote], true).status).toBe('ready')
    const original = [remote, english, local], before = [...original]
    expect(inspectMandarinVoices(original, true).voices).toEqual([local, remote])
    expect(inspectMandarinVoices(original, false).voices).toEqual([local]); expect(original).toEqual(before)
  })
})
