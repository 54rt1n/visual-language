<script lang="ts">
  import { skillLabels } from '../learning/conversationPractice'
  import { untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import PinyinText from './PinyinText.svelte'
  import ReadingNotes from './ReadingNotes.svelte'
  import LearningGrowth from './LearningGrowth.svelte'
  import DictionaryAttribution from './DictionaryAttribution.svelte'
  import { readingHistory } from '../mandarin/readingHistory'
  import { learningPreferencesForCard } from '../graph/graphService'
  import { LearningService } from '../learning/learningService'
  import { isDue } from '../learning/leitner'
  import { workspaceClock } from '../teacher/host'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  let { workspace, initialSection = 'cards', readingDraftId, onHistory, onPractice, onCapture, onReveal, onChanged, onClose }: { workspace: WorkspaceState; initialSection?: 'cards' | 'readings'; readingDraftId?: string; onHistory: (cardId: string) => void; onPractice: (cardId: string) => void; onCapture: () => void; onReveal: (nodeId: string) => void; onChanged: (snapshot: WorkspaceSnapshot) => void; onClose: () => void } = $props()
  let section = $state<'cards' | 'readings' | 'growth'>(untrack(() => initialSection))
  const readingCount = $derived(workspace.snapshot ? readingHistory(workspace.snapshot.state).length : 0)
  let query = $state(''), filter = $state<'all' | 'due' | 'new' | 'suspended'>('all'), error = $state(''), busy = $state(false)
  const clock = untrack(() => workspaceClock(workspace))
  const rows = $derived((workspace.snapshot?.state.cards ?? []).map(card => ({ card, item: workspace.snapshot!.state.items.find(item => item.id === card.itemId)! })).filter(({ card, item }) =>
    (filter === 'all' || (filter === 'due' ? isDue(card, clock.now()) : card.status === filter)) && `${item.canonicalText} ${item.pinyin ?? ''} ${item.meaning}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
  const boxes = $derived([1, 2, 3, 4, 5].map(box => ({ box, count: workspace.snapshot?.state.cards.filter(card => card.box === box && card.status === 'active').length ?? 0 })))
  async function toggle(cardId: string, suspended: boolean) {
    busy = true; error = ''
    try { const next = await workspace.apply((snapshot, repository) => new LearningService(repository, clock).setSuspended(snapshot, cardId, suspended)); onChanged(next) }
    catch (cause) { error = cause instanceof Error ? cause.message : 'The card was not changed.' }
    finally { busy = false }
  }
</script>
<Modal title="Library" onClose={() => { if (!busy) onClose() }}>
  <div class="library">
    <div class="sections" aria-label="Library section"><button type="button" class="ghost" aria-pressed={section === 'cards'} disabled={busy} onclick={() => { section = 'cards' }}>Study cards</button><button type="button" class="ghost" aria-label="Saved explanations" aria-pressed={section === 'readings'} disabled={busy} onclick={() => { section = 'readings' }}>Saved explanations <span>{readingCount}</span></button><button type="button" class="ghost" aria-pressed={section === 'growth'} disabled={busy} onclick={() => { section = 'growth' }}>Growth</button></div>
    {#if section === 'readings'}<ReadingNotes {workspace} initialDraftId={readingDraftId} {onReveal} />{:else if section === 'growth' && workspace.snapshot}<LearningGrowth document={workspace.snapshot.state} />{:else}
    <p>Your saved words and phrases, ready to practice. Each answer type has its own review schedule.</p>
    <div class="boxes" aria-label="Active Leitner box distribution">{#each boxes as box}<span>Box {box.box}<strong>{box.count}</strong></span>{/each}</div>
    <div class="filters"><label>Find in library<input type="search" bind:value={query} /></label><label>Card status<select bind:value={filter}><option value="all">All cards</option><option value="due">Due now</option><option value="new">Not introduced</option><option value="suspended">Suspended</option></select></label></div>
    <button type="button" class="ghost" onclick={onCapture} disabled={busy}>Save for practice</button>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !rows.length}<p>No matching cards. Save a phrase from the graph or add one here, then let Zheng introduce it.</p>{/if}
    {#each rows as { card, item } (card.id)}
      <article>
        <h3 lang="zh">{item.canonicalText} <span>{skillLabels[card.skill]}</span></h3><PinyinText text={item.pinyin} mode={learningPreferencesForCard(workspace.snapshot!.state, card.id).pinyinDisplay} /><p>{item.meaning}</p>
        <DictionaryAttribution citations={item.dictionarySources ?? []} meaning={item.meaning} />
        <p class="schedule">{card.status === 'new' ? 'New — not introduced yet' : card.status === 'suspended' ? 'Suspended' : `Box ${card.box} · ${isDue(card, clock.now()) ? 'Due now' : `Next review ${new Date(card.dueAt!).toLocaleString()}`}`}</p>
        {#if item.originalSrs && Object.keys(item.originalSrs).length}<details><summary>Original SRS metadata — not Leitner progress</summary><pre>{JSON.stringify(item.originalSrs, null, 2)}</pre></details>{/if}
        <div class="actions"><button type="button" onclick={() => onPractice(card.id)} disabled={busy || card.status === 'suspended'}>{card.status === 'new' ? 'Learn with Zheng' : isDue(card, clock.now()) ? 'Review this card' : 'Early practice'}</button>
          <button type="button" class="ghost" onclick={() => void toggle(card.id, card.status !== 'suspended')} disabled={busy}>{card.status === 'suspended' ? 'Resume card' : 'Suspend card'}</button>
          <button type="button" class="ghost" onclick={() => onHistory(card.id)} disabled={busy}>Review history</button>
          {#if item.sourceNodeIds[0] && workspace.snapshot?.state.nodes.some(n => n.id === item.sourceNodeIds[0])}<button type="button" class="ghost" disabled={busy} onclick={() => onReveal(item.sourceNodeIds[0]!)}>Show source</button>{:else if item.sourceNodeIds.length}<span class="schedule">Original graph source removed; saved meaning/history retained.</span>{/if}
        </div>
      </article>
    {/each}
    {/if}
  </div>
</Modal>
<style>
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }summary { cursor: pointer; font-size: 12px; }
  .sections { display: flex; gap: 8px; flex-wrap: wrap; }.sections button { flex: 1; min-height: 44px; font-size: 14px; }.sections button[aria-pressed=true] { background: #263750; border-color: #aacdff; }.sections span { margin-left: 4px; color: #b9d0f6; }
  .library { display: grid; gap: 14px; } p,h3 { margin: 0; } p { line-height: 1.5; }.boxes { display: flex; gap: 8px; }.boxes span { flex: 1; text-align: center; background: #222b3c; padding: 8px; border-radius: 8px; font-size: 12px; }.boxes strong { display: block; font-size: 20px; color: #a8caff; }
  .filters { display: flex; gap: 10px; }.filters label { flex: 1; display: grid; gap: 5px; font-size: 12px; } input,select { width: 100%; padding: 8px; background: #111722; color: inherit; border: 1px solid #3d485d; border-radius: 7px; }
  article { display: grid; gap: 7px; border: 1px solid #354154; padding: 14px; border-radius: 10px; }h3 span { font-size: 12px; color: #b9c5d9; font-weight: 400; }.schedule { font-size: 12px; color: #a9b2c4; }.actions { display: flex; gap: 7px; flex-wrap: wrap; }.error { color: #f4a3a3; }
</style>
