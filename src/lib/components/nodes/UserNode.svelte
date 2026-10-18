<script lang="ts">
  import NodeActions from './NodeActions.svelte'
  import { getContext } from 'svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import type { UserNodeType } from '../../types/graph'

  let { id, data, selected }: NodeProps<UserNodeType> = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
</script>

<div class="vl-node user" class:selected>
  <Handle type="target" position={Position.Top} />
  <h3>You</h3>
  <div class="body">{ui?.concealed() ? 'Source text hidden during recall' : data.text}</div>
  <Handle type="source" position={Position.Bottom} />
<NodeActions {id} {selected} messageKind="user" />
</div>
