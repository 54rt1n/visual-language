<script lang="ts">
  import NodeActions from './NodeActions.svelte'
  import { getContext } from 'svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import type { RootNodeType } from '../../types/graph'

  let { id, data, selected }: NodeProps<RootNodeType> = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
</script>

<div class="vl-node root" class:selected>
  <Handle type="target" position={Position.Left} />
  <h3>Root</h3>
  <div class="body">{ui?.concealed() ? 'Topic text hidden during recall' : data.name}</div>
  <Handle type="source" position={Position.Bottom} />
<NodeActions {id} {selected} />
</div>
