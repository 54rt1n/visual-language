/** Project-authored controls for a future independent grader calibration run.
 * Language labels require expert adjudication; transfer labels also need a clear
 * learning-product policy. These controls are not live samples.
 */
export const LESSON_QUALITY_CONTROLS_VERSION = 'lesson-quality-controls-v2'
export const lessonQualityControls = [
  { id: 'neutral-meaning-valid', criterion: 'answer_validity', expectedScore: 2, expectedDecision: 'accept',
    question: { stem: 'What does this expression convey?', passage: '谢谢', options: ['Thank you', 'Sorry', 'Hello', 'Goodbye'], key: 0 },
    reason: 'One choice faithfully expresses gratitude; the other social functions are distinct.' },
  { id: 'wrong-key', criterion: 'answer_validity', expectedScore: 0, expectedDecision: 'correct',
    question: { stem: 'What does this expression convey?', passage: '谢谢', options: ['Thank you', 'Sorry', 'Hello', 'Goodbye'], key: 1 },
    reason: 'The declared apology key conflicts with the gratitude expression.' },
  { id: 'english-leak', criterion: 'answer_hidden', expectedScore: 0, expectedDecision: 'correct',
    question: { stem: 'You have received help and want to thank someone. Which meaning fits?', passage: '谢谢', options: ['Thank you', 'Sorry', 'Hello', 'Goodbye'], key: 0 },
    reason: 'The English stem already establishes gratitude without reading Mandarin.' },
  { id: 'misleading-feedback', criterion: 'feedback', expectedScore: 0, expectedDecision: 'correct',
    question: { stem: 'What does this expression convey?', passage: '不要加糖', options: ['Do not add sugar', 'Add sugar', 'Bring tea', 'Bring a cup'], key: 0, feedback: '不要 means please add, so this asks for sugar.' },
    reason: 'The key is correct but feedback reverses the negation.' },
  { id: 'cosmetic-clause-repair', criterion: 'correction_quality', expectedScore: 0, expectedDecision: 'correct',
    settings: { complexity: 'simple' }, candidate: '请给我一杯茶。不要加糖。', correction: '请给我一杯茶，不要加糖。',
    reason: 'A comma does not turn two distinct imperative clauses into one clause.' },
  { id: 'changed-referent', criterion: 'grounding', expectedScore: 0, expectedDecision: 'correct',
    source: '纸张可以回收利用，所以请放进回收箱。', claim: 'The notice says plastic bottles can be recycled.',
    reason: 'The notice names paper, not plastic bottles; do not invent a claim about a different material.' },
  { id: 'false-coverage', criterion: 'coverage_accuracy', expectedScore: 0,
    waypoint: 'Distinguish gratitude from apology.', question: { stem: 'What does 谢谢 mean?', options: ['Thank you', 'Thanks', 'Many thanks', 'Thanks a lot'] },
    claim: 'This assesses the gratitude-versus-apology contrast.', reason: 'No actual choice expresses an apology; author tags cannot establish the missing contrast.' },
  { id: 'redundant-gap', criterion: 'gap_necessity', expectedScore: 0,
    waypoint: 'Recognize that 不要加糖 means do not add sugar.', question: { stem: 'What does this expression mean?', passage: '不要加糖', options: ['Do not add sugar', 'Add sugar', 'Order tea', 'Refuse tea'] },
    proposal: 'Add another direct-meaning question to test no sugar versus adding sugar.', reason: 'The accepted alternatives already assess exactly that distinction.' },
  { id: 'fresh-sugar-confirmation', criterion: 'transfer', expectedScore: null, expectedDecision: null,
    practice: 'Server asks if you want sugar; choose 不要加糖.', check: 'The server confirms your tea order before preparing it; choose a reply adding the no-sugar preference.',
    reason: 'Reactive refusal becomes proactive preference, but the policy does not establish how much contextual change constitutes meaningful transfer. Reference score and decision remain unresolved.' },
  { id: 'mere-rephrasing', criterion: 'transfer', expectedScore: null, expectedDecision: null,
    practice: 'What does 不要加糖 mean? Choices: no sugar, add sugar, refuse tea, refuse cup.', check: 'Which situation fits 不要加糖? Choices: customer wants no sugar, wants sugar, refuses tea, refuses cup.',
    reason: 'The tested distinction is unchanged, while current guidance expressly recommends meaning-to-situation questions. Reference score and decision remain unresolved until the transfer threshold is defined.' },
] as const

/** Criterion-score agreement does not imply a review accept/revise decision. */
export function summarizeGraderCalibration(predictions: Array<{ id: string; score: number | null }>) {
  if (new Set(predictions.map(p => p.id)).size !== predictions.length || predictions.some(p => !lessonQualityControls.some(c => c.id === p.id) || p.score !== null && ![0, 1, 2].includes(p.score))) throw new Error('Calibration predictions must have unique known controls and 0/1/2/null ratings.')
  const controls = lessonQualityControls.map(c => ({ ...c, actual: predictions.find(p => p.id === c.id)?.score ?? null }))
  const comparisons = controls.flatMap(c => c.expectedScore === null ? [] : [{ id: c.id, expectedScore: c.expectedScore, actual: c.actual }])
  return { controlsVersion: LESSON_QUALITY_CONTROLS_VERSION,
    annotationStatus: 'project-authored-provisional; expert adjudication and transfer policy pending',
    planned: controls.length, labelsAvailable: comparisons.length, rated: comparisons.filter(c => c.actual !== null).length,
    exactScoreMatches: comparisons.filter(c => c.actual !== null && c.actual === c.expectedScore).length,
    overratedControls: comparisons.filter(c => c.actual !== null && c.actual > c.expectedScore).map(c => c.id),
    underratedControls: comparisons.filter(c => c.actual !== null && c.actual < c.expectedScore).map(c => c.id),
    unknown: comparisons.filter(c => c.actual === null).map(c => c.id),
    unresolvedLabels: controls.filter(c => c.expectedScore === null).map(c => ({ id: c.id, observedScore: c.actual })),
    certified: false }
}
