<script lang="ts">
  import type { SavedDraft } from '../domain/workspace'
  let { drafts, busy, resumed, networkAllowed, onReview, onRegenerate, onDiscard, onUse }: {
    drafts: SavedDraft[]; busy: boolean; resumed: boolean; networkAllowed: boolean;
    onReview: (id: string) => void; onRegenerate: (id: string) => void; onDiscard: (id: string) => void; onUse: (id: string) => void;
  } = $props()
  let confirming = $state(''), count = $state(5)
</script>
{#if drafts.length}
  <section class="recovery" aria-label="Saved quiz work">
    <h3>Saved quiz work ({drafts.length})</h3>
    {#if !networkAllowed}<p class="small">Switch to live mode to review or regenerate a model candidate. Prerecorded mode does not substitute authored material for it.</p>{/if}
    {#each drafts.slice(0, count) as draft (draft.id)}
      <article aria-label={`Saved quiz ${draft.id}`}>
        <h4>{draft.status === 'validated' ? 'Reviewed quiz — ready to use' : draft.status === 'rejected' ? 'Inactive quiz — review not supported' : 'Unfinished quiz — content review needed'}</h4>
        <p class="small">{draft.cardIds.length} question{draft.cardIds.length === 1 ? '' : 's'} · {draft.sourceIds.length} frozen source{draft.sourceIds.length === 1 ? '' : 's'} · saved {new Date(draft.createdAt).toLocaleString()} · {draft.generation?.provider} / {draft.generation?.model}</p>
        {#if draft.sourceLessonId}<p class="small">Guided discovery practice; using this quiz cannot award independent recall credit.</p>{/if}
        {#if !draft.quizTargets}<p class="small">Legacy candidate: the saved question and sources are preserved; target preferences will be resolved from its current learning cards.</p>{/if}
        {#if draft.contentReview}<p class="small">Last content review: {draft.contentReview.verdict} · {draft.contentReview.provider} / {draft.contentReview.model}</p>{/if}
        {#if draft.replacesDraftId}<p class="small">Replacement version; the previous inactive candidate remains archived in your backup.</p>{/if}
        <div class="actions">
          {#if draft.status === 'validated'}<button type="button" disabled={busy || !resumed || Boolean(confirming)} onclick={() => onUse(draft.id)}>Use reviewed quiz</button>{:else}
            <button type="button" disabled={busy || !networkAllowed || Boolean(confirming)} onclick={() => onReview(draft.id)}>Review saved quiz</button>
            <button type="button" class="ghost" disabled={busy || !networkAllowed || Boolean(confirming)} onclick={() => onRegenerate(draft.id)}>Regenerate from saved sources</button>
            <button type="button" class="ghost" disabled={busy || Boolean(confirming)} onclick={() => { confirming = draft.id }}>Discard candidate</button>
          {/if}
        </div>
        {#if confirming === draft.id}<div class="confirm" role="region" aria-label="Confirm quiz discard"><p>Archive this unused candidate? Its questions, sources and provenance remain in backups, but it will no longer be offered. No learning progress changes.</p><div class="actions"><button type="button" disabled={busy} onclick={() => { confirming = ''; onDiscard(draft.id) }}>Confirm discard</button><button type="button" class="ghost" disabled={busy} onclick={() => { confirming = '' }}>Keep candidate</button></div></div>{/if}
      </article>
    {/each}
    {#if drafts.length > count}<button type="button" class="ghost" onclick={() => { count += 5 }}>Show five more saved quizzes</button>{/if}
    {#if !resumed}<p class="small">Start or resume the focused lesson to use a reviewed quiz. Current eligibility, scope and review limits still apply.</p>{/if}
  </section>
{/if}
<style>
  .recovery,article,.confirm { display: grid; gap: 10px; }article,.confirm { padding: 12px; border: 1px solid #3d485d; border-radius: 8px; }h3,h4,p { margin: 0; }p { line-height: 1.5; overflow-wrap: anywhere; }.small { color: #a9b2c4; font-size: 12px; }.actions { display: flex; flex-wrap: wrap; gap: 8px; }.confirm { background: #263044; border-color: #ba985c; }
</style>
