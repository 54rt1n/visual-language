import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

// Explicit asset acquisition, never a build-time or application network request.
// The upstream URL changes over time; fail closed instead of silently upgrading.
const snapshot = JSON.parse(await readFile(new URL('../src/lib/mandarin/dictionarySnapshot.json', import.meta.url), 'utf8'))
const target = new URL(`../public/dictionaries/${snapshot.file}`, import.meta.url)
let archive
try { archive = await readFile(target) }
catch (error) {
  if (error.code !== 'ENOENT' || process.argv.includes('--check')) throw error
  const response = await fetch(snapshot.url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Dictionary download failed: ${response.status}`)
  const chunks = []; let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > snapshot.bytes) throw new Error('Dictionary download differs from the pinned snapshot. Review an update explicitly.')
    chunks.push(chunk)
  }
  archive = Buffer.concat(chunks)
}
if (archive.byteLength !== snapshot.bytes || createHash('sha256').update(archive).digest('hex') !== snapshot.sha256) throw new Error('Dictionary snapshot checksum mismatch; no file was written.')
const source = gunzipSync(archive)
if (source.byteLength !== snapshot.expandedBytes || createHash('sha256').update(source).digest('hex') !== snapshot.expandedSha256 || !source.includes(`#! date=${snapshot.date}\r\n`) || !source.includes(`#! entries=${snapshot.entries}\r\n`) || !source.includes(snapshot.license)) throw new Error('Dictionary metadata mismatch; no file was written.')
if (!process.argv.includes('--check')) {
  await mkdir(new URL('../public/dictionaries/', import.meta.url), { recursive: true })
  try { await writeFile(target, archive, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
console.log(`Verified unchanged ${snapshot.name} snapshot: ${snapshot.entries} entries, ${archive.byteLength} compressed bytes, ${snapshot.date}.`)
