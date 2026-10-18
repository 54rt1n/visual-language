import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Plugin } from 'vite'

const MAX_SHELL_BYTES = 1.5 * 1024 * 1024
const MAX_LANGUAGE_BYTES = 3 * 1024 * 1024
const MAX_MEANING_BYTES = 4.25 * 1024 * 1024
const MAX_AVATAR_BYTES = 1.5 * 1024 * 1024
const MAX_AVATAR_LIBRARY_BYTES = 7 * 1024 * 1024
const MAX_TOKENIZER_BYTES = 2 * 1024 * 1024

/** Exact build inventory; no request-driven cache growth or API caching. */
export function pwaPlugin(): Plugin {
  let root = ''
  return {
    name: 'visual-language-shell', apply: 'build', enforce: 'post',
    configResolved(config) { root = config.root },
    // Vite finalizes lazy-import preload URLs during generateBundle. Inventory
    // and hash the resulting bytes, not its earlier import-analysis placeholders.
    generateBundle: { order: 'post', handler(_options, bundle) {
      const publicDir = join(root, 'public')
      const dictionary = JSON.parse(readFileSync(join(root, 'src/lib/mandarin/dictionarySnapshot.json'), 'utf8')) as { file: string; bytes: number; sha256: string }
      if (!/^cc-cedict-\d{8}-[a-f0-9]{8}\.txt\.gz$/.test(dictionary.file)) throw new Error('Invalid dictionary asset path.')
      const dictionaryFile = `dictionaries/${dictionary.file}`, dictionaryBytes = readFileSync(join(publicDir, dictionaryFile))
      if (dictionaryBytes.byteLength !== dictionary.bytes || createHash('sha256').update(dictionaryBytes).digest('hex') !== dictionary.sha256) throw new Error('Reading dictionary differs from the pinned snapshot.')
      const meaningFiles = [dictionaryFile, 'dictionaries/NOTICE.txt']
      const files: string[] = ['manifest.webmanifest', ...meaningFiles]
      function visit(folder: string) {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const path = join(folder, entry.name)
          if (entry.isDirectory()) visit(path)
          else if (/\.(png|svg|json)$/.test(entry.name)) files.push(relative(publicDir, path).replaceAll('\\', '/'))
        }
      }
      // Portraits are optional, on-demand presentation. Their absence must never
      // fail shell installation, or make text-only users download every master.
      visit(join(publicDir, 'icons'))
      const hash = createHash('sha256'), assets = Object.keys(bundle).filter(file => /\.(html|js|css)$/.test(file))
      const shellFiles: { file: string; bytes: number }[] = []
      const tokenizerFiles: { file: string; bytes: number }[] = []
      const languageFiles: string[] = []
      for (const file of assets.sort()) {
        const artifact = bundle[file]!, content = artifact.type === 'chunk' ? artifact.code : artifact.source
        hash.update(file); hash.update(content)
        const entry = { file, bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength }
        // Tokenization is only needed when preparing a network request. Saved
        // lessons and offline readers must not download its BPE vocabulary.
        if (artifact.type === 'chunk' && Object.keys(artifact.modules).some(id => id.includes('/node_modules/js-tiktoken/'))) {
          tokenizerFiles.push(entry)
          continue
        }
        shellFiles.push(entry)
        if (artifact.type === 'chunk' && Object.keys(artifact.modules).some(id => id.includes('/node_modules/@pinyin-pro/data/'))) languageFiles.push(file)
      }
      for (const file of files.sort()) { const content = readFileSync(join(publicDir, file)); hash.update(file); hash.update(content); shellFiles.push({ file, bytes: content.byteLength }) }
      const shellBytes = shellFiles.reduce((total, item) => total + item.bytes, 0)
      const languageBytes = shellFiles.filter(item => languageFiles.includes(item.file)).reduce((total, item) => total + item.bytes, 0)
      const meaningBytes = shellFiles.filter(item => meaningFiles.includes(item.file)).reduce((total, item) => total + item.bytes, 0)
      const coreBytes = shellBytes - languageBytes - meaningBytes
      const tokenizerBytes = tokenizerFiles.reduce((total, item) => total + item.bytes, 0)
      if (coreBytes > MAX_SHELL_BYTES) throw new Error(`Required core shell exceeds its ${MAX_SHELL_BYTES}-byte budget (${coreBytes}). Review delivery cost before publishing.`)
      if (languageBytes > MAX_LANGUAGE_BYTES) throw new Error(`Local reading dictionaries exceed their ${MAX_LANGUAGE_BYTES}-byte budget (${languageBytes}). Review delivery cost before publishing.`)
      if (meaningBytes > MAX_MEANING_BYTES) throw new Error('English dictionary exceeds its separately reviewed 4.25 MiB asset budget.')
      if (tokenizerBytes > MAX_TOKENIZER_BYTES) throw new Error('The on-demand tokenizer exceeds its 2 MiB asset budget; include only the required encoding.')
      const manifest = JSON.parse(readFileSync(join(publicDir, 'avatars/zheng/manifest.json'), 'utf8')) as { defaultState: string; states: Record<string, { file: string }> }
      const expected = ['attentive', 'welcome', 'thinking', 'encouraging', 'gentleCorrection'].sort()
      if (manifest.defaultState !== 'attentive' || JSON.stringify(Object.keys(manifest.states).sort()) !== JSON.stringify(expected)) throw new Error('Portrait manifest must use the five reviewed states and attentive fallback.')
      const portraits = Object.entries(manifest.states).map(([state, value]) => {
        if (!/^[a-z-]+-v1\.png$/.test(value.file)) throw new Error('Portrait filenames must resolve to reviewed local PNG masters.')
        const file = `avatars/zheng/${value.file}`, content = readFileSync(join(publicDir, file))
        if (content.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || content.readUInt32BE(16) !== 1254 || content.readUInt32BE(20) !== 1254) throw new Error('Portrait master dimensions changed; review the asset contract.')
        if (content.byteLength > MAX_AVATAR_BYTES) throw new Error(`Portrait ${state} exceeds its ${MAX_AVATAR_BYTES}-byte on-demand budget.`)
        return { state, file, bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }
      })
      const portraitBytes = portraits.reduce((total, item) => total + item.bytes, 0)
      if (portraitBytes > MAX_AVATAR_LIBRARY_BYTES) throw new Error('Optional portrait library exceeds its reviewed asset budget.')
      const pronunciation = JSON.parse(readFileSync(join(root, 'src/lib/mandarin/readingModelManifest.json'), 'utf8')) as { directory: string; bytes: number; files: { file: string; bytes: number; sha256: string }[] }
      if (pronunciation.directory !== 'reading-model/g2pw-v2-int4-1/' || pronunciation.bytes > 82_000_000) throw new Error('Optional pronunciation pack exceeds its reviewed delivery budget.')
      for (const asset of pronunciation.files) {
        if (!/^[A-Za-z0-9.-]+$/.test(asset.file)) throw new Error('Invalid pronunciation asset path.')
        const bytes = readFileSync(join(publicDir, pronunciation.directory, asset.file))
        if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('Pronunciation asset differs from the pinned pack.')
      }
      this.emitFile({ type: 'asset', fileName: 'asset-budget.json', source: JSON.stringify({ version: 2, units: 'artifact bytes before HTTP content encoding; dictionary archive remains gzip',
        shell: { bytes: shellBytes, limit: MAX_SHELL_BYTES + MAX_LANGUAGE_BYTES + MAX_MEANING_BYTES, files: shellFiles,
          core: { bytes: coreBytes, limit: MAX_SHELL_BYTES },
          meanings: { bytes: meaningBytes, limit: MAX_MEANING_BYTES, files: meaningFiles, policy: 'pinned full dictionary; indexed off-thread on first word selection; precached for offline lookup' },
          language: { bytes: languageBytes, limit: MAX_LANGUAGE_BYTES, files: languageFiles, policy: 'loaded when reading; precached locally for saved responses' } },
        tokenizer: { policy: 'loaded on first generation; excluded from the required offline shell', bytes: tokenizerBytes, limit: MAX_TOKENIZER_BYTES, files: tokenizerFiles },
        portraits: { policy: 'on demand; never required or cached by the service worker', bytes: portraitBytes, limit: MAX_AVATAR_LIBRARY_BYTES, perFileLimit: MAX_AVATAR_BYTES, files: portraits },
        pronunciation: { ...pronunciation, limit: 82_000_000, policy: 'explicit device download only; hash-verified resource cache; never required by the service worker or included in learner backups' } }, null, 2) })
      const template = readFileSync(join(root, 'scripts/service-worker.js'), 'utf8')
      hash.update(template) // A policy-only worker update also needs its own cache version.
      const version = hash.digest('hex').slice(0, 16)
      const source = template
        .replace('__BUILD_VERSION__', JSON.stringify(version)).replace('__SHELL_FILES__', JSON.stringify(shellFiles.map(entry => entry.file)))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    } },
  }
}
