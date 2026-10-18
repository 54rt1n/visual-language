import { pinyin } from 'pinyin-pro'

export type MandarinChunk = { text: string; pinyin: string; start: number; end: number }

/** Adapted from the owned original's chineseParser. These are Hanzi runs, not dictionary words. */
export function mandarinChunks(text: string): MandarinChunk[] {
  if (text.length > 100_000) throw new Error('Choose a shorter message to extract Mandarin chunks.')
  return [...text.matchAll(/\p{Script=Han}+/gu)].slice(0, 100).map(match => ({
    text: match[0], pinyin: mandarinPinyin(match[0]), start: match.index, end: match.index + match[0].length,
  }))
}
export function mandarinPinyin(text: string): string {
  if (text.length > 4000) throw new Error('Choose a shorter Mandarin phrase for pinyin.')
  return pinyin(text, { toneType: 'symbol', nonZh: 'consecutive' })
}
export function containsHanzi(text: string) { return /\p{Script=Han}/u.test(text) }

/** Conservative prompt guard, deliberately separate from answer grading. */
export function revealsProductionAnswer(prompt: string, answers: string[]): boolean {
  const folded = ` ${prompt.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[1-5]/g, '').replace(/[^a-z]+/g, ' ')} `
  return answers.some(answer => {
    const value = answer.trim().normalize('NFC')
    if (!value) return false
    if (prompt.normalize('NFC').includes(value)) return true
    if (!containsHanzi(value)) return false
    const romanized = mandarinPinyin(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim()
    return Boolean(romanized && (folded.includes(` ${romanized} `) || folded.includes(` ${romanized.replace(/ /g, '')} `)))
  })
}
