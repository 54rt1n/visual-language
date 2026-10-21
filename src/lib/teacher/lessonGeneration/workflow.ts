import { projectCoverageContext, validateCoverageSubmission } from './coverageContext'
import { englishAnswers } from '../../domain/lessonSettings'
import { sameRecord } from '../../domain/common'
import { validateLessonGraph, waypointContext, waypointLessonInputSchema, type WaypointLessonInput, type LessonGraph } from '../../domain/lessonGraph'
import { InputValidationError } from '../../domain/validation'
import { questionAnswerIssue, requireQuestionAnswerReview, visibleQuestionView } from '../../domain/questionSolve'
import { revisedQuestionPending } from '../../domain/lessonPreparation'
import { proposalWaypoint, applyWaypoint, lessonOverview } from '../lessonGraphTools'
import { plannedQuestionGap, validateGap, validateCoverage, remainingWaypointIds, remainingTargetIds, assertUnassessedQuestionGap } from '../questionGapTools'
import { executeLessonStage as stage, type LessonGenerationOptions } from './executeStage'
import { assertDistinctQuestion, questionFromWaypoint, validateWaypointQuestion } from '../../learning/waypointQuestion'
import { lessonStages } from './stages'
import { validateLessonBrief } from './definitions'
export { questionGapSchema, waypointQuizSchema } from '../../domain/lessonPreparation'
export type { QuestionGap, ReviewedLessonGraph, AcceptedWaypointQuestion, WaypointQuiz } from '../../domain/lessonPreparation'
export type { LessonGenerationOptions } from './executeStage'
import { waypointQuizSchema, validateQuestionConcealment, lessonPreparationHash, validateGraphDraft, validateLessonPreparation, validateQuizCoverageEvidence, waypointQuestionHash, pendingQuestionContextHash, validatePendingQuestion, type LessonPreparation, type LessonGraphDraft, type QuestionGap, type ReviewedLessonGraph, type AcceptedWaypointQuestion, type WaypointQuiz, type RejectedQuestionSubmission } from '../../domain/lessonPreparation'
import { selectLessonModelProfile } from './modelProfiles'
import { graphConstructionBudget } from './graphConstruction'
import { commitLessonCheckpoint } from './checkpoint'
import { InferenceFailure } from '../../ai/inferenceFailure'
import { assessmentQuestionLimit, assertAssessmentCapacity } from './assessmentPlan'
import { lessonWorkflowBudget, lessonScopeWorkflowPolicy, type LessonWorkflowPolicy } from './workflowBudget'
import { MAX_DIRECTION_REPLANS, replanQuizDirection, assertNewQuestionCandidate, rejectedQuestionSubmission } from './quizReplanning'

export type GenerateLessonOptions = Omit<LessonGenerationOptions, 'onStage'> & {
  workflowPolicy?: Partial<LessonWorkflowPolicy>;
  checkpoint?: LessonPreparation; graphDraft?: LessonGraphDraft;
  onGraphDraft?: (draft: LessonGraphDraft) => Promise<void>;
  onLesson?: (lesson: LessonPreparation) => Promise<void>;
  onQuiz?: (phase: WaypointQuiz['phase'], quiz: WaypointQuiz) => Promise<void>;
  onStage?: (stage: string, phase?: WaypointQuiz['phase']) => void;
}

/** The shared lifecycle. Every persistence callback completes before dependent work begins. */
export async function generateLesson(value: WaypointLessonInput, options: GenerateLessonOptions): Promise<LessonPreparation> {
  const budget = lessonWorkflowBudget(options, { ...lessonScopeWorkflowPolicy(value.targets.length), ...options.workflowPolicy })
  try { return await generateLessonWithinBudget(value, { ...options, signal: budget.signal, transport: budget.transport }) }
  finally { budget.dispose() }
}

async function generateLessonWithinBudget(value: WaypointLessonInput, options: GenerateLessonOptions): Promise<LessonPreparation> {
  const input = lessonInput(value)
  const config = { ...options, modelProfile: selectLessonModelProfile(options.modelProfile, options.provider) }
  let preparation = options.checkpoint ? validateLessonPreparation(options.checkpoint) : undefined
  if (preparation && (!sameRecord(preparation.input, input) || options.graphDraft)) throw new InputValidationError('The saved preparation does not match this lesson brief.')
  options.signal?.throwIfAborted()
  if (!preparation) {
    const lesson = await prepareWaypointGraph(input, { ...config, checkpoint: options.graphDraft, onCheckpoint: options.onGraphDraft })
    preparation = { input, lesson }
    await commitLessonCheckpoint(preparation, options.onLesson, options.signal, 'reviewed-lesson', options.onCheckpointCommitted)
  }
  for (const phase of ['practice', 'check'] as const) {
    options.signal?.throwIfAborted()
    const quiz = await buildWaypointQuizWithinBudget(input, preparation.lesson, phase, { ...config,
      checkpoint: preparation[phase], previousPractice: phase === 'check' ? preparation.practice : undefined,
      onStage: stage => options.onStage?.(stage, phase),
      onCheckpoint: async checkpoint => { await options.onQuiz?.(phase, structuredClone(checkpoint)) },
    })
    preparation = { ...preparation, [phase]: quiz }
  }
  return preparation
}

