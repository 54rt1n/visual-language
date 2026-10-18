import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { decodeQwenTool } from '../../src/lib/ai/qwenToolProtocol'
import { streamChat } from '../../src/lib/ai/client'
import { parseStageSubmission } from '../../src/lib/teacher/lessonGeneration/stageSubmission'
import { resolveLessonModelProfile } from '../../src/lib/teacher/lessonGeneration/modelProfiles'
import type { ToolDefinition } from '../../src/lib/ai/types'
import prefaced from '../evaluation/focused-cases/qwen-reading-prefaced-calls.json'
import quotedExpression from '../evaluation/focused-cases/qwen-quoted-expression-text-v11.json'
import missingFunctionAngle from '../evaluation/focused-cases/qwen-missing-function-angle-v21.json'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import { validateGap } from '../../src/lib/teacher/questionGapTools'
import { waypointContext } from '../../src/lib/domain/lessonGraph'
import { questionFromWaypoint, validateWaypointQuestion } from '../../src/lib/learning/waypointQuestion'

const schema = z.strictObject({ ack: z.literal(true), reason: z.string().optional(), ids: z.array(z.string()).optional() })
const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'record_probe', description: 'Diagnostic.', parameters: z.toJSONSchema(schema) } }]
const block = (body = '<parameter=ack>True</parameter>', fn = 'record_probe') => `<tool_call>\n<function=${fn}>\n${body}\n</function>\n</tool_call>`
const config = { baseUrl: 'https://example.com/v1', apiKey: 'fixture', model: 'diagnostic', tools, messages: [{ role: 'user' as const, content: 'Probe' }], responseMode: 'complete' as const }
const fetcher = (content: string, finish_reason = 'stop') => async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }))

