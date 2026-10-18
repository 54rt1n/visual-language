import { describe, expect, it } from 'vitest'
import { qwenToolEnvelope } from '../../src/lib/ai/qwenToolEnvelope'
import { decodeQwenTool } from '../../src/lib/ai/qwenToolProtocol'
import type { ToolDefinition } from '../../src/lib/ai/types'
import prefaced from '../evaluation/focused-cases/qwen-reading-prefaced-calls.json'

describe('explicit prefaced Qwen envelope recognition', () => {
  it.each(prefaced.rows)('separates captured assistant content without changing the tool arguments: $requestHash', row => {
    const raw = row.capturedCall.response.content, tools = row.capturedCall.request.tools as ToolDefinition[]
    expect(qwenToolEnvelope(raw)).toBeUndefined()
    const envelope = qwenToolEnvelope(raw, true)!
    expect(envelope.prefix).toBe(row.prefix)
    expect(envelope.toolText).toBe(row.completeToolBlock)
    expect(decodeQwenTool(envelope.toolText, tools)).toEqual(decodeQwenTool(row.completeToolBlock, tools))
  })
  it('does not treat arbitrary prose or JSON echoes as a call', () => {
    expect(qwenToolEnvelope('A narrative answer.', true)).toBeUndefined()
    expect(qwenToolEnvelope('{"name":"record_probe","arguments":{"ack":true}}', true)).toBeUndefined()
  })
  it('rejects fenced examples, prior tool markup and oversized responses', () => {
    expect(() => qwenToolEnvelope('```xml\n<tool_call></tool_call>```', true)).toThrow('fenced examples')
    expect(() => qwenToolEnvelope('<function=other>text</function><tool_call></tool_call>', true)).toThrow('other tool-template markup')
    expect(() => qwenToolEnvelope('x'.repeat(32_000) + '<tool_call></tool_call>', true)).toThrow('response exceeds')
  })
  it('leaves trailing prose, multiple calls and unknown functions for strict body rejection', () => {
    const tools: ToolDefinition[] = [{ type: 'function', function: { name: 'record_probe', description: 'Probe',
      parameters: { type: 'object', properties: { ack: { type: 'boolean' } } } } }]
    const block = '<tool_call><function=record_probe><parameter=ack>true</parameter></function></tool_call>'
    for (const raw of ['Prefix. ' + block + ' Trailing prose.', 'Prefix. ' + block + block, 'Prefix. ' + block.replace('record_probe', 'unavailable')]) {
      expect(() => decodeQwenTool(qwenToolEnvelope(raw, true)!.toolText, tools)).toThrow()
    }
  })
})
