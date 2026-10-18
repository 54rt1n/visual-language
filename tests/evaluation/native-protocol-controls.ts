export { summarizeProtocolControls } from './protocol-control-summary'
import { projectCoverageContext, validateCoverageSubmission } from '../../src/lib/teacher/lessonGeneration/coverageContext'
import { z } from 'zod'
import { recognitionEligibleWaypoints } from '../../src/lib/domain/coverageEvidence'
import { visibleQuestionView } from '../../src/lib/domain/questionSolve'
import { InputValidationError } from '../../src/lib/domain/validation'
import { readFileSync } from 'node:fs'
import { streamChat } from '../../src/lib/ai/client'
import type { ChatMessage, ChatOptions, ChatResult, ProviderStreamError, ResponseDiagnostic, ToolChoice, ToolDefinition } from '../../src/lib/ai/types'
import { classifyInferenceFailure, type InferenceFailureRecord } from '../../src/lib/ai/inferenceFailure'
import { parseStageSubmission } from '../../src/lib/teacher/lessonGeneration/stageSubmission'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import { assembleLessonPrompt } from '../../src/lib/teacher/lessonGeneration/assemblePrompt'
import { parseToolContext } from '../fixtures/tool-context'
import { toolPrompt } from '../../src/lib/teacher/toolPrompt'
import { applyWaypoint, proposalWaypoint, graphReviewSchema } from '../../src/lib/teacher/lessonGraphTools'
import { plannedQuestionGap, validateGap } from '../../src/lib/teacher/questionGapTools'
import { questionFromWaypoint, validateWaypointQuestion } from '../../src/lib/learning/waypointQuestion'
import { waypointContext, waypointLessonInputSchema, validateLessonGraph } from '../../src/lib/domain/lessonGraph'
import { lessonKindSchema, quizLevelSchema, type LessonKind, type QuizLevel } from '../../src/lib/domain/lessonSettings'
import { validateLessonBrief } from '../../src/lib/teacher/lessonGeneration/definitions'
import { waypointFixture } from '../fixtures/topic-lesson'
import { blindQuestionView, blindQuestionResultSchema, BLIND_QUESTION_INSTRUCTIONS } from './blind-question-view'

type TransferId = `${'authoring' | 'planning'}-transfer/${LessonKind}/${QuizLevel}`
const transferIds = (['authoring', 'planning'] as const).flatMap(operation =>
  lessonKindSchema.options.flatMap(kind => quizLevelSchema.options.map(level =>
    `${operation}-transfer/${kind}/${level}` as TransferId)))

export const protocolCaseIds = ['question-review-neutral-reuse', 'question-build-reading-presentation', 'question-plan-reading-presentation', 'question-plan-fresh-application', 'question-review-reading-presentation', 'question-review-answer-mode', 'question-review-answer-mode-scenario', 'guarded-coverage-apology', 'guarded-coverage-thanks', 'guarded-coverage-reply-apology', 'guarded-coverage-reply-thanks', 'question-plan-directions-length', 'question-plan-preserve-meaning', 'question-review-reply-intent', 'coverage-reviewed-reply-eligibility', 'question-review-clause-joining', 'question-review-single-request', 'blind-neutral', 'blind-key-leak', 'blind-reading-leak', 'probe', 'waypoint-schema', 'graph-schema', 'waypoint-stage', 'graph-stage', 'waypoint-add-stage',
  'question-build-english-stem', 'question-build-format-repair', 'question-build-stage', 'question-review-novelty', 'question-review-key-leak', 'question-review-duplicate', 'question-review-reason-limit', 'question-review-repair', 'question-review-reading-leak', 'coverage-situation-overcredit', 'coverage-assessment-length', 'coverage-repair-echo', 'coverage-apology', 'coverage-thanks', 'coverage-reply-apology', 'coverage-reply-thanks', ...transferIds] as const
export type ProtocolCaseId = typeof protocolCaseIds[number]
type ProtocolCase = { id: ProtocolCaseId; level: 'minimal' | 'schema' | 'stage'; tool: ToolDefinition;
  schema: z.ZodType; messages: ChatMessage[]; expected: Record<string, unknown>; validate?: (value: any) => void }
