import { describe, expect, it, vi } from 'vitest'
import { SearchResultCache, SEARCH_CACHE_LIMITS } from '../../src/lib/search/resultCache'
import { searchCacheKey, searchWeb, type SearchCache } from '../../src/lib/search/tavily'
import { NOW } from './fixtures'

const result = (key: string, expiresAt = NOW + 1000, excerpt = 'A retained Mandarin example.'): SearchCache => ({ key, expiresAt, sources: [{ id: `source-${key}`, kind: 'web', title: key, url: `https://example.org/${key}`, excerpt, retrievedAt: NOW }] })
const bytes = (value: SearchCache) => new TextEncoder().encode(JSON.stringify(value)).byteLength
describe('bounded disposable search results', () => {
  it('evicts least-recently-used entries under the entry limit without touching frozen source copies', () => {
    const cache = new SearchResultCache({ maxEntries: 2, maxBytes: 4096 }), a = result('a'), frozen = structuredClone(a.sources)
    cache.set(a, NOW); cache.set(result('b'), NOW); expect(cache.get('a', NOW)).toEqual(a)
    cache.set(result('c'), NOW)
    expect(cache.get('b', NOW)).toBeUndefined(); expect(cache.get('a', NOW)).toEqual(a)
    expect(cache.stats(NOW).entries).toBe(2); expect(a.sources).toEqual(frozen)
    const returned = cache.get('a', NOW)!; returned.sources[0]!.excerpt = 'Changed caller data'
    a.sources[0]!.excerpt = 'Changed insertion data'
    expect(cache.get('a', NOW)!.sources).toEqual(frozen)
    cache.clear(); expect(cache.stats(NOW)).toEqual({ entries: 0, bytes: 0 }); expect(frozen[0]!.excerpt).toBe('A retained Mandarin example.')
  })
  it('counts UTF-8 payload bytes and refuses an oversized replacement rather than serving the old refreshed value', () => {
    const a = result('a', NOW + 1000, '谢谢'.repeat(20)), limit = bytes(a)
    const cache = new SearchResultCache({ maxEntries: 50, maxBytes: limit })
    expect(limit).toBeGreaterThan(JSON.stringify(a).length)
    expect(cache.set(a, NOW)).toBe(true); expect(cache.stats(NOW)).toEqual({ entries: 1, bytes: limit })
    const b = result('b'); expect(cache.set(b, NOW)).toBe(true)
    expect(cache.get('a', NOW)).toBeUndefined(); expect(cache.stats(NOW).bytes).toBe(bytes(b))
    expect(cache.set(result('b', NOW + 1000, '字'.repeat(1000)), NOW)).toBe(false)
    expect(cache.get('b', NOW)).toBeUndefined(); expect(cache.stats(NOW)).toEqual({ entries: 0, bytes: 0 })
  })
  it('expires at the exact boundary and accounts for replacement bytes without background work', () => {
    const cache = new SearchResultCache(), a = result('a')
    cache.set(a, NOW); cache.set(result('b', NOW + 2000), NOW)
    expect(cache.get('a', NOW + 999)).toEqual(a)
    expect(cache.get('a', NOW + 1000)).toBeUndefined(); expect(cache.stats(NOW + 1000).entries).toBe(1)
    const updated = result('b', NOW + 3000, 'A longer refreshed description.'); cache.set(updated, NOW + 1000)
    expect(cache.stats(NOW + 1000)).toEqual({ entries: 1, bytes: bytes(updated) })
    expect(cache.set(result('expired', NOW), NOW + 1000)).toBe(false)
    expect(cache.set(result('invalid', Infinity), NOW)).toBe(false)
    expect(cache.stats(NOW + 3000)).toEqual({ entries: 0, bytes: 0 })
    expect(() => new SearchResultCache({ maxEntries: 0, maxBytes: 100 })).toThrow('positive')
  })
  it('retains 24-hour/general and 15-minute/news policy while explicit refresh creates new source versions', async () => {
    const cache = new SearchResultCache(), input = { query: 'Mandarin café phrase', purpose: 'Fixture learning search' }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: 'Example', url: 'https://example.org/phrase', content: 'A public Mandarin example.' }] })))
    const first = await searchWeb(input, { apiKey: 'fixture', fetcher, now: () => NOW }); cache.set(first, NOW)
    const savedSources = structuredClone(first.sources)
    const again = await searchWeb(input, { apiKey: 'fixture', fetcher, now: () => NOW + 1 }, cache.get(searchCacheKey(input), NOW + 1))
    expect(again).toEqual(first); expect(fetcher).toHaveBeenCalledTimes(1)
    const refreshed = await searchWeb(input, { apiKey: 'fixture', fetcher, now: () => NOW + 2 }, cache.get(first.key, NOW + 2), true); cache.set(refreshed, NOW + 2)
    expect(refreshed.sources[0]!.id).not.toBe(first.sources[0]!.id); expect(first.sources).toEqual(savedSources)
    expect(cache.get(first.key, NOW + 86_400_002)).toBeUndefined()
    const news = await searchWeb({ ...input, current: true }, { apiKey: 'fixture', fetcher, now: () => NOW }); cache.set(news, NOW)
    expect(cache.get(news.key, NOW + 899_999)).toEqual(news); expect(cache.get(news.key, NOW + 900_000)).toBeUndefined()
  })
  it('keeps a long browsing session inside both declared limits', () => {
    const cache = new SearchResultCache()
    for (let i = 0; i < 1000; i++) {
      cache.set(result(`query-${i}`, NOW + 1000, '学'.repeat(3000)), NOW)
      const stats = cache.stats(NOW)
      expect(stats.entries).toBeLessThanOrEqual(SEARCH_CACHE_LIMITS.maxEntries)
      expect(stats.bytes).toBeLessThanOrEqual(SEARCH_CACHE_LIMITS.maxBytes)
    }
    expect(cache.get('query-0', NOW)).toBeUndefined()
    expect(cache.get('query-999', NOW)).toBeDefined()
  })
})
