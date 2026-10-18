import { sha256 } from '@noble/hashes/sha2.js'

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/** Full-entropy v4 IDs, including browsers without secure-context randomUUID. */
export function randomUuid(): string {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID()
  if (typeof browserCrypto?.getRandomValues !== 'function') {
    throw new Error('Secure random numbers are unavailable. Open the app in a current browser using HTTPS.')
  }
  const bytes = browserCrypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const value = hex(bytes)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

/** Keep persisted operation fingerprints identical when SubtleCrypto is absent. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value), subtle = globalThis.crypto?.subtle
  const digest = typeof subtle?.digest === 'function'
    ? new Uint8Array(await subtle.digest('SHA-256', bytes))
    : sha256(bytes)
  return hex(digest)
}
