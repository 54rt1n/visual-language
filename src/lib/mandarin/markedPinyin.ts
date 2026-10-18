import { convert } from 'pinyin-pro'

/** CC-CEDICT/G2pW use tone 5 for neutral; pinyin-pro's converter expects 0. */
export function markedPinyin(numbered: string): string {
  return convert(numbered.replaceAll('u:', 'ü').replace(/5(?=\s|$)/gu, '0'), { format: 'numToSymbol' })
}

/** A missing upstream romanization is not pinyin. Keep the basic reader fallback. */
export function modelPinyin(numbered: string): string | undefined {
  return /^[a-züê]+[1-5]$/u.test(numbered) ? markedPinyin(numbered) : undefined
}
