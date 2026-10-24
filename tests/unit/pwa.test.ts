import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function workerFixture() {
  const handlers = new Map<string, (event: unknown) => void>(), records = new Map<string, Map<string, Response>>()
  const prefix = 'visual-language-shell:%2Fvisual-language%2F:', name = `${prefix}new`
  const added: Request[] = [], deleted: string[] = []
  let failInstall = false
  const caches = {
    async open(key: string) {
      if (!records.has(key)) records.set(key, new Map())
      return {
        async addAll(requests: Request[]) { if (failInstall) throw new Error('Fixture cache quota failure'); for (const r of requests) { added.push(r); records.get(key)!.set(r.url, new Response(`cached:${r.url}`)) } },
        async match(url: string) { return records.get(key)!.get(url)?.clone() },
        async keys() { return [...records.get(key)!.keys()].map(url => new Request(url)) },
      }
    },
    async keys() { return [...records.keys()] },
    async has(key: string) { return records.has(key) },
    async delete(key: string) { deleted.push(key); return records.delete(key) },
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('network')), skipWaiting = vi.fn(), claim = vi.fn()
  const self = { registration: { scope: 'https://example.org/visual-language/', active: { state: 'activated' } }, skipWaiting, clients: { claim }, addEventListener(type: string, callback: (event: unknown) => void) { handlers.set(type, callback) } }
  runInNewContext(readFileSync('scripts/service-worker.js', 'utf8'), { self, caches, fetch, Request, Response, URL, AbortController, setTimeout, clearTimeout, __BUILD_VERSION__: 'new', __SHELL_FILES__: ['index.html', 'assets/app.js', 'icons/app-192.png'] })
  async function lifecycle(type: string) { let pending: Promise<unknown> | undefined; handlers.get(type)!({ waitUntil(value: Promise<unknown>) { pending = value } }); await pending }
  async function request(url: string, options?: RequestInit, navigation = false) {
    const request = new Request(url, options)
    if (navigation) Object.defineProperty(request, 'mode', { value: 'navigate' })
    let result: Promise<Response> | undefined
    handlers.get('fetch')!({ request, respondWith(value: Promise<Response>) { result = value } }); return result
  }
  async function status() {
    let result: unknown, pending: Promise<unknown> | undefined
    handlers.get('message')!({ data: { type: 'SHELL_STATUS' }, ports: [{ postMessage(value: unknown) { result = value } }], waitUntil(value: Promise<unknown>) { pending = value } })
    await pending; return result
  }
  return { handlers, records, prefix, name, added, deleted, fetch, skipWaiting, claim, lifecycle, request, status, fail: () => { failInstall = true } }
}

describe('strict app-shell worker policy', () => {
  it('caches only the immutable inventory with credentials omitted and never forces activation', async () => {
    const h = workerFixture()
    await h.lifecycle('install'); await h.lifecycle('activate')
    expect(h.added.map(r => r.url)).toEqual(['https://example.org/visual-language/index.html', 'https://example.org/visual-language/assets/app.js', 'https://example.org/visual-language/icons/app-192.png'])
    expect(h.added.every(r => r.credentials === 'omit')).toBe(true)
    expect(await (await h.request('https://example.org/visual-language/assets/app.js'))!.text()).toContain('cached:')
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.skipWaiting).not.toHaveBeenCalled(); expect(h.claim).not.toHaveBeenCalled()
  })
  it('does not intercept external APIs, arbitrary URLs, queries, non-GET or auth requests', async () => {
    const h = workerFixture(); await h.lifecycle('install')
    for (const url of ['https://api.tavily.com/search', 'https://api.featherless.ai/v1/chat/completions', 'https://example.org/other/assets/app.js', 'https://example.org/visual-language/private.json', 'https://example.org/visual-language/assets/app.js?key=private']) expect(await h.request(url)).toBeUndefined()
    expect(await h.request('https://example.org/visual-language/assets/app.js', { method: 'POST' })).toBeUndefined()
    expect(await h.request('https://example.org/visual-language/assets/app.js', { headers: { Authorization: 'Bearer test' } })).toBeUndefined()
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it('retains one previous shell and never removes sibling-app caches or databases', async () => {
    const h = workerFixture()
    for (const key of [`${h.prefix}older`, 'unrelated-cache', 'visual-language-shell:%2Fsibling%2F:version', `${h.prefix}previous`]) h.records.set(key, new Map())
    await h.lifecycle('install'); await h.lifecycle('activate')
    expect(h.deleted).toEqual([`${h.prefix}older`])
    expect([...h.records.keys()]).toContain('unrelated-cache')
    expect([...h.records.keys()]).toContain(`${h.prefix}previous`)
  })
  it('failed installation removes only the newly attempted shell, preserving the previous one', async () => {
    const h = workerFixture(); h.records.set(`${h.prefix}previous`, new Map()); h.fail()
    await expect(h.lifecycle('install')).rejects.toThrow('quota')
    expect(h.deleted).toEqual([h.name]); expect(h.records.has(`${h.prefix}previous`)).toBe(true)
  })
  it('a failed reinstall of the same build preserves its existing offline shell', async () => {
    const h = workerFixture(); await h.lifecycle('install')
    h.fail()
    await expect(h.lifecycle('install')).rejects.toThrow('quota')
    expect(h.deleted).toEqual([])
    expect(await (await h.request('https://example.org/visual-language/assets/app.js'))!.text()).toContain('cached:')
    expect(h.fetch).not.toHaveBeenCalled()
  })
  it('reports its own cached build readiness rather than another active worker state', async () => {
    const h = workerFixture()
    expect(await h.status()).toEqual({ version: 'new', ready: false })
    await h.lifecycle('install')
    expect(await h.status()).toEqual({ version: 'new', ready: true })
    h.records.get(h.name)!.delete('https://example.org/visual-language/assets/app.js')
    expect(await h.status()).toEqual({ version: 'new', ready: false })
  })
  it('loads current HTML on navigation while preserving the cached offline generation', async () => {
    const h = workerFixture(); await h.lifecycle('install')
    expect(await (await h.request('https://example.org/visual-language/', undefined, true))!.text()).toBe('network')
    expect((h.fetch.mock.calls[0]![0] as Request).cache).toBe('no-store')
    expect(await (await h.request('https://example.org/visual-language/index.html'))!.text()).toContain('cached:')
  })
  it.each(['offline', 'unavailable', 'timeout'])('uses saved HTML when the navigation is %s', async failure => {
    vi.useFakeTimers()
    try {
      const h = workerFixture(); await h.lifecycle('install')
      if (failure === 'offline') h.fetch.mockRejectedValue(new Error('Offline'))
      else if (failure === 'unavailable') h.fetch.mockResolvedValue(new Response('Unavailable', { status: 503 }))
      else h.fetch.mockImplementation(async input => new Promise((_resolve, reject) => {
        (input as Request).signal.addEventListener('abort', () => { reject(new Error('Aborted')) }, { once: true })
      }))
      const pending = h.request('https://example.org/visual-language/', undefined, true)
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(3000)
      expect(await (await pending)!.text()).toContain('cached:https://example.org/visual-language/index.html')
    } finally { vi.useRealTimers() }
  })
})
