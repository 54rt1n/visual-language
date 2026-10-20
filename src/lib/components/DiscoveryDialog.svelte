<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import SourceList from './SourceList.svelte'
  import PinyinText from './PinyinText.svelte'
  import SpeechButton from './SpeechButton.svelte'
  import TeacherPortrait from './TeacherPortrait.svelte'
  import { TeacherActivity } from '../teacher/activity'
  import { teacherExpression } from '../teacher/portrait'
  import type { DiscoveryRequest } from '../domain/discovery'
  import type { Settings } from '../settings'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import { DiscoveryService } from '../teacher/discoveryService'
  import { learningPreferences } from '../graph/graphService'
  import { quizLevels } from '../domain/lessonSettings'
  import { envApiKey } from '../settings'

  let { workspace, settings, draftId, onChanged, onLesson, onDailyReview, onReveal, onSettings, onClose }: { workspace: WorkspaceState; settings: Settings; draftId?: string; onChanged: (s: WorkspaceSnapshot) => void; onLesson: (nodeId: string, sessionId?: string) => void; onDailyReview: () => void; onReveal: (nodeId: string) => void; onSettings: () => void; onClose: () => void } = $props()
  const host = untrack(() => teacherHost(workspace, onChanged)), clock = untrack(() => workspaceClock(workspace))
  let pendingRequests = $state(0)
  const activity = new TeacherActivity(count => { pendingRequests = count })
  const service = new DiscoveryService(host, () => settings, { clock, transport: activity.transport, onTavilyRequest: activity.begin,
    onProgress: stage => { label = { sources: 'Finding Mandarin examples…', planning: 'Planning useful language for your lesson…', draft: 'Writing your lesson…', review: 'Checking your lesson…' }[stage] } })
  const document = $derived(workspace.snapshot!.state)
  const drafts = $derived(document.drafts.filter(d => d.kind === 'discovery').reverse())
  let selectedId = $state(untrack(() => draftId ?? drafts[0]?.id ?? ''))
  const selected = $derived(drafts.find(d => d.id === selectedId))
  let request = $state<DiscoveryRequest>(untrack(() => ({ ...structuredClone(selected?.discoveryRequest ?? { kind: 'topic' as const, publicTopic: '', rootId: document.view.activeRootId, extract: false, refresh: false }), quizLevel: selected?.discoveryRequest?.quizLevel ?? 'meaningPinyin' })))
  let lastSaved = untrack(() => selected ? JSON.stringify(request) : '')
  const material = $derived(selected?.status === 'validated' ? selected.discovery : undefined)
  const preferences = $derived(learningPreferences(document, request.rootId))
  const prerecorded = $derived(document.demo?.enabled && document.demo.contentMode === 'fixtures')
  const editable = $derived(!material)
  const unfinished = $derived(Boolean(selected && selected.status !== 'editing' && !material))
  const createLabel = $derived(unfinished ? (selected?.sourceIds.length || selected?.discoveryPlanning) ? 'Continue creating lesson' : 'Try again' : 'Create lesson')
  let busy = $state(false), label = $state(''), error = $state(''), notice = $state('')
  const usesWeb = $derived(Boolean(settings.tavily.apiKey.trim() || envApiKey('tavily')))
  const teacherPortraits = $derived(document.view.teacherPortraits ?? true)
  const expression = $derived(teacherExpression({ pending: pendingRequests > 0, failed: Boolean(error), welcoming: true }))
  let controller: AbortController | undefined, activeTask: Promise<void> | undefined, saveTask: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const kindName = { topic: 'Topic lesson', roleplay: 'Practical role-play', interest: 'Current-interest reading' }
  onMount(() => () => { controller?.abort(); if (timer) clearTimeout(timer) })
  $effect(() => { if (workspace.status === 'conflict') controller?.abort() })
  $effect(() => {
    const signature = JSON.stringify(request)
    if (!editable || busy || signature === lastSaved || (!request.publicTopic.trim() && !selectedId)) return
    timer = setTimeout(() => { void flushRequest().catch(cause => { error = cause instanceof Error ? cause.message : 'The request could not be saved.' }) }, 300)
    return () => { if (timer) clearTimeout(timer) }
  })
  async function flushRequest(): Promise<void> {
    if (timer) clearTimeout(timer)
    if (saveTask) { await saveTask; return flushRequest() }
    if (!editable || (!request.publicTopic.trim() && !selectedId)) return
    const value = $state.snapshot(request), signature = JSON.stringify(value), id = selectedId
    if (signature === lastSaved) return
    // Editing an unfinished generated request starts a new version, preserving
    // its saved sources and candidate under the original request.
    const editingId = selected?.status === 'editing' ? id : undefined
    saveTask = (async () => { selectedId = await service.saveRequest(value, editingId || undefined); lastSaved = signature })()
    try { await saveTask } finally { saveTask = undefined }
  }
  function work(message: string, action: (signal: AbortSignal) => Promise<void>) {
    if (busy) return Promise.resolve()
    busy = true; label = message; error = ''; notice = ''; controller = new AbortController()
    const signal = controller.signal
    activeTask = (async () => {
      try { await flushRequest(); await action(signal) }
      catch (cause) { if (signal.aborted) notice = 'Paused. Your progress is saved.'; else error = cause instanceof Error ? cause.message : 'The lesson action could not complete.' }
      finally { busy = false; controller = undefined; activeTask = undefined }
    })()
    return activeTask
  }
  async function choose(id: string) {
    try {
      await flushRequest(); selectedId = id
      const value = drafts.find(d => d.id === id)?.discoveryRequest
      request = { ...structuredClone(value ?? { kind: request.kind, publicTopic: '', rootId: document.view.activeRootId, extract: false, refresh: false }), quizLevel: value?.quizLevel ?? 'meaningPinyin' }
      lastSaved = id ? JSON.stringify(request) : ''; error = ''; notice = ''
    } catch (cause) { error = cause instanceof Error ? cause.message : 'The current request could not be saved.' }
  }
  async function savePhrase(phraseId: string) {
    await work('Saving this phrase for multiple-choice practice…', async () => {
      await service.capturePhrase(selectedId, phraseId, ['recognition'])
      notice = 'Saved for practice. Zheng will introduce new words before scheduling reviews.'
    })
  }
  async function createLesson() {
    let created: { nodeId: string; sessionId: string } | undefined
    await work('Preparing your lesson topic…', async signal => {
      await service.resume(selectedId, signal)
      signal.throwIfAborted()
      created = await service.startLesson(selectedId, { quizLevel: request.quizLevel ?? 'meaningPinyin', complexity: 'simple', scope: 'everyday', focus: 'characters', topic: request.publicTopic.slice(0, 200) })
    })
    if (created) { const next = created; await close(() => onLesson(next.nodeId, next.sessionId)) }
  }
  async function close(after = onClose) {
    controller?.abort(); await activeTask
    try { await flushRequest(); after() } catch (cause) { error = `The request could not be safely saved. ${cause instanceof Error ? cause.message : ''}` }
  }
