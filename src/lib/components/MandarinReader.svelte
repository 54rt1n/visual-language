<script lang="ts">
  import { getContext, onMount, tick, untrack } from 'svelte'
  import { CANVAS_UI, type CanvasUI } from '../graph/uiContext'
  import { readingSelection, readingPage, type ReadingToken } from '../mandarin/reading'
  import type { SavedDraft } from '../domain/workspace'
  import { Play, Square } from '@lucide/svelte'
  import { lookupConciseDefinition } from '../mandarin/dictionary'
  import { loadReadingLexicon, type ReadingLexicon } from '../mandarin/lexicon'
  import { pronunciationFor, pronunciationOverlay } from '../mandarin/pronunciation'
  import type { OriginalWordSegment } from '../domain/original'
  import { originalReadingTokens } from '../mandarin/originalReading'
  import { startReadingModel, readingModelState, analyzeReading } from '../mandarin/readingModel'
  import type { LocalPronunciation } from '../mandarin/readingModelInput'
  import { speakMandarin } from '../mandarin/tts'

  let { nodeId, text, originalWordSegments, focused = false, showControls = true, autoPlayWords = true, plain = $bindable(false), pinyinOverride = $bindable<boolean | undefined>() }: { nodeId: string; text: string; originalWordSegments?: OriginalWordSegment[]; focused?: boolean; showControls?: boolean; autoPlayWords?: boolean; plain?: boolean; pinyinOverride?: boolean } = $props()
  const ui = getContext<CanvasUI>(CANVAS_UI)
  let importedView = $state(false)
  const importedTokens = $derived(originalReadingTokens(text, originalWordSegments ?? []))
  let pageCursor = $state<{ source: string; starts: number[]; index: number }>(), wordText = $state<HTMLDivElement>()
  const pageIndex = $derived(pageCursor?.source === text ? pageCursor.index : 0)
  const pageStarts = $derived(pageCursor?.source === text ? pageCursor.starts : [0])
  let selected = $state<{ source: string; start: number; end: number } | null>(null)
  let error = $state(''), busy = $state(false), sequence = 0
  let details = $state<HTMLElement>(), readerElement = $state<HTMLDivElement>()
  let lastSource: string | undefined
  let lexicon = $state<ReadingLexicon>(), dictionaryLoading = $state(true), dictionaryError = $state('')
  let localReadings = $state<Map<number, LocalPronunciation>>(new Map()), localSource = $state('')
  let speechController: AbortController | undefined, speakingWord = $state(''), speechError = $state('')
  let focusedMeaning = $state<{ meaning: string; pinyin?: string; kind?: 'exact' | 'components' } | null>(null)
  let focusedMeaningLoading = $state(false), focusedMeaningError = $state('')
  const localOverlay = $derived(localSource === text && $readingModelState.phase === 'ready' && !importedView ? localReadings : new Map<number, LocalPronunciation>())
  const split = $derived(readingPage(text, pageStarts[pageIndex] ?? 0, 1600, lexicon))
  let savedNotes = $state<SavedDraft[]>([])
  let lastPlain = plain
  const overlay = $derived(pronunciationOverlay(savedNotes))
  // Trim only the display's leading whitespace, not the source used by word offsets.
  const contentStart = $derived(text.length - text.trimStart().length)
  const displayedTokens = $derived(split.tokens.filter(token => token.end > contentStart).map(token => ({ ...token, ...pronunciationFor(token.text, token.start, token.pinyin, overlay, localOverlay) })))
  const withPinyin = $derived(pinyinOverride ?? ui.pinyinDisplay(nodeId) === 'always')
  const selection = $derived(selected?.source === text ? readingSelection(text, selected.start, selected.end) : null)
  const selectedPronunciation = $derived.by(() => {
    if (!selection) return null
    const current = pronunciationFor(selection.text, selection.start, selection.pinyin, overlay, localOverlay)
    const original = importedView ? originalWordSegments?.find(segment => segment.startIndex === selection.start && segment.endIndex === selection.end) : undefined
    return original && current.source !== 'model' ? { pinyin: original.pinyin ?? '', source: 'original' } : current
  })
  const pronunciationLabel = (source?: string) => source === 'original' ? 'Imported pinyin · not rechecked' : source === 'model' ? 'Saved AI contextual pinyin' : source === 'mixed' ? 'Automatic/local and saved AI pinyin' : source === 'local' ? 'Local contextual pinyin · Taiwan model' : source === 'local-mixed' ? 'Automatic + local contextual pinyin · Taiwan model' : 'Automatic pinyin'
  const words = $derived((importedView ? importedTokens : split.tokens).filter(t => t.hanzi))

  function present(element: HTMLElement) {
    if (typeof element.showPopover === 'function') element.showPopover()
    else {
      // Older browsers still get an unscaled inspector outside the graph transform.
      element.removeAttribute('popover')
      document.getElementById('app')?.appendChild(element)
      return { destroy() { element.remove() } }
    }
  }

  function close(focus = false) {
    const start = selected?.start
    const focusStart = start === undefined ? undefined : words.find(word => word.start <= start && word.end > start)?.start ?? start
    sequence++; speechController?.abort(); selected = null; error = ''; busy = false; speakingWord = ''; speechError = ''
    focusedMeaning = null; focusedMeaningLoading = false; focusedMeaningError = ''
    if (focus && focusStart !== undefined) void tick().then(() => (readerElement?.querySelector<HTMLElement>(`[data-word-start="${focusStart}"]`) ?? readerElement?.querySelector<HTMLElement>('.word-text'))?.focus({ preventScroll: true }))
  }
  $effect(() => {
    const source = text
    untrack(() => {
      // A saved explanation replaces the workspace object, not this source text.
      // Do not close the reader or reset its page for an unrelated note write.
      if (lastSource === source) return
      lastSource = source; close(); pageCursor = undefined
    })
  })
  $effect(() => {
    const current = plain
    untrack(() => {
      if (current === lastPlain) return
      lastPlain = current; importedView = false; close()
    })
  })
  $effect(() => {
    void ui.readingRevision(); void lexicon
    let current = true
    savedNotes = []
    void ui.savedReadings(nodeId, text).then(notes => { if (current) savedNotes = notes }).catch(() => {})
    return () => { current = false }
  })
  onMount(() => {
    startReadingModel()
    let mounted = true
    void loadReadingLexicon().then(value => { if (mounted) lexicon = value })
      .catch(() => { if (mounted) dictionaryError = 'The local word dictionary could not load. Basic word view is available; reconnect and reload to try the dictionary again.' })
      .finally(() => { if (mounted) dictionaryLoading = false })
    return () => { mounted = false; speechController?.abort() }
  })

  function acceptLocal(source: string, results: LocalPronunciation[]) {
    if (source !== text) return
    const next = localSource === source ? new Map(localReadings) : new Map<number, LocalPronunciation>()
    for (const result of results) if (source.slice(result.start, result.end) === result.text) next.set(result.start, result)
    while (next.size > 2048) next.delete(next.keys().next().value!)
    // Session-only view analysis; never replace saved pinyin or source records.
    localSource = source; localReadings = next
  }
  $effect(() => {
    const source = text, current = selection, enabled = $readingModelState.phase === 'ready' && !importedView && !plain
    if (!enabled || !current) return
    const controller = new AbortController()
    void analyzeReading(source, [{ start: current.start, end: current.end }], controller.signal, results => acceptLocal(source, results), true)
      .catch(() => {}) // Basic pinyin remains available if optional inference fails.
    return () => controller.abort()
  })
  $effect(() => {
    const element = wordText, source = text, tokens = split.tokens, enabled = withPinyin && $readingModelState.phase === 'ready' && !plain && !importedView && !dictionaryLoading
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return
    const visible = new Set<number>(); let timer: ReturnType<typeof setTimeout>, controller: AbortController | undefined
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) { const start = Number((entry.target as HTMLElement).dataset.wordStart); if (entry.isIntersecting) visible.add(start); else visible.delete(start) }
      clearTimeout(timer)
      timer = setTimeout(() => {
        controller?.abort(); controller = new AbortController()
        // Only visible text asks for inference, never every mounted graph node.
        let count = 0
        const ranges = tokens.filter(token => visible.has(token.start) && (count += [...token.text].length) <= 256 && token.text.length <= 200).map(({ start, end }) => ({ start, end }))
        if (ranges.length) void analyzeReading(source, ranges, controller.signal, results => acceptLocal(source, results)).catch(() => {})
      }, 200)
    })
    element.querySelectorAll('[data-word-start]').forEach(word => observer.observe(word))
    return () => { observer.disconnect(); clearTimeout(timer); controller?.abort() }
  })

  async function choose(start: number, end: number, focusDetails = false) {
    try { readingSelection(text, start, end) } catch (cause) { error = cause instanceof Error ? cause.message : 'Choose a shorter phrase.'; return }
    close(); selected = { source: text, start, end }; const request = ++sequence; focusedMeaningLoading = true
    await tick()
    if (sequence !== request) return
    if (!focused && details) {
      details.scrollTop = 0
      if (typeof details.showPopover === 'function' && !details.matches(':popover-open')) details.showPopover()
    }
    try {
      {
        const saved = await ui.savedReading(nodeId, text, start, end)
        if (sequence !== request) return
        if (saved?.reading) focusedMeaning = { meaning: saved.reading.meaning, pinyin: saved.reading.pinyin }
        else {
          const definition = await lookupConciseDefinition(text.slice(start, end))
          if (sequence !== request) return
          if (definition) focusedMeaning = definition
          else focusedMeaningError = 'No local dictionary definition found.'
        }
      }
    } catch (cause) {
      if (sequence === request) {
        const message = cause instanceof Error ? cause.message : 'The definition could not be loaded.'
        if (focused) focusedMeaningError = message
        else error = message
      }
    } finally {
      if (sequence === request) {
        focusedMeaningLoading = false
        if (!focused && focusDetails) { await tick(); details?.focus({ preventScroll: true }) }
      }
    }
  }
  function selectWord(event: MouseEvent, token: ReadingToken) {
    event.stopPropagation()
    const start = event.shiftKey && selected ? Math.min(token.start, selected.start) : token.start
    const end = event.shiftKey && selected ? Math.max(token.end, selected.end) : token.end
    void choose(start, end, true)
    if (autoPlayWords) void speakWord(text.slice(start, end))
  }
  function hoverWord(event: PointerEvent, token: ReadingToken) {
    if (event.pointerType !== 'mouse' || event.buttons || event.shiftKey || !ui.hoverToExplore() || ui.concealed()) return
    if (selected?.source === text && selected.start === token.start && selected.end === token.end) return
    void choose(token.start, token.end)
  }
  async function speakWord(word: string) {
    speechController?.abort()
    const request = new AbortController(); speechController = request; speakingWord = word; speechError = ''
    try { await speakMandarin(word, request.signal) }
    catch (error) { if (!request.signal.aborted) speechError = error instanceof Error ? error.message : 'Word audio could not play.' }
    finally { if (speechController === request) { speechController = undefined; speakingWord = '' } }
  }
  async function turnPage(direction: -1 | 1) {
    if (direction < 0 && pageIndex === 0 || direction > 0 && split.end >= text.length) return
    close()
    pageCursor = { source: text, starts: direction > 0 ? [...pageStarts.slice(0, pageIndex + 1), split.end] : pageStarts, index: pageIndex + direction }
    await tick()
    if (!focused) await ui.ensureNodeVisible(nodeId)
    if (wordText) { wordText.scrollTop = 0; wordText.focus({ preventScroll: true }) }
  }
  function saveForPractice() {
    if (!selection) return
    const current = selection
    ui.saveForPractice(nodeId, current.text, focusedMeaning?.kind === 'components' ? '' : focusedMeaning?.meaning ?? '', {
      sourceText: text, start: current.start, end: current.end, pinyin: selectedPronunciation?.pinyin ?? current.pinyin,
    })
    close()
  }
  const savedForPractice = $derived(Boolean(selection && ui.isSavedForPractice(nodeId, selection.text)))
  async function addWord() {
    if (!selection || busy) return
    const current = selection, request = sequence
    busy = true; error = ''
    try {
      await ui.addLearningWord(nodeId, text, current.start, current.end, selectedPronunciation?.pinyin ?? current.pinyin)
      if (sequence === request) close()
    } catch (cause) { if (sequence === request) error = cause instanceof Error ? cause.message : 'The word could not be saved.' }
    finally { if (sequence === request) busy = false }
  }

