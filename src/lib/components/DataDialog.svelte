<script lang="ts">
  import { onMount } from 'svelte'
  import Modal from './Modal.svelte'
  import { counts, downloadBackup, exportBackup, previewBackup, type RestorePreview } from '../storage/backup'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import { previewOriginalImport } from '../storage/originalImport'
  import { assertWorkspaceMode } from '../domain/workspaceMode'

  let { workspace, flushDraft, onRestored, onClose }: {
    workspace: WorkspaceState; flushDraft: () => Promise<void>; onRestored: (snapshot: WorkspaceSnapshot) => void; onClose: () => void
  } = $props()
  let preview = $state.raw<RestorePreview | null>(null)
  let busy = $state(false), confirmReplace = $state(false), message = $state(''), error = $state('')
  let reviewCheckpoint = $state(false)
  let persistence = $state('Checking browser storage…'), usage = $state('')
  const recordCounts = $derived(workspace.snapshot ? counts(workspace.snapshot.state) : null)
  async function storageInfo() {
    if (!navigator.storage) { persistence = 'This browser does not expose storage protection controls.'; return }
    try {
      const persisted = await navigator.storage.persisted?.()
      persistence = persisted ? 'Persistent storage granted on this device.' : 'Best-effort browser storage. Keep downloaded backups.'
      const estimate = await navigator.storage.estimate?.()
      if (estimate?.usage !== undefined) usage = `${(estimate.usage / 1024 / 1024).toFixed(1)} MiB used${estimate.quota ? ` of approximately ${(estimate.quota / 1024 / 1024).toFixed(0)} MiB` : ''}.`
    } catch { persistence = 'Storage health information is unavailable in this browser.' }
  }
  onMount(() => { void storageInfo() })
  async function protect() {
    try {
      if (!navigator.storage?.persist) { persistence = 'This browser does not support requesting persistent storage.'; return }
      const granted = await navigator.storage.persist()
      await storageInfo()
      if (!granted) persistence = 'The browser did not grant protection. Your saved data is still present; download a backup.'
    } catch { persistence = 'Storage protection could not be requested. A downloaded backup is still available.' }
  }
  async function run(action: () => Promise<void>) {
    busy = true; error = ''; message = ''
    try { await action() } catch (cause) { error = cause instanceof Error ? cause.message : 'The operation failed. Existing data was retained.' }
    finally { busy = false }
  }
  async function download() {
    await run(async () => {
      await flushDraft()
      const current = await workspace.flush()
      downloadBackup(exportBackup(current))
      message = 'Backup download started. Check your browser’s downloads to confirm the file was saved.'
    })
  }
  async function downloadCommitted() {
    await run(async () => {
      if (!workspace.repository) throw new Error('The saved database is unavailable.')
      downloadBackup(exportBackup(await workspace.repository.snapshot()))
      message = 'Download of the last committed workspace started. Unsaved changes currently visible in this tab are not included; save a separate draft recovery copy if needed.'
    })
  }
  async function chooseFile(event: Event, original = false) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]
    preview = null; confirmReplace = false; reviewCheckpoint = false
    if (!file) return
    await run(async () => {
      await flushDraft()
      const current = await workspace.flush()
      const proposed = original ? await previewOriginalImport(file, current.version) : await previewBackup(file, current.version)
      assertWorkspaceMode(workspace.mode, proposed.backup.data)
      preview = proposed
    })
  }
  async function replace() {
    if (!preview || !confirmReplace) return
    const chosen = preview
    await run(async () => {
      // A changed revision after preview is rejected; no silent re-preview or merge.
      const restored = await workspace.apply((_current, repository) => repository.replace(chosen.expected, chosen.backup.data))
      onRestored(restored); preview = null; confirmReplace = false
      message = 'Workspace restored. A recovery checkpoint is available below. Local keys were not changed; review provider settings before using imported preferences.'
    })
  }
  async function rollback() {
    await run(async () => {
      await flushDraft()
      const restored = await workspace.apply((current, repository) => repository.rollback(current.version))
      onRestored(restored)
      reviewCheckpoint = false
      message = 'Recovery checkpoint restored. The workspace you replaced is now the checkpoint.'
    })
  }
</script>

