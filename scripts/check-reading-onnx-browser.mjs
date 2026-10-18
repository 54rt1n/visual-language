import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

// Standalone local-model diagnostic. No application, real profiles, provider
// requests, remote runtime CDN or browser storage is involved.
const args = process.argv.slice(2), options = {}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i].replace(/^--/, '')
  if (!args[i].startsWith('--') || !['runtime', 'model', 'inputs', 'out'].includes(key) || key in options || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/check-reading-onnx-browser.mjs --runtime ORT_DIST --model MODEL --inputs INPUT_REPORT --out NEW_REPORT')
  options[key] = resolve(args[i + 1])
}
for (const key of ['runtime', 'model', 'inputs', 'out']) if (!options[key]) throw new Error(`Missing --${key}.`)
const inputBytes = await readFile(options.inputs)
if (inputBytes.length > 5_000_000) throw new Error('Input diagnostic exceeds its byte bound.')
const payload = JSON.parse(inputBytes)
if (payload.format !== 'visual-language-reading-onnx-inputs' || payload.version !== 1 || payload.sounds.length !== 1305 || !payload.cases.length || payload.cases.length > 100) throw new Error('Invalid input-vector report.')
for (const entry of payload.cases) {
  for (const value of Object.values(entry.feeds)) if (!['int64', 'float32'].includes(value.type) || !Array.isArray(value.dims) || value.dims.some(d => !Number.isInteger(d) || d <= 0) || value.data.length !== value.dims.reduce((a, b) => a * b, 1) || value.data.length > 1400 || value.data.some(v => !Number.isFinite(v))) throw new Error('Invalid bounded model input.')
}
const files = new Map([['/model.onnx', { path: options.model, type: 'application/octet-stream' }],
  ...['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].map(name => [`/runtime/${name}`, { path: resolve(options.runtime, name), type: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }])])
for (const file of files.values()) if (!(await stat(file.path)).isFile()) throw new Error('A required runtime/model asset is missing.')
const hashFile = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
const report = { format: 'visual-language-reading-onnx-browser-evaluation', version: 1, status: 'running',
  corpusVersion: payload.corpusVersion, corpusHash: payload.corpusHash, annotationStatus: payload.annotationStatus, scope: payload.scope,
  inputHash: createHash('sha256').update(inputBytes).digest('hex'), runnerHash: await hashFile(new URL(import.meta.url)), modelHash: await hashFile(options.model), modelBytes: (await stat(options.model)).size,
  runtimeHashes: Object.fromEntries(await Promise.all([...files].filter(([url]) => url.startsWith('/runtime/')).map(async ([url, file]) => [url, await hashFile(file.path)]))),
  externalProviderCalls: 0, externalRequests: [], pageErrors: [], results: [] }
const output = await open(options.out, 'wx', 0o600)
await output.writeFile(JSON.stringify(report, null, 2) + '\n')
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname
  if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><meta charset="utf-8"><title>Isolated reading-model diagnostic</title>'); return }
  const file = files.get(path)
  if (!file) { response.writeHead(404); response.end(); return }
  response.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' })
  const stream = createReadStream(file.path)
  stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response)
})
let browser, timeout
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch()
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    report.externalRequests.push(new URL(route.request().url()).origin); return route.abort()
  })
  const page = await context.newPage()
  page.on('pageerror', error => report.pageErrors.push(error.message))
  page.on('console', message => { if (message.text().startsWith('reading-eval:')) console.log(message.text()) })
  timeout = setTimeout(() => { void browser.close() }, 180_000)
  await page.goto(origin)
  const measured = await page.evaluate(async payload => {
    const ort = await import('/runtime/ort.wasm.min.mjs')
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = `${location.origin}/runtime/`
    const started = performance.now(), session = await ort.InferenceSession.create('/model.onnx', { executionProviders: ['wasm'] })
    const loadMilliseconds = performance.now() - started, results = [], referenceVectors = new Map()
    const tensorFeeds = raw => Object.fromEntries(Object.entries(raw).map(([name, input]) => [name, new ort.Tensor(input.type, input.type === 'int64' ? BigInt64Array.from(input.data.map(BigInt)) : Float32Array.from(input.data), input.dims)]))
    try {
      for (const { feeds: raw, ...entry } of payload.cases) {
        const feeds = tensorFeeds(raw)
        const began = performance.now(), outputs = await session.run(feeds), elapsed = performance.now() - began
        const probabilities = Object.values(outputs)[0].data
        if (probabilities.length !== payload.sounds.length || probabilities.some(value => !Number.isFinite(value))) throw new Error('Invalid browser probability vector.')
        let best = 0
        for (let i = 1; i < probabilities.length; i++) if (probabilities[i] > probabilities[best]) best = i
        const actual = payload.sounds[best]
        referenceVectors.set(entry.id, Float32Array.from(probabilities))
        results.push({ ...entry, actual, matches: actual === entry.expected, confidence: probabilities[best], milliseconds: elapsed })
        Object.values(feeds).forEach(tensor => tensor.dispose()); Object.values(outputs).forEach(tensor => tensor.dispose())
        if (results.length % 10 === 0) console.log(`reading-eval: ${results.length}/${payload.cases.length}`)
      }
      // The exported graph can broadcast one BERT sequence across several
      // target positions. Share ONLY byte-identical encoder inputs; do not
      // enlarge windows or silently change the model's context to make groups.
      const groups = new Map(), sharedEncoderChecks = []
      const encoderFields = ['input_ids', 'token_type_ids', 'attention_mask']
      for (const entry of payload.cases) {
        const key = JSON.stringify(encoderFields.map(name => entry.feeds[name]))
        groups.set(key, [...(groups.get(key) ?? []), entry])
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue
        const raw = Object.fromEntries(Object.entries(group[0].feeds).map(([name, input]) => [name, encoderFields.includes(name) ? input : { ...input, dims: [group.length, ...input.dims.slice(1)], data: group.flatMap(entry => entry.feeds[name].data) }]))
        const feeds = tensorFeeds(raw), began = performance.now(), outputs = await session.run(feeds), milliseconds = performance.now() - began
        const probabilities = Object.values(outputs)[0].data
        if (probabilities.length !== group.length * payload.sounds.length) throw new Error('Shared-encoder output shape changed.')
        let maxProbabilityDifference = 0
        for (let row = 0; row < group.length; row++) for (let column = 0; column < payload.sounds.length; column++) {
          maxProbabilityDifference = Math.max(maxProbabilityDifference, Math.abs(probabilities[row * payload.sounds.length + column] - referenceVectors.get(group[row].id)[column]))
        }
        sharedEncoderChecks.push({ caseIds: group.map(entry => entry.id), milliseconds, maxProbabilityDifference, matchesSeparateQueries: maxProbabilityDifference < 0.00001 })
        Object.values(feeds).forEach(tensor => tensor.dispose()); Object.values(outputs).forEach(tensor => tensor.dispose())
      }
      return { loadMilliseconds, userAgent: navigator.userAgent, threads: 1, executionProvider: 'wasm', sharedEncoderChecks, results }
    } finally { await session.release() }
  }, payload)
  Object.assign(report, measured, { status: 'finished' })
  report.summary = { total: report.results.length, matches: report.results.filter(row => row.matches).length }
  process.exitCode = report.summary.matches === report.summary.total && !report.externalRequests.length && !report.pageErrors.length && report.sharedEncoderChecks.every(row => row.matchesSeparateQueries) ? 0 : 1
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1
} finally {
  clearTimeout(timeout); await browser?.close(); await new Promise(resolve => server.close(resolve))
  const text = JSON.stringify(report, null, 2) + '\n'
  await output.write(text, 0, 'utf8'); await output.truncate(Buffer.byteLength(text)); await output.close()
}
console.log(JSON.stringify({ status: report.status, modelBytes: report.modelBytes, loadMilliseconds: report.loadMilliseconds, summary: report.summary,
  failures: report.results.filter(row => !row.matches), sharedEncoderChecks: report.sharedEncoderChecks, error: report.error, externalRequests: report.externalRequests, pageErrors: report.pageErrors }, null, 2))
