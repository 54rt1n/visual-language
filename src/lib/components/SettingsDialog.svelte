<script lang="ts">
  import { tick, untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import { bindProfileKey, envApiKey, providerCatalog, providerDefaults, providerIds, providerNames, resolveProvider, resolveProviderAccess, saveSettings, type ProviderCompatibility, type Settings } from '../settings'
  import { streamChat } from '../ai/client'
  import { listProviderModels, type ModelList } from '../ai/models'
  import { unusableReplyReason } from '../ai/replyQuality'
  let { settings, onSave, onClose, allowNetwork = true }: { settings: Settings; onSave: (value: Settings) => void | Promise<void>; onClose: () => void; allowNetwork?: boolean } = $props()
  let draft = $state<Settings>(untrack(() => structuredClone($state.snapshot(settings))))
  let status = $state('')
  let testing = $state(false)
  let saving = $state(false)
  let loadingModels = $state(false), catalog = $state<ModelList>(), modelQuery = $state(''), probeText = $state('')
  let keyError = $state(''), keyInput = $state<HTMLInputElement>(), modelSelect = $state<HTMLSelectElement>(), resultStatus = $state<HTMLParagraphElement>()
  let modelBrowserOpen = $state(false), advancedOpen = $state(false)
  const busy = $derived(testing || saving || loadingModels)
  let controller: AbortController | undefined
  const profile = $derived(draft.profiles[draft.selected])
  const matchingModels = $derived(catalog?.ids.filter(id => id.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase())) ?? [])
  const olderStarter = $derived(draft.selected === 'featherless' && profile.baseUrl.replace(/\/+$/, '') === providerDefaults.featherless.baseUrl && ['Qwen/Qwen3-32B', 'Qwen/Qwen3.6-27B'].includes(profile.model))
  const insecurePage = typeof window !== 'undefined' && !window.isSecureContext
  $effect(() => {
    const custom = draft.selected === 'custom'
    untrack(() => { modelBrowserOpen = custom; advancedOpen = custom })
  })
  $effect(() => () => controller?.abort())
  $effect(() => {
    void draft.selected; void profile.baseUrl; void profile.apiKey
    untrack(() => { catalog = undefined; modelQuery = ''; probeText = ''; status = ''; keyError = '' })
  })
  $effect(() => {
    void profile.model; void profile.compatibility
    untrack(() => { probeText = ''; status = '' })
  })

  function approved() {
    const value = structuredClone($state.snapshot(draft))
    for (const id of providerIds) {
      if (value.profiles[id].baseUrl) value.profiles[id] = bindProfileKey(value.profiles[id])
    }
    return value
  }
  function connectionError(error: unknown) {
    const message = error instanceof Error ? error.message : 'Connection failed. Try again.'
    if (/missing or invalid|Add your .+ key|API key is required/i.test(message)) {
      keyError = `${providerNames[draft.selected]} needs a valid API key. Check the key and try again.`
      return 'Check your API key above.'
    }
    return message
  }
  async function focusResult() {
    await tick()
    if (keyError) keyInput?.focus()
    else resultStatus?.focus()
  }
  function hasTestKey() {
    if (profile.apiKey.trim() || envApiKey(draft.selected)) return true
    keyError = `Enter your ${providerNames[draft.selected]} API key to continue.`
    status = 'Add your API key above.'
    void focusResult()
    return false
  }
  async function save() {
    if (busy) return
    saving = true; status = 'Saving provider settings…'
    let keysSaved = false
    try { const value = approved(); saveSettings(value); keysSaved = true; await onSave(value); onClose() }
    catch (error) {
      const detail = error instanceof Error ? error.message : 'Storage is unavailable.'
      status = keysSaved ? `Keys were saved in this browser, but workspace backup preferences could not be saved. ${detail}` : `Could not save settings. ${detail}`
    } finally { saving = false }
  }
  async function test() {
    if (busy) return
    if (!allowNetwork) { status = 'Switch the demo to live providers before testing a connection.'; return }
    if (!hasTestKey()) return
    keyError = ''
    testing = true; status = 'Checking the selected model…'; probeText = ''; controller = new AbortController()
    try {
      const config = resolveProvider(approved())
      const result = await streamChat({ ...config, messages: [{ role: 'user', content: 'Reply with a short Mandarin greeting and its English meaning. Nothing else.' }], maxTokens: 256, temperature: 0.2, handlers: { signal: controller.signal } })
      const problem = unusableReplyReason(result.content, true)
      probeText = result.content.slice(0, 1000)
      status = problem ? `The connection worked, but the reply was not usable. ${problem}` : `Connected to ${providerNames[config.provider]}.`
    } catch (error) { status = connectionError(error) }
    finally { testing = false; await focusResult() }
  }
  async function loadModels() {
    if (busy || !allowNetwork) return
    if (!hasTestKey()) return
    keyError = ''
    loadingModels = true; status = 'Loading provider model IDs…'; controller = new AbortController()
    try {
      catalog = await listProviderModels(resolveProviderAccess(approved()), modelQuery, controller.signal)
      status = 'Models loaded. Choose a model, then save your connection.'
    } catch (cause) { catalog = undefined; status = controller.signal.aborted ? 'Model loading stopped.' : `${connectionError(cause)} You can also enter a model ID manually.` }
    finally { loadingModels = false; await tick(); if (catalog) modelSelect?.focus(); else await focusResult() }
  }
