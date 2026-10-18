<script lang="ts">
  import { getContext } from 'svelte'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import NodeActions from './NodeActions.svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  let { id, data, selected }: NodeProps = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
  const lesson = $derived(ui?.lessonSummary(String(data.draftId)))
</script>
<div class="vl-node lesson" class:selected><Handle type="target" position={Position.Top} />
  {#if ui?.concealed()}<h3>Saved lesson</h3><p>Lesson material is hidden during recall.</p>
  {:else if lesson}<h3>{lesson.title}</h3><p class="meta">{lesson.kind} · {lesson.phraseCount} phrase proposals · {lesson.sourceCount} saved sources</p><div class="body" lang="zh">{lesson.passage}</div><button type="button" class="ghost nodrag" onclick={() => ui?.openDiscovery(String(data.draftId))}>Open cited lesson</button>{/if}
  <NodeActions {id} {selected} /><Handle type="source" position={Position.Bottom} />
</div>
<style>.lesson { border-color: #c9a764; max-height: 340px; overflow: auto; }.meta,p { font-size: 12px; color: #adb8ca; }.body { white-space: pre-wrap; margin-bottom: 12px; }button { font-size: 12px; }</style>
