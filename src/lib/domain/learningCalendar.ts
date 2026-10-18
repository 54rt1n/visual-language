import { z } from 'zod'
import { identifier, timestamp } from './common'

export const timeZoneSchema = z.string().min(1).max(100).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return !/^[+-]/.test(value) } catch { return false }
}, 'Choose a valid IANA time zone.')
const startMinute = z.number().int().min(0).max(1439)
export const learningDaySchema = z.strictObject({
  id: identifier, sequence: z.number().int().nonnegative(), date: z.iso.date(),
  timeZone: timeZoneSchema, startMinute, startAt: timestamp, endAt: timestamp,
}).refine(day => day.endAt > day.startAt, 'A learning day must end after it starts.')

export const learningCalendarSchema = z.strictObject({
  startMinute, timeZone: timeZoneSchema,
  anchor: learningDaySchema.optional(),
  pending: z.strictObject({ startMinute, timeZone: timeZoneSchema, effectiveAt: timestamp }).optional(),
}).refine(calendar => !calendar.pending || Boolean(calendar.anchor && calendar.pending.effectiveAt === calendar.anchor.endAt),
  'A calendar change takes effect after the anchored learning day.')
  .refine(calendar => !calendar.anchor || (calendar.anchor.timeZone === calendar.timeZone && calendar.anchor.startMinute === calendar.startMinute),
    'The anchored learning day must use the active calendar policy.')

export type LearningCalendar = z.infer<typeof learningCalendarSchema>
export type LearningDay = z.infer<typeof learningDaySchema>
export function defaultLearningCalendar(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): LearningCalendar {
  return learningCalendarSchema.parse({ startMinute: 180, timeZone })
}
