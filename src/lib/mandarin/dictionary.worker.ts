import snapshot from './dictionarySnapshot.json'
import { createDictionaryIndex } from './dictionaryData'
import { decodeDictionaryArchive } from './dictionaryArchive'

let dictionary: ReturnType<typeof createDictionaryIndex> | undefined
// A dedicated worker keeps decompression and the full index off the canvas thread.
async function load(url: string) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(url, { credentials: 'omit', signal: controller.signal })
    if (!response.ok || !response.body) throw new Error('Dictionary asset is unavailable.')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > snapshot.expandedBytes) { await reader.cancel(); throw new Error('Dictionary asset exceeds its pinned size.') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    dictionary = createDictionaryIndex(decodeDictionaryArchive(bytes), snapshot.entries)
  } finally { clearTimeout(timeout) }
}
self.onmessage = async (event: MessageEvent<{ type: 'load'; url: string } | { type: 'lookup'; id: number; text: string }>) => {
  const message = event.data
  try {
    if (message.type === 'load') { await load(message.url); self.postMessage({ type: 'ready' }) }
    else {
      if (!dictionary) throw new Error('Dictionary is not ready.')
      self.postMessage({ type: 'result', id: message.id, result: dictionary.lookup(message.text) })
    }
  } catch { self.postMessage({ type: 'error' }) }
}
