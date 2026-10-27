<script lang="ts">
  let { busy, status, teachingReady, practiceReady, checkReady, waypointCount, practiceCount, checkCount, checkOnly = false, pauseFailed = false }: {
    busy: boolean; status: string; teachingReady: boolean; practiceReady: boolean; checkReady: boolean;
    waypointCount: number; practiceCount: number; checkCount: number;
    checkOnly?: boolean; pauseFailed?: boolean;
  } = $props()

  const stages = $derived(([
    { title: 'Lesson plan', detail: 'Examples and learning steps', ready: teachingReady, count: waypointCount, unit: 'learning step' },
    { title: 'Guided practice', detail: 'Questions to try as you learn', ready: practiceReady, count: practiceCount, unit: 'question' },
    { title: 'Lesson quiz', detail: 'Questions to answer after the lesson', ready: checkReady, count: checkCount, unit: 'question' },
  ]).filter(stage => !checkOnly || stage.title === 'Lesson quiz'))
  const completed = $derived(stages.filter(stage => stage.ready).length)
  const current = $derived(stages.findIndex(stage => !stage.ready))
  const flavors = $derived([
    ['Finding a home for every phrase…', 'Putting the tea in teaching…', 'Connecting a few bright ideas…'],
    ['Giving every question a purpose…', 'Making room for your next “aha!”…', 'Setting out a few choices…'],
    ['Taking your phrases out into the world…', 'Setting the scene for a fresh conversation…', 'Giving familiar ideas a new setting…'],
  ][checkOnly ? 2 : Math.max(0, current)])
  let flavor = $state(0)
  $effect(() => {
    if (!busy) return
    const timer = setInterval(() => { flavor = (flavor + 1) % flavors.length }, 6500)
    return () => clearInterval(timer)
  })
</script>

<section class="creation" aria-label="Lesson creation progress">
  <div class="scene" class:working={busy} aria-hidden="true">
    <span class="spark left">✦</span><span class="diamond"></span><span class="spark right">✧</span>
  </div>
  {#if busy}<p class="flavor" aria-hidden="true">{flavors[flavor]}</p>{/if}
  <p class="status" role="status">{busy ? status : pauseFailed ? 'Pause not saved.' : 'Creation paused.'}</p>
  <div class="progress-summary"><span>{completed} of {stages.length} stages ready</span><span>{checkOnly ? 'Saved lesson → Fresh quiz' : 'Learn & practice → Quiz'}</span></div>
  <div class="track" role="progressbar" aria-label="Lesson preparation stages" aria-valuemin="0" aria-valuemax={stages.length} aria-valuenow={completed} aria-valuetext={`${completed} of ${stages.length} stages ready${current >= 0 ? `; ${stages[current].title} ${busy ? 'in progress' : 'next'}` : ''}`}>
    {#each stages as stage, index}
      <span class:complete={stage.ready} class:active={busy && index === current}></span>
    {/each}
  </div>
  <ol class="milestones">
    {#each stages as stage, index}
      <li class:ready={stage.ready} class:current={index === current} aria-current={index === current ? 'step' : undefined}>
        <span class="marker" aria-hidden="true">{stage.ready ? '✓' : index + 1}</span>
        <div><strong>{stage.title} — {stage.ready ? 'Ready' : busy && index === current ? 'In progress' : stage.count ? `${stage.count} ${stage.unit}${stage.count === 1 ? '' : 's'} saved` : 'To prepare'}</strong>
          <p>{stage.count ? `${stage.count} reviewed ${stage.unit}${stage.count === 1 ? '' : 's'} saved` : stage.detail}</p>
        </div>
      </li>
    {/each}
  </ol>
</section>

<style>
  .creation { padding: 22px 20px 18px; border: 1px solid #405574; border-radius: 16px; background: radial-gradient(ellipse at 50% 0%, #294466 0%, #1b293d 52%, #172333 100%); }
  .scene { height: 68px; display: flex; align-items: center; justify-content: center; gap: 28px; }
  .diamond { width: 28px; height: 40px; background: linear-gradient(135deg, #b6efdb, #5fbbdf 50%, #648bd4); clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%); filter: drop-shadow(0 0 12px #7dc7ee55); }
  .spark { color: #94c8e8; font-size: 20px; } .right { font-size: 28px; }
  .working .diamond { animation: float 3s ease-in-out infinite; }
  .working .spark { animation: twinkle 3s ease-in-out infinite; } .working .right { animation-delay: 1.5s; }
  p { margin: 0; line-height: 1.5; } .flavor { text-align: center; font-size: 18px; font-weight: 600; color: #e0edf9; min-height: 54px; display: grid; align-items: center; }
  .status { text-align: center; color: #c6d8ed; font-size: 14px; min-height: 42px; margin: 5px 0 18px; }
  .progress-summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; font-size: 12px; color: #b9cde3; margin-bottom: 8px; }
  .track { display: flex; gap: 5px; height: 8px; } .track span { flex: 1; border-radius: 4px; background: #40516b; }
  .track .complete { background: #94d7ba; }
  .track .active { background: linear-gradient(100deg, #536886 20%, #9acbee 50%, #536886 80%); background-size: 200% 100%; animation: shimmer 2s linear infinite; }
  .milestones { list-style: none; padding: 0; margin: 20px 0 0; display: grid; gap: 16px; }
  li { display: flex; align-items: start; gap: 12px; color: #b8c6d9; } strong { font-size: 14px; font-weight: 600; }
  li p { font-size: 12px; margin-top: 3px; color: #b8c6d9; } .current strong { color: #e0edf9; }
  .marker { display: grid; place-items: center; flex: 0 0 26px; height: 26px; border: 1px solid #657b99; border-radius: 50%; font-size: 12px; }
  .ready .marker { color: #b3efd4; border-color: #7bb69f; background: #29463f; }
  .current .marker { border-color: #a1c9ef; color: #e0edf9; }
  @keyframes float { 50% { transform: translateY(-6px); } }
  @keyframes twinkle { 50% { opacity: .4; } }
  @keyframes shimmer { to { background-position: -200% 0; } }
  @media (max-width: 520px) {
    .creation { padding: 16px 12px; } .scene { height: 36px; } .diamond { width: 20px; height: 30px; }
    .flavor { font-size: 16px; min-height: 48px; } .status { min-height: 0; margin-bottom: 12px; }
    .milestones { gap: 12px; margin-top: 16px; } li:not(.current) p { display: none; }
  }
  @media (max-width: 520px) and (max-height: 640px) {
    .creation { padding-block: 12px; } .scene { display: none; }
    .flavor { font-size: 14px; min-height: 42px; }
    .status { font-size: 12px; line-height: 1.35; margin: 4px 0 10px; }
    .milestones { gap: 8px; margin-top: 12px; } strong { font-size: 13px; }
  }
  @media (prefers-reduced-motion: reduce) { .working .diamond, .working .spark, .track .active { animation: none; } }
</style>
