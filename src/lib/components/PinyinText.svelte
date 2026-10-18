<script lang="ts">
  import type { LearnerProfile } from '../domain/learning'
  let { text, mode = 'always', label = 'Show pinyin' }: { text?: string; mode?: LearnerProfile['pinyinDisplay']; label?: string } = $props()
  let open = $state(false)
</script>
{#if text && mode !== 'hidden'}
  <div class="pinyin-control">{#if mode === 'onDemand'}<button type="button" class="ghost" aria-expanded={open} onclick={() => { open = !open }}>{open ? 'Hide pinyin' : label}</button>{/if}{#if mode === 'always' || open}<p lang="zh-Latn">{text}</p>{/if}</div>
{/if}
<style>.pinyin-control { display: grid; gap: 6px; justify-items: start; }.pinyin-control button { font-size: 12px; padding: 5px 8px; }p { margin: 0; color: #bdd3f4; font-size: 13px; line-height: 1.5; }</style>
