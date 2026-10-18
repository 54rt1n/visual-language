<script lang="ts">
  import { untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import { GraphService } from '../graph/graphService'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  let { workspace, onChanged, onReveal, onClose }: { workspace: WorkspaceState; onChanged: (snapshot: WorkspaceSnapshot) => void; onReveal: (id: string) => void; onClose: () => void } = $props()
  const host = untrack(() => teacherHost(workspace, onChanged)), clock = untrack(() => workspaceClock(workspace))
  const document = $derived(workspace.snapshot!.state)
  const roots = $derived(document.nodes.filter(node => node.type === 'root'))
  const bookmarks = $derived(document.nodes.filter(node => node.bookmarked))
  let query = $state(''), topicName = $state(''), renameId = $state(''), renameText = $state(''), busy = $state(false), error = $state(''), notice = $state('')
  async function work(action: (service: GraphService, snapshot: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>) {
    busy = true; error = ''; notice = ''
    try { await host.apply((snapshot, repository) => action(new GraphService(repository, clock), snapshot)); return true }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Your topics could not be saved.'; return false }
    finally { busy = false }
  }
</script>

<Modal title="Topics" onClose={() => { if (!busy) onClose() }}>
  <div class="topics">
    <p>Keep a separate conversation for each subject you want to explore.</p>
    <label>Find a topic<input type="search" bind:value={query} placeholder="Search topic names" /></label>
    <div class="topic-list">
      {#each roots.filter(root => root.data.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) as root}
        <article aria-label={root.data.name}>
          {#if renameId === root.id}
            <form onsubmit={async event => { event.preventDefault(); if (await work((service, snapshot) => service.editText(snapshot, root.id, renameText))) { renameId = ''; notice = 'Topic renamed.' } }}>
              <label>Topic name<input bind:value={renameText} required maxlength="200" disabled={busy} /></label>
              <div class="actions"><button type="submit" disabled={busy || !renameText.trim()}>Save name</button><button type="button" class="ghost" disabled={busy} onclick={() => { renameId = '' }}>Cancel</button></div>
            </form>
          {:else}
            <div class="topic-heading"><h3>{root.data.name}</h3>{#if root.id === document.view.activeRootId}<span class="current">Current topic</span>{/if}</div>
            <div class="actions"><button type="button" disabled={busy} onclick={() => onReveal(root.id)}>Open topic</button><button type="button" class="ghost" disabled={busy} onclick={() => { renameId = root.id; renameText = root.data.name }}>Rename</button></div>
          {/if}
        </article>
      {:else}<p class="small">No topics match “{query}”.</p>{/each}
    </div>
    <form class="new-topic" onsubmit={async event => { event.preventDefault(); if (await work((service, snapshot) => service.createTopic(snapshot, topicName))) { topicName = ''; onReveal(host.current().state.view.activeRootId) } }}>
      <label>New topic name<input bind:value={topicName} maxlength="200" required disabled={busy} placeholder="For example, ordering food" /></label>
      <button type="submit" disabled={busy || !topicName.trim()}>Create topic</button>
    </form>
    {#if bookmarks.length}<details><summary>Bookmarks ({bookmarks.length})</summary><div class="bookmarks">{#each bookmarks as node}<button type="button" class="ghost" disabled={busy} onclick={() => onReveal(node.id)}>★ {node.type === 'root' ? node.data.name : 'text' in node.data ? node.data.text.slice(0, 80) : 'Saved activity'}</button>{/each}</div></details>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}{#if error}<p role="alert" class="error">{error}</p>{/if}
  </div>
</Modal>

<style>
  .topics,.topic-list,form { display: grid; gap: 14px; }p,h3 { margin: 0; }p { line-height: 1.5; }label { display: grid; gap: 6px; font-size: 13px; }input { width: 100%; min-width: 0; padding: 10px; background: #111722; color: inherit; border: 1px solid #3d485d; border-radius: 7px; font: inherit; }article { border: 1px solid #354154; padding: 14px; border-radius: 10px; }.topic-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }h3 { font-size: 16px; overflow-wrap: anywhere; }.current,.small { font-size: 12px; color: #a9b2c4; }.actions { display: flex; gap: 8px; flex-wrap: wrap; }button { min-height: 44px; }.new-topic { border-top: 1px solid #354154; padding-top: 16px; }.bookmarks { display: grid; gap: 8px; margin-top: 12px; }.bookmarks button { text-align: left; overflow-wrap: anywhere; }.error { color: #f4a3a3; }summary { cursor: pointer; }
</style>
