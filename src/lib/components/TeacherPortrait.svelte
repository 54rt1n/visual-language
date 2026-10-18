<script lang="ts">
  import { availablePortrait, portraitFile, portraitState, type PortraitState } from '../teacher/portrait'
  let { state: pose = 'attentive', variant = 'lesson' }: { state?: unknown; variant?: 'strip' | 'lesson' | 'discovery' } = $props()
  let failed = $state<PortraitState[]>([])
  const shown = $derived(availablePortrait(pose, failed))
  function unavailable(event: Event) {
    const pose = portraitState((event.currentTarget as HTMLImageElement).dataset.pose)
    if (!failed.includes(pose)) failed = [...failed, pose]
  }
</script>
<div class="portrait" class:strip={variant === 'strip'} class:discovery={variant === 'discovery'} data-testid="teacher-portrait">
  {#if shown}
    {#key shown}<img src={`${import.meta.env.BASE_URL}${portraitFile(shown)}`} data-pose={shown} alt="" width="1254" height="1254" loading="lazy" decoding="async" onerror={unavailable} />{/key}
  {:else}
    <div class="fallback"><span>Zheng</span><small>Portrait unavailable</small><button type="button" class="ghost" onclick={() => { failed = [] }}>Retry portrait</button></div>
  {/if}
</div>
<style>
  .portrait { width: 96px; height: 96px; flex: 0 0 auto; align-self: center; }.portrait.strip { width: 120px; height: 120px; align-self: end; }.portrait.discovery { width: 80px; height: 80px; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center bottom; }.fallback { height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 4px; color: #b9d0f6; text-align: center; overflow-wrap: anywhere; }small { font-size: 10px; }.fallback button { padding: 4px; font-size: 10px; }
  @media(max-width: 640px) { .portrait,.portrait.strip,.portrait.discovery { width: 80px; height: 80px; } }
</style>
