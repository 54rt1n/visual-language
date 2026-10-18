import { englishOnlyUnit } from './lesson-quality-grader'
import type { auditPacket } from './lesson-quality'

/** Review sheet contains visible English only; keep its identity map out of reviewer context. */
export function concealmentAudit(packet: Awaited<ReturnType<typeof auditPacket>>) {
  const selected = packet.units.filter(unit => unit.scope === 'artifact' && unit.stage === 'saved_question' && unit.criteria.includes('answer_hidden'))
  return {
    review: { format: 'visual-language-blind-concealment-review', version: 1, sourceSha256: packet.sourceSha256,
      instruction: 'Using only each stem and its English choices, can you identify one uniquely supported answer? Explain the exact English clue if so. Otherwise record unresolved; do not guess from option position, frequency or familiarity. No Mandarin, key, target or feedback is available.',
      questions: selected.map((unit, index) => ({ maskedId: index + 1, ...structuredClone(englishOnlyUnit(unit)) })) },
    mapping: { format: 'visual-language-concealment-identity-map', version: 1, sourceSha256: packet.sourceSha256,
      units: selected.map((unit, index) => ({ maskedId: index + 1, unitId: unit.id })) },
  }
}