const probe = z.strictObject({ ack: z.literal(true) })
const settings = { quizLevel: 'meaningHanzi' as const, complexity: 'phrases' as const, scope: 'everyday' as const, focus: 'characters' as const, topic: 'Courtesy' }

function questionPlanningControl(id: ProtocolCaseId, context: any): ProtocolCase {
  context = { ...context, remainingWaypointIds: context.remainingWaypointIds ?? context.graph.waypoints.filter((w: any) => !(context.coverage ?? []).some((c: any) => c.waypointId === w.id)).map((w: any) => w.id) }; delete context.generationMode
  const stage = lessonStages.proposeQuestions, schema = stage.schema(context)
  const tool: ToolDefinition = { type: 'function', function: {
    name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema),
  } }
  return { id, level: 'stage', schema, tool, expected: {},
    messages: assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages,
    validate: value => { plannedQuestionGap(value, context.graph, context) } }
}

function questionReviewControl(id: ProtocolCaseId, context: any, decision?: 'accept' | 'revise'): ProtocolCase {
  context = { ...context }; delete context.generationMode
  // Recompute app-owned evidence rather than trusting metadata from an old capture.
  delete context.visibleQuestion
  delete context.validationIssue
  try {
    context.visibleQuestion = visibleQuestionView(validateWaypointQuestion(
      questionFromWaypoint(context.candidate, context.gap, context.graph, context), context.gap.cardId, context, context.phase))
  } catch (error) {
    if (!(error instanceof InputValidationError)) throw error
    // Negative captures may be unplayable; expose the real issue, not a fabricated display.
    context.validationIssue = error.message
  }
  const stage = lessonStages.reviewQuestion, schema = stage.schema(context), tool: ToolDefinition = { type: 'function', function: {
    name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema),
  } }
  return { id, level: 'stage', tool, schema, expected: decision === undefined ? {} : { decision },
    messages: assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages }
}

function questionAuthoringControl(id: ProtocolCaseId, context: any): ProtocolCase {
  const waypoint = context.graph.waypoints.find((w: any) => !(context.coverage ?? []).some((c: any) => c.waypointId === w.id))
  context = { ...context, gap: context.gap ?? plannedQuestionGap({ waypointId: waypoint.id, cardId: waypoint.cardIds[0] }, context.graph, context) }
  delete context.proposedDirections
  const stage = lessonStages.buildQuestion, schema = stage.schema(context)
  const tool: ToolDefinition = { type: 'function', function: {
    name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema),
  } }
  return { id, level: 'stage', schema, tool, expected: {},
    messages: assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages,
    validate: value => {
      const gap = validateGap(context.gap, context.graph, context)
      const selected = waypointContext(context.graph, gap.waypointIds)
      const focused = { ...context, sources: context.sources.filter((s: any) => selected.some(w => w.sourceIds.includes(s.id))) }
      const candidate = value
      validateWaypointQuestion(questionFromWaypoint(candidate, gap, context.graph, focused), gap.cardId, focused, context.phase)
    },
  }
}

