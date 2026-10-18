<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import SourceList from './SourceList.svelte'
  import { highlightParts, searchLearningHistory, type SearchFilters } from '../search/searchService'
  import { extractSources, searchWeb, type SearchCache } from '../search/tavily'
  import { resolveTavilyKey, type Settings } from '../settings'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import { nid } from '../id'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import type { SourceSnapshot } from '../domain/workspace'

  let { workspace, settings, onReveal, onPractice, onChanged, onClose }: { workspace: WorkspaceState; settings: Settings; onReveal: (nodeId: string) => void; onPractice: (cardId: string) => void; onChanged: (snapshot: WorkspaceSnapshot) => void; onClose: () => void } = $props()
  const host = untrack(() => teacherHost(workspace, onChanged)), clock = untrack(() => workspaceClock(workspace))
  const prerecorded = $derived(workspace.mode === 'demo' && workspace.snapshot?.state.demo?.contentMode === 'fixtures')
  let tab = $state<'local' | 'web'>('local'), query = $state(''), rootId = $state(''), kind = $state<SearchFilters['kind']>('all'), due = $state<SearchFilters['due']>('all'), selectedIndex = $state(0)
  let current = $state(false), refresh = $state(false), busy = $state(false), error = $state(''), notice = $state(''), selectedSources = $state<string[]>([])
  let webSources = $state.raw<SourceSnapshot[]>([]), cached: SearchCache | undefined, controller: AbortController | undefined
  const results = $derived(workspace.snapshot ? searchLearningHistory(workspace.snapshot.state, query, { rootId: rootId || undefined, kind, due }, clock.now()) : [])
  onMount(() => () => controller?.abort())
  $effect(() => { if (workspace.status === 'conflict') controller?.abort() })
  $effect(() => { query; rootId; kind; due; selectedIndex = 0 })
  function navigate(delta: number) {
    selectedIndex = Math.max(0, Math.min(results.length - 1, selectedIndex + delta))
    const target = document.getElementById(`search-result-${results[selectedIndex]?.id}`)
    target?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    target?.focus({ preventScroll: true })
  }
  async function retain(sources: SourceSnapshot[]) {
    await host.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind: 'save-search-sources', at: clock.now(), intent: sources.map(s => s.id) }, state => {
      for (const source of sources) if (!state.sources.some(s => s.id === source.id)) state.sources.push(source)
    }))
  }
  async function retrieve(extract = false) {
    if (prerecorded) { error = 'Switch the demo to live providers for Tavily retrieval. Prerecorded mode makes no search request.'; return }
    busy = true; error = ''; notice = ''; controller = new AbortController()
    try {
      // Public retrieval timestamps/cache age use wall time, never the demo clock.
      const options = { apiKey: resolveTavilyKey(settings), signal: controller.signal }
      if (extract) {
        const result = await extractSources(selectedSources, webSources, options)
        controller.signal.throwIfAborted()
        await retain(result.sources)
        webSources = [...result.sources, ...webSources]; selectedSources = []
        notice = result.failedIds.length ? 'Some extractions failed. Their saved snippets remain available.' : 'Selected excerpts were saved as new source versions.'
      } else {
        const result = await searchWeb({ query, purpose: 'User-requested Mandarin learning search', current }, options, cached, refresh)
        controller.signal.throwIfAborted()
        await retain(result.sources)
        cached = result; webSources = result.sources; selectedSources = []
        notice = result.sources.length ? 'Sources saved with retrieval dates. Search alone does not change learning progress.' : 'No usable results. Try a more specific public phrase, or use saved learning history.'
      }
    } catch (cause) { error = controller.signal.aborted ? 'Search cancelled. Saved sources are unchanged.' : cause instanceof Error ? cause.message : 'Search failed. Your learning progress was not changed.' }
    finally { busy = false }
  }
