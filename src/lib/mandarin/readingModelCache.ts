import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import manifest from './readingModelManifest.json'

export const readingModelBytes = manifest.bytes
export const readingModelVersion = manifest.version
type Asset = typeof manifest.files[number]

/** Resource cache only. Never part of a learner backup or the required SW shell. */
export function createReadingModelCache(base: string) {
  const root = new URL(manifest.directory, base), cacheName = `vl-pronunciation-${encodeURIComponent(root.pathname)}-${manifest.version}`
  const marker = new URL('installed', root).href
  const url = (asset: Asset) => new URL(asset.file, root).href
  async function read(response: Response | undefined, asset: Asset, progress?: (n: number) => void) {
    if (!response?.ok || !response.body) throw new Error('The contextual pinyin pack is missing. Download it again when online.')
    const reader = response.body.getReader(), bytes = new Uint8Array(asset.bytes); let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        if (received + value.length > asset.bytes) throw new Error('The contextual pinyin pack exceeds its expected size.')
        bytes.set(value, received); received += value.length; progress?.(received)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    if (received !== asset.bytes || bytesToHex(sha256(bytes)) !== asset.sha256) throw new Error('The contextual pinyin pack failed its integrity check. Download it again.')
    return bytes
  }
  async function installed() {
    if (!(await caches.has(cacheName))) return false
    const cache = await caches.open(cacheName)
    return (await cache.match(marker))?.ok === true && (await Promise.all(manifest.files.map(asset => cache.match(url(asset))))).every(Boolean)
  }
  return {
    installed,
    async install(signal: AbortSignal, progress: (n: number) => void) {
      const cache = await caches.open(cacheName); await cache.delete(marker)
      let received = 0
      for (const asset of manifest.files) {
        signal.throwIfAborted()
        let bytes: Uint8Array | undefined
        const existing = await cache.match(url(asset))
        if (existing) try { bytes = await read(existing, asset) } catch { await cache.delete(url(asset)) }
        if (!bytes) {
          const response = await fetch(url(asset), { credentials: 'omit', redirect: 'error', cache: 'no-store', signal })
          bytes = await read(response, asset, n => progress(received + n))
          signal.throwIfAborted(); await cache.put(url(asset), new Response(bytes.slice().buffer))
        }
        received += asset.bytes; progress(received)
      }
      signal.throwIfAborted(); await cache.put(marker, new Response(manifest.version))
    },
    async asset(file: string) {
      const asset = manifest.files.find(asset => asset.file === file)
      if (!asset) throw new Error('Unknown pronunciation asset.')
      return read(await (await caches.open(cacheName)).match(url(asset)), asset)
    },
    async remove() { await caches.delete(cacheName) },
  }
}
