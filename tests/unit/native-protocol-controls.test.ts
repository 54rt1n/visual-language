import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { protocolCase, protocolCaseIds, protocolFixture, runProtocolControl } from '../evaluation/native-protocol-controls'
import { streamChat } from '../../src/lib/ai/client'
import directionsFailure from '../evaluation/focused-cases/question-directions-length-qwen27b.json'
import frozen from '../evaluation/focused-cases/build-waypoint-qwen27b-quoted-tags.json'
import formatFailure from '../evaluation/focused-cases/question-tool-format-qwen27b.json'
import stemFailure from '../evaluation/focused-cases/english-stem-placement-qwen27b.json'
import { decodeQwenTool } from '../../src/lib/ai/qwenToolProtocol'
import { parseStageSubmission } from '../../src/lib/teacher/lessonGeneration/stageSubmission'
import { parseToolContext } from '../fixtures/tool-context'
import englishExamples from '../evaluation/examples/question-authoring-comprehension.json'
import replyExamples from '../evaluation/examples/question-authoring-reply.json'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import { waypointLessonInputSchema, validateLessonGraph } from '../../src/lib/domain/lessonGraph'
import { validateLessonBrief } from '../../src/lib/teacher/lessonGeneration/definitions'
import { validateGap } from '../../src/lib/teacher/questionGapTools'
import { questionFromWaypoint, validateWaypointQuestion } from '../../src/lib/learning/waypointQuestion'

const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-key', model: 'fixture', compatibility: 'featherless' as const }

