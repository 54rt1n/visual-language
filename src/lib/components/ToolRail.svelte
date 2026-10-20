<script lang="ts">
  import { BookOpen, ListChecks, GraduationCap, BookmarkPlus, Search, Settings2, Plus, PanelsTopLeft, Compass, Ellipsis, PanelLeftOpen, PanelLeftClose } from '@lucide/svelte'
  let { disabled, settingsDisabled, conflicted, onSelect }: { disabled: boolean; settingsDisabled: boolean; conflicted: boolean; onSelect: (action: string) => void } = $props()
  function initialExpanded() {
    try { return localStorage.getItem('vl-tool-labels-v1') !== 'hide' } catch { return true }
  }
  let expanded = $state(initialExpanded()), container = $state<HTMLDivElement>(), overflow = $state(false), atEnd = $state(false)
  let tooltip = $state<{ text: string; x: number; y: number; anchor: HTMLElement } | null>(null)
  function toggleLabels() {
    expanded = !expanded; tooltip = null
    try { localStorage.setItem('vl-tool-labels-v1', expanded ? 'show' : 'hide') } catch { /* Keep the toggle usable when browser storage is restricted. */ }
  }
  const groups = [
    { name: 'Learning', tools: [
      { id: 'lessons', label: 'Lessons', name: 'Lessons', hint: 'Continue lessons, review, track progress, and manage your collection.', icon: ListChecks },
      { id: 'teacher', label: 'Daily review', name: 'Daily review', hint: 'Review saved words and learn new ones.', icon: GraduationCap },
      { id: 'discovery', label: 'Explore', name: 'Explore a topic', hint: 'Create a lesson from a topic, scenario, or interest.', icon: Compass },
      { id: 'capture', label: 'Save for practice', name: 'Save for practice', hint: 'Save a Mandarin word or phrase to practice.', icon: BookmarkPlus },
      { id: 'library', label: 'Library', name: 'Library', hint: 'Browse your study cards and saved explanations.', icon: BookOpen },
      { id: 'search', label: 'Search', name: 'Search', hint: 'Find saved learning or search the web.', icon: Search },
    ] },
    { name: 'Workspace', tools: [
      { id: 'topics', label: 'Topics', name: 'Topics', hint: 'Open, rename, and organize your conversations.', icon: PanelsTopLeft },
      { id: 'new-topic', label: 'New topic', name: 'New topic', hint: 'Start a new conversation topic.', icon: Plus },
    ] },
    { name: 'Utilities', tools: [
      { id: 'settings', label: 'Settings', name: 'Settings', hint: 'AI connection, audio, pinyin, and appearance.', icon: Settings2 },
      { id: 'more', label: 'More', name: 'More tools', hint: 'Backups, installation, app information, and demo.', icon: Ellipsis },
    ] },
  ]
  function measure() {
    if (!container) return
    overflow = container.scrollHeight > container.clientHeight + 1
    atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 2
    // Keyboard focus can scroll its button into view. Keep that button's hint
    // attached after the scroll instead of immediately clearing it.
    if (tooltip && document.activeElement === tooltip.anchor) {
      const rect = tooltip.anchor.getBoundingClientRect()
      tooltip = { ...tooltip, x: rect.right + 14, y: Math.min(rect.top, window.innerHeight - 100) }
    } else tooltip = null
  }
  $effect(() => {
    if (!container) return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  })
  function describe(event: FocusEvent | PointerEvent, text: string) {
    if ('pointerType' in event && event.pointerType === 'touch') return
    const anchor = event.currentTarget as HTMLElement, rect = anchor.getBoundingClientRect()
    tooltip = { text, anchor, x: rect.right + 14, y: Math.min(rect.top, window.innerHeight - 100) }
  }
</script>

