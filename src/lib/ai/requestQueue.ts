type Account = { baseUrl: string; apiKey: string }

function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** One in-flight request per account in this runtime, across features and models. */
export class ProviderRequestQueue {
  private endpoints = new Map<string, Map<string, Promise<void>>>()

  run<T>(account: Account, signal: AbortSignal | undefined, request: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    const endpoint = account.baseUrl.replace(/\/+$/, '')
    const accounts = this.endpoints.get(endpoint) ?? new Map<string, Promise<void>>()
    this.endpoints.set(endpoint, accounts)
    const previous = accounts.get(account.apiKey) ?? Promise.resolve()
    const pending = previous.then(() => { signal?.throwIfAborted(); return request() })
    // Rejection must release the slot, while a cancelled waiter keeps its place
    // until earlier work settles so later callers cannot bypass the active call.
    const tail = pending.then(() => {}, () => {})
    accounts.set(account.apiKey, tail)
    void tail.then(() => {
      if (accounts.get(account.apiKey) !== tail) return
      accounts.delete(account.apiKey)
      if (!accounts.size) this.endpoints.delete(endpoint)
    })
    return untilAborted(pending, signal)
  }
}

export const providerRequestQueue = new ProviderRequestQueue()
