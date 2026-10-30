import { ZodError } from 'zod'
import { InputValidationError } from '../domain/validation'

export type InferenceFailureCategory =
  | 'request_invalid' | 'http_rejected' | 'rate_limited' | 'provider_unavailable'
  | 'provider_stream_error' | 'transport_error' | 'timeout' | 'cancelled'
  | 'stream_incomplete' | 'output_limit' | 'protocol_error' | 'empty_output'
  | 'tool_missing' | 'tool_unexpected' | 'arguments_invalid' | 'schema_invalid'
  | 'references_invalid' | 'constraints_invalid' | 'budget_exhausted' | 'review_rejected' | 'persistence_error' | 'unexpected_error'

export type InferenceFailureRecord = {
  category: InferenceFailureCategory
  layer: 'request' | 'transport' | 'protocol' | 'validation' | 'budget' | 'review' | 'persistence' | 'internal'
  message: string
  retryable: boolean
  stage?: string
  attempt?: number
  submissionAttempt?: number
  requestAttempt?: number
  checkpointId?: string
  httpStatus?: number
  requestId?: string
  retryAfterMs?: number
  provider?: { message?: string; type?: string; code?: string; param?: string }
  finishReason?: string
  fields?: string[]
  correctionExhausted?: boolean
  originatingFailure?: Pick<InferenceFailureRecord, 'category' | 'layer' | 'message' | 'stage' | 'requestAttempt' | 'submissionAttempt' | 'fields'>
}

/** Provider backpressure is operational state, never a model submission to correct. */
export function isProviderCapacity(failure?: InferenceFailureRecord | null) {
  return failure?.category === 'rate_limited'
    || ['concurrency_limit_exceeded', 'capacity_exhausted'].includes(failure?.provider?.code ?? '')
}

export function httpInferenceFailure(status: number, details: Pick<InferenceFailureRecord, 'message' | 'requestId' | 'provider' | 'retryAfterMs'>) {
  const message = status === 429 && details.provider?.code === 'concurrency_limit_exceeded'
    ? 'The provider is handling its maximum number of requests. Wait for a request to finish, then retry.'
    : details.message
  return new InferenceFailure({ ...details, message, category: status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable' : 'http_rejected',
    layer: 'request', retryable: [408, 429, 500, 502, 503, 504].includes(status), httpStatus: status })
}

/** Structured evidence travels with a concise user-facing exception. */
export class InferenceFailure extends Error {
  readonly failure: InferenceFailureRecord
  constructor(failure: InferenceFailureRecord, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause })
    this.name = failure.category === 'cancelled' ? 'AbortError' : failure.category === 'timeout' ? 'TimeoutError' : 'InferenceFailure'
    this.failure = structuredClone(failure)
  }
  withContext(context: Partial<Pick<InferenceFailureRecord, 'stage' | 'attempt' | 'submissionAttempt' | 'requestAttempt' | 'checkpointId'>>) {
    return new InferenceFailure({ ...this.failure, ...context }, this)
  }
}

/** User-visible diagnostics, without request bodies or credentials. */
export function inferenceFailureDetails(error: unknown): string {
  if (!(error instanceof InferenceFailure)) return error instanceof Error ? error.message : 'Unknown failure.'
  const failure = error.failure, original = failure.originatingFailure
  return [...new Set([
    failure.stage ? `${failure.stage}: ${failure.category}` : failure.category,
    failure.message, original?.message, ...(failure.fields ?? []), ...(original?.fields ?? []),
    failure.requestId ? `Request: ${failure.requestId}` : undefined,
  ].filter(Boolean))].join('\n\n').slice(0, 6000)
}

export function classifyInferenceFailure(error: unknown, signal?: AbortSignal): InferenceFailure {
  if (!signal?.aborted && error instanceof InferenceFailure) return error
  const reason = signal?.aborted ? signal.reason : error
  if (reason instanceof InferenceFailure) return reason
  const name = reason instanceof Error ? reason.name : ''
  const message = error instanceof Error ? error.message : 'Unknown inference failure.'
  if (name === 'TimeoutError') return new InferenceFailure({ category: 'timeout', layer: 'transport',
    message, retryable: true }, error)
  if (signal?.aborted || name === 'AbortError') return new InferenceFailure({ category: 'cancelled', layer: 'transport',
    message, retryable: false }, error)
  if (error instanceof InferenceFailure) return error
  if (error instanceof ZodError) return new InferenceFailure({ category: 'request_invalid', layer: 'validation', retryable: false,
    message: 'The lesson input or generation configuration is invalid.', fields: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) }, error)
  if (error instanceof InputValidationError) return new InferenceFailure({ category: 'request_invalid', layer: 'validation', retryable: false,
    message: error.message }, error)
  if (error instanceof TypeError) return new InferenceFailure({ category: 'transport_error', layer: 'transport',
    message, retryable: true }, error)
  return new InferenceFailure({ category: 'unexpected_error', layer: 'internal', message, retryable: false }, error)
}

