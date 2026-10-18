import { describe, expect, it, vi } from 'vitest'
import type { ChatOptions, ChatResult } from '../../src/lib/ai/types'
import { InferenceFailure } from '../../src/lib/ai/inferenceFailure'
import { executeLessonStage } from '../../src/lib/teacher/lessonGeneration/executeStage'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import { parseToolContext, parseToolProjection } from '../fixtures/tool-context'
import { waypointResult } from '../fixtures/topic-lesson'
import { assembleLessonPrompt } from '../../src/lib/teacher/lessonGeneration/assemblePrompt'
import { LEARNER_REQUEST, REPAIR_EXPLANATION } from '../../src/lib/teacher/lessonGeneration/prompts'
import { streamChat } from '../../src/lib/ai/client'
import { questionPlanningExample, questionPlanningExamplesText } from '../../src/lib/teacher/lessonGeneration/planningExamples'

const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', compatibility: 'featherless' as const }
const context = { kind: 'topic' as const, settings: { quizLevel: 'meaningHanzi' as const, complexity: 'phrases' as const,
  scope: 'everyday' as const, focus: 'characters' as const, topic: 'Courtesy' }, graph: { overview: '', waypoints: [] } }
const verdict = { decision: 'accept', reason: 'Supported fixture point.' }
const noCall = (content: string): ChatResult => ({ content, reasoning: 'Not submitted.', toolCalls: [], finishReason: 'stop', model: 'fixture' })

