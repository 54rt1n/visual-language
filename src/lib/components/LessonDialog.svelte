<script lang="ts">
  import { lessonForSession, lessonView } from '../domain/lesson'
  import { onMount, tick, untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import LessonCreationProgress from './LessonCreationProgress.svelte'
  import LessonTeaching from './LessonTeaching.svelte'
  import LessonQuestion from './LessonQuestion.svelte'
  import LessonResults from './LessonResults.svelte'
  import QuizRecoveryPanel from './QuizRecoveryPanel.svelte'
  import { recoverableQuizzes } from '../teacher/quizRecovery'
  import { conversationSelection } from '../learning/conversationPractice'
  import { lessonKindLabels, quizLevels, complexityLabels, scopeLabels, focusLabels, type QuizLevel, type LessonSettings } from '../domain/lessonPlan'
  import { lessonStep, lessonReadiness, growthEvidence } from '../learning/lessonProgress'
  import { LearningService } from '../learning/learningService'
  import { LessonService } from '../learning/lessonService'
  import { TeacherService } from '../teacher/teacherService'
  import { RehearsalTeacher } from '../demo/rehearsalTeacher'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import { feedbackMaterial } from '../teacher/feedback'
  import { learningPreferencesForCard } from '../graph/graphService'
  import { nid } from '../id'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import type { Settings } from '../settings'

  let { workspace, settings, anchorId, initialSessionId, initialItemId, autoStart = false, onChanged, onClose, onReturn, onDailyReview, onLessons }: {
    workspace: WorkspaceState; settings: Settings; anchorId: string; initialSessionId?: string; initialItemId?: string;
    onChanged: (snapshot: WorkspaceSnapshot) => void; onClose: () => void;
    onReturn: (anchorId: string) => void; onDailyReview: () => void;
    autoStart?: boolean; onLessons: () => void;
  } = $props()
  const host = untrack(() => teacherHost(workspace, onChanged)), clock = untrack(() => workspaceClock(workspace))
  const prerecorded = untrack(() => workspace.mode === 'demo' && workspace.snapshot?.state.demo?.contentMode === 'fixtures')
  const teacher = prerecorded ? new RehearsalTeacher(host, clock) : new TeacherService(host, () => settings, { clock })
  const document = $derived(workspace.snapshot!.state)
  const selection = $derived(conversationSelection(document, anchorId))
  let selectedItems = $state<string[]>(untrack(() => selection.source?.scope ? selection.items.map(i => i.id) : initialItemId ? [initialItemId] : selection.items.slice(0, 9).map(i => i.id)))
  const previousSettings = untrack(() => document.lessons.filter(l => l.anchorId === anchorId).at(-1)?.settings)
  const previousLesson = $derived(document.sessions.filter(s => s.status === 'completed' && lessonForSession(document, s)?.kind === selection.kind && lessonForSession(document, s)!.cardIds.length === selectedItems.length && lessonForSession(document, s)!.cardIds.every(id => selectedItems.includes(document.cards.find(c => c.id === id)!.itemId))).at(-1))
  const suggested = $derived(previousLesson ? growthEvidence(document, previousLesson).suggestion : undefined)
  let goal = $state(untrack(() => selection.source?.scenario?.objective ?? (selection.kind === 'reading' ? 'Understand the selected phrases in this passage and a fresh short reading.' : 'Understand these phrases and choose appropriate uses in conversation.')))
  let quizLevel = $state<QuizLevel>(previousSettings?.quizLevel ?? 'meaningPinyin')
  let complexity = $state<LessonSettings['complexity']>(previousSettings?.complexity ?? 'simple'), scope = $state<LessonSettings['scope']>(previousSettings?.scope ?? 'everyday'), focus = $state<LessonSettings['focus']>(previousSettings?.focus ?? 'characters')
  let topic = $state(untrack(() => previousSettings?.topic ?? selection.title))
  let sessionId = $state(untrack(() => initialSessionId)), resumed = $state(untrack(() => autoStart)), busy = $state(false), error = $state(''), busyLabel = $state('')
  const session = $derived(document.sessions.find(s => s.id === sessionId))
  const plan = $derived(lessonView(document, session))
  const readiness = $derived(session && plan ? lessonReadiness(document, session) : undefined)
  const creating = $derived(Boolean(plan && !readiness?.ready))
  const totalSteps = $derived(plan?.steps.length ?? 0)
  const step = $derived(session ? lessonStep(document, session) : undefined)
  const inQuiz = $derived(step?.stage === 'check')
  const teachingCount = $derived(plan?.steps.filter(s => s.phase === 'learn').length ?? 0)
  const teachingIndex = $derived(plan?.steps.slice(0, plan.stepIndex + 1).filter(s => s.phase === 'learn').length ?? 0)
  const quizCount = $derived(plan?.steps.filter(s => s.phase === 'check').length ?? 0)
  const quizIndex = $derived(plan?.steps.slice(0, plan.stepIndex + 1).filter(s => s.phase === 'check').length ?? 0)
  const nextStep = $derived(plan?.steps[plan.stepIndex + 1])
  const advanceLabel = $derived(nextStep?.phase === 'check' ? 'Start quiz' : step?.stage === 'learn' && nextStep?.phase === 'practice' ? 'Try it' : 'Continue')
  const card = $derived(document.cards.find(c => c.id === step?.cardId))
  const item = $derived(document.items.find(i => i.id === card?.itemId))
  const exercise = $derived(document.exercises.find(e => e.id === session?.activeExerciseId))
  const preparedQuestion = $derived(plan && exercise?.multipleChoice ? document.drafts.find(d => d.id === exercise.multipleChoice!.quizId)?.quiz?.questions.find(q => q.cardId === exercise.cardId && q.lessonStep === exercise.lessonStep) : undefined)
  const attempt = $derived(exercise ? document.attempts.find(a => a.exerciseId === exercise.id) : undefined)
  const waypoint = $derived(plan?.preparation?.lesson.graph.waypoints.find(w => w.id === step?.waypointId))
  const teachingItems = $derived(waypoint ? waypoint.cardIds.flatMap(id => {
    const item = document.items.find(i => i.id === document.cards.find(c => c.id === id)?.itemId)
    return item ? [item] : []
  }) : item ? [item] : [])
  const needsRetry = $derived(Boolean(step?.stage === 'practice' && plan && attempt?.status === 'committed' && (attempt.assessment?.grade !== 'correct' || attempt.helpUsed) && !plan.remediatedSteps.includes(plan.stepIndex)))
  const feedback = $derived(exercise ? feedbackMaterial(document, exercise, attempt) : undefined)
  const preferences = $derived(learningPreferencesForCard(document, card?.id))
  const savedSessions = $derived(document.sessions.filter(s => s.learnerId === document.activeLearnerId && s.status !== 'completed'))
  const savedQuizzes = $derived(recoverableQuizzes(document).filter(d => d.sessionId === sessionId && d.status !== 'validated'))
  let answer = $state(''), optionId = $state(''), retryOptionId = $state(''), loadedExercise = '', revealed = $state(false)
  let journey = $state<HTMLElement>(), heading = $state<HTMLElement>(), controller: AbortController | undefined, pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let lastDraft = ''
  onMount(() => {
    if (autoStart && sessionId) void work(readiness?.ready ? 'Opening your lesson…' : 'Preparing your quiz…', async signal => {
      if (!readiness?.ready) await teacher.prepareLesson(sessionId!, signal, label => { busyLabel = label })
      await openQuestion(signal)
    })
    return () => { controller?.abort(); clearTimeout(timer) }
  })
  $effect(() => {
    if (creating && heading) { heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: 'start' }) }
  })
  $effect(() => { if (workspace.status === 'conflict') { controller?.abort(); resumed = false } })
  $effect(() => {
    if ((exercise?.id ?? '') === loadedExercise) return
    loadedExercise = exercise?.id ?? ''; revealed = false; retryOptionId = ''
    const draft = document.drafts.find(d => d.kind === 'answer' && d.exerciseId === exercise?.id)
    answer = attempt?.answer ?? draft?.text ?? ''; optionId = attempt?.selectedOptionId ?? draft?.selectedOptionId ?? ''
    lastDraft = JSON.stringify([loadedExercise, answer, optionId])
  })
  $effect(() => {
    const signature = JSON.stringify([exercise?.id ?? '', answer, optionId])
    if (!exercise || attempt || !resumed || busy || signature === lastDraft) return
    timer = setTimeout(() => { void saveAnswer().catch(cause => { error = String(cause) }) }, 300)
    return () => clearTimeout(timer)
  })
  async function saveAnswer() {
    clearTimeout(timer)
    if (!exercise || attempt) return
    const id = exercise.id, text = answer, selected = optionId
    const signature = JSON.stringify([id, text, selected])
    if (signature === lastDraft) return
    await host.apply((s, r) => new LearningService(r, clock).saveAnswerDraft(s, id, text, nid('op'), selected || undefined))
    lastDraft = signature
  }
  async function work(label: string, action: (signal: AbortSignal) => Promise<void>, focus: 'content' | 'feedback' = 'content') {
    if (busy) return
    busy = true; error = ''; busyLabel = label; controller = new AbortController()
    const signal = controller.signal
    pending = (async () => {
      try {
        await action(signal); await tick()
        const target = (focus === 'feedback' ? journey?.querySelector<HTMLElement>('[data-lesson-feedback]') : undefined)
          ?? journey?.querySelector<HTMLElement>('[data-lesson-heading], h3')
        target?.focus({ preventScroll: true })
        if (focus === 'feedback') target?.scrollIntoView({ block: 'start' })
        else journey?.closest('.modal-body')?.scrollTo({ top: 0 })
      }
      catch (cause) { error = signal.aborted ? 'Paused. Your saved progress is ready when you return.' : cause instanceof Error ? cause.message : 'Practice could not continue.' }
      finally { busy = false; pending = undefined }
    })()
    await pending
  }
  async function start() {
    await work('Saving your lesson plan…', async signal => {
      const next = await host.apply((s, r) => new LearningService(r, clock).startLesson(s, anchorId, selectedItems, goal, { quizLevel, complexity, scope, focus, topic }))
      sessionId = next.state.sessions.at(-1)!.id; resumed = true
      await teacher.prepareLesson(sessionId, signal, label => { busyLabel = label })
      await openQuestion(signal)
    })
  }
  async function retry() {
    await work('Preparing a fresh quiz…', async signal => {
      const next = await host.apply((s, r) => new LessonService(r, clock).startActivity(s, plan!.id))
      sessionId = next.state.sessions.find(s => s.status === 'active' && s.lessonAttempt?.lessonId === plan!.id)!.id; resumed = true
      await teacher.prepareLesson(sessionId, signal, label => { busyLabel = label })
      await openQuestion(signal)
    })
  }
  async function resume(id: string) {
    await work('Resuming lesson…', async signal => {
      await host.apply((s, r) => new LearningService(r, clock).setSessionStatus(s, id, 'active'))
      sessionId = id; resumed = true
      const active = host.current().state.sessions.find(s => s.id === id)?.activeExerciseId
      const pendingAttempt = host.current().state.attempts.find(a => a.exerciseId === active && a.status === 'pending')
      if (pendingAttempt) await host.apply((s, r) => new LearningService(r, clock).markGradingUnavailable(s, pendingAttempt.id, 'The previous request stopped. Check the saved answer again.'))
      await openQuestion(signal)
    })
  }
  async function openQuestion(signal: AbortSignal) {
    const state = host.current().state, current = state.sessions.find(s => s.id === sessionId)
    if (!current || current.status !== 'active' || current.activeExerciseId || !resumed) return
    const currentPlan = lessonView(state, current), currentStep = lessonStep(state, current)
    if (!currentPlan || !currentStep || currentStep.stage === 'learn' || !lessonReadiness(state, current).ready) return
    const currentCard = state.cards.find(c => c.id === currentStep.cardId)!
    if (currentCard.status === 'new') await host.apply((s, r) => new LearningService(r, clock).introduce(s, currentCard.id, current.id))
    signal.throwIfAborted()
    const draft = lessonReadiness(host.current().state, current)[currentStep.stage]
    if (!draft?.quiz || draft.status !== 'validated') throw new Error('Finish preparing the lesson quiz first.')
    const index = draft.quiz.questions.findIndex(q => q.lessonStep === currentPlan.stepIndex)
    await teacher.presentQuizQuestion(current.id, draft.id, index, currentPlan.activity !== 'review')
  }
  async function advance(signal: AbortSignal) {
    await host.apply((s, r) => new LearningService(r, clock).advanceLesson(s, sessionId!))
    signal.throwIfAborted()
    await openQuestion(signal)
  }
  async function answerQuiz(signal: AbortSignal) { await submit(signal); signal.throwIfAborted(); await advance(signal) }
  async function submit(signal: AbortSignal) {
    if (!exercise) return
    if (!attempt) {
      await saveAnswer()
      await host.apply((s, r) => new LearningService(r, clock).submitAttempt(s, { id: nid('attempt'), exerciseId: exercise!.id, answer, submittedAt: clock.now(), ...(optionId ? { selectedOptionId: optionId } : {}) }))
    }
    const saved = host.current().state.attempts.find(a => a.exerciseId === exercise!.id)!
    await teacher.gradeAttempt(saved.id, signal)
  }
  async function close(after = onClose) {
    controller?.abort(); await pending
    try {
      await saveAnswer()
      if (session && session.status !== 'completed') await host.apply((s, r) => new LearningService(r, clock).setSessionStatus(s, session!.id, 'paused'))
      after()
    } catch (cause) { error = `Your practice could not be saved. ${cause instanceof Error ? cause.message : ''}` }
  }
  async function showHelp() {
    if (step?.stage !== 'practice' || !exercise || attempt) return
    await work('Saving your help request…', async () => {
      await saveAnswer()
      await host.apply((s, r) => new LearningService(r, clock).requestHelp(s, exercise!.id, 'reveal'))
      revealed = true
    }, 'feedback')
  }
