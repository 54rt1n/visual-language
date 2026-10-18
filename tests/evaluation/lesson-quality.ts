import { z } from 'zod'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import { blindQuestionResultSchema, blindQuestionView } from '../../src/lib/domain/blindQuestion'
import { visibleQuestionResultSchema } from '../../src/lib/domain/questionSolve'
import { parseToolContext } from '../fixtures/tool-context'
import { decodeQwenTool } from '../../src/lib/ai/qwenToolProtocol'
import { englishAnswers } from '../../src/lib/domain/lessonPlan'
import { validateLessonGraph, type LessonGraph, type WaypointLessonInput } from '../../src/lib/domain/lessonGraph'
import { waypointProposalSchema, proposalWaypoint, waypointReviewSchema, graphReviewSchema, applyWaypoint } from '../../src/lib/teacher/lessonGraphTools'
import { validateGap } from '../../src/lib/teacher/questionGapTools'
import { questionFromWaypoint, validateWaypointQuestion, waypointQuestionSchema } from '../../src/lib/learning/waypointQuestion'
import { digest, type CaseResult, type CallEvidence } from './lesson-runner'
import { lessonReliability, lessonRecoveryEvidence } from './lesson-reliability'
import { capacityLimitedRequest, lessonOperationalOutcome } from './provider-capacity'
import { quizPassageLabel, quizQuestionPrompt } from '../../src/lib/learning/quiz'

export const RUBRIC_VERSION = 'lesson-quality-v3'
const CONTRACT_VALIDATION_SCOPE = 'schema_and_content_replay'
export const rubric = {
  accuracy: 'Natural Mandarin; faithful full translations; correct contextual pronunciation. A misleading language rule or wrong meaning is a critical defect.',
  grounding: 'Supported by the supplied source and selected sense. Preserve objects, quantities, negation, conditions and scenario roles. Hypothetical situations must not invent source facts.',
  alignment: 'Teaches/tests the selected objective within complexity and scope; question distinguishes relevant intentions without requiring untaught language or outside trivia.',
  scaffolding: 'Distinct teachable understandings; prerequisites are useful; examples support each understanding. Do not reward extra waypoints or forced dependency chains.',
  answer_validity: 'Exactly one defensible answer; grammatical plausible distractors; solve visible question independently of the declared key. No closest-but-wrong key.',
  answer_set_accuracy: 'The visible-only solver identifies every and only defensible choice from the complete displayed task, including pronunciation when shown. Empty or multiple answers can be correct solver observations; do not infer correctness from agreement with an author key.',
  answer_hidden: 'For English choices, remove Mandarin/pinyin AND hide targets, key, examples and feedback before assessing English-only clues. English goals are expected for Mandarin reply choices.',
  feedback: 'After-answer explanation accurately explains the key and meaningful contrasts, remains valid after option shuffling, and helps correct a misconception.',
  transfer: 'Check applies the same taught understanding to a meaningfully fresh task within the same answer direction. Cosmetic rewording alone is insufficient.',
  coverage_accuracy: 'Coverage cites actual learner-visible material and choices that test each claimed waypoint. A distractor naming a meaning does not prove recognition of an unshown Mandarin expression. Missing or merely author-tagged evidence is insufficient; completion requires all understandings.',
  gap_necessity: 'Proposed gap adds genuinely missing assessable knowledge within the chosen answer direction; not a redundant question or unnecessary escalation.',
  decision_accuracy: 'Independent assessment of the ORIGINAL candidate agrees with accept/correct/reject. Do not adopt the production reviewer’s reason as ground truth.',
  correction_quality: 'Accepted or corrected artifact resolves demonstrated defects without new defects; rejection correctly withholds unusable content. No credit solely for emitting a review tool.',
} as const
type Criterion = keyof typeof rubric
const critical = new Set<Criterion>(['accuracy', 'grounding', 'answer_validity', 'answer_set_accuracy', 'answer_hidden', 'coverage_accuracy', 'decision_accuracy', 'correction_quality'])
const graphCriteria: Criterion[] = ['accuracy', 'grounding', 'alignment', 'scaffolding']
const questionCriteria: Criterion[] = ['accuracy', 'grounding', 'alignment', 'answer_validity', 'feedback']
const preparationModes = ['ground_lesson', 'propose_lesson_points', 'review_lesson_scope', 'prepare_reading_source', 'prepare_scenario_source', 'review_lesson_source']
export const MODES = [...preparationModes, 'add_lesson_waypoint', 'revise_lesson_waypoint', 'verify_lesson_waypoint', 'verify_lesson_graph', 'list_missing_questions', 'evaluate_question_coverage', 'solve_english_question', 'solve_visible_question', 'build_question_answers', 'revise_question_answers', 'verify_correct_question'] as const

export type QualityUnit = {
  id: string; caseId: string; repetition: number; kind: string; format: string;
  scope: 'segment' | 'artifact'; stage: string; phase: string; callIndex?: number;
  criteria: Criterion[]; contract: { status: 'pass' | 'fail' | 'response_unavailable' | 'not_applicable'; issue?: string };
  context: Record<string, any>; output: any; decision?: string;
}
type LessonReport = { format: string; version: number; status: string; requestedProvider: string; requestedModel: string; requestedThinking: string; corpusHash: string; codeHashes: Record<string, string>; selectedCaseIds: string[]; repetitions: number; results: Array<CaseResult & { repetition: number }>; activeCase?: unknown; runtime?: { generationPolicy?: unknown }; executionContinuity?: { interrupted: boolean; unknownExtraCalls: boolean } }

