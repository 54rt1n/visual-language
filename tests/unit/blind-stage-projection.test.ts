import { describe, expect, it } from 'vitest'
import { executeLessonStage } from '../../src/lib/teacher/lessonGeneration/executeStage'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import { parseToolProjection } from '../fixtures/tool-context'
import { waypointResult } from '../fixtures/topic-lesson'
import { presentQuizQuestion } from '../../src/lib/learning/quiz'

const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', compatibility: 'featherless' as const }
const context = { kind: 'topic' as const, settings: { quizLevel: 'meaningHanzi' as const, complexity: 'phrases' as const,
  scope: 'everyday' as const, focus: 'characters' as const, topic: 'SECRET_TOPIC' }, phase: 'practice' as const,
  graph: { overview: 'SECRET_GRAPH', waypoints: [] }, target: 'SECRET_TARGET',
  candidate: { stem: 'Which situation fits this expression?', passage: '谢谢', answerA: 'Receiving help.', answerB: 'Making a mistake.',
    answerC: 'Meeting someone.', answerD: 'Leaving a room.', correct: 'A', feedback: 'SECRET_FEEDBACK' } }

describe('isolated English solver stage', () => {
  it('projects visible pronunciation by format without keys, feedback or profile clues on initial and repair requests', async () => {
    for (const level of ['meaningPinyin', 'meaningHanzi', 'responsePinyin', 'responseHanzi'] as const) {
      const meaning = level.startsWith('meaning'), showPinyin = level.endsWith('Pinyin')
      const question = presentQuizQuestion({ cardId: 'SECRET_TARGET', stem: 'Which choice fits?', passage: '谢谢',
        options: (meaning ? ['Thank you', 'Sorry', 'Hello', 'Goodbye'] : ['你好', '再见', '不客气', '对不起']).map((text, i) => ({ id: 'ABCD'[i]!, text })),
        correctOptionId: meaning ? 'A' : 'C', explanation: 'SECRET_FEEDBACK', distractorFeedback: [], sourceIds: ['SECRET_SOURCE'], objective: 'SECRET_OBJECTIVE' }, level)
      let calls = 0
      const solved = await executeLessonStage({ provider, modelProfile: { id: 'isolated-visible', version: '1', taskPlacement: 'user_context_tail',
        guidance: 'SECRET_GLOBAL', comprehensionGuidance: 'SECRET_DIRECTION', protocol: { toolResponseDialect: 'qwen_xml' },
        stages: { solveVisibleQuestion: { guidance: 'SECRET_STAGE' } } }, transport: async request => {
        calls++
        const input = parseToolProjection(request.messages[1]!.content!)
        for (const secret of ['SECRET_TARGET', 'SECRET_FEEDBACK', 'SECRET_SOURCE', 'SECRET_OBJECTIVE', 'SECRET_GLOBAL', 'SECRET_DIRECTION', 'SECRET_STAGE', 'SECRET_GRAPH']) expect(JSON.stringify(request.messages)).not.toContain(secret)
        expect(input.prompt).toContain('谢谢')
        expect(Boolean(input.passagePinyin)).toBe(showPinyin)
        expect(input.choices.some((choice: { pinyin?: string }) => choice.pinyin)).toBe(!meaning && showPinyin)
        for (const key of ['question', 'correctOptionId', 'candidate', 'graph', 'target', 'settings', 'generationMode']) expect(input).not.toHaveProperty(key)
        expect(request.messages.map(message => message.role)).toEqual(['system', 'user'])
        return waypointResult(request, { answerIds: calls === 1 ? ['A', 'A'] : ['A', 'D'], reason: 'Authored solver observation.' })
      } }, lessonStages.solveVisibleQuestion, { ...context, question })
      expect(calls).toBe(2)
      expect(solved.value.answerIds).toEqual(['A', 'D'])
    }
  })
  it.each(['system', 'user_context_tail'] as const)('keeps hidden content out of first and correction requests with %s task placement', async taskPlacement => {
    let calls = 0
    const result = await executeLessonStage({ provider, modelProfile: {
      id: 'semantic-profile-isolation-control', version: '1',
      taskPlacement,
      guidance: 'SECRET_GLOBAL: 谢谢 means thank you.',
      comprehensionGuidance: 'SECRET_DIRECTION: choose the gratitude answer.',
      protocol: { toolResponseDialect: 'qwen_xml' },
      stages: { solveEnglishQuestion: { guidance: 'SECRET_STAGE: 谢谢 expresses gratitude.',
        comprehensionGuidance: 'SECRET_STAGE_DIRECTION: select A.' } },
    }, transport: async request => {
      calls++
      const all = JSON.stringify(request.messages)
      for (const hidden of ['SECRET_TOPIC', 'SECRET_GRAPH', 'SECRET_TARGET', 'SECRET_FEEDBACK', 'SECRET_GLOBAL', 'SECRET_DIRECTION', 'SECRET_STAGE', '谢谢']) expect(all).not.toContain(hidden)
      expect(request.messages[1]!.content).toContain('<tool_call><function=solve_english_question>')
      expect(request.tools?.[0]?.function.name).toBe('solve_english_question')
      expect(request.messages.map(m => m.role)).toEqual(['system', 'user'])
      const projected = parseToolProjection(request.messages[1]!.content!)
      expect(projected.stem).toBe(context.candidate.stem)
      expect(projected.choices).toHaveLength(4)
      for (const key of ['kind', 'settings', 'phase', 'graph', 'target', 'candidate', 'generationMode', 'correct', 'passage', 'feedback']) expect(projected).not.toHaveProperty(key)
      if (taskPlacement === 'user_context_tail') {
        expect(Object.keys(projected).at(-1)).toBe('currentTask')
        expect(projected.currentTask).toContain('solving the English-only view')
      }
      expect(request.generationTrace!.taskPlacement).toBe(taskPlacement)
      if (calls === 1) expect(Object.keys(projected).sort()).toEqual(taskPlacement === 'system' ? ['choices', 'learnerRequest', 'stem'] : ['choices', 'currentTask', 'learnerRequest', 'stem'])
      else expect(projected.nativeSubmissionIssue).toBeTruthy()
      return waypointResult(request, { answerId: 'unknown', reason: calls === 1 ? '' : 'The expression is unavailable.' })
    } }, lessonStages.solveEnglishQuestion, context)
    expect(calls).toBe(2)
    expect(result.value.answerId).toBe('unknown')
  })
})
