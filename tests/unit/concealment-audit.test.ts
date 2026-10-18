import { describe, expect, it } from 'vitest'
import { concealmentAudit } from '../evaluation/concealment-audit'
import type { auditPacket } from '../evaluation/lesson-quality'

const fixture = () => ({ sourceSha256: 'a'.repeat(64), units: [{ id: 'hidden-case/r1/saved-check-q1', scope: 'artifact',
  stage: 'saved_question', criteria: ['answer_hidden'], context: { settings: { quizLevel: 'meaningHanzi' }, target: 'secret-target', source: 'secret-source' },
  output: { stem: 'What does this expression mean?', passage: '谢谢', correctOptionId: 'A', explanation: 'secret-feedback',
    options: [{ id: 'A', text: 'Thanks' }, { id: 'B', text: 'Sorry' }, { id: 'C', text: 'Hello' }, { id: 'D', text: 'Goodbye' }] },
}] }) as unknown as Awaited<ReturnType<typeof auditPacket>>

describe('blind English concealment review extraction', () => {
  it('excludes hidden fields and case identity while retaining the exact visible English', () => {
    const packet = fixture(), result = concealmentAudit(packet)
    expect(result.review.questions).toEqual([{ maskedId: 1, stem: packet.units[0]!.output.stem, options: packet.units[0]!.output.options }])
    const visible = JSON.stringify(result.review)
    for (const hidden of ['secret-target', 'secret-source', 'secret-feedback', '谢谢', 'hidden-case', 'correctOptionId']) expect(visible).not.toContain(hidden)
    expect(result.mapping.units).toEqual([{ maskedId: 1, unitId: packet.units[0]!.id }])
    expect(result.mapping.sourceSha256).toBe(result.review.sourceSha256)
    result.review.questions[0]!.options[0]!.text = 'Reviewer modification'
    expect(packet.units[0]!.output.options[0].text).toBe('Thanks')
  })
  it('omits segment duplicates and questions without the concealment criterion', () => {
    const packet = fixture(), original = packet.units[0]!
    packet.units.push({ ...original, id: 'segment', scope: 'segment' }, { ...original, id: 'reply', criteria: ['answer_validity'] })
    expect(concealmentAudit(packet).review.questions).toHaveLength(1)
  })
  it('rejects malformed English fields instead of silently stripping Mandarin clues', () => {
    const packet = fixture()
    packet.units[0]!.output.stem = 'What does 谢谢 mean?'
    expect(() => concealmentAudit(packet)).toThrow('actual English-only visible text')
  })
})
