import { createHash } from 'node:crypto'
import { readFile, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'

// Runs the real current automatic reader. No credentials, model calls, learner
// database, corrections from the corpus, or implied linguistic certification.
const args = process.argv.slice(2)
if (args.length && (args.length !== 2 || args[0] !== '--out' || args[1].startsWith('--'))) throw new Error('Usage: node scripts/evaluate-reading.mjs [--out NEW_FILE]')
let output, server
try {
  if (args.length) output = await open(resolve(args[1]), 'wx', 0o600)
  server = await createServer({ configFile: false, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true }, ssr: { noExternal: ['pinyin-pro', '@pinyin-pro/data'] } })
  const { readingCorpus, readingCases, numberedSyllable } = await server.ssrLoadModule('/tests/evaluation/reading-corpus.ts')
  const { readingTokens, readingSelection } = await server.ssrLoadModule('/src/lib/mandarin/reading.ts')
  const { loadReadingLexicon } = await server.ssrLoadModule('/src/lib/mandarin/lexicon.ts')
  const lexicon = await loadReadingLexicon()
  const results = readingCases.map(entry => {
    const page = readingTokens(entry.text, lexicon), selection = readingSelection(entry.text, entry.start, entry.end)
    const token = page.tokens.find(token => token.start <= entry.start && token.end >= entry.end)
    // Corpus targets are BMP Han characters. Use code-point position within the
    // actual token; never infer an occurrence from a word's first indexOf.
    const syllableIndex = [...token.text.slice(0, entry.start - token.start)].filter(char => /\p{Script=Han}/u.test(char)).length
    const pagePinyin = token.pinyin.split(/\s+/u)[syllableIndex] ?? '', selectionPinyin = selection.pinyin
    return { id: entry.id, tag: entry.tag, text: entry.text, start: entry.start, end: entry.end, target: entry.target, expected: entry.expected,
      pagePinyin, selectionPinyin, actual: numberedSyllable(selectionPinyin), matches: numberedSyllable(selectionPinyin) === entry.expected,
      pageSelectionAgree: numberedSyllable(pagePinyin) === numberedSyllable(selectionPinyin), sourcePreserved: page.tokens.map(token => token.text).join('') === entry.text }
  })
  const codeHashes = Object.fromEntries(await Promise.all(['src/lib/mandarin/reading.ts', 'src/lib/mandarin/lexicon.ts', 'scripts/patch-pinyin.mjs', 'tests/evaluation/reading-corpus.ts'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
  const summary = { total: results.length, matches: results.filter(row => row.matches).length, pageSelectionMismatches: results.filter(row => !row.pageSelectionAgree).length, sourceFailures: results.filter(row => !row.sourcePreserved).length }
  const report = { format: 'visual-language-reading-evaluation', version: 1, status: 'finished', createdAt: new Date().toISOString(), engine: 'current-automatic-reader',
    corpusVersion: readingCorpus.version, corpusHash: createHash('sha256').update(await readFile('tests/evaluation/reading-pronunciation.json')).digest('hex'),
    annotationStatus: readingCorpus.annotationStatus, scope: readingCorpus.scope, codeHashes, runtime: { node: process.version, browser: false, modelCalls: 0 }, summary, results }
  if (output) await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...summary, failures: results.filter(row => !row.matches || !row.pageSelectionAgree || !row.sourcePreserved) }, null, 2))
  process.exitCode = summary.matches === summary.total && !summary.pageSelectionMismatches && !summary.sourceFailures ? 0 : 1
} finally { await output?.close(); await server?.close() }
