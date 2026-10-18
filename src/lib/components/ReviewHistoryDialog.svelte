<script lang="ts">
  import { untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import SourceList from './SourceList.svelte'
  import PinyinText from './PinyinText.svelte'
  import SpeechButton from './SpeechButton.svelte'
  import WorkedExampleView from './WorkedExampleView.svelte'
  import { feedbackMaterial } from '../teacher/feedback'
  import { TeacherService } from '../teacher/teacherService'
  import { RehearsalTeacher } from '../demo/rehearsalTeacher'
  import { teacherHost } from '../teacher/host'
  import type { Settings } from '../settings'
  import { onMount } from 'svelte'
  import { cardReviewHistory } from '../teacher/reviewHistory'
  import { correctionImpact } from '../learning/corrections'
  import { LearningService } from '../learning/learningService'
  import { review } from '../learning/leitner'
  import { learningPreferencesForCard } from '../graph/graphService'
  import { mandarinPinyin, containsHanzi } from '../mandarin/chineseParser'
  import { workspaceClock } from '../teacher/host'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot, WorkspaceVersion } from '../storage/repository'
  let { workspace, settings, cardId, onChanged, onPractice, onReveal, onClose }: { workspace: WorkspaceState; settings: Settings; cardId?: string; onChanged: (s: WorkspaceSnapshot) => void; onPractice: (id: string) => void; onReveal: (id: string) => void; onClose: () => void } = $props()
  const clock = untrack(() => workspaceClock(workspace))
  const host = untrack(() => teacherHost(workspace, onChanged)), prerecorded = untrack(() => workspace.mode === 'demo' && workspace.snapshot?.state.demo?.contentMode === 'fixtures')
  const teacher = prerecorded ? new RehearsalTeacher(host, clock) : new TeacherService(host, () => settings, { clock })
  let controller = $state<AbortController | undefined>()
  let task: Promise<void> | undefined
  onMount(() => () => controller?.abort())
  $effect(() => { if (workspace.status === 'conflict') controller?.abort() })
  const document = $derived(workspace.snapshot!.state)
  const cards = $derived(document.cards.filter(c => c.learnerId === document.activeLearnerId))
  let selectedId = $state(untrack(() => cardId ?? cards[0]?.id ?? ''))
  const card = $derived(cards.find(c => c.id === selectedId)), item = $derived(document.items.find(i => i.id === card?.itemId))
  const history = $derived(cardReviewHistory(document, selectedId))
  const preferences = $derived(learningPreferencesForCard(document, selectedId))
  let count = $state(10), busy = $state(false), error = $state(''), notice = $state('')
  let pending = $state<{ eventId: string; outcome: 'recalled' | 'notRecalled'; historical: boolean; box: number; dueAt: number; at: number; version: WorkspaceVersion } | null>(null)
  function preview(eventId: string, outcome: 'recalled' | 'notRecalled') {
    error = ''; notice = ''
    try {
      const impact = correctionImpact(document, eventId)
      if (impact.blocked) throw new Error('Finish or skip the pending question for this card before correcting its schedule.')
      if (outcome === 'recalled' && !impact.canRecall) throw new Error('A helped answer cannot become independent recall.')
      const after = impact.historical ? impact.card : review(impact.original.before, outcome, impact.original.occurredAt, true)
      pending = { eventId, outcome, historical: impact.historical, box: after.box, dueAt: after.dueAt!, at: impact.original.occurredAt, version: { ...workspace.snapshot!.version } }
    } catch (cause) { error = cause instanceof Error ? cause.message : 'This result could not be previewed.' }
  }
  async function confirm() {
    if (!pending || busy) return
    const value = pending; busy = true; error = ''
    try {
      const result = await workspace.apply((snapshot, repository) => {
        if (JSON.stringify(snapshot.version) !== JSON.stringify(value.version)) throw new Error('Saved history changed after preview. Cancel and preview this correction again.')
        return new LearningService(repository, clock).correctReview(snapshot, value.eventId, value.outcome)
      })
      onChanged(result); pending = null
      notice = value.historical ? 'Historical dispute saved. Later progress and the current schedule are unchanged.' : 'Correction saved from the original review state and time. The original assessment is retained.'
    } catch (cause) { error = cause instanceof Error ? cause.message : 'The correction could not be saved.' }
    finally { busy = false }
  }
  function explain(attemptId: string) {
    if (busy) return
    busy = true; error = ''; notice = ''; controller = new AbortController()
    const signal = controller.signal
    task = (async () => {
      try { await teacher.explainAttempt(attemptId, signal); notice = 'Worked example saved separately. Original answers, grades and schedules are unchanged.' }
      catch (cause) { error = signal.aborted ? 'Example request cancelled. No automatic retry; saved results are unchanged.' : cause instanceof Error ? cause.message : 'The example could not be prepared.' }
      finally { busy = false; controller = undefined; task = undefined }
    })()
  }
  async function close() { if (task) { controller?.abort(); await task } if (!busy) onClose() }
