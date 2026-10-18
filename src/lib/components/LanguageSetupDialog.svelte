<script lang="ts">
  import { onMount } from 'svelte'
  import Modal from './Modal.svelte'
  import { detectLanguageDevice, operatingSystems, languageSetupGuides, type OperatingSystem } from '../mandarin/languageSetup'
  import { mandarinSpeechAvailability, selectMandarinVoice, watchMandarinSpeech, speakMandarin } from '../mandarin/tts'
  import { defaultSpeechPreferences, loadSpeechPreferences, saveSpeechPreferences, type SpeechPreferences } from '../settings'
  import PronunciationPack from './PronunciationPack.svelte'
  let { onClose }: { onClose: () => void } = $props()
  const device = detectLanguageDevice(navigator)
  let instructionsFor = $state<OperatingSystem>(device.os)
  const guide = $derived(languageSetupGuides[instructionsFor])
  let speech = $state.raw(mandarinSpeechAvailability()), checked = $state('')
  let preferenceError = $state('')
  function initialPreferences(): SpeechPreferences {
    try { return loadSpeechPreferences() } catch { preferenceError = 'Saved audio settings could not be read. They have not been overwritten.'; return defaultSpeechPreferences() }
  }
  let preferences = $state<SpeechPreferences>(initialPreferences())
  let playing = $state(false), playback = $state(''), failed = $state(false)
  let controller: AbortController | undefined
  const titles = { unsupported: 'Browser speech is unavailable', error: 'Voice check failed', empty: 'Waiting for browser voices', missing: 'Mandarin voice not found', offline: 'Mandarin voice needs a connection', ready: 'Mandarin voice available' }
  const selectedVoice = $derived(selectMandarinVoice(speech.voices, preferences.voiceURI))
  const preferredVoiceMissing = $derived(Boolean(preferences.voiceURI) && !speech.voices.some(voice => voice.voiceURI === preferences.voiceURI))
  function check() { speech = mandarinSpeechAvailability(); checked = new Date().toLocaleTimeString() }
  function saveAudioPreferences() {
    try { saveSpeechPreferences($state.snapshot(preferences)); preferenceError = ''; playback = 'Audio settings saved on this browser.'; failed = false }
    catch (error) { preferenceError = error instanceof Error ? error.message : 'Audio settings could not be saved.' }
  }
  onMount(() => { const stop = watchMandarinSpeech(check); return () => { stop(); controller?.abort() } })
  async function testAudio() {
    if (playing) { controller?.abort(); return }
    check(); if (!speech.available) return
    const request = new AbortController(); controller = request; playing = true; failed = false
    playback = 'Playing the sample…'
    try { await speakMandarin('你好，我们开始学习吧。', request.signal, $state.snapshot(preferences)); playback = 'The browser reported playback finished. If you heard nothing, check the tab mute, system volume and audio output.' }
    catch (error) { failed = !request.signal.aborted; playback = request.signal.aborted ? 'Sample stopped.' : error instanceof Error ? error.message : 'The sample could not play.' }
    finally { playing = false }
  }
</script>

