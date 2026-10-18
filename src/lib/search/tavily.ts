import { z } from 'zod'
import { boundedJsonResponse, publicSourceUrl, requestSignal, responseError } from '../ai/http'
import { nid } from '../id'

export const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(300),
  purpose: z.string().trim().min(1).max(300),
  domains: z.array(z.string().regex(/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/i)).max(5).optional(),
  current: z.boolean().optional(),
})
export const extractInputSchema = z.strictObject({ sourceIds: z.array(z.string().min(1).max(200)).min(1).max(2) })
export type SearchInput = z.infer<typeof searchInputSchema>
export type SourceSnapshot = {
  id: string; kind: 'web' | 'local'; title: string; url?: string; excerpt: string
  retrievedAt: number; publishedAt?: string; query?: string; nodeId?: string; cardId?: string
  adapted?: boolean
}
export type SearchCache = { key: string; expiresAt: number; sources: SourceSnapshot[] }
export type TavilyOptions = { apiKey: string; signal?: AbortSignal; fetcher?: typeof fetch; now?: () => number; onRequest?: () => () => void }

const rawSource = z.object({
  title: z.string().max(2000).optional(), url: z.string().max(4000),
  content: z.string().max(100_000).optional(), raw_content: z.string().max(500_000).nullable().optional(),
  published_date: z.string().max(100).optional(),
})

async function request(endpoint: 'search' | 'extract', body: unknown, options: TavilyOptions): Promise<unknown> {
  const lifetime = requestSignal(options.signal, 30_000)
  let finish: (() => void) | undefined
  try {
    if (!options.apiKey.trim()) throw new Error('Add a Tavily key in Settings.')
    lifetime.signal.throwIfAborted()
    finish = options.onRequest?.() // Includes bounded body consumption, not just response headers.
    const response = await (options.fetcher ?? fetch)(`https://api.tavily.com/${endpoint}`, {
      method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: lifetime.signal,
    })
    if (!response.ok) throw responseError(response.status)
    return await boundedJsonResponse(response, lifetime.signal)
  } finally { lifetime.dispose(); finish?.() }
}

export function searchCacheKey(input: SearchInput): string {
  return JSON.stringify({ query: input.query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(), domains: [...(input.domains ?? [])].sort(), current: Boolean(input.current) })
}

export async function searchWeb(input: SearchInput, options: TavilyOptions, cache?: SearchCache, refresh = false): Promise<SearchCache> {
  input = searchInputSchema.parse(input)
  const now = (options.now ?? Date.now)()
  const key = searchCacheKey(input)
  options.signal?.throwIfAborted()
  if (!refresh && cache?.key === key && cache.expiresAt > now) return structuredClone(cache)
  const raw = z.object({ results: z.array(rawSource).max(20) }).parse(await request('search', {
    query: input.query, search_depth: 'basic', max_results: 5, include_answer: false,
    include_raw_content: false, auto_parameters: false, include_images: false,
    topic: input.current ? 'news' : 'general', ...(input.domains?.length ? { include_domains: input.domains } : {}),
  }, options))
  const sources: SourceSnapshot[] = []
  const seen = new Set<string>()
  for (const result of raw.results.slice(0, 5)) {
    let url: string
    try { url = publicSourceUrl(result.url) } catch { continue }
    if (seen.has(url) || !result.content?.trim()) continue
    seen.add(url)
    sources.push({ id: nid('source'), kind: 'web', title: (result.title || new URL(url).hostname).slice(0, 200), url,
      excerpt: result.content.slice(0, 500), retrievedAt: now, query: input.query,
      ...(result.published_date ? { publishedAt: result.published_date } : {}) })
  }
  return { key, expiresAt: now + (input.current ? 15 * 60_000 : 24 * 60 * 60_000), sources }
}

/** The action supplies only its returned search sources; the model cannot invent a URL. */
export async function extractSources(ids: string[], allowed: SourceSnapshot[], options: TavilyOptions): Promise<{ sources: SourceSnapshot[]; failedIds: string[] }> {
  extractInputSchema.parse({ sourceIds: ids })
  if (new Set(ids).size !== ids.length) throw new Error('Choose distinct source IDs.')
  const selected = ids.map(id => {
    const source = allowed.find(s => s.id === id && s.kind === 'web' && s.url)
    if (!source?.url) throw new Error('Extraction is limited to this action’s search results.')
    return { ...source, url: publicSourceUrl(source.url) }
  })
  const raw = z.object({ results: z.array(rawSource).max(10), failed_results: z.array(z.unknown()).optional() })
    .parse(await request('extract', { urls: selected.map(s => s.url), extract_depth: 'basic', format: 'text', include_images: false }, options))
  const sources: SourceSnapshot[] = [], failedIds: string[] = []
  for (const source of selected) {
    const result = raw.results.find(r => { try { return publicSourceUrl(r.url) === source.url } catch { return false } })
    const excerpt = (result?.raw_content || result?.content)?.trim().slice(0, 2000)
    if (!excerpt) { failedIds.push(source.id); continue }
    // A new snapshot ID prevents extraction from modifying an already-frozen quiz source.
    sources.push({ ...source, id: nid('source'), excerpt, retrievedAt: (options.now ?? Date.now)() })
  }
  return { sources, failedIds }
}
