<script lang="ts">
  import NodeActions from './NodeActions.svelte'
  import { getContext } from 'svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  let { id, data, selected }: NodeProps = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
</script>
<div class="vl-node" class:selected>
  <Handle type="target" position={Position.Top} />
  <h3>{String(data.domainType ?? 'Learning record')}</h3>
  <div class="body">{ui?.concealed() ? 'Learning context hidden during recall' : String(data.text ?? data.prompt ?? data.model ?? data.exerciseId ?? 'Saved learning context')}</div>
  <Handle type="source" position={Position.Bottom} />
<NodeActions {id} {selected} />
</div>
