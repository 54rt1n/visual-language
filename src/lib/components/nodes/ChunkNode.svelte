<script lang="ts">
  import NodeActions from './NodeActions.svelte'
  import { getContext } from 'svelte'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  import SpeechButton from '../SpeechButton.svelte'
  import DictionaryAttribution from '../DictionaryAttribution.svelte'
  import { containsHanzi } from '../../mandarin/chineseParser'
  let { id, data, selected }: NodeProps = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
  let pinyinOverride = $state<boolean | undefined>()
  const showPinyin = $derived(pinyinOverride ?? ui?.pinyinDisplay(id) === 'always')
</script>
<div class="vl-node chunk" class:selected class:learning-word={Boolean(data.wordSource)}>
  <Handle type="target" position={Position.Top} /><h3>{data.wordSource ? 'Learning word' : `Mandarin chunk · ${data.itemId ? 'saved learning' : 'unassessed material'}`}</h3>
  {#if ui?.concealed()}<p>Learning material hidden during recall.</p><button type="button" class="ghost nodrag" onclick={() => ui?.revealMaterial()}>Review help options</button>
  {:else}
    <div class="body" lang="zh">{String(data.text)}</div>
    {#if data.wordSource}
      {#if showPinyin}<p class="pinyin" lang="zh-Latn">{String(data.pinyin ?? '')}</p>{/if}
      <div class="word-controls nodrag nopan">
        <SpeechButton text={String(data.text)} compact transport />
        <button type="button" class="ghost" aria-pressed={showPinyin} onclick={() => { pinyinOverride = !showPinyin }}>{showPinyin ? 'Hide pinyin' : 'Show pinyin'}</button>
        <button type="button" disabled={ui?.requestBusy()} onclick={() => ui?.explainWord(id)}>Explain</button>
        <button type="button" class="ghost" disabled={ui?.requestBusy()} onclick={() => data.itemId ? ui?.practiceItem(String(data.itemId)) : ui?.captureItem(id)}>{data.itemId ? 'Practice this phrase' : 'Save for practice'}</button>
      </div>
    {:else}
    {#if ui?.pinyinDisplay(id) === 'always' || (ui?.pinyinDisplay(id) === 'onDemand' && showPinyin)}<p class="pinyin" lang="zh-Latn">{String(data.pinyin ?? '')}</p>{/if}
    {#if ui?.pinyinDisplay(id) === 'onDemand'}<button type="button" class="ghost nodrag" onclick={() => { pinyinOverride = !showPinyin }}>{showPinyin ? 'Hide pinyin' : 'Show pinyin'}</button>{/if}
    <p>{String(data.meaning ?? '')}</p>
    {#if containsHanzi(String(data.text))}<button type="button" class="ghost nodrag nopan" disabled={ui?.readingBusy()} onclick={() => ui?.readResponse(id)}>Read word by word</button>{/if}
    {#if data.itemId}<DictionaryAttribution citations={ui?.dictionarySources(String(data.itemId)) ?? []} meaning={String(data.meaning ?? '')} />{/if}
    {#if data.originalVocabulary}<details class="nodrag nopan"><summary>Original vocabulary metadata</summary><p>Historical metadata only, not Leitner progress.</p><pre>{JSON.stringify(data.originalVocabulary, null, 2)}</pre></details>{/if}
    <div class="nodrag nopan"><SpeechButton text={String(data.text)} /></div>
    {#if data.itemId}<button type="button" class="ghost nodrag" onclick={() => ui?.practiceItem(String(data.itemId))}>Practice this phrase</button>{:else}<button type="button" class="ghost nodrag" onclick={() => ui?.captureItem(id)}>Save for practice</button>{/if}
    {/if}
  {/if}
{#if data.wordSource}<details class="nodrag nopan"><summary>Configuration</summary><NodeActions {id} {selected} /><button type="button" class="ghost" disabled={ui?.requestBusy()} onclick={() => ui?.deleteNode(id)}>Delete node…</button></details>{:else}<NodeActions {id} {selected} />{/if}
<Handle type="source" position={Position.Bottom} />
</div>
<style>.chunk.learning-word { background: #101b2c; border: 1px solid #526a8d; border-radius: 14px; }.learning-word .body { font-size: 26px; font-weight: 500; }.learning-word .pinyin { color: #c8dafe; font-size: 14px; }.learning-word .word-controls button { font-size: 12px; }.word-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }.word-controls button { margin-top: 0; min-height: 44px; }.chunk { border-color: #e9c46a; }.body { font-size: 20px; }.pinyin { color: #bdd3f4; }p { margin: 8px 0; }button { font-size: 11px; margin-top: 7px; }pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; font-size: 10px; }summary { cursor: pointer; font-size: 11px; }details { margin-top: 10px; }</style>