describe('explicit missing-function-angle compatibility', () => {
  it.each(missingFunctionAngle.rows)('preserves captured arguments and raw text: $source.callIndex', async row => {
    const offered = row.tools as ToolDefinition[]
    await expect(streamChat({ ...config, tools: offered, toolResponseDialect: 'qwen_xml', fetcher: fetcher(row.rawContent) }))
      .rejects.toMatchObject({ failure: { category: 'arguments_invalid' } })
    const result = await streamChat({ ...config, tools: offered, toolResponseDialect: 'qwen_xml', normalizeFunctionOpening: true, fetcher: fetcher(row.rawContent) })
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual(row.expectedArguments)
    expect(result.toolProtocol).toEqual({ representation: 'qwen_xml', rawContent: row.rawContent,
      normalizations: ['function_opening_angle:solve_english_question'] })
    expect(parseStageSubmission(result, 'solve_english_question', lessonStages.solveEnglishQuestion.schema({} as any))).toEqual(row.expectedArguments)
  })

  const malformed = block().replace('<function=', 'function=')
  it('normalizes a captured terminal SSE response while retaining the original content', async () => {
    const row = missingFunctionAngle.rows[0]!
    const event = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`
    const body = event({ content: row.rawContent }) + event({}, 'stop') + 'data: [DONE]\n\n'
    const result = await streamChat({ ...config, responseMode: 'stream', tools: row.tools as ToolDefinition[], toolResponseDialect: 'qwen_xml',
      normalizeFunctionOpening: true, fetcher: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual(row.expectedArguments)
    expect(result.toolProtocol).toMatchObject({ representation: 'qwen_xml', rawContent: row.rawContent,
      normalizations: ['function_opening_angle:solve_english_question'] })
  })

  it.each([
    malformed.slice(0, -12), malformed + malformed, malformed.replace('record_probe', 'unavailable'),
    malformed.replace('</parameter>', ''), malformed.replace('</function>', ''), malformed + ' extra prose',
    malformed.replace('<parameter=ack>True</parameter>', '<parameter=ack>True</parameter><parameter=ack>True</parameter>'),
    malformed.replace('<parameter=ack>True</parameter>', '<parameter=extra>True</parameter>'),
    malformed.replace('<parameter=ack>True</parameter>', '<parameter=ids>["a"</parameter>'),
  ])('keeps incomplete, ambiguous and invalid submissions rejected: %s', raw => {
    expect(() => decodeQwenTool(raw, tools, { normalizeFunctionOpening: true })).toThrow()
  })

  it('does not alter parameter text or normalize a canonical opening', () => {
    const reason = 'The literal text function=record_probe> is data.'
    const normalizations: string[] = []
    const call = decodeQwenTool(block(`<parameter=ack>True</parameter><parameter=reason>${reason}</parameter>`), tools,
      { normalizeFunctionOpening: true, onFunctionOpeningNormalization: name => { normalizations.push(name) } })!
    expect(JSON.parse(call.function.arguments)).toEqual({ ack: true, reason })
    expect(normalizations).toEqual([])
  })

  it('keeps schema validation mandatory after syntax normalization', () => {
    const call = decodeQwenTool('<tool_call>function=record_probe></function></tool_call>', tools, { normalizeFunctionOpening: true })!
    expect(() => parseStageSubmission({ content: '', toolCalls: [call], finishReason: 'stop' }, 'record_probe', schema)).toThrow()
  })

  it('requires the explicit dialect and keeps the normalization flag off the wire', async () => {
    let body: any
    const transport = async (_url: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return fetcher(malformed)() }
    await expect(streamChat({ ...config, normalizeFunctionOpening: true, fetcher: transport })).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
    expect(body).toBeUndefined()
    await streamChat({ ...config, toolResponseDialect: 'qwen_xml', normalizeFunctionOpening: true, fetcher: transport })
    expect(body).not.toHaveProperty('normalizeFunctionOpening')
  })

  it('retains terminal-completion and output-limit checks', async () => {
    const partial = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: malformed } }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    await expect(streamChat({ ...config, responseMode: 'stream', toolResponseDialect: 'qwen_xml', normalizeFunctionOpening: true, fetcher: partial }))
      .rejects.toMatchObject({ failure: { category: 'stream_incomplete' } })
    await expect(streamChat({ ...config, toolResponseDialect: 'qwen_xml', normalizeFunctionOpening: true, fetcher: fetcher(malformed, 'length') }))
      .rejects.toMatchObject({ failure: { category: 'output_limit' } })
  })
})

describe('captured prefaced reading submissions, offline body replay', () => {
  it.each(prefaced.rows)('adapts prefaced calls only when explicitly selected, retaining content and argument evidence: $requestHash', async row => {
    const selectedTools = row.capturedCall.request.tools as ToolDefinition[], raw = row.capturedCall.response.content
    const strict = await streamChat({ ...config, tools: selectedTools, toolResponseDialect: 'qwen_xml', fetcher: fetcher(raw) })
    expect(strict.toolCalls).toEqual([])
    const adapted = await streamChat({ ...config, tools: selectedTools, toolResponseDialect: 'qwen_xml', allowAssistantPrefix: true, fetcher: fetcher(raw) })
    expect(adapted.toolCalls).toEqual([decodeQwenTool(row.completeToolBlock, selectedTools)])
    expect(adapted.content).toBe(row.prefix)
    expect(adapted.toolProtocol).toEqual({ representation: 'qwen_xml', rawContent: raw })
  })
  it('does not dispatch prefix recognition with a native dialect or send the local flag on the wire', async () => {
    let body: any
    const transport = async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return fetcher('A preface. ' + block())()
    }
    await expect(streamChat({ ...config, allowAssistantPrefix: true, fetcher: transport })).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
    expect(body).toBeUndefined()
    await streamChat({ ...config, allowAssistantPrefix: true, toolResponseDialect: 'qwen_xml', fetcher: transport })
    expect(body).not.toHaveProperty('allowAssistantPrefix')
  })
  it.each(prefaced.rows)('keeps schema/reference validity separate from question validity: $requestHash', row => {
    const context = JSON.parse(row.capturedCall.request.messages.find(m => m.role === 'user')!.content.split('\n\nTool call:\n', 1)[0]!)
    const call = decodeQwenTool(row.completeToolBlock, row.capturedCall.request.tools as ToolDefinition[])!
    // The capture's tool schema is historical; this test checks decoding and text preservation.
    const args: any = JSON.parse(call.function.arguments)
    const { waypointIds, cardId, intent, whyMissing, ...candidate } = args
    const gap = validateGap({ waypointIds, cardId, intent, whyMissing }, context.graph, context)
    const selected = waypointContext(context.graph, waypointIds)
    const focused = { ...context, sources: context.sources.filter((s: any) => selected.some(w => w.sourceIds.includes(s.id))) }
    const validate = () => validateWaypointQuestion(questionFromWaypoint(candidate, gap, context.graph, focused), gap.cardId, focused, context.phase)
    expect(row.capturedCall.failure.category).toBe('tool_missing')
    expect(row.prefix).toContain('select direction')
    if (row.questionConstraintsValid) expect(validate).not.toThrow()
    else expect(validate).toThrow('instructions must be in English')
  })
})

describe('explicit Qwen function-template protocol', () => {
  it('decodes the actual completed question call with quoted-expression feedback without changing its text', () => {
    const captured = quotedExpression.capturedCall
    const selectedTools = captured.request.tools as ToolDefinition[]
    const context = JSON.parse(captured.request.messages.find(m => m.role === 'user')!.content.split('\n\nTool call:\n', 1)[0]!)
    const call = decodeQwenTool(captured.wireContent.text, selectedTools, { allowAssistantPrefix: true })!
    // The capture's tool schema is historical; this test checks decoding and text preservation.
    const args: any = JSON.parse(call.function.arguments)
    expect(args.feedback).toBe('"对不起" is the correct choice because it is used to apologize or express regret, which is appropriate when you are late. "谢谢" is used to express gratitude, which does not fit the context of making up for a delay. "没关系" is a response to an apology, meaning "it\'s okay," and "你好" is a standard greeting.')
    expect(args.correct).toBe('B')
    expect(args.answerB).toBe('对不起')
    const { waypointIds, cardId, intent, whyMissing, ...candidate } = args
    const gap = validateGap({ waypointIds, cardId, intent, whyMissing }, context.graph, context)
    expect(() => validateWaypointQuestion(questionFromWaypoint(candidate, gap, context.graph, context), gap.cardId, context, context.phase))
      .not.toThrow()
  })
  it('preserves full-text string parameters beginning with a quoted expression', () => {
    const reason = '"对不起" is used to apologize. "谢谢" expresses gratitude.'
    const call = decodeQwenTool(block(`<parameter=ack>true</parameter><parameter=reason>${reason}</parameter>`), tools)!
    expect(JSON.parse(call.function.arguments)).toEqual({ ack: true, reason })
    expect(parseStageSubmission({ content: '', reasoning: '', toolCalls: [call], finishReason: 'stop' },
      'record_probe', schema)).toEqual({ ack: true, reason })
  })
  it('still unwraps a completely JSON-encoded string and requires complete parameter boundaries', () => {
    const reason = '"对不起" means sorry.'
    const call = decodeQwenTool(block(`<parameter=ack>true</parameter><parameter=reason>${JSON.stringify(reason)}</parameter>`), tools)!
    expect(JSON.parse(call.function.arguments).reason).toBe(reason)
    expect(() => decodeQwenTool(block('<parameter=ack>true</parameter><parameter=reason>"对不起" is used to apologize.'), tools))
      .toThrow('complete parameter blocks')
    expect(() => decodeQwenTool(block('<parameter=ack>true</parameter><parameter=ids>"a", "b"</parameter>'), tools))
      .toThrow('complete JSON')
  })
  it('diagnoses a malformed parameter separator without accepting it', () => {
    expect(() => decodeQwenTool(block('<parameter>ack>true</parameter>'), tools)).toThrow("uses '>' instead of '='")
  })
  it('diagnoses the captured missing angle bracket without inventing or accepting a function block', () => {
    expect(() => decodeQwenTool('<tool_call>function=record_probe><parameter=ack>true</parameter></function></tool_call>', tools))
      .toThrow("function opening tag is missing its '<' character")
  })
  it('rejects the captured extra-quote syntax with a precise repair instruction', () => {
    expect(() => decodeQwenTool(block('<parameter=ack">True</parameter>'), tools)).toThrow('Copy <parameter=ack> exactly, without quotes')
  })
  it('normalizes only an offered parameter name when explicitly selected, retaining the original wire text', async () => {
    const text = block('<parameter=ack">True</parameter>')
    const adapted = await streamChat({ ...config, toolResponseDialect: 'qwen_xml', normalizeParameterNameQuotes: true, fetcher: fetcher(text) })
    expect(adapted.toolProtocol).toEqual({ representation: 'qwen_xml', rawContent: text, normalizations: ['parameter_name_quote:ack'] })
    expect(parseStageSubmission(adapted, 'record_probe', schema)).toEqual({ ack: true })
    expect(() => decodeQwenTool(block('<parameter=unknown">true</parameter>'), tools, { normalizeParameterNameQuotes: true })).toThrow('offered and distinct')
    expect(() => decodeQwenTool(block('<parameter=ack">true</parameter><parameter=ack>true</parameter>'), tools, { normalizeParameterNameQuotes: true })).toThrow('offered and distinct')
    expect(() => decodeQwenTool('<tool_call><parameter=ack">true</parameter></function></tool_call>', tools, { normalizeParameterNameQuotes: true })).toThrow('complete tool/function')
  })
  it('decodes captured boolean spelling and structured parameters, then validates the offered schema', () => {
    const call = decodeQwenTool(block('<parameter=ack>True</parameter><parameter=reason>Diagnostic verdict.</parameter><parameter=ids>["a","b"]</parameter>'), tools)!
    expect(JSON.parse(call.function.arguments)).toEqual({ ack: true, reason: 'Diagnostic verdict.', ids: ['a', 'b'] })
  })
  it.each(['ordinary prose', '{"ack":true}', '```xml\n' + block() + '\n```', 'Here is the call: ' + block()])('never converts arbitrary text: %s', text => {
    expect(decodeQwenTool(text, tools)).toBeUndefined()
  })
  it.each([block().slice(0, -12), block() + block(), block(undefined, 'unavailable'),
    block('<parameter=ack>true</parameter><parameter=ack>true</parameter>'), block('<parameter=extra>true</parameter>'),
    block('<parameter=ack>maybe</parameter>'), block('<parameter=ids>[incomplete</parameter>'), block() + ' prose'])('rejects malformed or ambiguous submissions', text => {
    expect(() => decodeQwenTool(text, tools)).toThrow('Invalid Qwen')
  })
  it('does not promote schema-invalid values', () => {
    const call = decodeQwenTool(block('<parameter=ack>false</parameter>'), tools)!
    expect(() => parseStageSubmission({ content: '', reasoning: '', toolCalls: [call], finishReason: 'stop' }, 'record_probe', schema)).toThrow()
  })
  it('adapts only when selected and retains the raw representation separately from native diagnostics', async () => {
    const native = await streamChat({ ...config, fetcher: fetcher(block()) })
    expect(native.toolCalls).toEqual([])
    let count: number | undefined
    const adapted = await streamChat({ ...config, toolResponseDialect: 'qwen_xml', fetcher: fetcher(block()), handlers: { onDiagnostic: d => { count = d.nativeToolCalls } } })
    expect(adapted.toolProtocol).toEqual({ representation: 'qwen_xml', rawContent: block() })
    expect(count).toBe(0)
    expect(parseStageSubmission(adapted, 'record_probe', schema)).toEqual({ ack: true })
  })
  it('requires a completed response before adaptation', async () => {
    await expect(streamChat({ ...config, toolResponseDialect: 'qwen_xml', fetcher: fetcher(block(), 'length') })).rejects.toMatchObject({ failure: { category: 'output_limit' } })
  })
  it('selects dialects through validated profiles without model-name inference', () => {
    expect(resolveLessonModelProfile(undefined, 'reviewGraph').protocol.toolResponseDialect).toBe('native')
    expect(resolveLessonModelProfile({ id: 'explicit', version: '1', protocol: { toolResponseDialect: 'qwen_xml' } }, 'reviewGraph').protocol.toolResponseDialect).toBe('qwen_xml')
  })
})
