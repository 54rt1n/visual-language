import { describe, expect, it, vi } from 'vitest'
import { lessonWorkflowBudget } from '../../src/lib/teacher/lessonGeneration/workflowBudget'
import type { ChatOptions } from '../../src/lib/ai/types'

const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture' }
const request: ChatOptions = { ...provider, messages: [{ role: 'user', content: 'Prepare a point.' }], maxTokens: 4096 }
describe('whole preparation budget', () => {
  it('rejects insufficient token reservations before dispatch', async () => {
    const transport = vi.fn(async () => { throw new Error('Do not dispatch') })
    const budget = lessonWorkflowBudget({ provider, transport }, { maxReservedTokens: 1 })
    try { await expect(budget.transport(request)).rejects.toMatchObject({ failure: { category: 'budget_exhausted' } }); expect(transport).not.toHaveBeenCalled() }
    finally { budget.dispose() }
  })
  it('cancels outstanding transport at the whole-run deadline', async () => {
    vi.useFakeTimers()
    const budget = lessonWorkflowBudget({ provider, transport: async options => new Promise((_resolve, reject) => {
      options.handlers!.signal!.addEventListener('abort', () => reject(options.handlers!.signal!.reason), { once: true })
    }) }, { timeoutMs: 5 })
    try {
      const result = expect(budget.transport(request)).rejects.toMatchObject({ failure: {
        category: 'budget_exhausted', layer: 'budget', retryable: false, checkpointId: 'lesson-workflow',
      } })
      await vi.advanceTimersByTimeAsync(6); await result
    } finally { budget.dispose(); vi.useRealTimers() }
  })
})