<Modal title="Audio & pinyin settings" {onClose}>
  <p class="device">{device.browser} on {operatingSystems[device.os]}</p>
  <section class="voice-status" class:ready={speech.available} aria-label="Mandarin audio status">
    <h3 role="status">{titles[speech.status]}</h3>
    {#if speech.reason}<p>{speech.reason}</p>{/if}
    <p>{speech.reported.length} voices reported · {speech.matching.length} Mandarin · {speech.online ? 'Online' : 'Offline'}</p>
    {#if selectedVoice}<p>Playback voice: <strong>{selectedVoice.name}</strong> ({selectedVoice.lang}) · {selectedVoice.localService ? 'On device' : 'Online service'}</p>{/if}
    {#if preferredVoiceMissing}<p class="small">Your saved voice is unavailable right now, so playback will use the first available Mandarin voice.</p>{/if}
    {#if speech.status === 'empty'}<p>Voices can load after the page opens. We listen for updates; this does not prove that no voices are installed.</p>{/if}
    <p class="small">Last checked: {checked || 'checking…'}. Rechecks when you return to the app.</p>
  </section>

  <section class="audio-controls" aria-labelledby="audio-controls-title">
    <h3 id="audio-controls-title">Mandarin audio</h3>
    <label>Playback voice<select aria-label="Playback voice" value={selectedVoice?.voiceURI ?? ''} disabled={!speech.voices.length || playing} onchange={event => { preferences.voiceURI = event.currentTarget.value; saveAudioPreferences() }}>{#each speech.voices as voice}<option value={voice.voiceURI}>{voice.name} · {voice.lang} · {voice.localService ? 'On device' : 'Online'}</option>{/each}</select></label>
    <label>Speaking speed <strong>{preferences.rate.toFixed(2)}×</strong><input aria-label="Speaking speed" type="range" min="0.5" max="1.2" step="0.05" bind:value={preferences.rate} disabled={playing} onchange={saveAudioPreferences} /></label>
    <p class="small">Lower the speed for clearer practice. Voice engines interpret the same speed differently, so test the sample after changing either setting.</p>
    {#if preferenceError}<p class="error" role="alert">{preferenceError}</p>{/if}
  </section>

  <PronunciationPack />

  <section aria-labelledby="voice-instructions">
    <h3 id="voice-instructions">Set up a Mandarin voice</h3>
    <label>Instructions for<select bind:value={instructionsFor}>{#each Object.entries(operatingSystems) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
    <p class="small">Device detection is best-effort. Changing this menu only changes these instructions.</p>
    <ol>{#each guide.steps as step}<li>{step}</li>{/each}</ol>
    {#if instructionsFor === 'windows'}<p class="small">Install text-to-speech voices, not just a Chinese keyboard or display language. Cantonese is not used for Mandarin playback.</p>{/if}
    <a href={guide.source} target="_blank" rel="noopener noreferrer">{guide.sourceLabel}</a>
  </section>

  <details>
    <summary>Voices reported by this browser ({speech.reported.length})</summary>
    <p class="small">This is the browser’s list, not an inventory of installed system voices. On-device/online labels come from the browser; availability is not a guarantee of audible playback.</p>
    <ul class="voice-list">{#each speech.reported as voice}<li><strong>{voice.name}</strong> · {voice.lang} · {voice.localService ? 'On device' : 'Online service'}{speech.voices.includes(voice) ? ' · Mandarin available' : speech.matching.includes(voice) ? ' · Needs connection' : ' · Not selected for Mandarin'}</li>{/each}</ul>
  </details>
  <p class="small">Word reading and pinyin work without a speech voice. The optional contextual pinyin pack does not generate audio. Voice and speed are device-local browser settings; checking status sends no learning data and needs no API key.</p>

  {#snippet footer()}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Bounded playback feedback must be keyboard-scrollable on short screens.) -->
    <div class="sample-info" tabindex="0" role="region" aria-label="Audio sample and playback status">
      <p class="sample">Sample: <span lang="zh">你好，我们开始学习吧。</span></p>
      {#if selectedVoice && !selectedVoice.localService}<p class="small">Testing sends this sample to your browser’s online speech service.</p>{/if}
      {#if playback}<p class="playback" class:error={failed} role="status">{playback}</p>{/if}
    </div>
    <div class="actions"><button type="button" class="ghost" onclick={check}>Recheck voices</button><button type="button" disabled={!playing && !speech.available} onclick={() => void testAudio()}>{playing ? 'Stop test audio' : 'Test Mandarin audio'}</button></div>
  {/snippet}
</Modal>

<style>
  p { margin: 8px 0; line-height: 1.5; overflow-wrap: anywhere; font-size: 14px; }
  .device { margin-top: 0; color: #c8dafe; }
  h3 { margin: 0 0 8px; font-size: 16px; }
  .voice-status { padding: 12px; border: 1px solid #a88c55; border-radius: 10px; background: #25251f; margin-bottom: 20px; }
  .voice-status.ready { border-color: #53896e; background: #1e2b28; }
  .audio-controls { display: grid; gap: 10px; margin-bottom: 20px; }
  .audio-controls label { gap: 8px; }
  input[type='range'] { width: 100%; min-height: 32px; accent-color: #8ebcff; }
  .small { font-size: 12px; color: #b1bbcd; }
  label { display: grid; gap: 6px; font-size: 13px; }
  select { padding: 8px; font: inherit; font-size: 16px; color: inherit; background: #12141a; border: 1px solid #465773; border-radius: 8px; min-width: 0; }
  ol { padding-left: 22px; }li { margin: 8px 0; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
  a { color: #a9ceff; }details { margin-top: 20px; }summary { cursor: pointer; color: #c8dafe; min-height: 36px; }
  .voice-list { max-height: 180px; overflow: auto; padding-left: 20px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }button { min-height: 44px; flex: 1; }
  .sample-info { max-height: min(120px, 20dvh); overflow: auto; margin-bottom: 8px; }
  .sample { margin-top: 0; }.playback { font-size: 13px; }.error { color: #f4a3a3; }
</style>