</script>

<Modal title="Your lesson" onClose={() => void close(autoStart ? onLessons : onClose)}>
  <div class="journey" bind:this={journey}>
    {#if prerecorded}<p class="muted">Demo · prerecorded examples. These do not demonstrate live lesson generation.</p>{/if}
    {#if !session}
      <h3 tabindex="-1" bind:this={heading}>{selection.title}</h3>
      <p>{lessonKindLabels[selection.kind]}. {selection.source?.scope ? 'This lesson keeps all its reviewed teaching points.' : 'Choose up to nine saved phrases.'} Learn from examples, practice with choices, then check your understanding in a new situation.</p>
      {#if savedSessions.length}<details><summary>Saved sessions ({savedSessions.length})</summary><p class="muted">Starting here pauses your other session and keeps its answers.</p>{#each savedSessions.filter(s => lessonForSession(document, s)?.archivedAt === undefined) as saved}<button type="button" class="ghost" disabled={busy} onclick={() => saved.lessonAttempt ? void resume(saved.id) : onDailyReview()}>Resume {lessonForSession(document, saved)?.title ?? 'daily review'}</button>{/each}</details>{/if}
      {#if selection.items.length}
        <label>Lesson objective<textarea bind:value={goal} maxlength="2000" rows="2" disabled={busy}></textarea></label>
        <fieldset disabled={busy || Boolean(selection.source?.scope)}><legend>Phrases to practice</legend>{#each selection.items as phrase}<label class="phrase"><input type="checkbox" value={phrase.id} bind:group={selectedItems} /><span><strong lang="zh">{phrase.canonicalText}</strong><span>{phrase.meaning}</span></span></label>{/each}</fieldset>
        {#if suggested}<aside><p>Your saved checks and delayed reviews support trying one next step.</p><button type="button" class="ghost" onclick={() => { quizLevel = suggested!.quizLevel; complexity = suggested!.complexity; scope = suggested!.scope; focus = suggested!.focus; topic = suggested!.topic }}>Use suggested settings</button></aside>{/if}
        <label>Quiz level<select bind:value={quizLevel} disabled={busy}>{#each Object.entries(quizLevels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
        <details><summary>Adjust lesson</summary><div class="settings">
          <label>Topic or situation<input bind:value={topic} maxlength="200" disabled={busy} /></label>
          <label>Language complexity<select bind:value={complexity} disabled={busy}>{#each Object.entries(complexityLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
          <label>Topic scope<select bind:value={scope} disabled={busy}>{#each Object.entries(scopeLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
          <label>Today’s growth focus<select bind:value={focus} disabled={busy}>{#each Object.entries(focusLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
        </div></details>
        <p class="muted">{selectedItems.length} {selectedItems.length === 1 ? 'phrase' : 'phrases'} · Examples, guided practice and a lesson quiz. The questions will cover what your lesson teaches.</p>
        <p class="muted">All answers are multiple choice. Preparation saves the lesson, guided practice and the final quiz before you begin. It uses your connected AI account; completed stages are kept if you pause.</p>
        
        <p class="muted">New phrases return for review tomorrow after their introduction. Practice and quizzes keep existing review dates unchanged.</p>
        {#if selectedItems.length > 9}<p role="alert">Choose up to nine phrases for this lesson.</p>{/if}
      {:else}<p>No phrases saved on this branch yet. Select a word in the conversation and choose <strong>Save for practice</strong>.</p>{/if}
    {:else if plan && !readiness?.ready}
      <h3 tabindex="-1" bind:this={heading}>{plan.checkPreparation ? busy ? 'Preparing your fresh quiz' : 'Continue preparing your quiz' : busy ? 'Creating your lesson' : 'Continue creating your lesson'}</h3>
      <LessonCreationProgress {busy} status={busyLabel}
        checkOnly={Boolean(plan.checkPreparation)} teachingReady={Boolean(readiness?.teaching)} practiceReady={readiness?.practice?.status === 'validated'} checkReady={readiness?.check?.status === 'validated'}
        waypointCount={plan.preparation?.lesson.graph.waypoints.length ?? plan.waypointDraft?.graph.waypoints.length ?? 0}
        practiceCount={plan.preparation?.practice?.questions.length ?? 0} checkCount={plan.preparation?.check?.questions.length ?? 0} />
      <details><summary>Lesson details</summary><p>{session.goal}</p><p class="muted">{quizLevels[plan.settings.quizLevel]} · {complexityLabels[plan.settings.complexity]}</p></details>
      <p class="muted">Reviewed questions are saved as you go. You can pause and continue here later. {plan.checkPreparation ? 'Your fresh quiz begins when its questions are ready.' : 'Your lesson begins when all three stages are ready.'}</p>
    {:else if !step}
      <LessonResults {document} session={session!} />
    {:else}
      <header class="lesson-progress">
        <p class="lesson-title">{plan!.title}</p>
        <div class="progress-label"><span>{inQuiz ? `Quiz · Question ${quizIndex} of ${quizCount}` : `Lesson · Part ${teachingIndex} of ${teachingCount}`}</span><span>{step.stage === 'practice' ? 'Practice' : inQuiz ? '' : 'Learn'}</span></div>
        <progress aria-label={inQuiz ? 'Quiz progress' : 'Lesson progress'} max={inQuiz ? quizCount : totalSteps - quizCount} value={inQuiz ? quizIndex - 1 : plan!.stepIndex}></progress>
      </header>
      {#if !resumed}
        <h3 tabindex="-1" bind:this={heading}>Your lesson is saved</h3><p>Resume {plan!.title} where you left off.</p>
      {:else if exercise}
        {#if !inQuiz && plan?.source?.scenario}<p class="muted">You: {plan.source.scenario.learnerRole} · Zheng: {plan.source.scenario.teacherRole}</p>{/if}
        {#key exercise.id}<LessonQuestion {exercise} question={preparedQuestion} {attempt} quiz={inQuiz} {busy} bind:optionId bind:retryOptionId {needsRetry}
          remediated={Boolean(plan?.remediatedSteps.includes(plan.stepIndex))}
          helped={revealed || document.events.some(e => e.exerciseId === exercise.id && e.aid)} material={feedback} pinyinDisplay={preferences.pinyinDisplay}
          onSubmit={() => void work(inQuiz ? 'Saving your answer…' : 'Checking your answer…', inQuiz ? answerQuiz : submit, inQuiz ? 'content' : 'feedback')}
          onHelp={() => void showHelp()}
          onRetry={id => void work('Saving your practice…', async () => { await host.apply((s, r) => new LearningService(r, clock).completeSupportedRetry(s, sessionId!, id)) }, 'feedback')} />{/key}
      {:else if step.stage === 'learn'}
        <LessonTeaching items={teachingItems} {waypoint} source={plan?.source} kind={plan!.kind} context={plan!.context} pinyinDisplay={preferences.pinyinDisplay} />
      {:else}
        <h3 tabindex="-1" bind:this={heading}>Open your {inQuiz ? 'quiz' : 'practice question'}</h3><p>Your progress is saved. Try opening the prepared question again.</p>
      {/if}
    {/if}
      {#if savedQuizzes.length}<QuizRecoveryPanel drafts={savedQuizzes} {busy} {resumed} networkAllowed={!prerecorded}
        onReview={id => void work('Checking saved questions…', async signal => { await teacher.reviewQuiz(id, signal) })}
        onRegenerate={id => void work('Preparing a replacement question…', async signal => { await teacher.regenerateQuiz(id, signal) })}
        onDiscard={id => void work('Removing this unfinished question…', async () => { await teacher.discardQuiz(id) })}
        onUse={() => void work('Opening the saved question…', openQuestion)} />{/if}
  </div>
  {#snippet footer()}
    <div class="journey-footer">
      {#if busy && !(plan && !readiness?.ready)}<p role="status">{busyLabel}</p>{/if}{#if error}<p role="alert">{error}</p>{/if}
      <div class="actions">
        {#if session?.status === 'completed'}{#if session.lessonAttempt?.completion?.passed === false && session.lessonAttempt.activity !== 'practice'}<button type="button" disabled={busy} onclick={() => void retry()}>Try quiz again</button>{/if}<button type="button" class="ghost" onclick={() => void close(onLessons)}>Back to lessons</button>{/if}
        {#if session?.status !== 'completed' || !autoStart}<button type="button" class="ghost" onclick={() => void close(autoStart ? onLessons : () => onReturn(plan?.anchorId ?? anchorId))}>{autoStart ? 'Pause & back to lessons' : session && step ? 'Pause & return' : 'Return to source'}</button>{/if}
        {#if !session && selection.items.length}<button type="button" disabled={busy || !goal.trim() || !selectedItems.length || selectedItems.length > 9 || !topic.trim()} onclick={() => void start()}>Prepare lesson</button>
        {:else if session && plan && !readiness?.ready}
          {#if busy}<button type="button" class="ghost" onclick={() => controller?.abort()}>Pause creation</button>
          {:else if !resumed}<button type="button" onclick={() => void resume(session!.id)}>Resume lesson</button>
          {:else}<button type="button" disabled={busy} onclick={() => void work('Continuing preparation…', async signal => { await teacher.prepareLesson(sessionId!, signal, label => { busyLabel = label }); await openQuestion(signal) })}>Continue preparation</button>{/if}
        {:else if session && step}
          {#if !resumed}<button type="button" disabled={busy} onclick={() => void resume(session!.id)}>Resume lesson</button>
          {:else if exercise && inQuiz}<button type="submit" form="lesson-answer" disabled={busy || (!attempt && !optionId)}>{quizIndex === quizCount ? 'Submit quiz' : 'Next'}</button>
          {:else if exercise && needsRetry}<button type="submit" form="lesson-answer" disabled={busy || !retryOptionId}>Try again</button>
          {:else if exercise && attempt?.status === 'committed'}<button type="button" disabled={busy} onclick={() => void work('Saving your progress…', advance)}>{advanceLabel}</button>
          {:else if exercise && attempt}<button type="button" disabled={busy} onclick={() => void work('Saving your answer…', submit)}>Retry saving answer</button>
          {:else if exercise}<button type="submit" form="lesson-answer" disabled={busy || !optionId}>Check answer</button>
          {:else if step.stage === 'learn'}<button type="button" disabled={busy} onclick={() => void work('Opening your practice…', advance)}>{advanceLabel}</button>
          {:else}<button type="button" disabled={busy} onclick={() => void work('Opening your question…', openQuestion)}>Retry opening question</button>{/if}
        {/if}
      </div>
    </div>
  {/snippet}
</Modal>
<style>
  .journey,.journey-footer { display: grid; gap: 18px; }
  p,h3 { margin: 0; line-height: 1.55; } h3:focus { outline: none; }
  label { display: grid; gap: 8px; }
  textarea,select,input:not([type=radio]):not([type=checkbox]) { width: 100%; background: #111722; color: inherit; border: 1px solid #526078; border-radius: 8px; padding: 10px; font: inherit; }
  fieldset { border: 1px solid #354154; border-radius: 8px; display: grid; gap: 12px; padding: 14px; }
  .phrase { display: flex; gap: 12px; align-items: start; padding: 6px; } .phrase input { margin-top: 5px; } .phrase span { display: grid; gap: 4px; }
  .muted { color: #b9c5d9; font-size: 13px; line-height: 1.5; }
  aside { background: #223046; padding: 14px; border-radius: 8px; display: grid; gap: 10px; }
  .settings { display: grid; gap: 12px; margin-top: 12px; }
  details p,details button { margin-top: 10px; } summary { cursor: pointer; color: #b9d0f6; }
  .lesson-progress { display: grid; gap: 9px; padding-bottom: 4px; } .lesson-title { font-size: 14px; color: #b9c5d9; }
  .progress-label { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: #c6d9f7; }
  progress { display: block; width: 100%; height: 6px; border: 0; border-radius: 4px; overflow: hidden; accent-color: #8cadf4; }
  progress::-webkit-progress-bar { background: #303d53; } progress::-webkit-progress-value { background: #8cadf4; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; } .actions button { flex: 1; min-height: 44px; }
  [role=alert] { color: #f4a3a3; } .journey-footer [role=alert] { max-height: 100px; overflow: auto; }
</style>