function lessonInput(value: WaypointLessonInput) {
  const input = waypointLessonInputSchema.parse(value)
  if (new Set(input.targets.map(t => t.cardId)).size !== input.targets.length || new Set(input.sources.map(s => s.id)).size !== input.sources.length) throw new InputValidationError('Lesson target and source references must be distinct.')
  validateLessonBrief(input)
  return input
}

export type WaypointGraphOptions = LessonGenerationOptions & {
  checkpoint?: LessonGraphDraft; onCheckpoint?: (draft: LessonGraphDraft) => Promise<void>;
  maxAuthoringOperations?: number;
}

function scopeProjection(input: WaypointLessonInput, graph: { waypoints: LessonGraph['waypoints'] }) {
  const taught = new Set(graph.waypoints.flatMap(w => w.cardIds))
  const scope = input.sourceMaterial?.scope
  const sourceMaterial = input.sourceMaterial ? { ...input.sourceMaterial, scope: undefined } : undefined
  return { ...(scope ? { sourceMaterial, originalRequest: scope.request, acceptedScope: { outline: scope.outline, points: scope.points } } : {}),
    missingTeachingPoints: input.targets.filter(t => !taught.has(t.cardId)) }
}

export async function prepareWaypointGraph(value: WaypointLessonInput, options: WaypointGraphOptions): Promise<ReviewedLessonGraph> {
  const input = lessonInput(value)
  const initialGraph = { overview: '', waypoints: [] }
  let draft = validateGraphDraft(options.checkpoint ?? { input, graph: initialGraph,
    construction: { limit: options.maxAuthoringOperations ?? 14, operations: 0, states: [lessonPreparationHash(input, initialGraph)] } })
  if (!sameRecord(input, draft.input)) throw new InputValidationError('The saved graph belongs to different lesson material.')
  const construction = graphConstructionBudget(options.maxAuthoringOperations ?? draft.construction.limit, draft.construction)
  const save = async (next: LessonGraphDraft) => {
    next = validateGraphDraft({ ...next, construction: construction.snapshot() })
    await commitLessonCheckpoint(next, options.onCheckpoint, options.signal, 'graph-draft', options.onCheckpointCommitted)
    draft = next
  }
  // Graph review decides whether to add, revise, or proceed to quiz preparation.
  while (true) {
    if (draft.graph.waypoints.length && !draft.revision && !draft.pending) {
      const graph = validateLessonGraph({ ...draft.graph, overview: lessonOverview(draft.graph) }, input, false)
      const checked = await stage(options, lessonStages.reviewGraph, { ...input, ...scopeProjection(input, graph), graph }, value => {
        if (value.waypointId && !graph.waypoints.some(w => w.id === value.waypointId)) throw new InputValidationError('Review identifies an unknown waypoint.')
        if (value.decision !== 'revise' && value.waypointId) throw new InputValidationError('Only revise may identify a waypoint.')
        if (value.decision === 'revise' && !value.waypointId) throw new InputValidationError('Revise must identify the waypoint to replace; use add for a missing point.')
        if (value.decision === 'accept') validateLessonGraph(graph, input)
        if (value.decision === 'add' && graph.waypoints.length >= 9) throw new InputValidationError('The graph has reached its nine-waypoint limit; revise an existing point.')
      })
      if (checked.value.decision === 'reject') throw new InferenceFailure({ category: 'review_rejected', layer: 'review', retryable: false,
        stage: 'reviewGraph', checkpointId: 'graph-draft', message: 'The lesson graph needs revision before questions can be built.', fields: [checked.value.reason] })
      if (checked.value.decision === 'accept') return { graph: validateLessonGraph(graph, input), review: { decision: 'accept', reason: checked.value.reason, model: checked.model } }
      await save({ ...draft, revision: { reason: checked.value.reason, ...(checked.value.waypointId ? { waypointId: checked.value.waypointId } : {}) } })
    }
    const id = draft.revision?.waypointId ?? `w${draft.graph.waypoints.length + 1}`
    if (!draft.revision?.waypointId && draft.graph.waypoints.length >= 9) throw new InputValidationError('The graph has reached its nine-waypoint limit; revise an existing point.')
    const projection = scopeProjection(input, draft.graph)
    const nextTeachingPoint = input.sourceMaterial?.scope && !draft.revision?.waypointId ? projection.missingTeachingPoints[0] : undefined
    const context = { ...input, ...projection, graph: draft.graph, nextWaypointId: id,
      ...(nextTeachingPoint ? { nextTeachingPoint } : {}), ...(draft.revision ? { revision: draft.revision } : {}) }
    const validateCandidate = (candidate: ReturnType<typeof proposalWaypoint>) => {
      if (nextTeachingPoint && !candidate.cardIds.includes(nextTeachingPoint.cardId)) throw new InputValidationError(`Teach the selected next point ${nextTeachingPoint.hanzi} (${nextTeachingPoint.cardId}) in this waypoint, then continue through the reviewed plan.`)
      if (input.kind !== 'reading' && /…|\.{2,}/u.test(candidate.exampleHanzi)) throw new InputValidationError('Show a complete Mandarin example using the taught language, such as 请给我菜单。 Put an open sentence pattern in the explanation.')
      return applyWaypoint(draft.graph as LessonGraph, id, candidate, input)
    }
    if (!draft.pending) {
      construction.author()
      await save(draft)
      const built = await stage(options, draft.revision?.waypointId ? lessonStages.reviseWaypoint : lessonStages.buildWaypoint,
        context, value => { validateCandidate(proposalWaypoint(value, id)) })
      await save({ ...draft, pending: { candidate: proposalWaypoint(built.value, id), reviewRound: 0,
        stateHash: lessonPreparationHash(input, draft.graph) } })
    }
    for (;;) {
      let candidate = draft.pending!.candidate
      if (draft.pending!.revision) {
        construction.author()
        await save(draft)
        const revised = await stage(options, lessonStages.reviseWaypoint, { ...input, ...scopeProjection(input, draft.graph), graph: draft.graph, nextWaypointId: id,
          ...(nextTeachingPoint ? { nextTeachingPoint } : {}),
          candidateToRevise: candidate, revision: { waypointId: id, reason: draft.pending!.revision } }, value => {
            validateCandidate(proposalWaypoint(value, id))
          })
        candidate = proposalWaypoint(revised.value, id)
        await save({ ...draft, pending: { candidate, reviewRound: draft.pending!.reviewRound + 1,
          stateHash: lessonPreparationHash(input, draft.graph) } })
      }
      let validationIssue: string | undefined
      try { validateCandidate(candidate) } catch (error) { validationIssue = (error as Error).message }
      const checked = await stage(options, lessonStages.reviewWaypoint,
        { ...input, ...scopeProjection(input, draft.graph), graph: draft.graph, candidate,
          ...(nextTeachingPoint ? { nextTeachingPoint } : {}), ...(validationIssue ? { validationIssue } : {}) }, value => {
          if (value.decision === 'accept') validateCandidate(candidate)
        })
      if (checked.value.decision === 'reject') throw new InferenceFailure({ category: 'review_rejected', layer: 'review', retryable: false,
        stage: 'reviewWaypoint', checkpointId: 'graph-draft', message: 'This waypoint needs revision. Accepted learning points remain saved.', fields: [checked.value.reason] })
      if (checked.value.decision === 'revise') {
        if (draft.pending!.reviewRound >= 2) throw new InferenceFailure({ category: 'budget_exhausted', layer: 'budget', retryable: false,
          stage: 'reviewWaypoint', checkpointId: 'graph-draft', message: 'Waypoint correction budget exhausted; accepted points remain saved.', fields: [checked.value.reason] })
        await save({ ...draft, pending: { ...draft.pending!, revision: checked.value.reason } })
        continue
      }
      const graph = applyWaypoint(draft.graph as LessonGraph, id, candidate, input)
      const accepted = { ...graph, overview: draft.graph.overview }
      construction.observe(lessonPreparationHash(input, accepted))
      await save({ input, graph: accepted, construction: construction.snapshot() })
      break
    }
  }
}

