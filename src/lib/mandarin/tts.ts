import { defaultSpeechPreferences, loadSpeechPreferences, type SpeechPreferences } from '../settings'

export type SpeechAvailability = {
  available: boolean; supported: boolean; online: boolean; status: 'unsupported' | 'error' | 'empty' | 'missing' | 'offline' | 'ready'
  reason: string; voices: SpeechSynthesisVoice[]; reported: SpeechSynthesisVoice[]; matching: SpeechSynthesisVoice[]
}
export function inspectMandarinVoices(reported: SpeechSynthesisVoice[], online: boolean, supported = true): SpeechAvailability {
  const matching = supported ? reported.filter(voice => /^(?:zh$|zh-(?:CN|TW|SG|Hans|Hant)(?:-|$)|cmn(?:-|$))/i.test(voice.lang.replace(/_/g, '-')) && !/cantonese|yue/i.test(voice.name)) : []
  const voices = matching
    .filter(voice => online || voice.localService)
    .sort((a, b) => Number(b.localService) - Number(a.localService) || Number(b.lang === 'zh-CN') - Number(a.lang === 'zh-CN'))
  const status = !supported ? 'unsupported' : !reported.length ? 'empty' : !matching.length ? 'missing' : !voices.length ? 'offline' : 'ready'
  const reasons = { unsupported: 'Speech playback is unavailable in this browser.', empty: 'This browser has not reported any speech voices yet.', missing: 'No suitable Mandarin voice is available in this browser.', offline: 'Only online Mandarin voices are available. Reconnect or install an on-device voice.', ready: '' }
  return { available: voices.length > 0, supported, online, status, reason: reasons[status], voices, reported, matching }
}
export function mandarinSpeechAvailability(): SpeechAvailability {
  const online = typeof navigator !== 'undefined' && navigator.onLine
  if (typeof window === 'undefined' || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return inspectMandarinVoices([], online, false)
  try { return inspectMandarinVoices(window.speechSynthesis.getVoices(), online) }
  catch { return { ...inspectMandarinVoices([], online), status: 'error', reason: 'This browser could not report its speech voices. Recheck or restart the browser.' } }
}
export function selectMandarinVoice(voices: SpeechSynthesisVoice[], voiceURI: string): SpeechSynthesisVoice | undefined {
  return voices.find(voice => voice.voiceURI === voiceURI) ?? voices[0]
}
function currentSpeechPreferences(): SpeechPreferences {
  try { return loadSpeechPreferences() } catch { return defaultSpeechPreferences() }
}
let interruptActiveSpeech: (() => void) | undefined
/** Shared by the setup modal and audio buttons, including a return from OS settings. */
export function watchMandarinSpeech(update: () => void): () => void {
  const synthesis = window.speechSynthesis
  const visible = () => { if (document.visibilityState === 'visible') update() }
  synthesis?.addEventListener('voiceschanged', update)
  for (const event of ['focus', 'online', 'offline']) window.addEventListener(event, update)
  document.addEventListener('visibilitychange', visible)
  update()
  return () => {
    synthesis?.removeEventListener('voiceschanged', update)
    for (const event of ['focus', 'online', 'offline']) window.removeEventListener(event, update)
    document.removeEventListener('visibilitychange', visible)
  }
}
/** Adapted from the original TTS helper; lack of a suitable voice is explicit, never silent. */
export async function speakMandarin(text: string, signal?: AbortSignal, preferences = currentSpeechPreferences()): Promise<void> {
  if (!text.trim() || text.length > 1000) throw new Error('Choose a Mandarin phrase of 1–1,000 characters for playback.')
  signal?.throwIfAborted()
  const available = mandarinSpeechAvailability()
  if (!available.available) throw new Error(available.reason)
  const synthesis = window.speechSynthesis
  // Starting a new reading is an intentional handoff, not a playback failure.
  // Resolve the old owner before cancelling its utterance so its UI resets cleanly.
  interruptActiveSpeech?.()
  synthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.voice = selectMandarinVoice(available.voices, preferences.voiceURI)!
  utterance.lang = utterance.voice.lang; utterance.rate = preferences.rate; utterance.pitch = 1
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); utterance.onend = null; utterance.onerror = null; if (interruptActiveSpeech === interrupt) interruptActiveSpeech = undefined }
    const finish = (complete: () => void) => { if (settled) return; settled = true; cleanup(); complete() }
    const interrupt = () => { finish(resolve); synthesis.cancel() }
    const abort = () => { finish(() => reject(signal?.reason ?? new DOMException('Playback stopped.', 'AbortError'))); synthesis.cancel() }
    const timeout = setTimeout(() => { finish(() => reject(new Error('Speech playback timed out. Try again.'))); synthesis.cancel() }, 90_000)
    interruptActiveSpeech = interrupt
    signal?.addEventListener('abort', abort, { once: true })
    utterance.onend = () => finish(resolve)
    utterance.onerror = () => finish(() => reject(new Error('Speech playback was unavailable or interrupted. Try again.')))
    try { synthesis.speak(utterance) }
    catch (error) { finish(() => reject(error)) }
  })
}
