import { describe, expect, it } from 'vitest'
import { ProviderRequestQueue } from '../../src/lib/ai/requestQueue'
import { streamChat } from '../../src/lib/ai/client'

const account = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture' }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('provider account request queue', () => {
  it('serializes one account while separate credentials and endpoints can run', async () => {
    const queue = new ProviderRequestQueue(), first = deferred(), order: string[] = []
    const a = queue.run(account, undefined, async () => { order.push('a'); await first.promise })
    const b = queue.run({ ...account, baseUrl: account.baseUrl + '/' }, undefined, async () => { order.push('b') })
    await Promise.all([
      queue.run({ ...account, apiKey: 'other-fixture' }, undefined, async () => { order.push('other-key') }),
      queue.run({ ...account, baseUrl: 'https://other.invalid/v1' }, undefined, async () => { order.push('other-endpoint') }),
    ])
    expect(order).toEqual(['a', 'other-key', 'other-endpoint'])
    first.resolve(); await Promise.all([a, b])
    expect(order.at(-1)).toBe('b')
  })

  it('cancels a queued caller promptly without letting later work overlap the active request', async () => {
    const queue = new ProviderRequestQueue(), first = deferred(), controller = new AbortController(), order: string[] = []
    const a = queue.run(account, undefined, async () => { order.push('a'); await first.promise })
    const b = queue.run(account, controller.signal, async () => { order.push('b') })
    const c = queue.run(account, undefined, async () => { order.push('c') })
    const cancelled = expect(b).rejects.toThrow('Cancelled')
    controller.abort(new DOMException('Cancelled', 'AbortError')); await cancelled
    expect(order).toEqual(['a'])
    first.resolve(); await Promise.all([a, c])
    expect(order).toEqual(['a', 'c'])
  })

  it('releases the account after rejection', async () => {
    const queue = new ProviderRequestQueue()
    const a = queue.run(account, undefined, async () => { throw new Error('Provider unavailable') })
    const b = queue.run(account, undefined, async () => 'next')
    await expect(a).rejects.toThrow('Provider unavailable')
    expect(await b).toBe('next')
  })

  it('holds the slot until an active cancelled request finishes cleanup', async () => {
    const queue = new ProviderRequestQueue(), cleanup = deferred(), entered = deferred(), controller = new AbortController()
    const order: string[] = []
    const a = queue.run(account, controller.signal, async () => { entered.resolve(); await cleanup.promise })
    await entered.promise
    const b = queue.run(account, undefined, async () => { order.push('next') })
    const cancelled = expect(a).rejects.toThrow('Cancelled')
    controller.abort(new DOMException('Cancelled', 'AbortError')); await cancelled
    expect(order).toEqual([])
    cleanup.resolve(); await b
    expect(order).toEqual(['next'])
  })

  it('serializes actual client calls across model IDs through complete response consumption', async () => {
    const first = deferred(), entered = deferred(), seen: string[] = []
    const config = { ...account, messages: [{ role: 'user' as const, content: 'Hello' }], responseMode: 'complete' as const }
    const fetcher: typeof fetch = async (_url, init) => {
      const { model } = JSON.parse(String(init?.body)); seen.push(model)
      if (model === 'first') { entered.resolve(); await first.promise }
      return Response.json({ model, choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] })
    }
    const a = streamChat({ ...config, model: 'first', fetcher })
    await entered.promise
    const b = streamChat({ ...config, model: 'second', fetcher })
    await Promise.resolve()
    expect(seen).toEqual(['first'])
    first.resolve(); await Promise.all([a, b])
    expect(seen).toEqual(['first', 'second'])
  })
})
