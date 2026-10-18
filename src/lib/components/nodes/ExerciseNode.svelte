<script lang="ts">
  import NodeActions from './NodeActions.svelte'
  import { getContext } from 'svelte'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  let { id, data, selected }: NodeProps = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
  const summary = $derived(ui?.exerciseSummary(String(data.exerciseId)))
</script>
<div class="vl-node exercise" class:selected><Handle type="target" position={Position.Top} /><h3>{summary?.mode === 'dueReview' ? 'Scheduled review' : 'Practice history'}</h3>
  {#if ui?.concealed()}<p>Exercise and feedback hidden during recall.</p>
  {:else if summary}<div class="body">{summary.prompt}</div>{#if summary.answer}<p><strong>Saved answer:</strong> {summary.answer}</p>{/if}{#if summary.feedback}<p><strong>Feedback:</strong> {summary.feedback}</p>{/if}<button class="ghost nodrag" type="button" onclick={() => ui?.practiceCard(summary!.cardId)}>Open teacher</button>{/if}
{#if summary && !ui?.concealed()}<button class="ghost nodrag" type="button" onclick={() => ui?.reviewHistory(summary!.cardId)}>View saved review history</button>{/if}
<NodeActions {id} {selected} />
</div>
<style>.exercise { border-color: #b39af3; max-height: 320px; overflow: auto; }p { font-size: 12px; white-space: pre-wrap; }button { font-size: 11px; }</style>
