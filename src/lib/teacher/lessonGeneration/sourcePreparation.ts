import { z } from 'zod'
import { nid } from '../../id'
import type { DiscoveryProposal, DiscoveryRequest, DiscoveryPlanning } from '../../domain/discovery'
import { lessonScopePointSchema, MAX_LESSON_POINTS } from '../../domain/discovery'
import type { SourceSnapshot } from '../../domain/workspace'
import type { LearnerProfile } from '../../domain/learning'
import { containsHanzi } from '../../mandarin/chineseParser'
import { executeLessonStage, type LessonGenerationOptions } from './executeStage'
import type { LessonStage, LessonStageContext } from './stages'
import { commitLessonCheckpoint } from './checkpoint'

const text = (max: number) => z.string().trim().min(1).max(max)
const readingSchema = z.strictObject({ passage: text(1200), translation: text(2000) })
const scenarioSchema = z.strictObject({ situation: text(500), partnerRole: text(200), learnerRole: text(200), opening: text(300), openingMeaning: text(500), objective: text(500) })
const pointsSchema = z.strictObject({ points: z.array(lessonScopePointSchema.omit({ id: true })).min(1).max(MAX_LESSON_POINTS) })
const reviewSchema = z.strictObject({ accepted: z.boolean(), reason: text(1500) })
export type SourceOptions = LessonGenerationOptions & {
  checkpoint?: DiscoveryPlanning; onPlanning?: (planning: DiscoveryPlanning) => Promise<void>;
  additionalContext?: { learnerInstruction?: string; vocabularyPreferences?: unknown }
}
const pointExamples = [
  { expression: '我想借书', meaning: 'I would like to borrow books.', purpose: 'State the purpose of a library visit.' },
  { expression: '可以借多久', meaning: 'How long may I borrow it?', purpose: 'Find out the loan period after choosing a book.' },
]
const concretePointExample = { context: { topic: 'Ordering tea', outline: 'Make a polite request and specify a quantity.' }, arguments: { points: [
  { expression: '请给我茶', meaning: 'Please give me tea.', purpose: 'Make a complete polite request.' },
  { expression: '两杯茶', meaning: 'Two cups of tea.', purpose: 'Put a quantity before a drink.' },
] } }
function context(request: DiscoveryRequest, learner: LearnerProfile, sources: SourceSnapshot[], options: SourceOptions): LessonStageContext {
  return { kind: request.kind === 'roleplay' ? 'scenario' : request.kind === 'interest' ? 'reading' : 'topic',
    settings: { quizLevel: request.quizLevel ?? 'meaningPinyin', complexity: 'simple', scope: 'topic', focus: 'characters', topic: request.publicTopic.slice(0, 200) },
    originalRequest: request, learner: { level: learner.level, explanationLanguage: learner.explanationLanguage, goal: learner.goal, languageBalance: learner.languageBalance ?? 'balanced' },
    ...options.additionalContext, sources: sources.map(({ title, excerpt }) => ({ title, excerpt })),
    material: sources.length ? 'Adapt the supplied sources faithfully for language learning.' : 'Create an everyday illustrative example.' }
}
function run<T extends z.ZodType>(id: LessonStage<T>['id'], name: string, schema: T, task: string, c: LessonStageContext,
  example: { context: Record<string, unknown>; arguments: Record<string, unknown> } | Array<{ context: Record<string, unknown>; arguments: Record<string, unknown> }>, options: SourceOptions, validate?: (value: z.infer<T>) => void) {
  return executeLessonStage(options, { id, toolName: name, description: task, schema: () => schema,
    instructions: () => task, preparation: true, nativeExamples: Array.isArray(example) ? example : [example] }, c, validate)
}
async function reading(c: LessonStageContext, options: SourceOptions) {
  return run('prepareSource', 'prepare_reading_source', readingSchema,
    'Write one short coherent Mandarin reading and its faithful translation, guided by the outline and learner level. With sources, preserve their facts; otherwise use an everyday fictional scene. This passage will be frozen before selecting useful expressions to teach.', c,
    { context: { topic: 'Visiting a library', outline: 'Ask to borrow a book and understand the loan period.' }, arguments: { passage: '我想借书。可以借多久？可以借两周。', translation: 'I would like to borrow books. How long may I borrow them? You may borrow them for two weeks.' } }, options,
    v => { if (!containsHanzi(v.passage)) throw new Error('Give the reading in Mandarin characters.') })
}

