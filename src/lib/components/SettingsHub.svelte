<script lang="ts">
  import { untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import { LearningService } from '../learning/learningService'
  import { workspaceClock } from '../teacher/host'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  let { workspace, onChanged, portraits, onPortraits, onProviders, onAudio, onClose }: { workspace: WorkspaceState; onChanged: (snapshot: WorkspaceSnapshot) => void; portraits: boolean; onPortraits: () => Promise<void>; onProviders: () => void; onAudio: () => void; onClose: () => void } = $props()
  let busy = $state(false)
  const learner = $derived(workspace.snapshot!.state.learners.find(l => l.id === workspace.snapshot!.state.activeLearnerId)!)
  let pinyinError = $state('')
  const calendar = $derived(workspace.learningCalendar!)
  const clock = untrack(() => workspaceClock(workspace))
  function time(value: number) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}` }
  let cutoff = $state(untrack(() => time(calendar.pending?.startMinute ?? calendar.startMinute)))
  let error = $state(''), saved = $state(false)
  function localTime(at: number, zone: string) { return new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(at) }
  async function saveLearningDay() {
    if (busy) return
    busy = true; error = ''; saved = false
    try {
      if (!/^\d{2}:\d{2}$/.test(cutoff)) throw new Error('Choose a time for your learning day to begin.')
      const [hours, minutes] = cutoff.split(':').map(Number)
      if (hours! > 23 || minutes! > 59) throw new Error('Choose a valid time.')
      const next = await workspace.apply((s, r) => new LearningService(r, clock).setLearningDayStart(s, hours! * 60 + minutes!))
      onChanged(next); saved = true
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Your learning-day preference could not be saved.' }
    finally { busy = false }
  }
  async function toggle() { busy = true; try { await onPortraits() } finally { busy = false } }
  async function setPinyin(input: HTMLInputElement) {
    if (busy) return
    busy = true; pinyinError = ''
    const pinyinDisplay = input.checked ? 'always' : 'onDemand'
    try {
      const next = await workspace.mutate('pinyin-display-preference', { pinyinDisplay }, state => {
        state.learners.find(l => l.id === state.activeLearnerId)!.pinyinDisplay = pinyinDisplay
      })
      onChanged(next)
    } catch (cause) { pinyinError = cause instanceof Error ? cause.message : 'Your pinyin preference could not be saved.' }
    finally { input.checked = learner.pinyinDisplay === 'always'; busy = false }
  }
</script>

<Modal title="Settings" {onClose}>
  <div class="settings-hub">
    <button type="button" class="ghost setting" aria-label="AI connection" disabled={busy} onclick={onProviders}><strong>AI connection</strong><span>Choose your provider and model, and manage API keys.</span><span class="arrow" aria-hidden="true">→</span></button>
    <button type="button" class="ghost setting" aria-label="Audio & pinyin settings" disabled={busy} onclick={onAudio}><strong>Audio & pinyin</strong><span>Choose a voice, adjust speaking speed, and improve pinyin accuracy.</span><span class="arrow" aria-hidden="true">→</span></button>
    <section aria-label="Reading"><h3>Reading</h3><label><input type="checkbox" checked={learner.pinyinDisplay === 'always'} disabled={busy} onchange={event => void setPinyin(event.currentTarget)} /> Show pinyin by default</label><p>Show pronunciation alongside Chinese text. You can still show or hide it on individual responses.</p>{#if pinyinError}<p role="alert">{pinyinError}</p>{/if}</section>
    <section aria-label="Learning day"><h3>Learning day</h3>
      <form onsubmit={event => { event.preventDefault(); void saveLearningDay() }}>
        <label class="cutoff">Learning day starts at<input type="time" step="60" required bind:value={cutoff} disabled={busy} oninput={() => { saved = false }} /></label>
        <p>Time zone: {calendar.timeZone}. {#if calendar.pending && calendar.pending.timeZone !== calendar.timeZone}Next time zone: {calendar.pending.timeZone}. {/if}Activities before this time count toward the previous learning day.</p>
        <p aria-label="Current learning day">Current day: {localTime(calendar.anchor!.startAt, calendar.timeZone)} – {localTime(calendar.anchor!.endAt, calendar.timeZone)}</p>
        {#if calendar.pending}<p>Change applies after the current learning day ends: {localTime(calendar.pending.effectiveAt, calendar.timeZone)}.</p>{/if}
        <button type="submit" class="ghost" disabled={busy}>Save learning day</button>
        {#if error}<p role="alert">{error}</p>{:else if saved}<p role="status">Learning-day preference saved.</p>{/if}
      </form>
    </section>
    <section><h3>Appearance</h3><label><input type="checkbox" checked={portraits} disabled={busy} onchange={() => void toggle()} /> Show Zheng’s portrait</label><p>You can keep chatting and practicing with the portrait hidden.</p></section>
  </div>
</Modal>

<style>
  .settings-hub { display: grid; gap: 14px; }.setting { position: relative; display: grid; gap: 5px; padding: 16px 38px 16px 16px; text-align: left; }.setting strong { font-size: 16px; color: #e8eaed; }.setting span { font-size: 13px; font-weight: 400; line-height: 1.5; }.setting .arrow { position: absolute; top: 18px; right: 16px; }.setting:hover { background: #263750; }
  section { border-top: 1px solid #354154; padding-top: 18px; }h3 { margin: 0 0 12px; font-size: 15px; }label { display: flex; align-items: center; gap: 10px; min-height: 44px; }p { margin: 4px 0 0; font-size: 13px; color: #a9b2c4; }
  .cutoff { display: grid; gap: 7px; font-size: 14px; }input[type="time"] { min-height: 44px; width: 100%; box-sizing: border-box; padding: 8px 10px; color: inherit; background: #12141a; border: 1px solid #3a4352; border-radius: 8px; font: inherit; }form button { margin-top: 12px; min-height: 44px; }[role="alert"] { color: #ffc1c1; }
</style>