describe('fresh lesson submission corrections', () => {
  it('keeps shared lesson and assessment context factual across stages and answer directions', () => {
    for (const kind of ['topic', 'scenario', 'reading'] as const) {
      for (const quizLevel of ['meaningHanzi', 'meaningPinyin', 'responseHanzi', 'responsePinyin'] as const) {
        const c = { ...context, kind, phase: 'check' as const, settings: { ...context.settings, quizLevel, complexity: 'simple' as const } }
        for (const id of ['reviewGraph', 'reviewWaypoint', 'evaluateCoverage'] as const) {
          const stage = lessonStages[id]
          const prompt = assembleLessonPrompt({ name: stage.toolName, description: stage.description, parameters: {} }, c, stage.instructions(c))
          const system = prompt.messages[0]!.content!
          expect(system).toContain(`${kind.toUpperCase()} CONTEXT:`)
          expect(system).toContain(quizLevel.startsWith('meaning') ? 'English answers' : 'Mandarin reply')
          expect(system).toContain('One short Mandarin clause')
          for (const unrelated of ['Build waypoints', 'Plan comprehension questions', 'Plan a question about', 'During revision, change'])
            expect(system).not.toContain(unrelated)
          expect(system).toContain(stage.instructions(c))
        }
      }
    }
  })
  it('offers only actual graph revision targets and demonstrates complete review verdicts', () => {
    const c = { ...context, graph: { overview: 'A greeting.', waypoints: [{ id: 'w1' }] } }
    const stage = lessonStages.reviewGraph, schema = stage.schema(c)
    const examples = [...stage.instructions(c).matchAll(/Complete submission arguments: (\{[^\n]+\})/g)].map(match => JSON.parse(match[1]!))
    expect(examples.map(value => schema.parse(value).decision)).toEqual(['add', 'revise', 'revise'])
    expect(schema.safeParse({ decision: 'revise', reason: 'Revise a future point.', waypointId: 'w2' }).success).toBe(false)
    expect(schema.parse({ decision: 'add', reason: 'Teach the remaining expression.' })).not.toHaveProperty('waypointId')
    const missing = lessonStages.reviewGraph.schema({ ...c, missingTeachingPoints: [{ cardId: 'not-taught' }] })
    expect(missing.safeParse({ decision: 'accept', reason: 'The concepts seem covered.' }).success).toBe(false)
    expect(missing.parse({ decision: 'add', reason: 'Teach the remaining expression.' }).decision).toBe('add')
    expect(lessonStages.reviewGraph.schema({ ...c, missingTeachingPoints: [] }).safeParse({ decision: 'accept', reason: 'Every target is taught.' }).success).toBe(true)
  })
  it('provides matched complete examples and asks the author only for question content', () => {
    for (const quizLevel of ['meaningHanzi', 'meaningPinyin', 'responseHanzi', 'responsePinyin'] as const) {
      for (const phase of ['practice', 'check'] as const) {
        const settings = { ...context.settings, quizLevel }
        const example = questionPlanningExample(settings, phase)
        const c = { ...context, ...example.input, kind: 'topic' as const, phase }
        expect(lessonStages.proposeQuestions.schema(c).parse(example.arguments)).toEqual(example.arguments)
        const text = questionPlanningExamplesText(settings, phase)
        expect(lessonStages.proposeQuestions.instructions(c)).toContain(text)
        const author = lessonStages.buildQuestion.instructions(c)
        const args = JSON.parse(author.split('Complete question arguments:\n')[1]!)
        expect(lessonStages.buildQuestion.schema(c).parse(args)).toEqual(args)
        for (const field of ['waypointIds', 'cardId', 'intent', 'whyMissing']) expect(args).not.toHaveProperty(field)
        expect(lessonStages.reviewQuestion.instructions(c)).not.toContain(text)
        const stage = lessonStages.buildQuestion
        const prompt = assembleLessonPrompt({ name: stage.toolName, description: stage.description, parameters: {} }, c, author)
        expect(Object.values(parseToolProjection(prompt.messages[1]!.content!))[0]).toBe(LEARNER_REQUEST)
      }
    }
  })
  it.each(['native', 'qwen_xml'] as const)('preserves evidence, examples and repair footer with task placement in %s', dialect => {
    const tool = { name: 'verify_lesson_waypoint', description: 'Review one point.', parameters: {
      type: 'object', properties: { decision: { type: 'string' }, reason: { type: 'string', maxLength: 1000 } }, required: ['decision', 'reason'],
    } }
    const task = 'Review the candidate.', modelGuidance = 'A worked example remains here.'
    const data = { ...context, graph: { ...context.graph, currentTask: 'DOMAIN_EVIDENCE' }, currentTask: 'UNTRUSTED_TASK' }
    const baseline = assembleLessonPrompt(tool, data, task, { dialect, modelGuidance })
    const candidate = assembleLessonPrompt(tool, data, task, { dialect, modelGuidance, taskPlacement: 'user_context_tail' })
    const repair = { decision: 'revise', reason: 'x'.repeat(1001) }
    for (const [original, moved] of [[baseline.messages[1]!, candidate.messages[1]!],
      [baseline.project('reason exceeds limit.', repair), candidate.project('reason exceeds limit.', repair)]]) {
      const expected = parseToolProjection(original.content!), actual = parseToolProjection(moved.content!)
      expect(Object.keys(actual).at(-1)).toBe('currentTask')
      expect(actual.currentTask.endsWith(task)).toBe(true)
      expect(moved.content).not.toContain('UNTRUSTED_TASK')
      expect(parseToolContext(moved.content!).graph.currentTask).toBe('DOMAIN_EVIDENCE')
      expect(parseToolContext(moved.content!)).not.toHaveProperty('currentTask')
      delete expected.currentTask; delete actual.currentTask
      expect(actual).toEqual(expected)
      expect(moved.content!.slice(moved.content!.indexOf('\n\nTool call:\n'))).toBe(original.content!.slice(original.content!.indexOf('\n\nTool call:\n')))
    }
    expect(candidate.messages[0]!.content).toContain(modelGuidance)
    expect(candidate.messages[0]!.content).not.toContain(task)
    expect(candidate.messages[0]!.content!.startsWith('Tool:')).toBe(true)
  })
  it('corrects a real client output-limit failure without replaying partial arguments or changing token limits', async () => {
    const requests: ChatOptions[] = [], events: any[] = [], validate = vi.fn()
    const result = await executeLessonStage({ provider, onSubmission: event => { events.push(event) }, transport: async request => {
      requests.push(request)
      const limited = requests.length === 1
      return streamChat({ ...request, responseMode: 'complete', fetcher: async () => new Response(JSON.stringify({
        choices: [{ message: { content: limited ? 'DISCARDED_PARTIAL_CONTENT' : '', tool_calls: [{ id: limited ? 'partial-call' : 'complete-call', type: 'function',
          function: { name: request.tools![0]!.function.name, arguments: limited ? '{"reason":"DISCARDED_PARTIAL_ARGUMENTS' : JSON.stringify(verdict) } }] },
          finish_reason: limited ? 'length' : 'tool_calls' }], usage: { prompt_tokens: 3084, completion_tokens: limited ? 4096 : 20, total_tokens: limited ? 7180 : 3104 },
      })) })
    } }, lessonStages.reviewWaypoint, context, validate)
    expect(result.value).toEqual(verdict)
    expect(validate).toHaveBeenCalledExactlyOnceWith(verdict)
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.maxTokens)).toEqual([4096, 4096])
    expect(requests.map(request => request.generationTrace!.attempt)).toEqual([{ submission: 1, request: 1 }, { submission: 2, request: 1 }])
    expect(requests[1]!.messages.map(message => message.role)).toEqual(['system', 'user'])
    expect(JSON.stringify(requests[1]!.messages)).not.toContain('DISCARDED_PARTIAL')
    const projected = parseToolContext(requests[1]!.messages[1]!.content!)
    expect(projected).not.toHaveProperty('candidateSubmission')
    expect(projected.graph).toEqual(context.graph)
    expect(projected.nativeSubmissionIssue).toContain('same output allowance')
    expect(events).toEqual([expect.objectContaining({ accepted: false, submissionAttempt: 1, requestAttempt: 1,
      failure: expect.objectContaining({ category: 'output_limit', retryable: false, finishReason: 'length', httpStatus: 200 }) }),
    expect.objectContaining({ accepted: true, submissionAttempt: 2, requestAttempt: 1 })])
  })

  it('exhausts output-limit corrections at the existing submission count, without transport resends', async () => {
    const events: any[] = [], transport = vi.fn(async (_request: ChatOptions) => {
      throw new InferenceFailure({ category: 'output_limit', layer: 'protocol', retryable: false, finishReason: 'length',
        message: 'The provider reached its output cap.', httpStatus: 200, requestId: `output-${transport.mock.calls.length}` })
    })
    await expect(executeLessonStage({ provider, transport, onSubmission: event => { events.push(event) } }, lessonStages.reviewWaypoint, context))
      .rejects.toMatchObject({ failure: { category: 'output_limit', layer: 'protocol', retryable: false, finishReason: 'length',
        stage: 'reviewWaypoint', submissionAttempt: 2, requestAttempt: 1, correctionExhausted: true, requestId: 'output-2' } })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(events.every(event => !event.accepted && event.failure.category === 'output_limit')).toBe(true)
    expect(events.map(event => event.submissionAttempt)).toEqual([1, 2])
  })

  it('adds measured repair guidance only for a rejected explanation exceeding its schema limit', () => {
    const tool = { name: 'verify_lesson_waypoint', description: 'Review one point.', parameters: {
      type: 'object', properties: { decision: { type: 'string' }, reason: { type: 'string', maxLength: 1000 } },
      required: ['decision', 'reason'],
    } }
    const prompt = assembleLessonPrompt(tool, context, 'Review the candidate.', { dialect: 'qwen_xml' })
    const first = prompt.messages[1]!.content!
    expect(first).not.toContain(REPAIR_EXPLANATION)
    const candidate = { decision: 'revise', reason: 'x'.repeat(1001) }
    const repaired = prompt.project('reason exceeds its limit.', candidate).content!
    expect(repaired).toContain(REPAIR_EXPLANATION)
    expect(parseToolContext(repaired).candidateSubmission).toEqual({ decision: 'revise' })
    expect(candidate.reason).toHaveLength(1001)
    expect(parseToolContext(repaired).graph).toEqual(context.graph)
    expect(repaired.endsWith(first.slice(first.indexOf('verify_lesson_waypoint(')))).toBe(true)
    expect(prompt.project('Malformed function tag.').content).not.toContain(REPAIR_EXPLANATION)
    expect(prompt.project('Other constraint.', { ...candidate, reason: 'x'.repeat(1000) }).content).not.toContain(REPAIR_EXPLANATION)
    expect(parseToolContext(prompt.project('Other constraint.', { ...candidate, reason: 'x'.repeat(1000) }).content!).candidateSubmission.reason).toHaveLength(1000)
    expect(prompt.project(undefined, candidate).content).not.toContain(REPAIR_EXPLANATION)
    const unbounded = assembleLessonPrompt({ ...tool, parameters: { type: 'object', properties: { reason: { type: 'string' } } } },
      context, 'Review.')
    expect(unbounded.project('Other constraint.', candidate).content).not.toContain(REPAIR_EXPLANATION)
  })
  it.each([
    ['empty_output', 'protocol'], ['tool_missing', 'protocol'], ['tool_unexpected', 'protocol'],
    ['arguments_invalid', 'protocol'], ['schema_invalid', 'validation'], ['constraints_invalid', 'validation'],
    ['output_limit', 'protocol'], ['protocol_error', 'protocol'],
  ] as const)('preserves %s classification and rejected-attempt evidence through stage exhaustion', async (category, layer) => {
    const events: any[] = []
    const transport = vi.fn(async (request: ChatOptions) => {
      const result = waypointResult(request, verdict)
      if (category === 'empty_output' || category === 'tool_missing') return noCall(category === 'empty_output' ? '' : 'A prose verdict.')
      if (category === 'tool_unexpected') result.toolCalls[0]!.function.name = 'unavailable_tool'
      if (category === 'arguments_invalid') result.toolCalls[0]!.function.arguments = '{"decision":'
      if (category === 'schema_invalid') result.toolCalls[0]!.function.arguments = '{"decision":"accept"}'
      if (category === 'output_limit') result.finishReason = 'length'
      if (category === 'protocol_error') result.toolCalls[0]!.id = ''
      return result
    })
    await expect(executeLessonStage({ provider, transport,
      executionPolicy: { submissionAttempts: 1, requestAttempts: 1 },
      onSubmission: event => { events.push(event) },
    }, lessonStages.reviewWaypoint, context, () => {
      if (category === 'constraints_invalid') throw new Error('The candidate is outside the selected target.')
    })).rejects.toMatchObject({ failure: { category, layer, stage: 'reviewWaypoint', submissionAttempt: 1 } })
    expect(transport).toHaveBeenCalledOnce()
    expect(events).toEqual([expect.objectContaining({ accepted: false, submissionAttempt: 1, requestAttempt: 1,
      failure: expect.objectContaining({ category, layer, stage: 'reviewWaypoint' }) })])
  })
  it('retains the last request attempt on a post-response schema failure', async () => {
    await expect(executeLessonStage({ provider, transport: async request => waypointResult(request, { decision: 'accept' }),
      executionPolicy: { submissionAttempts: 1, requestAttempts: 1 },
    }, lessonStages.reviewWaypoint, context)).rejects.toMatchObject({ failure: { category: 'schema_invalid', requestAttempt: 1 } })
  })
  it('serializes the recovered transport attempt when the returned submission then fails validation', async () => {
    const events: any[] = []
    const transport = vi.fn(async (request: ChatOptions) => {
      if (transport.mock.calls.length === 1) throw new TypeError('Injected disconnection.')
      return waypointResult(request, { decision: 'accept' })
    })
    try {
      await executeLessonStage({ provider, transport, executionPolicy: { submissionAttempts: 1, requestAttempts: 2, retryDelayMs: 0 },
        onSubmission: event => { events.push(event) },
      }, lessonStages.reviewWaypoint, context)
      throw new Error('Expected invalid schema.')
    } catch (error) {
      expect(JSON.parse(JSON.stringify((error as InferenceFailure).failure))).toMatchObject({
        category: 'schema_invalid', stage: 'reviewWaypoint', submissionAttempt: 1, requestAttempt: 2, correctionExhausted: true,
      })
    }
    expect(transport).toHaveBeenCalledTimes(2)
    expect(events).toEqual([expect.objectContaining({ accepted: false, requestAttempt: 2,
      failure: expect.objectContaining({ requestAttempt: 2, category: 'schema_invalid' }) })])
  })
  it('classifies a failed accepted-submission observation as persistence, without regenerating', async () => {
    const cause = new Error('Outcome journal failed'), transport = vi.fn(async (request: ChatOptions) => waypointResult(request, verdict))
    const observer = vi.fn(async (_event: unknown) => { throw cause })
    await expect(executeLessonStage({ provider, transport, onSubmission: observer }, lessonStages.reviewWaypoint, context))
      .rejects.toMatchObject({ failure: { category: 'persistence_error', layer: 'persistence', stage: 'reviewWaypoint',
        checkpointId: 'submission-observation', retryable: false } })
    expect(transport).toHaveBeenCalledOnce()
    expect(observer).toHaveBeenCalledOnce()
    expect(observer.mock.calls[0]![0]).toMatchObject({ accepted: true })
  })
  it('records rejected and accepted submissions separately from received responses', async () => {
    const events: any[] = []
    const transport = vi.fn(async (request: ChatOptions) => transport.mock.calls.length === 1
      ? waypointResult(request, { ...verdict, invalid: 'extra' }) : waypointResult(request, verdict))
    await executeLessonStage({ provider, transport, onSubmission: event => { events.push(event) } }, lessonStages.reviewWaypoint, context)
    expect(events).toEqual([expect.objectContaining({ accepted: false, submissionAttempt: 1, requestAttempt: 1, failure: expect.objectContaining({ category: 'schema_invalid' }) }),
      expect.objectContaining({ accepted: true, submissionAttempt: 2, requestAttempt: 1 })])
  })
  it.each(['', 'verify_lesson_waypoint(decision="accept")', '```json\n{"decision":"accept"}\n```'])('repairs a missing native call without replaying assistant text: %s', async content => {
    const transport = vi.fn(async (request: ChatOptions) => transport.mock.calls.length === 1 ? noCall(content) : waypointResult(request, verdict))
    const result = await executeLessonStage({ provider, transport }, lessonStages.reviewWaypoint, context)
    expect(result.value).toEqual(verdict)
    const repair = transport.mock.calls[1]![0]
    expect(repair.messages.map(message => message.role)).toEqual(['system', 'user'])
    const projected = parseToolContext(repair.messages[1]!.content!)
    expect(projected.nativeSubmissionIssue).toContain('actual native function channel')
    expect(projected).not.toHaveProperty('candidateSubmission')
    expect(projected.graph).toEqual(context.graph)
    expect(context).not.toHaveProperty('nativeSubmissionIssue')
  })
  it('classifies empty output separately and preserves the last cause on correction exhaustion', async () => {
    const transport = vi.fn(async () => noCall(''))
    await expect(executeLessonStage({ provider, transport }, lessonStages.reviewWaypoint, context)).rejects.toMatchObject({
      failure: { category: 'empty_output', layer: 'protocol', stage: 'reviewWaypoint', attempt: 2, correctionExhausted: true },
    })
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('provides malformed schema arguments as candidate data, without a tool-history echo', async () => {
    const transport = vi.fn(async (request: ChatOptions) => waypointResult(request,
      transport.mock.calls.length === 1 ? { ...verdict, replacement: 'Forbidden extra field.' } : verdict))
    await executeLessonStage({ provider, transport }, lessonStages.reviewWaypoint, context)
    const repair = transport.mock.calls[1]![0]
    const projected = parseToolContext(repair.messages[1]!.content!)
    expect(repair.messages).toHaveLength(2)
    expect(projected.candidateSubmission).toEqual({ ...verdict, replacement: 'Forbidden extra field.' })
    expect(projected.nativeSubmissionIssue).toContain('validation')
  })
  it('does not retry a deterministic rejected request or label it a semantic review failure', async () => {
    const transport = vi.fn(async () => { throw new InferenceFailure({ category: 'http_rejected', layer: 'request',
      message: 'HTTP 422 rejected the request.', retryable: false, httpStatus: 422, provider: { param: 'messages' } }) })
    await expect(executeLessonStage({ provider, transport }, lessonStages.reviewWaypoint, context)).rejects.toMatchObject({
      failure: { category: 'http_rejected', httpStatus: 422, provider: { param: 'messages' }, stage: 'reviewWaypoint', attempt: 1 },
    })
    expect(transport).toHaveBeenCalledOnce()
  })
})