const signature = (q: { stem: string; passage?: string }) => `${q.passage ?? ''}\n${q.stem}`.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
function oneCall(call: CallEvidence, name: string) {
  const response = call.response!
  if (response.toolProtocol?.representation === 'qwen_xml') {
    if (call.request.toolResponseDialect !== 'qwen_xml' || !response.toolProtocol.rawContent) throw new Error('Undeclared template adaptation.')
    const normalizations: string[] = []
    let assistantPrefix = ''
    const decoded = decodeQwenTool(response.toolProtocol.rawContent, call.request.tools ?? [], { normalizeParameterNameQuotes: call.request.normalizeParameterNameQuotes,
      normalizeFunctionOpening: call.request.normalizeFunctionOpening,
      onFunctionOpeningNormalization: name => { normalizations.push(`function_opening_angle:${name}`) },
      allowAssistantPrefix: call.request.allowAssistantPrefix, onAssistantPrefix: prefix => { assistantPrefix = prefix },
      onNormalization: field => { normalizations.push(`parameter_name_quote:${field}`) } })
    if (!decoded || JSON.stringify(decoded) !== JSON.stringify(response.toolCalls[0])) throw new Error('Template evidence differs from normalized submission.')
    if (response.content !== assistantPrefix) throw new Error('Assistant content differs from its template evidence.')
    if (JSON.stringify(normalizations) !== JSON.stringify(response.toolProtocol.normalizations ?? [])) throw new Error('Template normalization provenance differs from its wire evidence.')
  }
  if (!['stop', 'tool_calls'].includes(response.finishReason) || response.toolCalls.length !== 1 || response.toolCalls[0]!.function.name !== name) throw new Error(`Expected one completed ${name} submission.`)
  return JSON.parse(response.toolCalls[0]!.function.arguments)
}
function checkQuestion(value: unknown, context: Record<string, any>, original: WaypointLessonInput, graph: LessonGraph) {
  const input = { ...original, sources: context.sources }
  const question = validateWaypointQuestion(questionFromWaypoint(value, context.gap, graph, input), context.gap.cardId, input, context.phase)
  if ([...context.currentQuestions, ...(context.practiceQuestions ?? [])].some(q => signature(q) === signature(question))) throw new Error('Question repeats an existing question.')
  return question
}

function readLessonReport(source: string): LessonReport {
  const report = JSON.parse(source)
  if (report.format !== 'visual-language-lessons-evaluation' || report.version !== 2) {
    throw new Error('Scoring requires a current version 2 lesson report. Retired workflows retain their archived scores.')
  }
  return report as LessonReport
}

