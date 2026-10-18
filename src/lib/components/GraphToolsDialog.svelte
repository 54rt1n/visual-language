<script lang="ts">
  import { GENERATION_OUTPUT_TOKENS } from '../ai/generationBudget'
  import { untrack } from 'svelte'
  import Modal from './Modal.svelte'
  import { configTypes, type GraphNode } from '../domain/graph'
  import { GraphService, configLabels, conversationAnchor, deletionScope, isConversation, type ConfigKind } from '../graph/graphService'
  import { effectiveConfiguration } from '../graph/contracts'
  import { teacherHost, workspaceClock } from '../teacher/host'
  import { downloadBackup, exportBackup } from '../storage/backup'
  import type { WorkspaceState } from '../state/workspace.svelte'
  import type { WorkspaceSnapshot } from '../storage/repository'
  import { providerIds, providerNames, type Settings } from '../settings'
  import type { LearnerProfile } from '../domain/learning'

  let { workspace, settings, nodeId, onChanged, onReveal, onRegenerate, onClose }: { workspace: WorkspaceState; settings: Settings; nodeId?: string; onChanged: (snapshot: WorkspaceSnapshot) => void; onReveal: (id: string) => void; onRegenerate: (id: string) => void; onClose: () => void } = $props()
  const host = untrack(() => teacherHost(workspace, onChanged)), clock = untrack(() => workspaceClock(workspace))
  const document = $derived(workspace.snapshot!.state)
  let selectedId = $state(untrack(() => nodeId ?? document.view.selectedNodeIds[0] ?? document.view.activeRootId))
  const selected = $derived(document.nodes.find(n => n.id === selectedId)), anchor = $derived(selected ? conversationAnchor(document, selected.id) : undefined)
  const effective = $derived(anchor ? effectiveConfiguration(anchor.id, document.nodes, document.edges) : {})
  const roots = $derived(document.nodes.filter(n => n.type === 'root'))
  let text = $state(''), kind = $state<ConfigKind>('modelConfig')
  let model = $state({ provider: untrack(() => settings.selected), model: untrack(() => settings.profiles[settings.selected].model), temperature: 0.4, maxTokens: GENERATION_OUTPUT_TOKENS })
  let prompt = $state(''), words = $state(''), vocabularyInstruction = $state('')
  let learning = $state<LearnerProfile>(untrack(() => structuredClone(document.learners.find(l => l.id === document.activeLearnerId)!)))
  let busy = $state(false), error = $state(''), notice = $state(''), confirmDelete = $state(false)
  let branchSettingsOpen = $state(false)
  $effect(() => { if (inherited?.type === 'modelConfig' && inherited.data.requiresReview) branchSettingsOpen = true })
  let pendingDelete = $state<ReturnType<typeof deletionScope> | null>(null)
  const attached = $derived(anchor ? document.edges.find(e => e.data.kind === 'context' && e.target === anchor.id && document.nodes.find(n => n.id === e.source)?.type === kind) : undefined)
  const inherited = $derived(effective[kind])
  let loadedNode = '', loadedConfig = ''
  function title(node: GraphNode) { return node.type === 'root' ? node.data.name : node.type === 'exercise' ? 'Saved exercise' : 'text' in node.data ? `${node.type}: ${node.data.text.slice(0, 65)}` : (configLabels as Record<string, string>)[node.type] ?? node.type }
  $effect(() => {
    if (selected?.id === loadedNode) return
    loadedNode = selected?.id ?? ''; text = selected?.type === 'root' ? selected.data.name : selected && 'text' in selected.data ? selected.data.text : ''
    pendingDelete = null; confirmDelete = false
    if (selected && (configTypes as readonly string[]).includes(selected.type)) kind = selected.type as ConfigKind
  })
  $effect(() => {
    const data = inherited?.data, signature = JSON.stringify([anchor?.id, kind, data])
    if (signature === loadedConfig) return
    loadedConfig = signature
    untrack(() => {
      if (kind === 'modelConfig') model = inherited?.type === kind ? { provider: inherited.data.provider, model: inherited.data.model, temperature: inherited.data.temperature, maxTokens: inherited.data.maxTokens } : { provider: settings.selected, model: settings.profiles[settings.selected].model, temperature: 0.4, maxTokens: GENERATION_OUTPUT_TOKENS }
      if (kind === 'systemConfig') prompt = inherited?.type === kind ? inherited.data.prompt : ''
      if (kind === 'vocabularyConfig') { words = inherited?.type === kind ? inherited.data.words.join('\n') : ''; vocabularyInstruction = inherited?.type === kind ? inherited.data.instruction : '' }
      if (kind === 'learningConfig') learning = { ...document.learners.find(l => l.id === document.activeLearnerId)!, ...(inherited?.type === kind ? inherited.data : {}) }
    })
  })
  async function work(action: () => Promise<void>) {
    if (busy) return
    busy = true; error = ''; notice = ''
    try { await action() } catch (cause) { error = cause instanceof Error ? cause.message : 'The graph operation did not complete. Your draft remains visible.' }
    finally { busy = false }
  }
  const command = (action: (service: GraphService, snapshot: WorkspaceSnapshot) => Promise<WorkspaceSnapshot>) => host.apply((snapshot, repository) => action(new GraphService(repository, clock), snapshot))
  async function saveText() { await work(async () => { await command((service, s) => service.editText(s, selectedId, text)); notice = 'Text saved. Existing replies and frozen learning records were not rewritten.' }) }
  async function saveConfig() {
    await work(async () => {
      if (!anchor) return
      const { id: _id, ...preferences } = learning
      const data = kind === 'modelConfig' ? { ...model, model: model.model.trim() } : kind === 'systemConfig' ? { prompt: prompt.trim() } : kind === 'vocabularyConfig' ? { words: [...new Set(words.split('\n').map(w => w.trim()).filter(Boolean))], instruction: vocabularyInstruction.trim() } : preferences
      await command((service, s) => service.setConfiguration(s, anchor!.id, kind, data))
      notice = 'Branch override saved. It applies to future requests; frozen lessons and sibling branches keep their existing records.'
    })
  }
  async function removeOverride() { await work(async () => { await command((service, s) => service.removeConfiguration(s, anchor!.id, kind)); notice = 'This override was removed; the nearest ancestor setting or workspace default applies now.' }) }
  async function removeSubtree() {
    if (!pendingDelete || !confirmDelete) return
    const preview = pendingDelete, target = selectedId
    await work(async () => {
      await command((service, s) => service.deleteSubtree(s, target, preview.nodeIds))
      selectedId = host.current().state.view.selectedNodeIds[0] ?? host.current().state.view.activeRootId; pendingDelete = null; confirmDelete = false
      notice = `Removed ${preview.nodeIds.length} graph nodes and ${preview.edgeIds.length} edges. Learning items, attempts, sources, and schedules are retained. Restore graph content from a downloaded backup if needed.`
    })
  }
