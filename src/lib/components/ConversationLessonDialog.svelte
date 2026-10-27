<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import LessonCreationProgress from './LessonCreationProgress.svelte'
  import type { Settings } from '../settings'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import { quizLevels, complexityLabels, scopeLabels, focusLabels, type LessonSettings } from '../domain/lessonSettings'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import { LessonCreationPauseError, LessonCreationService, lessonConversationSetup, lessonCreationSettings, lessonCreationConnected, type LessonCreationResult } from '../teacher/lessonCreationService'

  let { workspace, settings, nodeId, draftId, onChanged, onStart, onLessons, onConnection, onClose }: {
    workspace: WorkspaceState; settings: Settings; nodeId: string; draftId?: string;
    onChanged: (snapshot: WorkspaceSnapshot) => void; onStart: (result: LessonCreationResult) => void;
    onLessons: () => void; onConnection: () => void; onClose: () => void;
  } = $props()

  const host = untrack(() => teacherHost(workspace, onChanged))
  const service = new LessonCreationService(host, () => settings, {
    clock: untrack(() => workspaceClock(workspace)),
    onProgress: progress => {
      status = progress.phase === 'lesson' ? progress.stage : {
        sources: 'Reading your conversation…', planning: 'Planning your lesson…',
        draft: 'Writing your lesson…', review: 'Checking your lesson…',
      }[progress.stage]
    },
  })
  const initialDraft = untrack(() => workspace.snapshot!.state.drafts.find(draft => draft.id === draftId))
  const initial = untrack(() => {
    const state = workspace.snapshot!.state
    const source = state.sources.find(source => source.id === initialDraft?.discoveryRequest?.origin?.sourceId)
    if (source?.conversation) return {
      ...source.conversation,
      title: initialDraft?.creationSettings?.topic ?? source.title,
      settings: initialDraft?.creationSettings ?? service.status({ draftId: draftId ?? '' }).lesson?.settings ?? lessonCreationSettings(source.title),
    }
    return lessonConversationSetup(state, nodeId)
  })
  let selectedId = $state(untrack(() => draftId ?? ''))
  const creation = $derived(service.status({ draftId: selectedId }))
  let kind = $state<'topic' | 'roleplay' | 'interest'>(initialDraft?.discoveryRequest?.kind ?? 'topic')
  let lessonSettings = $state<LessonSettings>(untrack(() => structuredClone(
    service.status({ draftId: draftId ?? '' }).lesson?.settings ?? initialDraft?.creationSettings ?? initial.settings,
  )))
  let startNodeId = $state(initial.messages[0]?.nodeId ?? '')
  const messages = $derived(initial.messages.slice(Math.max(0, initial.messages.findIndex(message => message.nodeId === startNodeId))))
  let started = $state(Boolean(initialDraft))
  let busy = $state(false), status = $state(''), error = $state(''), pauseFailed = $state(false), navigating = $state(false)
  const ready = $derived(!busy && creation.phase === 'ready' && !creation.completed)
  const hasConnection = $derived(lessonCreationConnected(workspace.snapshot!.state, settings, workspace.snapshot!.state.nodes.some(node => node.id === nodeId) ? nodeId : initial.rootId))
  const phase = $derived(ready ? 'ready' : busy ? started ? 'preparing' : 'saving' : started ? 'paused' : 'setup')
  let heading = $state<HTMLHeadingElement>(), previousPhase = ''
  let controller: AbortController | undefined, activeTask: Promise<void> | undefined

  $effect(() => {
    const changed = previousPhase && previousPhase !== phase
    previousPhase = phase
    if (changed) void tick().then(() => {
      heading?.focus({ preventScroll: true })
      heading?.closest('.modal-body')?.scrollTo({ top: 0 })
    })
  })
  $effect(() => { if (workspace.status === 'conflict') controller?.abort() })
  onMount(() => () => controller?.abort())

  async function create() {
    if (busy || navigating) return
    if (!hasConnection) { onConnection(); return }
    busy = true; error = ''; pauseFailed = false; status = 'Preparing your conversation…'
    controller = new AbortController()
    const signal = controller.signal
    activeTask = (async () => {
      try {
        if (!started) {
          selectedId = await service.saveConversationRequest(nodeId, {
            kind, settings: $state.snapshot(lessonSettings), startNodeId,
          }, selectedId || undefined)
          started = true
        }
        signal.throwIfAborted()
        await service.createFromRequest(selectedId, { signal, settings: $state.snapshot(lessonSettings) })
      } catch (cause) {
        pauseFailed = cause instanceof LessonCreationPauseError
        if (!signal.aborted || pauseFailed) error = cause instanceof Error ? cause.message : 'Your lesson could not be created.'
      } finally {
        busy = false; controller = undefined; activeTask = undefined
      }
    })()
    await activeTask
  }

  async function leave(after = onClose) {
    if (navigating) return
    navigating = true; controller?.abort()
    try {
      await service.pause()
      await activeTask
      after()
    } catch (cause) {
      pauseFailed = cause instanceof LessonCreationPauseError
      error = cause instanceof Error ? cause.message : 'Your progress could not be saved.'
    } finally { navigating = false }
  }

  function startLesson() {
    if (!ready || !creation.lesson || !creation.sessionId) return
    onStart({ draftId: selectedId, lessonId: creation.lesson.id, sessionId: creation.sessionId, anchorId: creation.lesson.anchorId })
  }
