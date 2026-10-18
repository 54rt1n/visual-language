import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage?: (event: { data: Record<string, unknown> }) => void
  onerror?: () => void
  messages: Record<string, unknown>[] = []
  terminated = false
  constructor() { FakeWorker.instances.push(this) }
  postMessage(message: Record<string, unknown>) { this.messages.push(message) }
  terminate() { this.terminated = true }
  receive(data: Record<string, unknown>) { this.onmessage?.({ data }) }
}
beforeEach(() => {
  vi.resetModules(); FakeWorker.instances = []
  vi.stubGlobal('window', { isSecureContext: true, caches: {} })
  vi.stubGlobal('document', { baseURI: 'https://example.org/course/' })
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('optional pronunciation client lifecycle', () => {
  it('never starts on an insecure device', async () => {
    vi.stubGlobal('window', { isSecureContext: false, caches: {} })
    const client = await import('../../src/lib/mandarin/readingModel')
    client.startReadingModel(); expect(FakeWorker.instances).toHaveLength(0)
    expect(get(client.readingModelState).phase).toBe('unavailable')
  })
  it('contains a worker-construction failure instead of throwing into reader mounting', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker creation blocked') } })
    const client = await import('../../src/lib/mandarin/readingModel')
    expect(() => client.startReadingModel()).not.toThrow()
    expect(get(client.readingModelState).phase).toBe('error')
  })
  it('shares one worker and accepts partial source-bound results until completion', async () => {
    const client = await import('../../src/lib/mandarin/readingModel')
    client.startReadingModel(); client.startReadingModel(); expect(FakeWorker.instances).toHaveLength(1)
    const worker = FakeWorker.instances[0]!, partial = vi.fn()
    worker.receive({ type: 'state', phase: 'ready' })
    const result = client.analyzeReading('还', [{ start: 0, end: 1 }], new AbortController().signal, partial, true)
    const id = worker.messages.at(-1)!.id
    expect(worker.messages.at(-1)).toMatchObject({ type: 'analyze', source: '还', priority: true })
    worker.receive({ type: 'partial', id, results: [{ text: '还', start: 0, end: 1, pinyin: 'huán', confidence: 0.9 }] })
    expect(partial).toHaveBeenCalledOnce(); worker.receive({ type: 'done', id }); await result
  })
  it('ignores a cancelled selection and delayed events from a terminated worker', async () => {
    const client = await import('../../src/lib/mandarin/readingModel')
    client.startReadingModel(); const worker = FakeWorker.instances[0]!, controller = new AbortController(), partial = vi.fn()
    const result = client.analyzeReading('还', [{ start: 0, end: 1 }], controller.signal, partial)
    const id = worker.messages.at(-1)!.id; controller.abort()
    await expect(result).rejects.toThrow('selection changed')
    worker.receive({ type: 'partial', id, results: [] }); expect(partial).not.toHaveBeenCalled()
    client.cancelReadingModelDownload(); expect(worker.terminated).toBe(true)
    worker.receive({ type: 'state', phase: 'ready' }); worker.onerror?.()
    expect(get(client.readingModelState).phase).toBe('checking')
    expect(FakeWorker.instances[1]!.terminated).toBe(false)
  })
  it('restarts a failed runtime only on explicit retry', async () => {
    const client = await import('../../src/lib/mandarin/readingModel')
    client.startReadingModel(); const worker = FakeWorker.instances[0]!
    worker.receive({ type: 'state', phase: 'error', error: 'Corrupt cache' })
    expect(FakeWorker.instances).toHaveLength(1)
    client.downloadReadingModel(); expect(worker.terminated).toBe(true)
    expect(FakeWorker.instances[1]!.messages.map(m => m.type)).toEqual(['init', 'install'])
  })
  it('times out pending work and releases its worker without a stuck promise', async () => {
    vi.useFakeTimers()
    const client = await import('../../src/lib/mandarin/readingModel')
    client.startReadingModel(); const worker = FakeWorker.instances[0]!
    const result = client.analyzeReading('还', [{ start: 0, end: 1 }], new AbortController().signal, () => {})
    const rejected = expect(result).rejects.toThrow('too long')
    await vi.advanceTimersByTimeAsync(90_000); await rejected
    expect(worker.terminated).toBe(true); expect(get(client.readingModelState).phase).toBe('error')
  })
})
