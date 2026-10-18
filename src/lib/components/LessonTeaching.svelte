<script lang="ts">
  import type { LearningItem, LearnerProfile } from '../domain/learning'
  import type { LessonWaypoint } from '../domain/lessonGraph'
  import type { lessonSourceSchema, LessonKind } from '../domain/lessonSettings'
  import type { z } from 'zod'
  import PinyinText from './PinyinText.svelte'
  import SpeechButton from './SpeechButton.svelte'
  import { mandarinPinyin } from '../mandarin/chineseParser'

  let { items, waypoint, source, kind, context, pinyinDisplay }: {
    items: LearningItem[]; waypoint?: LessonWaypoint; source?: z.infer<typeof lessonSourceSchema>;
    kind: LessonKind; context: string; pinyinDisplay: LearnerProfile['pinyinDisplay'];
  } = $props()
  const sameExpression = (a: string, b: string) => a.trim().replace(/[。！？!?]+$/u, '') === b.trim().replace(/[。！？!?]+$/u, '')
  const terms = $derived(waypoint ? items.filter(item => !sameExpression(item.canonicalText, waypoint.exampleHanzi)) : items)
</script>

<section class="teaching" aria-label="Lesson material">
  {#if source?.scenario}<p class="scenario-role">You: {source.scenario.learnerRole} · Zheng: {source.scenario.teacherRole}</p>{/if}
  {#if waypoint}
    <div class="example">
      {#if kind === 'reading'}<p class="eyebrow">From your reading</p>{/if}
      <h3 data-lesson-heading tabindex="-1" lang="zh">{waypoint.exampleHanzi}</h3>
      <PinyinText text={mandarinPinyin(waypoint.exampleHanzi)} mode={pinyinDisplay} />
      <p class="meaning">{waypoint.exampleMeaning}</p>
      <div class="audio"><SpeechButton text={waypoint.exampleHanzi} compact playLabel="Listen" /></div>
    </div>
  {/if}
  {#each terms as item, index (item.id)}
    <div class="term">
      {#if !waypoint && index === 0}<h3 data-lesson-heading tabindex="-1" lang="zh">{item.canonicalText}</h3>{:else}<h4 lang="zh">{item.canonicalText}</h4>{/if}
      <PinyinText text={item.pinyin} mode={pinyinDisplay} />
      <p>{item.meaning}</p>
    </div>
  {/each}
  {#if waypoint}<p class="explanation">{waypoint.explanation}</p>{/if}
  {#if source?.scenario}
    <details><summary>Your scenario</summary><div class="reference" aria-label="Lesson context">
      <p>{source.scenario.situation}</p><p>You: {source.scenario.learnerRole} · Zheng: {source.scenario.teacherRole}</p>
      <p lang="zh">{source.scenario.openingHanzi}</p><PinyinText text={mandarinPinyin(source.scenario.openingHanzi)} mode={pinyinDisplay} />
      <p>{source.scenario.openingMeaning}</p><SpeechButton text={source.scenario.openingHanzi} />
    </div></details>
  {:else if source && kind === 'reading'}
    <details><summary>Your reading</summary><div class="reference" aria-label="Lesson context">
      <p class="passage" lang="zh">{source.passageHanzi}</p><PinyinText text={mandarinPinyin(source.passageHanzi)} mode={pinyinDisplay} />
      <SpeechButton text={source.passageHanzi} /><details><summary>Show passage meaning</summary><p>{source.passageMeaning}</p></details>
    </div></details>
  {/if}
  {#if context || waypoint?.objective}
    <details><summary>Lesson notes</summary><div class="reference">
      {#if waypoint}<p>{waypoint.objective}</p>{/if}
      {#if context}<p class="passage">{context}</p>{/if}
    </div></details>
  {/if}
</section>

<style>
  .teaching,.term,.example,.reference { display: grid; gap: 10px; }
  .teaching { gap: 22px; } h3,h4,p { margin: 0; overflow-wrap: anywhere; line-height: 1.55; }
  h3 { font-size: 34px; font-weight: 600; } h4 { font-size: 23px; } h3:focus { outline: none; }
  .meaning { font-size: 18px; color: #d7deeb; } .example { padding: 18px; background: #223046; border-radius: 12px; justify-items: start; }
  .audio { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; } .scenario-role { color: #b9c5d9; font-size: 14px; }
  .eyebrow { font-size: 12px; color: #b9c5d9; } .explanation { color: #d7deeb; }
  summary { cursor: pointer; color: #b9d0f6; font-size: 14px; } .reference { padding-top: 12px; font-size: 14px; }
  .passage { white-space: pre-wrap; }
  @media (max-width: 520px) { .teaching { gap: 18px; } .example { padding: 14px; } h3 { font-size: 30px; } }
</style>
