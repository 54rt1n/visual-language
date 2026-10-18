<script lang="ts">
  import Modal from './Modal.svelte'
  import type { PwaLifecycle } from '../pwa/lifecycle.svelte'
  let { pwa, onPrepareUpdate, onClose }: { pwa: PwaLifecycle; onPrepareUpdate: () => Promise<void>; onClose: () => void } = $props()
  let busy = $state(false), message = $state(''), error = $state('')
  async function prepare() {
    busy = true; error = ''
    try { await onPrepareUpdate(); message = 'Drafts are saved and the lesson is paused. Close every Visual Language tab and installed-app window, then reopen. Other tabs must save their own drafts first.' }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Saving failed. Keep this window open and download draft recovery before updating.' }
    finally { busy = false }
  }
</script>
<Modal title="Install & app updates" onClose={() => { if (!busy) onClose() }}>
  <div class="pwa-dialog">
    <p>{pwa.installed ? 'Running as an installed app.' : 'Installation is optional. The full workspace also works in a browser tab.'}</p>
    {#if pwa.installAvailable}<button type="button" onclick={() => { void pwa.install() }}>Install Visual Language</button>{/if}
    <section><h3>Install on your device</h3><p>Use your browser’s “Install app” menu when offered. On iPhone/iPad, open the browser’s Share menu and choose “Add to Home Screen.” On supported desktop Safari, use “Add to Dock.” If your browser does not offer installation, keep using this tab.</p></section>
    <section><h3>Connection & local data</h3><p>{pwa.shell}</p><p>New teacher responses, model grading, and Tavily need a connection. Saved material, saved quiz scoring, and backup/restore work locally. Reconnecting never silently retries paid work.</p><p>Installing does not guarantee permanent storage. Use Backup & restore to protect and download your workspace; keys remain separate in this browser’s localStorage.</p></section>
    <section><h3>{pwa.updateAvailable ? 'Update ready — your lesson will not reload' : 'App updates'}</h3><p>Updates wait while app windows are open. Save and pause here, save drafts in other tabs, close all app windows, then reopen. No update button forcibly reloads an unfinished lesson.</p><div class="actions"><button type="button" class="ghost" onclick={() => { void pwa.checkUpdates() }} disabled={busy}>Check for app update</button><button type="button" onclick={prepare} disabled={busy}>Save & prepare to update</button></div></section>
    {#if pwa.message}<p role="status">{pwa.message}</p>{/if}{#if message}<p role="status">{message}</p>{/if}{#if error}<p role="alert" class="error">{error}</p>{/if}
  </div>
</Modal>
<style>
  .pwa-dialog { display: grid; gap: 16px; }section { border-top: 1px solid #354154; padding-top: 14px; }p { margin: 0 0 10px; line-height: 1.6; }h3 { margin: 0 0 10px; color: #b9d0f6; }.actions { display: flex; gap: 8px; flex-wrap: wrap; }.error { color: #f4a3a3; }
</style>
