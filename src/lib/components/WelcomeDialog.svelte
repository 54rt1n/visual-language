<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Modal from './Modal.svelte'

  let { onConnect, onClose }: { onConnect: () => void; onClose: () => void } = $props()
  let connectButton: HTMLButtonElement | undefined

  onMount(() => { void tick().then(() => connectButton?.focus()) })
</script>

<Modal title="Welcome to Visual Language" {onClose}>
  <div class="welcome-intro">
    <img src={`${import.meta.env.BASE_URL}icons/app.svg`} width="56" height="56" alt="" />
    <p>Learn Mandarin with Zheng through conversations, lessons, and reviews.</p>
  </div>
  <p class="setup">Add your own AI provider key to start conversations and create lessons. Choose Nebius or another provider in the next step.</p>
  {#snippet footer()}
    <div class="welcome-actions">
      <button type="button" bind:this={connectButton} onclick={onConnect}>Set up AI connection</button>
      <button type="button" class="ghost" onclick={onClose}>Explore first</button>
    </div>
  {/snippet}
</Modal>

<style>
  .welcome-intro { display: flex; align-items: center; gap: 16px; }
  .welcome-intro img { flex: 0 0 auto; }
  p { margin: 0; line-height: 1.6; }
  .welcome-intro p { font-size: 17px; color: #e8eaed; }
  .setup { margin-top: 20px; color: #b4c4df; font-size: 14px; }
  .welcome-actions { display: flex; gap: 10px; }
  .welcome-actions button { min-height: 44px; }
  @media (max-width: 520px) {
    .welcome-actions { flex-direction: column; }
    .welcome-intro { gap: 12px; }
    .welcome-intro p { font-size: 16px; }
  }
</style>
