import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/mandarin/readingModelManifest.json', () => ({ default: { version: 'test', directory: 'reading-model/test/', bytes: 3, files: [{ file: 'model.onnx', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }] } }))
import { createReadingModelCache } from '../../src/lib/mandarin/readingModelCache'

describe('optional pronunciation resource integrity and ownership', () => {
  let stores: Map<string, Map<string, Response>>, request: ReturnType<typeof vi.fn>
  beforeEach(() => {
    stores = new Map()
    vi.stubGlobal('caches', {
      has: async (name: string) => stores.has(name),
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        const data = stores.get(name) ?? new Map<string, Response>(); stores.set(name, data)
        return { match: async (key: string) => data.get(key)?.clone(), put: async (key: string, value: Response) => { data.set(key, value.clone()) }, delete: async (key: string) => data.delete(key) }
      },
    })
    request = vi.fn(async () => new Response('abc')); vi.stubGlobal('fetch', request)
  })
  afterEach(() => vi.unstubAllGlobals())
  it('does not download on a presence check; installation is explicit and verified bytes are reused', async () => {
    const cache = createReadingModelCache('https://example.org/course/')
    expect(await cache.installed()).toBe(false); expect(request).not.toHaveBeenCalled(); expect(stores.size).toBe(0)
    await cache.install(new AbortController().signal, () => {})
    expect(await cache.installed()).toBe(true)
    expect(new TextDecoder().decode(await cache.asset('model.onnx'))).toBe('abc')
    expect(request).toHaveBeenCalledWith('https://example.org/course/reading-model/test/model.onnx', expect.objectContaining({ credentials: 'omit', redirect: 'error', cache: 'no-store' }))
    await cache.install(new AbortController().signal, () => {})
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(['bad', 'ab', 'abcd'])('never marks corrupt or mis-sized bytes installed: %s', async value => {
    request.mockImplementation(async () => new Response(value))
    const cache = createReadingModelCache('https://example.org/course/')
    await expect(cache.install(new AbortController().signal, () => {})).rejects.toThrow()
    expect(await cache.installed()).toBe(false)
  })
  it('checks cached bytes again before execution and repairs corruption only after another explicit install', async () => {
    const cache = createReadingModelCache('https://example.org/course/')
    await cache.install(new AbortController().signal, () => {})
    stores.values().next().value!.set('https://example.org/course/reading-model/test/model.onnx', new Response('bad'))
    await expect(cache.asset('model.onnx')).rejects.toThrow('integrity')
    expect(request).toHaveBeenCalledTimes(1)
    await cache.install(new AbortController().signal, () => {})
    expect(new TextDecoder().decode(await cache.asset('model.onnx'))).toBe('abc')
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('cancellation cannot leave an installed marker', async () => {
    const cache = createReadingModelCache('https://example.org/course/'), controller = new AbortController()
    await expect(cache.install(controller.signal, () => controller.abort())).rejects.toThrow()
    expect(await cache.installed()).toBe(false)
  })
  it('removes only this base/version resource, never another app or its required shell', async () => {
    const ours = createReadingModelCache('https://example.org/course/'), theirs = createReadingModelCache('https://example.org/another/')
    stores.set('visual-language-shell:unrelated', new Map())
    await ours.install(new AbortController().signal, () => {}); await theirs.install(new AbortController().signal, () => {})
    await ours.remove()
    expect(await ours.installed()).toBe(false); expect(await theirs.installed()).toBe(true)
    expect(stores.has('visual-language-shell:unrelated')).toBe(true)
    await expect(ours.asset('../secrets')).rejects.toThrow('Unknown')
  })
})
