<script lang="ts">
  import { lessonForSession } from '../domain/lesson'
  import type { Workspace } from '../domain/workspace'
  import { lessonSummary } from '../learning/lessonProgress'
  import { focusLabels } from '../domain/lessonPlan'
  let { document }: { document: Workspace } = $props()
  const lessons = $derived(document.sessions.filter(s => s.learnerId === document.activeLearnerId && s.status === 'completed' && s.lessonAttempt)
    .map(session => ({ session, summary: lessonSummary(document, session)! })).reverse())
</script>
<section aria-label="Learning growth" class="growth">
  <h3>Your learning growth</h3>
  <p>Lesson checks record the phrases, quiz support, and language you practiced. Daily review measures what you recognize later.</p>
  {#if !lessons.length}<p>Getting started. Complete a lesson from <strong>Practice this conversation</strong> or <strong>Explore a topic</strong> to see your first results here.</p>{/if}
  <div class="paths">
    <article><h4>Character recognition</h4><p>Compare phrase understanding with and without pinyin. Phrase results do not establish knowledge of each individual character.</p></article>
    <article><h4>Language complexity</h4><p>Track common phrases, simple sentences, and connected sentences separately.</p></article>
    <article><h4>Topics and situations</h4><p>Explore more specific interests while choosing the language complexity and support that suit you.</p></article>
  </div>
  {#each lessons as { session, summary }}
    <article>
      <h4>{summary.topic}</h4><p>{session.goal}</p>
      <p><strong>{summary.correct} of {summary.total} correct on your first try without help</strong></p>
      <p>{summary.format} · {summary.complexity} · {summary.scope}</p>
      <p>{summary.helped} used help · {summary.skipped} skipped · {summary.unanswered} unanswered or unresolved</p>
      <p>Focus: {focusLabels[lessonForSession(document, session)!.settings.focus]} · {new Date(session.updatedAt).toLocaleDateString()}</p>
      <p>{summary.evidence.level ? `Level ${summary.evidence.level} of 4` : 'Working toward Level 1'} · {summary.evidence.points}/10 lesson points.</p><p>{summary.next}</p>
    </article>
  {/each}
</section>
<style>
  .growth,.paths,article { display: grid; gap: 12px; }article { padding: 14px; border: 1px solid #354154; border-radius: 10px; }h3,h4,p { margin: 0; }p { line-height: 1.5; } .paths p { color: #b9c5d9; font-size: 13px; }
</style>
