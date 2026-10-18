<script lang="ts">
  import { readingModelState, readingModelBytes, downloadReadingModel, cancelReadingModelDownload, removeReadingModel } from '../mandarin/readingModel'
  const size = (readingModelBytes / 1_000_000).toFixed(1)
</script>

<section class="pinyin-accuracy" aria-labelledby="pinyin-accuracy-title">
  <h3 id="pinyin-accuracy-title">Pinyin accuracy</h3>
  <p>Basic pinyin is always available. An optional download can better choose pronunciations for characters such as 还, 得 and 地 from the surrounding sentence.</p>

  {#if $readingModelState.phase === 'checking'}
    <p role="status">Checking downloaded pinyin data…</p>
  {:else if $readingModelState.phase === 'downloading'}
    <progress value={$readingModelState.downloaded} max={readingModelBytes} aria-label="Pinyin accuracy download"></progress>
    <p role="status">{($readingModelState.downloaded / 1_000_000).toFixed(1)} / {size} MB downloaded</p>
    <button type="button" class="ghost" onclick={cancelReadingModelDownload}>Cancel download</button>
  {:else if $readingModelState.phase === 'ready'}
    <p class="ready" role="status">Context-aware pinyin is downloaded on this device.</p>
    <button type="button" class="ghost" onclick={removeReadingModel}>Remove pinyin accuracy data</button>
  {:else if $readingModelState.phase === 'unavailable'}
    <p role="status">The optional download is unavailable here. Basic pinyin still works.</p>
  {:else}
    {#if $readingModelState.error}<p role="status">The pinyin download could not be used. Basic pinyin still works.</p>{/if}
    <button type="button" class="ghost" onclick={downloadReadingModel}>{$readingModelState.phase === 'error' ? 'Retry pinyin accuracy download' : `Download context-aware pinyin · ${size} MB`}</button>
  {/if}

  <details>
    <summary>Accuracy, privacy and troubleshooting</summary>
    <p>The predictor runs locally and does not generate audio or send reading text to a provider. It was trained primarily for Taiwan Mandarin, so regional readings can differ and predictions can be wrong.</p>
    {#if $readingModelState.error}<p>{$readingModelState.error}</p>{/if}
  </details>
</section>

<style>
  .pinyin-accuracy { margin-top: 20px; padding-top: 16px; border-top: 1px solid #354154; }
  h3 { margin: 0 0 8px; font-size: 16px; }
  p { margin: 8px 0; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
  .ready { color: #b3e1cd; }
  button { min-height: 44px; white-space: normal; }
  progress { width: 100%; }
  details { margin-top: 12px; }
  summary { min-height: 36px; cursor: pointer; color: #c8dafe; }
</style>
