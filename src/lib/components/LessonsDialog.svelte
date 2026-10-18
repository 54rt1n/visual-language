<script lang="ts">
  import { untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import { LessonService } from '../learning/lessonService'
  import { lessonActivity, lessonHistory, lessonProgression, learningStreak } from '../learning/lessonPolicy'
  import { quizLevels, complexityLabels, scopeLabels } from '../domain/lessonPlan'
  import { workspaceClock } from '../teacher/host'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import type { Lesson } from '../domain/lesson'

  let { workspace, onChanged, onOpen, onCreate, onClose }: {
    workspace: WorkspaceState; onChanged: (snapshot: WorkspaceSnapshot) => void;
    onOpen: (sessionId: string, anchorId: string) => void; onCreate: () => void; onClose: () => void;
  } = $props()
  const clock = untrack(() => workspaceClock(workspace))
  const kinds = { topic: 'Topic', scenario: 'Scenario', reading: 'Reading' }
  const document = $derived(workspace.snapshot!.state)
  const now = $derived(workspace.learningNow)
  let archived = $state(false), busy = $state(false), error = $state(''), status = $state('')
  const lessons = $derived(document.lessons.filter(l => l.learnerId === document.activeLearnerId))
  const rows = $derived(lessons.filter(l => (l.archivedAt !== undefined) === archived).map(lesson => ({
    lesson, progress: lessonProgression(document, lesson.id), action: lessonActivity(document, lesson, now), history: lessonHistory(document, lesson.id),
  })).sort((a, b) => Number(b.action.due) - Number(a.action.due) || Number(Boolean(b.action.session)) - Number(Boolean(a.action.session)) || b.lesson.createdAt - a.lesson.createdAt))
  const hasDue = $derived(lessons.some(l => lessonActivity(document, l, now).due))
  const streak = $derived(learningStreak(document, workspace.learningCalendar!.anchor!))
  const when = (at: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
  async function open(lesson: Lesson, practice = false) {
    if (busy) return
    busy = true; error = ''
    try {
      const next = await workspace.apply((s, r) => new LessonService(r, clock).startActivity(s, lesson.id, practice ? 'practice' : undefined))
      onChanged(next)
      const activity = practice ? 'practice' : lessonActivity(next.state, next.state.lessons.find(l => l.id === lesson.id)!, clock.now()).mode
      const session = next.state.sessions.find(s => s.lessonAttempt?.lessonId === lesson.id && s.lessonAttempt.activity === activity && s.status === 'active')!
      onOpen(session.id, lesson.anchorId)
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Your saved lesson could not be opened.' }
    finally { busy = false }
  }
  async function archive(lesson: Lesson, value: boolean) {
    if (busy) return
    busy = true; error = ''
    try {
      onChanged(await workspace.apply((s, r) => new LessonService(r, clock).archive(s, lesson.id, value)))
      status = value ? 'Lesson archived. Your saved work and history are kept.' : 'Lesson restored with its saved progress and review date.'
    } catch (cause) { error = cause instanceof Error ? cause.message : 'The lesson could not be updated.' }
    finally { busy = false }
  }
</script>

<Modal title="Lessons" {onClose}>
  <div class="lessons">
    <section aria-label="Learning streak" class="streak">
      <p><strong>{streak.current} {streak.current === 1 ? 'day' : 'days'} in a row</strong> · Personal best: {streak.best}</p>
      <div class="week" aria-label="Last seven learning days">{#each streak.days as day, i}<span class:done={day.completed} aria-label={`${i === 6 ? 'Today' : `${6 - i} learning days ago`}: ${day.completed ? 'completed' : 'no completion'}`}>{day.completed ? '✓' : '·'}</span>{/each}</div>
      <p>{streak.today ? 'You’ve completed a learning activity today.' : 'Complete a lesson, practice or review to add today.'}</p>
    </section>
    <div class="collection-tools"><button type="button" class:ready={!hasDue} disabled={busy} onclick={onCreate}>Create a lesson</button><label><input type="checkbox" bind:checked={archived} /> Show archived ({lessons.filter(l => l.archivedAt !== undefined).length})</label></div>
    {#if error}<p role="alert">{error}</p>{/if}{#if status}<p role="status">{status}</p>{/if}
    {#if !rows.length}<p>{archived ? 'No archived lessons.' : 'Your saved lessons will appear here. Create one from a conversation or explore a topic to begin.'}</p>{/if}
    {#each rows as { lesson, progress, action, history } (lesson.id)}
      <article aria-label={lesson.title}>
        <h3>{lesson.title}</h3>
        <p class="muted">{kinds[lesson.kind]} · {progress.level ? `Level ${progress.level} of 4` : 'Not yet passed'} · {progress.points}/10 points</p>
        <progress max="10" value={progress.points} aria-label={`${lesson.title}: ${progress.points} of 10 points`}></progress>
        {#if progress.nextThreshold}<p class="muted">Next: Level {progress.level + 1} at {progress.nextThreshold} {progress.nextThreshold === 1 ? 'point' : 'points'}.</p>{/if}
        {#if action.due}<p class="due">Ready for review{action.retry ? ' · Try again whenever you’re ready' : ''}</p>
        {:else if lesson.opportunity?.kind === 'initial'}<p>{action.retry ? 'Try again to earn your first point. Earlier attempts are saved.' : 'Learn at your own pace, then check your understanding.'}</p>
        {:else if lesson.opportunity}<p>Next review: {when(lesson.opportunity.eligibleAt)}</p>{/if}
        {#if action.session}<p class="muted">Saved {action.session.lessonAttempt!.activity === 'review' ? 'review' : action.session.lessonAttempt!.activity === 'learn' ? 'lesson' : 'practice'} · Step {action.session.lessonAttempt!.stepIndex + 1}</p>{/if}
        {#if action.session?.lessonAttempt?.activity === 'review'}<p class="muted">Practicing during this unfinished review records help for unanswered checks.</p>{/if}
        <div class="actions">{#if archived}<button type="button" disabled={busy} onclick={() => void archive(lesson, false)}>Restore lesson</button>
          {:else}<button type="button" class:ready={action.due} disabled={busy} onclick={() => void open(lesson)}>{action.label}</button>
            {#if action.mode !== 'practice'}<button type="button" class="ghost" disabled={busy || !lesson.preparation?.check?.complete} onclick={() => void open(lesson, true)}>{action.savedPractice ? 'Resume saved practice' : 'Practice'}</button>{/if}
            <button type="button" class="ghost" disabled={busy} onclick={() => void archive(lesson, true)}>Archive</button>{/if}</div>
        <details><summary>Progress and history ({history.filter(s => s.lessonAttempt?.completion).length} completed)</summary>
          {#if !history.some(s => s.lessonAttempt?.completion)}<p>No completed attempts yet. Your current work stays saved.</p>{/if}
          <ol>{#each history.filter(s => s.lessonAttempt?.completion) as session}
            {@const attempt = session.lessonAttempt!}{@const completion = attempt.completion!}
            <li><strong>{attempt.activity === 'practice' ? 'Practice completed' : `${attempt.activity === 'review' ? 'Review' : 'Learn'} · ${completion.passed ? 'Passed' : 'Not yet passed'}`}</strong> · {completion.answers.filter(a => a.outcome === 'correct').length}/{completion.answers.length} correct without help
              <br /><span class="muted">{when(completion.completedAt)} · Learning day {completion.day.date}{completion.pointAwarded ? ' · +1 point' : ''}</span></li>
          {/each}</ol>
          <p>{lesson.goal}</p><p class="muted">{quizLevels[lesson.settings.quizLevel]} · {complexityLabels[lesson.settings.complexity]} · {scopeLabels[lesson.settings.scope]}</p>
          <p class="muted">{lesson.source ? 'Saved sourced material' : 'Saved conversation material'} · Created {when(lesson.createdAt)}</p>
          <p>Levels need 1, 3, 6 and 10 points. Each scored opportunity earns at most one point. Every Check answer must be correct on the first try without help. You can retry until you pass.</p>
        </details>
      </article>
    {/each}
  </div>
</Modal>

<style>
  .lessons { display: grid; gap: 18px; }h3,p { margin: 0; }p { line-height: 1.5; font-size: 14px; }.muted { color: #b4bfd0; font-size: 13px; }article,.streak { display: grid; gap: 10px; border: 1px solid #40516b; border-radius: 12px; padding: 16px; }h3 { font-size: 17px; overflow-wrap: anywhere; }.actions,.collection-tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }button,label { min-height: 44px; }label { display: flex; align-items: center; gap: 7px; font-size: 13px; }progress { width: 100%; height: 8px; accent-color: #a0d8c0; }.due { color: #b2ead4; font-weight: 600; }.ready { box-shadow: 0 0 0 2px #92d9b566, 0 0 18px #8cddb333; border-color: #a6e5c4; }button:focus-visible { outline: 3px solid #bed6ff; outline-offset: 4px; }.week { display: flex; gap: 7px; }.week span { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: #303949; }.week .done { background: #315c4c; color: #c7f5df; }summary { cursor: pointer; min-height: 44px; display: list-item; align-content: center; }details p { margin-top: 9px; }ol { padding-left: 20px; }li + li { margin-top: 12px; }[role="alert"] { color: #ffc1c1; }
</style>
