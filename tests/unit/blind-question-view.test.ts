import { describe, expect, it } from 'vitest'
import { blindQuestionView } from '../evaluation/blind-question-view'
import { protocolCase } from '../evaluation/native-protocol-controls'
import { parseToolContext } from '../fixtures/tool-context'

describe('English-only inference boundary', () => {
  it('allows only visible English, independently of the caller-owned key, feedback, passage and targets', () => {
    const candidate = { stem: 'Which situation fits?', answerA: 'Gratitude.', answerB: 'Apology.', answerC: 'Greeting.', answerD: 'Farewell.',
      correct: 'A', feedback: 'The key is A.', passage: '谢谢', target: { meaning: 'thank you' }, objective: 'Gratitude' }
    const before = structuredClone(candidate)
    expect(blindQuestionView(candidate)).toEqual({ stem: candidate.stem, choices: [
      { id: 'A', text: 'Gratitude.' }, { id: 'B', text: 'Apology.' }, { id: 'C', text: 'Greeting.' }, { id: 'D', text: 'Farewell.' },
    ] })
    expect(candidate).toEqual(before)
  })
  it.each(['blind-neutral', 'blind-key-leak', 'blind-reading-leak'] as const)('compiles %s without lesson hints or the authored key', id => {
    const control = protocolCase(id), view = parseToolContext(control.messages[1]!.content!)
    expect(Object.keys(view)).toEqual(['stem', 'choices'])
    expect(view.choices.map((choice: { id: string }) => choice.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(JSON.stringify(control.messages)).not.toMatch(/\p{Script=Han}/u)
    expect(JSON.stringify(view)).not.toMatch(/correct|feedback|objective|target|evaluation-card/)
    expect(control.tool.function.name).toBe('solve_english_question')
  })
  it('rejects Mandarin or empty values in the visible English fields', () => {
    const candidate = { stem: 'Which meaning?', answerA: 'Thanks.', answerB: 'Sorry.', answerC: 'Hello.', answerD: 'Bye.' }
    expect(() => blindQuestionView({ ...candidate, stem: 'Which meaning of 谢谢?' })).toThrow('without Hanzi')
    expect(() => blindQuestionView({ ...candidate, answerA: '' })).toThrow('nonempty English')
  })
})
