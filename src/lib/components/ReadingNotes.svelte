<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import { readingConcealed, readingHistory, readingSourceStatus, searchReadingHistory } from '../mandarin/readingHistory'
  import { pronunciationFor, pronunciationOverlay } from '../mandarin/pronunciation'
  import SpeechButton from './SpeechButton.svelte'

  let { workspace, initialDraftId, onReveal }: { workspace: WorkspaceState; initialDraftId?: string; onReveal: (id: string) => void } = $props()
  let query = $state(''), count = $state(20), selectedId = $state(untrack(() => initialDraftId ?? ''))
  let heading = $state<HTMLHeadingElement>(), search = $state<HTMLInputElement>()
  let source = $state<Awaited<ReturnType<typeof readingSourceStatus>>>()
  const document = $derived(workspace.snapshot!.state)
  const concealed = $derived(readingConcealed(document))
  const groups = $derived(readingHistory(document)), results = $derived(searchReadingHistory(groups, query))
  const group = $derived(groups.find(value => value.versions.some(draft => draft.id === selectedId)))
  const draft = $derived(group?.versions.find(value => value.id === selectedId)), note = $derived(draft?.reading)
  const pronunciation = $derived(note && draft ? pronunciationFor(note.text, note.start, note.pinyin, pronunciationOverlay([draft])) : undefined)

  $effect(() => { void query; count = 20 })
  $effect(() => {
    source = undefined
    let current = true
    if (draft) void readingSourceStatus(document, draft).then(value => { if (current) source = value }).catch(() => {})
    return () => { current = false }
  })
  async function focusHeading() { await tick(); heading?.focus({ preventScroll: true }); heading?.scrollIntoView({ block: 'nearest' }) }
  async function open(id: string) { selectedId = id; await focusHeading() }
  async function back() { selectedId = ''; await tick(); search?.focus({ preventScroll: true }); search?.scrollIntoView({ block: 'nearest' }) }
  onMount(() => { if (selectedId) void focusHeading() })
</script>

<div class="reading-notes">
  {#if concealed}
    <p>Finish the recall question or explicitly reveal learning material before opening saved explanations.</p>
  {:else if note && draft && group}
    <button type="button" class="ghost back" onclick={() => void back()}>Back to saved explanations</button>
    <section aria-label="Saved word explanation" class="saved-explanation">
      <h3 lang="zh" tabindex="-1" bind:this={heading}>{note.text}</h3>
      <p class="pinyin" lang="zh-Latn">{pronunciation?.pinyin || 'Pronunciation unavailable'}</p>
      <p class="small">{pronunciation?.source === 'model' ? 'Saved AI contextual pinyin' : 'Saved automatic pinyin'} · {note.level} · {note.explanationLanguage}</p>
      {#if draft.id !== group.latest.id}<p class="notice">Earlier version. A newer explanation is saved for this occurrence.</p>{/if}
      {#if note.uncertain}<p class="notice">Zheng marked this explanation as uncertain. Check it before relying on it.</p>{/if}
      <p class="meaning">{note.meaning}</p>
      <p>{note.explanation}</p>
      {#if note.pronunciation}<p>{note.pronunciation.note}</p>{/if}
      <div class="frozen-sentence">
        <h4>Sentence when this was saved</h4>
        <p lang="zh">{note.context.slice(0, note.start - note.contextStart)}<mark>{note.text}</mark>{note.context.slice(note.end - note.contextStart)}</p>
        <p>{note.sentenceMeaning}</p>
      </div>
      <details><summary>Pronunciation & audio</summary><p class="small">Pinyin is a saved suggestion, not certified pronunciation. Audio uses your browser's voice and may differ.</p>{#key draft.id}<SpeechButton text={note.text} />{/key}</details>
      <p class="small">Saved AI explanation · {draft.generation?.model} · {new Date(draft.createdAt).toLocaleString()}. Reading this does not change review progress.</p>
      {#if group.versions.length > 1}<label>Saved version<select value={selectedId} onchange={event => void open(event.currentTarget.value)}>{#each group.versions as version, index (version.id)}<option value={version.id}>{index === 0 ? 'Latest' : `Earlier ${group.versions.length - index}`} · {new Date(version.createdAt).toLocaleString()}</option>{/each}</select></label>{/if}
      <div class="source-status">
        {#if source?.kind === 'missing'}<p class="small">Original response removed. This frozen sentence and its explanations are still saved.</p>
        {:else if source}
          <p class="small">{source.kind === 'changed' ? 'The response has changed. This explanation belongs to the saved sentence above, not its current text.' : 'The source response still matches this saved occurrence.'} · {source.topic}</p>
          <button type="button" class="ghost" onclick={() => onReveal(source!.nodeId!)}>{source.kind === 'changed' ? 'Show changed response' : 'Show source response'}</button>
        {:else}<p class="small" role="status">Checking the saved source…</p>{/if}
      </div>
    </section>
  {:else}
    <p>Your saved word explanations, without enrolling words or making another model request.</p>
    <label>Find saved explanations<input type="search" bind:this={search} bind:value={query} maxlength="300" placeholder="Hanzi, pinyin, meaning or sentence…" /></label>
    <p class="small">Search includes earlier versions and ignores tone marks. Results are for this learner across all topics, levels and explanation languages.</p>
    {#if !groups.length}<p>No saved explanations yet. Select a word in a Mandarin reply and choose Explain in context.</p>
    {:else if !results.length}<p>No matching saved explanations. Try another word, pinyin or meaning.</p>
    {:else}<p role="status" class="small">{results.length} saved {results.length === 1 ? 'occurrence' : 'occurrences'}</p>{/if}
    {#each results.slice(0, count) as result (result.id)}
      <article>
        <h3 lang="zh">{result.match.reading.text}</h3>
        <p>{result.match.reading.meaning}</p>
        <p class="small">{result.match.reading.level} · {result.match.reading.explanationLanguage}{result.match.reading.uncertain ? ' · uncertain' : ''}{result.match.id !== result.latest.id ? ' · match in an earlier version' : ''}</p>
        <button type="button" class="ghost" onclick={() => void open(result.match.id)}>Read explanation</button>
      </article>
    {/each}
    {#if results.length > count}<button type="button" class="ghost" onclick={() => { count += 20 }}>Show more explanations ({results.length - count} remaining)</button>{/if}
  {/if}
</div>

<style>
  .reading-notes,.saved-explanation,article,.source-status,.frozen-sentence { display: grid; gap: 10px; }
  p,h3,h4 { margin: 0; }p { line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }h3 { font-size: 22px; font-weight: 500; }h4 { font-size: 13px; color: #b7c8e1; }
  .pinyin { color: #b9d0f6; }.meaning { font-size: 19px; }.small { font-size: 12px; color: #afbed3; }.notice { color: #ecd29c; font-size: 13px; }
  .frozen-sentence { border-left: 2px solid #6f8bae; padding: 10px 12px; background: #111b2c; border-radius: 4px; }
  mark { background: #665329; color: #fff2c2; }label { display: grid; gap: 6px; font-size: 13px; }input,select { width: 100%; min-width: 0; font-size: 16px; padding: 10px; border: 1px solid #3d485d; border-radius: 7px; background: #111722; color: inherit; }
  button { min-height: 44px; }.back { justify-self: start; }article { padding: 14px; border: 1px solid #354154; border-radius: 9px; }article button { justify-self: start; }summary { cursor: pointer; min-height: 36px; color: #b9d0f6; }details p { margin-bottom: 10px; }.source-status { padding-top: 10px; border-top: 1px solid #354154; }
</style>
