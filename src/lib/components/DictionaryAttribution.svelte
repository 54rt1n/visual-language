<script lang="ts">
  import type { DictionaryCitation } from '../domain/dictionaryCitation'
  import { dictionaryPinyin } from '../mandarin/dictionaryCapture'
  let { citations, meaning }: { citations: DictionaryCitation[]; meaning: string } = $props()
</script>
{#if citations.length}
  <details class="dictionary-attribution nodrag nopan nowheel">
    <summary>Dictionary source</summary>
    {#each citations as citation}
      <div>
        <p>From <a href={citation.source} target="_blank" rel="noopener noreferrer">{citation.dictionary}</a></p>
        <p><span lang="zh">{citation.simplified}{citation.traditional !== citation.simplified ? ` / ${citation.traditional}` : ''}</span> · <span lang="zh-Latn">{dictionaryPinyin(citation.numberedPinyin)}</span></p>
        <p>Original dictionary wording: {citation.definition}</p>
        {#if meaning.trim() !== citation.definition.trim()}<p>Your wording differs from this dictionary definition.</p>{/if}
        <p>Snapshot: {citation.snapshotDate}. General dictionary meaning; not a verified sentence translation.</p>
      </div>
    {/each}
  </details>
{/if}
<style>
  .dictionary-attribution { color: #b1bbcd; font-size: 12px; overflow-wrap: anywhere; }
  summary { cursor: pointer; color: #c8dafe; min-height: 36px; padding-top: 8px; }
  p { margin: 6px 0; line-height: 1.5; } a { color: #c8dafe; } div + div { margin-top: 14px; }
</style>
