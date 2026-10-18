<script lang="ts">
  import { getContext } from 'svelte'
  import { CANVAS_UI, type CanvasUI } from '../../graph/uiContext'
  let { id, selected = false, messageKind }: { id: string; selected?: boolean; messageKind?: 'user' | 'assistant' } = $props()
  const ui = getContext<CanvasUI | undefined>(CANVAS_UI)
  const flags = $derived(ui?.nodeFlags(id))
</script>
{#if flags?.bookmarked}<span class="bookmark" aria-label="Bookmarked">★</span>{/if}
{#if messageKind || selected || flags?.collapsed}<div class="actions nopan">
  {#if messageKind && ui}<button type="button" class="ghost message-action nodrag" disabled={ui.requestBusy()} title={messageKind === 'user' ? 'Ask Zheng to respond to this saved message without retyping it.' : 'Try another response to the same message. This reply and later messages are kept.'} onclick={event => { event.stopPropagation(); ui?.generateReply(id) }}>{messageKind === 'user' ? 'Generate reply' : 'Retry response'}</button>{/if}
  {#if selected || flags?.collapsed}<button type="button" class="ghost nodrag" disabled={ui?.readingBusy()} onclick={event => { event.stopPropagation(); ui?.openGraphTools(id) }}>Node tools</button><button type="button" class="ghost nodrag" disabled={ui?.readingBusy()} onclick={event => { event.stopPropagation(); ui?.toggleCollapse(id) }}>{flags?.collapsed ? 'Expand branch' : 'Collapse branch'}</button>{/if}
</div>{/if}
<style>.actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }.actions button { font-size: 10px; padding: 5px 7px; }.actions button.message-action { font-size: 12px; min-height: 36px; padding: 7px 10px; }.bookmark { color: #ebca7f; position: absolute; right: 12px; top: 10px; }</style>