/** Replay schema/content checks; observed executor acceptance is separate workflow evidence. */
export function qualityUnits(report: LessonReport): QualityUnit[] {
  if (report.format !== 'visual-language-lessons-evaluation' || report.version !== 2 || report.status !== 'finished' || report.activeCase) throw new Error('Scoring requires a terminal finished lesson report; partial evidence is not a completed matrix.')
  if (!Number.isInteger(report.repetitions) || report.repetitions < 1 || !Array.isArray(report.selectedCaseIds)
    || !report.selectedCaseIds.length || new Set(report.selectedCaseIds).size !== report.selectedCaseIds.length) throw new Error('The declared case matrix must contain distinct cases and positive repetitions.')
  const trialIds = new Set<string>()
  for (const result of report.results) {
    if (typeof result.scriptedPlaybackCompleted !== 'boolean' || result.calls.some(call => typeof call.parsedResponseReceived !== 'boolean')) {
      throw new Error('Explicit playback and parsed-response outcomes are required.')
    }
    const repetition = result.repetition ?? 1, id = `${result.caseId}/r${repetition}`
    if (!report.selectedCaseIds.includes(result.caseId) || !Number.isInteger(repetition) || repetition < 1 || repetition > report.repetitions
      || trialIds.has(id)) throw new Error('Results must identify distinct trials within the declared case matrix.')
    trialIds.add(id)
  }
  const units: QualityUnit[] = []
  for (const result of report.results) {
    const repetition = result.repetition ?? 1, prefix = `${result.caseId}/r${repetition}`
    const base = { caseId: result.caseId, repetition, kind: result.caseSnapshot.kind, format: result.caseSnapshot.settings.quizLevel }
    let original: WaypointLessonInput | undefined, graph: LessonGraph | undefined
    let lastPhase: 'lesson' | 'practice' | 'check' = 'lesson'
    result.calls.forEach((call, callIndex) => {
      const context = parseToolContext([...call.request.messages].reverse().find(m => m.role === 'user')!.content!)
      const phase = context.phase ?? (['solve_english_question', 'solve_visible_question'].includes(call.mode) ? lastPhase : 'lesson')
      lastPhase = phase
      if (!MODES.some(mode => mode === call.mode) || call.request.tools?.length !== 1
        || call.request.tools[0]?.function.name !== call.mode) throw new Error('Report uses a retired or unknown workflow contract.')
      const properties = call.request.tools[0]!.function.parameters.properties ?? {}
      if (['verify_lesson_graph', 'verify_lesson_waypoint', 'verify_correct_question'].includes(call.mode)
        && (Object.hasOwn(properties, 'cardIds') || Object.hasOwn(properties, 'answerA'))) {
        throw new Error('Report uses a retired combined review/correction contract.')
      }
      const criteria: Criterion[] = preparationModes.includes(call.mode) ? call.mode.startsWith('review_') ? ['decision_accuracy', 'accuracy', 'alignment'] : [...graphCriteria]
        : call.mode === 'solve_english_question' ? ['answer_hidden']
        : call.mode === 'solve_visible_question' ? ['answer_set_accuracy']
        : ['add_lesson_waypoint', 'revise_lesson_waypoint'].includes(call.mode) ? [...graphCriteria]
          : ['verify_lesson_graph', 'verify_lesson_waypoint', 'verify_correct_question'].includes(call.mode) ? ['decision_accuracy', 'accuracy']
            : call.mode === 'evaluate_question_coverage' ? ['coverage_accuracy', 'alignment']
              : call.mode === 'list_missing_questions' ? ['gap_necessity', 'alignment'] : [...questionCriteria]
      if (context.candidateToRevise && ['revise_lesson_waypoint', 'build_question_answers', 'revise_question_answers'].includes(call.mode)) criteria.push('correction_quality')
      if (['build_question_answers', 'revise_question_answers'].includes(call.mode) && englishAnswers(context.settings.quizLevel)) criteria.push('answer_hidden')
      if (['build_question_answers', 'revise_question_answers'].includes(call.mode) && phase === 'check') criteria.push('transfer')
      const unit: QualityUnit = { ...base, id: `${prefix}/call-${callIndex + 1}`, scope: 'segment', stage: call.mode, phase, callIndex, criteria,
        contract: { status: call.parsedResponseReceived ? 'pass' : 'response_unavailable', ...(call.error ? { issue: call.error } : {}) }, context,
        output: call.response ? call.response.toolCalls.map(t => ({ tool: t.function.name, arguments: safeArguments(t.function.arguments) })) : null }
      if (call.parsedResponseReceived) try {
        if (preparationModes.includes(call.mode)) {
          unit.output = z.fromJSONSchema(call.request.tools![0]!.function.parameters).parse(oneCall(call, call.mode))
          if (call.mode.startsWith('review_')) unit.decision = unit.output.accepted ? 'accept' : 'correct'
        } else if (['add_lesson_waypoint', 'revise_lesson_waypoint'].includes(call.mode)) {
          original = context as WaypointLessonInput
          const point = proposalWaypoint(waypointProposalSchema.parse(oneCall(call, call.mode)), context.nextWaypointId)
          unit.output = { overview: context.graph.overview, waypoints: [point] }
          applyWaypoint(context.graph, point.id, point, original)
        } else if (call.mode === 'verify_lesson_waypoint') {
          original = context as WaypointLessonInput
          const verdict = waypointReviewSchema.parse(oneCall(call, call.mode))
          unit.decision = verdict.decision === 'revise' ? 'correct' : verdict.decision; unit.output = verdict
          if (verdict.decision === 'accept') applyWaypoint(context.graph, context.candidate.id, context.candidate, original)
        } else if (call.mode === 'verify_lesson_graph') {
          original = context as WaypointLessonInput
          const verdict = graphReviewSchema.parse(oneCall(call, call.mode))
          unit.decision = ['add', 'revise'].includes(verdict.decision) ? 'correct' : verdict.decision; unit.output = verdict
          graph = validateLessonGraph(context.graph, original, verdict.decision === 'accept')
          if (verdict.waypointId && (verdict.decision !== 'revise' || !graph.waypoints.some(w => w.id === verdict.waypointId))) throw new Error('Invalid final review revision reference.')
          if (verdict.decision === 'revise' && !verdict.waypointId) throw new Error('Graph review revision must identify an existing waypoint.')
          if (verdict.decision === 'add' && graph.waypoints.length >= 9) throw new Error('Graph review cannot add beyond nine waypoints.')
        } else if (call.mode === 'list_missing_questions') {
          unit.output = lessonStages.proposeQuestions.schema(context).parse(oneCall(call, call.mode)); unit.decision = 'needs_question'
        } else if (call.mode === 'evaluate_question_coverage') {
          unit.output = lessonStages.evaluateCoverage.schema(context).parse(oneCall(call, call.mode))
          if (new Set(unit.output.waypointIds).size !== unit.output.waypointIds.length || unit.output.waypointIds.some((id: string) => !context.graph.waypoints.some((w: { id: string }) => w.id === id))) throw new Error('Invalid coverage waypoint references.')
        } else if (call.mode === 'build_question_answers' || call.mode === 'revise_question_answers') {
          unit.output = waypointQuestionSchema(context.settings).parse(oneCall(call, call.mode))
          if (call.mode === 'build_question_answers') {
            context.gap = validateGap(context.gap, context.graph, context)
            original = context as WaypointLessonInput
            const savedGraph = graph ?? result.artifacts.plan?.preparation?.lesson.graph
            graph = { ...context.graph, waypoints: context.graph.waypoints.map((summary: LessonGraph['waypoints'][number]) =>
              context.waypoints?.find((point: LessonGraph['waypoints'][number]) => point.id === summary.id)
                ?? savedGraph?.waypoints.find(point => point.id === summary.id) ?? summary) }
          }
          if (!original || !graph) throw new Error('Missing authoritative lesson context.')
          checkQuestion(unit.output, context, original, graph)
        } else if (call.mode === 'verify_correct_question') {
          const verdict = waypointReviewSchema.parse(oneCall(call, call.mode))
          unit.decision = verdict.decision === 'revise' ? 'correct' : verdict.decision; unit.output = verdict
          if (verdict.decision === 'accept') {
            if (!original || !graph) throw new Error('Missing authoritative lesson context.')
            checkQuestion(context.candidate, context, original, graph)
          }
        } else if (call.mode === 'solve_visible_question') {
          unit.output = visibleQuestionResultSchema.parse(oneCall(call, call.mode))
          if (typeof context.prompt !== 'string' || !Array.isArray(context.choices) || context.choices.length !== 4
            || new Set(context.choices.map((choice: { id: string }) => choice.id)).size !== 4
            || new Set(unit.output.answerIds).size !== unit.output.answerIds.length
            || unit.output.answerIds.some((id: string) => !context.choices.some((choice: { id: string }) => choice.id === id))) throw new Error('Visible solving must cite distinct actual choices.')
        } else if (call.mode === 'solve_english_question') {
          const result = blindQuestionResultSchema.parse(oneCall(call, call.mode))
          const choices = z.array(z.strictObject({ id: z.enum(['A', 'B', 'C', 'D']), text: z.string() })).length(4).parse(context.choices)
          if (choices.map(c => c.id).join('') !== 'ABCD') throw new Error('English-only choices must preserve distinct offered identities.')
          blindQuestionView({ stem: context.stem, answerA: choices[0]!.text, answerB: choices[1]!.text, answerC: choices[2]!.text, answerD: choices[3]!.text })
          unit.output = result
        } else throw new Error('Unsupported workflow stage; cannot infer success.')
      } catch (error) { unit.contract = { status: 'fail', issue: error instanceof Error ? error.message : String(error) } }
      units.push(unit)
    })
    const scope = result.artifacts.creation?.discoveryPlanning?.accepted
    if (scope) units.push({ ...base, id: `${prefix}/saved-scope`, scope: 'artifact', stage: 'saved_scope', phase: 'lesson', criteria: [...graphCriteria],
      contract: { status: 'not_applicable' }, context: { request: scope.request }, output: scope })
    const draft = result.artifacts.plan?.waypointDraft
    if (draft?.graph.waypoints.length) units.push({ ...base, id: `${prefix}/saved-lesson-draft`, scope: 'artifact', stage: 'saved_lesson_draft', phase: 'lesson', criteria: [...graphCriteria],
      contract: { status: 'not_applicable' }, context: { ...draft.input, draft: true, readinessApproved: false }, output: draft.graph })
    const preparation = result.artifacts.plan?.preparation
    if (preparation) {
      units.push({ ...base, id: `${prefix}/saved-lesson`, scope: 'artifact', stage: 'saved_lesson', phase: 'lesson', criteria: [...graphCriteria], contract: { status: 'not_applicable' }, context: preparation.input, output: preparation.lesson.graph })
      for (const phase of ['practice', 'check'] as const) for (const [index, question] of (preparation[phase]?.questions ?? []).entries()) {
        const criteria = [...questionCriteria]
        if (englishAnswers(preparation.input.settings.quizLevel)) criteria.push('answer_hidden')
        if (phase === 'check') criteria.push('transfer')
        // Prepared drafts retain the actual shuffled order and app-owned pinyin.
        // A partial checkpoint has no prepared view; never invent one from its key.
        const presented = result.artifacts[phase]?.quiz?.questions[index]
        const learnerView = presented ? {
          prompt: quizQuestionPrompt(presented),
          options: presented.options.map(option => ({ ...option })),
          ...(presented.quizLevel ? { quizLevel: presented.quizLevel } : {}),
          ...(presented.passagePinyin ? { passagePinyin: presented.passagePinyin } : {}),
          ...(presented.passageOrigin ? { passageOrigin: presented.passageOrigin, passageLabel: quizPassageLabel(presented) } : {}),
        } : null
        units.push({ ...base, id: `${prefix}/saved-${phase}-${question.id}`, scope: 'artifact', stage: 'saved_question', phase, criteria, contract: { status: 'not_applicable' },
          context: { ...preparation.input, graph: preparation.lesson.graph, gap: question.gap,
            learnerView,
            ...(phase === 'check' ? { practiceQuestions: preparation.practice?.questions.map(q => q.question) } : {}) }, output: question.question })
      }
    }
  }
  if (new Set(units.map(u => u.id)).size !== units.length) throw new Error('Duplicate case/repetition or unit identity.')
  return units
}
function safeArguments(text: string) { try { return JSON.parse(text) } catch { return { malformedArguments: text } } }