/** Persist intent and reviewed scope before dependent teaching. Re-entry resumes the saved stage. */
export async function prepareLessonSource(request: DiscoveryRequest, learner: LearnerProfile, sources: SourceSnapshot[], options: SourceOptions) {
  const c = context(request, learner, sources, options)
  let plan = options.checkpoint, model = ''
  const save = async (next: DiscoveryPlanning) => {
    await commitLessonCheckpoint(next, options.onPlanning, options.signal, 'lesson-scope', options.onCheckpointCommitted)
    plan = next
  }
  if (!plan) {
    const result = await run('groundLesson', 'ground_lesson', z.strictObject({ outline: text(1800) }),
      'What useful Chinese language would you teach me for my request, at my level and in this context? Explain briefly what it helps me understand or do and a useful order to learn it. Give a compact coherent lesson outline with a manageable focus.', c,
      [{ context: { topic: 'Visiting a library', learner: { level: 'beginner' } }, arguments: { outline: 'Learn to state that you want to borrow a book, then ask how long you may keep it. This prepares you for a short exchange at the lending desk.' } },
        { context: { topic: 'Ordering a meal', learner: { level: 'beginner' } }, arguments: { outline: 'Start by getting the menu so you can choose. Then order a dish and state how much you want. Finish by asking for the bill and thanking the waiter.' } }], options)
    model = result.model; await save({ outline: result.value.outline, rounds: 0 })
  }
  if (request.kind === 'interest' && !plan!.reading) {
    const result = await reading({ ...c, outline: plan!.outline }, options)
    model = result.model; await save({ ...plan!, reading: result.value })
  }
  let authoredThisAttempt = 0
  while (!plan!.accepted) {
    if (!plan!.candidate || plan!.revision) {
      if (authoredThisAttempt >= 2) throw new Error('The lesson scope needs revision. The saved outline is available to continue.')
      authoredThisAttempt++
      const result = await run('planLesson', 'propose_lesson_points', pointsSchema,
        'Choose the concrete teaching content for this outline: useful Mandarin expressions, patterns demonstrated by a concrete expression, or distinctions, each with its meaning and its purpose in this lesson. Give a short plain translation in meaning; use purpose to explain what it helps me do. Order the points into a manageable progression suited to the original request and learner. For a reading, quote each expression unchanged from the fixed passage. Use distinct useful content; the capacity is a ceiling, not a requested count.',
        { ...c, outline: plan!.outline, ...(plan!.reading ? { fixedReading: plan!.reading } : {}), ...(plan!.revision ? { previousCandidate: plan!.candidate, revision: plan!.revision } : {}) },
        [{ context: { topic: 'Visiting a library', outline: 'Ask to borrow a book and find out the loan period.' }, arguments: { points: pointExamples } }, concretePointExample], options,
        v => { if (v.points.some(p => !containsHanzi(p.expression) || plan!.reading && !plan!.reading.passage.includes(p.expression))) throw new Error('Use concrete Mandarin expressions quoted unchanged from the fixed reading when supplied.')
          if (request.kind !== 'interest' && v.points.some(p => /…|\.{2,}|[/／]/u.test(p.expression))) throw new Error('Give each point one concrete Mandarin form, such as 两杯茶. Put the general pattern or comparison in its purpose.')
          if (new Set(v.points.map(p => p.expression.normalize('NFKC'))).size !== v.points.length) throw new Error('Choose distinct teaching expressions.') })
      model = result.model
      await save({ ...plan!, candidate: result.value.points.map(p => ({ ...p, id: nid('point') })), revision: undefined, rounds: plan!.rounds + 1 })
    }
    const checked = await run('reviewLessonScope', 'review_lesson_scope', reviewSchema,
      'Review this proposed teaching scope against my original request, outline, level and context. Does it offer enough distinct useful language for the chosen lesson focus, in a sensible progression? Check meanings and each point’s practical purpose. A phrase-focused request can be small; a broad topic needs a coherent useful scope. For reading, verify the points arise from the fixed passage; for scenarios, check the learner’s role and practical goal. Accept a usable scope or explain one concrete revision.',
      { ...c, outline: plan!.outline, points: plan!.candidate, ...(plan!.reading ? { fixedReading: plan!.reading } : {}) },
      [{ context: { topic: 'Visiting a library', outline: 'Borrow a book and find out the loan period.', points: pointExamples }, arguments: { accepted: true, reason: 'The two distinct functions support a short lending-desk exchange, progressing from the request to its loan conditions.' } },
        { context: { topic: 'Visiting a library', outline: 'Borrow a book and find out the loan period.', points: [pointExamples[0]] }, arguments: { accepted: false, reason: 'The request expression is useful, but the outline also promises finding out the loan period. Add suitable language for that purpose.' } }], options)
    model = checked.model
    if (checked.value.accepted) await save({ ...plan!, accepted: { request, outline: plan!.outline, points: plan!.candidate!, review: { reason: checked.value.reason, model } } })
    else await save({ ...plan!, revision: checked.value.reason })
  }
  const scope = plan!.accepted!, sourceContext = { ...c, acceptedScope: scope }
  let passageHanzi: string, passageMeaning: string, roleplay: DiscoveryProposal['roleplay'] = null
  if (request.kind === 'interest') {
    passageHanzi = plan!.reading!.passage; passageMeaning = plan!.reading!.translation
  } else if (request.kind === 'roleplay') {
    const result = await run('prepareSource', 'prepare_scenario_source', scenarioSchema,
      'Set up a practical Mandarin scenario for the accepted teaching scope: the situation, learner and partner roles, a short partner opening with its meaning, and a clear practical goal for the learner.', sourceContext,
      { context: { topic: 'Visiting a library', points: pointExamples }, arguments: { situation: 'At a library lending desk.', partnerRole: 'Librarian', learnerRole: 'Borrower', opening: '您需要什么？', openingMeaning: 'What do you need?', objective: 'Ask to borrow a book and find out the loan period.' } }, options,
      v => { if (!containsHanzi(v.opening)) throw new Error('Give the partner a Mandarin opening.') })
    model = result.model
    const v = result.value
    roleplay = { situation: v.situation, teacherRole: v.partnerRole, learnerRole: v.learnerRole, openingHanzi: v.opening, openingMeaning: v.openingMeaning, objective: v.objective }
    passageHanzi = [v.opening, ...scope.points.map(p => p.expression)].join('\n'); passageMeaning = [v.openingMeaning, ...scope.points.map(p => p.meaning)].join('\n')
  } else {
    // The accepted expressions are already concrete source examples. Teaching expands them one waypoint at a time.
    passageHanzi = scope.points.map(p => p.expression).join('\n'); passageMeaning = scope.points.map(p => p.meaning).join('\n')
  }
  return { model: model || scope.review.model, planning: plan!, proposal: { title: request.publicTopic.slice(0, 120), explanation: scope.outline, passageHanzi, passageMeaning,
    phrases: scope.points.map(p => ({ hanzi: p.expression, meaning: p.meaning, sense: p.meaning.slice(0, 300), explanation: p.purpose,
      exampleHanzi: p.expression, exampleMeaning: p.meaning, sourceIds: sources.map(s => s.id) })), sourceIds: sources.map(s => s.id), roleplay } satisfies DiscoveryProposal }
}

export function reviewLessonSource(request: DiscoveryRequest, learner: LearnerProfile, lesson: DiscoveryProposal, sources: SourceSnapshot[], options: SourceOptions) {
  return run('reviewSource', 'review_lesson_source', reviewSchema,
    'Check the proposed Mandarin material against the accepted scope: natural expressions, faithful translations, learner level and matching scenario roles. For web sources, verify the adaptation preserves supplied facts. For AI-written examples, assess the language as an illustration. Explain your decision briefly.',
    { ...context(request, learner, sources, options), acceptedScope: options.checkpoint?.accepted, lesson },
    { context: { expressions: pointExamples, material: '我想借书。可以借多久？', meaning: 'I would like to borrow books. How long may I borrow them?' }, arguments: { accepted: true, reason: 'The material preserves the reviewed request and loan-period language with faithful meanings.' } }, options)
}
