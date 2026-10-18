<script lang="ts">
  import PinyinText from './PinyinText.svelte'
  import SpeechButton from './SpeechButton.svelte'
  import type { LearnerProfile } from '../domain/learning'
  import type { feedbackMaterial } from '../teacher/feedback'
  let { material, pinyinDisplay }: { material: NonNullable<ReturnType<typeof feedbackMaterial>>; pinyinDisplay: LearnerProfile['pinyinDisplay'] } = $props()
</script>
<section class="worked-example" aria-label="Worked Mandarin example">
  <h4>Worked Mandarin example</h4><p class="small">{material.origin} {material.provenance} · {material.provenance.startsWith('fixture') ? 'Prerecorded example, not live inference.' : 'Teacher adaptation, not a source quotation.'}</p>
  <p lang="zh">{material.example.hanzi}</p><PinyinText text={material.example.pinyin} mode={pinyinDisplay} label="Show worked-example pinyin" />
  <p><strong>Meaning / translation:</strong> {material.example.meaning}</p><p>{material.example.explanation}</p><SpeechButton text={material.example.hanzi} />
</section>
<style>
  .worked-example { display: grid; gap: 9px; padding: 14px; border-left: 3px solid #ba985c; border-radius: 8px; background: #223046; }p,h4 { margin: 0; }p { line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }.small { color: #a9b2c4; font-size: 12px; }
</style>
