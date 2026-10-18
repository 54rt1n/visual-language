export function normalizeEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS endpoint without credentials, query parameters, or a fragment.')
  }
  return url.href.replace(/\/+$/, '')
}

export function publicSourceUrl(value: string): string {
  const url = new URL(value)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')) {
    throw new Error('Sources must have a public HTTP(S) domain, not a local/IP address.')
  }
  for (const key of url.searchParams.keys()) if (/^(?:api[-_]?key|access[-_]?token|token|auth(?:orization)?|password|secret|signature|x-amz-credential|x-amz-signature)$/i.test(key)) {
    throw new Error('Source URLs cannot contain credential-bearing query parameters.')
  }
  url.hash = ''
  return url.href
}

export async function boundedJsonResponse(response: Response, signal: AbortSignal, maxBytes = 2_000_000): Promise<unknown> {
  signal.throwIfAborted()
  const reader = response.body?.getReader()
  if (!reader) throw new Error('The service returned no response body.')
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  const decoder = new TextDecoder()
  let text = '', size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      size += value?.byteLength ?? 0
      if (size > maxBytes) throw new Error('The service response exceeded the size limit.')
      text += decoder.decode(value, { stream: !done })
      if (done) break
    }
    try { return JSON.parse(text) } catch { throw new Error('The service returned malformed JSON.') }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function requestSignal(parent: AbortSignal | undefined, timeoutMs: number, timeoutReason?: unknown) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) onAbort()
  else parent?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(timeoutReason ?? new DOMException('Request timed out. Retry when ready.', 'TimeoutError')), timeoutMs)
  return { signal: controller.signal, dispose() { clearTimeout(timer); parent?.removeEventListener('abort', onAbort) } }
}

/** Server messages may echo tokens/prompts. Expose status, never the raw body. */
export function responseError(status: number): Error {
  const reasons: Record<number, string> = {
    400: 'The provider rejected this model or request. Check its supported parameters.',
    401: 'The API key is missing or invalid. Check Settings.',
    403: 'This key does not have access to the requested service or model.',
    404: 'The endpoint or model was not found. Check Settings.',
    429: 'The provider is limiting requests. Wait, then retry. Check account limits if this continues.',
    432: 'The Tavily plan limit was reached.',
    433: 'The Tavily pay-as-you-go limit was reached.',
  }
  return new Error(reasons[status] ?? `Provider request failed (HTTP ${status}). Your work is saved; retry when ready.`)
}
