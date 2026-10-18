/** Narrow compatibility correction for the pinned ESM pronunciation engine.
 * Upstream's unknown-character path drops the suffix probability exponent,
 * periodically beating known words in long input (银行 becomes yín xíng).
 * Keep the original algorithm/dictionaries; carry its exponent in BOTH paths.
 * See docs/PINYIN-ENGINE-PATCH.md. Unknown versions/bytes fail closed.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const beforeHash = 'c10d385f99209b6871a4bd1aded1b25175cedf97f7fce9b5937d71ae7fc84bd6'
const afterHash = '48f9b270f08657ec13da5b6bbb3bcb35a40df70ef50f0a8f56f93c5a3ed9e725'
const hash = text => createHash('sha256').update(text).digest('hex')

export function correctedPinyinSource(version, source) {
  if (version !== '3.29.3') throw new Error('Re-audit the pinyin engine correction before changing pinyin-pro versions.')
  if (hash(source) === afterHash) return source
  if (hash(source) !== beforeHash) throw new Error('Unexpected pinyin engine source. No patch applied; reinstall the locked dependency and re-audit.')
  const before = 'probability: 1e-13 /* Probability.Unknown */ * suffixDP.probability,\r\n            decimal: 0,'
  const corrected = source.replace(before, before.replace('decimal: 0', 'decimal: suffixDP.decimal'))
  if (hash(corrected) !== afterHash) throw new Error('Pinyin correction failed its expected-output check. No patch applied.')
  return corrected
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packagePath = createRequire(import.meta.url).resolve('pinyin-pro/package.json')
  const { version } = JSON.parse(await readFile(packagePath, 'utf8'))
  const path = join(dirname(packagePath), 'dist/esm/common/segmentit/max-probability.mjs')
  const source = await readFile(path, 'utf8'), corrected = correctedPinyinSource(version, source)
  if (corrected !== source) await writeFile(path, corrected)
  console.log('Verified pinned pinyin-pro ESM probability correction.')
}
