import { modelPinyin } from './markedPinyin'
import type * as Ort from 'onnxruntime-web'
import { createReadingModelCache } from './readingModelCache'
import { createReadingModelInput, type LocalPronunciation, type ModelMetadata, type ReadingRange } from './readingModelInput'

type Job = { id: number; source: string; ranges: ReadingRange[] }
let cache: ReturnType<typeof createReadingModelCache>, ort: typeof Ort, session: Ort.InferenceSession | undefined
let prepare: ReturnType<typeof createReadingModelInput>, metadata: ModelMetadata
let loading: Promise<void> | undefined, installing: AbortController | undefined, running: number | undefined
let queue: Job[] = []; const cancelled = new Set<number>(), results = new Map<string, { pinyin: string; confidence: number } | null>()
const send = (value: unknown) => self.postMessage(value)
const state = (phase: string, extra = {}) => send({ type: 'state', phase, ...extra })
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Local pronunciation could not run on this device.'
async function load() {
  if (session) return
  if (loading) return loading
  loading = (async () => {
    if (!(await cache.installed())) throw new Error('Download the contextual pinyin pack first.')
    const urls: string[] = []
    const blobModule = async (name: string, type = 'text/javascript') => { const url = URL.createObjectURL(new Blob([(await cache.asset(name)).slice().buffer], { type })); urls.push(url); return url }
    try {
      metadata = JSON.parse(new TextDecoder().decode(await cache.asset('metadata.json')))
      prepare = createReadingModelInput(metadata)
      ort = await import(/* @vite-ignore */ await blobModule('ort.wasm.min.mjs'))
      ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false
      // Both URLs are explicit: the Emscripten helper otherwise tries to resolve
      // a relative WASM filename against its opaque blob URL, even with wasmBinary.
      ort.env.wasm.wasmPaths = { mjs: await blobModule('ort-wasm-simd-threaded.mjs'), wasm: await blobModule('ort-wasm-simd-threaded.wasm', 'application/wasm') }
      session = await ort.InferenceSession.create(await cache.asset('model.onnx'), { executionProviders: ['wasm'] })
    } finally { urls.forEach(url => URL.revokeObjectURL(url)) }
  })().catch(error => { state('error', { error: errorText(error) }); throw error }).finally(() => { loading = undefined })
  return loading
}
async function pump() {
  if (running !== undefined || !queue.length) return
  const job = queue.shift()!; running = job.id
  try {
    await load()
    for (const group of prepare(job.source, job.ranges)) {
      if (cancelled.has(job.id)) break
      const output: LocalPronunciation[] = [], missing = group.targets.filter(target => {
        const key = `${group.ids}/${target.charId}/${target.position}`, hit = results.get(key)
        if (hit) output.push({ ...target, ...hit })
        return !results.has(key)
      })
      if (missing.length) {
        const count = missing.length, width = metadata.sounds.length, mask = new Float32Array(count * width)
        missing.forEach((target, row) => target.candidates.forEach(column => { mask[row * width + column] = 1 }))
        const tensor = (values: number[], dims: number[]) => new ort.Tensor('int64', BigInt64Array.from(values.map(BigInt)), dims)
        const feeds = { input_ids: tensor(group.ids, [1, group.ids.length]), token_type_ids: tensor(group.ids.map(() => 0), [1, group.ids.length]), attention_mask: tensor(group.ids.map(() => 1), [1, group.ids.length]),
          char_ids: tensor(missing.map(target => target.charId), [count]), position_ids: tensor(missing.map(target => target.position), [count]), phoneme_mask: new ort.Tensor('float32', mask, [count, width]) }
        let answer: Ort.InferenceSession.ReturnType | undefined
        try {
          answer = await session!.run(feeds)
          const values = Object.values(answer)[0]!.data as Float32Array
          if (values.length !== count * width || values.some(value => !Number.isFinite(value))) throw new Error('Invalid pronunciation prediction.')
          missing.forEach((target, row) => {
            let best = target.candidates[0]!
            for (const column of target.candidates) if (values[row * width + column]! > values[row * width + best]!) best = column
            const pinyin = modelPinyin(metadata.sounds[best]!)
            const result = pinyin ? { pinyin, confidence: values[row * width + best]! } : null
            const key = `${group.ids}/${target.charId}/${target.position}`; results.set(key, result)
            while (results.size > 2048) results.delete(results.keys().next().value!)
            if (result) output.push({ text: target.text, start: target.start, end: target.end, ...result })
          })
        } finally { Object.values(feeds).forEach(t => t.dispose()); if (answer) Object.values(answer).forEach(t => t.dispose()) }
      }
      if (!cancelled.has(job.id)) send({ type: 'partial', id: job.id, results: output })
      // Yield a TASK, not just a microtask, so stale viewport work can be stopped.
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    send({ type: 'done', id: job.id })
  } catch (error) { send({ type: 'error', id: job.id, error: errorText(error) }) }
  finally { cancelled.delete(job.id); running = undefined; void pump() }
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const base = new URL(data.base)
      if (base.origin !== self.location.origin) throw new Error('Pronunciation assets must be on this site.')
      cache = createReadingModelCache(base.href)
      if (data.remove) await cache.remove()
      const installed = await cache.installed()
      if (!installing) state(installed ? 'ready' : 'absent')
    } else if (data.type === 'install') {
      if (installing) return
      installing = new AbortController(); state('downloading', { downloaded: 0 })
      let lastProgress = 0
      try { await cache.install(AbortSignal.any([installing.signal, AbortSignal.timeout(300_000)]), downloaded => { if (Date.now() - lastProgress > 100) { lastProgress = Date.now(); state('downloading', { downloaded }) } }); state('ready') }
      catch (error) { state('error', { error: errorText(error) }) }
      finally { installing = undefined }
    } else if (data.type === 'remove') { await cache.remove(); state('absent') }
    else if (data.type === 'analyze') {
      if (queue.length >= 16) throw new Error('Pronunciation is busy. Try this word again shortly.')
      if (data.priority) queue.unshift(data); else queue.push(data)
      void pump()
    } else if (data.type === 'cancel') { queue = queue.filter(job => job.id !== data.id); if (running === data.id) cancelled.add(data.id) }
  } catch (error) { if (data.id !== undefined) send({ type: 'error', id: data.id, error: errorText(error) }); else state('error', { error: errorText(error) }) }
}
