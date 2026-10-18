import { createHash } from 'node:crypto'
import { readFile, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { pinyin, addDict, removeDict } from 'pinyin-pro'

// Standalone diagnostic: never imported by the app. Each temporary dictionary
// is removed before the next engine. No API calls or corpus-driven corrections.
const args = process.argv.slice(2)
const options = {}
for (let i = 0; i < args.length; i += 2) {
  const name = args[i]
  if (!['--out', '--from'].includes(name) || options[name] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: npm run eval:pronunciation -- [--from LESSON_REPORT] [--out NEW_FILE]')
  options[name] = args[i + 1]
}
let output, server
try {
  if (options['--out']) output = await open(resolve(options['--out']), 'wx', 0o600)
  server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true } })
  const { readingCases, decodeReadingCase, numberedSyllable } = await server.ssrLoadModule('/tests/evaluation/reading-corpus.ts')
  const { mandarinPinyin } = await server.ssrLoadModule('/src/lib/mandarin/chineseParser.ts')
  const lessonCorpus = JSON.parse(await readFile('tests/evaluation/lesson-pronunciation.json', 'utf8'))
  if (lessonCorpus.version !== 'lesson-pronunciation-v1' || lessonCorpus.annotationStatus !== 'project-authored-provisional') throw new Error('Unsupported lesson pronunciation corpus.')
  const cases = [...readingCases, ...lessonCorpus.cases.map(decodeReadingCase)]
  if (new Set(cases.map(row => row.id)).size !== cases.length) throw new Error('Pronunciation case IDs must be unique.')
  const savedSamples = []
  let sourceReport
  if (options['--from']) {
    const bytes = await readFile(options['--from']), source = JSON.parse(bytes)
    if (source.format !== 'visual-language-lessons-evaluation' || source.status !== 'finished' || !Array.isArray(source.results)) throw new Error('Choose a terminal lesson evaluation report.')
    sourceReport = { path: options['--from'], sha256: createHash('sha256').update(bytes).digest('hex') }
    function collect(value, path, caseId) {
      if (!value || typeof value !== 'object') return
      for (const [textKey, pinyinKey] of [['hanzi', 'pinyin'], ['exampleHanzi', 'examplePinyin'], ['passage', 'passagePinyin'], ['text', 'pinyin']]) {
        if (typeof value[textKey] === 'string' && typeof value[pinyinKey] === 'string' && /\p{Script=Han}/u.test(value[textKey])) savedSamples.push({ caseId, path: `${path}.${textKey}`, text: value[textKey], savedPinyin: value[pinyinKey] })
      }
      for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`, caseId)
    }
    source.results.forEach((row, index) => collect(row.artifacts, `results.${index}.artifacts`, row.caseId))
    if (!savedSamples.length) throw new Error('The report has no saved Mandarin/pinyin field pairs.')
  }
  const variants = []
  for (const engine of ['app-default', 'word-by-word', 'modern-dictionary', 'complete-dictionary']) {
    const start = performance.now(), dictionaryName = `evaluation-${engine}`
    try {
      if (engine === 'modern-dictionary') addDict((await import('@pinyin-pro/data/modern')).default, dictionaryName)
      if (engine === 'complete-dictionary') addDict((await import('@pinyin-pro/data/complete')).default, dictionaryName)
      const initializationMs = performance.now() - start
      const segmenter = engine === 'word-by-word' ? new Intl.Segmenter('zh-CN', { granularity: 'word' }) : undefined
      const results = cases.map(entry => {
        const parts = segmenter
          ? [...segmenter.segment(entry.text)].flatMap(word => pinyin(word.segment, { type: 'all' }))
          : pinyin(entry.text, { type: 'all' })
        if (parts.map(part => part.origin).join('') !== entry.text) throw new Error('Pronunciation changed the source text.')
        let offset = 0, actual = ''
        for (const part of parts) {
          if (offset === entry.start && offset + part.origin.length === entry.end) actual = numberedSyllable(part.pinyin)
          offset += part.origin.length
        }
        if (!actual) throw new Error(`Could not align pronunciation with marked character: ${entry.id}`)
        // Default and dictionary candidates use the real lesson renderer. The
        // rejected word-by-word candidate displays its experimental syllables.
        const rendered = segmenter ? parts.map(part => part.result).join(' ') : mandarinPinyin(entry.text)
        return { id: entry.id, tag: entry.tag, text: entry.text, start: entry.start, end: entry.end, expected: entry.expected, actual, matches: actual === entry.expected, rendered }
      })
      const baseline = variants[0]?.results
      const savedResults = savedSamples.map(sample => {
        const rendered = segmenter ? [...segmenter.segment(sample.text)].flatMap(word => pinyin(word.segment, { type: 'array' })).join(' ') : mandarinPinyin(sample.text)
        return { ...sample, rendered, differsFromSaved: rendered !== sample.savedPinyin }
      })
      variants.push({ engine, initializationMs, results, savedResults,
        summary: { total: results.length, matches: results.filter(row => row.matches).length,
          lessonMatches: results.filter(row => row.id.startsWith('lesson-') && row.matches).length,
          fixed: baseline ? results.filter((row, i) => row.matches && !baseline[i].matches).map(row => row.id) : [],
          regressed: baseline ? results.filter((row, i) => !row.matches && baseline[i].matches).map(row => row.id) : [],
          savedFields: savedResults.length, savedDisagreements: savedResults.filter(row => row.differsFromSaved).length } })
    } finally { removeDict(dictionaryName) }
    if (cases.some((entry, i) => mandarinPinyin(entry.text) !== variants[0].results[i].rendered)) throw new Error(`Dictionary cleanup changed the app baseline after ${engine}.`)
    if (savedSamples.some((entry, i) => mandarinPinyin(entry.text) !== variants[0].savedResults[i].rendered)) throw new Error(`Dictionary cleanup changed saved-field rendering after ${engine}.`)
  }
  const files = ['scripts/evaluate-pronunciation.mjs', 'tests/evaluation/reading-pronunciation.json', 'tests/evaluation/lesson-pronunciation.json', 'tests/evaluation/reading-corpus.ts', 'src/lib/mandarin/chineseParser.ts', 'scripts/patch-pinyin.mjs', 'package-lock.json']
  const codeHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
  const report = { format: 'visual-language-pronunciation-comparison', version: 1, status: 'finished', createdAt: new Date().toISOString(),
    annotationStatus: lessonCorpus.annotationStatus,
    scope: 'Marked-character diagnostic using raw lesson text. Unlike the word reader, this path does not normalize traditional spelling. Not a representative benchmark or full-sentence correctness score. Initialization timing is sequential in one process, not browser startup latency.',
    runtime: { node: process.version, icu: process.versions.icu, browser: false, modelCalls: 0 }, codeHashes, sourceReport, variants,
    savedComparisonCaveat: 'Saved-field disagreement flags a review candidate, not a pronunciation error or proof that another engine is correct. Duplicate occurrences remain separately addressable.',
    productionChanged: false, releaseReady: false }
  if (output) await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(variants.map(({ engine, summary }) => ({ engine, ...summary })), null, 2))
  // A successful diagnostic must still return failure when production has known
  // pronunciation errors. Candidate improvements are never automatic promotion.
  process.exitCode = variants[0].summary.matches === cases.length ? 0 : 1
} finally { await output?.close(); await server?.close() }