<nav class="tool-rail" class:expanded aria-label="Workspace tools">
  <button type="button" class="ghost label-toggle" aria-label={expanded ? 'Hide tool labels' : 'Show tool labels'} aria-expanded={expanded} aria-controls="workspace-tool-buttons" onclick={toggleLabels}>
    {#if expanded}<PanelLeftClose size={20} /><span>Hide labels</span>{:else}<PanelLeftOpen size={20} />{/if}
  </button>
  <div class="tool-buttons" id="workspace-tool-buttons" bind:this={container} onscroll={measure}>
    {#each groups as group}
      <div class="tool-group" role="group" aria-label={group.name}>
        {#if expanded}<span class="group-label">{group.name}</span>{/if}
        {#each group.tools as tool}
          <button type="button" class="ghost" aria-label={tool.name} disabled={tool.id === 'settings' ? settingsDisabled : disabled || (conflicted && tool.id === 'new-topic')} aria-describedby={`tool-hint-${tool.id}`}
            onpointerenter={event => describe(event, `${tool.name} — ${tool.hint}`)} onpointerleave={() => { tooltip = null }}
            onkeydown={event => { if (event.key === 'Escape') tooltip = null }}
            onfocus={event => describe(event, `${tool.name} — ${tool.hint}`)} onblur={() => { tooltip = null }}
            onclick={() => { tooltip = null; onSelect(tool.id) }}>
            <tool.icon size={21} />{#if expanded}<span>{tool.label}</span>{/if}
          </button>
          <span class="sr-only" id={`tool-hint-${tool.id}`}>{tool.hint}</span>
        {/each}
      </div>
    {/each}
  </div>
  {#if overflow}<button type="button" class="ghost scroll-tools" aria-label={atEnd ? 'Back to first workspace tools' : 'Scroll to more tools'} aria-controls="workspace-tool-buttons" onclick={() => container?.scrollTo({ top: atEnd ? 0 : container.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>{atEnd ? 'Top ↑' : 'Scroll ↓'}</button>{/if}
</nav>
{#if tooltip}<div class="tool-tooltip" role="tooltip" style:left={`${tooltip.x}px`} style:top={`${tooltip.y}px`}>{tooltip.text}</div>{/if}

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .tool-rail { position: absolute; z-index: 5; left: 14px; top: 14px; display: flex; flex-direction: column; padding: 6px; width: 64px; max-height: calc(100% - 70px); border: 1px solid #354154; border-radius: 12px; background: #1a1d26f5; box-shadow: 0 8px 20px #0004; }
  .tool-rail.expanded { width: 172px; }
  .tool-buttons { min-height: 0; overflow-y: auto; scrollbar-width: thin; }
  .tool-group { display: grid; gap: 3px; padding-block: 5px; }.tool-group + .tool-group { border-top: 1px solid #354154; }
  button { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 8px; min-width: 44px; min-height: 44px; border-color: transparent; font-size: 13px; white-space: nowrap; }
  .expanded button { justify-content: start; }.label-toggle { flex-shrink: 0; border-bottom-color: #354154; border-radius: 6px 6px 0 0; }
  button:hover:not(:disabled),button:focus-visible { background: #29364d; color: #e3edff; }button:focus-visible { outline-offset: -3px; }
  .group-label { padding: 4px 8px; font-size: 11px; color: #a9b2c4; }
  .scroll-tools { flex-shrink: 0; font-size: 10px; padding: 4px 0; border-top-color: #354154; border-radius: 0 0 6px 6px; }.expanded .scroll-tools { justify-content: center; }
  .tool-tooltip { position: fixed; z-index: 8; max-width: min(260px, calc(100vw - 200px)); padding: 9px 12px; border: 1px solid #536781; border-radius: 8px; background: #222b3c; color: #e8eaed; box-shadow: 0 4px 16px #0006; font-size: 12px; pointer-events: none; }
  @media(max-width:880px) { .tool-rail { max-height: calc(100% - var(--teacher-height) - max(12px, env(safe-area-inset-bottom)) - 70px); } }
  /* On a short landscape screen, scroll the whole rail so fixed controls cannot
     squeeze the tool list below the height of one touch target. */
  @media(max-width:880px) and (max-height:420px) {
    .tool-rail { overflow-y: auto; scrollbar-width: thin; }
    .tool-buttons { overflow: visible; flex-shrink: 0; }
    .scroll-tools { display: none; }
  }
</style>
