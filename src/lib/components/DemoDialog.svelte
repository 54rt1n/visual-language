<script lang="ts">
  import Modal from './Modal.svelte'
  import { DemoService, demoSummary } from '../demo/demoService'
  import { DEMO_NOW } from '../demo/material'
  import { downloadBackup, exportBackup } from '../storage/backup'
  import type { WorkspaceMode } from '../domain/workspaceMode'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  let { workspace, flushDraft, onChanged, onSwitch, onClose }: { workspace: WorkspaceState; flushDraft: () => Promise<void>; onChanged: (s: WorkspaceSnapshot) => void; onSwitch: (mode: WorkspaceMode) => Promise<void>; onClose: () => void } = $props()
  const demo = $derived(workspace.snapshot?.state.demo), summary = $derived(demo?.enabled ? demoSummary(workspace.snapshot!.state) : null)
  let busy = $state(false), error = $state(''), notice = $state(''), days = $state(1), confirmReset = $state(false)
  async function work(action: () => Promise<void>) {
    if (busy) return
    busy = true; error = ''; notice = ''
    try { await action() } catch (cause) { error = cause instanceof Error ? cause.message : 'Demo action did not complete. Existing data was retained.' }
    finally { busy = false }
  }
  async function change(action: (service: DemoService, snapshot: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>) {
    await flushDraft()
    onChanged(await workspace.apply((snapshot, repository) => action(new DemoService(repository), snapshot)))
  }
</script>
<Modal title="Demo & rehearsal" onClose={() => { if (!busy) onClose() }}>
  <div class="demo-dialog">
    <p>Explore sample conversations and practice with Zheng in a separate demo workspace. Your own learning progress stays safe.</p>
    {#if workspace.mode !== 'demo'}
      <p>Includes two topics, five practice cards, and a past mistake to revisit. You can return to the demo where you left off.</p>
      <p>Your current work is saved before switching. AI connection settings are shared. Inside the demo, choose prerecorded examples for a walkthrough without an API key.</p>
      <button type="button" disabled={busy} onclick={() => void work(() => onSwitch('demo'))}>Open demo workspace</button>
    {:else if demo?.enabled && summary}
      <section><h3>DEMO clock</h3><p class="clock">{new Date(demo.now).toISOString()} (UTC)</p><p>{summary.due} due now · {summary.newCards} new cards · active boxes {summary.boxes.map((count, i) => `${i + 1}: ${count}`).join(' / ')}</p>
        <p>Clock advancement changes only simulated “now”, not stored due dates, grades or answers. Whole days are exact 24-hour intervals. Rewind requires a confirmed demo reset or demo-backup restore.</p>
        <form onsubmit={event => { event.preventDefault(); void work(async () => { await change((service, s) => service.advance(s, days)); notice = `Advanced the isolated demo by ${days} day(s). No review was graded or replayed.` }) }}><label>Days to advance<input type="number" min="1" max="365" step="1" bind:value={days} disabled={busy || summary.clockBlocked} /></label><button type="submit" disabled={busy || summary.clockBlocked}>Advance demo clock</button></form>
        {#if summary.clockBlocked}<p>Finish, skip, or end the saved question before changing the clock or content mode. Its answer and review eligibility remain frozen.</p>{:else if summary.pendingQuestion}<p>Saved lesson practice can continue across demo days with its answers and mode unchanged. Finish it before switching content mode.</p>{/if}
      </section>
      <section><h3>Choose the rehearsal path</h3><p>Current path: {demo.contentMode === 'fixtures' ? 'prerecorded fixtures — no inference or web retrieval' : 'live provider calls — credentials and connectivity required'}.</p>
        <p>Live mode uses the configured provider and Tavily keys and can spend credits. Prerecorded mode uses fixed, authored material for the seeded items only; it is not live model grading, native tool generation, or Tavily evidence. Both use the real Leitner engine and save only demo progress.</p>
        <div class="actions"><button type="button" disabled={busy || summary.pendingQuestion || demo.contentMode === 'fixtures'} onclick={() => void work(async () => { await change((service, s) => service.setContentMode(s, 'fixtures')); notice = 'Prerecorded demo enabled. No provider or search request was made.' })}>Use prerecorded rehearsal</button><button type="button" class="ghost" disabled={busy || summary.pendingQuestion || demo.contentMode !== 'fixtures'} onclick={() => void work(async () => { await change((service, s) => service.setContentMode(s, 'live')); notice = 'Live demo enabled. Requests still require an explicit action and approved keys.' })}>Use live providers</button></div>
      </section>
      {#if !summary.pendingQuestion}<section><h3>Walkthrough</h3><ol><li>Open Daily review and choose a goal. Review the due recognition card correctly, then miss the typed production question to see a box-3 reset.</li><li>Use fresh corrective practice; an immediate correct answer must not promote the card. Inspect the saved session summary.</li><li>After the scoped due queue is clear, teach the new item and explicitly finish its introduction.</li><li>End the session, advance the demo by one day, and review again. Search for “coffee” to recover the prior mistake and its source.</li><li>Save an unfinished quiz, reload, and restore a downloaded demo backup in another profile opened in demo mode.</li></ol><p>For the release rehearsal, repeat in live mode with Nebius, Featherless and Tavily. Prerecorded success does not satisfy those live gates.</p></section>{/if}
      <section><h3>Save or reset the demo</h3><button type="button" class="ghost" disabled={busy} onclick={() => void work(async () => { await flushDraft(); downloadBackup(exportBackup(await workspace.flush())); notice = 'Demo backup download started. It includes quiz answers and private content, not provider keys.' })}>Download demo backup</button><p>A reset replaces only this demo with its original seed at {new Date(DEMO_NOW).toISOString()}; the previous demo becomes its local recovery checkpoint. Normal data is never the reset target.</p>
        <label class="check"><input type="checkbox" bind:checked={confirmReset} disabled={busy} /> Replace only the demo workspace, retaining one demo recovery checkpoint.</label>
        <button type="button" class="ghost" disabled={busy || !confirmReset} onclick={() => void work(async () => { await change((service, s) => service.reset(s)); confirmReset = false; notice = 'Demo reset. Its previous state is the demo recovery checkpoint. Normal learner data was untouched.' })}>Reset demo only</button>
      </section>
      <button type="button" disabled={busy} onclick={() => void work(() => onSwitch('normal'))}>Save & return to normal workspace</button>
    {/if}
    {#if busy}<p role="status">Saving locally…</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</Modal>
<style>
  .demo-dialog,section,form { display: grid; gap: 12px; }section { border-top: 1px solid #3a4052; padding-top: 16px; }h3,p { margin: 0; }h3,.clock { color: #f0d494; }p,li { line-height: 1.55; }li { margin-bottom: 9px; }ol { margin: 0; padding-left: 22px; }label { display: grid; gap: 7px; font-size: 13px; }input { width: 100%; padding: 8px; color: inherit; background: #111722; border: 1px solid #3d485d; border-radius: 7px; }.check { grid-template-columns: auto 1fr; align-items: start; }.check input { width: auto; }.actions { display: flex; flex-wrap: wrap; gap: 8px; }.error { color: #f4a3a3; }.clock { overflow-wrap: anywhere; }
</style>
