import { describe, expect, it } from 'vitest'
import { defaultLearningCalendar } from '../../src/lib/domain/learningCalendar'
import { changeLearningDayStart, learningDayBoundary, lessonReviewEligibleAt, resolveLearningCalendar } from '../../src/lib/learning/learningCalendar'

const at = (value: string) => Date.parse(value)
describe('lazy learning calendar', () => {
  it('assigns before 3am to the previous day without mutating saved preferences', () => {
    const saved = defaultLearningCalendar('America/Chicago'), before = structuredClone(saved)
    const early = resolveLearningCalendar(saved, at('2026-10-16T07:59:00Z'))
    expect(early.anchor!.date).toBe('2026-10-15')
    expect(early.anchor!.endAt).toBe(at('2026-10-16T08:00:00Z'))
    const next = resolveLearningCalendar(early, at('2026-10-16T08:00:00Z'))
    expect(next.anchor!.date).toBe('2026-10-16')
    expect(next.anchor!.sequence).toBe(early.anchor!.sequence + 1)
    expect(resolveLearningCalendar(next, at('2026-10-16T08:00:00Z'))).toEqual(next)
    expect(saved).toEqual(before)
  })
  it('resolves missed days directly and retains their gap in the sequence', () => {
    const first = resolveLearningCalendar(defaultLearningCalendar('UTC'), at('2026-10-12T12:00:00Z'))
    const next = resolveLearningCalendar(first, at('2026-10-16T12:00:00Z'))
    expect(next.anchor!.date).toBe('2026-10-16')
    expect(next.anchor!.sequence).toBe(4)
    expect(first.anchor!.date).toBe('2026-10-12')
  })
  it('uses a 23-hour spring day and the first valid instant for a skipped cutoff', () => {
    const policy = defaultLearningCalendar('America/New_York')
    expect(learningDayBoundary('2026-03-08', policy) - learningDayBoundary('2026-03-07', policy)).toBe(23 * 3_600_000)
    expect(learningDayBoundary('2026-03-08', { ...policy, startMinute: 150 })).toBe(at('2026-03-08T07:00:00Z'))
  })
  it('uses the first repeated cutoff and does not roll backward during a fall fold', () => {
    const policy = { ...defaultLearningCalendar('America/New_York'), startMinute: 90 }
    expect(learningDayBoundary('2026-11-01', policy)).toBe(at('2026-11-01T05:30:00Z'))
    expect(learningDayBoundary('2026-11-02', policy) - learningDayBoundary('2026-11-01', policy)).toBe(25 * 3_600_000)
    const first = resolveLearningCalendar(policy, at('2026-11-01T05:45:00Z'))
    const repeated = resolveLearningCalendar(first, at('2026-11-01T06:10:00Z'))
    expect(repeated.anchor).toEqual(first.anchor)
  })
  it('freezes the current day until its end when the cutoff changes', () => {
    const original = resolveLearningCalendar(defaultLearningCalendar('UTC'), at('2026-10-16T12:00:00Z'))
    const changed = changeLearningDayStart(original, at('2026-10-16T13:00:00Z'), 240)
    expect(changed.startMinute).toBe(180)
    expect(changed.anchor).toEqual(original.anchor)
    expect(changed.pending).toEqual({ startMinute: 240, timeZone: 'UTC', effectiveAt: at('2026-10-17T03:00:00Z') })
    const bridge = resolveLearningCalendar(changed, at('2026-10-17T03:30:00Z'))
    expect(bridge.startMinute).toBe(240)
    expect(bridge.pending).toBeUndefined()
    expect(bridge.anchor).toMatchObject({ sequence: 1, startAt: at('2026-10-17T03:00:00Z'), endAt: at('2026-10-17T04:00:00Z') })
    const next = resolveLearningCalendar(bridge, at('2026-10-17T04:00:00Z'))
    expect(next.anchor).toMatchObject({ sequence: 2, date: '2026-10-17' })
    expect(next.anchor!.id).not.toBe(bridge.anchor!.id)
  })
  it('applies an already-saved change after inactive days and stages new zone detection afterward', () => {
    const saved = changeLearningDayStart(defaultLearningCalendar('UTC'), at('2026-10-16T12:00:00Z'), 240)
    const resumed = resolveLearningCalendar(saved, at('2026-10-20T12:00:00Z'), 'America/Chicago')
    expect(resumed).toMatchObject({ startMinute: 240, timeZone: 'UTC', anchor: { sequence: 5, date: '2026-10-20' },
      pending: { startMinute: 240, timeZone: 'America/Chicago', effectiveAt: at('2026-10-21T04:00:00Z') } })
  })
  it('preserves day sequencing when a zone change repeats a displayed date', () => {
    const saved = resolveLearningCalendar(defaultLearningCalendar('UTC'), at('2026-10-16T12:00:00Z'), 'America/Chicago')
    const changed = resolveLearningCalendar(saved, at('2026-10-17T03:30:00Z'), 'America/Chicago')
    expect(changed.anchor!.date).toBe(saved.anchor!.date)
    expect(changed.anchor!.sequence).toBe(saved.anchor!.sequence + 1)
    expect(changed.anchor!.id).not.toBe(saved.anchor!.id)
  })
  it('cancels an unapplied cutoff change without changing the active day', () => {
    const saved = resolveLearningCalendar(defaultLearningCalendar('UTC'), at('2026-10-16T12:00:00Z'))
    const pending = changeLearningDayStart(saved, at('2026-10-16T12:00:00Z'), 240)
    expect(changeLearningDayStart(pending, at('2026-10-16T13:00:00Z'), 180)).toEqual(saved)
    expect(() => changeLearningDayStart(saved, at('2026-10-16T13:00:00Z'), 1440)).toThrow()
    expect(() => resolveLearningCalendar({ ...saved, anchor: { ...saved.anchor!, date: '2026-02-30' } }, at('2026-10-16T13:00:00Z'))).toThrow()
    expect(() => resolveLearningCalendar({ ...saved, startMinute: 240 }, at('2026-10-16T13:00:00Z'))).toThrow()
  })
  it('uses the later of the scheduled date and six elapsed hours, without rounding forward', () => {
    const completed = at('2026-10-16T22:00:00Z'), calendar = resolveLearningCalendar(defaultLearningCalendar('UTC'), completed)
    expect(lessonReviewEligibleAt(completed, calendar.anchor!, 1)).toBe(at('2026-10-17T04:00:00Z'))
    expect(lessonReviewEligibleAt(completed, calendar.anchor!, 3)).toBe(at('2026-10-19T03:00:00Z'))
    expect(lessonReviewEligibleAt(at('2026-10-16T21:00:00Z'), calendar.anchor!, 1)).toBe(at('2026-10-17T03:00:00Z'))
    expect(() => lessonReviewEligibleAt(completed, calendar.anchor!, 0)).toThrow()
  })
})
