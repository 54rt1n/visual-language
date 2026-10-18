import { writable } from 'svelte/store'
import { readingModelBytes } from './readingModelCache'
import type { LocalPronunciation, ReadingRange } from './readingModelInput'

export { readingModelBytes }
type PackState = { phase: 'checking' | 'absent' | 'downloading' | 'ready' | 'error' | 'unavailable'; downloaded: number; error?: string }
export const readingModelState = writable<PackState>({ phase: 'checking', downloaded: 0 })
let worker: Worker | undefined, sequence = 0, initialized = false, failed = false
type Pending = { resolve(): void; reject(error: Error): void; partial(results: LocalPronunciation[]): void; cleanup(): void }
const pending = new Map<number, Pending>()
function stopWorker(reason: string) {
  worker?.terminate(); worker = undefined; initialized = false
  for (const request of pending.values()) { request.cleanup(); request.reject(new Error(reason)) }
  pending.clear()
}
export function startReadingModel(remove = false) {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  failed = false
  if (!window.isSecureContext || !('caches' in window) || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    readingModelState.set({ phase: 'unavailable', downloaded: 0, error: 'The contextual pinyin pack requires HTTPS (or localhost), browser storage and WebAssembly.' }); return
  }
  readingModelState.set({ phase: 'checking', downloaded: 0 })
  try { worker = new Worker(new URL('./readingModel.worker.ts', import.meta.url), { type: 'module' }) }
  catch { failed = true; readingModelState.set({ phase: 'error', downloaded: 0, error: 'This browser could not start the optional pronunciation worker. Basic word reading remains available.' }); return }
  const current = worker
  worker.onmessage = ({ data }) => {
    if (worker !== current) return
    if (data.type === 'state') { failed = data.phase === 'error'; readingModelState.set({ phase: data.phase, downloaded: data.downloaded ?? 0, error: data.error }); return }
    const request = pending.get(data.id); if (!request) return
    if (data.type === 'partial') { request.partial(data.results); return }
    pending.delete(data.id); request.cleanup()
    if (data.type === 'done') request.resolve(); else request.reject(new Error(data.error))
  }
  worker.onerror = () => { if (worker !== current) return; stopWorker('Local pronunciation stopped. Your source text is unchanged.'); readingModelState.set({ phase: 'error', downloaded: 0, error: 'Local pronunciation could not start on this device. Retry or continue with basic reading.' }) }
  worker.postMessage({ type: 'init', base: new URL(import.meta.env.BASE_URL, document.baseURI).href, remove })
}
export function downloadReadingModel() { if (failed) stopWorker('Retrying local pronunciation.'); startReadingModel(); worker?.postMessage({ type: 'install' }) }
export function cancelReadingModelDownload() { stopWorker('Pronunciation download stopped.'); startReadingModel() }
export function removeReadingModel() {
  // Termination releases WASM memory and prevents an in-flight install from
  // recreating the cache after removal. Only this app/version resource is removed.
  stopWorker('The optional contextual pinyin pack was removed.'); startReadingModel(true)
}
export function analyzeReading(source: string, ranges: ReadingRange[], signal: AbortSignal, partial: (results: LocalPronunciation[]) => void, priority = false): Promise<void> {
  signal.throwIfAborted(); startReadingModel()
  if (!worker) return Promise.reject(new Error('Local pronunciation is unavailable.'))
  if (pending.size >= 16) return Promise.reject(new Error('Local pronunciation is busy. Try this word again.'))
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); worker?.postMessage({ type: 'cancel', id }); cleanup(); reject(new DOMException('Reading selection changed.', 'AbortError')) }
    const timer = setTimeout(() => {
      stopWorker('Local pronunciation took too long. Basic reading is still available.')
      readingModelState.set({ phase: 'error', downloaded: 0, error: 'Local pronunciation timed out. Retry when ready; the reply is unchanged.' })
    }, 90_000)
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    pending.set(id, { resolve, reject, partial, cleanup }); signal.addEventListener('abort', abort, { once: true })
    worker!.postMessage({ type: 'analyze', id, source, ranges, priority })
  })
}
