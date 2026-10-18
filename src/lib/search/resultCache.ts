import type { SearchCache } from './tavily'

export const SEARCH_CACHE_LIMITS = { maxEntries: 50, maxBytes: 512 * 1024 } as const

/** Disposable normalized results only. Budgets count UTF-8 serialized payload,
 * not total JS heap. This cache has no repository or scheduling authority. */
export class SearchResultCache {
  private entries = new Map<string, { value: SearchCache; bytes: number }>()
  private bytes = 0
  private limits: { maxEntries: number; maxBytes: number }
  constructor(limits: { maxEntries: number; maxBytes: number } = SEARCH_CACHE_LIMITS) {
    if (!Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Search cache limits must be positive integers.')
    this.limits = { ...limits }
  }
  private remove(key: string) {
    const entry = this.entries.get(key)
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key) }
  }
  private expire(now: number) {
    for (const [key, entry] of this.entries) if (entry.value.expiresAt <= now) this.remove(key)
  }
  get(key: string, now = Date.now()): SearchCache | undefined {
    this.expire(now)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key); this.entries.set(key, entry) // Most recently used.
    return structuredClone(entry.value)
  }
  set(value: SearchCache, now = Date.now()): boolean {
    this.expire(now); this.remove(value.key)
    if (!Number.isFinite(value.expiresAt) || value.expiresAt <= now) return false
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (bytes > this.limits.maxBytes) return false
    while (this.entries.size >= this.limits.maxEntries || this.bytes + bytes > this.limits.maxBytes) this.remove(this.entries.keys().next().value!)
    this.entries.set(value.key, { value: structuredClone(value), bytes }); this.bytes += bytes
    return true
  }
  stats(now = Date.now()) { this.expire(now); return { entries: this.entries.size, bytes: this.bytes } }
  clear() { this.entries.clear(); this.bytes = 0 }
}
