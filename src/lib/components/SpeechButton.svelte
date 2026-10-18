<script lang="ts">
  import { getContext, onMount } from 'svelte'
  import { Play, Volume2, Square } from '@lucide/svelte'
  import { mandarinSpeechAvailability, speakMandarin, watchMandarinSpeech } from '../mandarin/tts'
  import { CANVAS_UI, type CanvasUI } from '../graph/uiContext'
  let { text, disabled = false, compact = false, transport = false, showStatus = true, playLabel = 'Play Mandarin audio', stopLabel = 'Stop audio', playing = $bindable(false) }: { text: string; disabled?: boolean; compact?: boolean; transport?: boolean; showStatus?: boolean; playLabel?: string; stopLabel?: string; playing?: boolean } = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
  let available = $state(false), reason = $state('Checking Mandarin voice availability…')
  let controller: AbortController | undefined
  function check() { const result = mandarinSpeechAvailability(); available = result.available; reason = result.reason }
  onMount(() => {
    const stop = watchMandarinSpeech(check)
    return () => { controller?.abort(); stop() }
  })
  async function play() {
    if (playing) { controller?.abort(); return }
    playing = true; reason = ''; controller = new AbortController()
    try { await speakMandarin(text, controller.signal) } catch (error) { if (!controller.signal.aborted) reason = error instanceof Error ? error.message : 'Playback unavailable.' }
    finally { playing = false }
  }
</script>
<div class="speech" class:compact><button type="button" class="ghost" aria-label={playing ? stopLabel : playLabel} title={reason || (playing ? stopLabel : playLabel)} disabled={disabled || !available} onclick={play}>{#if compact}{#if playing}<Square size={18} />{:else if transport}<Play size={20} />{:else}<Volume2 size={18} />{/if}{:else}{playing ? stopLabel : playLabel}{/if}</button>{#if reason && showStatus}{#if compact}<details class="audio-status"><summary>{reason.startsWith('Checking') ? 'Checking audio…' : available ? 'Audio problem' : 'Audio unavailable'}</summary><span role="status">{reason}</span>{#if ui}<button type="button" class="ghost setup-link" onclick={() => ui.languageSetup()}>Mandarin audio settings</button>{/if}</details>{:else}<span role="status">{reason}</span>{#if ui}<button type="button" class="ghost setup-link" onclick={() => ui.languageSetup()}>Mandarin audio settings</button>{/if}{/if}{:else if reason}<span class="visually-hidden" role="status">{reason}</span>{/if}</div>
<style>.speech { display: grid; justify-items: start; gap: 5px; }.speech span { color: #a9b2c4; font-size: 12px; }.compact { display: contents; }.compact button { flex: 0 0 44px; min-height: 44px; padding: 10px; display: grid; place-items: center; }.audio-status { flex-basis: 100%; order: 2; font-size: 12px; color: #b1bbcd; line-height: 1.4; }.audio-status summary { cursor: pointer; }.audio-status span { display: block; margin-top: 6px; }.setup-link { min-height: 44px; margin-top: 4px; font-size: 12px; }.visually-hidden { position: fixed; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }</style>
