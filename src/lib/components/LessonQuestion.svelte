<script lang="ts">
  import type { Exercise, ReviewAttempt, LearnerProfile } from '../domain/learning'
  import type { QuizQuestion } from '../learning/quiz'
  import { quizPassageLabel } from '../learning/quiz'
  import type { feedbackMaterial } from '../teacher/feedback'
  import PinyinText from './PinyinText.svelte'
  import SpeechButton from './SpeechButton.svelte'

  let { exercise, question, attempt, quiz, busy, optionId = $bindable(''), retryOptionId = $bindable(''), needsRetry,
    remediated, helped, material, pinyinDisplay, onSubmit, onHelp, onRetry }: {
    exercise: Exercise; question?: QuizQuestion; attempt?: ReviewAttempt; quiz: boolean; busy: boolean;
    optionId?: string; retryOptionId?: string; needsRetry: boolean; remediated: boolean; helped: boolean;
    material?: ReturnType<typeof feedbackMaterial>; pinyinDisplay: LearnerProfile['pinyinDisplay'];
    onSubmit: () => void; onHelp: () => void; onRetry: (id: string) => void;
  } = $props()
  const answered = $derived(attempt?.status === 'committed')
  const feedback = $derived(attempt?.assessment?.feedback)
  const correct = $derived(exercise.multipleChoice!.options.find(o => o.id === exercise.multipleChoice!.correctOptionId)!)
</script>

<section class="question">
  <h3 data-lesson-heading tabindex="-1">{question?.stem ?? exercise.prompt}</h3>
  {#if question?.passage}
    <div class="stimulus">
      {#if quizPassageLabel(question)}<p class="small">{quizPassageLabel(question)}</p>{/if}
      <p class="hanzi" lang="zh">{question.passage}</p>
      {#if exercise.multipleChoice?.passagePinyin}<p class="pinyin" lang="zh-Latn">{exercise.multipleChoice.passagePinyin}</p>{/if}
    </div>
  {/if}
  <form id="lesson-answer" onsubmit={event => { event.preventDefault(); if (needsRetry) onRetry(retryOptionId); else onSubmit() }}>
    <fieldset disabled={busy || Boolean(attempt && !needsRetry)}>
      <legend>{needsRetry ? 'Choose again' : 'Choose one answer'}</legend>
      {#each exercise.multipleChoice!.options as option}
        <label class="phrase" class:selected={(needsRetry ? retryOptionId : optionId) === option.id}>
          {#if needsRetry}<input type="radio" name="lesson-retry" value={option.id} bind:group={retryOptionId} />
          {:else}<input type="radio" name="lesson-option" value={option.id} bind:group={optionId} />{/if}
          <span lang={exercise.multipleChoice?.quizLevel?.startsWith('meaning') ? 'en' : 'zh'}>
            {option.text}{#if option.pinyin}<small lang="zh-Latn">{option.pinyin}</small>{/if}
            {#if answered && !quiz && attempt?.selectedOptionId === option.id}<small class="first-answer">Your first answer</small>{/if}
          </span>
        </label>
      {/each}
    </fieldset>
  </form>
  {#if answered && !quiz}
    <div class="feedback" data-lesson-feedback tabindex="-1" class:correct={attempt?.assessment?.grade === 'correct'} role="status">
      <strong>{remediated ? 'Got it.' : attempt?.assessment?.grade === 'correct' ? 'Correct.' : `The answer is: ${correct.text}`}</strong>
      {#if needsRetry}<p>Use the explanation below, then choose again.</p>{/if}
    </div>
    {#if feedback || material}
      <details open={needsRetry}><summary>Why?</summary><div class="explanation">
        {#if feedback}<p>{feedback}</p>{/if}
        {#if material && material.example.hanzi !== question?.passage}
          <div class="example"><p lang="zh">{material.example.hanzi}</p><PinyinText text={material.example.pinyin} mode={pinyinDisplay} />
            <p>{material.example.meaning}</p><SpeechButton text={material.example.hanzi} />
          </div>
        {/if}
      </div></details>
    {/if}
  {:else if attempt && !answered}
    <p role="status">Your answer is saved. Retry saving it to continue.</p>
  {:else if !attempt && !quiz}
    {#if material}<details><summary>See the example</summary><div class="example">
      <p lang="zh">{material.example.hanzi}</p><PinyinText text={material.example.pinyin} mode={pinyinDisplay} />
      <p>{material.example.meaning}</p><SpeechButton text={material.example.hanzi} />
    </div></details>{/if}
    {#if helped}<aside data-lesson-feedback tabindex="-1"><strong>Answer: {correct.text}</strong><p>{exercise.multipleChoice?.explanation}</p></aside>
    {:else}<div class="help"><button type="button" class="text-button" disabled={busy} onclick={onHelp}>Show answer</button>
    </div>{/if}
  {/if}
</section>

<style>
  .question,.stimulus,.explanation,.example,.feedback,.help,aside { display: grid; gap: 12px; }
  .question { gap: 20px; } h3,p { margin: 0; line-height: 1.55; overflow-wrap: anywhere; } h3 { font-size: 21px; } h3:focus { outline: none; }
  .stimulus { padding: 18px; border-radius: 12px; background: #223046; } .hanzi { font-size: 28px; } .pinyin { font-size: 14px; color: #bdd3f4; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 10px; }
  legend { padding: 0; margin-bottom: 10px; font-size: 13px; color: #b9c5d9; }
  .phrase { display: flex; align-items: start; gap: 12px; padding: 13px 14px; border: 1px solid #46536a; border-radius: 10px; min-height: 48px; cursor: pointer; }
  .phrase.selected { background: #263d5e; border-color: #92b4ee; } .phrase:focus-within { outline: 2px solid #b9d0f6; outline-offset: 2px; }
  input { margin-top: 5px; accent-color: #91b4ff; } .phrase span { display: grid; gap: 5px; overflow-wrap: anywhere; } small,.small { color: #b9c5d9; font-size: 13px; }
  .first-answer { color: #c6d9f7; } .feedback { padding: 14px; border-left: 3px solid #d7b57a; background: #292b32; border-radius: 8px; }
  .feedback.correct { border-color: #8dd4b4; background: #20362f; } summary { cursor: pointer; color: #b9d0f6; } .explanation { padding-top: 12px; }
  [data-lesson-feedback]:focus { outline: none; }
  .example,aside { padding: 14px; border-radius: 10px; background: #223046; } .example { justify-items: start; }
  .text-button { justify-self: start; border: 0; background: transparent; padding: 6px 0; color: #b9d0f6; text-decoration: underline; }
  @media (max-width: 520px) { .question { gap: 16px; } .stimulus { padding: 14px; } h3 { font-size: 19px; } }
</style>