</script>
<Modal title="Saved review history" onClose={() => void close()}>
  <div class="history">
    <p>Inspect original answers, feedback and effective review results. Viewing history does not grade an answer. Corrections are explicit learner judgments, not new model assessments.</p>
    <label>Learning skill<select bind:value={selectedId} disabled={busy || Boolean(pending)} onchange={() => { count = 10; error = ''; notice = '' }}>{#each cards as option}<option value={option.id}>{document.items.find(i => i.id === option.itemId)!.canonicalText} · {option.skill}</option>{/each}</select></label>
    {#if card && item}<section class="current"><h3 lang="zh">{item.canonicalText} · {card.skill}</h3><PinyinText text={item.pinyin} mode={preferences.pinyinDisplay} /><p>{item.meaning}</p><p class="small">Current card: {card.status}{card.dueAt ? ` · box ${card.box} · due ${new Date(card.dueAt).toLocaleString()}` : ' · unintroduced, no due date'}</p><button type="button" class="ghost" disabled={busy || Boolean(pending) || card.status !== 'active'} onclick={() => onPractice(card.id)}>Open this skill with Zheng</button></section>{/if}
    {#if pending}<section class="confirmation" aria-label="Confirm grade correction"><h3>{pending.historical ? 'Flag historical dispute' : 'Confirm schedule correction'}</h3><p>{pending.historical ? 'A later card transition exists. This flags the original record for review; it does not rewrite the later chain or change the schedule.' : `Replace the effective result with ${pending.outcome === 'recalled' ? 'independent recall' : 'not recalled'}: box ${pending.box}, next due ${new Date(pending.dueAt).toLocaleString()}, calculated from the original review at ${new Date(pending.at).toLocaleString()}. The original event remains saved.`}</p><div class="actions"><button type="button" disabled={busy} onclick={() => void confirm()}>{pending.historical ? 'Save historical dispute' : 'Confirm correction'}</button><button type="button" class="ghost" disabled={busy} onclick={() => { pending = null }}>Cancel correction</button></div></section>{/if}
    {#if error}<p role="alert" class="error">{error}</p>{/if}{#if notice}<p role="status" class="notice">{notice}</p>{/if}
    {#if !history.length}<p>No saved questions for this skill yet. Introduction and suspension records are not recall assessments.</p>{/if}
    {#each history.slice(0, count) as row (row.exercise.id)}
      <article aria-label={`Review from ${new Date(row.exercise.presentedAt).toISOString()}`}>
        <h3>{row.event ? 'Due review' : row.exercise.mode === 'dueReview' ? 'Unresolved or skipped review' : 'Practice — no schedule change'}</h3><p class="small">{new Date(row.exercise.presentedAt).toLocaleString()} · {row.exercise.provider} / {row.exercise.model}</p><p>{row.exercise.prompt}</p>
        {#each row.attempts as attempt}{@const worked = feedbackMaterial(document, row.exercise, attempt)}<div class="attempt"><h4>Original saved answer</h4><p>{attempt.answer}</p><p class="small">{attempt.status} · {attempt.assessmentSource ?? 'not yet assessed'}{attempt.gradingModel ? ` · ${attempt.gradingProvider} / ${attempt.gradingModel}` : ''}</p>
          {#if attempt.assessment}<p>Original assessment: {attempt.assessment.grade}. {attempt.assessment.feedback}</p><details><summary>Criterion evidence</summary>{#each attempt.assessment.criteria as criterion}<p>{row.exercise.rubric.find(r => r.id === criterion.criterionId)?.description}: {criterion.met === null ? 'unresolved' : criterion.met ? 'met' : 'not met'}. {criterion.evidence}</p>{/each}</details>{/if}
          {#if attempt.gradingError}<p>{attempt.gradingError}</p>{/if}
          {#if worked}<WorkedExampleView material={worked} pinyinDisplay={preferences.pinyinDisplay} /><SourceList sources={document.sources.filter(s => worked.sourceIds.includes(s.id))} onReveal={id => { if (!busy && !pending) onReveal(id) }} />{:else if attempt.status === 'committed'}<p class="small">No paired example was saved in this older result. A new example uses up to two model calls without search; it cannot change the grade. Prerecorded mode uses authored seed material only.</p><button type="button" class="ghost" disabled={busy || Boolean(pending)} onclick={() => explain(attempt.id)}>Prepare worked example for this result</button>{/if}
        </div>
        {/each}
        {#if row.aids.length}<p class="small">Help recorded: {row.aids.join(', ')}. A helped answer cannot become independent recall.</p>{/if}
        {#if row.event && row.original}<p class="effective">Effective scheduling result: {row.event.outcome === 'recalled' ? 'recalled' : 'not recalled'} · box {row.original.before.box} → {row.event.after.box} · due {new Date(row.event.after.dueAt!).toLocaleString()}{row.event.kind === 'correction' ? ' · learner-corrected' : ''}</p>
          {#if row.disputed}<p class="notice">Historical dispute flagged; no later schedule was rewritten.</p>{/if}
          {#if row.corrections.length}<details><summary>Preserved correction chain ({row.corrections.length})</summary>{#each row.corrections as correction}<p class="small">Learner correction to {correction.outcome === 'recalled' ? 'recalled' : 'not recalled'} · card revision {correction.after.revision} · retains original review time {new Date(correction.occurredAt).toLocaleString()}</p>{/each}</details>{/if}
          <div class="actions">{#if row.latest}<button type="button" class="ghost" disabled={busy || Boolean(pending) || Boolean(row.original.aid)} onclick={() => preview(row.event!.id, 'recalled')}>Preview correction: recalled</button><button type="button" class="ghost" disabled={busy || Boolean(pending)} onclick={() => preview(row.event!.id, 'notRecalled')}>Preview correction: not recalled</button>{:else}<button type="button" class="ghost" disabled={busy || Boolean(pending) || row.disputed} onclick={() => preview(row.event!.id, row.event!.outcome === 'recalled' ? 'recalled' : 'notRecalled')}>Flag historical result for review</button>{/if}</div>
        {/if}
        <details><summary>Saved answer key and sources</summary><p>{row.exercise.expectedAnswer}</p>{#if containsHanzi(row.exercise.expectedAnswer)}<PinyinText text={mandarinPinyin(row.exercise.expectedAnswer)} mode={preferences.pinyinDisplay} /><SpeechButton text={row.exercise.expectedAnswer} />{/if}<p class="small">Learning item meaning: {item?.meaning}</p><SourceList sources={document.sources.filter(s => row.exercise.sourceIds.includes(s.id))} onReveal={id => { if (!busy && !pending) onReveal(id) }} /></details>
      </article>
    {/each}
    {#if history.length > count}<button type="button" class="ghost" onclick={() => { count += 10 }}>Show 10 more questions ({history.length - count} remaining)</button>{/if}
    {#if controller}<p role="status">Preparing saved teaching material…</p><button type="button" class="ghost" onclick={() => controller?.abort()}>Cancel example request</button>{/if}
  </div>
</Modal>
<style>
  .history,article,.current,.confirmation,.attempt { display: grid; gap: 12px; }p,h3,h4 { margin: 0; }p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }h3 { font-size: 16px; }h4 { font-size: 14px; }
  label { display: grid; gap: 6px; }select { width: 100%; padding: 9px; background: #111722; color: inherit; border: 1px solid #3d485d; border-radius: 7px; }.current,article,.confirmation { padding: 14px; border: 1px solid #3d485d; border-radius: 9px; }.confirmation { border-color: #ba985c; background: #263044; }.small { color: #a9b2c4; font-size: 12px; }.effective { color: #c4d7f5; font-size: 13px; }.notice { color: #e8c985; font-size: 13px; }.error { color: #f4a3a3; }.actions { display: flex; flex-wrap: wrap; gap: 8px; }summary { cursor: pointer; color: #b9d0f6; }details p { margin-top: 10px; }
</style>