/** Compact projection: prior answers and feedback never enter proposal/authoring context. */
export function currentQuestionContext(questions: AcceptedWaypointQuestion[]) {
  return questions.map(({ id, question }) => ({ id, cardId: question.cardId,
    stem: question.stem, ...(question.passage ? { passage: question.passage } : {}),
  }))
}

/** Projections are derived from accepted graph state, not accumulated model conversations. */
export function projectQuizContext(input: WaypointLessonInput, graph: LessonGraph, quiz: WaypointQuiz, previous: AcceptedWaypointQuestion[] = [], earlierCheckQuestions: WaypointQuizOptions['earlierCheckQuestions'] = []) {
  return { ...input, ...scopeProjection(input, graph), graph, phase: quiz.phase,
    ...(input.sourceMaterial?.scope ? { plannedTargetIds: input.targets.map(t => t.cardId), remainingTargetIds: remainingTargetIds(input, quiz) } : {}),
    remainingWaypointIds: remainingWaypointIds(graph, quiz, input), currentQuestions: currentQuestionContext(quiz.questions), coverage: quiz.coverage.map(({ waypointId, questionIds }) => ({ waypointId, questionIds })),
    // Rejected author claims are audit history, not learning objectives. Keep
    // references and visible task text so planning can avoid the failed attempt.
    ...(quiz.replanning ? { rejectedDirections: quiz.replanning.rejectedDirections.filter(entry => remainingWaypointIds(graph, quiz, input).some(id => entry.gap.waypointIds.includes(id))).slice(-MAX_DIRECTION_REPLANS).map(({ gap, candidate, reason }) => ({
      waypointIds: gap.waypointIds, cardId: gap.cardId, ...(candidate.stem ? { stem: candidate.stem } : {}),
      ...(candidate.passage ? { passage: candidate.passage } : {}), reason,
    })) } : {}),
    ...(quiz.phase === 'check' ? { practiceQuestions: currentQuestionContext(previous) } : {}),
    ...(earlierCheckQuestions.length ? { earlierCheckQuestions } : {}) }
}