</script>
<Modal title="Search" onClose={() => { controller?.abort(); onClose() }}>
  <div class="search-dialog">
    {#if prerecorded}<p class="small">Prerecorded DEMO: saved-history search is available. Switch to live providers in Demo & rehearsal for actual Tavily retrieval.</p>{/if}
    <div class="tabs" aria-label="Search location"><button type="button" class:active={tab === 'local'} class="ghost" onclick={() => { tab = 'local' }}>Saved learning</button><button type="button" class:active={tab === 'web'} class="ghost" onclick={() => { tab = 'web' }}>Search the web</button></div>
    <label>Search query<input type="search" bind:value={query} maxlength="300" placeholder={tab === 'local' ? 'Hanzi, pinyin, meaning, or a past mistake…' : 'A public Mandarin phrase or topic…'} onkeydown={event => { if (event.key === 'Enter' && tab === 'web' && !busy && query.trim()) { event.preventDefault(); void retrieve() } }} /></label>
    {#if tab === 'local'}
      <div class="filters"><label>Topic<select bind:value={rootId}><option value="">All topics</option>{#each workspace.snapshot!.state.nodes.filter(n => n.type === 'root') as root}<option value={root.id}>{root.data.name}</option>{/each}</select></label><label>Type<select bind:value={kind}><option value="all">All types</option><option value="conversation">Conversation / chunks</option><option value="lesson">Discovery lessons</option><option value="item">Learning cards</option><option value="feedback">Feedback / attempts</option><option value="source">Saved sources</option></select></label><label>Due state<select bind:value={due}><option value="all">All</option><option value="due">Due now</option><option value="new">New</option><option value="suspended">Suspended</option></select></label></div>
      <details><summary>Search tips</summary><p class="small">Search by Hanzi, pinyin, meaning, or a past mistake. Pinyin searches work with or without tone marks.</p></details>
      {#if !query.trim()}<p>Find words, conversations, and past feedback across all topics.</p>{:else if !results.length}<p>No matching saved material.</p>{:else}
        <div class="navigation"><button type="button" class="ghost" disabled={selectedIndex === 0} onclick={() => navigate(-1)}>Previous result</button><span role="status">{selectedIndex + 1} / {results.length}</span><button type="button" class="ghost" disabled={selectedIndex >= results.length - 1} onclick={() => navigate(1)}>Next result</button></div>
        {#each results as result, index (result.id)}<article id={`search-result-${result.id}`} tabindex="-1" aria-label={result.title} class:chosen={index === selectedIndex}><h3>{#each highlightParts(result.title, query) as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</h3><p>{#each highlightParts(result.snippet, query) as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p><p class="small">{result.kind}{result.skill ? ` · ${result.skill}` : ''}{result.box ? ` · box ${result.box}` : ''}{result.dueAt ? ` · due ${new Date(result.dueAt).toLocaleString()}` : ''}</p><div class="actions">{#if result.nodeId && !result.missingSource}<button type="button" class="ghost" onclick={() => onReveal(result.nodeId!)}>Reveal source on graph</button>{:else if result.missingSource}<span class="small">Original graph node removed; saved excerpt/history retained.</span>{/if}{#if result.cardId}<button type="button" onclick={() => onPractice(result.cardId!)}>Practice this</button>{/if}</div></article>{/each}
      {/if}
    {:else}
      <p class="small">Only this query is sent to Tavily with your own key. Do not include private answers or personal details. Results are evidence to review, not instructions for the teacher.</p>
      <div class="options"><label class="check"><input type="checkbox" bind:checked={current} disabled={busy} /> Current/news sources (15-minute cache)</label><label class="check"><input type="checkbox" bind:checked={refresh} disabled={busy} /> Refresh instead of using cached results</label></div>
      <button type="button" disabled={busy || prerecorded || !query.trim()} onclick={() => void retrieve()}>{busy ? 'Retrieving…' : 'Search the web'}</button>
      {#each webSources as source (source.id)}<div class="source-result"><label class="check"><input type="checkbox" bind:group={selectedSources} value={source.id} disabled={busy || (selectedSources.length >= 2 && !selectedSources.includes(source.id))} /> Select for fuller extraction</label><SourceList sources={[source]} /></div>{/each}
      {#if webSources.length}<button type="button" class="ghost" disabled={busy || !selectedSources.length} onclick={() => void retrieve(true)}>Extract selected sources (up to two)</button>{/if}
    {/if}
    {#if notice}<p role="status">{notice}</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</Modal>
<style>
  .search-dialog { display: grid; gap: 14px; }p,h3 { margin: 0; }p { line-height: 1.5; white-space: pre-wrap; }h3 { font-size: 15px; }.tabs,.filters,.navigation,.actions { display: flex; gap: 8px; flex-wrap: wrap; }.navigation { align-items: center; }.tabs .active { background: #263750; border-color: #aacdff; }label { display: grid; gap: 5px; font-size: 12px; }.filters label { flex: 1; }input,select { padding: 9px; border: 1px solid #3d485d; border-radius: 7px; background: #111722; color: inherit; min-width: 0; }.check { grid-template-columns: auto 1fr; align-items: center; }.check input { width: auto; }article { display: grid; gap: 8px; padding: 12px; border: 1px solid #354154; border-radius: 8px; }article.chosen { border-color: #91b6f6; }.small { font-size: 12px; color: #a9b2c4; }mark { background: #665329; color: #fff2c2; }.error { color: #f4a3a3; }.source-result { display: grid; gap: 8px; }.options { display: grid; gap: 8px; }
</style>
