<script lang="ts">
  import { onMount } from 'svelte'
  import MandarinReader from './MandarinReader.svelte'
  import SpeechButton from './SpeechButton.svelte'
  import type { OriginalWordSegment } from '../domain/original'
  let { nodeId, text, originalWordSegments, passage = false, onClose }: { nodeId: string; text: string; originalWordSegments?: OriginalWordSegment[]; passage?: boolean; onClose: () => void } = $props()
  let element: HTMLElement, closeButton: HTMLButtonElement
  let nativePopover = true
  let playing = $state(false)
  onMount(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    nativePopover = typeof element.showPopover === 'function'
    if (nativePopover) element.showPopover()
    else element.removeAttribute('popover')
    closeButton.focus({ preventScroll: true })
    return () => {
      // A library/capture handoff owns focus once its native modal opens.
      if (!document.querySelector('dialog[open]') && previous?.isConnected) previous.focus({ preventScroll: true })
    }
  })
</script>

<svelte:window onkeydown={event => {
  if (!nativePopover && event.key === 'Escape' && !event.defaultPrevented && element?.contains(document.activeElement) && !element.querySelector('.word-details')) {
    event.preventDefault(); onClose()
  }
}} />

<section class="response-reader nodrag nopan nowheel" popover="auto" aria-label={passage ? 'Passage reader' : 'Response reader'} bind:this={element} ontoggle={event => { if (event.newState === 'closed') onClose() }}>
  <header><div><h2>{passage ? 'Read this passage' : 'Read this response'}</h2><p>{playing ? 'Click a word for its meaning. Playback will continue.' : 'Click a word to hear it and see its meaning.'}</p></div><div class="header-actions"><SpeechButton {text} bind:playing compact transport showStatus={false} playLabel={passage ? 'Play full passage' : 'Play full response'} stopLabel={passage ? 'Stop full passage' : 'Stop full response'} /><button type="button" class="ghost close" aria-label={passage ? 'Close passage reader' : 'Close response reader'} onclick={onClose} bind:this={closeButton}>✕</button></div></header>
  <div class="reader-body"><MandarinReader {nodeId} {text} {originalWordSegments} focused autoPlayWords={!playing} /></div>
</section>

<style>
  .response-reader { position: fixed; inset: 16px 16px auto auto; width: min(720px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: 0; padding: 0; border: 1px solid #526a8d; border-radius: 14px; background: #101b2c; color: #e8eaed; box-shadow: 0 16px 64px #0009; z-index: 45; overflow: auto; overscroll-behavior: contain; font-size: 14px; }
  header { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between; align-items: start; gap: 12px; padding: 14px 18px; background: #101b2c; border-bottom: 1px solid #526a8d66; }
  h2 { font-size: 20px; margin: 0; } header p { color: #b1bbcd; margin: 4px 0 0; font-size: 12px; }
  .header-actions { display: flex; align-items: start; gap: 4px; }
  .header-actions :global(button) { min-width: 44px; min-height: 44px; }
  .close { flex: 0 0 44px; }
  .reader-body { padding: 10px 18px 18px; }
  @media (max-width: 520px) { .response-reader { inset: 8px 8px auto; width: calc(100vw - 16px); max-height: calc(100dvh - 16px); } header, .reader-body { padding-left: 12px; padding-right: 12px; } }
</style>
