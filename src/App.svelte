<script lang="ts">
  import { SvelteFlowProvider } from '@xyflow/svelte'
  import GraphCanvas from './lib/components/GraphCanvas.svelte'
</script>

<SvelteFlowProvider>
  <GraphCanvas />
</SvelteFlowProvider>
