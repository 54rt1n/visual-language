import { timestamp } from '../domain/common'
import { cardSchema, type LeitnerCard, type LearningItem, type LearningSession } from '../domain/learning'

export const DAY = 86_400_000
export const LEITNER_INTERVALS = [1, 3, 7, 14, 30] as const
export type Clock = { now(): number }
export const realClock: Clock = { now: Date.now }
export class SchedulingError extends Error { name = 'SchedulingError' }

export function isDue(card: LeitnerCard, now: number): boolean {
  return card.status === 'active' && card.dueAt !== null && card.dueAt <= now
}
export function dueQueue(cards: LeitnerCard[], now: number, options: { learnerId: string; rootId?: string | null; items?: LearningItem[]; excludedIds?: string[] }) {
  timestamp.parse(now)
  const inScope = (card: LeitnerCard) => !options.rootId || Boolean(options.items?.find(i => i.id === card.itemId)?.sourceRootIds.includes(options.rootId))
  const allDue = cards.filter(c => c.learnerId === options.learnerId && isDue(c, now))
  return {
    cards: allDue.filter(c => inScope(c) && !options.excludedIds?.includes(c.id))
      .sort((a, b) => a.dueAt! - b.dueAt! || a.box - b.box || a.id.localeCompare(b.id, 'en')),
    outsideScopeCount: allDue.filter(c => !inScope(c)).length,
  }
}
export function sessionQueue(cards: LeitnerCard[], items: LearningItem[], session: LearningSession, now: number) {
  const scoped = dueQueue(cards, now, { learnerId: session.learnerId, rootId: session.rootId, items })
  const unvisited = scoped.cards.filter(c => !session.completedCardIds.includes(c.id) && !session.skippedCardIds.includes(c.id))
  const slots = Math.max(0, session.maxReviewCards - session.selectedCardIds.length)
  return { ...scoped, cards: unvisited.filter(c => session.selectedCardIds.includes(c.id) || slots > 0).slice(0, slots + unvisited.filter(c => session.selectedCardIds.includes(c.id)).length),
    remainingDueCount: scoped.cards.length,
    // Skipping an overdue card doesn't exhaust the real queue or unlock new material.
    canIntroduce: scoped.cards.length === 0 && session.introducedItemIds.length < session.maxNewItems }
}

function checkTime(card: LeitnerCard, at: number) {
  timestamp.parse(at)
  if (card.lastTransitionAt !== null && at < card.lastTransitionAt) throw new SchedulingError('The clock is earlier than this card’s last change. The schedule was not changed.')
}
function nextCard(card: LeitnerCard, patch: Partial<LeitnerCard>, at: number): LeitnerCard {
  checkTime(card, at)
  return cardSchema.parse({ ...card, ...patch, lastTransitionAt: at, revision: card.revision + 1 })
}
export function introduce(card: LeitnerCard, at: number): LeitnerCard {
  if (card.status !== 'new') throw new SchedulingError('Only a new card can be introduced.')
  return nextCard(card, { status: 'active', box: 1, introducedAt: at, dueAt: at + DAY }, at)
}
export function review(card: LeitnerCard, outcome: 'recalled' | 'notRecalled' | 'unresolved', at: number, eligible: boolean): LeitnerCard {
  if (!eligible || outcome === 'unresolved') return structuredClone(card)
  if (card.status !== 'active' || card.dueAt === null) throw new SchedulingError('This card is not active.')
  const box = outcome === 'recalled' ? Math.min(card.box + 1, 5) as LeitnerCard['box'] : 1
  return nextCard(card, { box, dueAt: at + LEITNER_INTERVALS[box - 1]! * DAY }, at)
}
export function suspend(card: LeitnerCard, at: number): LeitnerCard {
  if (card.status === 'suspended') throw new SchedulingError('This card is already suspended.')
  return nextCard(card, { status: 'suspended' }, at)
}
export function resume(card: LeitnerCard, at: number): LeitnerCard {
  if (card.status !== 'suspended') throw new SchedulingError('This card is not suspended.')
  return nextCard(card, { status: card.introducedAt === null ? 'new' : 'active' }, at)
}
export function exerciseMode(card: LeitnerCard, format: 'freeAnswer' | 'multipleChoice', at: number, practice = false) {
  return !practice && isDue(card, at) && (format !== 'multipleChoice' || card.skill === 'recognition') ? 'dueReview' as const : 'practice' as const
}