</script>

<Modal title="Node tools" onClose={() => { if (!busy) onClose() }}>
  <div class="graph-tools">
    <label>Selected graph node<select bind:value={selectedId} disabled={busy}>{#each roots as root}<optgroup label={root.data.name}>{#each document.nodes.filter(n => n.rootId === root.id) as node}<option value={node.id}>{node.bookmarked ? '★ ' : ''}{title(node)}</option>{/each}</optgroup>{/each}</select></label>
    <button type="button" class="ghost" disabled={busy || !selected} onclick={() => onReveal(selectedId)}>Show on canvas</button>
    {#if selected}
      <section><h3>Selected {selected.type === 'root' ? 'topic' : 'node'}</h3>
        <div class="actions"><button type="button" class="ghost" disabled={busy} onclick={() => void work(async () => { await command((service, s) => service.setFlag(s, selectedId, 'bookmarked', !selected!.bookmarked)) })}>{selected.bookmarked ? 'Remove bookmark' : 'Bookmark node'}</button><button type="button" class="ghost" disabled={busy} onclick={() => void work(async () => { await command((service, s) => service.setFlag(s, selectedId, 'collapsed', !selected!.collapsed)) })}>{selected.collapsed ? 'Expand branch' : 'Collapse branch'}</button></div>
        {#if isConversation(selected)}<form onsubmit={event => { event.preventDefault(); void saveText() }}><label>{selected.type === 'root' ? 'Topic name' : 'Message text'}<textarea bind:value={text} maxlength={selected.type === 'root' ? 200 : 100000} rows={selected.type === 'root' ? 2 : 5} required disabled={busy}></textarea></label><p class="small">Editing does not regenerate existing replies or change saved learning items, sources, questions, or grades.</p><div class="actions"><button type="submit" disabled={busy || !text.trim()}>Save text</button>{#if selected.type === 'assistant'}<button type="button" class="ghost" disabled={busy} onclick={() => onRegenerate(selectedId)}>Generate alternative reply</button>{/if}</div></form>{/if}
        {#if selected.type === 'assistant'}<p class="small">An alternative uses a new reply node, preserving this reply, descendants, and learning history. Save any text edits above first.</p>{:else if selected.type === 'user'}<button type="button" class="ghost" disabled={busy} onclick={() => onRegenerate(selectedId)}>Generate reply to this message</button>{/if}
      </section>
      {#if anchor}
        <details class="branch-settings" bind:open={branchSettingsOpen}><summary>Branch settings</summary><div class="settings-body"><p class="small">Customize future replies from {title(anchor)}. Other branches keep their settings.</p>
          <label>Setting type<select bind:value={kind} disabled={busy}>{#each configTypes as type}<option value={type}>{configLabels[type]}</option>{/each}</select></label>
          <p class="small">{attached ? 'Override attached here.' : inherited ? 'Inherited from an ancestor. Saving creates an override here.' : 'Using workspace defaults. Saving creates an override here.'}</p>
          {#if inherited?.type === 'modelConfig' && inherited.data.requiresReview}<p class="error" role="status">Imported model needs review (original provider: {inherited.data.originalProvider}). Choose a provider and available model, then Save branch override. Keys/endpoints still require separate approval in Settings.</p>{/if}
          <form onsubmit={event => { event.preventDefault(); void saveConfig() }}>
            {#if kind === 'modelConfig'}<div class="columns"><label>Branch provider<select bind:value={model.provider} disabled={busy}>{#each providerIds as id}<option value={id}>{providerNames[id]}</option>{/each}</select></label><label>Branch model ID<input bind:value={model.model} maxlength="200" required disabled={busy} /></label></div><div class="columns"><label>Temperature<input type="number" min="0" max="2" step="0.1" bind:value={model.temperature} disabled={busy} /></label><label>Maximum output tokens<input type="number" min="64" max="16000" step="1" bind:value={model.maxTokens} disabled={busy} /></label></div><p class="small">Uses only the selected provider’s separately approved endpoint and key in Settings. No credential is stored in this node. Temperature applies to conversation; native quiz drafting, structured teaching, grading, and content review use 0.2. All requests honor this token ceiling and may use smaller task limits.</p>
            {:else if kind === 'systemConfig'}<label>Branch instruction<textarea bind:value={prompt} rows="5" maxlength="8000" required disabled={busy}></textarea></label><p class="small">A learner instruction for conversation and teacher context; it cannot grant tools or change scheduling rules.</p>
            {:else if kind === 'vocabularyConfig'}<label>Vocabulary — one word or phrase per line<textarea bind:value={words} rows="5" maxlength="30100" disabled={busy}></textarea></label><label>Vocabulary guidance<textarea bind:value={vocabularyInstruction} rows="3" maxlength="2000" disabled={busy}></textarea></label><p class="small">Up to 100 saved entries; requests use a bounded selection. These are contextual preferences, not automatically introduced cards.</p>
            {:else}<label>Branch learning goal<textarea bind:value={learning.goal} maxlength="2000" disabled={busy} required></textarea></label><div class="columns"><label>Branch level<select bind:value={learning.level} disabled={busy}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option><option value="native">Native-level complexity</option></select></label><label>Branch explanation language<input bind:value={learning.explanationLanguage} maxlength="100" disabled={busy} required /></label></div><label>Branch language balance<select bind:value={learning.languageBalance} disabled={busy}><option value={undefined}>Balanced (default)</option><option value="mostlyTarget">Mostly Mandarin</option><option value="balanced">Balanced</option><option value="mostlyNative">Mostly explanation language</option></select></label><label>Branch pinyin display<select bind:value={learning.pinyinDisplay} disabled={busy}><option value="always">Always</option><option value="onDemand">On demand</option><option value="hidden">Hidden</option></select></label><div class="columns"><label>Topic lesson review limit<input type="number" min="1" max="100" bind:value={learning.maxReviewCards} disabled={busy} /></label><label>Topic lesson new-item limit<input type="number" min="0" max="20" bind:value={learning.maxNewItems} disabled={busy} /></label></div><p class="small">A topic-root override supplies limits when starting a lesson scoped to that topic. All-topic lessons retain workspace limits. Existing sessions and schedules do not change.</p>{/if}
            <div class="actions"><button type="submit" disabled={busy}>Save branch override</button>{#if attached}<button type="button" class="ghost" disabled={busy} onclick={removeOverride}>Remove override / inherit</button>{/if}</div>
          </form>
        </div></details>
      {/if}
      <details class="danger"><summary>Delete this branch…</summary><div class="settings-body"><p>Removes graph nodes and connecting edges only. Learning records and source excerpts survive with missing-source indicators. Deleting a topic includes its entire graph. Keep a downloaded backup if you may need this layout/text again.</p><div class="actions"><button type="button" class="ghost" disabled={busy} onclick={() => void work(async () => { downloadBackup(exportBackup(await workspace.flush())); notice = 'Full backup download started. It contains private learning data and quiz answers, but no provider keys.' })}>Download backup before deleting</button><button type="button" class="ghost" disabled={busy} onclick={() => { pendingDelete = deletionScope(document, selectedId); confirmDelete = false }}>Preview subtree deletion</button></div>
        {#if pendingDelete}<div class="deletion-preview"><p>{pendingDelete.nodeIds.length} nodes and {pendingDelete.edgeIds.length} edges will be removed. {pendingDelete.learningItems} linked learning items will be kept.</p><label class="check"><input type="checkbox" bind:checked={confirmDelete} disabled={busy} /> Delete this exact graph subtree; retain learning history.</label><div class="actions"><button type="button" disabled={busy || !confirmDelete || !roots.some(root => !pendingDelete!.nodeIds.includes(root.id))} onclick={removeSubtree}>Delete confirmed subtree</button><button type="button" class="ghost" disabled={busy} onclick={() => { pendingDelete = null; confirmDelete = false }}>Cancel deletion</button></div>{#if !roots.some(root => !pendingDelete!.nodeIds.includes(root.id))}<p>Create another topic before deleting the last root.</p>{/if}</div>{/if}
      </div></details>
    {/if}
    {#if busy}<p role="status">Saving graph changes…</p>{/if}{#if notice}<p role="status">{notice}</p>{/if}{#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</Modal>
<style>
  .graph-tools { display: grid; gap: 20px; }section,form { display: grid; gap: 12px; }h3,p { margin: 0; }h3 { color: #b9d0f6; }p { line-height: 1.5; }label { display: grid; gap: 6px; font-size: 12px; }input,select,textarea { width: 100%; min-width: 0; padding: 9px; background: #111722; border: 1px solid #3d485d; border-radius: 7px; color: inherit; font: inherit; }.columns { display: flex; gap: 10px; }.columns label { flex: 1; min-width: 0; }.actions { display: flex; flex-wrap: wrap; gap: 8px; }.small { font-size: 12px; color: #a9b2c4; }.check { grid-template-columns: auto 1fr; align-items: start; }.check input { width: auto; }.deletion-preview { display: grid; gap: 12px; padding: 12px; border: 1px solid #b77777; border-radius: 8px; }.error { color: #f4a3a3; }.settings-body { display: grid; gap: 12px; padding-top: 14px; }.branch-settings,.danger { border-top: 1px solid #354154; padding-top: 18px; }.danger summary { color: #f4a3a3; }summary { cursor: pointer; }@media(max-width:520px) { .columns { flex-direction: column; } }
</style>