const ratingSchema = z.strictObject({ criterion: z.enum(Object.keys(rubric) as [Criterion, ...Criterion[]]), score: z.number().int().min(0).max(2).nullable(),
  rationale: z.string().trim().min(1).max(1500), evidence: z.array(z.strictObject({ path: z.string().min(1), quote: z.string().min(1).max(1000) })).min(1).max(8) })
export const qualityAnnotationsSchema = z.strictObject({
  format: z.literal('visual-language-lesson-quality-annotations'), version: z.literal(1), rubricVersion: z.literal(RUBRIC_VERSION),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), reviewer: z.strictObject({ id: z.string().min(1), type: z.enum(['human', 'model', 'agent']), independent: z.boolean(), qualifiedMandarin: z.boolean(), model: z.string().optional() }),
  units: z.array(z.strictObject({ id: z.string().min(1), ratings: z.array(ratingSchema), expectedDecision: z.enum(['accept', 'correct', 'reject']).nullable().optional() })),
})
export type QualityAnnotations = z.infer<typeof qualityAnnotationsSchema>
function valueAt(unit: QualityUnit, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, unit)
}

export async function auditPacket(source: string) {
  const report = readLessonReport(source), units = qualityUnits(report)
  const initialContextHashes = await Promise.all(report.results.map(async result => {
    const content = result.calls[0]?.request.messages.filter(message => message.role === 'user').at(-1)?.content
    return { caseId: result.caseId, repetition: result.repetition ?? 1, sha256: typeof content === 'string' ? await digest(content) : null }
  }))
  initialContextHashes.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repetition - b.repetition)
  const generationConfigurations = [...new Set(report.results.flatMap(r => r.calls.flatMap(c => {
    const trace = c.request.generationTrace
    return trace ? [JSON.stringify({ workflowVersion: trace.workflowVersion, promptVersion: trace.promptVersion, modelProfile: trace.modelProfile })] : []
  })))].sort().map(value => JSON.parse(value) as { workflowVersion: string; promptVersion: string; modelProfile: { id: string; version: string; hash: string } })
  return { format: 'visual-language-lesson-quality-packet', version: 1, rubricVersion: RUBRIC_VERSION, sourceSha256: await digest(source),
    contractValidationScope: CONTRACT_VALIDATION_SCOPE,
    provenance: { provider: report.requestedProvider, model: report.requestedModel,
      generationConfigurations,
      generationPolicy: report.runtime?.generationPolicy ?? null,
      initialContextHashes,
      returnedModels: [...new Set(report.results.flatMap(r => r.calls.flatMap(c => c.returnedModel ? [c.returnedModel] : [])))],
      executionContinuity: report.executionContinuity ?? { interrupted: false, unknownExtraCalls: false },
      thinking: report.requestedThinking ?? 'application-default', corpusHash: report.corpusHash, codeHashes: report.codeHashes, selectedCaseIds: report.selectedCaseIds, repetitions: report.repetitions },
    anchors: { '0': 'Demonstrated material error or failed stage purpose.', '1': 'Usable with a specific minor weakness; no demonstrated critical error.', '2': 'Meets this criterion with concrete evidence.', unknown: 'null: unavailable or unresolved; excluded from numeric score, included in audit coverage.' },
    rubric, units }
}

