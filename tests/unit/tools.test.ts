import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ActionBudget, defineTool, runToolLoop, ToolDispatcher } from '../../src/lib/ai/tools'
import type { ToolCall } from '../../src/lib/ai/types'
import { InputValidationError } from '../../src/lib/domain/validation'
const call = (id = 'call-1', name = 'draft', args = '{"text":"hello"}'): ToolCall => ({ id, type: 'function', function: { name, arguments: args } })

describe('bounded native tool execution', () => {
  it('retains MiniMax reasoning alongside correlated tools in the next request', async () => {
    const budget = new ActionBudget()
    const transport = vi.fn().mockResolvedValueOnce({ content: '', reasoning: 'Choose draft.', toolCalls: [call()], finishReason: 'tool_calls', model: 'm' })
      .mockResolvedValueOnce({ content: 'Done', reasoning: '', toolCalls: [], finishReason: 'stop', model: 'm' })
    try {
      await runToolLoop({ baseUrl: 'https://api.example/v1', apiKey: 'key', model: 'm', compatibility: 'minimax', messages: [], budget, transport,
        applicationTools: [defineTool('draft', 'draft', z.strictObject({ text: z.string() }), async () => 'saved')] })
      expect(transport.mock.calls[1]![0].messages[0]).toMatchObject({ role: 'assistant', reasoning_content: 'Choose draft.', tool_calls: [call()] })
      expect(transport.mock.calls[1]![0].messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
    } finally { budget.dispose() }
  })
  it('returns authored correction details but hides infrastructure exceptions', async () => {
    const budget = new ActionBudget()
    try {
      for (const [error, exposed] of [[new InputValidationError('Use English in stem.'), true], [new Error('database credential private'), false]] as const) {
        const dispatcher = new ToolDispatcher([defineTool('draft', 'draft', z.strictObject({ text: z.string() }), async () => { throw error })], budget)
        const result = JSON.parse(await dispatcher.dispatch(call()))
        expect(result.ok).toBe(false)
        expect(JSON.stringify(result).includes(error.message)).toBe(exposed)
        if (exposed) expect(result.correction).toContain('complete corrected tool arguments')
      }
    } finally { budget.dispose() }
  })
  it('keeps a required drafting tool on repair and stops immediately after success', async () => {
    const budget = new ActionBudget(), choice = { type: 'function' as const, function: { name: 'draft' } }
    let saved = false
    const transport = vi.fn().mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [call('bad')], finishReason: 'tool_calls', model: 'm' })
      .mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [call('fixed')], finishReason: 'tool_calls', model: 'm' })
    try {
      await runToolLoop({ baseUrl: 'https://api.example/v1', apiKey: '', model: 'm', messages: [], budget, transport,
        toolChoice: choice, continuationToolChoice: choice, complete: () => saved,
        applicationTools: [defineTool('draft', 'draft', z.strictObject({ text: z.string() }), async (_, id) => {
          if (id === 'bad') throw new InputValidationError('Correct the stem.')
          saved = true; return 'saved'
        })] })
      expect(transport).toHaveBeenCalledTimes(2)
      expect(transport.mock.calls[1]![0].toolChoice).toEqual(choice)
      expect(transport.mock.calls[1]![0].messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'bad', content: expect.stringContaining('Correct the stem.') }))
    } finally { budget.dispose() }
  })
  it('validates before dispatch and rejects unknown tools', async () => {
    const execute = vi.fn(async () => 'saved'), budget = new ActionBudget()
    try {
      const dispatcher = new ToolDispatcher([defineTool('draft', 'draft text', z.strictObject({ text: z.string() }), execute)], budget)
      expect(JSON.parse(await dispatcher.dispatch(call('1', 'unknown'))).ok).toBe(false)
      expect(JSON.parse(await dispatcher.dispatch(call('2', 'draft', '{"box":5}'))).ok).toBe(false)
      expect(execute).not.toHaveBeenCalled()
      expect(JSON.parse(await dispatcher.dispatch(call())).ok).toBe(true)
    } finally { budget.dispose() }
  })
  it('deduplicates concurrent/replayed call IDs, but rejects changed arguments', async () => {
    const execute = vi.fn(async () => 'once'), budget = new ActionBudget()
    try {
      const dispatcher = new ToolDispatcher([defineTool('draft', 'draft', z.strictObject({ text: z.string() }), execute)], budget)
      const results = await Promise.all([dispatcher.dispatch(call()), dispatcher.dispatch(call())])
      expect(results[0]).toEqual(results[1]); expect(execute).toHaveBeenCalledOnce()
      await expect(dispatcher.dispatch(call('call-1', 'draft', '{"text":"changed"}'))).rejects.toThrow('changed')
    } finally { budget.dispose() }
  })
  it('returns correlated tool results to the next model request', async () => {
    const budget = new ActionBudget()
    const transport = vi.fn().mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [call()], finishReason: 'tool_calls', model: 'm' })
      .mockResolvedValueOnce({ content: 'Done', reasoning: '', toolCalls: [], finishReason: 'stop', model: 'm' })
    try {
      const result = await runToolLoop({ baseUrl: 'https://api.example/v1', apiKey: 'private', model: 'm', messages: [], budget, transport,
        applicationTools: [defineTool('draft', 'draft', z.strictObject({ text: z.string() }), async () => ({ draftId: 'd1' }))] })
      expect(result.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
      expect(JSON.stringify(result.messages)).not.toContain('private')
      expect(budget.used('model')).toBe(2)
    } finally { budget.dispose() }
  })
  it('stops after four model requests even if the model keeps calling tools', async () => {
    const budget = new ActionBudget()
    const transport = vi.fn(async () => ({ content: '', reasoning: '', toolCalls: [call()], finishReason: 'tool_calls', model: 'm' }))
    try {
      await expect(runToolLoop({ baseUrl: 'https://api.example/v1', apiKey: '', model: 'm', messages: [], budget, transport,
        applicationTools: [defineTool('draft', 'draft', z.strictObject({ text: z.string() }), async () => 'ok')] })).rejects.toThrow('budget is exhausted')
      expect(transport).toHaveBeenCalledTimes(4)
    } finally { budget.dispose() }
  })
})
