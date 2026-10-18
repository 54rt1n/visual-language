import { polyphonic } from 'pinyin-pro'
import { currentReadingLexicon } from './lexicon'
import type { SavedDraft } from '../domain/workspace'

const hanzi = (text: string) => /\p{Script=Han}/u.test(text)
const toneFree = (syllable: string) => syllable.normalize('NFD').replace(/[\u0300\u0301\u0304\u030c]/g, '').normalize('NFC')

/** Lexical alternatives, not a claim to have resolved the sentence's grammar. */
export function pronunciationChoices(text: string) {
  if (text.length > 200) throw new Error('Choose a short word or phrase.')
  let offset = 0
  return [...text].flatMap(char => {
    const start = offset; offset += char.length
    if (!hanzi(char)) return []
    const normalized = currentReadingLexicon()?.normalize(char) ?? char
    const readings = [...new Set(polyphonic(normalized, { type: 'all' }).flat().filter(entry => entry.isZh).map(entry => entry.pinyin))]
    return [{ text: char, start, end: offset, readings }]
  })
}

/** Reject misaligned/fabricated syllables before saving an AI pronunciation.
 * This verifies character compatibility, NOT contextual meaning or correctness.
 */
export function validateContextualPinyin(text: string, proposed: string | null, uncertain: boolean): string | null {
  return contextualSyllables(text, proposed, uncertain)?.map(group => group.pinyin).join(' ') ?? null
}

type PronunciationGroup = { start: number; end: number; pinyin: string }
function contextualSyllables(text: string, proposed: string | null, uncertain: boolean): PronunciationGroup[] | null {
  if (proposed === null) {
    if (!uncertain) throw new Error('An unavailable pronunciation must disclose uncertainty.')
    return null
  }
  const syllables = proposed.trim().normalize('NFC').toLowerCase().split(/\s+/u), characters = pronunciationChoices(text)
  if (!characters.length) throw new Error('Choose text containing Mandarin characters.')
  const groups: PronunciationGroup[] = []
  function allowed(char: typeof characters[number], syllable: string) {
    const neutral = syllable === toneFree(syllable) && char.readings.some(reading => toneFree(reading) === syllable)
    const sandhi = (char.text === '一' && ['yí', 'yì'].includes(syllable)) || (char.text === '不' && syllable === 'bú')
    const erhuaSuffix = /[儿兒]/u.test(char.text) && syllable === 'r'
    return /^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜêńňǹḿ]+$/u.test(syllable) && (char.readings.includes(syllable) || neutral || sandhi || erhuaSuffix)
  }
  for (let index = 0, sound = 0; index < characters.length; sound++) {
    const char = characters[index]!, syllable = syllables[sound]
    if (!syllable) throw new Error('Pinyin must cover the selected Hanzi, with spaces between syllables.')
    if (allowed(char, syllable)) { groups.push({ start: char.start, end: char.end, pinyin: syllable }); index++ }
    else {
      const next = characters[index + 1]
      if (next && /[儿兒]/u.test(next.text) && next.start === char.end && syllable.endsWith('r') && allowed(char, syllable.slice(0, -1))) {
        groups.push({ start: char.start, end: next.end, pinyin: syllable }); index += 2
      } else throw new Error('The proposed pinyin does not match the selected characters. Correct it, or return null and disclose uncertainty.')
    }
    if (index === characters.length && sound !== syllables.length - 1) throw new Error('Pinyin includes syllables outside the selected text.')
  }
  return groups
}

/** Caller supplies notes already matched to the response hash and learner settings. */
export function pronunciationOverlay(notes: SavedDraft[]) {
  const overlay = new Map<number, PronunciationGroup>()
  for (const draft of [...notes].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const note = draft.reading
    if (!note) continue
    // A newer uncertain result must clear an older confident overlapping suggestion.
    for (const [start, group] of overlay) if (start < note.end && group.end > note.start) overlay.delete(start)
    if (note.uncertain || !note.pronunciation?.pinyin) continue
    let checked: PronunciationGroup[] | null
    try { checked = contextualSyllables(note.text, note.pronunciation.pinyin, note.uncertain) } catch { continue }
    for (const group of checked!) overlay.set(note.start + group.start, { start: note.start + group.start, end: note.start + group.end, pinyin: group.pinyin })
  }
  return overlay
}

export function pronunciationFor(text: string, start: number, automatic: string, overlay: Map<number, PronunciationGroup>, local = new Map<number, PronunciationGroup>()) {
  const defaults = automatic ? automatic.split(' ') : [], syllables: string[] = []
  let offset = start, index = 0, supplied = 0, localCount = 0, complete = true, coveredUntil = start
  for (const char of text) {
    if (hanzi(char)) {
      if (offset < coveredUntil) { supplied++; index++; offset += char.length; continue }
      const suggested = overlay.get(offset), applicable = suggested && suggested.end <= start + text.length
      const contextual = local.get(offset), locallyApplicable = contextual && contextual.end <= start + text.length
      const value = applicable ? suggested.pinyin : locallyApplicable ? contextual.pinyin : defaults[index]
      if (applicable) { supplied++; coveredUntil = suggested.end }
      else if (locallyApplicable) localCount++
      if (!value) complete = false
      else syllables.push(value)
      index++
    }
    offset += char.length
  }
  return { pinyin: complete ? syllables.join(' ') : '', source: supplied === index && supplied > 0 ? 'model' : supplied > 0 ? 'mixed' : localCount === index && localCount > 0 ? 'local' : localCount > 0 ? 'local-mixed' : 'automatic' }
}
