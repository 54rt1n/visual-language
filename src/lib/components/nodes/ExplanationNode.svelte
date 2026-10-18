<script lang="ts">
  import { getContext } from 'svelte'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  import NodeActions from './NodeActions.svelte'
  let { id, data, selected }: NodeProps = $props()
  const ui = getContext<CanvasUI>(CANVAS_UI)
</script>

<div class="vl-node explanation" class:selected>
  <Handle type="target" position={Position.Top} />
  <h3>Zheng · explanation {#if data.streaming}<span class="pulse"></span>{/if}</h3>
  {#if ui.concealed()}<p>Explanation hidden during recall.</p>
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (A bounded reading region needs keyboard scrolling.) -->
    <div class="body nodrag nopan nowheel" role="region" aria-label="Word explanation" tabindex="0">{String(data.text || (data.streaming ? 'Zheng is explaining…' : 'No explanation saved yet.'))}</div>
    {#if data.error}<p class="error" role="alert">{String(data.error)}</p>{/if}
    {#if data.streaming}<button type="button" class="ghost nodrag nopan" onclick={() => ui.stopExplanation()}>Stop</button>
    {:else if data.state !== 'complete'}
      {#if data.state === 'interrupted'}<p class="notice">Stopped. You can retry when ready.</p>{/if}
      <button type="button" class="ghost nodrag nopan" disabled={ui.requestBusy()} onclick={() => ui.explainWord(String(data.wordNodeId))}>Retry</button>
    {/if}
  {/if}
  <details class="nodrag nopan"><summary>Configuration</summary>
    <p class="notice">{String(data.provider)} · {String(data.model)}</p>
    <NodeActions {id} {selected} />
    <button type="button" class="ghost" disabled={ui.requestBusy()} onclick={() => ui.deleteNode(id)}>Delete node…</button>
  </details>
</div>

<style>
  .explanation { border-color: #91b6f6; min-width: 320px; }
  h3 { color: #91b6f6; }
  .body { max-height: 320px; overflow: auto; cursor: text; font-size: 15px; line-height: 1.65; }
  button { min-height: 40px; margin-top: 10px; font-size: 12px; }
  details { margin-top: 12px; }summary,.notice { font-size: 11px; color: #b4c4df; }summary { cursor: pointer; }
</style>
