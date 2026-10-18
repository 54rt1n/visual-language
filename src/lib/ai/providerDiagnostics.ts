import type { ProviderStreamError } from './types'

/** Preserve a provider cooldown. Parent stage/run deadlines still bound any wait. */
export function providerRetryAfter(response: Response, now = Date.now()) {
  const raw = response.headers.get('retry-after')?.trim()
  if (!raw) return undefined
  const milliseconds = /^\d+$/.test(raw) ? Number(raw) * 1000
    : /^[A-Za-z]{3},/.test(raw) ? Date.parse(raw) - now : NaN
  return Number.isFinite(milliseconds) ? Math.min(86_400_000, Math.max(0, Math.ceil(milliseconds))) : undefined
}

export function providerRequestId(response: Response) {
  return (response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('x-correlation-id'))?.slice(0, 200) || undefined
}

export function providerErrorFields(value: unknown, key: string): ProviderStreamError {
  const raw = typeof value === 'string' ? { message: value } : value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  return Object.fromEntries(['message', 'type', 'code', 'param'].flatMap(field => {
    const v = raw[field]
    if (typeof v !== 'string' && typeof v !== 'number') return []
    const safe = key ? String(v).replaceAll(key, '[redacted]') : String(v)
    return [[field, safe.slice(0, field === 'message' ? 1000 : 200)]]
  }))
}

/** Error diagnostics are bounded and never substituted for the user-facing error. */
export async function readProviderError(response: Response, key: string, signal: AbortSignal): Promise<ProviderStreamError> {
  const reader = response.body?.getReader()
  if (!reader) return {}
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let text = '', bytes = 0
  try {
    while (bytes < 8192) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (value) { const bounded = value.slice(0, 8192 - bytes); bytes += bounded.byteLength; text += decoder.decode(bounded, { stream: true }) }
      if (done) { text += decoder.decode(); break }
    }
    if (!text.trim()) return {}
    try { const parsed = JSON.parse(text); return providerErrorFields(parsed.error ?? parsed, key) }
    catch { return providerErrorFields(text, key) }
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

