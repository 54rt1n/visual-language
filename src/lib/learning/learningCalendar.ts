import { learningCalendarSchema, type LearningCalendar, type LearningDay } from '../domain/learningCalendar'

type Policy = Pick<LearningCalendar, 'startMinute' | 'timeZone'>
const DAY = 86_400_000
const formatters = new Map<string, Intl.DateTimeFormat>()
function parts(at: number, zone: string) {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    formatters.set(zone, formatter)
  }
  return Object.fromEntries(formatter.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]))
}
function wallTime(at: number, zone: string) {
  const p = parts(at, zone)
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!)
}
function dateAt(at: number, zone: string) {
  const p = parts(at, zone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}
const ordinal = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY
export const addLearningDays = (date: string, count: number) => new Date((ordinal(date) + count) * DAY).toISOString().slice(0, 10)

/** Resolve a wall-clock boundary: earlier occurrence in a fold, first valid
 * instant after a gap. No fixed 24-hour assumptions enter calendar arithmetic. */
export function learningDayBoundary(date: string, policy: Policy): number {
  const target = ordinal(date) * DAY + policy.startMinute * 60_000
  const offsets = new Set([-36, -12, 0, 12, 36].map(hours => {
    const sample = target + hours * 3_600_000
    return wallTime(sample, policy.timeZone) - sample
  }))
  const candidates = [...offsets].map(offset => target - offset).sort((a, b) => a - b)
  const exact = candidates.filter(at => wallTime(at, policy.timeZone) === target)
  if (exact.length) return exact[0]!
  let high = candidates.find(at => wallTime(at, policy.timeZone) > target)
  const low = candidates.filter(at => at < high! && wallTime(at, policy.timeZone) < target).at(-1)
  if (high === undefined || low === undefined) throw new Error('The learning-day boundary could not be resolved.')
  let before = low
  while (high - before > 1) {
    const middle = Math.floor((before + high) / 2)
    if (wallTime(middle, policy.timeZone) >= target) high = middle
    else before = middle
  }
  return high
}
function currentDay(at: number, policy: Policy) {
  let date = dateAt(at, policy.timeZone)
  if (at < learningDayBoundary(date, policy)) date = addLearningDays(date, -1)
  return { date, startAt: learningDayBoundary(date, policy), endAt: learningDayBoundary(addLearningDays(date, 1), policy) }
}
function day(policy: Policy, value: ReturnType<typeof currentDay>, sequence: number): LearningDay {
  return { ...policy, ...value, sequence, id: `learning-day:${sequence}:${value.startAt}` }
}

/** Lazy bootstrap. Pure projection; passing a boundary never writes or awards. */
export function resolveLearningCalendar(value: LearningCalendar, now: number, browserZone?: string): LearningCalendar {
  let calendar = learningCalendarSchema.parse(value)
  if (!Number.isFinite(now) || now < 0) throw new Error('The current learning time is invalid.')
  let policy: Policy = { startMinute: calendar.startMinute, timeZone: calendar.timeZone }
  let anchor = calendar.anchor ?? day(policy, currentDay(now, policy), 0)
  if (now >= anchor.endAt) {
    if (calendar.pending) {
      policy = { startMinute: calendar.pending.startMinute, timeZone: calendar.pending.timeZone }
      const transition = currentDay(anchor.endAt, policy)
      anchor = day(policy, { ...transition, startAt: anchor.endAt }, anchor.sequence + 1)
      calendar = { ...policy, anchor }
    }
    if (now >= anchor.endAt) {
      const current = currentDay(now, policy)
      anchor = day(policy, current, anchor.sequence + ordinal(current.date) - ordinal(anchor.date))
    }
  }
  calendar = { ...calendar, ...policy, anchor }
  if (browserZone) {
    const desired = { startMinute: calendar.pending?.startMinute ?? calendar.startMinute, timeZone: browserZone }
    if (desired.startMinute !== calendar.startMinute || desired.timeZone !== calendar.timeZone)
      calendar.pending = { ...desired, effectiveAt: anchor.endAt }
    else delete calendar.pending
  }
  return learningCalendarSchema.parse(calendar)
}

export function changeLearningDayStart(value: LearningCalendar, now: number, startMinute: number, browserZone?: string): LearningCalendar {
  const calendar = resolveLearningCalendar(value, now, browserZone)
  const desired = { startMinute, timeZone: calendar.pending?.timeZone ?? calendar.timeZone }
  if (desired.startMinute === calendar.startMinute && desired.timeZone === calendar.timeZone) delete calendar.pending
  else calendar.pending = { ...desired, effectiveAt: calendar.anchor!.endAt }
  return learningCalendarSchema.parse(calendar)
}

export function lessonReviewEligibleAt(completedAt: number, completionDay: LearningDay, intervalDays: number) {
  if (!Number.isInteger(intervalDays) || intervalDays < 1) throw new Error('Choose a positive review interval.')
  return Math.max(learningDayBoundary(addLearningDays(completionDay.date, intervalDays), completionDay), completedAt + 6 * 3_600_000)
}
