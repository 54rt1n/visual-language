import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'

// Reproducible asset staging, not an application download or model evaluation.
// Existing files must be byte-identical; never replace a different model silently.
const source = process.argv[2]
if (!source || process.argv.length !== 3) throw new Error('Usage: node scripts/stage-reading-model.mjs PREPARED_ARTIFACT_DIRECTORY')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function pinned(path, expected) {
  const bytes = await readFile(path)
  if (expected && sha(bytes) !== expected) throw new Error(`Unreviewed artifact: ${path}`)
  return bytes
}
async function identicalOrNew(path, bytes) {
  try { await writeFile(path, bytes, { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(path)) !== sha(bytes)) throw error }
}
const upstream = join(resolve(source), 'g2pw-src/g2pw')
const poly = await pinned(join(source, 'model/G2PWModel/POLYPHONIC_CHARS.txt'), 'b63cd02d842dbaea32ca55b3fbbdef986a617854967cc2fb9ec1f2126715b747')
const vocab = await pinned(join(source, 'bert-vocab.txt'), '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c')
const s2t = await pinned(join(upstream, 'bert-base-chinese_s2t_dict.txt'), '394822822c43f53adc258aaf7feca6e8bd82a84ff7d02ee4a6adcf70b572f447')
const roman = JSON.parse(await pinned(join(upstream, 'bopomofo_to_pinyin_wo_tune_dict.json'), '0fe90e26be7653023772b3ad2d08952961bbf295fb39ba685c7172d3d9769f52'))
const pairs = poly.toString('utf8').trim().split('\n').map(line => line.split('\t'))
const labels = [...new Set(pairs.map(pair => pair[1]))].sort(), chars = [...new Set(pairs.map(pair => pair[0]))].sort()
if (labels.length !== 1305 || chars.length !== 3582 || chars.some(char => char.length !== 1)) throw new Error('Unexpected model inventory.')
const vocabulary = vocab.toString('utf8').split('\n'); if (vocabulary.at(-1) === '') vocabulary.pop()
const metadata = { version: 1, vocabulary, sounds: labels.map(sound => (roman[sound.slice(0, -1)] ?? sound.slice(0, -1)) + sound.at(-1)),
  chars, candidates: chars.map(char => pairs.filter(pair => pair[0] === char).map(pair => labels.indexOf(pair[1]))),
  s2t: Object.fromEntries(s2t.toString('utf8').trim().split('\n').map(line => line.split('\t'))) }
if (vocabulary[101] !== '[CLS]' || vocabulary[2533] !== '得' || vocabulary[6917] !== '還') throw new Error('Tokenizer vocabulary IDs changed.')
const out = resolve('public/reading-model/g2pw-v2-int4-1'); await mkdir(out, { recursive: true })
const assets = [
  ['model.onnx', await pinned(join(source, 'g2pw-packed-int4-v2.onnx'), 'bbcff9e87197515b72bfe0232e0ac278621bac22c50c8f98e2456d9d952a501b')],
  ['metadata.json', Buffer.from(JSON.stringify(metadata) + '\n')],
  ['G2pW-LICENSE.txt', await pinned(join(source, 'g2pw-src/LICENCE'), '43070e2d4e532684de521b885f385d0841030efa2b1a20bafb76133a5e1379c1')],
]
if (JSON.parse(await readFile('node_modules/onnxruntime-web/package.json')).version !== '1.23.2') throw new Error('ORT runtime must be 1.23.2.')
for (const name of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) assets.push([name, await readFile(join('node_modules/onnxruntime-web/dist', name))])
for (const [name, upstreamName] of [['ORT-LICENSE.txt', 'LICENSE'], ['ORT-ThirdPartyNotices.txt', 'ThirdPartyNotices.txt']]) {
  const response = await fetch(`https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/${upstreamName}`, { signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error('Could not stage runtime notices.')
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 2_000_000) throw new Error('Notice size exceeded.')
  assets.push([name, bytes])
}
assets.push(['NOTICE.txt', Buffer.from(`Optional contextual Mandarin pronunciation pack\n\nG2pW by GitYCC and contributors, Apache-2.0.\nSource: https://github.com/GitYCC/g2pW/tree/36c3fcce93aebfcb54803d2ad6677023a28ad950\nOfficial v2 model: https://storage.googleapis.com/esun-ai/g2pW/G2PWModel-v2-onnx.zip\nModified by Visual Language: conditional candidate tables packed and model quantized to int4; metadata transformed to JSON. See scripts/prepare-reading-model.py and docs/READING-PRONUNCIATION-EVALUATION.md. This is not an unmodified upstream model.\nBERT Chinese vocabulary by Google, Apache-2.0, revision 8f23c25b06e129b6c986331a13d8d025a92cf0ea.\nONNX Runtime Web 1.23.2 by Microsoft Corporation, MIT; see ORT-LICENSE.txt and ORT-ThirdPartyNotices.txt. Runtime files are unmodified.\n\nThe model is Taiwan-oriented. Contextual predictions are not certified pronunciations; regional conventions can differ. Source text is never changed.\n`)])
const files = []
for (const [file, bytes] of assets) { await identicalOrNew(join(out, file), bytes); files.push({ file, bytes: bytes.length, sha256: sha(bytes) }) }
const manifest = { version: 'g2pw-v2-int4-1', directory: 'reading-model/g2pw-v2-int4-1/', bytes: files.reduce((n, file) => n + file.bytes, 0), files }
await identicalOrNew(resolve('src/lib/mandarin/readingModelManifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
console.log(JSON.stringify(manifest, null, 2))