export function protocolCase(id: ProtocolCaseId): ProtocolCase {
  if (id === 'question-build-reading-presentation') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/question-build-reading-presentation-qwen27b.json', 'utf8'))
    const context = { ...saved.context }; delete context.generationMode
    return questionAuthoringControl(id, context)
  }
  if (id === 'question-review-neutral-reuse') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/review-neutral-stem-reuse-qwen27b.json', 'utf8'))
    return questionReviewControl(id, saved.context)
  }
  if (id === 'question-review-reading-presentation') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/question-review-reading-presentation-flashnext.json', 'utf8'))
    return questionReviewControl(id, saved.context)
  }
  if (id.startsWith('authoring-transfer/') || id.startsWith('planning-transfer/')) {
    const [, kind, level] = id.split('/')
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/question-authoring-transfer-v1.json', 'utf8'))
    const entry = saved.cases.find((c: any) => c.context.kind === kind)
    if (!entry) throw new Error('Unknown transfer lesson kind.')
    const context = structuredClone(entry.context)
    context.settings.quizLevel = quizLevelSchema.parse(level)
    const input = waypointLessonInputSchema.parse(Object.fromEntries(
      Object.keys(waypointLessonInputSchema.shape).filter(key => key in context).map(key => [key, context[key]])))
    validateLessonBrief(input); validateLessonGraph(context.graph, input)
    if (id.startsWith('planning-transfer/')) {
      delete context.proposedDirections
      return questionPlanningControl(id, context)
    }
    return questionAuthoringControl(id, context)
  }
  if (id === 'question-review-answer-mode' || id === 'question-review-answer-mode-scenario') {
    const scenario = id === 'question-review-answer-mode-scenario'
    const file = scenario ? 'reviewer-answer-mode-drift-flashnext.json' : 'reviewer-answer-mode-drift-flashnext-v19.json'
    const saved = JSON.parse(readFileSync(`tests/evaluation/focused-cases/${file}`, 'utf8'))
    const context = scenario ? parseToolContext(saved.sequences[0].call.request.messages[1].content) : saved.context
    return questionReviewControl(id, context)
  }

  if (id.startsWith('guarded-coverage-')) {
    const original = protocolCase(id.slice('guarded-'.length) as ProtocolCaseId)
    const context = parseToolContext(original.messages[1]!.content!)
    delete context.generationMode
    const reviewed = { ...context.question, correctOptionId: 'A' }
    const projected = projectCoverageContext(context, reviewed, context.question.id)
    const stage = lessonStages.evaluateCoverage, schema = stage.schema(projected as any)
    const tool: ToolDefinition = { type: 'function', function: { name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema) } }
    return { id, level: 'stage', tool, schema, expected: original.expected,
      messages: assembleLessonPrompt(tool.function, projected as any, stage.instructions(projected as any)).messages,
      validate: value => { validateCoverageSubmission(context, reviewed, value.waypointIds) } }
  }

  if (id === 'question-plan-reading-presentation' || id === 'question-plan-fresh-application' || id === 'question-plan-preserve-meaning' || id === 'question-plan-directions-length') {
    const file = id === 'question-plan-reading-presentation' ? 'question-plan-reading-presentation-flashnext.json' : id === 'question-plan-fresh-application' ? 'question-plan-fresh-application-qwen27b.json' : id === 'question-plan-directions-length' ? 'question-directions-length-qwen27b.json' : 'transfer-meaning-drift-qwen27b.json'
    const saved = JSON.parse(readFileSync(`tests/evaluation/focused-cases/${file}`, 'utf8'))
    return questionPlanningControl(id, saved.context)
  }
  if (id === 'question-review-reply-intent') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/review-reply-intent-qwen27b.json', 'utf8'))
    return questionReviewControl(id, saved.context, saved.expectedDecision)
  }
  if (id === 'coverage-reviewed-reply-eligibility') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/coverage-reviewed-reply-eligibility-qwen27b.json', 'utf8'))
    const context = { ...saved.context }; delete context.generationMode
    context.recognitionEligibleWaypointIds = recognitionEligibleWaypoints(context, context.graph, { ...context.question, correctOptionId: saved.reviewedCorrectOptionId })
    const definition = lessonStages.evaluateCoverage, schema = definition.schema(context), tool: ToolDefinition = { type: 'function', function: {
      name: definition.toolName, description: definition.description, parameters: z.toJSONSchema(schema) } }
    return { id, level: 'stage', tool, schema, expected: saved.expected,
      messages: assembleLessonPrompt(tool.function, context, definition.instructions(context)).messages }
  }
  if (id === 'question-review-clause-joining' || id === 'question-review-single-request') {
    const file = id === 'question-review-clause-joining' ? 'review-clause-joining-qwen27b' : 'review-single-request-qwen27b'
    const saved = JSON.parse(readFileSync(`tests/evaluation/focused-cases/${file}.json`, 'utf8'))
    return questionReviewControl(id, saved.context, saved.expectedDecision)
  }
  if (id.startsWith('blind-')) {
    const saved = JSON.parse(readFileSync(id === 'blind-reading-leak'
      ? 'tests/evaluation/focused-cases/reading-english-leak-qwen27b.json'
      : 'tests/evaluation/focused-cases/review-question-novelty-qwen27b.json', 'utf8'))
    const candidate = { ...saved.context.candidate }
    if (id === 'blind-key-leak') candidate.stem = 'Which situation involves expressing gratitude for help received?'
    const view = blindQuestionView(candidate), tool: ToolDefinition = { type: 'function', function: {
      name: 'solve_english_question', description: 'Record what the English-only question determines, without the hidden expression or key.',
      parameters: z.toJSONSchema(blindQuestionResultSchema),
    } }
    const prompt = toolPrompt(tool.function)
    return { id, level: 'stage', tool, schema: blindQuestionResultSchema,
      expected: { answerId: id === 'blind-neutral' ? 'unknown' : 'A' },
      messages: [{ role: 'system', content: `${prompt.description}\n\n${BLIND_QUESTION_INSTRUCTIONS}` },
        { role: 'user', content: JSON.stringify(view) + prompt.footer }] }
  }
  if (id === 'question-review-repair') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/question-review-repair-p12.json', 'utf8'))
    return questionReviewControl(id, parseToolContext(saved.failedReviews[0].call.request.messages[1].content!))
  }
  if (id === 'coverage-situation-overcredit') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/coverage-situation-overcredit-qwen27b.json', 'utf8'))
    const context = { ...saved.records[0].context }; delete context.generationMode
    const stage = lessonStages.evaluateCoverage, schema = stage.schema(context), tool: ToolDefinition = { type: 'function', function: {
      name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema),
    } }
    return { id, level: 'stage', schema, tool, expected: saved.expected,
      messages: assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages }
  }
  if (id === 'coverage-assessment-length' || id === 'coverage-repair-echo') {
    const saved = JSON.parse(readFileSync(id === 'coverage-repair-echo'
      ? 'tests/evaluation/focused-cases/coverage-repair-echo-p12.json'
      : 'tests/evaluation/focused-cases/coverage-assessment-length-qwen27b.json', 'utf8'))
    const context = parseToolContext(saved.failedAssessments[0].call.request.messages[1].content!)
    delete context.generationMode
    const stage = lessonStages.evaluateCoverage, schema = stage.schema(context), tool: ToolDefinition = { type: 'function', function: {
      name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema),
    } }
    return { id, level: 'stage', schema, tool, expected: {},
      messages: assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages,
      validate: value => {
        if (new Set(value.waypointIds).size !== value.waypointIds.length || value.waypointIds.some((id: string) => !context.graph.waypoints.some((w: any) => w.id === id))) throw new Error('Invalid coverage waypoint references.')
      } }
  }
  if (id === 'question-review-reason-limit') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/question-review-reason-length-qwen27b.json', 'utf8'))
    const context = parseToolContext(saved.failedReviews[0].call.request.messages[1].content!)
    return questionReviewControl(id, context, 'revise')
  }
  if (id === 'question-review-reading-leak') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/reading-english-leak-qwen27b.json', 'utf8'))
    return questionReviewControl(id, saved.context, 'revise')
  }
  if (id === 'question-review-novelty' || id === 'question-review-key-leak' || id === 'question-review-duplicate') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/review-question-novelty-qwen27b.json', 'utf8'))
    const context = { ...saved.context }; delete context.generationMode
    if (id === 'question-review-key-leak') context.candidate = { ...context.candidate, stem: 'Which situation involves expressing gratitude for help received?' }
    if (id === 'question-review-duplicate') {
      const question = { ...context.currentQuestions[0], cardId: context.gap.cardId,
        stem: context.candidate.stem, passage: context.candidate.passage }
      context.currentQuestions = [question]
      context.coverage = context.graph.waypoints.filter((point: any) => point.cardIds.includes(question.cardId))
        .map((point: any) => ({ waypointId: point.id, questionIds: [question.id] }))
    }
    return questionReviewControl(id, context, id === 'question-review-novelty' ? 'accept' : 'revise')
  }
  if (id === 'probe') {
    const tool: ToolDefinition = { type: 'function', function: { name: 'record_probe', description: 'Acknowledge the diagnostic with ack=true.', parameters: z.toJSONSchema(probe) } }
    return { id, level: 'minimal', tool, schema: probe, expected: { ack: true }, messages: [
      { role: 'system', content: 'Submit the requested result through the available native function. Use its argument schema.' },
      { role: 'user', content: 'Acknowledge this diagnostic with record_probe and ack=true.' },
    ] }
  }
  if (id === 'waypoint-add-stage') {
    const saved = JSON.parse(readFileSync('tests/evaluation/focused-cases/build-waypoint-qwen27b-quoted-tags.json', 'utf8'))
    const context = { ...saved.context }; delete context.generationMode
    const stage = lessonStages.buildWaypoint, schema = stage.schema(context), tool: ToolDefinition = { type: 'function', function: {
      name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema),
    } }
    return { id, level: 'stage', tool, schema, expected: {},
      messages: assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages,
      validate: value => { applyWaypoint(context.graph, context.nextWaypointId, proposalWaypoint(value, context.nextWaypointId), context) },
    }
  }
  if (id === 'question-build-stage' || id === 'question-build-format-repair' || id === 'question-build-english-stem' || id.startsWith('coverage-')) {
    const build = id === 'question-build-stage' || id === 'question-build-format-repair' || id === 'question-build-english-stem'
    const saved = JSON.parse(readFileSync(id === 'question-build-english-stem' ? 'tests/evaluation/focused-cases/english-stem-placement-qwen27b.json'
      : id === 'question-build-format-repair' ? 'tests/evaluation/focused-cases/question-tool-format-qwen27b.json'
      : build ? 'tests/evaluation/focused-cases/build-question-qwen27b.json'
      : 'tests/evaluation/focused-cases/coverage-phrase-specific.json', 'utf8'))
    const context: any = build ? { ...saved.context } : parseToolContext(saved.results[0].calls[0].request.messages[0].content)
    delete context.generationMode
    const thanks = id.endsWith('thanks'), reply = id.startsWith('coverage-reply-')
    if (!build && thanks) {
      context.question.passage = '谢谢！'
      context.question.stem = 'What does the expression mean?'
      context.question.options = [{ id: 'A', text: 'Thank you.' }, { id: 'B', text: 'Sorry.' }, { id: 'C', text: 'Hello.' }, { id: 'D', text: 'Goodbye.' }]
    } else if (!build) {
      context.question.passage = '对不起！'
      context.question.stem = 'What does the expression mean?'
      context.question.options = [{ id: 'A', text: 'Sorry.' }, { id: 'B', text: 'Thank you.' }, { id: 'C', text: 'Hello.' }, { id: 'D', text: 'Goodbye.' }]
    }
    if (reply) {
      context.settings = { ...context.settings, quizLevel: 'responseHanzi' }
      context.question.stem = thanks ? 'Choose a Mandarin reply that thanks someone for a favor.' : 'Choose a Mandarin reply that apologizes for a mistake.'
      delete context.question.passage
      context.question.options = [{ id: 'A', text: thanks ? '谢谢' : '对不起' }, { id: 'B', text: thanks ? '对不起' : '谢谢' },
        { id: 'C', text: '你好' }, { id: 'D', text: '再见' }]
    }
    if (!build) context.currentQuestions = context.currentQuestions.filter((q: any) => q.id !== context.question.id)
    if (build) return questionAuthoringControl(id, context)
    const stage = lessonStages.evaluateCoverage
    const schema = stage.schema(context), tool: ToolDefinition = { type: 'function', function: { name: stage.toolName,
      description: stage.description, parameters: z.toJSONSchema(schema) } }
    return { id, level: 'stage', schema, tool, expected: { waypointIds: [thanks ? 'w1' : 'w2'] },
      messages: assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages,
      validate: value => {
        if (new Set(value.waypointIds).size !== value.waypointIds.length || value.waypointIds.some((id: string) => !context.graph.waypoints.some((w: any) => w.id === id))) throw new Error('Invalid coverage waypoint references.')
      },
    }
  }
  const graph = id.startsWith('graph-'), stage = graph ? lessonStages.reviewGraph : lessonStages.reviewWaypoint
  let context: any = { kind: 'topic', settings }
  if (id.endsWith('-stage')) {
    const file = `tests/evaluation/focused-cases/${graph ? 'review-graph-qwen27b' : 'review-waypoint-qwen-flash'}.json`
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    context = parseToolContext(saved.results[0].calls[0].request.messages[0].content)
    delete context.generationMode
  }
  const schema = graph && !id.endsWith('-stage') ? graphReviewSchema : stage.schema(context), tool: ToolDefinition = { type: 'function', function: {
    name: stage.toolName, description: stage.description, parameters: z.toJSONSchema(schema),
  } }
  const expected = { decision: graph ? 'add' : 'accept' }
  const messages: ChatMessage[] = id.endsWith('-stage')
    ? assembleLessonPrompt(tool.function, context, stage.instructions(context)).messages
    : [{ role: 'system', content: 'Record the supplied decision with the available native function. Do not evaluate a lesson in this schema-only diagnostic.' },
      { role: 'user', content: `Call ${stage.toolName} with decision=${expected.decision}, reason="Diagnostic verdict." and no other fields.` }]
  return { id, level: id.endsWith('-stage') ? 'stage' : 'schema', tool, schema, expected, messages }
}

