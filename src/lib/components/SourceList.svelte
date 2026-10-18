<script lang="ts">
  import type { SourceSnapshot } from '../domain/workspace'
  let { sources, onReveal }: { sources: SourceSnapshot[]; onReveal?: (nodeId: string) => void } = $props()
</script>
{#if sources.length}
  <section class="sources" aria-label="Saved sources"><h4>Sources</h4>{#each sources as source (source.id)}
    <details><summary>{source.kind === 'web' ? 'Web' : 'Saved learning'} · {source.title}</summary>
      <p>{source.excerpt}</p><small>{source.adapted ? 'Teacher-adapted material. ' : ''}Retrieved {new Date(source.retrievedAt).toLocaleString()}{source.publishedAt ? ` · Published ${source.publishedAt}` : ''}</small>
      {#if source.url}<a href={source.url} target="_blank" rel="noopener noreferrer">Open cited page ↗</a>{/if}
      {#if source.nodeId && onReveal}<button type="button" class="ghost" onclick={() => onReveal?.(source.nodeId!)}>Reveal graph source</button>{/if}
    </details>
  {/each}</section>
{/if}
<style>.sources { display: grid; gap: 8px; }h4,p { margin: 0; }details { background: #161e2b; border-radius: 7px; padding: 9px; font-size: 12px; }summary { cursor: pointer; color: #b9d0f6; }p { margin: 9px 0; white-space: pre-wrap; line-height: 1.5; }small,a { display: block; margin-top: 7px; }small { color: #a9b2c4; }a { color: #abd1ff; }</style>
