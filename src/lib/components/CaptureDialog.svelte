<script lang="ts">
  import { untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import SpeechButton from './SpeechButton.svelte'
  import { mandarinChunks, mandarinPinyin, containsHanzi } from '../mandarin/chineseParser'
  import { LearningService } from '../learning/learningService'
  import { workspaceClock } from '../teacher/host'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import type { LearningItem, Skill } from '../domain/learning'
  import { originalSrsSchema } from '../domain/original'
  import type { ReadingCaptureDetails } from '../graph/uiContext'
  import DictionaryAttribution from './DictionaryAttribution.svelte'

  let { workspace, sourceNodeId, selectedText = '', selectedMeaning = '', readingDetails, onSaved, onClose }: { workspace: WorkspaceState; sourceNodeId?: string; selectedText?: string; selectedMeaning?: string; readingDetails?: ReadingCaptureDetails; onSaved: (snapshot: WorkspaceSnapshot) => void; onClose: () => void } = $props()
  const source = $derived(workspace.snapshot?.state.nodes.find(n => n.id === sourceNodeId))
  const sourceText = $derived(source && 'text' in source.data ? source.data.text : '')
  const learningWord = $derived(source?.type === 'chunk' && Boolean(source.data.wordSource))
  const chunks = $derived.by(() => { try { return mandarinChunks(sourceText) } catch { return [] } })
  let text = $state(untrack(() => selectedText || (learningWord ? sourceText : chunks[0]?.text) || ''))
  let meaning = $state(untrack(() => selectedMeaning || (source?.type === 'chunk' ? source.data.meaning : ''))), sense = $state(''), kind = $state<LearningItem['kind']>(untrack(() => readingDetails?.dictionary || learningWord ? 'word' : 'phrase'))
  let production = $state(false), recognition = $state(true), meaningRecall = $state(false), busy = $state(false), error = $state('')
  let sameSelection = $state(true)
  const dictionary = $derived(sameSelection ? readingDetails?.dictionary : undefined)
  const matchingSource = $derived(source && 'text' in source.data && text.trim() && source.data.text.includes(text.trim()) ? source : undefined)
  const pinyin = $derived(sameSelection && readingDetails?.pinyin ? readingDetails.pinyin : source?.type === 'chunk' && source.data.wordSource && text === source.data.text ? source.data.pinyin : text.length <= 1000 ? mandarinPinyin(text) : '')
  const practiceSummary = $derived([production && 'type Mandarin', recognition && 'multiple choice', meaningRecall && 'explain the meaning'].filter(Boolean).join(' · ') || 'choose at least one')
  function changeText(value: string) {
    if (value.trim() !== selectedText.trim()) {
      // Do not attach a previous word's dictionary meaning or pronunciation to
      // new text. Preserve independently edited learner wording, but clear a seed.
      if (sameSelection && meaning === selectedMeaning) meaning = ''
      sameSelection = false
    }
    text = value
  }
  async function save() {
    busy = true; error = ''
    try {
      if (!containsHanzi(text) || !meaning.trim()) throw new Error('Enter a Mandarin span and its specific meaning before saving.')
      const skills: Skill[] = [...(production ? ['production' as const] : []), ...(recognition ? ['recognition' as const] : []), ...(meaningRecall ? ['meaning' as const] : [])]
      if (!skills.length) throw new Error('Choose at least one assessed skill.')
      const snapshot = await workspace.apply((current, repository) => new LearningService(repository, workspaceClock(workspace)).addItem(current, {
        language: 'zh', kind, canonicalText: text.trim(), pinyin, meaning: meaning.trim(), senseKey: sense.trim() || meaning.trim(),
        sourceNodeIds: matchingSource ? [matchingSource.id] : [], sourceRootIds: [source?.rootId ?? current.state.view.activeRootId],
        ...(dictionary ? { dictionarySources: [dictionary] } : {}),
        ...(matchingSource?.type === 'chunk' && matchingSource.data.text.trim() === text.trim() && matchingSource.data.originalVocabulary ? { originalSrs: originalSrsSchema.strip().parse(matchingSource.data.originalVocabulary) } : {}),
      }, skills, undefined, undefined, sameSelection && readingDetails && sourceNodeId ? { nodeId: sourceNodeId, sourceText: readingDetails.sourceText, start: readingDetails.start, end: readingDetails.end } : undefined))
      onSaved(snapshot); onClose()
    } catch (cause) { error = cause instanceof Error ? cause.message : 'The item could not be saved. Your edits are still here.' }
    finally { busy = false }
  }
</script>
<Modal title="Save for practice" onClose={() => { if (!busy) onClose() }}>
  <form id="capture-word-form" onsubmit={event => { event.preventDefault(); void save() }} class="capture">
    <p>{selectedText ? 'Keep this word or phrase for practice with Zheng.' : 'Save a Mandarin word or short phrase you want to learn.'}</p>
    <label>Mandarin word or phrase<textarea value={text} oninput={event => changeText(event.currentTarget.value)} maxlength="1000" rows="2" required disabled={busy}></textarea></label>
    {#if pinyin}<p class="pinyin" lang="zh-Latn">{pinyin}</p>{/if}
    <label>Meaning in this context<textarea bind:value={meaning} maxlength="4000" rows="2" required disabled={busy} placeholder="What does this specific use mean?"></textarea></label>
    {#if dictionary}<p class="notice">You chose this dictionary meaning and pronunciation. Check that they fit your sentence; you can edit the meaning before saving.</p><DictionaryAttribution citations={[dictionary]} {meaning} />
    {:else if selectedMeaning && sameSelection}<p class="notice">Check that this suggested meaning fits your sentence. You can edit it before saving.</p>{/if}
    {#if readingDetails?.dictionary && !sameSelection}<p class="notice">The word changed, so the previous dictionary citation and pronunciation no longer apply. Check the meaning before saving.</p>{/if}
    <SpeechButton {text} disabled={busy || !containsHanzi(text)} />
    <details class="practice-options"><summary>Practice options <span>· {practiceSummary}</span></summary><div class="options-body">
      <fieldset disabled={busy}><legend>How would you like to practice?</legend>
        <label class="check"><input type="checkbox" bind:checked={production} /> Type the Mandarin answer</label>
        <label class="check"><input type="checkbox" bind:checked={recognition} /> Choose an answer (multiple choice)</label>
        <label class="check"><input type="checkbox" bind:checked={meaningRecall} /> Explain the meaning</label>
      </fieldset>
      <p class="notice">Each selected skill has its own review schedule.</p>
      <label>Item type<select bind:value={kind} disabled={busy}><option value="word">Word</option><option value="phrase">Phrase / chunk</option><option value="grammar">Grammar concept</option></select></label>
      <label>Sense / distinction<input bind:value={sense} maxlength="1000" disabled={busy} placeholder="Optional: distinguish another use of the same word" /></label>
    </div></details>
    {#if chunks.length}<details><summary>Choose from this response</summary><p class="notice">These suggestions are whole Chinese phrases. Edit the text above to keep just the part you want.</p><div class="chunks" aria-label="Suggested Hanzi chunks">{#each chunks as chunk}<button type="button" class="ghost" onclick={() => { sameSelection = false; text = chunk.text; meaning = ''; sense = '' }} disabled={busy}>{chunk.text}</button>{/each}</div></details>{/if}
    <p class="notice">Zheng will introduce your saved word before scheduling reviews.</p>
  </form>
  {#snippet footer()}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    <div class="save-actions"><button type="button" class="ghost" disabled={busy} onclick={onClose}>Cancel</button><button type="submit" form="capture-word-form" disabled={busy}>{busy ? 'Saving…' : 'Save for practice'}</button></div>
  {/snippet}
</Modal>
<style>
  .capture { display: grid; gap: 14px; } p { margin: 0; line-height: 1.5; } label { display: grid; gap: 6px; font-size: 13px; }
  input, textarea, select { width: 100%; padding: 9px; background: #111722; color: inherit; border: 1px solid #3d485d; border-radius: 7px; font: inherit; font-size: 16px; }
  .chunks { display: flex; gap: 6px; flex-wrap: wrap; max-height: 130px; overflow: auto; } .pinyin { color: #b9d0f6; }
  fieldset { border: 1px solid #3d485d; border-radius: 8px; display: grid; gap: 8px; }.check { grid-template-columns: auto 1fr; align-items: center; }.check input { width: auto; }
  .notice { color: #a9b2c4; font-size: 12px; }.error { color: #f4a3a3; margin-bottom: 10px; }
  summary { cursor: pointer; color: #b9d0f6; padding-block: 8px; } summary span { font-size: 12px; color: #a9b2c4; }.options-body { display: grid; gap: 14px; padding-top: 10px; }.practice-options { border-top: 1px solid #354154; padding-top: 6px; }
  .save-actions { display: flex; justify-content: flex-end; gap: 10px; }.save-actions button { min-height: 44px; }.save-actions button[type=submit] { flex: 1; max-width: 260px; }
</style>
