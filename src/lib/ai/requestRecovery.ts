import { requestSignal } from './http'
import { classifyInferenceFailure, isProviderCapacity } from './inferenceFailure'

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!ms) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(signal?.reason) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Only classified transient failures repeat a generation request. No state is applied here. */
export async function requestWithRecovery<T>(request: (attempt: number, signal: AbortSignal) => Promise<T>,
  policy: { attempts: number; capacityWaits?: number; timeoutMs: number; retryDelayMs: number; signal?: AbortSignal; stage?: string;
    onCapacityWait?: (delayMs: number) => void }) {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1 || policy.attempts > 3) throw new Error('Request recovery needs one to three bounded attempts.')
  const capacityWaits = policy.capacityWaits ?? 2
  if (!Number.isInteger(capacityWaits) || capacityWaits < 0 || capacityWaits > 3) throw new Error('Capacity recovery needs zero to three bounded waits.')
  let transportAttempts = 0, capacityWaitsUsed = 0
  for (let attempt = 1; ; attempt++) {
    let retryDelayMs = policy.retryDelayMs * 2 ** transportAttempts
    const deadline = requestSignal(policy.signal, policy.timeoutMs)
    try {
      const response = await request(attempt, deadline.signal)
      deadline.signal.throwIfAborted()
      return response
    } catch (error) {
      const failure = classifyInferenceFailure(error, deadline.signal).withContext({ stage: policy.stage, attempt, requestAttempt: attempt })
      if (policy.signal?.aborted) throw classifyInferenceFailure(error, policy.signal).withContext({ stage: policy.stage, attempt, requestAttempt: attempt })
      const details = failure.failure
      const overloaded = isProviderCapacity(details)
      if (!details.retryable) throw failure
      if (overloaded) {
        if (capacityWaitsUsed++ >= capacityWaits) throw failure
      } else if (++transportAttempts >= policy.attempts) throw failure
      const cooldownMs = overloaded ? 60_000 : details.category === 'provider_unavailable' ? 1000 : 0
      retryDelayMs = Math.max(retryDelayMs, details.retryAfterMs ?? cooldownMs)
      if (overloaded) policy.onCapacityWait?.(retryDelayMs)
    } finally { deadline.dispose() }
    try { await waitForRetry(retryDelayMs, policy.signal) }
    catch (error) { throw classifyInferenceFailure(error, policy.signal).withContext({ stage: policy.stage, attempt, requestAttempt: attempt }) }
  }
}

