<script lang="ts">
  import type { Snippet } from 'svelte'
  let { title, children, footer, onClose }: { title: string; children: Snippet; footer?: Snippet; onClose: () => void } = $props()
  let dialog = $state<HTMLDialogElement>()
  $effect(() => {
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousDialog = previous?.closest('dialog')
    dialog.showModal()
    return () => {
      dialog?.close()
      if (previous?.isConnected) previous.focus()
      // A live status update can remove an auxiliary dialog's opener. Keep
      // keyboard focus in the still-open parent, not its inert workspace.
      else if (previousDialog?.isConnected && previousDialog.open) previousDialog.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
      else document.querySelector<HTMLElement>('[aria-label="Workspace tools"] button:not(:disabled)')?.focus()
    }
  })
</script>

<dialog bind:this={dialog} aria-label={title} oncancel={(event) => { event.preventDefault(); onClose() }}>
  <header><h2>{title}</h2><button type="button" class="ghost" aria-label="Close dialog" onclick={onClose}>✕</button></header>
  <div class="modal-body">{@render children()}</div>
  {#if footer}<footer class="modal-footer">{@render footer()}</footer>{/if}
</dialog>

<style>
  dialog { width: min(620px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); padding: 0; border: 1px solid #354154; border-radius: 18px; background: #1a1d26; color: #e8eaed; box-shadow: 0 24px 90px #0009; }
  dialog[open] { display: flex; flex-direction: column; overflow: hidden; }
  dialog::backdrop { background: #070a12c9; backdrop-filter: blur(5px); }
  header { flex: 0 0 auto; background: #1a1d26; display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 14px 24px; border-bottom: 1px solid #303745; }
  header button { min-width: 44px; min-height: 44px; }
  h2 { font-size: 18px; margin: 0; }
  .modal-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 20px 24px; scroll-padding-block: 16px; }
  .modal-footer { flex: 0 0 auto; padding: 14px 24px; border-top: 1px solid #354154; background: #191f2a; }
  @media (max-width: 520px) {
    dialog { width: calc(100vw - 16px); max-height: calc(100dvh - 24px); border-radius: 14px; }
    header { gap: 10px; padding: 10px 16px; }
    .modal-body { padding: 16px; }
    .modal-footer { padding: 12px 16px; }
  }
</style>