/** Evidence-bound annotations are external judgments, never the production model's self-review. */
export async function scoreLessons(source: string, annotationValue?: unknown) {
  const report = readLessonReport(source), packet = await auditPacket(source)
  const annotations = annotationValue === undefined ? undefined : qualityAnnotationsSchema.parse(annotationValue)
  if (annotations && annotations.sourceSha256 !== packet.sourceSha256) throw new Error('Annotation source hash mismatch.')
  if (annotations && !annotations.reviewer.independent) throw new Error('Production self-review cannot supply independent semantic ratings.')
  if (annotations?.reviewer.type === 'model' && !annotations.reviewer.model) throw new Error('Model graders must record their model identity.')
  const labels = new Map<string, QualityAnnotations['units'][number]>()
  for (const label of annotations?.units ?? []) {
    const unit = packet.units.find(u => u.id === label.id)
    if (!unit || labels.has(label.id)) throw new Error('Unknown or duplicate annotation unit.')
    const criteria = label.ratings.map(r => r.criterion)
    if (new Set(criteria).size !== criteria.length || JSON.stringify([...criteria].sort()) !== JSON.stringify([...unit.criteria].sort())) throw new Error('Each annotated unit must rate all and only its applicable criteria once; use null for unknown.')
    if (label.expectedDecision !== undefined && !['verify_lesson_graph', 'verify_lesson_waypoint', 'verify_correct_question'].includes(unit.stage)) throw new Error('Expected review decisions require a review stage.')
    const decisionRating = label.ratings.find(rating => rating.criterion === 'decision_accuracy')
    if (decisionRating && decisionRating.score !== null) {
      if (!label.expectedDecision || !unit.decision) throw new Error('Rated decision accuracy requires independent expected and observed review decisions.')
      if (decisionRating.score !== (label.expectedDecision === unit.decision ? 2 : 0)) throw new Error('Decision accuracy score contradicts the independent expected and observed review decisions.')
    }
    for (const rating of label.ratings) for (const evidence of rating.evidence) {
      const value = valueAt(unit, evidence.path)
      if (typeof value !== 'string' || !value.includes(evidence.quote)) throw new Error(`Evidence does not match ${unit.id} at ${evidence.path}.`)
    }
    labels.set(label.id, label)
  }
  function semantic(units: QualityUnit[]) {
    const slots = units.reduce((n, u) => n + u.criteria.length, 0)
    const rated = units.flatMap(u => (labels.get(u.id)?.ratings ?? []).filter(r => r.score !== null))
    // Macro-average within case/repetition first: long loops must not dominate a model score.
    const cases = [...new Set(units.map(u => `${u.caseId}/r${u.repetition}`))]
    const means = cases.flatMap(key => {
      const values = units.filter(u => `${u.caseId}/r${u.repetition}` === key).flatMap(u => (labels.get(u.id)?.ratings ?? []).flatMap(r => r.score === null ? [] : [r.score]))
      return values.length ? [values.reduce((a, b) => a + b, 0) / values.length / 2 * 100] : []
    })
    const criticalDefects = units.flatMap(u => (labels.get(u.id)?.ratings ?? []).filter(r => r.score === 0 && critical.has(r.criterion)).map(r => ({ unitId: u.id, criterion: r.criterion, rationale: r.rationale })))
    return { status: criticalDefects.length ? 'critical_defects' : rated.some(r => r.score !== 2) ? 'needs_improvement' : slots === 0 || rated.length !== slots ? 'unrated_or_partial' : 'criteria_met', observedScore: means.length ? round(means.reduce((a, b) => a + b, 0) / means.length) : null, ratedCriteria: rated.length, applicableCriteria: slots, auditCoverage: slots ? round(rated.length / slots * 100) : null,
      fullyAudited: slots > 0 && rated.length === slots, auditedCases: means.length, casesWithUnits: cases.length,
      criticalDefects }
  }
  const planned = report.selectedCaseIds.length * report.repetitions
  const stages = MODES.filter(stage => !preparationModes.includes(stage) || report.results.some(r => r.entryPoint === 'raw-request'))
    .flatMap(stage => ([...preparationModes, 'add_lesson_waypoint', 'revise_lesson_waypoint', 'verify_lesson_waypoint', 'verify_lesson_graph'].includes(stage) ? ['lesson'] : ['practice', 'check']).map(phase => {
    const units = packet.units.filter(u => u.scope === 'segment' && u.stage === stage && u.phase === phase), calls = units.map(u => report.results.find(r => r.caseId === u.caseId && (r.repetition ?? 1) === u.repetition)!.calls[u.callIndex!]!)
    const decisions = units.flatMap(u => {
      const expected = labels.get(u.id)?.expectedDecision
      return expected && u.decision ? [{ unitId: u.id, expected, actual: u.decision }] : []
    })
    return { stage, phase, reachedCases: new Set(units.map(u => `${u.caseId}/r${u.repetition}`)).size, plannedCases: planned, attempts: units.length, httpResponses: calls.filter(c => c.httpStatus !== undefined).length,
      responseFailures: calls.filter(c => !c.parsedResponseReceived && !capacityLimitedRequest(c)).map(c => ({ httpStatus: c.httpStatus ?? null, category: c.failure?.category ?? (/finish status \(length\)/i.test(c.error ?? '') ? 'output_limit' : /timeout|timed out|aborted|interrupted/i.test(c.error ?? '') ? 'transport_or_timeout' : c.httpStatus !== undefined && c.httpStatus >= 400 ? 'http_error' : c.httpStatus !== undefined && c.httpStatus >= 200 && c.httpStatus < 300 ? 'protocol_or_stream_error' : 'transport_or_timeout'), detail: c.failure ?? null, error: c.error ?? 'Response unavailable' })), completedResponses: calls.filter(c => c.parsedResponseReceived).length,
      outputBudgets: [...new Set(calls.map(c => c.request.maxTokens))],
      submissionsAcceptedByExecutor: calls.filter(c => c.submissionAccepted === true).length,
      submissionOutcomesUnknown: calls.filter(c => c.submissionAccepted === undefined).length,
      capacityEvents: calls.filter(capacityLimitedRequest).map(c => ({ httpStatus: c.httpStatus ?? null, detail: c.failure ?? null })),
      submissionFailures: calls.filter(c => c.submissionAccepted === false && !capacityLimitedRequest(c)).map(c => ({ category: c.failure?.category ?? 'unknown', detail: c.failure ?? null })),
      contractPasses: units.filter(u => u.contract.status === 'pass').length, contractFailures: units.filter(u => u.contract.status === 'fail').length,
      operationalContractValidityPercent: calls.length ? round(units.filter(u => u.contract.status === 'pass').length / calls.length * 100) : null,
      nativeContractPasses: units.filter((u, i) => u.contract.status === 'pass' && calls[i]?.response?.toolProtocol?.representation !== 'qwen_xml').length,
      adaptedContractPasses: units.filter((u, i) => u.contract.status === 'pass' && calls[i]?.response?.toolProtocol?.representation === 'qwen_xml').length,
      responseValidityPercent: calls.filter(c => c.parsedResponseReceived).length ? round(units.filter(u => u.contract.status === 'pass').length / calls.filter(c => c.parsedResponseReceived).length * 100) : null,
      durationsMs: { median: percentile(calls.map(c => c.durationMs), .5), p95: percentile(calls.map(c => c.durationMs), .95) },
      tokenUsage: usage(calls), returnedModels: [...new Set(calls.flatMap(c => c.returnedModel ? [c.returnedModel] : []))], semantic: semantic(units), reviewDecisions: { rated: decisions.length, agreement: decisions.filter(d => d.actual === d.expected).length,
        falseAccepts: decisions.filter(d => d.actual === 'accept' && d.expected !== 'accept'), falseRejects: decisions.filter(d => d.actual === 'reject' && d.expected !== 'reject'),
        unnecessaryCorrections: decisions.filter(d => d.actual === 'correct' && d.expected === 'accept') } }
  }))
  const cases = report.results.map(r => {
    const units = packet.units.filter(u => u.caseId === r.caseId && u.repetition === (r.repetition ?? 1))
    return { caseId: r.caseId, repetition: r.repetition ?? 1, kind: r.caseSnapshot.kind, answerFormat: r.caseSnapshot.settings.quizLevel, prepared: r.prepared, completed: r.scriptedPlaybackCompleted,
      lessonReady: r.prepared, operationalOutcome: lessonOperationalOutcome(r), scriptedPlaybackCompleted: r.scriptedPlaybackCompleted, recovery: lessonRecoveryEvidence(r),
      failure: r.failure, calls: r.calls.length, durationMs: r.durationMs, tokens: usage(r.calls), contractFailures: units.filter(u => u.contract.status === 'fail').map(u => ({ id: u.id, issue: u.contract.issue })),
      invariantFailures: Object.entries(r.invariants).filter(([, pass]) => !pass).map(([name]) => name), quality: semantic(units.filter(u => u.scope === 'artifact')), workflowSemantics: semantic(units.filter(u => u.scope === 'segment')) }
  })
  return { format: 'visual-language-lesson-quality-score', version: 1, rubricVersion: RUBRIC_VERSION, sourceSha256: packet.sourceSha256,
    provenance: packet.provenance, ...(annotations ? { annotationSha256: await digest(JSON.stringify(annotations)), reviewer: annotations.reviewer } : {}),
    planned, attempted: report.results.length, prepared: cases.filter(c => c.prepared).length, completed: cases.filter(c => c.completed).length,
    reliability: lessonReliability(report.results, planned), contractValidationScope: CONTRACT_VALIDATION_SCOPE,
    instructionalQuality: semantic(packet.units.filter(u => u.scope === 'artifact')), workflowSemantics: semantic(packet.units.filter(u => u.scope === 'segment')),
    stages, cases, unitFindings: packet.units.map(u => ({ id: u.id, stage: u.stage, phase: u.phase, contract: u.contract, annotation: labels.get(u.id) ?? null })),
    interpretation: 'One sample per flow is diagnostic, not a stable model ranking. Semantic scores are provisional external judgments; missing ratings are unknown. Saved partial artifacts are scored separately from case completion. Model self-review and scripted learner correctness never count as independent instructional evidence.',
    humanReview: annotations?.reviewer.type === 'human' && annotations.reviewer.qualifiedMandarin ? 'provided' : 'pending', releaseReady: false }
}
const round = (n: number) => Math.round(n * 10) / 10
function percentile(values: number[], p: number) { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null }
function usage(calls: CallEvidence[]) { const usages = calls.flatMap(c => c.response?.usage ?? c.diagnostic?.usage ? [c.response?.usage ?? c.diagnostic!.usage!] : []); return { reportingCalls: usages.length, unknownCalls: calls.length - usages.length, totalTokens: usages.length ? usages.reduce((n, u) => n + u.totalTokens, 0) : null } }

