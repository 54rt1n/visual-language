import { InferenceFailure, classifyInferenceFailure } from '../../ai/inferenceFailure'
import { sha256Hex } from '../../crypto'
export type CheckpointCommit = { checkpointId: string; persisted: boolean; contentHash: string }

/** Persistence finishes before dependent inference; a failed write is never a model failure. */
export async function commitLessonCheckpoint<T>(value: T, write: ((value: T) => Promise<void>) | undefined,
  signal: AbortSignal | undefined, checkpointId: string, onCommitted?: (event: CheckpointCommit) => void | Promise<void>) {
  signal?.throwIfAborted()
  try { await write?.(structuredClone(value)) }
  catch (error) {
    if (signal?.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) {
      throw classifyInferenceFailure(error, signal).withContext({ checkpointId })
    }
    throw new InferenceFailure({ category: 'persistence_error', layer: 'persistence', retryable: false,
      checkpointId, message: 'The lesson checkpoint could not be saved. Dependent generation has stopped.' }, error)
  }
  if (onCommitted) try { await onCommitted({ checkpointId, persisted: Boolean(write), contentHash: await sha256Hex(JSON.stringify(value)) }) }
  catch (error) { throw new InferenceFailure({ category: 'persistence_error', layer: 'persistence', retryable: false,
    checkpointId: `${checkpointId}-observation`, message: 'The checkpoint outcome could not be recorded.',
    fields: [write ? 'The checkpoint write was acknowledged before its observation failed.' : 'No durable checkpoint writer was configured.'] }, error) }
  signal?.throwIfAborted()
}
