import { describe, expect, it, vi } from 'vitest'
import { enforceContextBudget } from '../../src/lib/ai/contextBudget'
import { executeLessonStage } from '../../src/lib/teacher/lessonGeneration/executeStage'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import type { ChatOptions } from '../../src/lib/ai/types'

const request: ChatOptions = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture',
  messages: [{ role: 'user', content: '请给我一杯茶。' }], maxTokens: 4096 }
describe('lesson context and output capacity', () => {
  it('labels the local tokenizer estimate and preserves the complete request', async () => {
    const original = structuredClone(request)
    expect(await enforceContextBudget(request)).toMatchObject({ method: 'tiktoken_estimate', encoding: 'cl100k_base', outputReserveTokens: 4096, totalLimitTokens: 32768 })
    expect(request).toEqual(original)
  })
  it('allows normal English context larger than 32KB while blocking genuinely oversized tokenized input', async () => {
    const english = 'I am learning Chinese with practical examples. '.repeat(800)
    expect(new TextEncoder().encode(english).length).toBeGreaterThan(32768)
    expect(await enforceContextBudget({ ...request, messages: [{ role: 'user', content: english }] })).toMatchObject({ method: 'tiktoken_estimate' })
    await expect(enforceContextBudget({ ...request, messages: [{ role: 'user', content: '一杯茶。'.repeat(10000) }] })).rejects.toMatchObject({ failure: { category: 'budget_exhausted' } })
  })
  it('verifies a possible Featherless overflow with its model tokenizer before rejecting', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{"token_count":7000}'))
    const evidence = await enforceContextBudget({ ...request, baseUrl: 'https://api.featherless.ai/v1', compatibility: 'featherless',
      messages: [{ role: 'user', content: '一杯茶。'.repeat(10000) }], fetcher })
    expect(evidence).toMatchObject({ method: 'tokenizer', inputTokens: 7000 })
    expect(evidence.encoding).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe('https://api.featherless.ai/debug/chat-format')
  })
  it('uses exact tokenizer counts, including the output reserve at the boundary', async () => {
    expect(await enforceContextBudget(request, async () => 28672)).toMatchObject({ method: 'tokenizer', inputTokens: 28672 })
    await expect(enforceContextBudget(request, async () => 28673)).rejects.toMatchObject({ failure: { category: 'budget_exhausted' } })
    await expect(enforceContextBudget(request, async () => NaN)).rejects.toMatchObject({ failure: { category: 'protocol_error' } })
  })
  it('stops an oversized assembled lesson locally before inference or retry', async () => {
    const transport = vi.fn(async () => { throw new Error('Must not dispatch') })
    const context = { kind: 'topic' as const, settings: { quizLevel: 'meaningHanzi' as const, complexity: 'phrases' as const,
      scope: 'everyday' as const, focus: 'characters' as const, topic: 'Courtesy' }, graph: { overview: '', waypoints: [] }, sourceEvidence: '一杯茶。'.repeat(10000) }
    await expect(executeLessonStage({ provider: request, transport }, lessonStages.reviewGraph, context)).rejects.toMatchObject({
      failure: { category: 'budget_exhausted', stage: 'reviewGraph' },
    })
    expect(transport).not.toHaveBeenCalled()
  })
})