export function scoreMarkdown(score: Awaited<ReturnType<typeof scoreLessons>>) {
  const r = score.reliability
  return formatScoreMarkdown(score) + `\n## Operational reliability\n\n` +
    `| Outcome | Count |\n|---|---:|\n` +
    `| Planned trials | ${r.plannedTrials} |\n| Finished trials | ${r.trialsFinished} |\n` +
    `| Lessons ready without transport/submission recovery | ${r.lessonsReadyWithoutRecovery} |\n` +
    `| Lessons ready after recovery | ${r.lessonsReadyAfterRecovery} |\n` +
    `| Lessons ready with unknown recovery history | ${r.lessonsReadyWithUnknownRecovery} |\n` +
    `| Scripted playback completed | ${r.scriptedPlaybackCompleted} |\n` +
    `| Harness capacity errors / capacity-limited requests | ${r.harnessCapacityErrors}/${r.capacityLimitedRequests} |\n` +
    `| Responses received / requests attempted | ${r.responsesReceived}/${r.requestsAttempted} |\n` +
    `| Submissions accepted / rejected / unknown | ${r.submissionsAcceptedByExecutor}/${r.submissionsRejectedByExecutor}/${r.submissionOutcomesUnknown} |\n` +
    `| Acknowledged durable checkpoints | ${r.acknowledgedDurableCheckpoints} |\n` +
    `| Trials with unknown checkpoint observations | ${r.trialsWithUnknownCheckpointObservations} |\n\n${r.evidenceScope}\n`
    + `\nTokenizer checks: ${r.tokenization.uncachedChecks} uncached, ${r.tokenization.cachedChecks} cached, ${r.tokenization.failedChecks} failed; `
    + `${r.tokenization.trialsWithUnknownObservations} trials have unknown observations. These auxiliary checks are separate from inference requests.\n`
}

