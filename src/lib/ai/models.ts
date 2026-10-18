import { z } from 'zod'
import { boundedJsonResponse, normalizeEndpoint, requestSignal, responseError } from './http'
import type { resolveProviderAccess } from '../settings'
import { providerHeaders } from './providers'

const modelEnvelope = z.object({ data: z.array(z.unknown()).max(20_000) })
export type ModelList = { ids: string[]; partial: boolean }

/** One explicit, bounded catalog request. No prompt, workspace or returned URL
 * is sent/followed. The response supplies IDs only, never endpoint/key authority.
 */
export async function listProviderModels(config: ReturnType<typeof resolveProviderAccess>, query = '', signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ModelList> {
  const endpoint = normalizeEndpoint(config.baseUrl), url = new URL(`${endpoint}/models`)
  const featherless = endpoint === 'https://api.featherless.ai/v1'
  if (featherless) {
    url.searchParams.set('per_page', '1000')
    url.searchParams.set('available_on_current_plan', 'true')
    if (query.trim()) url.searchParams.set('q', query.trim().slice(0, 100))
  }
  const lifetime = requestSignal(signal, 20_000)
  try {
    lifetime.signal.throwIfAborted()
    const response = await fetcher(url.href, { method: 'GET', credentials: 'omit', redirect: 'error', headers: { ...providerHeaders(config.apiKey, config.compatibility), Accept: 'application/json' }, signal: lifetime.signal })
    if (response.status === 404 || response.status === 405) throw new Error('This endpoint did not provide a model list. You can still enter a model ID manually and test it.')
    if (!response.ok) throw responseError(response.status)
    const parsed = modelEnvelope.safeParse(await boundedJsonResponse(response, lifetime.signal, 4_000_000))
    if (!parsed.success) throw new Error('The endpoint returned an unsupported model-list format. Enter a model ID manually.')
    const ids: string[] = []
    for (const entry of parsed.data.data) {
      if (!entry || typeof entry !== 'object' || !('id' in entry)) continue
      const id = entry.id
      if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\s\p{C}]/u.test(id) || (config.apiKey.length >= 8 && id.includes(config.apiKey))) continue
      ids.push(id)
    }
    const unique = [...new Set(ids)].sort((a, b) => a.localeCompare(b))
    if (!unique.length) throw new Error('The provider returned no usable model IDs for this request. Change the search or enter an ID manually.')
    return { ids: unique, partial: featherless || unique.length < parsed.data.data.length }
  } finally { lifetime.dispose() }
}
