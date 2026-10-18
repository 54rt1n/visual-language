<script lang="ts">
  import { lookupDictionary, type DictionaryEntry, type DictionaryLookup } from '../mandarin/dictionary'
  import { dictionaryPinyin } from '../mandarin/dictionaryCapture'
  let { text, onChoose }: { text: string; onChoose?: (entry: DictionaryEntry, definition: string) => void } = $props()
  let lookupState = $state<{ text: string; result?: DictionaryLookup; error?: string }>(), retry = $state(0)
  const current = $derived(lookupState?.text === text ? lookupState : undefined)
  $effect(() => {
    const word = text; void retry
    let active = true
    lookupState = { text: word }
    void lookupDictionary(word).then(result => { if (active) lookupState = { text: word, result } })
      .catch(() => { if (active) lookupState = { text: word, error: 'Dictionary unavailable. Retry or use Explain in context.' } })
    return () => { active = false }
  })
  const sound = dictionaryPinyin
  const isNote = (sense: string) => /^(?:CL:|Taiwan pr\.|also pr\.)/.test(sense)
</script>

{#snippet entry(value: DictionaryEntry, related = false)}
  {@const senses = value.senses.filter(sense => !isNote(sense))}
  {@const notes = value.senses.filter(isNote)}
  <div class="dictionary-entry">
    <p class="dictionary-reading">{#if related}<span lang="zh">{value.simplified}</span> · {/if}<span lang="zh-Latn">{sound(value.pinyin)}</span></p>
    <ul>{#each senses.slice(0, 2) as sense}<li><span>{sense}</span>{#if onChoose && !related}<button type="button" class="ghost use-meaning" aria-label={`Use meaning ${sound(value.pinyin)}: ${sense}`} title="Choose this meaning for learning; review before saving" onclick={() => onChoose?.(value, sense)}>Use meaning…</button>{/if}</li>{/each}</ul>
    {#if senses.length > 2}<details><summary>More senses ({senses.length - 2})</summary><ul>{#each senses.slice(2) as sense}<li><span>{sense}</span>{#if onChoose && !related}<button type="button" class="ghost use-meaning" aria-label={`Use meaning ${sound(value.pinyin)}: ${sense}`} title="Choose this meaning for learning; review before saving" onclick={() => onChoose?.(value, sense)}>Use meaning…</button>{/if}</li>{/each}</ul></details>{/if}
    {#if notes.length}<details><summary>Dictionary notes</summary><ul>{#each notes as note}<li>{note.replace(/^CL:/, 'Measure words: ')}</li>{/each}</ul></details>{/if}
  </div>
{/snippet}

<section class="dictionary-meaning" aria-label="Dictionary meanings">
  <h5>Dictionary meanings <span>· English</span></h5>
  {#if current?.result}
    {#if current.result.entries.length}
      {#each current.result.entries.slice(0, 2) as value}{@render entry(value)}{/each}
      {#if current.result.entries.length > 2}<details><summary>More readings ({current.result.entries.length - 2})</summary>{#each current.result.entries.slice(2) as value}{@render entry(value)}{/each}</details>{/if}
      {#if current.result.related.length}<details><summary>Referenced words</summary>{#each current.result.related as value}{@render entry(value, true)}{/each}</details>{/if}
    {:else}<p class="dictionary-hint">No exact dictionary entry for this selection. Try a smaller span or ask Zheng about the phrase.</p>{/if}
  {:else if current?.error}
    <p class="dictionary-hint" role="status">{current.error}</p><button type="button" class="ghost" onclick={() => retry++}>Retry dictionary</button>
  {:else}<p class="dictionary-hint" role="status">Loading the local English dictionary…</p>{/if}
</section>

<style>
  .dictionary-meaning { margin: 10px 0; }
  h5 { margin: 0 0 6px; font-size: 14px; } h5 span { font-weight: 400; color: #b1bbcd; }
  .dictionary-entry { margin: 6px 0; }
  .dictionary-reading { margin: 0; color: #c8dafe; font-size: 13px; }
  ul { margin: 2px 0 4px; padding: 0; list-style: none; font-size: 17px; line-height: 1.5; }
  li { display: flex; align-items: center; gap: 8px; padding: 2px 0; } li span { flex: 1; min-width: 0; }
  .dictionary-hint { font-size: 12px; color: #b1bbcd; line-height: 1.5; margin: 8px 0; }
  summary { color: #c8dafe; cursor: pointer; min-height: 36px; }
  button { min-height: 44px; }
  .use-meaning { flex: 0 0 auto; padding: 5px; font-size: 11px; max-width: 88px; }
</style>
