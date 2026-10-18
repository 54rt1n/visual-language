import { describe, expect, it, vi } from 'vitest'
import { listProviderModels } from '../../src/lib/ai/models'

const config = { provider: 'custom' as const, baseUrl: 'https://catalog.example/v1', apiKey: 'catalog-private-key' }
describe('explicit provider model discovery', () => {
  it('returns bounded IDs only, without accepting provider-supplied endpoint or key authority', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [
      { id: 'qwen3.8-max', baseUrl: 'https://untrusted.example', apiKey: 'not-authority' },
      { id: 'qwen3.8-flash' }, { id: 'qwen3.8-max' }, { id: config.apiKey },
      { id: 'bad\nid' }, { id: 'x'.repeat(201) }, null, {},
    ] }))
    const result = await listProviderModels(config, '', undefined, fetcher)
    expect(result).toEqual({ ids: ['qwen3.8-flash', 'qwen3.8-max'], partial: true })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, request] = fetcher.mock.calls[0]!
    expect(url).toBe('https://catalog.example/v1/models')
    expect(request).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer catalog-private-key' } })
    expect(request).not.toHaveProperty('body')
    expect(JSON.stringify(result)).not.toMatch(/private|authority|untrusted/)
  })
  it('bounds Featherless catalog pages and supports explicit search on the official endpoint only', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'Qwen/Qwen3.6-27B' }] }))
    const result = await listProviderModels({ ...config, provider: 'featherless', baseUrl: 'https://api.featherless.ai/v1/' }, 'Qwen3.6', undefined, fetcher)
    const url = new URL(fetcher.mock.calls[0]![0] as string)
    expect(Object.fromEntries(url.searchParams)).toEqual({ per_page: '1000', available_on_current_plan: 'true', q: 'Qwen3.6' })
    expect(result.partial).toBe(true)
    await listProviderModels({ ...config, provider: 'featherless' }, 'private query', undefined, fetcher)
    expect(fetcher.mock.calls[1]![0]).toBe('https://catalog.example/v1/models')
  })
  it.each([404, 405, 401, 429])('reports HTTP %s without displaying the raw error body', async status => {
    await expect(listProviderModels(config, '', undefined, async () => new Response(config.apiKey, { status }))).rejects.not.toThrow(config.apiKey)
    if (status === 404) await expect(listProviderModels(config, '', undefined, async () => new Response('', { status }))).rejects.toThrow('manually')
  })
  it('rejects malformed, empty or oversized lists without leaking response data', async () => {
    for (const response of [new Response('{bad'), Response.json({ data: [] }), Response.json({ data: 'private metadata' }), Response.json({ data: new Array(20_001).fill({ id: 'x' }) }), new Response('x'.repeat(4_000_001))]) {
      await expect(listProviderModels(config, '', undefined, async () => response)).rejects.toThrow()
    }
  })
  it('does not send an already-aborted request or follow an unsafe endpoint', async () => {
    const controller = new AbortController(); controller.abort()
    const fetcher = vi.fn<typeof fetch>()
    await expect(listProviderModels(config, '', controller.signal, fetcher)).rejects.toMatchObject({ name: 'AbortError' })
    await expect(listProviderModels({ ...config, baseUrl: 'https://secret@example.com' }, '', undefined, fetcher)).rejects.toThrow('HTTPS endpoint')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
