<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Modal from './Modal.svelte'

  let { onConnect, onDemo, onClose }: { onConnect: () => void; onDemo: () => Promise<void>; onClose: () => void } = $props()
  let connectButton: HTMLButtonElement | undefined
  let busy = $state(false), error = $state('')

  onMount(() => { void tick().then(() => connectButton?.focus()) })
  async function tryDemo() {
    if (busy) return
    busy = true; error = ''
    try { await onDemo() }
    catch (cause) { error = cause instanceof Error ? cause.message : 'The demo could not open. Try again.' }
    finally { busy = false }
  }
</script>

<Modal title="Welcome to Visual Language" {onClose}>
  <p class="welcome-intro">Learn Mandarin with your tutor Zheng.</p>
  <ul class="first-steps">
    <li><strong>Chat:</strong> Send a message using the box at the bottom.</li>
    <li><strong>Read:</strong> Select Chinese words for meanings, pronunciation, and saving for practice.</li>
    <li><strong>Learn:</strong> Open <strong>Explore</strong> to create a lesson, or <strong>Lessons</strong> to continue one.</li>
  </ul>
  <p class="canvas-hint">Drag the background to move around. Use the <strong>+ / −</strong> buttons in the bottom left to zoom.</p>
  <p class="setup">Connect your AI provider to get started, or try the demo without a key.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#snippet footer()}
    <div class="welcome-actions">
      <button type="button" bind:this={connectButton} disabled={busy} onclick={onConnect}>Set up AI connection</button>
      <button type="button" class="ghost" disabled={busy} onclick={() => void tryDemo()}>{busy ? 'Opening demo…' : 'Try demo'}</button>
    </div>
  {/snippet}
</Modal>

<style>
  p { margin: 0; line-height: 1.5; font-size: 14px; }
  .welcome-intro { font-size: 17px; color: #e8eaed; }
  .first-steps { display: grid; gap: 10px; padding: 0; margin: 16px 0; list-style: none; font-size: 14px; line-height: 1.5; }
  .first-steps strong { color: #e8eaed; }
  .canvas-hint, .setup { color: #b4c4df; }
  .canvas-hint strong { white-space: nowrap; }
  .setup { margin-top: 16px; }
  .error { margin-top: 12px; color: #f3aaaa; }
  .welcome-actions { display: flex; gap: 10px; }
  .welcome-actions button { min-height: 44px; }
  @media (max-width: 520px) {
    .welcome-actions { flex-direction: column; }
    .welcome-intro { font-size: 16px; }
  }
</style>