function formatScoreMarkdown(score: Awaited<ReturnType<typeof scoreLessons>>) {
  const quality = score.instructionalQuality
  return `# Lesson evaluation: ${score.provenance.model}\n\nProvider: ${score.provenance.provider}. Rubric: ${score.rubricVersion}. Source SHA-256: ${score.sourceSha256}.\n\n${score.prepared}/${score.planned} prepared; ${score.completed}/${score.planned} completed scripted playback. Saved-content status: **${quality.status}**. Provisional observed quality: ${quality.observedScore ?? 'unrated'}/100 (${quality.auditCoverage ?? 0}% of applicable criteria audited). Human Mandarin review: ${score.humanReview}.\n\n## Flow results\n\n| Flow | Prepared | Calls | Seconds | Reported tokens | Saved-content status | Quality / coverage | Operational outcome |\n|---|---|---:|---:|---:|---|---|---|\n${score.cases.map(c => `| ${c.caseId} | ${c.prepared ? 'yes' : 'no'} | ${c.calls} | ${round(c.durationMs / 1000)} | ${c.tokens.totalTokens ?? 'unknown'} | ${c.quality.status} | ${c.quality.observedScore ?? 'unrated'} / ${c.quality.auditCoverage ?? 0}% | ${c.operationalOutcome}: ${(c.failure?.message ?? '').replaceAll('|', '/').replaceAll('\n', ' ')} |`).join('\n')}\n\n## Workflow segments\n\nContracts below replay schema/content checks; they do not replay every stateful workflow constraint. Executor acceptance is recorded separately and does not imply semantic reviewer approval.\n\n| Stage | Cases reached / planned | Attempts | Schema/content contracts / all requests (response-only %) | Executor accepted | Semantic score / coverage | Median ms | Tokens (unknown calls) | Review agreement |\n|---|---|---:|---|---|---|---:|---|---|\n${score.stages.map(s => `| ${s.phase}: ${s.stage} | ${s.reachedCases}/${s.plannedCases} | ${s.attempts} | ${s.contractPasses}/${s.attempts} (${s.responseValidityPercent ?? 'unknown'}%) | ${s.submissionsAcceptedByExecutor}/${s.attempts} | ${s.semantic.observedScore ?? 'unrated'} / ${s.semantic.auditCoverage ?? 0}% | ${s.durationsMs.median ?? '—'} | ${s.tokenUsage.totalTokens ?? 'unknown'} (${s.tokenUsage.unknownCalls}) | ${s.reviewDecisions.agreement}/${s.reviewDecisions.rated} rated |`).join('\n')}\n\n${score.interpretation}\n\n## Critical findings\n\n${[...quality.criticalDefects, ...score.workflowSemantics.criticalDefects].map(d => `- ${d.unitId} · ${d.criterion}: ${d.rationale}`).join('\n') || 'No independently annotated critical findings. This does not mean no defects.'}\n`
}

