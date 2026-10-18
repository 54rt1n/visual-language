import { z } from 'zod'

export const identifier = z.string().min(1).max(200)
export const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)
export const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const shortText = (max: number) => z.string().min(1).max(max)
export const ids = (max = 1000) => z.array(identifier).max(max)
export const policyVersion = z.literal('leitner-v1')
export const quizLevelSchema = z.enum(['meaningPinyin', 'responsePinyin', 'meaningHanzi', 'responseHanzi'])
export function uniqueIds(records: { id: string }[], label: string) {
  const set = new Set<string>()
  for (const { id } of records) {
    if (set.has(id)) throw new Error(`Duplicate ${label} ID: ${id}`)
    set.add(id)
  }
  return set
}
export function sameRecord(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameRecord(v, b[i]))
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = Object.keys(a).sort(), right = Object.keys(b).sort()
  return sameRecord(left, right) && left.every(k => sameRecord((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
