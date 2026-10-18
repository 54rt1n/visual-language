import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pinyin } from 'pinyin-pro'
import { correctedPinyinSource } from '../../scripts/patch-pinyin.mjs'

describe('pinned pronunciation engine arithmetic', () => {
  it('retains known polyphonic words across probability scaling in long input', () => {
    for (const repetitions of [10, 50, 100, 350, 1350]) {
      const result = pinyin('银行'.repeat(repetitions), { type: 'array' })
      expect(result).toEqual(Array.from({ length: repetitions }, () => ['yín', 'háng']).flat())
    }
    expect(pinyin('银行行长喜欢音乐。')).toBe('yín háng háng zhǎng xǐ huan yīn yuè 。')
  })

  it('is byte-checked, idempotent and refuses an unreviewed dependency or source', async () => {
    const packagePath = createRequire(import.meta.url).resolve('pinyin-pro/package.json')
    const { version } = JSON.parse(await readFile(packagePath, 'utf8'))
    const source = await readFile(join(dirname(packagePath), 'dist/esm/common/segmentit/max-probability.mjs'), 'utf8')
    expect(correctedPinyinSource(version, source)).toBe(source)
    const original = source.replace('probability: 1e-13 /* Probability.Unknown */ * suffixDP.probability,\r\n            decimal: suffixDP.decimal,',
      'probability: 1e-13 /* Probability.Unknown */ * suffixDP.probability,\r\n            decimal: 0,')
    expect(original).not.toBe(source)
    expect(correctedPinyinSource(version, original)).toBe(source)
    expect(() => correctedPinyinSource('3.29.4', source)).toThrow('Re-audit')
    expect(() => correctedPinyinSource(version, source + '\n')).toThrow('Unexpected')
  })
})
