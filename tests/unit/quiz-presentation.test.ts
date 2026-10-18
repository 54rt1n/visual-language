import { describe, expect, it } from 'vitest'
import saved from '../evaluation/focused-cases/missing-question-marker-flashnext.json'
import { parseToolContext } from '../fixtures/tool-context'
import { questionFromWaypoint, validateWaypointQuestion } from '../../src/lib/learning/waypointQuestion'
import { quizQuestionPrompt, presentQuizQuestion, quizProposalSchema } from '../../src/lib/learning/quiz'
const context = parseToolContext(saved.sequences[0]!.precedingReview.request.messages[1]!.content!)
const input = { ...context, sources: context.sources.filter((source: any) => context.waypoints.some((waypoint: any) => waypoint.sourceIds.includes(source.id))) }
const authored = { ...context.candidate, stem: 'What does this expression state about paper?' }
const question = () => questionFromWaypoint(authored, context.gap, context.graph, input)
const replyQuestion = () => ({ ...question(), stem: 'Which Mandarin reply instructs them to sort the waste into the appropriate bins?',
  options: [
    { id: 'A', text: '请分类投放垃圾。' }, { id: 'B', text: '请放进回收箱。' },
    { id: 'C', text: '纸张可以回收利用。' }, { id: 'D', text: '展览结束了。' },
  ], correctOptionId: 'A' })
describe('quiz presentation matches the plain text renderer', () => {
  it.each(['responsePinyin', 'responseHanzi'] as const)('withholds a verbatim reply inside longer context in %s', level => {
    for (const passage of ['请分类投放垃圾。', '展览结束后，请分类投放垃圾。', '展览结束后，请 分 类 投 放 垃 圾！']) {
      expect(() => presentQuizQuestion({ ...replyQuestion(), passage }, level)).toThrow('repeats the correct reply')
    }
  })
  it('preserves preceding dialogue, shared vocabulary and multiple mentioned alternatives', () => {
    for (const passage of ['您想喝什么？', '垃圾应该怎么投放？', '请分类投放垃圾，纸张可以回收利用。']) {
      expect(presentQuizQuestion({ ...replyQuestion(), passage }, 'responseHanzi').passage).toBe(passage)
    }
    expect(presentQuizQuestion({ ...replyQuestion(), passage: undefined }, 'responseHanzi').passage).toBeUndefined()
    // Comprehension deliberately displays the expression being interpreted.
    expect(presentQuizQuestion(question(), 'meaningHanzi').passage).toBe(question().passage)
  })
  it('does not mistake 好 inside the greeting 你好 for an agreeing reply', () => {
    const candidate = { ...replyQuestion(), passage: '你好，请坐。',
      stem: 'Someone greets you and invites you to sit. You agree to sit. Which reply is appropriate?',
      options: [{ id: 'A', text: '好。' }, { id: 'B', text: '不用。' }, { id: 'C', text: '再见。' }, { id: 'D', text: '谢谢。' }] }
    expect(presentQuizQuestion(candidate, 'responseHanzi').passage).toBe(candidate.passage)
    expect(() => presentQuizQuestion({ ...candidate, passage: '好。' }, 'responseHanzi')).toThrow('repeats the correct reply')
  })
  it.each(['It is not a request to add sugar (B).', 'Option C describes a different material.', 'The answer D does not fit.'])('rejects feedback with unstable choice letters: %s', explanation => {
    expect(() => validateWaypointQuestion({ ...question(), explanation }, context.gap.cardId, input, context.phase)).toThrow('not letters')
    const wrong = question().distractorFeedback.map((feedback, index) => index === 0 ? { ...feedback, explanation } : feedback)
    expect(() => validateWaypointQuestion({ ...question(), distractorFeedback: wrong }, context.gap.cardId, input, context.phase)).toThrow('not letters')
  })
  it('labels source excerpts and new examples without changing Mandarin or pronunciation', () => {
    const original = validateWaypointQuestion(question(), context.gap.cardId, input, context.phase)
    const passage = '塑料可以回收利用，所以请放进回收箱。'
    const example = validateWaypointQuestion({ ...original, passage }, context.gap.cardId, input, 'check')
    expect(original.passageOrigin).toBe('source')
    expect(quizQuestionPrompt(original)).toBe(`From your reading:\n${original.passage}\n\n${original.stem}`)
    expect(example.passageOrigin).toBe('new_example')
    expect(quizQuestionPrompt(example)).toBe(`New example:\n${passage}\n\n${example.stem}`)
    expect(example.passage).toBe(passage)
    expect(example.passagePinyin).not.toMatch(/New example/)
    expect(presentQuizQuestion(example, 'meaningHanzi').passageOrigin).toBe('new_example')
    expect(quizProposalSchema.shape.questions.element.shape).not.toHaveProperty('passageOrigin')
  })
  it('does not label other lesson kinds or absent reply context', () => {
    const original = question()
    const topic = validateWaypointQuestion(original, context.gap.cardId, { ...input, kind: 'topic' }, context.phase)
    expect(topic.passageOrigin).toBeUndefined()
    expect(quizQuestionPrompt(topic)).toBe(`${topic.passage}\n\n${topic.stem}`)
    expect(quizQuestionPrompt({ ...topic, passage: undefined })).toBe(topic.stem)
  })
  it('rejects the actual accepted underlined-expression stem', () => {
    expect(() => validateWaypointQuestion({ ...question(), stem: context.candidate.stem }, context.gap.cardId, input, context.phase)).toThrow('does not underline')
  })
  it.each(['highlighted phrase', 'bold word', 'italicized term', 'circled Chinese character', 'marked target expression'])('rejects a reference to an absent %s', marker => {
    expect(() => validateWaypointQuestion({ ...question(), stem: `What does the ${marker} mean?` }, context.gap.cardId, input, context.phase)).toThrow('does not underline')
  })
  it.each(['What does this expression state about paper?', 'Which action does this sign request?', 'What is the highlight of this notice?', 'Which instruction describes handling coloured paper?'])('preserves ordinary source wording: %s', stem => {
    expect(validateWaypointQuestion({ ...question(), stem }, context.gap.cardId, input, context.phase).stem).toBe(stem)
  })
})