<Modal title="Backup & restore" onClose={() => { if (!busy) onClose() }}>
  <div class="data-dialog">
    {#if workspace.mode === 'demo'}<p class="summary">DEMO DATABASE ONLY. Downloads, replacement and checkpoint recovery here affect only the isolated demo. Normal learning backups must be loaded after leaving demo mode.</p>{/if}
    <p>Your learning workspace stays in this browser. Changing domains, clearing browser data, or losing this device can remove access to it.</p>
    {#if recordCounts}<p class="summary">{recordCounts.topics} topics · {recordCounts.nodes} nodes · {recordCounts.cards} cards · {recordCounts.events} learning events · {recordCounts.pending} pending answers</p>{/if}
    <section aria-labelledby="backup-heading">
      <h3 id="backup-heading">Save a portable copy</h3>
      <p>Includes every topic, saved sources, card schedules, history, drafts, and quiz answers. API keys are excluded. The file contains private learning data and is not encrypted.</p>
      <button type="button" onclick={download} disabled={busy}>Download full backup</button>
      {#if workspace.status === 'error' || workspace.status === 'conflict'}<button class="ghost" type="button" onclick={downloadCommitted} disabled={busy}>Download last committed state</button>{/if}
    </section>
    <section aria-labelledby="restore-heading">
      <h3 id="restore-heading">Load a workspace</h3>
      <p>Load a Visual Language backup up to 25 MiB. You will see a preview before replacing anything. This is replacement, not merging.</p>
      <label class="file-label">Choose backup file <input type="file" accept=".json,application/json" onchange={chooseFile} disabled={busy} /></label>
      <details class="original-import"><summary>Import from the original project</summary>
        {#if workspace.mode === 'demo'}<p>Leave demo mode to import original learner content. Original-data conversion cannot put real records under a simulated clock.</p>{/if}
        <p>This is a separate content conversion for the owned original’s eight implemented node types. Use a JSON object with nodes, edges, and optional vocabulary arrays, not a Dexie export envelope. Unsupported relationships/types are rejected, not discarded.</p>
        <p>Messages and supported settings are retained. Old SRS values stay labeled as historical metadata; they never award Leitner credit. Entries without a meaning stay unassessed. Keep the original file as an archive.</p>
        <label class="file-label">Choose original project file <input type="file" accept=".json,application/json" onchange={event => chooseFile(event, true)} disabled={busy || workspace.mode === 'demo'} /></label>
      </details>
      {#if preview}
        <div class="preview">
          <h4>{preview.backup.data.name}</h4>
          {#if preview.kind === 'original'}<p>Original-project content conversion · no prior Leitner progress imported</p>{:else}<p>Exported {new Date(preview.backup.exportedAt).toLocaleString()} · app {preview.backup.appVersion} · revision {preview.backup.snapshotRevision}</p>{/if}
          <p>{preview.counts.topics} topics · {preview.counts.cards} cards · {preview.counts.attempts} attempts · {preview.counts.pending} pending answers</p>
          <ul>{#each preview.warnings as warning}<li>{warning}</li>{/each}</ul>
          <label class="confirmation"><input type="checkbox" bind:checked={confirmReplace} disabled={busy} /> Replace the current workspace, keeping one local recovery checkpoint.</label>
          <div class="actions"><button type="button" onclick={replace} disabled={busy || !confirmReplace}>Replace workspace</button><button type="button" class="ghost" disabled={busy} onclick={() => { preview = null; confirmReplace = false }}>Cancel import</button></div>
        </div>
      {/if}
      {#if workspace.snapshot?.hasCheckpoint}
        <button class="ghost" type="button" disabled={busy} onclick={() => { reviewCheckpoint = true; preview = null; confirmReplace = false }}>Restore recovery checkpoint</button>
        {#if reviewCheckpoint}
          <div class="preview">
            <h4>Confirm checkpoint recovery</h4>
            <p>This replaces the current workspace with the previous local dataset. The current dataset becomes the new checkpoint. Download a backup first if you want a separate permanent copy.</p>
            <div class="actions"><button type="button" onclick={rollback} disabled={busy}>Restore checkpoint now</button><button class="ghost" type="button" disabled={busy} onclick={() => { reviewCheckpoint = false }}>Cancel recovery</button></div>
          </div>
        {/if}
      {/if}
    </section>
    <section aria-labelledby="storage-heading">
      <h3 id="storage-heading">Protect local data</h3>
      <p>{persistence} {usage}</p>
      <p>Protection can reduce automatic eviction, but does not prevent browser-data deletion or replace a backup.</p>
      <button class="ghost" type="button" onclick={protect} disabled={busy}>Request storage protection</button>
    </section>
    {#if busy}<p role="status">Working locally…</p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</Modal>

<style>
  .data-dialog { display: grid; gap: 1rem; color: #c8cdd8; }
  p { margin: 0 0 .7rem; line-height: 1.5; }
  section { border-top: 1px solid #34394a; padding-top: 1rem; }
  h3, h4 { margin: 0 0 .65rem; color: #eef1f7; }
  .summary { color: #93bbf9; }
  .preview { margin-top: 1rem; background: #202535; padding: 1rem; border-radius: .6rem; }
  .confirmation, .file-label { display: grid; gap: .6rem; }
  .confirmation { grid-template-columns: auto 1fr; align-items: start; }
  .confirmation input { width: auto; }
  .actions { display: flex; gap: .5rem; margin-top: 1rem; }
  ul { padding-left: 1.3rem; }
  li { margin-bottom: .4rem; }
  .error { color: #f4a3a3; }
  .original-import { margin-top: 1rem; } summary { cursor: pointer; margin-bottom: .7rem; }
</style>
