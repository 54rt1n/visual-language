<script lang="ts">
  import NodeActions from './NodeActions.svelte'
  import { getContext } from 'svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import type { AssistantNodeType } from '../../types/graph'
  import MandarinReader from '../MandarinReader.svelte'
  import { containsHanzi } from '../../mandarin/chineseParser'
  import { unusableReplyReason } from '../../ai/replyQuality'
  import { BookOpen, ListChecks } from '@lucide/svelte'

  let { id, data, selected }: NodeProps<AssistantNodeType> = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
  const replyWarning = $derived(data.error || (!data.streaming && data.state === 'complete' ? unusableReplyReason(data.text, true) : undefined))
  let plain = $state(false), pinyinOverride = $state<boolean | undefined>()
  const withPinyin = $derived(pinyinOverride ?? ui?.pinyinDisplay(id) === 'always')
</script>

<div class="vl-node assistant" class:selected>
  <Handle type="target" position={Position.Top} />
  <h3><span>
      Zheng
      {#if data.editedAt}<span class="provenance" title="This text was edited locally after generation">edited locally</span>{:else if data.regeneratedFrom}<span class="provenance">alternative reply</span>{/if}
      {#if data.streaming}<span class="pulse" title="streaming"></span>{/if}
    </span>
    {#if !data.streaming && containsHanzi(data.text) && !ui?.concealed()}<div class="response-actions">
      <button type="button" class="ghost nodrag nopan read-response" aria-label="Read response" title="Read response" disabled={ui?.readingBusy()} onclick={event => { event.stopPropagation(); ui?.readResponse(id) }}><BookOpen size={20} /></button>
      {#if data.state === 'complete'}<button type="button" class="ghost nodrag nopan read-response" aria-label="Create lesson" title="Create lesson" disabled={ui?.readingBusy()} onclick={event => { event.stopPropagation(); ui?.createLesson(id) }}><ListChecks size={20} /></button>{/if}
    </div>{/if}
  </h3>
  <div class="body">
    {#if ui?.concealed()}
      Source text hidden during recall. Resume the question or explicitly reveal learning material.
    {:else if data.text}
      {#if !data.streaming && containsHanzi(data.text)}<MandarinReader nodeId={id} text={data.text} showControls={false} bind:plain bind:pinyinOverride />{:else}{data.text}{/if}
    {:else if data.streaming}
      waiting for first token…
    {/if}
  </div>
  {#if replyWarning && !ui?.concealed()}
    <div class="error">{replyWarning}</div>
  {/if}
  {#if !data.streaming}<details class="configuration">
    <summary class="nodrag nopan">Configuration</summary>
    {#if containsHanzi(data.text) && !ui?.concealed()}<div class="display-controls" aria-label="Reading display controls">
      <button type="button" class="ghost nodrag nopan" aria-pressed={plain} onclick={() => { plain = !plain }}>{plain ? 'Word view' : 'Plain text'}</button>
      {#if !plain}<button type="button" class="ghost nodrag nopan" aria-pressed={withPinyin} onclick={() => { pinyinOverride = !withPinyin }}>{withPinyin ? 'Hide pinyin' : 'Show pinyin'}</button>{/if}
    </div>{/if}
    {#if data.reasoning && !ui?.concealed()}
      <details class="thinking-disclosure">
        <summary class="nodrag nopan"><span class="when-closed">Show thinking</span><span class="when-open">Hide thinking</span></summary>
        <!-- Keyboard users need to focus this bounded scroll region to read long thinking text. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="reasoning nodrag nopan nowheel" tabindex="0" role="region" aria-label="Model thinking">{data.reasoning}</div>
      </details>
    {/if}
    {#if data.model}<p class="model-info">{data.provider} · {data.model}</p>{/if}
    <NodeActions {id} {selected} messageKind="assistant" />
    <button type="button" class="ghost delete-node nodrag nopan" disabled={ui?.requestBusy()} onclick={event => { event.stopPropagation(); ui?.deleteNode(id) }}>Delete node…</button>
  </details>{/if}
  <Handle type="source" position={Position.Bottom} />
</div>
<style>
  .provenance { font-size: 10px; font-weight: 400; color: #a9b2c4; }
  .model-info { color: #a9b2c4; font-size: 11px; margin: 10px 0 0; overflow-wrap: anywhere; }
  h3 { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .read-response { flex: 0 0 auto; min-width: 44px; min-height: 44px; margin: 0; padding: 11px; display: grid; place-items: center; }
  .response-actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
  :global(.assistant .bookmark) { right: 114px; }
  .configuration { margin-top: 8px; }
  .configuration:not([open]) { width: max-content; max-width: 100%; margin-left: auto; }
  .configuration > summary { width: max-content; min-height: 36px; margin-left: auto; padding: 0 8px; display: flex; align-items: center; color: #a9b2c4; font-size: 11px; cursor: pointer; }
  .display-controls { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 4px; }
  .display-controls button { min-height: 36px; font-size: 11px; }
  .delete-node { min-height: 36px; margin-top: 8px; color: #f3aaaa; border-color: #8e5050; font-size: 11px; }
  .thinking-disclosure { margin-top: 8px; cursor: default; }
  summary { color: #a9b2c4; font-size: 11px; padding: 8px 0; cursor: pointer; }
  .when-open, .thinking-disclosure[open] .when-closed { display: none; }
  .thinking-disclosure[open] .when-open { display: inline; }
  .reasoning { white-space: pre-wrap; overflow-wrap: anywhere; overscroll-behavior: contain; cursor: text; }
</style>