</script>

<Modal title="Create lesson from conversation" onClose={() => void leave()}>
  <div class="creation-screen">
    {#if ready}
      <header><h3 tabindex="-1" bind:this={heading}>Your lesson is ready</h3><p class="muted">{creation.lesson?.title}</p></header>
      <ul class="ready-stages" aria-label="Prepared lesson">
        <li><span aria-hidden="true">✓</span> Lesson plan</li>
        <li><span aria-hidden="true">✓</span> Guided practice</li>
        <li><span aria-hidden="true">✓</span> Lesson quiz</li>
      </ul>
    {:else if started}
      <header><h3 tabindex="-1" bind:this={heading}>{busy ? 'Creating your lesson' : 'Continue preparation'}</h3><p class="muted">{creation.lesson?.title ?? lessonSettings.topic}</p></header>
      <LessonCreationProgress {busy} {status} {pauseFailed}
        teachingReady={Boolean(creation.readiness?.teaching)}
        practiceReady={creation.readiness?.practice?.status === 'validated'}
        checkReady={creation.readiness?.check?.status === 'validated'}
        waypointCount={creation.lesson?.preparation?.lesson.graph.waypoints.length ?? creation.lesson?.waypointDraft?.graph.waypoints.length ?? 0}
        practiceCount={creation.lesson?.preparation?.practice?.questions.length ?? 0}
        checkCount={creation.lesson?.preparation?.check?.questions.length ?? 0} />
      {#if !busy && !creation.lesson}<button type="button" class="ghost edit-request" onclick={() => { started = false; error = '' }}>Edit lesson</button>{/if}
    {:else}
      <h3 tabindex="-1" bind:this={heading}>{initial.title}</h3>
      <details class="conversation">
        <summary>Conversation · {messages.length} {messages.length === 1 ? 'message' : 'messages'}</summary>
        <div class="details-body">
          {#if initial.messages.length > 1}<label>Start from<select bind:value={startNodeId} disabled={busy}>
            {#each initial.messages as message, index}<option value={message.nodeId}>{index + 1}. {message.role === 'user' ? 'You' : 'Zheng'} — {message.text.slice(0, 70)}{message.text.length > 70 ? '…' : ''}</option>{/each}
          </select></label>{/if}
          <div class="transcript" aria-label="Selected conversation">
            {#each messages as message}<article><h4>{message.role === 'user' ? 'You' : 'Zheng'}</h4><p>{message.text}</p></article>{/each}
          </div>
        </div>
      </details>
      <form id="conversation-lesson-request" onsubmit={event => { event.preventDefault(); void create() }}>
        <label>Lesson type<select bind:value={kind} disabled={busy}>
          <option value="topic">Learn about a topic</option><option value="roleplay">Practice a scenario</option><option value="interest">Read a short passage</option>
        </select></label>
        <label>Quiz level<select bind:value={lessonSettings.quizLevel} disabled={busy}>
          {#each Object.entries(quizLevels) as [value, label]}<option {value}>{label}</option>{/each}
        </select></label>
        <details><summary>Adjust lesson</summary><div class="details-body">
          <label>Topic or situation<input bind:value={lessonSettings.topic} maxlength="200" required disabled={busy} /></label>
          <label>Language complexity<select bind:value={lessonSettings.complexity} disabled={busy}>{#each Object.entries(complexityLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
          <label>Topic scope<select bind:value={lessonSettings.scope} disabled={busy}>{#each Object.entries(scopeLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
          <label>Growth focus<select bind:value={lessonSettings.focus} disabled={busy}>{#each Object.entries(focusLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
        </div></details>
      </form>
    {/if}
  </div>
  {#snippet footer()}
    <div class="creation-footer">
      {#if error}<div class="error-status"><p role="alert">{pauseFailed ? error : 'Your lesson could not be created.'}</p>{#if !pauseFailed}<details><summary>Details</summary><p>{error}</p><button type="button" class="ghost" onclick={onConnection}>AI connection</button></details>{/if}</div>{/if}
      <div class="footer-actions">
        <button type="button" class="ghost" disabled={navigating} onclick={() => void leave(ready || started ? onLessons : onClose)}>{pauseFailed ? 'Retry save & close' : ready || started ? 'Back to lessons' : 'Cancel'}</button>
        {#if ready}<button type="button" disabled={navigating} onclick={startLesson}>Start lesson</button>
        {:else if busy}<button type="button" disabled={navigating} onclick={() => controller?.abort()}>Pause</button>
        {:else if !hasConnection}<button type="button" disabled={navigating} onclick={onConnection}>Set up AI connection</button>
        {:else}<button type="button" disabled={navigating || !lessonSettings.topic.trim() || !messages.length} onclick={() => void create()}>{started ? 'Continue preparation' : 'Create lesson'}</button>{/if}
      </div>
    </div>
  {/snippet}
</Modal>

<style>
  .creation-screen,form,.creation-footer,.details-body { display: grid; gap: 16px; }
  h3,h4,p { margin: 0; } h3:focus { outline: none; } h3,header p { overflow-wrap: anywhere; } header { display: grid; gap: 4px; }
  p { line-height: 1.5; } .muted { color: #b9c5d9; font-size: 12px; }
  label { display: grid; gap: 7px; font-size: 13px; }
  select,input { width: 100%; min-height: 44px; padding: 9px; border: 1px solid #3d485d; border-radius: 7px; background: #111722; color: inherit; font: inherit; }
  summary { cursor: pointer; color: #c4d7f5; font-size: 13px; min-height: 44px; align-content: center; }
  .details-body { padding-top: 8px; }.conversation { border-bottom: 1px solid #354154; padding-bottom: 4px; }
  .transcript { display: grid; gap: 14px; max-height: 260px; overflow: auto; padding: 12px; border-radius: 9px; background: #111722; }
  article { display: grid; gap: 5px; } article h4 { color: #b9c5d9; font-size: 12px; } article p { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
  .ready-stages { list-style: none; margin: 0; padding: 18px; border: 1px solid #405574; border-radius: 12px; background: #1b293d; display: grid; gap: 16px; }
  .ready-stages li { display: flex; gap: 12px; align-items: center; }.ready-stages span { color: #b3efd4; }
  .footer-actions { display: flex; gap: 10px; }.footer-actions button { min-height: 44px; min-width: 0; }.footer-actions button:last-child { flex: 1; }
  .error-status { max-height: min(120px, 20dvh); overflow: auto; font-size: 13px; }.error-status>p { color: #f4a3a3; }.error-status details p { margin-bottom: 8px; }
  @media (max-width: 520px) { .creation-screen { gap: 12px; } .transcript { max-height: 210px; } }
</style>