</script>

<Modal title="Explore a topic" onClose={() => void close()}>
  <div class="discovery">
    <header class="teacher-heading">{#if teacherPortraits}<TeacherPortrait state={expression} variant="discovery" />{/if}<div><h3>What would you like to learn?</h3><p class="small">Turn a topic you care about into a Mandarin lesson.</p></div></header>
    {#if prerecorded}<p class="notice">Creating your own lesson needs an AI connection. Switch to live AI in Demo options, or try the ready-made sample lesson.</p>{/if}
    {#if drafts.length}<div class="saved-lessons"><label>Saved lesson<select value={selectedId} disabled={busy} onchange={event => void choose(event.currentTarget.value)}><option value="">New lesson</option>{#each drafts as draft}<option value={draft.id}>{(draft.discovery?.title ?? draft.discoveryRequest?.publicTopic) || 'Untitled lesson'} · {draft.status === 'validated' ? 'Ready' : draft.status === 'editing' ? 'Draft' : 'Unfinished'}</option>{/each}</select></label><button type="button" class="ghost" disabled={busy} onclick={() => void choose('')}>New lesson</button></div>{/if}
    {#if !material}
      {#if unfinished && !busy && !error}<p class="notice" role="status">Your unfinished lesson is saved. Continue where you left off, or edit the topic to start a new version.</p>{/if}
      <form id="discovery-request" onsubmit={event => { event.preventDefault(); void createLesson() }}>
        <label>Lesson type<select bind:value={request.kind} disabled={busy}><option value="topic">Learn about a topic</option><option value="roleplay">Practice a scenario</option><option value="interest">Read a short passage</option></select></label>
        <label>Topic or scenario<textarea bind:value={request.publicTopic} maxlength="300" rows="2" required disabled={!editable || busy} placeholder={request.kind === 'roleplay' ? 'Ordering vegetarian food in Mandarin' : request.kind === 'interest' ? 'Recent Mandarin articles about technology' : 'Ordering tea in Mandarin'}></textarea></label>
        <label>Quiz level<select bind:value={request.quizLevel} disabled={busy}>{#each Object.entries(quizLevels) as [value, title]}<option {value}>{title}</option>{/each}</select></label>
        <details class="search-options"><summary>More options</summary><div class="options-body">
          <label>Save in topic<select bind:value={request.rootId} disabled={!editable || busy}>{#each document.nodes.filter(n => n.type === 'root') as root}<option value={root.id}>{root.data.name}</option>{/each}</select></label>
          {#if usesWeb}<label class="check"><input type="checkbox" bind:checked={request.extract} disabled={busy} /> Read full source pages when useful</label><label class="check"><input type="checkbox" bind:checked={request.refresh} disabled={busy} /> Get fresh search results</label>{/if}
          {#if usesWeb && request.kind === 'interest'}<p class="small">Web readings use dated sources from the last 30 days.</p>{/if}
        </div></details>
      </form>
    {/if}
    {#if material && selected}
      <article aria-label="Reviewed discovery lesson">
        <p class="small">{kindName[request.kind]}</p>
        <h3>{material.title}</h3><p>{material.explanation}</p>
        {#if selected.text}<p class="notice">{selected.text}</p>{/if}
        <section class="adaptation"><h4>{selected.sourceIds.some(id => document.sources.some(s => s.id === id && s.kind === 'web')) ? 'Adapted Mandarin reading' : 'AI-written Mandarin practice'}</h4><p lang="zh">{material.passageHanzi}</p><PinyinText text={material.passagePinyin} mode={preferences.pinyinDisplay} /><p>{material.passageMeaning}</p><SpeechButton text={material.passageHanzi} /></section>
        <SourceList sources={document.sources.filter(s => selected!.sourceIds.includes(s.id))} onReveal={id => void close(() => onReveal(id))} />
        {#if material.roleplay}<section class="adaptation"><h4>Simulated role-play</h4><p>{material.roleplay.situation}</p><p>Zheng: {material.roleplay.teacherRole} · You: {material.roleplay.learnerRole}</p><p lang="zh">{material.roleplay.openingHanzi}</p><p>{material.roleplay.openingMeaning}</p><p>{material.roleplay.objective}</p><p class="small">Practice language, not live menu availability, dietary guarantees or other changing facts.</p></section>{/if}
        <p>Your lesson will use these phrases for examples, practice and a multiple-choice check.</p>
        <div class="phrase-list">
        {#each material.phrases as phrase}
          {@const capture = material.captures.find(c => c.phraseId === phrase.id)}
          <section class="phrase" aria-label={`Proposed phrase ${phrase.hanzi}`}><h4 lang="zh">{phrase.hanzi}</h4><PinyinText text={phrase.pinyin} mode={preferences.pinyinDisplay} /><p>{phrase.meaning}</p><p>{phrase.explanation}</p><p lang="zh">{phrase.exampleHanzi}</p><PinyinText text={phrase.examplePinyin} mode={preferences.pinyinDisplay} /><p>{phrase.exampleMeaning}</p><SpeechButton text={phrase.exampleHanzi} />
            <button type="button" class="ghost save-phrase" disabled={busy || Boolean(capture)} onclick={() => void savePhrase(phrase.id)}>{capture ? 'Saved for practice:' : 'Save for practice:'} {phrase.hanzi}</button>

          </section>
        {/each}
        </div>
        <div class="actions"><button type="button" class="ghost" disabled={busy} onclick={() => void close(() => onReveal(material.nodeId))}>Reveal lesson on graph</button><button type="button" class="ghost" disabled={busy} onclick={() => void close(onDailyReview)}>Daily review</button></div>
      </article>
    {/if}
  </div>
  {#snippet footer()}
    <div class="discovery-footer">
      <div class="action-status">{#if busy}<p role="status">{label}</p>{/if}{#if notice}<p role="status" class="notice">{notice}</p>{/if}{#if error}<p role="alert" class="error">We couldn’t finish your lesson. You can try again or edit the topic.</p><details><summary>Details</summary><p class="small">{error}</p><button type="button" class="ghost" onclick={() => void close(onSettings)}>AI connection</button></details>{/if}</div>
      <div class="footer-actions">
        <button type="button" class="ghost" onclick={() => void close()}>Close</button>
        {#if busy}<button type="button" onclick={() => controller?.abort()}>Pause</button>
        {:else if !material}<button type="submit" form="discovery-request" disabled={prerecorded || !request.publicTopic.trim()}>{createLabel}</button>
        {:else}<button type="button" onclick={() => void createLesson()}>Continue to lesson</button>{/if}
      </div>
    </div>
  {/snippet}
</Modal>

<style>
  .discovery,form,article,.adaptation,.phrase,.phrase-list { display: grid; gap: 13px; }p,h3,h4 { margin: 0; }p { line-height: 1.5; white-space: pre-wrap; }
  .discovery-footer,.options-body { display: grid; gap: 12px; }.options-body { padding-top: 12px; }.footer-actions { display: flex; gap: 10px; }.footer-actions button { min-height: 44px; }.footer-actions button:last-child { flex: 1; }.action-status { max-height: min(120px, 20dvh); overflow: auto; }.action-status:empty { display: none; }summary { cursor: pointer; color: #c4d7f5; font-size: 13px; }.search-options { border-top: 1px solid #354154; padding-top: 14px; }
  .saved-lessons { display: flex; align-items: end; gap: 10px; }.saved-lessons label { flex: 1; min-width: 0; }.saved-lessons button { min-height: 44px; }.phrase-list { scroll-margin-top: 16px; }
  .teacher-heading { display: flex; gap: 14px; align-items: center; }
  .small { color: #a9b2c4; font-size: 12px; }.notice { color: #c4d7f5; font-size: 13px; }.error { color: #f4a3a3; }
  label { display: grid; gap: 6px; font-size: 13px; }input,textarea,select { width: 100%; padding: 9px; border: 1px solid #3d485d; border-radius: 7px; background: #111722; color: inherit; font: inherit; }
  .check { grid-template-columns: auto 1fr; align-items: center; }.check input { width: auto; }
  .actions { display: flex; flex-wrap: wrap; gap: 9px; align-items: end; }.adaptation,.phrase { padding: 14px; background: #1f2b3d; border-radius: 9px; }.phrase { border-left: 3px solid #ba985c; }article { border-top: 1px solid #3d485d; padding-top: 18px; }
  @media(max-width: 520px) { .actions { align-items: stretch; }.actions>* { width: 100%; } }
</style>