function validateQuestion(question: AcceptedWaypointQuestion['question'], gap: QuestionGap, input: WaypointLessonInput, phase: WaypointQuiz['phase'], current: AcceptedWaypointQuestion[], previous: AcceptedWaypointQuestion[]) {
  let canonical: AcceptedWaypointQuestion['question']
  try { canonical = validateWaypointQuestion(question, gap.cardId, input, phase) }
  catch (error) {
    if (error instanceof InputValidationError) throw new InputValidationError(error.message.replaceAll('Question 1', 'Candidate'))
    throw error
  }
  assertDistinctQuestion(canonical, [...current, ...previous].map(existing => existing.question), input.settings)
  return canonical
}

export type WaypointQuizOptions = LessonGenerationOptions & {
  workflowPolicy?: Partial<LessonWorkflowPolicy>;
  maxQuestions?: number;
  previousPractice?: WaypointQuiz;
  earlierCheckQuestions?: { stem: string; passageExcerpt?: string }[];
  checkpoint?: WaypointQuiz;
  onCheckpoint?: (quiz: WaypointQuiz) => Promise<void>;
}

/** Three small decisions per addition: find a gap, author one question, verify/correct it. */
export async function buildWaypointQuiz(value: WaypointLessonInput, lesson: ReviewedLessonGraph, phase: WaypointQuiz['phase'], options: WaypointQuizOptions): Promise<WaypointQuiz> {
  const budget = lessonWorkflowBudget(options, { ...lessonScopeWorkflowPolicy(value.targets.length), ...options.workflowPolicy })
  try { return await buildWaypointQuizWithinBudget(value, lesson, phase, { ...options, signal: budget.signal, transport: budget.transport }) }
  finally { budget.dispose() }
}