export function compareQualityScores(scores: Array<Awaited<ReturnType<typeof scoreLessons>> & { scorerCodeHashes?: Record<string, string> }>) {
  if (scores.length < 2 || scores.some(s => s.format !== 'visual-language-lesson-quality-score' || s.version !== 1)) throw new Error('Compare at least two valid lesson quality score reports.')
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)
  const baseline = scores[0]!
  const mismatches = scores.slice(1).flatMap((s, i) => {
    const fields: string[] = []
    if (s.rubricVersion !== baseline.rubricVersion) fields.push('rubricVersion')
    if (s.provenance.corpusHash !== baseline.provenance.corpusHash) fields.push('corpusHash')
    if (canonical(s.provenance.codeHashes) !== canonical(baseline.provenance.codeHashes)) fields.push('generationCodeHashes')
    if (JSON.stringify([...s.provenance.selectedCaseIds].sort()) !== JSON.stringify([...baseline.provenance.selectedCaseIds].sort()) || s.provenance.repetitions !== baseline.provenance.repetitions) fields.push('caseMatrix')
    if (s.provenance.thinking !== baseline.provenance.thinking) fields.push('thinkingPolicy')
    if (canonical(s.provenance.generationPolicy ?? null) !== canonical(baseline.provenance.generationPolicy ?? null)) fields.push('lessonExecutionPolicy')
    if (JSON.stringify(s.provenance.generationConfigurations ?? []) !== JSON.stringify(baseline.provenance.generationConfigurations ?? [])) fields.push('lessonGenerationConfiguration')
    const completeContexts = (score: typeof baseline) => {
      const contexts = score.provenance.initialContextHashes ?? []
      return contexts.length === score.planned && contexts.every(context => typeof context.sha256 === 'string')
        && new Set(contexts.map(context => `${context.caseId}/r${context.repetition}`)).size === score.planned
    }
    if (!completeContexts(s) || !completeContexts(baseline)) fields.push('initialContextEvidence')
    else if (JSON.stringify(s.provenance.initialContextHashes) !== JSON.stringify(baseline.provenance.initialContextHashes)) fields.push('initialProjectedContexts')
    if (s.provenance.executionContinuity?.unknownExtraCalls || baseline.provenance.executionContinuity?.unknownExtraCalls) fields.push('interruptedExecution')
    if (canonical(s.scorerCodeHashes ?? {}) !== canonical(baseline.scorerCodeHashes ?? {})) fields.push('scorerCodeHashes')
    return fields.map(field => ({ reportIndex: i + 1, field }))
  })
  const reviewerMatched = scores.every(s => s.reviewer?.id === baseline.reviewer?.id && s.reviewer?.model === baseline.reviewer?.model && s.reviewer?.type === baseline.reviewer?.type)
  return { format: 'visual-language-lesson-quality-comparison', version: 1, matchedExperiment: mismatches.length === 0, mismatches, reviewerMatched,
    sameProvider: scores.every(s => s.provenance.provider === baseline.provenance.provider),
    models: scores.map(s => ({ provider: s.provenance.provider, model: s.provenance.model, sourceSha256: s.sourceSha256, prepared: s.prepared, planned: s.planned,
      reliability: s.reliability ?? null,
      quality: s.instructionalQuality, stages: s.stages, cases: s.cases })),
    interpretation: 'Descriptive single-pass comparison only. Do not rank semantic quality from unmatched or partial audits, or infer provider-independent latency, local VRAM, cost, learner outcomes or statistical superiority.' }
}