</script>

<svelte:window onkeydown={event => { if (event.key === 'Escape' && details?.contains(document.activeElement)) { event.preventDefault(); event.stopPropagation(); close(true) } }} />

<!-- Keep the reader's chrome draggable with its node; only controls and bounded
     reading/inspection regions opt out. A grab cursor must not be a dead zone. -->
<div class="reader nopan nowheel" bind:this={readerElement}>
  {#if focused && originalWordSegments !== undefined}<div class="reading-toolbar focused-import-controls">
    <button type="button" class="ghost nodrag" aria-pressed={importedView} onclick={() => { importedView = !importedView; close() }}>{importedView ? 'Current word view' : 'Original segments'}</button>
  </div>{/if}
  {#if plain}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (A labeled scroll region needs keyboard focus; W3C ACT 0ssw9k.) -->
    <div class="original nodrag" role="region" aria-label="Original response text" tabindex="0">{text}</div>
  {:else if importedView}
    <p class="reading-hint">Imported boundaries and pinyin are preserved, not rechecked. The original may group a whole passage as one segment. Use Current word view to explore smaller words.</p>
    {#if !originalWordSegments?.length}<p class="reading-hint">No segment records were supplied in the original.</p>{/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (A labeled, bounded reading region needs keyboard scrolling.) -->
    <div class="word-text original-segments nodrag" class:with-pinyin={withPinyin} role="region" tabindex="0" aria-label="Imported Mandarin segments">
      {#each importedTokens as token (token.start)}{#if token.hanzi && token.text.length <= 200}<button type="button" class="word" data-word-start={token.start} aria-label={focused && autoPlayWords ? `Play ${token.text}` : `Explore imported segment ${token.text}`} onpointerenter={event => hoverWord(event, token)} onclick={event => selectWord(event, token)}><ruby>{token.text}{#if withPinyin && token.pinyin}<rt title="Imported pinyin · not rechecked">{token.pinyin}</rt>{/if}</ruby></button>{:else if token.imported}<span class="original-segment"><span lang="zh">{token.text}</span>{#if withPinyin && token.pinyin}<span class="original-sound" lang="zh-Latn">{token.pinyin}</span>{/if}</span>{:else}{token.text}{/if}{/each}
    </div>
  {:else if dictionaryLoading}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keep the loading fallback keyboard-scrollable too.) -->
    <div class="original nodrag" role="region" aria-label="Original response text" tabindex="0">{text}</div>
  {:else}
    {#if dictionaryError}<p class="reading-hint" role="status">{dictionaryError}</p>{/if}
    {#if !focused}<p class="reading-hint">Select a word to understand it or save it for practice. Shift-click another word to select a phrase.{#if !split.wordsAvailable} Word splitting is unavailable in this browser; characters are shown instead.{/if}</p>{:else if !split.wordsAvailable}<p class="reading-hint">Word splitting is unavailable in this browser; characters are shown instead.</p>{/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard scrolling and page-turn focus use this labeled region, not a fake button role.) -->
    <div class="word-text nodrag" class:with-pinyin={withPinyin} role="region" tabindex="0" aria-label="Mandarin response word view" bind:this={wordText}>
      {#each displayedTokens as token (token.start)}{#if token.hanzi}<button type="button" class="word" class:active={selected && token.start >= selected.start && token.end <= selected.end} data-word-start={token.start} aria-label={focused && autoPlayWords ? `Play ${token.text}` : `Explore ${token.text}`} aria-pressed={Boolean(selected && token.start >= selected.start && token.end <= selected.end)} onpointerenter={event => hoverWord(event, token)} onclick={event => selectWord(event, token)}><ruby>{token.text}{#if withPinyin && token.pinyin}<rt title={pronunciationLabel(token.source)}>{token.pinyin}</rt>{/if}</ruby></button>{:else}{token.text}{/if}{/each}
    </div>
    {#if pageIndex > 0 || split.end < text.length}<nav class="reading-pages" aria-label="Response parts"><button type="button" class="ghost nodrag" disabled={pageIndex === 0} onclick={() => void turnPage(-1)}>Previous part</button><span role="status">Part {pageIndex + 1}{split.end === text.length ? ' · end' : ''}</span><button type="button" class="ghost nodrag" disabled={split.end === text.length} onclick={() => void turnPage(1)}>Next part</button></nav>{#if !focused}<p class="reading-hint">Read this part by scrolling inside the text. Plain text shows the complete original response.</p>{/if}{/if}
  {/if}
  {#if !focused && showControls}<details class="reading-controls nodrag nopan">
    <summary>Reading controls</summary>
    <div class="reading-toolbar">
      <span>{plain ? 'Original text' : importedView ? 'Preserved original breakdown' : dictionaryLoading ? 'Preparing word view…' : lexicon ? 'Word view' : split.wordsAvailable ? 'Basic word view' : 'Character view'}</span>
      <button type="button" class="ghost" aria-pressed={plain} onclick={() => { plain = !plain; importedView = false; close() }}>{plain ? 'Word view' : 'Plain text'}</button>
      {#if originalWordSegments !== undefined}<button type="button" class="ghost" aria-pressed={importedView} onclick={() => { importedView = !importedView; plain = false; close() }}>{importedView ? 'Current word view' : 'Original segments'}</button>{/if}
      {#if !plain}<button type="button" class="ghost" aria-pressed={withPinyin} onclick={() => { pinyinOverride = !withPinyin }}>{withPinyin ? 'Hide pinyin' : 'Show pinyin'}</button>{/if}
    </div>
  </details>{/if}
  {#if focused && selection}
    <section class="focused-definition nodrag" aria-label="Selected word definition">
      <div class="focused-word"><strong lang="zh">{selection.text}</strong><span lang="zh-Latn">{selectedPronunciation?.pinyin || focusedMeaning?.pinyin}</span></div>
      {#if focusedMeaningLoading}<p role="status">Finding a definition…</p>{:else if focusedMeaning}<p class:component-definition={focusedMeaning.kind === 'components'}>{focusedMeaning.meaning}</p>{:else if focusedMeaningError}<p class="reading-error" role="status">{focusedMeaningError}</p>{/if}
      {#if savedForPractice}<p class="reading-hint">Already saved from this response. Save a different meaning to keep another use.</p>{/if}
      <button type="button" disabled={busy || ui.readingBusy()} onclick={saveForPractice}>Save for practice</button>
    </section>
  {:else if selection}
    <section class="word-details nodrag nopan nowheel" popover="auto" aria-label="Word details" tabindex="-1" bind:this={details} use:present ontoggle={event => { if (event.newState === 'closed') close() }}>
      <header><div class="word-title"><h4 lang="zh">{selection.text}</h4><p class="pronunciation" lang="zh-Latn">{selectedPronunciation?.pinyin || 'Pronunciation unavailable'}</p></div><button type="button" class="ghost" aria-label="Close word details" onclick={() => close(true)}>✕</button></header>
      {#if focusedMeaningLoading}<p role="status">Finding a definition…</p>{:else if focusedMeaning}<p>{focusedMeaning.meaning}</p><p class="reading-hint">Check which meaning fits this sentence when saving.</p>{:else}<p class="reading-hint">No saved meaning yet. You can add one when saving.</p>{/if}
      {#if savedForPractice}<p class="reading-hint">Already saved from this response. Save a different meaning to keep another use.</p>{/if}
      <div class="word-actions">
        <button type="button" class="ghost play-word" aria-label={speakingWord ? 'Stop audio' : 'Play Mandarin audio'} onclick={() => { if (speakingWord) speechController?.abort(); else void speakWord(selection!.text) }}>{#if speakingWord}<Square size={20} />{:else}<Play size={20} />{/if}</button>
        <button type="button" disabled={busy || ui.readingBusy()} onclick={saveForPractice}>Save for practice</button>
        <button type="button" class="ghost" disabled={busy || ui.readingBusy()} onclick={() => void addWord()}>{busy ? 'Adding…' : 'Pin on canvas'}</button>
      </div>
      {#if speechError}<div class="word-audio-error"><p role="status">{speechError}</p><button type="button" class="ghost" onclick={() => ui.languageSetup()}>Mandarin audio settings</button></div>{/if}
      {#if error}<p class="reading-error" role="alert">{error}</p>{/if}
    </section>
  {/if}
  {#if focused}<div class="reading-status nodrag" class:error={Boolean(speechError)} aria-live="polite">{#if speakingWord}<span>Playing <span lang="zh">{speakingWord}</span>…</span>{:else if speechError}<span>{speechError}</span><button type="button" class="ghost" onclick={() => ui.languageSetup()}>Mandarin audio settings</button>{/if}</div>{/if}
</div>

<style>
  .reader { white-space: normal; }
  .word-text, .word-details { cursor: default; }
  .original { cursor: text; }
  .original-segment { display: inline; }.original-sound { display: block; font-size: 12px; color: #c8dafe; }
  .reading-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 6px 0 8px; }
  .reading-toolbar span { flex: 1 1 100%; font-size: 12px; color: #b6cbed; }
  .reading-controls { margin-top: 8px; }
  .reading-controls > summary { min-height: 36px; display: flex; align-items: center; color: #b6cbed; font-size: 12px; cursor: pointer; }
  button { font-size: 12px; min-height: 36px; }
  .reading-hint { font-size: 12px; color: #b1bbcd; line-height: 1.5; }
  .reading-hint { margin: 4px 0 10px; }
  .focused-definition { margin-top: 12px; padding: 10px 12px; border: 1px solid #526a8d66; border-radius: 10px; background: #18263a; }
  .focused-definition p { margin: 4px 0 0; line-height: 1.5; }
  .focused-definition .component-definition { white-space: pre-line; }
  .focused-word { display: flex; align-items: baseline; gap: 10px; }
  .focused-word strong { font-size: 20px; }
  .focused-word span { color: #c8dafe; font-size: 12px; }
  .reading-status { position: sticky; bottom: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-height: 36px; margin: 12px -2px -2px; padding: 4px 8px; border-top: 1px solid #526a8d66; background: #101b2cf2; color: #c8dafe; font-size: 12px; }
  .reading-status.error { color: #f4abab; }
  .reading-status button { min-height: 32px; }
  .word-text, .original { white-space: pre-wrap; overflow-wrap: anywhere; max-height: min(320px, 40dvh); overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; scroll-padding-block: 12px; }
  .reading-pages { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 10px; }.reading-pages span { font-size: 12px; color: #b1bbcd; }.reading-pages button { min-height: 44px; }
  .word-text { line-height: 2.3; }
  .word { display: inline-block; vertical-align: baseline; min-height: 44px; margin: 2px 2px 2px 0; padding: 2px 5px; border: 0; border-bottom: 1px solid #7483a4; border-radius: 5px; background: #26344a66; color: #f2f4f8; font-size: 20px; font-weight: 400; line-height: 1.7; }
  .word:hover, .word.active { background: #3c547e; border-color: #bad7ff; }
  rt { font-size: 10px; color: #c8dafe; letter-spacing: .02em; }
  .with-pinyin .word { padding-top: 10px; margin-top: 9px; }
  .word-details { position: fixed; inset: 16px 16px auto auto; width: min(340px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: 0; padding: 16px; border: 1px solid #526a8d; border-radius: 14px; background: #101b2c; color: #e8eaed; font-size: 14px; line-height: 1.5; white-space: normal; overflow: auto; overflow-wrap: anywhere; overscroll-behavior: contain; box-shadow: 0 16px 64px #0009; z-index: 50; }
  .word-details header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
  .word-title { min-width: 0; }h4 { margin: 0; font-size: 26px; font-weight: 500; }
  .pronunciation { color: #c8dafe; margin: 4px 0 0; }
  .focused-definition button { min-height: 44px; }
  .word-details button { min-width: 44px; min-height: 44px; }
  .word-actions { display: flex; align-items: center; gap: 8px; margin-top: 16px; }.word-actions > button:last-child { flex: 1; }.play-word { display: grid; place-items: center; padding: 10px; }
  .word-audio-error { margin-top: 12px; color: #b1bbcd; font-size: 12px; }.word-audio-error p { margin: 0 0 6px; }
  .reading-error { color: #f4abab; }
  @media (max-width: 600px) { .word-details { inset: auto 8px 8px; width: calc(100vw - 16px); max-height: 64dvh; } }
</style>