async function buildWaypointQuizWithinBudget(value: WaypointLessonInput, lesson: ReviewedLessonGraph, phase: WaypointQuiz['phase'], options: WaypointQuizOptions): Promise<WaypointQuiz> {
  const input = lessonInput(value), graph = validateLessonGraph(lesson.graph, input)
  if (!['accept', 'correct'].includes(lesson.review.decision)) throw new InputValidationError('Review the lesson graph before building questions.')
  if (phase === 'check' && !options.previousPractice?.complete) throw new InputValidationError('Complete the practice quiz before building the check.')
  const limit = assessmentQuestionLimit(graph, options.maxQuestions, input)
  const lessonHash = lessonPreparationHash(input, graph)
  let quiz = waypointQuizSchema.parse(options.checkpoint ?? { lessonHash, phase, questions: [], complete: false, coverageReason: '', coverage: [] })
  if (quiz.phase !== phase || quiz.questions.length > limit || new Set(quiz.questions.map(q => q.id)).size !== quiz.questions.length) throw new InputValidationError('The question checkpoint does not match this quiz.')
  // Checkpoint authority belongs to the caller's durable, reviewed state. Never
  // manufacture acceptance for a candidate merely because it has valid JSON.
  const validateCheckpoint = (saved: WaypointQuiz, previous: AcceptedWaypointQuestion[] = []) => {
    if (saved.lessonHash !== lessonHash) throw new InputValidationError('The saved questions belong to a different lesson graph or context.')
    for (const [i, q] of saved.questions.entries()) {
      if (q.id !== `q${i + 1}`) throw new InputValidationError('Saved question identities must preserve their accepted order.')
      validateQuestionConcealment(q.question, q.concealmentReview, input)
      requireQuestionAnswerReview(q.question, q.answerReview, waypointQuestionHash(q.question))
      validateGap(q.gap, graph, input)
      const context = waypointContext(graph, q.gap.waypointIds)
      const focused = { ...input, sources: input.sources.filter(s => context.some(w => w.sourceIds.includes(s.id))) }
      validateQuestion(q.question, q.gap, focused, saved.phase, saved.questions.slice(0, i), previous)
    }
    validateCoverage(saved.coverage, graph, saved.questions, saved.complete)
    validateQuizCoverageEvidence(saved, graph, input)
    validatePendingQuestion(saved, input, graph, previous)
  }
  const practice = options.previousPractice ? waypointQuizSchema.parse(options.previousPractice) : undefined
  if (practice) {
    if (practice.phase !== 'practice') throw new InputValidationError('The prior quiz must be practice.')
    validateCheckpoint(practice)
  }
  validateCheckpoint(quiz, practice?.questions)
  if (quiz.complete) return quiz
  const previous = practice?.questions ?? []
  const save = async (next: WaypointQuiz) => {
    next = waypointQuizSchema.parse(next)
    validateCheckpoint(next, previous)
    await commitLessonCheckpoint(next, options.onCheckpoint, options.signal, `${phase}-quiz`, options.onCheckpointCommitted)
    quiz = next
  }
  // Explicit Continue gets a fresh bounded opportunity. Accepting a question
  // starts the next slot's allowance; all rejected evidence stays durable.
  let recoveryStart = quiz.replanning?.rejectedDirections.length ?? 0
  let recoveryQuestion = quiz.questions.length
  const replan = async (reason: string, model: string, cause?: InferenceFailure, authored?: RejectedQuestionSubmission) => {
    if (quiz.questions.length !== recoveryQuestion) {
      recoveryStart = quiz.replanning?.rejectedDirections.length ?? 0
      recoveryQuestion = quiz.questions.length
    }
    const next = replanQuizDirection(quiz, quiz.replanning, reason.slice(0, 1000), model, cause, authored, recoveryStart)
    await save({ ...next.quiz, replanning: next.ledger })
  }
  // A resumed question may predate target-level evidence. Re-evaluate its existing
  // display; retain its author text, answer review and graph rather than rebuilding.
  if (input.sourceMaterial?.scope) for (const accepted of quiz.questions.filter(q => q.coverageReview?.cardIds === undefined)) {
    const context = projectQuizContext(input, graph, quiz, previous)
    const assessed = await stage(options, lessonStages.evaluateCoverage, projectCoverageContext(context, accepted.question, accepted.id), value => {
      validateCoverageSubmission(context, accepted.question, value.waypointIds, value.cardIds)
      if (!value.waypointIds.length) throw new InputValidationError('The retained question needs supported coverage evidence.')
    })
    const coverage = quiz.coverage.map(c => ({ ...c, questionIds: c.questionIds.filter(id => id !== accepted.id) })).filter(c => c.questionIds.length)
    for (const waypointId of assessed.value.waypointIds) {
      const entry = coverage.find(c => c.waypointId === waypointId)
      if (entry) entry.questionIds.push(accepted.id)
      else coverage.push({ waypointId, questionIds: [accepted.id], assessment: assessed.value.assessment })
    }
    const next = { ...quiz, coverage, questions: quiz.questions.map(q => q.id === accepted.id
      ? { ...q, coverageReview: { ...assessed.value, questionHash: waypointQuestionHash(q.question) } } : q) }
    if (next.pending) next.pending = { ...next.pending, stateHash: pendingQuestionContextHash(next, previous) }
    await save(next)
  }
  quizLoop: while (true) {
    options.signal?.throwIfAborted()
    // Review and coverage both precede acceptance; an unproductive candidate never consumes a quiz position.
    const pending = quiz.pending
    if (pending?.step === 'solve') {
      const waypoints = waypointContext(graph, pending.gap.waypointIds)
      const focused = { ...input, sources: input.sources.filter(s => waypoints.some(w => w.sourceIds.includes(s.id))) }
      const question = validateQuestion(questionFromWaypoint(pending.candidate, pending.gap, graph, focused), pending.gap, focused, phase, quiz.questions, previous)
      if (!pending.answerReview) {
        const solved = await stage(options, lessonStages.solveVisibleQuestion, { kind: input.kind, settings: input.settings, phase, question }, value => {
          if (new Set(value.answerIds).size !== value.answerIds.length || value.answerIds.some(id => !question.options.some(option => option.id === id))) throw new InputValidationError('Select distinct IDs from the actual visible choices.')
        })
        await save({ ...quiz, pending: { ...pending, answerReview: { ...solved.value, model: solved.model, questionHash: waypointQuestionHash(question) } } })
        continue
      }
      const issue = questionAnswerIssue(question, pending.answerReview)
      if (issue) {
        if (pending.reviewRound >= 2) await replan(issue, pending.answerReview.model)
        else await save({ ...quiz, pending: { ...pending, step: 'revise', revision: issue,
          review: { decision: 'correct', reason: issue, model: pending.answerReview.model } } })
      } else await save({ ...quiz, pending: { ...pending, step: 'review' } })
      continue
    }
    if (pending?.step === 'concealment') {
      const waypoints = waypointContext(graph, pending.gap.waypointIds)
      const focused = { ...input, sources: input.sources.filter(s => waypoints.some(w => w.sourceIds.includes(s.id))) }
      const question = validateQuestion(questionFromWaypoint(pending.candidate, pending.gap, graph, focused), pending.gap, focused, phase, quiz.questions, previous)
      if (!pending.concealmentReview) {
        const solved = await stage(options, lessonStages.solveEnglishQuestion, { ...input, phase, candidate: pending.candidate })
        if (solved.value.answerId !== 'unknown') {
          const reason = `This is a model observation, not verified evidence of a unique answer. Review the ambiguity and use a neutral English stem whose answer depends on the Mandarin. An English-only solver selected ${solved.value.answerId}: ${solved.value.reason}`.slice(0, 1000)
          if (pending.reviewRound >= 2) {
            const cause = new InferenceFailure({ category: 'review_rejected', layer: 'review', retryable: false,
              stage: 'solveEnglishQuestion', checkpointId: `${phase}-quiz`, message: 'The English-only check did not establish that Mandarin is necessary.', fields: [reason] })
            await replan(reason, solved.model, cause)
          } else {
            await save({ ...quiz, pending: { ...pending, step: 'revise', revision: reason,
              review: { decision: 'correct', reason, model: solved.model } } })
          }
          continue
        }
        await save({ ...quiz, pending: { ...pending, concealmentReview: { ...solved.value, model: solved.model, questionHash: waypointQuestionHash(question) } } })
        continue
      }
      validateQuestionConcealment(question, pending.concealmentReview, input)
      await save({ ...quiz, pending: { ...pending, step: 'coverage' } })
      continue
    }
    if (pending?.step === 'coverage') {
      const questionId = `q${quiz.questions.length + 1}`
      const waypoints = waypointContext(graph, pending.gap.waypointIds)
      const focused = { ...input, sources: input.sources.filter(s => waypoints.some(w => w.sourceIds.includes(s.id))) }
      const question = validateQuestion(questionFromWaypoint(pending.candidate, pending.gap, graph, focused), pending.gap, focused, phase, quiz.questions, previous)
      const context = projectQuizContext(input, graph, quiz, previous)
      const hash = waypointQuestionHash(question)
      if (!pending.coverageReview || input.sourceMaterial?.scope && pending.coverageReview.cardIds === undefined) {
        const assessed = await stage(options, lessonStages.evaluateCoverage, projectCoverageContext(context, question, questionId), value => {
          validateCoverageSubmission(context, question, value.waypointIds, value.cardIds)
        })
        await save({ ...quiz, pending: { ...pending, coverageReview: { ...assessed.value, questionHash: hash } } })
        continue
      }
      if (pending.coverageReview.questionHash !== hash) throw new InputValidationError('Pending coverage evidence belongs to changed question content.')
      const remaining = remainingWaypointIds(graph, quiz, input)
      if (pending.coverageReview.waypointIds.length && !pending.coverageReview.waypointIds.some(id => remainingWaypointIds(graph, quiz).includes(id))
        && !pending.coverageReview.cardIds?.some(id => remainingTargetIds(input, quiz).includes(id))) {
        const reason = `The question only assesses already-covered understandings. Revise it to assess a remaining waypoint: ${remaining.join(', ')}. ${pending.coverageReview.assessment}`.slice(0, 1000)
        if (pending.reviewRound >= 2) {
          await replan(reason, options.provider.model)
          continue
        }
        const { coverageReview: _assessment, concealmentReview: _concealment, ...candidateState } = pending
        await save({ ...quiz, pending: { ...candidateState, step: 'revise', revision: reason,
          review: { ...pending.review!, decision: 'correct', reason: 'The question must assess an outstanding learning gap.' } } })
        continue
      }
      if (!pending.coverageReview.waypointIds.length || input.sourceMaterial?.scope && !pending.coverageReview.cardIds?.length) {
        if (pending.reviewRound >= 2) {
          const cause = new InferenceFailure({ category: 'review_rejected', layer: 'review', retryable: false,
            stage: 'evaluateCoverage', checkpointId: `${phase}-quiz`, message: 'The revised question still supplies no coverage evidence.' })
          await replan(`The question still supplies no coverage after revision. Choose a different question for its remaining learning gap. ${pending.coverageReview.assessment}`.slice(0, 1000), options.provider.model, cause)
          continue
        }
        const { coverageReview: _assessment, concealmentReview: _concealment, ...candidateState } = pending
        await save({ ...quiz, pending: { ...candidateState, step: 'revise', revision: `The choices test no lesson understanding. Revise this question to test its intended gap. ${pending.coverageReview.assessment}`.slice(0, 1000),
          review: { ...pending.review!, decision: 'correct', reason: 'Coverage review requires a question revision.' } } })
        continue
      }
      const coverage = [...quiz.coverage]
      for (const waypointId of pending.coverageReview.waypointIds) {
        const index = coverage.findIndex(c => c.waypointId === waypointId)
        const entry = { waypointId, questionIds: [...new Set([...(coverage[index]?.questionIds ?? []), questionId])], assessment: pending.coverageReview.assessment }
        if (index < 0) coverage.push(entry); else coverage[index] = entry
      }
      const { pending: _candidate, proposedDirections: _directions, plannedGap: _plan, ...acceptedState } = quiz
      await save({ ...acceptedState, coverage, questions: [...quiz.questions, { id: questionId, gap: pending.gap, question,
        answerReview: pending.answerReview!, review: pending.review!, coverageReview: pending.coverageReview, ...(pending.concealmentReview ? { concealmentReview: pending.concealmentReview } : {}) }] })
      continue
    }
    if (quiz.questions.length && !remainingWaypointIds(graph, quiz, input).length) {
      validateCoverage(quiz.coverage, graph, quiz.questions, true)
      await save({ ...quiz, complete: true, coverageReason: 'Every lesson understanding has evidence from evaluated question choices.' })
      return quiz
    }
    if (quiz.questions.length >= limit) throw new InputValidationError('The quiz still has learning gaps at its question limit; it is incomplete.')
    assertAssessmentCapacity(graph, quiz, limit, input)
    if (!quiz.pending && (!quiz.proposedDirections || !quiz.plannedGap)) {
      const proposed = await stage(options, lessonStages.proposeQuestions, projectQuizContext(input, graph, quiz, previous, options.earlierCheckQuestions), value => {
        assertUnassessedQuestionGap(plannedQuestionGap(value, graph, input), graph, quiz, input)
      })
      await save({ ...quiz, proposedDirections: proposed.value.directions, plannedGap: plannedQuestionGap(proposed.value, graph, input) })
    }
    if (!quiz.pending) {
      const gap = validateGap(quiz.plannedGap!, graph, input)
      const authorContext = { ...projectQuizContext(input, graph, quiz, previous, options.earlierCheckQuestions), gap, questionIdeas: quiz.proposedDirections,
        graph: { overview: graph.overview, waypoints: graph.waypoints.map(({ id, cardIds, dependsOn, objective }) => ({ id, cardIds, dependsOn, objective })) },
        target: input.targets.find(t => t.cardId === gap.cardId), waypoints: waypointContext(graph, gap.waypointIds) }
      let authored: Pick<NonNullable<WaypointQuiz['pending']>, 'gap' | 'candidate'> | undefined
      let built
      try {
        built = await stage(options, lessonStages.buildQuestion, authorContext, candidate => {
          authored = undefined
          const selected = gap
          assertNewQuestionCandidate(quiz, selected, candidate, quiz.replanning)
          authored = { gap: selected, candidate }
          assertUnassessedQuestionGap(selected, graph, quiz, input)
          const waypoints = waypointContext(graph, selected.waypointIds)
          const focused = { ...input, sources: input.sources.filter(s => waypoints.some(w => w.sourceIds.includes(s.id))) }
          validateQuestion(questionFromWaypoint(candidate, selected, graph, focused), selected, focused, phase, quiz.questions, previous)
        })
      } catch (error) {
        const rejected = rejectedQuestionSubmission(error, graph, input, gap)
        if (rejected && error instanceof InferenceFailure) {
          await replan(error.message, options.provider.model, error, rejected)
          continue
        }
        if (!(error instanceof InferenceFailure) || error.failure.category !== 'constraints_invalid' || !error.failure.correctionExhausted || !authored) throw error
        await replan(error.message, options.provider.model, error, authored)
        continue
      }
      const candidate = built.value
      await save({ ...quiz, pending: { gap, candidate, step: 'solve', reviewRound: 0, stateHash: pendingQuestionContextHash(quiz, previous) } })
      continue
    }
    const gap = quiz.pending!.gap
    const context = waypointContext(graph, gap.waypointIds), sources = input.sources.filter(s => context.some(w => w.sourceIds.includes(s.id)))
    const focusedInput = { ...input, sources }
    const requestContext = { ...projectQuizContext(input, graph, quiz, previous, options.earlierCheckQuestions), graph: { overview: graph.overview, waypoints: graph.waypoints.map(({ id, cardIds, dependsOn, objective }) => ({ id, cardIds, dependsOn, objective })) }, gap, questionIdeas: quiz.proposedDirections, target: input.targets.find(t => t.cardId === gap.cardId), waypoints: context }
    let candidate = quiz.pending!.candidate, review = quiz.pending!.review
    for (;;) {
      if (quiz.pending!.revision) {
        let revised
        try {
          revised = await stage(options, lessonStages.reviseQuestion, { ...requestContext, candidateToRevise: candidate, revision: quiz.pending!.revision }, value => {
            assertNewQuestionCandidate(quiz, gap, value, quiz.replanning)
            validateQuestion(questionFromWaypoint(value, gap, graph, focusedInput), gap, focusedInput, phase, quiz.questions, previous)
          })
        } catch (error) {
          // A revision already has a validated pending direction to retire.
          // Keep malformed replacement fields out of saved lesson content, but
          // let exhausted schema corrections use the same bounded replan path.
          if (!(error instanceof InferenceFailure) || !['constraints_invalid', 'schema_invalid'].includes(error.failure.category) || !error.failure.correctionExhausted) throw error
          await replan(error.message, options.provider.model, error)
          continue quizLoop
        }
        candidate = revised.value
        await save({ ...quiz, pending: revisedQuestionPending(quiz.pending!, candidate) })
        continue quizLoop
      }
      let validationIssue: string | undefined
      let visibleQuestion: ReturnType<typeof visibleQuestionView> | undefined
      try { visibleQuestion = visibleQuestionView(validateQuestion(questionFromWaypoint(candidate, gap, graph, focusedInput), gap, focusedInput, phase, quiz.questions, previous)) }
      catch (error) { validationIssue = (error as Error).message }
      let verified
      try { verified = await stage(options, lessonStages.reviewQuestion,
        { ...requestContext, candidate, ...(visibleQuestion ? { visibleQuestion } : {}), ...(validationIssue ? { validationIssue } : {}) }, value => {
          if (value.decision === 'accept') validateQuestion(questionFromWaypoint(candidate, gap, graph, focusedInput), gap, focusedInput, phase, quiz.questions, previous)
        })
      } catch (error) {
        if (!(error instanceof InferenceFailure) || error.failure.category !== 'constraints_invalid' || !error.failure.correctionExhausted) throw error
        await replan(error.message, options.provider.model, error)
        continue quizLoop
      }
      const { decision, reason } = verified.value
      if (decision === 'reject') {
        const cause = new InferenceFailure({ category: 'review_rejected', layer: 'review', retryable: false,
          stage: 'reviewQuestion', checkpointId: `${phase}-quiz`,
          message: 'The candidate question was rejected; a different direction is required.', fields: [reason] })
        await replan([reason, validationIssue].filter(Boolean).join(' '), verified.model, cause)
        continue quizLoop
      }
      if (decision === 'revise') {
        if (quiz.pending!.reviewRound >= 2) {
          await replan(reason, verified.model)
          continue quizLoop
        }
        await save({ ...quiz, pending: { ...quiz.pending!, step: 'revise', revision: reason, review: { decision: 'correct', reason, model: verified.model } } })
        continue
      }
      // Keep the correction history, but bind approval evidence to this candidate.
      review = { decision: quiz.pending!.reviewRound > 0 ? 'correct' : decision, reason, model: verified.model }
      break
    }
    await save({ ...quiz, pending: { ...quiz.pending!, step: englishAnswers(input.settings.quizLevel) ? 'concealment' : 'coverage', review: review! } })
  }
}
