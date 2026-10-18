import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toolPrompt } from '../../src/lib/teacher/toolPrompt'
import { questionCoverageReviewSchema } from '../../src/lib/teacher/questionGapTools'

describe('schema bounds visible to generation', () => {
  it.each(['native', 'qwen_xml'] as const)('exposes the coverage explanation limit in the description and footer: %s', dialect => {
    const prompt = toolPrompt({ name: 'evaluate_question_coverage', description: 'Evaluate one question.',
      parameters: z.toJSONSchema(questionCoverageReviewSchema) }, dialect)
    expect(prompt.description).toContain('assessment: at most 1000 characters')
    expect(prompt.footer).toContain('assessment: at most 1000 characters')
    expect(prompt.footer).toContain('waypointIds: at most 9 items')
    expect(prompt.signature).toBe('evaluate_question_coverage(waypointIds: Array<string>, cardIds?: Array<string>, assessment: string)')
  })
  it('does not introduce a fabricated limit when the schema has none', () => {
    const prompt = toolPrompt({ name: 'probe', description: 'Probe.', parameters: z.toJSONSchema(z.object({ ack: z.boolean() })) })
    expect(prompt.description).not.toContain('Limits:')
    expect(prompt.footer).not.toContain('Limits:')
  })
})