describe('layered native-protocol controls', () => {
  it.each([
    { name: 'English-answer', file: 'question-authoring-comprehension.txt', examples: englishExamples.examples },
    { name: 'Mandarin-reply', file: 'question-authoring-reply.txt', examples: replyExamples.examples },
  ])('validates complete $name demonstrations and their rendered tool submissions', ({ name, file, examples }) => {
    const guidance = readFileSync(`tests/evaluation/examples/${file}`, 'utf8')
    expect(guidance.trim().length).toBeLessThanOrEqual(4000)
    for (const [index, example] of examples.entries()) {
      const input = waypointLessonInputSchema.strip().parse(example.context)
      validateLessonBrief(input)
      const graph = validateLessonGraph(example.context.graph, input)
      const phase = example.context.phase
      if (phase !== 'practice' && phase !== 'check') throw new Error('Invalid example phase')
      const context = { ...example.context, ...input, graph, phase }
      const schema = lessonStages.buildQuestion.schema(context)
      const tool = { type: 'function' as const, function: { name: 'build_question_answers', parameters: z.toJSONSchema(schema) } }
      const rendered = guidance.split(`Example ${index + 1} output:\n`)[1]!.split('\n\nExample ')[0]!.trim()
      const decoded = decodeQwenTool(rendered, [tool])!
      const args = schema.parse(JSON.parse(decoded.function.arguments))
      expect(args).toEqual(example.arguments)
      if (name === 'Mandarin-reply') expect(args).not.toHaveProperty('passage')
      const candidate = args
      const gap = validateGap(example.context.gap, graph, input)
      expect(() => validateWaypointQuestion(questionFromWaypoint(candidate, gap, graph, input), gap.cardId, input, phase)).not.toThrow()
    }
  })
  it('reuses all twelve validated transfer lessons without giving the planner a proposed answer', () => {
    const ids = protocolCaseIds.filter(id => id.startsWith('planning-transfer/'))
    expect(ids).toHaveLength(12)
    for (const id of ids) {
      const planning = protocolCase(id)
      const authoring = protocolCase(id.replace('planning-transfer/', 'authoring-transfer/') as typeof id)
      const planned = parseToolContext(planning.messages[1]!.content!)
      const authored = parseToolContext(authoring.messages[1]!.content!)
      expect(authored.gap.waypointIds).toHaveLength(1)
      expect(authored).not.toHaveProperty('proposedDirections')
      expect(planned.graph).toEqual(authored.graph)
      expect(planned.targets).toEqual(authored.targets)
      expect(planned.remainingWaypointIds).toContain(authored.gap.waypointIds[0])
      expect(planning.tool.function.name).toBe('list_missing_questions')
      expect(planning.expected).toEqual({})
      expect(planning.messages.map(m => m.role)).toEqual(['system', 'user'])
    }
  })
  it.each(['question-review-answer-mode', 'question-review-answer-mode-scenario'] as const)('keeps %s unlabeled and in its original format', async id => {
    const control = protocolCase(id)
    const context = parseToolContext(control.messages[1]!.content!)
    expect(context.settings.quizLevel).toBe(id === 'question-review-answer-mode' ? 'meaningPinyin' : 'meaningHanzi')
    expect(context.kind).toBe(id === 'question-review-answer-mode' ? 'topic' : 'scenario')
    expect(context.visibleQuestion.choices).toHaveLength(4)
    expect(Boolean(context.visibleQuestion.passagePinyin)).toBe(context.settings.quizLevel.endsWith('Pinyin'))
    expect(control.messages.map(message => message.content).join('\n')).toContain('English answers')
    expect(Object.keys(control.tool.function.parameters.properties as object)).toEqual(['decision', 'reason'])
    expect(control.expected).toEqual({})
    const result = await runProtocolControl(control.id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false, transport: protocolFixture })
    expect(result).toMatchObject({ contractAccepted: true, hasDeclaredExpectation: false, expectedFieldsMatch: null })
  })

  it('replays the captured planning-length context with unchanged limits and no semantic labels', async () => {
    const control = protocolCase('question-plan-directions-length')
    const context = parseToolContext(control.messages[1]!.content!)
    const { generationMode: _mode, ...expectedContext } = directionsFailure.context
    const { generationMode: _compiledMode, ...projected } = context
    const { learnerRequest: _frame, remainingWaypointIds: _remaining, ...evidence } = projected
    expect(evidence).toEqual(expectedContext)
    expect(control.tool.function.name).toBe('list_missing_questions')
    expect(Object.keys(control.tool.function.parameters.properties as object)).toEqual(['waypointId', 'cardId', 'directions'])
    expect(control.schema.safeParse({ waypointId: 'w2', cardId: context.targets[0].cardId, directions: 'x'.repeat(1601) }).success).toBe(false)
    expect(control.schema.safeParse({ waypointId: 'w2', cardId: context.targets[0].cardId, directions: 'x'.repeat(1600) }).success).toBe(true)
    expect(control.expected).toEqual({})
    expect(await runProtocolControl(control.id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false, transport: protocolFixture })).toMatchObject({ contractAccepted: true, expectedFieldsMatch: null, hasDeclaredExpectation: false })
  })

  it('changes only one field description in the tool and rendered description', async () => {
    const options = { provider, responseMode: 'stream' as const, toolChoice: 'named' as const, thinking: false, footerFormat: 'qwen_xml' as const, transport: protocolFixture }
    const baseline = await runProtocolControl('question-build-english-stem', options)
    const baselineDescription = (baseline.request.tools[0]!.function.parameters.properties as Record<string, { description: string }>).stem!.description
    const candidateDescription = 'English only; put all Chinese quotations in passage.'
    const candidate = await runProtocolControl('question-build-english-stem', { ...options,
      fieldDescription: { field: 'stem', baselineDescription, candidateDescription } })
    const restored = structuredClone(candidate.request)
    const properties = restored.tools[0]!.function.parameters.properties as Record<string, { description: string }>
    properties.stem!.description = baselineDescription
    for (const message of restored.messages) message.content = message.content!.replaceAll(candidateDescription, baselineDescription)
    expect(restored).toEqual(baseline.request)
    expect(candidate.request.messages[0]!.content).toContain(candidateDescription)
    expect(candidate.request.messages[1]).toEqual(baseline.request.messages[1])
    expect(parseToolContext(candidate.request.messages[1]!.content!)).toEqual(parseToolContext(baseline.request.messages[1]!.content!))
  })
  it('rejects unknown or stale field-description experiments before transport', async () => {
    const transport = vi.fn(protocolFixture)
    for (const field of ['missing', 'stem']) await expect(runProtocolControl('question-build-english-stem', {
      provider, responseMode: 'stream', toolChoice: 'named', thinking: false, transport,
      fieldDescription: { field, baselineDescription: 'Stale description', candidateDescription: 'Candidate' },
    })).rejects.toThrow('existing baseline description')
    expect(transport).not.toHaveBeenCalled()
  })
  it('rejects the recorded Mandarin quotations in English stems before review', () => {
    const control = protocolCase('question-build-english-stem')
    expect(stemFailure.failedAuthoringCalls).toHaveLength(5)
    for (const { call } of stemFailure.failedAuthoringCalls) {
      const { waypointIds: _ids, cardId: _card, intent: _intent, whyMissing: _why, ...value } = JSON.parse(call.response.toolCalls[0].function.arguments)
      expect(() => control.validate!(value)).toThrow('Lesson instructions must be in English')
    }
  })
  it('preserves rejection of both actual malformed reading tool submissions', () => {
    const control = protocolCase('question-build-format-repair')
    expect(formatFailure.failedCalls).toHaveLength(2)
    for (const call of formatFailure.failedCalls) {
      expect(call.diagnostic.finishReason).toBe('stop')
      expect(call.diagnostic.usage.completionTokens).toBeLessThan(4096)
      expect(() => decodeQwenTool(call.wireContent.text, [control.tool], {
        normalizeParameterNameQuotes: true, allowAssistantPrefix: true,
      })).toThrow(/complete tool\/function block|complete parameter blocks/)
    }
  })
  it('replays the actual transfer-planning context without supplying semantic gold labels', async () => {
    const control = protocolCase('question-plan-preserve-meaning')
    const context = parseToolContext(control.messages[1]!.content!)
    expect(context.phase).toBe('check')
    expect(context.currentQuestions).toEqual([])
    expect(context.practiceQuestions.length).toBeGreaterThan(0)
    expect(context.targets.some((target: any) => target.hanzi === '不要加糖')).toBe(true)
    expect(control.tool.function.name).toBe('list_missing_questions')
    expect(Object.keys(control.tool.function.parameters.properties as object)).toEqual(['waypointId', 'cardId', 'directions'])
    expect(control.expected).toEqual({})
    const result = await runProtocolControl(control.id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false, transport: protocolFixture })
    expect(result).toMatchObject({ contractAccepted: true, expectedFieldsMatch: null, hasDeclaredExpectation: false })
  })
  it('distinguishes an initial event from reasoning or tool output latency', async () => {
    let elapsed = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    try {
      const result = await runProtocolControl('probe', { provider, responseMode: 'stream', toolChoice: 'named', thinking: true,
        transport: async request => {
          elapsed = 10; request.handlers?.onWireEvent?.({ choices: [] })
          elapsed = 20; request.handlers?.onReasoning?.('Thinking')
          elapsed = 30; request.handlers?.onWireEvent?.({ choices: [{ delta: { tool_calls: [{ index: 0 }] } }] })
          elapsed = 40
          return protocolFixture(request)
        } })
      expect(result.latency).toEqual({ firstEventMs: 10, firstOutputMs: 20 })
      expect(result.durationMs).toBe(40)
    } finally { clock.mockRestore() }
  })
  it('leaves response latency unknown when transport fails before any event', async () => {
    const result = await runProtocolControl('probe', { provider, responseMode: 'stream', toolChoice: 'named', thinking: false,
      transport: async () => { throw new Error('Disconnected before response') } })
    expect(result.latency).toEqual({ firstEventMs: null, firstOutputMs: null })
    expect(result.responseReceived).toBe(false)
  })
  it('records contextual distractor overcredit as label disagreement despite a valid schema', async () => {
    const control = protocolCase('coverage-situation-overcredit'), context = parseToolContext(control.messages[1]!.content!)
    expect(context.question.passage).toBe('谢谢')
    expect(context.graph.waypoints.find((point: any) => point.id === 'w2').objective).toContain('Recognize 对不起')
    expect(control.expected).toEqual({ waypointIds: ['w1'] })
    const result = await runProtocolControl(control.id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false,
      transport: async request => {
        const response = await protocolFixture(request)
        response.toolCalls[0]!.function.arguments = JSON.stringify({ waypointIds: ['w1', 'w2'], assessment: 'Injected overcredit.' })
        return response
      } })
    expect(result).toMatchObject({ contractAccepted: true, expectedFieldsMatch: false })
  })
  it('keeps coverage-length acceptance separate from unknown semantic labels', async () => {
    const control = protocolCase('coverage-assessment-length')
    expect(control.expected).toEqual({})
    const context = parseToolContext(control.messages[1]!.content!)
    expect(context.settings.quizLevel).toBe('responseHanzi')
    expect(context.question).not.toHaveProperty('correctOptionId')
    const result = await runProtocolControl(control.id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false,
      transport: async request => {
        const response = await protocolFixture(request)
        response.toolCalls[0]!.function.arguments = JSON.stringify({ waypointIds: ['w2'], assessment: 'x'.repeat(1001) })
        return response
      } })
    expect(result).toMatchObject({ responseReceived: true, contractAccepted: false, expectedFieldsMatch: null,
      hasDeclaredExpectation: false, failure: { category: 'schema_invalid' } })
  })
  it('preserves the failed reviewer candidate and requires a complete bounded reason', async () => {
    const control = protocolCase('question-review-reason-limit'), context = parseToolContext(control.messages[1]!.content!)
    expect(context.candidate.passage).toBe('请给我一杯茶。不要加糖。')
    expect(context.validationIssue).toContain('simple permits at most 1')
    const result = await runProtocolControl(control.id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false,
      transport: async request => {
        const response = await protocolFixture(request)
        response.toolCalls[0]!.function.arguments = JSON.stringify({ decision: 'revise', reason: 'x'.repeat(1001) })
        return response
      } })
    expect(result).toMatchObject({ responseReceived: true, contractAccepted: false, failure: { category: 'schema_invalid' } })
  })
  it('keeps the independent reading-leak control in its original English-answer format', () => {
    const control = protocolCase('question-review-reading-leak'), context = parseToolContext(control.messages[1]!.content!)
    expect(context.settings.quizLevel).toBe('meaningHanzi')
    expect(context.candidate.stem).toBe('What is the reason given for putting paper in the recycling bin?')
    expect(control.expected).toEqual({ decision: 'revise' })
  })
  it('keeps the duplicate control visible question, target and coverage coherent', () => {
    const original = parseToolContext(protocolCase('question-review-novelty').messages[1]!.content!)
    const duplicate = parseToolContext(protocolCase('question-review-duplicate').messages[1]!.content!)
    expect(duplicate.candidate).toEqual(original.candidate)
    expect(duplicate.currentQuestions).toEqual([{ ...original.currentQuestions[0], cardId: duplicate.gap.cardId,
      stem: original.candidate.stem, passage: original.candidate.passage }])
    const previous = duplicate.currentQuestions[0]
    const target = duplicate.targets.find((target: any) => target.cardId === previous.cardId)
    expect(previous.passage).toContain(target.hanzi)
    expect(duplicate.coverage).toHaveLength(1)
    for (const citation of duplicate.coverage) {
      expect(citation.questionIds).toEqual([previous.id])
      expect(duplicate.graph.waypoints.find((point: any) => point.id === citation.waypointId).cardIds).toContain(previous.cardId)
    }
    expect(protocolCase('question-review-duplicate').expected).toEqual({ decision: 'revise' })
  })
  it('preserves the novelty failure context without inventing prior answer choices', () => {
    const context = parseToolContext(protocolCase('question-review-novelty').messages[1]!.content!)
    expect(context.candidate.passage).toBe('谢谢')
    expect(context.currentQuestions[0].passage).toBe('对不起')
    expect(context.currentQuestions[0].stem).toBe(context.candidate.stem)
    expect(context.currentQuestions[0]).not.toHaveProperty('options')
    expect(context.currentQuestions[0]).not.toHaveProperty('correct')
  })
  it('pairs novelty guidance with an English-only answer-leak rejection control', async () => {
    const positive = protocolCase('question-review-novelty'), negative = protocolCase('question-review-key-leak')
    const visible = parseToolContext(positive.messages[1]!.content!), leaked = parseToolContext(negative.messages[1]!.content!)
    expect(leaked.candidate).toEqual({ ...visible.candidate, stem: 'Which situation involves expressing gratitude for help received?' })
    expect(leaked.visibleQuestion.prompt).toContain(leaked.candidate.stem)
    expect(leaked.visibleQuestion.prompt).not.toBe(visible.visibleQuestion.prompt)
    expect(negative.expected).toEqual({ decision: 'revise' })
    const result = await runProtocolControl('question-review-key-leak', { provider, responseMode: 'stream', toolChoice: 'named', thinking: false,
      transport: async request => {
        const response = await protocolFixture(request)
        response.toolCalls[0]!.function.arguments = JSON.stringify({ decision: 'accept', reason: 'Injected false accept.' })
        return response
      } })
    expect(result.contractAccepted).toBe(true)
    expect(result.expectedFieldsMatch).toBe(false)
  })
  it.each(['coverage-apology', 'coverage-thanks', 'coverage-reply-apology', 'coverage-reply-thanks'] as const)(
    'projects %s as a pending question, excluding its identity from accepted questions', id => {
      const control = protocolCase(id), context = parseToolContext(control.messages[1]!.content!)
      expect(context.currentQuestions.some((q: any) => q.id === context.question.id)).toBe(false)
    })
  it.each(frozen.malformedSubmissions)('replays captured name quoting without changing argument values or bypassing reference checks', text => {
    const control = protocolCase('waypoint-add-stage')
    expect(() => decodeQwenTool(text, [control.tool])).toThrow('extra double quote')
    const call = decodeQwenTool(text, [control.tool], { normalizeParameterNameQuotes: true })!
    const args = parseStageSubmission({ content: '', reasoning: '', finishReason: 'stop', toolCalls: [call] }, control.tool.function.name, control.schema, control.validate) as any
    expect(args.cardIds).toEqual([frozen.context.targets[1]!.cardId])
    expect(args.exampleHanzi).toBe('对不起')
    expect(args.exampleMeaning).toBe('sorry')
    // Only the label quote is removed; the authored explanation remains literal wire data.
    expect(text).toContain(args.explanation)
  })
  it('varies only the schema footer when comparing native and template hints', async () => {
    const shared = { provider, responseMode: 'stream' as const, toolChoice: 'named' as const, thinking: false, transport: protocolFixture }
    const native = await runProtocolControl('graph-stage', { ...shared, footerFormat: 'native' })
    const template = await runProtocolControl('graph-stage', { ...shared, footerFormat: 'qwen_xml' })
    expect(template.request.messages[0]).toEqual(native.request.messages[0])
    expect(template.request.tools).toEqual(native.request.tools)
    expect(template.request.messages[1]!.content!.split('\n\nTool call:')[0]).toEqual(native.request.messages[1]!.content!.split('\n\nTool call:')[0])
    expect(template.request.messages[1]!.content).toContain('<tool_call><function=verify_lesson_graph>')
  })
  it('records explicit template acceptance separately from native wire fields', async () => {
    const text = '<tool_call><function=record_probe><parameter=ack>True</parameter></function></tool_call>'
    const result = await runProtocolControl('probe', { provider, responseMode: 'complete', toolChoice: 'named', thinking: false,
      toolResponseDialect: 'qwen_xml', transport: request => streamChat({ ...request,
        fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })) }) })
    expect(result).toMatchObject({ contractAccepted: true, nativeContractAccepted: false, representation: 'qwen_xml',
      expectedFieldsMatch: true, wireEvidence: { parserSawNativeFields: true, nativeFields: [] } })
  })
  it('replays production function-opening normalization only when declared, preserving arguments', async () => {
    const content = '<tool_call>function=record_probe><parameter=ack>True</parameter></function></tool_call>'
    const transport = (request: Parameters<typeof streamChat>[0]) => streamChat({ ...request,
      fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] })) })
    const shared = { provider, responseMode: 'complete' as const, toolChoice: 'named' as const,
      thinking: false, toolResponseDialect: 'qwen_xml' as const, transport }
    const strict = await runProtocolControl('probe', shared)
    const adapted = await runProtocolControl('probe', { ...shared, normalizeFunctionOpening: true })
    expect(strict).toMatchObject({ normalizeFunctionOpening: false, contractAccepted: false })
    expect(adapted).toMatchObject({ normalizeFunctionOpening: true, contractAccepted: true,
      nativeContractAccepted: false, expectedFieldsMatch: true, representation: 'qwen_xml' })
    expect(adapted.response!.toolCalls[0]!.function.arguments).toBe('{"ack":true}')
    expect(adapted.response!.toolProtocol!.rawContent).toBe(content)
    expect(adapted.response!.toolProtocol!.normalizations).toContain('function_opening_angle:record_probe')
    expect({ ...adapted.request, normalizeFunctionOpening: undefined }).toEqual(strict.request)
  })
  it('changes only system guidance in a focused guidance control', async () => {
    const baseline = await runProtocolControl('graph-stage', { provider, responseMode: 'stream', toolChoice: 'named', thinking: false, transport: protocolFixture })
    const candidate = await runProtocolControl('graph-stage', { provider, responseMode: 'stream', toolChoice: 'named', thinking: false, modelGuidance: 'Experimental guidance.', transport: protocolFixture })
    expect(candidate.request.messages.slice(1)).toEqual(baseline.request.messages.slice(1))
    expect(candidate.request.tools).toEqual(baseline.request.tools)
    expect(candidate.request.messages[0]!.content).toBe(baseline.request.messages[0]!.content + '\n\nModel guidance:\nExperimental guidance.')
  })
  it.each(protocolCaseIds)('keeps %s contract acceptance separate from expected field agreement', async id => {
    const result = await runProtocolControl(id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false, transport: protocolFixture })
    expect(result.contractAccepted).toBe(true)
    expect(result.expectedFieldsMatch).toBe(Object.keys(protocolCase(id).expected).length ? true : null)
    expect(result.wireEvidence.parserSawNativeFields).toBeNull()
    expect(JSON.stringify(result)).not.toContain(provider.apiKey)
  })
  it('fails the control when a valid envelope contains the wrong review decision', async () => {
    const result = await runProtocolControl('graph-schema', { provider, responseMode: 'stream', toolChoice: 'named', thinking: false,
      transport: async request => {
        const response = await protocolFixture(request)
        response.toolCalls[0]!.function.arguments = JSON.stringify({ decision: 'accept', reason: 'Wrong declared decision.' })
        return response
      } })
    expect(result.contractAccepted).toBe(true)
    expect(result.expectedFieldsMatch).toBe(false)
  })
  it('records an empty final output as a failed inference control', async () => {
    const result = await runProtocolControl('probe', { provider, responseMode: 'stream', toolChoice: 'required', thinking: false,
      transport: async () => ({ content: '', reasoning: '', toolCalls: [], finishReason: 'stop', model: 'fixture' }) })
    expect(result).toMatchObject({ responseReceived: true, contractAccepted: false, expectedFieldsMatch: null,
      hasDeclaredExpectation: true,
      failure: { category: 'empty_output' } })
  })
  it.each(['stream', 'complete'] as const)('compares wire native fields with parsed calls in %s mode', async responseMode => {
    const control = protocolCase('probe')
    const call = { id: 'call1', type: 'function', function: { name: control.tool.function.name, arguments: '{"ack":true}' } }
    const body = responseMode === 'stream'
      ? `data: ${JSON.stringify({ model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ ...call, index: 0 }] }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify({ model: 'fixture', choices: [{ index: 0, message: { content: null, tool_calls: [call] }, finish_reason: 'stop' }] })
    const result = await runProtocolControl('probe', { provider, responseMode, toolChoice: 'named', thinking: false,
      transport: request => streamChat({ ...request, fetcher: async () => new Response(body) }) })
    expect(result.contractAccepted).toBe(true)
    expect(result.wireEvidence.parserSawNativeFields).toBe(true)
    expect(result.diagnostic?.parserStatus).toBe('complete')
    expect(result.wireEvidence.nativeFields).toHaveLength(1)
  })
})
