<script lang="ts">
  import Modal from './Modal.svelte'
  import { DemoService, demoSummary } from '../demo/demoService'
  import { DEMO_LESSON_ID } from '../demo/lessonMaterial'
  import { lessonActivity } from '../learning/lessonPolicy'
  import { downloadBackup, exportBackup } from '../storage/backup'
  import type { WorkspaceMode } from '../domain/workspaceMode'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  let { workspace, flushDraft, onChanged, onSwitch, onLesson, onLessons, onExplore, onClose }: {
    workspace: WorkspaceState; flushDraft: () => Promise<void>; onChanged: (s: WorkspaceSnapshot) => void;
    onSwitch: (mode: WorkspaceMode) => Promise<void>; onLesson: (id: string) => Promise<void>;
    onLessons: () => void; onExplore: () => void; onClose: () => void;
  } = $props()
  const demo = $derived(workspace.snapshot?.state.demo), summary = $derived(demo?.enabled ? demoSummary(workspace.snapshot!.state) : null)
  const sample = $derived(workspace.snapshot?.state.lessons.find(l => l.id === DEMO_LESSON_ID))
  const action = $derived(sample ? lessonActivity(workspace.snapshot!.state, sample, workspace.now()) : undefined)
  const sampleLabel = $derived(sample?.archivedAt !== undefined ? 'Restore sample lesson' : action?.label === 'Continue' ? 'Continue sample lesson'
    : action?.mode === 'review' ? 'Review sample lesson' : action?.mode === 'practice' ? 'Practice sample lesson' : 'Try sample lesson')
  const anotherQuestion = $derived(workspace.snapshot?.state.sessions.some(s => s.status !== 'completed' && s.activeExerciseId && s.lessonAttempt?.lessonId !== DEMO_LESSON_ID))
  let busy = $state(false), error = $state(''), notice = $state(''), days = $state(1), confirmReset = $state(false)
  async function work(action: () => Promise<void>) {
    if (busy) return
    busy = true; error = ''; notice = ''
    try { await action() } catch (cause) { error = cause instanceof Error ? cause.message : 'The demo could not continue. Try again.' }
    finally { busy = false }
  }
  async function change(action: (service: DemoService, snapshot: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>) {
    await flushDraft()
    onChanged(await workspace.apply((snapshot, repository) => action(new DemoService(repository), snapshot)))
  }
  async function startSample() {
    await work(async () => {
      if (demo?.contentMode !== 'fixtures') await change((service, s) => service.setContentMode(s, 'fixtures'))
      if (!sample) await change((service, s) => service.addSampleLesson(s))
      await onLesson(DEMO_LESSON_ID)
    })
  }
</script>
<Modal title="Demo" {onClose}>
  <div class="demo-dialog">
    {#if workspace.mode !== 'demo'}
      <p>Try a Mandarin lesson and quiz, explore sample conversations, and look up words as you read.</p>
      <p>No API key is needed. Your own lessons and progress stay separate.</p>
      <button type="button" disabled={busy} onclick={() => void work(() => onSwitch('demo'))}>Open demo workspace</button>
    {:else if demo?.enabled && summary}
      <section class="sample">
        <p class="eyebrow">Sample lesson · No API key needed</p>
        <h3>Order a cup of tea</h3>
        <p>Make a polite request and thank the person who helps you. Learn each expression, try a practice question, then take the quiz.</p>
        <button type="button" disabled={busy || anotherQuestion} onclick={() => void startSample()}>{sampleLabel}</button>
        {#if anotherQuestion}<p>Finish your current question before opening the sample lesson.</p>{/if}
        <div class="actions"><button type="button" class="ghost" disabled={busy} onclick={onLessons}>View lessons</button><button type="button" class="ghost" disabled={busy} onclick={onExplore}>Explore the conversation</button></div>
      </section>
      <p class="muted">Open Lessons to see your quiz result, lesson level, and next review.</p>
      <details>
        <summary>Demo options</summary>
        <section><h3>Content</h3><p>{demo.contentMode === 'fixtures' ? 'Sample content is active. No AI requests are made.' : 'Live AI is active and uses your connection in Settings.'}</p>
          <div class="actions"><button type="button" class="ghost" disabled={busy || summary.pendingQuestion || demo.contentMode === 'fixtures'} onclick={() => void work(async () => { await change((service, s) => service.setContentMode(s, 'fixtures')); notice = 'Sample content enabled.' })}>Use sample content</button><button type="button" class="ghost" disabled={busy || summary.pendingQuestion || demo.contentMode === 'live'} onclick={() => void work(async () => { await change((service, s) => service.setContentMode(s, 'live')); notice = 'Live AI enabled.' })}>Use live AI</button></div>
        </section>
        <section><h3>Try a later review</h3><p>Demo date: {new Date(demo.now).toLocaleDateString()}. Jump ahead to see scheduled reviews become due.</p>
          <form onsubmit={event => { event.preventDefault(); void work(async () => { await change((service, s) => service.advance(s, days)); notice = `Advanced the demo by ${days} day(s).` }) }}><label>Days to advance<input type="number" min="1" max="365" step="1" bind:value={days} disabled={busy || summary.clockBlocked} /></label><button type="submit" class="ghost" disabled={busy || summary.clockBlocked}>Advance demo clock</button></form>
          {#if summary.clockBlocked}<p>Finish the current question before changing the demo date.</p>{/if}
        </section>
        <section><h3>Save or start over</h3><button type="button" class="ghost" disabled={busy} onclick={() => void work(async () => { await flushDraft(); downloadBackup(exportBackup(await workspace.flush())); notice = 'Demo backup download started.' })}>Download demo backup</button>
          <label class="check"><input type="checkbox" bind:checked={confirmReset} disabled={busy} /> Reset only the demo workspace</label>
          <button type="button" class="ghost" disabled={busy || !confirmReset} onclick={() => void work(async () => { await change((service, s) => service.reset(s)); confirmReset = false; notice = 'Demo reset.' })}>Reset demo only</button>
        </section>
      </details>
      <button type="button" class="ghost" disabled={busy} onclick={() => void work(() => onSwitch('normal'))}>Save & return to normal workspace</button>
    {/if}
    {#if busy}<p role="status">Saving…</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</Modal>
<style>
  .demo-dialog,section,form { display: grid; gap: 12px; }section { border-top: 1px solid #3a4052; padding-top: 16px; }.sample { border: 0; padding: 0; }h3,p { margin: 0; }h3 { font-size: 20px; color: #dce9ff; }p { line-height: 1.55; font-size: 14px; }.eyebrow { color: #79d6bd; font-size: 12px; }.muted { color: #a9b2c4; font-size: 13px; }label { display: grid; gap: 7px; font-size: 13px; }input { width: 100%; padding: 8px; color: inherit; background: #111722; border: 1px solid #3d485d; border-radius: 7px; }.check { grid-template-columns: auto 1fr; align-items: start; }.check input { width: auto; }.actions { display: flex; flex-wrap: wrap; gap: 8px; }.error { color: #f4a3a3; }button,summary { min-height: 44px; }summary { padding: 10px 0; cursor: pointer; color: #b4c4df; font-size: 14px; }details { border-top: 1px solid #3a4052; }details h3 { font-size: 15px; }details section { margin: 12px 0 20px; }
</style>
