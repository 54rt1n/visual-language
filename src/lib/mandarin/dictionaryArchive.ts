import { gunzipSync } from 'fflate'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import snapshot from './dictionarySnapshot.json'

/** Some hosts serve .gz as bytes; others apply Content-Encoding: gzip, which
 * fetch decodes. Accept exactly the two pinned representations, not arbitrary text.
 */
export function decodeDictionaryArchive(bytes: Uint8Array): string {
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b
  const expectedBytes = gzip ? snapshot.bytes : snapshot.expandedBytes
  const expectedHash = gzip ? snapshot.sha256 : snapshot.expandedSha256
  if (bytes.byteLength !== expectedBytes || bytesToHex(sha256(bytes)) !== expectedHash) throw new Error('Dictionary asset failed its integrity check.')
  // Verify before allocating/decompressing. No secure-context crypto API needed.
  const expanded = gzip ? gunzipSync(bytes, { out: new Uint8Array(snapshot.expandedBytes) }) : bytes
  if (expanded.byteLength !== snapshot.expandedBytes) throw new Error('Dictionary expanded size is incorrect.')
  return new TextDecoder('utf-8', { fatal: true }).decode(expanded)
}
