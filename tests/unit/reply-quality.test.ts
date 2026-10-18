import { describe, expect, it } from 'vitest'
import { unusableReplyReason } from '../../src/lib/ai/replyQuality'
import { messagesFromGraph } from '../../src/lib/ai/context'

describe('obvious unusable-reply detection', () => {
  it('distinguishes completed empty replies and repetition loops from short or meaningful text', () => {
    expect(unusableReplyReason('   ')).toBeUndefined()
    expect(unusableReplyReason('   ', true)).toContain('no readable reply')
    expect(unusableReplyReason('!'.repeat(48))).toBeUndefined()
    expect(unusableReplyReason('!'.repeat(48), true)).toContain('repeated symbols')
    expect(unusableReplyReason('！'.repeat(80))).toContain('repeated symbols')
    expect(unusableReplyReason('hello '.repeat(80))).toContain('repeating itself')
    expect(unusableReplyReason('请稍等'.repeat(100))).toContain('repeating itself')
    for (const text of ['！', '你好！', '哈哈哈，很高兴认识你。', '好好学习，天天向上。', '谢谢！谢谢！谢谢！', '你好 — hello.', '1, 2, 3, 4, 5', 'Use ! for an exclamation. ' + '-'.repeat(80), '你好。'.repeat(8)]) expect(unusableReplyReason(text, true), text).toBeUndefined()
  })
  it('omits obvious legacy assistant loops from outgoing history, without rewriting graph data or user text', () => {
    const noise = '!'.repeat(100), nodes = [
      { id: 'root', type: 'root', data: {} }, { id: 'user', type: 'user', data: { text: noise } },
      { id: 'bad', type: 'assistant', data: { text: noise, state: 'complete' } },
      { id: 'followup', type: 'user', data: { text: 'Try again in readable Mandarin.' } },
    ], edges = [{ id: 'a', source: 'root', target: 'user' }, { id: 'b', source: 'user', target: 'bad' }, { id: 'c', source: 'bad', target: 'followup' }]
    const before = structuredClone(nodes), messages = messagesFromGraph('followup', nodes, edges)
    expect(messages.filter(message => message.role === 'assistant')).toEqual([])
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([noise, 'Try again in readable Mandarin.'])
    expect(nodes).toEqual(before)
    nodes[2]!.data = { text: 'A useful partial explanation.', state: 'interrupted' }
    expect(messagesFromGraph('followup', nodes, edges).some(message => message.role === 'assistant' && message.content === 'A useful partial explanation.')).toBe(true)
  })
})
