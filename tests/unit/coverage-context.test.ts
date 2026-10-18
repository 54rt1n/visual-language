import { describe, expect, it } from 'vitest'
import saved from '../evaluation/focused-cases/coverage-projector-wire-parity-flashnext.json'
import { projectCoverageContext, validateCoverageSubmission } from '../../src/lib/teacher/lessonGeneration/coverageContext'
import { protocolCase, protocolFixture, runProtocolControl } from '../evaluation/native-protocol-controls'
import { parseToolContext } from '../fixtures/tool-context'
const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', compatibility: 'featherless' as const }
describe('shared production coverage projection', () => {
  it.each([{ ids: ['w9'] }, { ids: ['w1', 'w1'] }])('retains reference validation outside recognition filtering: $ids', ({ ids }) => {
    const context = { ...saved.context, settings: { ...saved.context.settings, focus: 'complexity' } }
    expect(() => validateCoverageSubmission(context as any, saved.reviewedQuestion, ids)).toThrow('unknown or repeated')
  })

  it('reproduces an actual terminal production request without exposing its reviewed key', () => {
    const { generationMode: _mode, ...context } = saved.context
    const projected = projectCoverageContext(context as any, saved.reviewedQuestion, context.question.id)
    expect(JSON.parse(JSON.stringify(projected))).toEqual(context)
    expect(JSON.stringify(projected)).toBe(JSON.stringify(context))
    expect(projected.question).not.toHaveProperty('correctOptionId')
    expect(projected.question.options.every(option => Object.keys(option).sort().join(',') === 'id,text')).toBe(true)
  })
  it.each(['guarded-coverage-apology', 'guarded-coverage-thanks', 'guarded-coverage-reply-apology', 'guarded-coverage-reply-thanks'] as const)('uses production eligibility and the schema boundary for %s', async id => {
    const control = protocolCase(id), context = parseToolContext(control.messages[1]!.content!)
    const expected = id.endsWith('thanks') ? 'w1' : 'w2'
    expect(context.recognitionEligibleWaypointIds).toEqual([expected])
    expect(context.question).not.toHaveProperty('correctOptionId')
    expect(control.schema.safeParse({ waypointIds: ['w1', 'w2'], assessment: 'Wrong distractor credit.' }).success).toBe(false)
    expect(await runProtocolControl(id, { provider, responseMode: 'stream', toolChoice: 'named', thinking: false, transport: protocolFixture })).toMatchObject({ contractAccepted: true, expectedFieldsMatch: true })
  })
  it('removes stale eligibility when the focus no longer calls for recognition filtering', () => {
    const context = { ...saved.context, settings: { ...saved.context.settings, focus: 'complexity' } }
    const projected = projectCoverageContext(context as any, saved.reviewedQuestion, context.question.id)
    expect(projected).not.toHaveProperty('recognitionEligibleWaypointIds')
  })
})
