<script lang="ts">
  import { quizPassageLabel } from '../learning/quiz'
  import { onMount, untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import SpeechButton from './SpeechButton.svelte'
  import SourceList from './SourceList.svelte'
  import PinyinText from './PinyinText.svelte'
  import WorkedExampleView from './WorkedExampleView.svelte'
  import TeacherPortrait from './TeacherPortrait.svelte'
  import { TeacherActivity } from '../teacher/activity'
  import { teacherExpression } from '../teacher/portrait'
  import QuizRecoveryPanel from './QuizRecoveryPanel.svelte'
  import { recoverableQuizzes } from '../teacher/quizRecovery'
  import { feedbackMaterial } from '../teacher/feedback'
  import { learningPreferences, learningPreferencesForCard } from '../graph/graphService'
  import { nid } from '../id'
  import { learnerSchema, type Assessment, type LearnerProfile } from '../domain/learning'
  import { LearningService } from '../learning/learningService'
  import { sessionQueue } from '../learning/leitner'
  import { mandarinPinyin, containsHanzi } from '../mandarin/chineseParser'
  import { TeacherService } from '../teacher/teacherService'
  import { RehearsalTeacher } from '../demo/rehearsalTeacher'
  import { effectiveReviewEvents, recentReviewEvents, sessionSummary } from '../teacher/teacherContext'
  import { sessionReflection } from '../teacher/reviewHistory'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import type { Settings } from '../settings'

  let { workspace, settings, targetCardId, onHistory, onChanged, onReveal, onClose }: { workspace: WorkspaceState; settings: Settings; targetCardId?: string; onHistory: (cardId?: string) => void; onChanged: (snapshot: WorkspaceSnapshot) => void; onReveal: (nodeId: string) => void; onClose: () => void } = $props()
  const host = untrack(() => teacherHost(workspace, onChanged)), clock = untrack(() => workspaceClock(workspace))
  const prerecorded = untrack(() => workspace.mode === 'demo' && workspace.snapshot?.state.demo?.contentMode === 'fixtures')
  let pendingRequests = $state(0)
  const activity = new TeacherActivity(count => { pendingRequests = count })
  const teacher = prerecorded ? new RehearsalTeacher(host, clock) : new TeacherService(host, () => settings, { clock, transport: activity.transport, onTavilyRequest: activity.begin })
  const document = $derived(workspace.snapshot!.state)
  const learner = $derived(document.learners.find(l => l.id === document.activeLearnerId)!)
  const session = $derived(document.sessions.find(s => s.learnerId === learner.id && !s.lessonAttempt && s.status !== 'completed'))
  const exercise = $derived(session?.activeExerciseId ? document.exercises.find(e => e.id === session.activeExerciseId) : undefined)
  const card = $derived(exercise ? document.cards.find(c => c.id === exercise.cardId) : undefined)
  const item = $derived(card ? document.items.find(i => i.id === card.itemId) : undefined)
  const attempt = $derived(exercise ? document.attempts.filter(a => a.exerciseId === exercise.id).at(-1) : undefined)
  const helped = $derived(Boolean(exercise && document.events.some(e => e.exerciseId === exercise.id && e.aid)))
  const revealed = $derived(Boolean(exercise && document.events.some(e => e.exerciseId === exercise.id && e.aid && e.aid !== 'hint')))
  const showAnswers = $derived(revealed || attempt?.status === 'committed')
  const worked = $derived(exercise ? feedbackMaterial(document, exercise, attempt) : undefined)
  const effectiveEvent = $derived(exercise ? effectiveReviewEvents(document).find(e => e.exerciseId === exercise.id) : undefined)
  const queue = $derived(session ? sessionQueue(document.cards, document.items, session, clock.now()) : null)
  const lastSession = $derived(session ?? document.sessions.filter(s => s.learnerId === learner.id && !s.lessonAttempt).at(-1))
  const summary = $derived(lastSession ? sessionSummary(document, lastSession.id, clock.now()) : null)
  const reflection = $derived(lastSession ? sessionReflection(document, lastSession.id, clock.now()) : null)
  const sources = $derived(exercise ? document.sources.filter(s => exercise.sourceIds.includes(s.id) || worked?.sourceIds.includes(s.id)) : [])
  const newCards = $derived(document.cards.filter(c => c.learnerId === learner.id && c.status === 'new' && (!session?.rootId || document.items.find(i => i.id === c.itemId)!.sourceRootIds.includes(session.rootId))))
  let selectedNewCard = $state(untrack(() => targetCardId && document.cards.some(c => c.id === targetCardId && c.status === 'new') ? targetCardId : ''))
  const teachingCard = $derived(newCards.find(c => c.id === selectedNewCard) ?? newCards[0])
  const teachingItem = $derived(teachingCard ? document.items.find(i => i.id === teachingCard.itemId) : undefined)
  const teachingPreferences = $derived(learningPreferencesForCard(document, teachingCard?.id))
  const exercisePreferences = $derived(learningPreferencesForCard(document, card?.id))
  const material = $derived(teachingCard ? document.drafts.filter(d => d.kind === 'teaching' && d.status === 'validated' && d.cardIds.includes(teachingCard.id)).at(-1) : undefined)
  const presentedQuestion = $derived(exercise?.multipleChoice ? document.drafts.find(d => d.id === exercise.multipleChoice!.quizId)?.quiz?.questions.find(q => q.cardId === exercise.cardId && q.lessonStep === exercise.lessonStep) : undefined)
  const pendingQuiz = $derived(session ? document.drafts.filter(d => d.kind === 'quiz' && d.status === 'validated' && d.sessionId === session.id && d.quiz?.questions.some(q => !document.exercises.some(e => e.sessionId === session.id && e.multipleChoice?.quizId === d.id && e.cardId === q.cardId))).at(-1) : undefined)
  const savedQuizzes = $derived(recoverableQuizzes(document))

  let profile = $state<LearnerProfile>(untrack(() => structuredClone(learner)))
  let rootId = $state(''), resumed = $state(false), busy = $state(false), busyLabel = $state(''), error = $state(''), notice = $state('')
  const scopedLearning = $derived(rootId ? learningPreferences(document, rootId) : null)
  let answer = $state(''), optionId = $state(''), web = $state(false), extract = $state(false), refresh = $state(false)
  let practiceFocus = $state<'automatic' | 'freshContext' | 'mistakeContrast'>('automatic')
  const nextDifficulties = $derived(queue?.cards[0] ? recentReviewEvents(document, queue.cards[0].id).filter(e => e.outcome === 'notRecalled').length : 0)
  let helpConfirmation = $state<'hint' | 'reveal' | 'dontKnow' | null>(null)
  let controller: AbortController | undefined, activeTask: Promise<void> | undefined, answerTimer: ReturnType<typeof setTimeout> | undefined
  let loadedExerciseId = '', lastSavedAnswer = ''
  let questionHeading = $state<HTMLElement>(), feedbackElement = $state<HTMLElement>(), presentedView = ''
  const expression = $derived(teacherExpression({ pending: pendingRequests > 0, failed: Boolean(error || attempt?.gradingError), committed: attempt?.status === 'committed',
    disputed: Boolean(attempt?.disputed || effectiveEvent?.kind === 'correction' || effectiveEvent?.disputed), grade: attempt?.assessment?.grade, welcoming: Boolean(resumed && !exercise) }))
  const teacherPortraits = $derived(document.view.teacherPortraits ?? true)
  const editable = $derived(Boolean(exercise && resumed && !busy && !attempt))
  const canIntroduce = $derived(Boolean(queue?.canIntroduce || (teachingCard && session?.introducedItemIds.includes(teachingCard.itemId))))

  onMount(() => () => { controller?.abort(); if (answerTimer) clearTimeout(answerTimer) })
  $effect(() => { if (workspace.status === 'conflict') { controller?.abort(); resumed = false } })
  $effect(() => {
    const current = exercise
    if ((current?.id ?? '') === loadedExerciseId) return
    loadedExerciseId = current?.id ?? ''
    const savedDraft = current ? document.drafts.find(d => d.kind === 'answer' && d.exerciseId === current.id) : undefined
    const savedAttempt = current ? document.attempts.filter(a => a.exerciseId === current.id).at(-1) : undefined
    answer = savedAttempt?.answer ?? savedDraft?.text ?? ''; optionId = savedAttempt?.selectedOptionId ?? savedDraft?.selectedOptionId ?? ''
    lastSavedAnswer = JSON.stringify([loadedExerciseId, answer, optionId])
    helpConfirmation = null
  })
  $effect(() => {
    if (!resumed || !exercise) return
    const feedback = attempt?.status === 'committed'
    const target = feedback ? feedbackElement : questionHeading
    const key = `${exercise.id}:${feedback ? 'feedback' : 'question'}`
    if (!target || key === presentedView) return
    presentedView = key
    // An explicit next/submit action should reveal its result, not leave the
    // learner at the previous question's scroll position. Never run on reload.
    target.scrollIntoView({ block: 'start' })
    target.focus({ preventScroll: true })
  })
  $effect(() => {
    const id = exercise?.id, text = answer, option = optionId
    if (!id || !editable || JSON.stringify([id, text, option]) === lastSavedAnswer) return
    answerTimer = setTimeout(() => { void flushAnswer().catch(cause => { error = cause instanceof Error ? cause.message : 'Answer draft could not be saved.' }) }, 300)
    return () => { if (answerTimer) clearTimeout(answerTimer) }
  })
  async function flushAnswer() {
    if (answerTimer) clearTimeout(answerTimer)
    if (!exercise || attempt) return
    const id = exercise.id, text = answer, option = optionId, signature = JSON.stringify([id, text, option])
    if (signature === lastSavedAnswer) return
    await host.apply((snapshot, repository) => new LearningService(repository, clock).saveAnswerDraft(snapshot, id, text, nid('op'), option || undefined))
    lastSavedAnswer = signature
  }
  function work(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (busy) return Promise.resolve()
    busy = true; busyLabel = label; error = ''; notice = ''; controller = new AbortController()
    const signal = controller.signal
    activeTask = (async () => {
      try { await action(signal) } catch (cause) { error = signal.aborted ? 'Paused. Saved work is available when you return.' : cause instanceof Error ? cause.message : 'The teacher action could not complete.' }
      finally { busy = false; busyLabel = ''; controller = undefined; activeTask = undefined }
    })()
    return activeTask
  }
  async function saveProfile() {
    const validated = learnerSchema.parse({ ...profile, goal: profile.goal.trim(), explanationLanguage: profile.explanationLanguage.trim() })
    await host.apply((snapshot, repository) => repository.mutate(snapshot.version, { id: nid('op'), kind: 'learner-profile', intent: validated, at: clock.now() }, current => {
      current.learners[current.learners.findIndex(l => l.id === validated.id)] = validated
    }))
  }
  async function startOrResume() {
    await work(session ? 'Resuming saved lesson…' : 'Planning your lesson…', async () => {
      if (!session) { await saveProfile(); await host.apply((snapshot, repository) => new LearningService(repository, clock).startSession(snapshot, rootId || null)) }
      else await host.apply((snapshot, repository) => new LearningService(repository, clock).setSessionStatus(snapshot, session!.id, 'active'))
      if (attempt?.status === 'pending') await host.apply((snapshot, repository) => new LearningService(repository, clock).markGradingUnavailable(snapshot, attempt!.id, 'The previous grading request is no longer running. Retry this saved answer explicitly.'))
      resumed = true
    })
  }
  async function makeExercise(cardId: string, practice: boolean, signal: AbortSignal) {
    const currentSession = host.current().state.sessions.find(s => !s.lessonAttempt && s.status !== 'completed' && s.learnerId === learner.id)!
    const currentCard = host.current().state.cards.find(c => c.id === cardId)!
    if (currentCard.skill === 'recognition') {
      const ordered = sessionQueue(host.current().state.cards, host.current().state.items, currentSession, clock.now()).cards
      const targets: string[] = [cardId]
      if (!practice && ordered[0]?.id === cardId) for (const candidate of ordered.slice(1)) { if (targets.length >= 3 || candidate.skill !== 'recognition') break; targets.push(candidate.id) }
      const result = await teacher.draftQuiz(targets, { sessionId: currentSession.id, web, extract: web && extract, refresh, purpose: practiceFocus === 'automatic' ? undefined : practiceFocus, signal })
      notice = result.notices.join(' ')
      await teacher.presentQuizQuestion(currentSession.id, result.draft.id, 0, practice)
    } else await teacher.prepareFreeExercise(currentSession.id, cardId, practice, signal, { web, extract: web && extract, refresh, purpose: practiceFocus === 'automatic' ? undefined : practiceFocus })
  }
  async function nextReview() {
    await work('Preparing a focused question…', async signal => {
      if (!session || !resumed) throw new Error('Start or resume the lesson first.')
      await flushAnswer()
      if (exercise) await host.apply((snapshot, repository) => new LearningService(repository, clock).finishExercise(snapshot, exercise!.id))
      const currentSession = host.current().state.sessions.find(s => s.id === session!.id)!
      const waitingQuiz = host.current().state.drafts.filter(d => d.kind === 'quiz' && d.status === 'validated' && d.sessionId === currentSession.id && d.quiz?.questions.some(q => !host.current().state.exercises.some(e => e.sessionId === currentSession.id && e.multipleChoice?.quizId === d.id && e.cardId === q.cardId))).at(-1)
      if (waitingQuiz?.quiz) {
        const index = waitingQuiz.quiz.questions.findIndex(q => !host.current().state.exercises.some(e => e.sessionId === currentSession.id && e.multipleChoice?.quizId === waitingQuiz.id && e.cardId === q.cardId))
        await teacher.presentQuizQuestion(currentSession.id, waitingQuiz.id, index)
        return
      }
      const next = sessionQueue(host.current().state.cards, host.current().state.items, currentSession, clock.now()).cards[0]
      if (next && recoverableQuizzes(host.current().state).some(d => d.status !== 'validated' && d.cardIds.includes(next.id))) throw new Error('An inactive quiz already targets the next due card. Review, regenerate or discard the saved candidate below before creating another.')
      if (next) await makeExercise(next.id, false, signal)
      else notice = 'No more eligible due cards in this lesson. Check the summary or learn new material if the scoped queue is exhausted.'
    })
  }
  async function practiceCard(cardId: string) {
    await work('Preparing fresh practice…', async signal => {
      if (!session || !resumed) throw new Error('Start or resume the lesson first.')
      const sourceLessonId = exercise?.cardId === cardId ? exercise.sourceLessonId : undefined
      const roleplay = Boolean(sourceLessonId && document.drafts.some(d => d.id === sourceLessonId && d.discoveryRequest?.kind === 'roleplay') && document.cards.some(c => c.id === cardId && c.skill === 'production'))
      if (exercise) await host.apply((snapshot, repository) => new LearningService(repository, clock).finishExercise(snapshot, exercise!.id))
      // Corrective practice always uses a fresh typed prompt and cannot move the schedule.
      await teacher.prepareFreeExercise(session.id, cardId, true, signal, sourceLessonId ? { sourceLessonId, roleplay, purpose: 'mistakeContrast' } : { web, extract: web && extract, refresh, purpose: 'mistakeContrast' })
    })
  }
  async function useSavedQuiz(id: string) {
    await work('Opening the reviewed quiz without a model request…', async () => {
      if (!session || !resumed) throw new Error('Start or resume the focused lesson first.')
      await flushAnswer()
      if (exercise) await host.apply((s, r) => new LearningService(r, clock).finishExercise(s, exercise!.id))
      await teacher.useReviewedQuiz(session.id, id)
    })
  }
  async function submit() {
    await work('Answer saved first; checking the rubric…', async signal => {
      if (!exercise || !resumed) throw new Error('Resume the saved question first.')
      const exerciseId = exercise.id, submittedAt = clock.now(), id = nid('attempt'), text = answer, selected = optionId
      await flushAnswer()
      await host.apply((snapshot, repository) => new LearningService(repository, clock).submitAttempt(snapshot, { id, exerciseId, answer: text, submittedAt, ...(selected ? { selectedOptionId: selected } : {}) }))
      await teacher.gradeAttempt(id, signal)
    })
  }
  async function help() {
    if (!exercise || !helpConfirmation) return
    const id = exercise.id, aid = helpConfirmation
    await work('Saving the help request…', async () => {
      await flushAnswer()
      await host.apply((snapshot, repository) => new LearningService(repository, clock).requestHelp(snapshot, id, aid))
      helpConfirmation = null; notice = 'Help is recorded. Further answers to this question are practice, without another schedule change.'
    })
  }
  async function selfAssess(correct: boolean) {
    if (!attempt || !exercise) return
    const proposal: Assessment = { exerciseId: exercise.id, grade: correct ? 'correct' : 'incorrect', criteria: exercise.rubric.map(r => ({ criterionId: r.id, met: correct, evidence: 'The learner explicitly assessed the original saved answer against this criterion.' })), feedback: correct ? 'You marked your original answer correct. This is recorded as learner assessment.' : 'You marked your original answer incorrect. This is recorded as learner assessment.' }
    await work('Saving your explicit self-assessment…', async () => { await host.apply((snapshot, repository) => new LearningService(repository, clock).assessAttempt(snapshot, attempt!.id, proposal, { source: 'learner' })) })
  }
  async function correct(correct: boolean) {
    if (!effectiveEvent) return
    const eventId = effectiveEvent.id, beforeRevision = card!.revision
    await work('Recording a grade correction…', async () => {
      const result = await host.apply((snapshot, repository) => new LearningService(repository, clock).correctReview(snapshot, eventId, correct ? 'recalled' : 'notRecalled'))
      notice = result.state.cards.find(c => c.id === card!.id)!.revision === beforeRevision ? 'Historical dispute saved. Later progress was not rewritten.' : 'Correction recorded from the original review state and submission time.'
    })
  }
  async function skip() {
    await work('Saving the skipped question…', async () => {
      if (!exercise) return
      await flushAnswer()
      await host.apply((snapshot, repository) => new LearningService(repository, clock).finishExercise(snapshot, exercise!.id, true))
      notice = 'Skipped for this session only. The card’s schedule was not changed by skipping.'
    })
  }
  async function endSession() {
    await work('Saving your session summary…', async () => {
      await flushAnswer()
      if (session) await host.apply((snapshot, repository) => new LearningService(repository, clock).setSessionStatus(snapshot, session!.id, 'completed'))
      resumed = false; notice = 'Lesson ended. The summary below is derived from saved outcomes.'
    })
  }
  async function pauseAndClose(after = onClose) {
    controller?.abort(); await activeTask
    try {
      await flushAnswer()
      if (session) await host.apply((snapshot, repository) => new LearningService(repository, clock).setSessionStatus(snapshot, session!.id, 'paused'))
      after()
    } catch (cause) { error = `The lesson could not be safely paused. Your answer is still visible. ${cause instanceof Error ? cause.message : ''}` }
  }
  async function revealSource(nodeId: string) {
    controller?.abort(); await activeTask
    try {
      await flushAnswer()
      if (session) await host.apply((snapshot, repository) => new LearningService(repository, clock).setSessionStatus(snapshot, session!.id, 'paused'))
      onReveal(nodeId)
    } catch (cause) { error = cause instanceof Error ? cause.message : 'The lesson could not be safely paused.' }
  }
  function downloadAnswerDraft() {
    const content = { format: 'visual-language-answer-draft-recovery', warning: 'Uncommitted answer recovery, not a full workspace backup.', exerciseId: exercise?.id, answer, selectedOptionId: optionId || undefined, capturedAt: new Date().toISOString() }
    const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' })), link = window.document.createElement('a')
    link.href = url; link.download = 'visual-language-answer-draft-recovery.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
</script>

<Modal title="Daily review" onClose={() => { void pauseAndClose() }}>
  <div class="lesson">
    {#if workspace.mode === 'demo'}<p class="demo-notice">Demo · {prerecorded ? 'Sample questions' : 'Live AI'}</p>{/if}
    <header class="teacher-heading">{#if teacherPortraits}<TeacherPortrait state={expression} variant={exercise ? 'discovery' : 'lesson'} />{/if}<div><h3>{exercise ? exercise.mode === 'dueReview' && !helped ? 'Recall review' : 'Practice — no schedule change' : "Let's practice"}</h3><p class="small">{exercise ? 'Try from memory, or ask for help.' : 'Review due words, then learn something new.'}</p></div></header>
    {#if !session}
      <form id="lesson-setup" class="profile" onsubmit={event => { event.preventDefault(); void startOrResume() }}>
        <label>Learning goal<textarea bind:value={profile.goal} maxlength="2000" required disabled={busy}></textarea></label>
        <div class="columns"><label>Your Mandarin level<select bind:value={profile.level} disabled={busy}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option><option value="native">Native-level complexity</option></select></label><label>Explanation language<input bind:value={profile.explanationLanguage} maxlength="100" required disabled={busy} /></label></div>
        <details class="lesson-options"><summary>Lesson options <span class="small">· up to {scopedLearning?.maxReviewCards ?? profile.maxReviewCards} reviews / {scopedLearning?.maxNewItems ?? profile.maxNewItems} new items</span></summary><div class="options-body">
        <label>Language balance<select bind:value={profile.languageBalance} disabled={busy}><option value={undefined}>Balanced (default)</option><option value="mostlyTarget">Mostly Mandarin</option><option value="balanced">Balanced</option><option value="mostlyNative">Mostly explanation language</option></select></label>
        <div class="columns"><label>Pinyin while learning<select bind:value={profile.pinyinDisplay} disabled={busy}><option value="always">Always</option><option value="onDemand">On demand</option><option value="hidden">Hidden</option></select></label><label>Review scope<select bind:value={rootId} disabled={busy}><option value="">All topics</option>{#each document.nodes.filter(n => n.type === 'root') as root}<option value={root.id}>{root.data.name}</option>{/each}</select></label></div>
        <div class="columns"><label>Distinct due cards per lesson<input type="number" min="1" max="100" bind:value={profile.maxReviewCards} disabled={busy} /></label><label>New items after due queue is exhausted<input type="number" min="0" max="20" bind:value={profile.maxNewItems} disabled={busy} /></label></div>
        <button type="button" class="ghost" disabled={busy} onclick={() => void work('Saving portrait preference…', async () => { const next = await workspace.mutate('teacher-portrait-display', { visible: !teacherPortraits }, state => { state.view.teacherPortraits = !teacherPortraits }); onChanged(next) })}>{teacherPortraits ? 'Hide teacher portrait' : 'Show teacher portrait'}</button>
        {#if scopedLearning}<p class="small">Topic-root settings supply this lesson’s goal and limits: {scopedLearning.goal} · {scopedLearning.maxReviewCards} due reviews / {scopedLearning.maxNewItems} new items. Your workspace preferences remain separate.</p>{/if}
        </div></details>
      </form>
    {:else}
      {#if exercise}
        <section class="question" aria-label="Saved exercise">
          {#if exercise.multipleChoice}<p class="small">Saved quiz · question {document.drafts.find(d => d.id === exercise!.multipleChoice!.quizId)?.quiz?.questions.findIndex(q => q.cardId === exercise!.cardId && q.lessonStep === exercise!.lessonStep)! + 1} of {document.drafts.find(d => d.id === exercise!.multipleChoice!.quizId)?.quiz?.questions.length}</p>{/if}
          <h4 class="prompt" tabindex="-1" bind:this={questionHeading}>{presentedQuestion?.quizLevel ? presentedQuestion.stem : exercise.prompt}</h4>
          {#if presentedQuestion?.quizLevel && presentedQuestion.passage}
            {#if quizPassageLabel(presentedQuestion)}<p class="small">{quizPassageLabel(presentedQuestion)}</p>{/if}
            <p lang="zh">{presentedQuestion.passage}</p>
          {/if}
          {#if exercise.multipleChoice?.passagePinyin}<p lang="zh-Latn">{exercise.multipleChoice.passagePinyin}</p>{/if}
          <form id="lesson-answer" onsubmit={event => { event.preventDefault(); void submit() }}>
            {#if exercise.multipleChoice}
              <fieldset disabled={!editable}><legend>Choose one answer</legend>{#each exercise.multipleChoice.options as option, index}<label class="option"><input type="radio" name="quiz-answer" value={option.id} bind:group={optionId} /><span>{String.fromCharCode(65 + index)}. {option.text}{#if option.pinyin}<br /><small lang="zh-Latn">{option.pinyin}</small>{/if}</span></label>{/each}</fieldset>
            {:else}<label>Your answer<textarea bind:value={answer} maxlength="8000" rows="3" disabled={!editable} autocomplete="off" onkeydown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && editable) { event.preventDefault(); void submit() } }}></textarea></label>{/if}
          </form>
          {#if attempt}<p class="small">Original answer saved {new Date(attempt.submittedAt).toLocaleString()}. It stays unchanged during retries. {attempt.assessmentSource ? `Assessment source: ${attempt.assessmentSource}.` : ''}</p>{/if}
          {#if attempt?.assessment}<div class="feedback" role="status" tabindex="-1" bind:this={feedbackElement}><strong>{attempt.assessment.grade === 'uncertain' ? 'Assessment unresolved' : attempt.assessment.grade === 'correct' ? 'Correct' : 'Let’s work on this'}</strong><p>{attempt.assessment.feedback}</p>{#if showAnswers && attempt.assessment.correctedExample}<p>{attempt.assessment.correctedExample}</p><PinyinText text={attempt.assessment.correctedExample.length <= 4000 ? mandarinPinyin(attempt.assessment.correctedExample) : ''} mode={exercisePreferences.pinyinDisplay} label="Show correction pinyin" />{/if}</div>{/if}
          {#if attempt?.gradingError}<p class="error" role="status">{attempt.gradingError}</p>{/if}
          {#if helped && !showAnswers}<div class="feedback"><strong>Hint — ensuing answers are practice</strong><p>{card?.skill === 'production' && item?.pinyin ? `Pinyin clue: ${item.pinyin}` : `The expected answer begins with: ${[...exercise.expectedAnswer][0]}…`}</p><p class="small">{effectiveEvent ? `Help recorded one not-recalled review: box ${card!.box}, next due ${new Date(card!.dueAt!).toLocaleString()}.` : 'Practice only; no scheduling change.'}</p></div>{/if}
          {#if showAnswers}
            <div class="answer-key"><h4>Expected answer</h4><p>{exercise.expectedAnswer}</p>{#if containsHanzi(exercise.expectedAnswer)}<PinyinText text={mandarinPinyin(exercise.expectedAnswer)} mode={exercisePreferences.pinyinDisplay} /><SpeechButton text={exercise.expectedAnswer} />{/if}{#if exercise.multipleChoice}<p>{exercise.multipleChoice.explanation}</p>{/if}<p>Learning item: {item?.canonicalText} — {item?.meaning}</p>
              <p class="small">{effectiveEvent ? `${effectiveEvent.kind === 'correction' ? 'Corrected result' : 'Scheduled result'}: ${effectiveEvent.outcome === 'recalled' ? 'independent recall' : 'not recalled'} · box ${card!.box} · next review ${new Date(card!.dueAt!).toLocaleString()}` : 'Practice only: box and due date are unchanged.'}</p>
            </div>
            {#if worked}<WorkedExampleView material={worked} pinyinDisplay={exercisePreferences.pinyinDisplay} />{:else}<p class="small">This older question has no paired worked example. Its item meaning is not a translation of a longer answer or legacy correction.</p>{#if attempt?.status === 'committed'}<button type="button" class="ghost" disabled={busy} onclick={() => void work('Preparing an example without changing the saved grade…', async signal => { await teacher.explainAttempt(attempt!.id, signal) })}>Prepare worked example</button>{/if}{/if}
            <SourceList {sources} onReveal={id => { void revealSource(id) }} />
          {/if}
          {#if attempt && attempt.status !== 'committed'}<details><summary>Assess the saved answer yourself</summary><div class="actions"><button type="button" class="ghost" disabled={busy || !resumed} onclick={() => void selfAssess(true)}>I checked my answer: correct</button><button type="button" class="ghost" disabled={busy || !resumed} onclick={() => void selfAssess(false)}>I checked my answer: incorrect</button></div><p class="small">Self-assessment is labeled as yours, not as a teacher judgment. Aided answers remain practice.</p></details>{/if}
          {#if !showAnswers}<div class="actions"><button type="button" class="ghost" disabled={busy || !resumed} onclick={() => { helpConfirmation = 'hint' }}>Hint</button><button type="button" class="ghost" disabled={busy || !resumed} onclick={() => { helpConfirmation = 'reveal' }}>Reveal answer</button><button type="button" class="ghost" disabled={busy || !resumed} onclick={() => { helpConfirmation = 'dontKnow' }}>I don’t know</button></div>{/if}
          <div class="actions"><button type="button" class="ghost" disabled={busy || !resumed} onclick={skip}>Skip question</button>{#if showAnswers}{#if attempt?.status !== 'committed'}<button type="button" class="ghost" disabled={busy || !resumed} onclick={nextReview}>Next review</button>{/if}<button type="button" class="ghost" disabled={busy || !resumed} onclick={() => void practiceCard(exercise!.cardId)}>Fresh corrective practice</button>{/if}</div>
          {#if exercise.learningContext}<p class="small" data-testid="question-context">{exercise.learningContext.purpose === 'mistakeContrast' ? 'Focused contrast using recent difficulties' : 'Fresh scenario'} · {exercise.learningContext.webUsed ? 'Cites a saved web source' : 'Uses saved learning examples'}. Teacher-adapted question, not a direct source quotation.</p>{#each exercise.learningContext.notices as retrievalNotice}<p class="small" role="status">{retrievalNotice}</p>{/each}{#if exercise.learningContext.webRequested && !exercise.learningContext.webUsed && !exercise.learningContext.notices.length}<p class="small">The teacher selected saved learning context; retrieved results were not cited in this question.</p>{/if}{/if}
          <details><summary>Question details</summary><p class="small">{card?.skill} · presented {new Date(exercise.presentedAt).toLocaleString()} · {exercise.provider} / {exercise.model}</p><p class="small">{queue?.remainingDueCount ?? 0} due in scope · {queue?.outsideScopeCount ?? 0} due outside scope · limit {session.maxReviewCards} reviews / {session.maxNewItems} new items</p><button type="button" class="ghost" disabled={busy} onclick={() => void work('Saving portrait preference…', async () => { const next = await workspace.mutate('teacher-portrait-display', { visible: !teacherPortraits }, state => { state.view.teacherPortraits = !teacherPortraits }); onChanged(next) })}>{teacherPortraits ? 'Hide teacher portrait' : 'Show teacher portrait'}</button></details>
          {#if effectiveEvent}<details><summary>Dispute this result</summary><p class="small">A correction to the latest transition recomputes from its original state/time. Older disputes are flagged without rewriting later progress.</p><div class="actions"><button type="button" class="ghost" disabled={busy || helped} onclick={() => void correct(true)}>Correct result: I recalled it</button><button type="button" class="ghost" disabled={busy} onclick={() => void correct(false)}>Correct result: not recalled</button></div></details>{/if}
        </section>
      {:else if resumed}
        <section class="next-step">
          <p class="summary-line">{queue?.remainingDueCount ?? 0} reviews ready{#if queue?.outsideScopeCount} · {queue.outsideScopeCount} in other topics{/if}</p>
          {#if pendingQuiz}<p>Your saved quiz is ready to continue.</p>{:else if queue?.cards.length}<p>Start with a word that’s ready for review. Zheng will ask one question at a time.</p>{:else if queue?.remainingDueCount}<p>You have reviews left. End this session and start another to continue.</p>{:else}<p>Nothing due right now. You can learn a new saved word or practice from your library.</p>{/if}
          {#if targetCardId && document.cards.some(c => c.id === targetCardId && c.status === 'active') && !queue?.cards.some(c => c.id === targetCardId)}<button type="button" class="ghost" disabled={busy} onclick={() => void practiceCard(targetCardId!)}>Practice the selected card without changing its schedule</button>{/if}
          {#if newCards.length}
            <label>New material<select bind:value={selectedNewCard} disabled={busy}><option value="">Next saved item</option>{#each newCards as next}<option value={next.id}>{document.items.find(i => i.id === next.itemId)!.canonicalText} · {next.skill}</option>{/each}</select></label>
            {#if !canIntroduce}<p class="small">Review your due words first. If you’ve reached this session’s limit, start another session to learn more.</p>{/if}
            {#if material?.lesson && teachingItem}
              <section class="teaching-material"><h4 lang="zh">{teachingItem.canonicalText}</h4><PinyinText text={teachingItem.pinyin} mode={teachingPreferences.pinyinDisplay} /><p>{teachingItem.meaning}</p><p>{material.lesson.explanation}</p><p class="small">{material.generation?.provider === 'fixture' ? 'Example' : 'Teacher-generated example (not a direct quotation)'}</p><blockquote lang="zh">{material.lesson.exampleHanzi}</blockquote><PinyinText text={material.lesson.examplePinyin} mode={teachingPreferences.pinyinDisplay} label="Show example pinyin" /><p>{material.lesson.exampleMeaning}</p><SpeechButton text={material.lesson.exampleHanzi} />
                <SourceList sources={document.sources.filter(s => material!.sourceIds.includes(s.id))} onReveal={id => { void revealSource(id) }} />
                <p class="small">{material.generation?.provider} / {material.generation?.model} · {material.generation?.promptVersion}</p>
              </section>
            {/if}
          {/if}
        </section>
      {/if}
      {#if resumed && (!exercise || showAnswers)}
        <details class="retrieval-settings">
          <summary>Context for the next question</summary>
          <label>Question focus<select bind:value={practiceFocus} disabled={busy || prerecorded}><option value="automatic">Teacher chooses from recent reviews</option><option value="freshContext">A fresh scenario</option><option value="mistakeContrast">Contrast a recent difficulty</option></select></label>
          {#if !exercise && practiceFocus === 'automatic' && nextDifficulties >= 2}<p class="small">The next due card has repeated not-recalled reviews. Zheng will use those saved difficulties to focus the question; its place in the due queue does not change.</p>{/if}
          <label class="check"><input type="checkbox" bind:checked={web} disabled={busy || prerecorded} /> Use Tavily examples for questions and corrective practice</label>
          <p class="small">Public retrieval uses selected phrases and meanings, never your answers or private history. Sources stay hidden until feedback or explicit help.</p>
          {#if web}<label class="check"><input type="checkbox" bind:checked={extract} disabled={busy} /> Extract selected pages if useful</label><label class="check"><input type="checkbox" bind:checked={refresh} disabled={busy} /> Refresh web sources instead of using the search cache</label>{/if}
          <p class="small">Per action: up to four model calls, two searches, one extraction and one format repair within those limits. Retrieval failures can use supported saved examples, with a visible notice. No suitable example means a retry, not a failed review.</p>
          {#if !exercise}<button type="button" class="ghost" disabled={busy} onclick={() => void work('Saving portrait preference…', async () => { const next = await workspace.mutate('teacher-portrait-display', { visible: !teacherPortraits }, state => { state.view.teacherPortraits = !teacherPortraits }); onChanged(next) })}>{teacherPortraits ? 'Hide teacher portrait' : 'Show teacher portrait'}</button>{/if}
        </details>
      {/if}
      <button type="button" class="ghost" disabled={busy} onclick={endSession}>End session</button>
    {/if}
    {#if !exercise || showAnswers}<QuizRecoveryPanel drafts={savedQuizzes} {busy} {resumed} networkAllowed={!prerecorded}
      onReview={id => { void work('Reviewing the saved quiz; no new search…', async signal => { await teacher.reviewQuiz(id, signal); notice = 'Quiz content reviewed. Choose Use reviewed quiz when ready; no learner grade was recorded.' }) }}
      onRegenerate={id => { void work('Regenerating with frozen quiz sources and targets…', async signal => { await teacher.regenerateQuiz(id, signal); notice = 'Replacement reviewed and saved. The old candidate remains archived; no learning progress changed.' }) }}
      onDiscard={id => { void work('Archiving the inactive quiz…', async () => { await teacher.discardQuiz(id); notice = 'Candidate archived. Its record remains in backups; learning progress is unchanged.' }) }}
      onUse={id => { void useSavedQuiz(id) }} />{/if}
    {#if reflection && (!exercise || showAnswers)}<section class="reflection" aria-label="Zheng’s session reflection"><h3>This session</h3>{#if lastSession?.rootId}<p class="small">{reflection.scope}</p>{/if}
      {#if summary && (summary.practices || summary.introduced)}<p class="small">{#if summary.practices}{summary.practices} practice {summary.practices === 1 ? 'answer' : 'answers'}{/if}{#if summary.practices && summary.introduced} · {/if}{#if summary.introduced}{summary.introduced} new {summary.introduced === 1 ? 'word' : 'words'} learned{/if}</p>{/if}
      {#if reflection.strengthCount}<h4>Remembered without help ({reflection.strengthCount})</h4><ul>{#each reflection.strengths as observation}<li>{observation.text}{#if observation.corrected}<span class="small"> · result updated by you</span>{/if}</li>{/each}</ul>{/if}
      {#if reflection.difficultyCount}<h4>Keep practicing ({reflection.difficultyCount})</h4><ul>{#each reflection.difficulties as observation}<li>{observation.text}{#if observation.aid}<span class="small"> · reviewed with help</span>{/if}</li>{/each}</ul>{/if}
      {#if !reflection.strengthCount && !reflection.difficultyCount && !reflection.disputed && !reflection.unresolved}<p>{summary?.practices || summary?.introduced ? 'Learning saved. Review later to see what you remember.' : 'No reviews completed yet.'}</p>{/if}
      {#if reflection.disputed}<p class="small">{reflection.disputed} {reflection.disputed === 1 ? 'result is' : 'results are'} marked for rechecking.</p>{/if}
      {#if reflection.unresolved}<p class="small">{reflection.unresolved} {reflection.unresolved === 1 ? 'answer still needs' : 'answers still need'} checking.</p>{/if}
      <p>{reflection.dueInScope ? `${reflection.dueInScope} ${reflection.dueInScope === 1 ? 'review' : 'reviews'} ready.` : lastSession?.rootId ? 'Nothing due for this topic.' : 'Nothing due right now.'}{#if reflection.dueOutsideScope} <span class="small">{reflection.dueOutsideScope} more in other topics.</span>{/if}</p>
      <p><strong>Next:</strong> {reflection.nextStep}</p>
    </section>{/if}
    {#if summary}<details class="session-summary"><summary>Session details</summary><p>{summary.reviewed} reviews · {summary.recalled} remembered · {summary.notRecalled} to practice · {summary.practices} practice {summary.practices === 1 ? 'answer' : 'answers'} · {summary.introduced} new {summary.introduced === 1 ? 'word' : 'words'} · {summary.skipped} skipped</p>{#if !exercise || showAnswers}<ul>{#each summary.changes as change}<li>{change.text} · {change.skill}: {change.outcome === 'recalled' ? 'remembered' : 'to practice'}, box {change.beforeBox} → {change.afterBox}</li>{/each}</ul>{/if}<p>{summary.dueNow} reviews due now.{summary.nextDueAt ? ` Next review: ${new Date(summary.nextDueAt).toLocaleString()}.` : ''}</p></details>{/if}
    {#if lastSession}<button type="button" class="ghost" disabled={busy} onclick={() => void pauseAndClose(() => onHistory(card?.id ?? targetCardId))}>Browse saved review history</button>{/if}
  </div>
  {#snippet footer()}
    <div class="lesson-footer">
      {#if busy || notice || error}<div class="action-status">
        {#if busy}<p role="status" class="busy">{busyLabel}</p>{/if}
        {#if notice}<p role="status" class="notice">{notice}</p>{/if}
        {#if error}<p role="alert" class="error">{error}</p>{#if exercise}<button type="button" class="ghost" onclick={downloadAnswerDraft}>Download answer draft recovery</button>{/if}{/if}
      </div>{/if}
      {#if helpConfirmation && exercise && resumed}
        <div class="help-confirmation"><p>{exercise.mode === 'dueReview' ? 'Help records this review as not recalled: box 1, due one day from this help request. Further answers are practice.' : 'This is practice. Help will not change the schedule.'} Continue?</p><div class="actions"><button type="button" disabled={busy} onclick={help}>Confirm help</button><button type="button" class="ghost" disabled={busy} onclick={() => { helpConfirmation = null }}>Keep trying independently</button></div></div>
      {:else}
        <div class="primary-actions">
          <button type="button" class="ghost" onclick={() => void pauseAndClose()}>{session ? 'Pause & close' : 'Close'}</button>
          {#if !session}<button type="submit" form="lesson-setup" disabled={busy}>Start practice</button>
          {:else if !resumed}<button type="button" onclick={startOrResume} disabled={busy}>Resume practice</button>
          {:else if exercise && !attempt}<button type="submit" form="lesson-answer" disabled={!editable || (exercise.multipleChoice ? !optionId : !answer.trim())}>Submit answer</button>
          {:else if exercise && attempt?.status !== 'committed'}<button type="button" disabled={busy} onclick={() => void work('Retrying the saved answer…', async signal => { await teacher.gradeAttempt(attempt!.id, signal) })}>Retry assessment</button>
          {:else if exercise && showAnswers}<button type="button" disabled={busy} onclick={nextReview}>Next review</button>
          {:else if queue?.cards.length || pendingQuiz}<button type="button" disabled={busy} onclick={nextReview}>{pendingQuiz ? 'Continue saved quiz' : 'Review next due card'}</button>
          {:else if teachingCard && material?.lesson && teachingItem}<button type="button" disabled={busy || !canIntroduce} onclick={() => void work('Scheduling the first review…', async () => { await host.apply((snapshot, repository) => new LearningService(repository, clock).introduce(snapshot, teachingCard!.id, session!.id)); notice = 'Introduction complete: box 1, first review in one day. Immediate practice does not promote the card.' })}>Finish introduction — first review tomorrow</button>
          {:else if teachingCard}<button type="button" disabled={busy || !canIntroduce} onclick={() => void work('Preparing your introduction…', async signal => { await teacher.teach(teachingCard!.id, signal) })}>Teach this item</button>{/if}
        </div>
      {/if}
      {#if busy}<button type="button" class="ghost" onclick={() => controller?.abort()}>Cancel current request</button>{/if}
    </div>
  {/snippet}
</Modal>

<style>
  .demo-notice { color: #f0d494; border-left: 3px solid #bf984c; padding-left: 10px; font-size: 12px; }
  .reflection { display: grid; gap: 10px; padding: 14px; border: 1px solid #354154; border-radius: 9px; }.reflection ul { margin: 0; padding-left: 20px; }.reflection li { margin: 6px 0; overflow-wrap: anywhere; }
  .lesson,.profile,.next-step,.question,.teaching-material { display: grid; gap: 14px; }p,h3,h4 { margin: 0; }p { line-height: 1.5; }
  .teacher-heading { display: flex; gap: 14px; align-items: center; }.teacher-heading h3 { color: #b9d0f6; margin-bottom: 7px; }
  .small,.summary-line { font-size: 12px; color: #a9b2c4; }.summary-line { padding: 10px; background: #222b3c; border-radius: 8px; }
  .retrieval-settings { padding: 12px; border: 1px solid #3d485d; border-radius: 8px; }.retrieval-settings label,.retrieval-settings p { margin-top: 10px; }
  .lesson-options { border-top: 1px solid #354154; padding-top: 10px; }.options-body { display: grid; gap: 14px; padding-top: 14px; }summary { padding-block: 7px; }
  .lesson-footer { display: grid; gap: 10px; }.action-status { max-height: min(120px, 20dvh); overflow: auto; font-size: 13px; overflow-wrap: anywhere; }.action-status p + p { margin-top: 6px; }
  .primary-actions { display: flex; justify-content: flex-end; gap: 10px; }.primary-actions button { min-height: 44px; }.primary-actions button:not(.ghost) { flex: 1; max-width: 350px; }.teacher-heading > div { min-width: 0; }
  label { display: grid; gap: 6px; font-size: 13px; }.columns { display: flex; gap: 10px; }.columns label { flex: 1; min-width: 0; }input,select,textarea { width: 100%; padding: 9px; border: 1px solid #3d485d; border-radius: 7px; background: #111722; color: inherit; font: inherit; font-size: 16px; }
  .check { grid-template-columns: auto 1fr; align-items: center; }.check input,.option input { width: auto; }
  .prompt { white-space: pre-wrap; line-height: 1.6; font-size: 18px; }.question form { display: grid; gap: 12px; }fieldset { border: 1px solid #3d485d; border-radius: 8px; display: grid; gap: 9px; }.option { grid-template-columns: auto 1fr; align-items: center; padding: 9px; min-height: 48px; font-size: 16px; border: 1px solid #3d485d; border-radius: 7px; }.option:has(input:checked) { border-color: #a8caff; background: #263750; }
  .actions { display: flex; flex-wrap: wrap; gap: 7px; }.answer-key,.feedback,.help-confirmation,.teaching-material { padding: 14px; background: #1f2b3d; border-radius: 9px; }.answer-key,.feedback { display: grid; gap: 9px; }.help-confirmation { border: 1px solid #ba9350; }blockquote { margin: 0; padding: 8px 12px; border-left: 3px solid #7aa2f7; font-size: 19px; }.error { color: #f4a3a3; }.notice,.busy { color: #b9d0f6; }summary { cursor: pointer; color: #b9d0f6; }.session-summary { border-top: 1px solid #354154; padding-top: 12px; }.session-summary p { margin-top: 10px; }
  @media (max-width: 520px) { .columns { flex-direction: column; }.prompt { font-size: 18px; }.primary-actions button { padding: 8px; }.help-confirmation { font-size: 13px; padding: 8px; } }
</style>
