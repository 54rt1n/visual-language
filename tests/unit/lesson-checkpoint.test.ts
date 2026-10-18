import { describe, expect, it, vi } from 'vitest'
import { commitLessonCheckpoint } from '../../src/lib/teacher/lessonGeneration/checkpoint'

describe('lesson checkpoint commits', () => {
  it('reports an acknowledged durable write before a requested cancellation', async () => {
    const controller = new AbortController(), commits: unknown[] = []
    await expect(commitLessonCheckpoint({ point: 'saved' }, async () => { controller.abort() }, controller.signal, 'graph-draft',
      event => { commits.push(event) })).rejects.toMatchObject({ name: 'AbortError' })
    expect(commits).toEqual([expect.objectContaining({ checkpointId: 'graph-draft', persisted: true, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })])
  })
  it('does not report a failed write as committed', async () => {
    const observed = vi.fn()
    await expect(commitLessonCheckpoint({}, async () => { throw new Error('Write failed') }, undefined, 'graph-draft', observed)).rejects.toMatchObject({ failure: { category: 'persistence_error' } })
    expect(observed).not.toHaveBeenCalled()
  })
  it('awaits the write and isolates persisted values from later mutation', async () => {
    const original = { candidate: { explanation: 'Accepted content' } }
    const write = vi.fn(async (value: typeof original) => { value.candidate.explanation = 'Writer mutation' })
    await commitLessonCheckpoint(original, write, undefined, 'graph-draft')
    expect(write).toHaveBeenCalledOnce()
    expect(original.candidate.explanation).toBe('Accepted content')
  })
  it('preserves the cause and classifies a failed write without retrying it', async () => {
    const cause = new Error('Disk is full')
    const write = vi.fn(async () => { throw cause })
    await expect(commitLessonCheckpoint({}, write, undefined, 'practice-quiz')).rejects.toMatchObject({
      failure: { category: 'persistence_error', layer: 'persistence', checkpointId: 'practice-quiz', retryable: false }, cause,
    })
    expect(write).toHaveBeenCalledOnce()
  })
  it('does not write after cancellation or misclassify it as persistence failure', async () => {
    const controller = new AbortController(), write = vi.fn(async () => {})
    controller.abort()
    await expect(commitLessonCheckpoint({}, write, controller.signal, 'graph-draft')).rejects.toMatchObject({ name: 'AbortError' })
    expect(write).not.toHaveBeenCalled()
  })
})
