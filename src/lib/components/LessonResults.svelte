<script lang="ts">
  import type { Workspace } from '../domain/workspace'
  import type { LearningSession } from '../domain/learning'
  import { lessonView } from '../domain/lesson'
  import { lessonProgression } from '../learning/lessonPolicy'
  import { lessonSummary } from '../learning/lessonProgress'
  import { quizLevels } from '../domain/lessonSettings'

  let { document, session }: { document: Workspace; session: LearningSession } = $props()
  const plan = $derived(lessonView(document, session)!)
  const completion = $derived(session.lessonAttempt?.completion)
  const progress = $derived(lessonProgression(document, plan.id))
  const growth = $derived(lessonSummary(document, session))
  const answers = $derived(completion?.answers ?? [])
</script>

<section class="results">
  <h3 data-lesson-heading tabindex="-1">Lesson complete</h3>
  <section class="score" aria-label="Quiz result">
    {#if growth}<p class="score-number">{growth.correct} of {growth.total} correct</p><p>Without help · Quiz result</p>{/if}
    <strong>{plan.activity === 'practice' ? 'Practice saved' : completion?.passed ? completion.pointAwarded ? 'Passed · +1 point' : 'Passed' : 'Keep practicing'}</strong>
  </section>
  <p>{progress.level ? `Level ${progress.level} of 4` : 'Working toward Level 1'} · {progress.points}/10 points</p>
  {#if completion}<p class="muted">This lesson counts toward your learning streak.</p>{/if}
  {#if completion?.passed && plan.activity !== 'practice'}
    <p>Next review: {new Date(plan.opportunity.eligibleAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. Practice is available anytime.</p>
  {:else if plan.activity !== 'practice'}<p>Review the answers below, then try a fresh quiz. All answers must be correct without help to earn a point.</p>{/if}
  {#if growth?.helped}<p class="muted">{growth.helped} {growth.helped === 1 ? 'answer used' : 'answers used'} help.</p>{/if}
  <section class="answers" aria-label="Quiz answers">
    {#each answers as result, index}
      {@const exercise = document.exercises.find(e => e.id === result.exerciseId)}
      {@const attempt = document.attempts.find(a => a.id === result.attemptId)}
      {@const question = exercise && document.drafts.find(d => d.id === exercise.multipleChoice?.quizId)?.quiz?.questions.find(q => q.lessonStep === exercise.lessonStep && q.cardId === exercise.cardId)}
      {#if exercise}
        <details open={result.outcome !== 'correct'}>
          <summary>Question {index + 1} · {result.outcome === 'correct' ? 'Correct' : result.outcome === 'helped' ? 'Used help' : 'To review'}</summary>
          <div class="answer">
            <p>{question?.stem ?? exercise.prompt}</p>
            {#if question?.passage}<p class="hanzi" lang="zh">{question.passage}</p>{/if}
            <p>Your answer: {exercise.multipleChoice?.options.find(o => o.id === attempt?.selectedOptionId)?.text ?? attempt?.answer ?? 'Not answered'}</p>
            {#if result.outcome !== 'correct'}<p><strong>Correct answer: {exercise.expectedAnswer}</strong></p>{/if}
            <p>{exercise.multipleChoice?.explanation}</p>
          </div>
        </details>
      {/if}
    {/each}
  </section>
  <details><summary>Lesson details</summary><div class="answer">
    <p>{plan.title} · {quizLevels[plan.settings.quizLevel]}</p>
    <p>{plan.cardIds.map(id => document.items.find(i => i.id === document.cards.find(c => c.id === id)?.itemId)?.canonicalText).filter(Boolean).join(' · ')}</p>
    <p class="muted">The quiz checks understanding in this lesson. Scheduled reviews let you check what you remember later.</p>
  </div></details>
</section>

<style>
  .results,.answer,.answers,.score { display: grid; gap: 12px; } .results { gap: 20px; }
  h3,p { margin: 0; line-height: 1.55; overflow-wrap: anywhere; } h3 { font-size: 22px; } h3:focus { outline: none; }
  .score { padding: 22px; border: 1px solid #48617d; border-radius: 14px; background: #223046; gap: 5px; }
  .score-number { font-size: 29px; font-weight: 600; } .score strong { margin-top: 10px; color: #bce8d4; }
  .muted { color: #b9c5d9; font-size: 14px; } summary { cursor: pointer; color: #b9d0f6; line-height: 1.5; }
  .answers details { padding: 14px; border: 1px solid #354154; border-radius: 10px; } .answer { padding-top: 12px; }
  .hanzi { font-size: 24px; }
</style>