</script>

<Modal title="AI connection" onClose={() => { if (!saving) onClose() }}>
  {#if insecurePage}<p class="notice" role="alert">Use HTTPS before entering real API keys. Local editing and backups are still available.</p>{/if}
  {#if !allowNetwork}<p class="notice">Demo mode: connection tests are disabled. Connection settings are shared with your main workspace.</p>{/if}
  <p class="intro">Choose how Zheng connects to AI.</p>
  <p class="notice draft-note">Changes apply when saved. Your other providers keep their own keys.</p>
  <label>Provider<select aria-label="Provider" bind:value={draft.selected} disabled={busy}>{#each providerIds as id}<option value={id}>{providerNames[id]}</option>{/each}</select></label>
  <p class="notice">{providerCatalog[draft.selected].note}</p>
  <label>{providerNames[draft.selected]} API key<input bind:this={keyInput} type="password" autocomplete="off" spellcheck="false" bind:value={profile.apiKey} placeholder={envApiKey(draft.selected) ? 'Local testing key available' : 'Paste your API key'} aria-invalid={keyError ? 'true' : undefined} aria-describedby={keyError ? 'connection-key-error' : 'connection-key-help'} disabled={busy} /></label>
  {#if providerCatalog[draft.selected].keyUrl}<p id="connection-key-help" class="key-help"><a href={providerCatalog[draft.selected].keyUrl} target="_blank" rel="noopener noreferrer">Get your {providerNames[draft.selected]} API key <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a></p>{:else}<p id="connection-key-help" class="notice">Use the key from your provider’s dashboard.</p>{/if}
  {#if keyError}<p class="field-error" id="connection-key-error" role="alert">{keyError}</p>{/if}
  {#if profile.apiKey}<button class="ghost key-remove" type="button" onclick={() => { profile.apiKey = ''; profile.keyOrigin = '' }} disabled={busy}>Remove key on save</button>{/if}
  {#if envApiKey(draft.selected)}<p class="notice">Development: an empty key uses your local test key at the default endpoint.</p>{/if}
  <section class="model-selection" aria-label="Selected model">
    <div class="model-heading"><h3>Model</h3>{#if profile.model === providerDefaults[draft.selected].model && profile.model}<span class="badge">Default</span>{/if}</div>
    <p class="model-name">{profile.model || 'Enter a model for your endpoint'}</p>
    {#if olderStarter}<div class="model-warning"><p>An older starter model is saved.</p><button type="button" class="ghost" disabled={busy} onclick={() => { profile.model = providerDefaults.featherless.model; profile.compatibility = providerDefaults.featherless.compatibility; status = 'Current starter selected. Test it and save when ready.' }}>Use current Featherless starter</button></div>{/if}
    <details class="model-browser" bind:open={modelBrowserOpen}><summary>Choose another model</summary>
      {#if providerCatalog[draft.selected].modelList}
        <p class="notice">Load models available from this provider, then select one.</p>
        <button type="button" class="ghost" disabled={busy || !allowNetwork} onclick={() => void loadModels()}>{loadingModels ? 'Loading models…' : 'Load provider models'}</button>
        {#if catalog}
          <label>Model search<input bind:value={modelQuery} maxlength="100" placeholder="Filter by model name" disabled={busy} /></label>
          <label>Available models<select bind:this={modelSelect} value={matchingModels.includes(profile.model) ? profile.model : ''} disabled={busy} onchange={event => { if (event.currentTarget.value) { profile.model = event.currentTarget.value; probeText = ''; status = 'Model selected. Save when ready.' } }}><option value="" disabled>Choose a model</option>{#each matchingModels as id}<option value={id}>{id}</option>{/each}</select></label>
          <p class="notice">{matchingModels.length} matching models.{catalog.partial ? ' This list may be partial; refine the search and load again.' : ''}</p>
        {/if}
      {/if}
      <label>Model ID<input bind:value={profile.model} placeholder={providerDefaults[draft.selected].model || 'Model ID from your provider'} disabled={busy} /></label>
      <p class="notice">You can enter a model ID manually. Availability depends on your account.</p>
    </details>
  </section>
  {#if probeText}<section class="probe" aria-label="Model test reply"><h3>Test reply</h3><p>{probeText}</p><p class="notice">This checks a text reply. Lesson tools are checked when preparing a lesson.</p></section>{/if}
  <details class="advanced" bind:open={advancedOpen}><summary>Advanced connection settings</summary>
    <label>API endpoint<input bind:value={profile.baseUrl} placeholder="https://…/v1" disabled={busy} /></label>
    <label>API compatibility<select value={profile.compatibility ?? 'standard'} onchange={event => { profile.compatibility = event.currentTarget.value as ProviderCompatibility }} disabled={busy}><option value="standard">Standard OpenAI-compatible</option><option value="alibaba">Alibaba Qwen (non-thinking)</option><option value="featherless">Featherless (non-thinking where supported)</option><option value="anthropic">Anthropic OpenAI-compatible API</option><option value="minimax">MiniMax (separate reasoning)</option><option value="openrouter">OpenRouter</option></select></label>
    {#if profile.compatibility === 'alibaba'}<p class="notice">Token Plan subscriptions use a dedicated endpoint and key. Match both to your plan; API compatibility alone does not switch accounts.</p>{/if}
    <p class="notice">Provider defaults are ready to use. Change these only for a different endpoint or API format. Saving approves this key for the selected endpoint.</p>
    <p class="notice">Branches can override the model. Use Node tools to manage a branch override.</p>
  </details>
  <details class="optional-search"><summary>Optional web search</summary>
    <p class="notice">Add a Tavily key for fresh web search. It is separate from your AI provider.</p>
    <label>Tavily API key<input type="password" autocomplete="off" spellcheck="false" bind:value={draft.tavily.apiKey} placeholder={envApiKey('tavily') ? 'Local testing key available' : 'tvly-…'} disabled={busy} /></label>
    {#if draft.tavily.apiKey}<button class="ghost" type="button" onclick={() => { draft.tavily.apiKey = '' }} disabled={busy}>Remove search key on save</button>{/if}
  </details>
  <details class="storage"><summary>How keys are stored</summary><p class="notice">Keys stay in this browser’s localStorage and are sent directly to their matching provider. Browser scripts can read them. Backups exclude keys. Connection tests send a small request and may use provider credits.</p></details>
  {#snippet footer()}
    <p role="status" tabindex="-1" bind:this={resultStatus} class="status">{status}</p>
    <div class="actions"><button type="button" class="ghost" onclick={() => void test()} disabled={busy || !allowNetwork}>Test connection</button><button type="button" onclick={() => void save()} disabled={busy}>Save connection</button></div>
    {#if testing || loadingModels}<button type="button" class="ghost stop" onclick={() => controller?.abort()}>Cancel provider request</button>{/if}
  {/snippet}
</Modal>

<style>
  .intro { margin: 0 0 5px; font-size: 15px; }.draft-note { margin-top: 0; }
  label { display: grid; gap: 7px; margin: 18px 0 8px; font-size: 13px; }
  input, select { width: 100%; box-sizing: border-box; padding: 10px; min-height: 44px; border: 1px solid #3a4352; border-radius: 8px; background: #12141a; color: inherit; font-size: 16px; }
  input[aria-invalid="true"] { border-color: #ed9b9b; }.field-error { color: #ffc1c1; font-size: 13px; line-height: 1.5; }
  .notice { color: #a9b2c4; font-size: 12px; line-height: 1.6; }
  .key-help { margin: 5px 0 12px; font-size: 13px; }a { color: #a9c7ff; text-underline-offset: 3px; }.key-remove { font-size: 12px; min-height: 36px; }
  .model-selection { margin: 22px 0 18px; }.model-heading { display: flex; align-items: center; gap: 10px; }h3 { font-size: 14px; margin: 0; }.badge { border: 1px solid #405a72; background: #223444; color: #c2e0fa; padding: 3px 8px; border-radius: 20px; font-size: 11px; }
  .model-name { margin: 10px 0; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
  details { border-top: 1px solid #354154; padding: 12px 0; }summary { cursor: pointer; color: #b9d0f6; font-size: 13px; min-height: 24px; line-height: 24px; }.model-browser { border: 1px solid #354154; border-radius: 8px; padding: 10px 12px; }.model-browser summary { min-height: 28px; line-height: 28px; }
  .actions { display: flex; gap: 10px; justify-content: flex-end; }.actions button { flex: 1; min-height: 44px; }
  .status { font-size: 13px; margin: 0 0 10px; max-height: 60px; overflow: auto; overflow-wrap: anywhere; }.status:empty { display: none; }
  .model-warning { border-left: 3px solid #caa160; padding-left: 12px; font-size: 13px; }.probe { border: 1px solid #3a4352; padding: 12px; border-radius: 8px; }.probe p { white-space: pre-wrap; overflow-wrap: anywhere; }.stop { margin-top: 10px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
</style>