export type ProtocolControlOptions = {
  provider: Pick<ChatOptions, 'baseUrl' | 'apiKey' | 'model' | 'compatibility'>
  responseMode: 'stream' | 'complete'; toolChoice: 'named' | 'required' | 'auto'; thinking: boolean
  toolResponseDialect?: 'native' | 'qwen_xml'
  modelGuidance?: string
  fieldDescription?: { field: string; baselineDescription: string; candidateDescription: string }
  footerFormat?: 'native' | 'qwen_xml'
  normalizeParameterNameQuotes?: boolean
  allowAssistantPrefix?: boolean
  normalizeFunctionOpening?: boolean
  signal?: AbortSignal; transport?: typeof streamChat
}

/** These controls measure submission capability, independently of lesson completion or language quality. */
export async function runProtocolControl(id: ProtocolCaseId, options: ProtocolControlOptions) {
  const control = protocolCase(id), started = performance.now()
  const messages = structuredClone(control.messages)
  const originalPrompt = toolPrompt(control.tool.function)
  if (options.fieldDescription) {
    const { field, baselineDescription, candidateDescription } = options.fieldDescription
    const properties = control.tool.function.parameters.properties as Record<string, { description?: string }>
    if (!properties?.[field] || properties[field]!.description !== baselineDescription || !candidateDescription.trim()) throw new Error('Field-description experiment must match an existing baseline description.')
    if (!messages[0]!.content!.startsWith(originalPrompt.description)) throw new Error('Field-description experiments require an assembled stage prompt.')
    properties[field]!.description = candidateDescription
    messages[0]!.content = toolPrompt(control.tool.function).description + messages[0]!.content!.slice(originalPrompt.description.length)
  }
  if (options.footerFormat || options.fieldDescription) {
    const user = messages.at(-1)!, oldFooter = originalPrompt.footer
    if (user.content?.endsWith(oldFooter)) user.content = user.content.slice(0, -oldFooter.length)
    user.content += toolPrompt(control.tool.function, options.footerFormat ?? 'native').footer
  }
  if (options.modelGuidance) messages[0]!.content += `\n\nModel guidance:\n${options.modelGuidance}`
  const toolChoice: ToolChoice = options.toolChoice === 'named' ? { type: 'function', function: { name: control.tool.function.name } } : options.toolChoice
  const request: ChatOptions = { ...options.provider, messages, tools: [control.tool], toolChoice,
    responseMode: options.responseMode, toolResponseDialect: options.toolResponseDialect ?? 'native', normalizeParameterNameQuotes: options.normalizeParameterNameQuotes,
    allowAssistantPrefix: options.allowAssistantPrefix,
    normalizeFunctionOpening: options.normalizeFunctionOpening,
    featherlessThinking: options.thinking, maxTokens: 4096, temperature: 0.2,
    timeoutMs: 120_000 }
  let diagnostic: ResponseDiagnostic | undefined, providerError: ProviderStreamError | undefined
  let response: Omit<ChatResult, 'reasoning'> | undefined, failure: InferenceFailureRecord | undefined
  let schemaAccepted = false, contractAccepted = false, expectedFieldsMatch: boolean | null = null, wireEvidenceTruncated = false, eventCount = 0
  const wireNativeFields: unknown[] = []
  let wireContent = '', wireContentTruncated = false
  let evidenceBytes = 0, wireRequest: Record<string, unknown> | undefined
  const latency: { firstEventMs: number | null; firstOutputMs: number | null } = { firstEventMs: null, firstOutputMs: null }
  const markOutput = () => { latency.firstOutputMs ??= Math.round(performance.now() - started) }
  try {
    const result = await (options.transport ?? streamChat)({ ...request, handlers: { signal: options.signal,
      onContent: text => {
        if (text.length) markOutput()
        const remaining = 8000 - wireContent.length
        wireContent += text.slice(0, remaining)
        if (text.length > remaining) wireContentTruncated = true
      },
      onReasoning: text => { if (text.length) markOutput() },
      onDiagnostic: value => { diagnostic = value }, onProviderError: value => { providerError = value },
      onWireEvent: value => {
        latency.firstEventMs ??= Math.round(performance.now() - started)
        eventCount++
        const fields = (value as any)?.choices?.flatMap((choice: any) => choice.delta?.tool_calls ?? choice.message?.tool_calls ?? []) ?? []
        if (fields.length) markOutput()
        const size = new TextEncoder().encode(JSON.stringify(fields)).byteLength
        if (evidenceBytes + size <= 65_536) { evidenceBytes += size; wireNativeFields.push(...fields) }
        else wireEvidenceTruncated = true
      },
    }, fetcher: async (url, init) => { wireRequest = JSON.parse(String(init?.body)); return fetch(url, init) } })
    const { reasoning: _reasoning, ...recorded } = result
    response = recorded
    const value = parseStageSubmission(result, control.tool.function.name, control.schema, value => { schemaAccepted = true; control.validate?.(value) }) as Record<string, unknown>
    contractAccepted = true
    expectedFieldsMatch = Object.keys(control.expected).length ? Object.entries(control.expected).every(([key, expected]) =>
      Array.isArray(expected) && Array.isArray(value[key]) ? JSON.stringify([...value[key]].sort()) === JSON.stringify([...expected].sort()) : value[key] === expected) : null
  } catch (error) {
    const classified = classifyInferenceFailure(error, options.signal).failure
    failure = { ...classified, httpStatus: classified.httpStatus ?? diagnostic?.httpStatus,
      requestId: classified.requestId ?? diagnostic?.requestId }
  }
  return { caseId: id, level: control.level, requestedModel: options.provider.model, responseMode: options.responseMode,
    allowAssistantPrefix: options.allowAssistantPrefix ?? false,
    normalizeFunctionOpening: options.normalizeFunctionOpening ?? false,
    toolChoice: options.toolChoice, toolResponseDialect: request.toolResponseDialect, normalizeParameterNameQuotes: options.normalizeParameterNameQuotes ?? false,
    footerFormat: options.footerFormat ?? 'original', thinking: options.thinking, durationMs: Math.round(performance.now() - started),
    request: { messages: request.messages, tools: request.tools, toolChoice, maxTokens: request.maxTokens, temperature: request.temperature },
    wireRequest, diagnostic, providerError, response, failure, latency, responseReceived: Boolean(response), schemaAccepted, contractAccepted, expectedFieldsMatch,
    hasDeclaredExpectation: Object.keys(control.expected).length > 0,
    nativeContractAccepted: contractAccepted && response?.toolProtocol?.representation !== 'qwen_xml',
    representation: response?.toolProtocol?.representation ?? (response?.toolCalls.length ? 'native' : null),
    wireEvidence: { eventCount, nativeFields: wireNativeFields, truncated: wireEvidenceTruncated,
      content: wireContent, contentTruncated: wireContentTruncated,
      parserSawNativeFields: eventCount ? Boolean(diagnostic?.nativeToolCalls) === Boolean(wireNativeFields.length) : null },
    evidence: 'Protocol/schema and declared-field agreement only; not Mandarin instructional quality.' }
}

export const protocolFixture: typeof streamChat = async request => {
  const name = request.tools![0]!.function.name
  if (name === 'solve_english_question') {
    const view = parseToolContext(request.messages[1]!.content!)
    return { content: '', reasoning: '', finishReason: 'tool_calls', model: 'authored-protocol-fixture', toolCalls: [
      { id: 'blind-fixture', type: 'function', function: { name, arguments: JSON.stringify({
        answerId: view.stem === 'Which situation fits this expression?' ? 'unknown' : 'A',
        reason: 'Authored English-only control, not independent inference.' }) } },
    ] }
  }
  if (name === 'verify_correct_question') {
    const context = parseToolContext(request.messages[1]!.content!)
    return { content: '', reasoning: '', finishReason: 'tool_calls', model: 'authored-protocol-fixture', toolCalls: [
      { id: 'question-review-fixture', type: 'function', function: { name, arguments: JSON.stringify({
        decision: context.settings.complexity === 'simple' && context.candidate.answerA === '请给我一杯茶，不要加糖。' || context.validationIssue || context.candidate.stem === 'What is the reason given for putting paper in the recycling bin?' || context.candidate.stem.includes('expressing gratitude') || context.currentQuestions.some((q: any) =>
          q.stem === context.candidate.stem && q.passage === context.candidate.passage) ? 'revise' : 'accept',
        reason: 'Authored reviewer control; not independent inference.' }) } },
    ] }
  }
  if (name === 'build_question_answers' || name === 'list_missing_questions') return waypointFixture(request)
  if (name === 'evaluate_question_coverage') {
    const context = parseToolContext(request.messages[1]!.content!)
    return { content: '', reasoning: '', finishReason: 'tool_calls', model: 'authored-protocol-fixture', toolCalls: [
      { id: 'coverage-fixture', type: 'function', function: { name, arguments: JSON.stringify({ waypointIds: [(context.question.passage?.includes('谢谢') || context.question.stem.includes('thanks someone')) ? 'w1' : 'w2'], assessment: 'Provisional labeled control.' }) } },
    ] }
  }
  if (name === 'add_lesson_waypoint') {
    const input = parseToolContext(request.messages[1]!.content!)
    const target = input.targets.find((t: any) => !input.graph.waypoints.some((w: any) => w.cardIds.includes(t.cardId)))
    return { content: '', reasoning: '', finishReason: 'tool_calls', model: 'authored-protocol-fixture', toolCalls: [
      { id: 'probe-call', type: 'function', function: { name, arguments: JSON.stringify({ cardIds: [target.cardId], dependsOn: [],
        objective: 'Recognize an apology.', explanation: 'This expression is used to apologize.', exampleHanzi: target.hanzi,
        exampleMeaning: target.meaning, sourceIds: [input.sources[0].id] }) } },
    ] }
  }
  const args = name === 'record_probe' ? { ack: true } : { decision: name === 'verify_lesson_graph' ? 'add' : 'accept', reason: 'Authored protocol fixture.' }
  return { content: '', reasoning: '', finishReason: 'tool_calls', model: 'authored-protocol-fixture', toolCalls: [
    { id: 'probe-call', type: 'function', function: { name, arguments: JSON.stringify(args) } },
  ] }
}
