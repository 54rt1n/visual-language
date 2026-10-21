import { waypointResult } from '../fixtures/topic-lesson'
import { parseToolContext } from '../fixtures/tool-context'
import { describe, expect, it, vi } from 'vitest'
import type { ChatOptions } from '../../src/lib/ai/types'
import { orderedWaypoints, validateLessonGraph, waypointContext, type LessonGraph, type WaypointLessonInput } from '../../src/lib/domain/lessonGraph'
import { buildWaypointQuiz, currentQuestionContext, projectQuizContext, prepareWaypointGraph, type ReviewedLessonGraph, type WaypointQuiz } from '../../src/lib/teacher/lessonGeneration/workflow'
import { validateGraphDraft, validateLessonPreparation, type LessonGraphDraft } from '../../src/lib/domain/lessonPreparation'
import { preparedLessonSteps } from '../../src/lib/domain/lessonPlan'
import { assertDistinctQuestion } from '../../src/lib/learning/waypointQuestion'

const input: WaypointLessonInput = {
  kind: 'topic', objective: 'Understand who receives an order and the quantity requested.', conversationContext: '请给我一杯茶。',
  settings: { quizLevel: 'meaningHanzi', complexity: 'simple', scope: 'everyday', focus: 'complexity', topic: 'Ordering tea' },
  targets: [{ cardId: 'c1', hanzi: '请给我一杯茶', meaning: 'Please give me a cup of tea.' }],
  sources: [{ id: 's1', title: 'Saved expression', excerpt: '请给我一杯茶 — Please give me a cup of tea. 我 is the speaker; 一杯 is one cup.' }],
}
const graph: LessonGraph = { overview: 'Identify the speaker as the recipient. Identify the requested quantity.', waypoints: [
  { id: 'w1', cardIds: ['c1'], dependsOn: [], objective: 'Identify the speaker as the recipient.', explanation: '我 refers to the person speaking.', exampleHanzi: '请给我一杯茶。', exampleMeaning: 'Please give me a cup of tea.', sourceIds: ['s1'] },
  { id: 'w2', cardIds: ['c1'], dependsOn: ['w1'], objective: 'Identify the requested quantity.', explanation: '一杯 specifies one cup.', exampleHanzi: '请给我一杯茶。', exampleMeaning: 'Please give me a cup of tea.', sourceIds: ['s1'] },
] }
const reviewed: ReviewedLessonGraph = { graph, review: { decision: 'accept', reason: 'Authored fixture.', model: 'fixture' } }
const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', compatibility: 'featherless' as const }
const data = (o: ChatOptions) => parseToolContext(o.messages.filter(m => m.role === 'user').at(-1)!.content!)
const submit = waypointResult
function fixture(o: ChatOptions) {
  if (o.tools?.[0]?.function.name === 'solve_english_question') return submit(o, { answerId: 'unknown', reason: 'Authored plumbing fixture.' })
  if (o.tools?.[0]?.function.name === 'solve_visible_question') return submit(o, { answerIds: ['A'], reason: 'Authored plumbing fixture; not a semantic judgment.' })
  const d = data(o), name = d.generationMode
  if (name === 'add_lesson_waypoint' || name === 'revise_lesson_waypoint') {
    const w = d.revision?.waypointId ? graph.waypoints.find(w => w.id === d.revision.waypointId) : graph.waypoints[d.graph.waypoints.length]
    if (!w) throw new Error('Fixture has no next waypoint.')
    const { id: _id, ...fields } = w
    return submit(o, fields)
  }
  if (name === 'verify_lesson_graph' && d.graph.waypoints.length < graph.waypoints.length) return submit(o, { decision: 'add', reason: 'Add the missing learning point.' })
  if (['verify_lesson_graph', 'verify_lesson_waypoint', 'verify_correct_question'].includes(name)) return submit(o, { decision: 'accept', reason: 'Authored fixture review.' })
  if (name === 'list_missing_questions') return submit(o, { waypointId: d.remainingWaypointIds[0], cardId: 'c1', directions: graph.waypoints.filter(w => !d.coverage.some((c: any) => c.waypointId === w.id)).map(w => `${w.id}: ${w.objective}`).join('\n') })
  if (name === 'evaluate_question_coverage') return submit(o, { waypointIds: [graph.waypoints[Number(d.question.id.slice(1)) - 1]!.id], assessment: 'The actual alternatives distinguish recipient or quantity.' })
  if (name === 'revise_question_answers') return submit(o, { ...d.candidateToRevise, feedback: '我 identifies the speaker as the recipient; 一杯 specifies one cup.' })
  if (name === 'build_question_answers') {
    const w = graph.waypoints.find(w => !d.coverage.some((c: any) => c.waypointId === w.id))!
    return submit(o, {
      stem: `${d.phase === 'check' ? 'For a different request' : 'In this request'}, ${w.id === 'w1' ? 'who receives the tea?' : 'how much tea is requested?'}`,
      passage: '请给我一杯茶。', answerA: w.id === 'w1' ? 'The speaker.' : 'One cup.', answerB: w.id === 'w1' ? 'The listener.' : 'Two cups.', answerC: 'A third person.', answerD: 'Nobody.', correct: 'A', feedback: '我 is the speaker, and 一杯 is one cup.' })
  }
  throw new Error(`Unknown stage ${name}`)
}

describe('projected lesson graph workflow', () => {
  it('rejects the captured selected-task check that exactly repeats its practice projection', () => {
    const practice = { stem: 'You are a customer in a café. The server asks, "What would you like to drink?" Select the appropriate Mandarin reply to order a cup of tea politely.', passage: '您想喝什么？' }
    const authoredCheck = { ...practice }
    expect(() => assertDistinctQuestion(authoredCheck, [practice])).toThrow('This question repeats an existing question.')
    expect(() => assertDistinctQuestion({ ...authoredCheck, passage: '我给您做一杯咖啡。' }, [practice])).not.toThrow()
    // This guard rejects duplicate display text; a different stem still needs semantic review.
    expect(() => assertDistinctQuestion({ ...authoredCheck, stem: 'Which reply politely orders tea?' }, [practice])).not.toThrow()
  })
  it.each(['meaningHanzi', 'meaningPinyin'] as const)('rejects the captured repeated phrase and answer group in %s even after rewording or shuffling', quizLevel => {
    const practice = { stem: 'What does this expression mean?', passage: '谢谢。', correctOptionId: 'A' as const,
      options: [{ id: 'A' as const, text: 'Thank you.' }, { id: 'B' as const, text: "I'm sorry." },
        { id: 'C' as const, text: 'Excuse me.' }, { id: 'D' as const, text: 'Hello.' }] }
    const settings = { quizLevel, complexity: 'phrases' as const }
    const check = { ...practice, stem: 'What does the speaker mean when saying this expression?' }
    expect(() => assertDistinctQuestion(check, [practice], settings)).toThrow('same Mandarin, answer choices and correct answer')
    const shuffled = { ...check, correctOptionId: 'C' as const,
      options: practice.options.map((option, i) => ({ id: option.id, text: practice.options[(i + 2) % 4]!.text })) }
    expect(() => assertDistinctQuestion(shuffled, [practice], settings)).toThrow('same Mandarin, answer choices and correct answer')
    const usage = { ...check, stem: 'When would someone say this?', options: practice.options.map((option, i) => ({ ...option,
      text: ['Someone has helped you.', 'You made a mistake.', 'You are greeting someone.', 'You are leaving.'][i]!,
    })) }
    expect(() => assertDistinctQuestion(usage, [practice], settings)).not.toThrow()
    expect(() => assertDistinctQuestion({ ...check, passage: '对不起。' }, [practice], settings)).not.toThrow()
    expect(() => assertDistinctQuestion(check, [practice], { ...settings, complexity: 'connected' })).not.toThrow()
    expect(() => assertDistinctQuestion(check, [practice], { quizLevel: 'responseHanzi', complexity: 'phrases' })).not.toThrow()
  })
  it('bounds standalone phase preparation before dispatching beyond its action budget', async () => {
    const transport = vi.fn(fixture)
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, workflowPolicy: { maxRequests: 1 } }))
      .rejects.toMatchObject({ failure: { category: 'budget_exhausted', checkpointId: 'lesson-workflow' } })
    expect(transport).toHaveBeenCalledOnce()
    expect(data(transport.mock.calls[0]![0]).generationMode).toBe('list_missing_questions')
  })
  it('teaches evaluated coverage before practicing a question whose author selected a different gap', async () => {
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), first = (d.currentQuestions?.length ?? 0) === 0
      if (d.generationMode === 'evaluate_question_coverage') return submit(o, { waypointIds: [first ? 'w2' : 'w1'], assessment: first ? 'Choices assess quantity.' : 'Choices assess recipient.' })
      const result = fixture(o)
      if (d.generationMode === 'build_question_answers' && first) {
        const value = JSON.parse(result.toolCalls[0]!.function.arguments)
        Object.assign(value, { stem: 'How much tea is requested?', answerA: 'One cup.', answerB: 'Two cups.', answerC: 'Three cups.', answerD: 'Four cups.', feedback: '一杯 specifies one cup.' })
        result.toolCalls[0]!.function.arguments = JSON.stringify(value)
      }
      return result
    } })
    const prep = validateLessonPreparation({ input, lesson: reviewed, practice: quiz })
    const steps = preparedLessonSteps(prep, input.settings, input.kind)
    expect(quiz.questions[0]!.gap.waypointIds).toEqual(['w1'])
    expect(quiz.questions[0]!.coverageReview!.waypointIds).toEqual(['w2'])
    expect(steps.findIndex(s => s.questionId === 'q1')).toBeGreaterThan(steps.findIndex(s => s.waypointId === 'w2'))
  })
  it.each(['passage', 'answerA'] as const)('preserves rejected missing-%s evidence across resume without accepting it', async missing => {
    const controller = new AbortController()
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, signal: controller.signal, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'build_question_answers' && d.currentQuestions.length) {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments); delete args[missing]
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => {
      checkpoint = structuredClone(q)
      if (q.replanning) controller.abort()
    } })).rejects.toThrow()
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(1)
    expect(checkpoint!.pending).toBeUndefined()
    const accepted = structuredClone(checkpoint!.questions[0])
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, checkpoint, transport: fixture })
    expect(quiz.complete).toBe(true)
    expect(quiz.questions[0]).toEqual(accepted)
    expect(quiz.questions[1]!.question.passage).toBeDefined()
    expect(quiz.replanning!.rejectedDirections[0]!.candidate[missing]).toBeUndefined()
  })
  it.each(['passage', 'answerA'] as const)('bounds repeated missing-%s failures with the existing replan quota and preserves the original category', async missing => {
    let checkpoint: WaypointQuiz | undefined
    let invalidSubmissions = 0
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'build_question_answers' && d.currentQuestions.length) {
        invalidSubmissions++
        const args = JSON.parse(response.toolCalls[0]!.function.arguments); delete args[missing]
        args.stem = `How much tea is requested in case ${d.rejectedDirections?.length ?? 0}?`
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => { checkpoint = structuredClone(q) } })).rejects.toMatchObject({ failure: {
      category: 'budget_exhausted', checkpointId: 'practice-quiz', originatingFailure: { category: 'schema_invalid', stage: 'buildQuestion' } } })
    expect(invalidSubmissions).toBe(6)
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(2)
    expect(checkpoint!.questions).toHaveLength(1)
    expect(checkpoint!.pending).toBeUndefined()
    expect(checkpoint!.complete).toBe(false)
  })

  it.each(['passage', 'answerA'] as const)('replans exhausted missing-%s submissions as rejected evidence without accepting or inventing content', async missing => {
    let missingSubmissions = 0
    const checkpoints: WaypointQuiz[] = []
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'build_question_answers' && d.currentQuestions.length === 1 && !d.rejectedDirections?.length) {
        missingSubmissions++
        const args = JSON.parse(response.toolCalls[0]!.function.arguments); delete args[missing]
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      if (d.generationMode === 'build_question_answers' && d.rejectedDirections?.length) {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = 'How many cups does this request ask for?'
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => { checkpoints.push(structuredClone(q)) } })
    expect(missingSubmissions).toBe(2)
    expect(quiz.complete).toBe(true)
    expect(quiz.questions).toHaveLength(2)
    expect(quiz.questions.every(q => q.question.passage)).toBe(true)
    expect(quiz.replanning!.rejectedDirections[0]!.candidate[missing]).toBeUndefined()
    const savedRejection = checkpoints.find(q => q.replanning)
    expect(savedRejection!.questions).toHaveLength(1)
    expect(savedRejection!.pending).toBeUndefined()
  })
  it.each(['missing-answer', 'overlong-feedback'])('replans exhausted %s revisions durably without accepting malformed replacements', async defect => {
    const controller = new AbortController()
    let checkpoint: WaypointQuiz | undefined
    let revisions = 0
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, signal: controller.signal, transport: async o => {
      const d = data(o)
      if (d.generationMode === 'verify_correct_question' && d.currentQuestions.length === 1)
        return submit(o, { decision: 'revise', reason: 'Clarify the feedback.' })
      const response = fixture(o)
      if (d.generationMode === 'revise_question_answers') {
        revisions++
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        if (defect === 'missing-answer') delete args.answerA
        else args.feedback = 'x'.repeat(1001)
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => {
      checkpoint = structuredClone(q)
      if (q.replanning) controller.abort()
    } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(revisions).toBe(2)
    expect(checkpoint!.questions).toHaveLength(1)
    expect(checkpoint!.pending).toBeUndefined()
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(1)
    // Retire the validated pending direction, never import malformed replacement fields.
    const rejected = checkpoint!.replanning!.rejectedDirections[0]!.candidate
    expect(rejected.answerA).toBe('One cup.')
    expect(rejected.feedback!.length).toBeLessThan(1001)
    const accepted = structuredClone(checkpoint!.questions[0])
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, checkpoint, transport: async o => {
      const response = fixture(o)
      if (data(o).generationMode === 'build_question_answers') {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = 'How many cups does this request ask for?'
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    } })
    expect(quiz.complete).toBe(true)
    expect(quiz.questions[0]).toEqual(accepted)
  })

  it('bounds repeated malformed revisions with the existing quota and preserves their schema failure origin', async () => {
    let checkpoint: WaypointQuiz | undefined
    let revisions = 0
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o)
      if (d.generationMode === 'verify_correct_question' && d.currentQuestions.length === 1)
        return submit(o, { decision: 'revise', reason: 'Clarify the feedback.' })
      const response = fixture(o)
      if (d.generationMode === 'build_question_answers' && d.currentQuestions.length === 1) {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = `How many cups are requested in case ${d.rejectedDirections?.length ?? 0}?`
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      if (d.generationMode === 'revise_question_answers') {
        revisions++
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        delete args.answerA
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => { checkpoint = structuredClone(q) } })).rejects.toMatchObject({ failure: {
      category: 'budget_exhausted', checkpointId: 'practice-quiz', originatingFailure: { category: 'schema_invalid', stage: 'reviseQuestion' } } })
    expect(revisions).toBe(6)
    expect(checkpoint!.questions).toHaveLength(1)
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(2)
    expect(checkpoint!.complete).toBe(false)
  })

  it.each(['reference', 'bounded-content'])('refuses to replan schema failures with invalid %s', async defect => {
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'build_question_answers') {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        delete args.passage
        if (defect === 'reference') args.cardId = 'unavailable-card'
        else args.feedback = 'x'.repeat(1001)
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => { checkpoint = q } })).rejects.toMatchObject({ failure: { category: 'schema_invalid', correctionExhausted: true } })
    expect(checkpoint!.questions).toHaveLength(0)
    expect(checkpoint!.replanning).toBeUndefined()
    expect(checkpoint!.pending).toBeUndefined()
  })

  it('resumes saved no-progress coverage by revising the pending question, preserving accepted coverage', async () => {
    const controller = new AbortController()
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, signal: controller.signal, transport: async o => {
      const d = data(o)
      if (d.generationMode === 'evaluate_question_coverage' && d.question.id === 'q2') return submit(o, { waypointIds: ['w1'], assessment: 'Only recipient recognition is tested.' })
      return fixture(o)
    }, onCheckpoint: async q => {
      checkpoint = structuredClone(q)
      if (q.questions.length === 1 && q.pending?.coverageReview) controller.abort()
    } })).rejects.toThrow()
    expect(checkpoint!.pending!.coverageReview!.waypointIds).toEqual(['w1'])
    const accepted = structuredClone(checkpoint!.questions[0])
    const modes: string[] = []
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, checkpoint, transport: async o => {
      const d = data(o)
      modes.push(d.generationMode)
      return fixture(o)
    } })
    expect(modes[0]).toBe('revise_question_answers')
    expect(modes.filter(mode => mode === 'evaluate_question_coverage')).toHaveLength(1)
    expect(quiz.questions[0]).toEqual(accepted)
    expect(quiz.coverage.find(c => c.waypointId === 'w1')!.questionIds).toEqual(['q1'])
    expect(quiz.complete).toBe(true)
  })

  it('revises actual coverage that adds no new understanding without accepting or counting the question', async () => {
    let duplicateAssessment = false, revision = false
    const checkpoints: WaypointQuiz[] = []
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'evaluate_question_coverage' && d.question.id === 'q2' && !duplicateAssessment) {
        duplicateAssessment = true
        return submit(o, { waypointIds: ['w1'], assessment: 'This candidate still tests the recipient, not quantity.' })
      }
      if (d.generationMode === 'revise_question_answers') {
        revision = true
        expect(d.revision).toContain('remaining waypoint: w2')
        expect(d.currentQuestions).toHaveLength(1)
      }
      return response
    }, onCheckpoint: async q => { checkpoints.push(structuredClone(q)) } })
    expect(duplicateAssessment && revision).toBe(true)
    expect(quiz.complete).toBe(true)
    expect(quiz.questions).toHaveLength(2)
    expect(quiz.questions[1]!.coverageReview.waypointIds).toEqual(['w2'])
    expect(checkpoints.some(q => q.pending?.step === 'revise' && q.questions.length === 1)).toBe(true)
    expect(quiz.coverage.find(c => c.waypointId === 'w1')!.questionIds).toEqual(['q1'])
  })
  it('bounds repeated no-progress coverage with replanning while preserving the accepted question', async () => {
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'evaluate_question_coverage' && d.question.id === 'q2') return submit(o, { waypointIds: ['w1'], assessment: 'Only the already assessed recipient is tested.' })
      if (d.generationMode === 'build_question_answers' && d.currentQuestions.length) {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = `In request ${d.rejectedDirections?.length ?? 0}, how much tea is requested?`
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => { checkpoint = q } })).rejects.toMatchObject({ failure: { category: 'budget_exhausted', checkpointId: 'practice-quiz' } })
    expect(checkpoint!.questions).toHaveLength(1)
    expect(checkpoint!.questions[0]!.id).toBe('q1')
    expect(checkpoint!.coverage).toHaveLength(1)
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(2)
    expect(checkpoint!.complete).toBe(false)
  })

  it('projects remaining waypoints from accepted coverage, independently for each quiz phase', () => {
    const partial = { phase: 'practice', questions: [{ id: 'q1', question: { cardId: 'c1', stem: 'Who receives the tea?', passage: '请给我一杯茶。' } }], coverage: [{ waypointId: 'w1', questionIds: ['q1'] }, { waypointId: 'w2', questionIds: [] }] } as unknown as WaypointQuiz
    expect(projectQuizContext(input, graph, partial).remainingWaypointIds).toEqual(['w2'])
    expect(projectQuizContext(input, graph, { ...partial, coverage: [{ waypointId: 'w1', questionIds: ['unaccepted'] }] }).remainingWaypointIds).toEqual(['w1', 'w2'])
    expect(projectQuizContext(input, graph, { ...partial, phase: 'check', questions: [], coverage: [] }).remainingWaypointIds).toEqual(['w1', 'w2'])
  })
  it('corrects an already-assessed direction before review while retaining accepted questions', async () => {
    let repeated = false, corrected = false
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'list_missing_questions' && d.currentQuestions.length === 1) {
        expect(d.remainingWaypointIds).toEqual(['w2'])
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        if (!repeated) {
          repeated = true
          args.waypointId = 'w1'
        } else {
          corrected = true
          expect(o.messages.some(message => message.content?.includes('waypointId'))).toBe(true)
          args.waypointId = 'w2'
        }
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      if (d.generationMode === 'verify_correct_question') expect(d.candidate.stem).not.toBe('Which participant is named by this request?')
      return response
    } })
    expect(repeated && corrected).toBe(true)
    expect(quiz.complete).toBe(true)
    expect(quiz.questions).toHaveLength(2)
    expect(quiz.questions[1]!.gap.waypointIds).toEqual(['w2'])
  })
  it('replans a semantically rejected valid candidate without dropping accepted questions or applying the rejected one', async () => {
    const checkpoints: WaypointQuiz[] = []
    let rejected = false
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'verify_correct_question' && d.currentQuestions.length && !rejected) {
        expect(d.validationIssue).toBeUndefined()
        rejected = true
        return submit(o, { decision: 'reject', reason: 'This task angle cannot assess the missing distinction.' })
      }
      if (d.generationMode === 'build_question_answers' && d.rejectedDirections?.length) {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = 'In another request, how much tea does the speaker request?'
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => { checkpoints.push(structuredClone(q)) } })
    expect(quiz.complete).toBe(true)
    expect(quiz.questions).toHaveLength(2)
    expect(quiz.replanning!.rejectedDirections).toHaveLength(1)
    expect(quiz.questions[1]!.question.stem).not.toBe(quiz.replanning!.rejectedDirections[0]!.candidate.stem)
    const ledgerCheckpoint = checkpoints.find(q => q.replanning)
    expect(ledgerCheckpoint!.questions).toHaveLength(1)
    expect(ledgerCheckpoint!.questions[0]).toEqual(quiz.questions[0])
    expect(ledgerCheckpoint!.pending).toBeUndefined()
  })
  it('bounds repeated semantic rejection and retains its origin when the replan quota expires', async () => {
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'verify_correct_question' && d.currentQuestions.length) {
        return submit(o, { decision: 'reject', reason: 'This proposed direction is unsupported.' })
      }
      if (d.generationMode === 'build_question_answers' && d.currentQuestions.length) {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = `In request ${d.rejectedDirections?.length ?? 0}, how much tea is requested?`
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    }, onCheckpoint: async q => { checkpoint = q } })).rejects.toMatchObject({ failure: {
      category: 'budget_exhausted', stage: 'reviewQuestion', checkpointId: 'practice-quiz',
      originatingFailure: { category: 'review_rejected', layer: 'review', stage: 'reviewQuestion' },
    } })
    expect(checkpoint!.questions).toHaveLength(1)
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(2)
    expect(checkpoint!.complete).toBe(false)
  })
  it('bounds an unfinished question and gives explicit Continue a fresh allowance with its full rejected history', async () => {
    let checkpoint: WaypointQuiz | undefined
    let proposals = 0
    const transport = async (o: ChatOptions) => {
      const context = data(o), response = fixture(o)
      if (context.generationMode === 'list_missing_questions') proposals++
      if (context.generationMode === 'build_question_answers') {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem += ` Alternative task ${context.rejectedDirections?.length ?? 0}.`
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      if (context.generationMode === 'revise_question_answers') {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem += ` Alternative task ${context.rejectedDirections?.length ?? 0}.`
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      if (context.generationMode === 'verify_correct_question') return submit(o, { decision: 'revise', reason: 'The direction remains infeasible.' })
      return response
    }
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport,
      onCheckpoint: async quiz => { checkpoint = quiz },
    })).rejects.toMatchObject({ failure: { category: 'budget_exhausted', checkpointId: 'practice-quiz' } })
    expect(proposals).toBe(3)
    expect(checkpoint!.questions).toEqual([])
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(2)
    checkpoint = validateLessonPreparation(JSON.parse(JSON.stringify({ input, lesson: reviewed, practice: checkpoint }))).practice!
    const resumed = vi.fn(async (o: ChatOptions) => {
      const response = fixture(o), context = data(o)
      // Re-review the retained exhausted candidate, then use its saved feedback
      // to author a genuinely changed question in the new bounded run.
      if (context.generationMode === 'verify_correct_question' && !context.currentQuestions.length && context.candidate?.stem?.includes('Alternative task')) {
        return submit(o, { decision: 'reject', reason: 'Use a new, supported question direction.' })
      }
      return response
    })
    const result = await buildWaypointQuiz(input, reviewed, 'practice', { provider, checkpoint, transport: resumed })
    expect(result.complete).toBe(true)
    expect(result.questions).toHaveLength(2)
    expect(result.replanning!.rejectedDirections).toHaveLength(3)
    expect(result.replanning!.rejectedDirections.slice(0, 2)).toEqual(checkpoint!.replanning!.rejectedDirections)
    expect(data(resumed.mock.calls[0]![0]).generationMode).toBe('verify_correct_question')
  })
  it('gives each next question its own two replans while preserving more than two rejected candidates', async () => {
    const reviews = new Map<number, number>()
    let authored = 0
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const context = data(o), response = fixture(o)
      if (context.generationMode === 'build_question_answers') {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem += ` Task ${++authored}.`
        return submit(o, args)
      }
      if (context.generationMode === 'verify_correct_question') {
        const slot = context.currentQuestions.length, count = reviews.get(slot) ?? 0
        reviews.set(slot, count + 1)
        if (count < 2) return submit(o, { decision: 'reject', reason: 'Choose a clearer task for this learning point.' })
      }
      return response
    } })
    expect(quiz.complete).toBe(true)
    expect(quiz.questions).toHaveLength(2)
    expect(quiz.replanning!.rejectedDirections).toHaveLength(4)
    expect(validateLessonPreparation({ input, lesson: reviewed, practice: quiz }).practice).toEqual(quiz)
  })
  it('persists direction replanning without losing accepted questions and resumes at proposal', async () => {
    const controller = new AbortController()
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, signal: controller.signal,
      transport: async o => {
        const context = data(o)
        if (context.generationMode === 'build_question_answers' && context.currentQuestions.length) {
          const response = fixture(o), args = JSON.parse(response.toolCalls[0]!.function.arguments)
          args.feedback = 'REJECTED_AUTHOR_FEEDBACK'
          return submit(o, args)
        }
        if (context.generationMode === 'verify_correct_question' && context.currentQuestions.length) {
          return submit(o, { decision: 'revise', reason: 'The selected task needs a different feasible direction.' })
        }
        return fixture(o)
      }, onCheckpoint: async quiz => { checkpoint = quiz; if (quiz.replanning) controller.abort() },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(checkpoint!.questions.map(q => q.id)).toEqual(['q1'])
    expect(checkpoint!.coverage.map(c => c.waypointId)).toEqual(['w1'])
    expect(checkpoint!.pending).toBeUndefined()
    expect(checkpoint!.proposedDirections).toBeUndefined()
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(1)
    checkpoint = validateLessonPreparation(JSON.parse(JSON.stringify({ input, lesson: reviewed, practice: checkpoint }))).practice!
    const transport = vi.fn(async (o: ChatOptions) => {
      const response = fixture(o)
      if (data(o).generationMode === 'build_question_answers') {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = 'Which quantity does this request specify?'
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    })
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, checkpoint, transport })
    const first = data(transport.mock.calls[0]![0])
    expect(first.generationMode).toBe('list_missing_questions')
    expect(first.rejectedDirections).toHaveLength(1)
    const rejected = checkpoint!.replanning!.rejectedDirections[0]!
    expect(first.rejectedDirections[0]).toEqual({ waypointIds: rejected.gap.waypointIds, cardId: rejected.gap.cardId,
      stem: rejected.candidate.stem, passage: rejected.candidate.passage, reason: rejected.reason })
    expect(first.graph).toEqual(graph)
    expect(JSON.stringify(first)).not.toContain('REJECTED_AUTHOR_INTENT')
    expect(JSON.stringify(first)).not.toContain('REJECTED_AUTHOR_RATIONALE')
    expect(rejected.gap.intent).toBe(graph.waypoints[1]!.objective)
    expect(JSON.stringify(first)).not.toContain('REJECTED_AUTHOR_FEEDBACK')
    expect(quiz.complete).toBe(true)
    expect(quiz.questions.map(q => q.id)).toEqual(['q1', 'q2'])
    expect(quiz.questions[0]).toEqual(checkpoint!.questions[0])
    expect(quiz.replanning!.rejectedDirections).toHaveLength(1)
  })
  it('never requests a new proposal before the replan checkpoint writer acknowledges it', async () => {
    let proposals = 0
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider,
      transport: async o => {
        if (data(o).generationMode === 'list_missing_questions') proposals++
        if (data(o).generationMode === 'verify_correct_question') return submit(o, { decision: 'revise', reason: 'Unproductive direction.' })
        return fixture(o)
      }, onCheckpoint: async quiz => { if (quiz.replanning) throw new Error('Replan storage failed') },
    })).rejects.toMatchObject({ failure: { category: 'persistence_error', checkpointId: 'practice-quiz' } })
    expect(proposals).toBe(1)
  })
  it.each(['authored', 'during-review', 'revision-requested', 'replacement'] as const)('resumes a pending waypoint after %s without rebuilding it', async interruption => {
    const controller = new AbortController()
    let checkpoint: LessonGraphDraft | undefined, requestedRevision = false, interrupted = false
    const calls: string[] = []
    const transport = async (o: ChatOptions) => {
      const d = data(o); calls.push(d.generationMode)
      if (d.generationMode === 'verify_lesson_waypoint' && d.candidate.id === 'w1' && !requestedRevision) {
        requestedRevision = true
        if (interruption === 'during-review') { interrupted = true; throw new Error('Review interrupted') }
        return submit(o, { decision: 'revise', reason: 'Clarify who is speaking.' })
      }
      if (d.generationMode === 'revise_lesson_waypoint' && d.candidateToRevise) {
        const { id: _id, ...fields } = d.candidateToRevise
        return submit(o, { ...fields, explanation: '我 identifies the speaker as the recipient of the tea.' })
      }
      return fixture(o)
    }
    await expect(prepareWaypointGraph(input, { provider, transport, signal: controller.signal, onCheckpoint: async draft => {
      checkpoint = draft
      const p = draft.pending
      if (!interrupted && p && ((interruption === 'authored' && p.reviewRound === 0 && !p.revision)
        || (interruption === 'revision-requested' && p.revision) || (interruption === 'replacement' && p.reviewRound === 1))) {
        interrupted = true; controller.abort()
      }
    } })).rejects.toThrow()
    expect(checkpoint!.pending).toBeDefined()
    expect(checkpoint!.graph.waypoints).toEqual([])
    checkpoint = validateGraphDraft(JSON.parse(JSON.stringify(checkpoint)))
    if (interruption === 'authored') {
      const stale = structuredClone(checkpoint); stale.pending!.stateHash = '0'.repeat(64)
      const rejected = vi.fn(transport)
      await expect(prepareWaypointGraph(input, { provider, transport: rejected, checkpoint: stale })).rejects.toThrow('different accepted graph')
      expect(rejected).not.toHaveBeenCalled()
    }
    const resumed = vi.fn(transport)
    const lesson = await prepareWaypointGraph(input, { provider, transport: resumed, checkpoint })
    expect(data(resumed.mock.calls[0]![0]).generationMode).toBe(interruption === 'revision-requested' ? 'revise_lesson_waypoint' : 'verify_lesson_waypoint')
    expect(lesson.graph.waypoints).toHaveLength(2)
    expect(calls.filter(name => name === 'add_lesson_waypoint')).toHaveLength(2)
  })
  it('reviews readiness after the final allowed authoring operation', async () => {
    const transport = vi.fn(async (o: ChatOptions) => fixture(o))
    const lesson = await prepareWaypointGraph(input, { provider, transport, maxAuthoringOperations: 2 })
    expect(lesson.graph).toEqual(graph)
    expect(data(transport.mock.calls.at(-1)![0]).generationMode).toBe('verify_lesson_graph')
  })
  it('reviews an exhausted graph and preserves its checkpoint without claiming readiness', async () => {
    let checkpoint: LessonGraphDraft | undefined
    const transport = vi.fn(async (o: ChatOptions) => fixture(o))
    await expect(prepareWaypointGraph(input, { provider, transport, maxAuthoringOperations: 1,
      onCheckpoint: async draft => { checkpoint = draft } })).rejects.toMatchObject({ failure: { category: 'budget_exhausted', layer: 'budget' } })
    expect(checkpoint!.graph.waypoints).toEqual([graph.waypoints[0]])
    expect(data(transport.mock.calls.at(-1)![0]).generationMode).toBe('verify_lesson_graph')
    await expect(prepareWaypointGraph(input, { provider, transport, checkpoint })).rejects.toMatchObject({ failure: { category: 'budget_exhausted' } })
    await expect(prepareWaypointGraph(input, { provider, transport, checkpoint, maxAuthoringOperations: 14 })).rejects.toThrow('original authoring limit')
  })
  it('stops identical accepted revisions with a progress failure', async () => {
    const transport = async (o: ChatOptions) => data(o).generationMode === 'verify_lesson_graph'
      ? submit(o, { decision: 'revise', waypointId: 'w1', reason: 'Please repeat the first point.' }) : fixture(o)
    await expect(prepareWaypointGraph(input, { provider, transport })).rejects.toMatchObject({ failure: { category: 'budget_exhausted',
      message: expect.stringContaining('without progress') } })
  })
  it('retains graph progress history across a pause before revision', async () => {
    const controller = new AbortController()
    let checkpoint: LessonGraphDraft | undefined
    await expect(prepareWaypointGraph(input, { provider, signal: controller.signal,
      transport: async o => data(o).generationMode === 'verify_lesson_graph'
        ? submit(o, { decision: 'revise', waypointId: 'w1', reason: 'Revise the recipient explanation.' }) : fixture(o),
      onCheckpoint: async draft => { checkpoint = draft; if (draft.revision) controller.abort() },
    })).rejects.toThrow()
    expect(checkpoint!.construction.operations).toBe(1)
    expect(checkpoint!.construction.states).toHaveLength(2)
    await expect(prepareWaypointGraph(input, { provider, checkpoint, transport: async o => fixture(o) })).rejects.toMatchObject({
      failure: { category: 'budget_exhausted', message: expect.stringContaining('without progress') },
    })
  })
  it('keeps useful prerequisites and rejects cycles, unknown references and missing targets', () => {
    expect(orderedWaypoints(graph).map(w => w.id)).toEqual(['w1', 'w2'])
    expect(waypointContext(graph, ['w2'])).toEqual(graph.waypoints)
    const cycle = structuredClone(graph); cycle.waypoints[0]!.dependsOn = ['w2']
    expect(() => validateLessonGraph(cycle, input)).toThrow('acyclic')
    expect(() => validateLessonGraph(graph, { ...input, targets: [...input.targets, { cardId: 'c2', hanzi: '谢谢', meaning: 'thanks' }] })).toThrow('every selected target')
    expect(() => validateLessonGraph({ ...graph, waypoints: [{ ...graph.waypoints[0]!, sourceIds: ['absent'] }] }, input)).toThrow('unavailable source')
  })
  it('projects every accepted point into the next build and review, saving before requesting', async () => {
    const checkpoints: LessonGraphDraft[] = []
    const transport = vi.fn(async (o: ChatOptions) => {
      const d = data(o)
      if (d.generationMode === 'add_lesson_waypoint' && d.graph.waypoints.length) expect(checkpoints.at(-1)!.graph).toEqual(d.graph)
      if (d.generationMode === 'verify_lesson_waypoint') expect(d.graph.waypoints.map((w: any) => w.id)).not.toContain(d.candidate.id)
      return fixture(o)
    })
    expect((await prepareWaypointGraph(input, { provider, transport, onCheckpoint: async d => { checkpoints.push(d) } })).graph).toEqual(graph)
    expect(transport.mock.calls.map(([o]) => o.tools![0]!.function.name)).toEqual(['add_lesson_waypoint', 'verify_lesson_waypoint', 'verify_lesson_graph', 'add_lesson_waypoint', 'verify_lesson_waypoint', 'verify_lesson_graph'])
    expect(checkpoints.find(d => d.graph.waypoints.length)!.graph.waypoints).toEqual([graph.waypoints[0]])
    expect(transport.mock.calls.every(([o]) => o.tools?.length === 1 && o.messages.length === 2 && o.maxTokens === 4096)).toBe(true)
  })
  it('authors only waypoint fields and derives the introduction after graph approval', async () => {
    const transport = vi.fn(async (o: ChatOptions) => fixture(o))
    const lesson = await prepareWaypointGraph(input, { provider, transport })
    expect(lesson.graph.overview).toBe(graph.overview)
    expect(lesson.graph.waypoints).toEqual(graph.waypoints)
    for (const [request] of transport.mock.calls.filter(([o]) => ['add_lesson_waypoint', 'revise_lesson_waypoint'].includes(data(o).generationMode))) {
      expect(request.tools![0]!.function.parameters.properties).not.toHaveProperty('action')
      expect(request.tools![0]!.function.parameters.properties).not.toHaveProperty('overview')
    }
  })
  it('uses add for missing graph points and requires an ID for replacement', async () => {
    let invalid = false
    const transport = vi.fn(async (o: ChatOptions) => {
      const d = data(o)
      if (d.generationMode === 'verify_lesson_graph' && d.graph.waypoints.length === 1 && !invalid) {
        invalid = true
        return submit(o, { decision: 'revise', reason: 'Add the missing quantity point.' })
      }
      return fixture(o)
    })
    const result = await prepareWaypointGraph(input, { provider, transport })
    expect(result.graph.waypoints).toHaveLength(2)
    const reviews = transport.mock.calls.filter(([o]) => data(o).generationMode === 'verify_lesson_graph')
    expect(reviews[0]![0].tools![0]!.function.parameters.properties.decision.enum).toContain('add')
    expect(reviews[1]![0].messages.at(-1)!.content).toContain('use add for a missing point')
  })
  it('resumes a durable waypoint draft and never rebuilds accepted points', async () => {
    let checkpoint: LessonGraphDraft | undefined
    const controller = new AbortController()
    await expect(prepareWaypointGraph(input, { provider, transport: async o => fixture(o), signal: controller.signal,
      onCheckpoint: async d => { checkpoint = d; if (d.graph.waypoints.length) controller.abort() } })).rejects.toThrow()
    const transport = vi.fn(async o => fixture(o))
    const result = await prepareWaypointGraph(input, { provider, transport, checkpoint })
    expect(data(transport.mock.calls[0]![0]).graph.waypoints).toEqual([graph.waypoints[0]])
    expect(result.graph).toEqual(graph)
    await expect(prepareWaypointGraph({ ...input, objective: 'Changed' }, { provider, transport, checkpoint })).rejects.toThrow('different lesson')
  })
  it('evaluates corrected waypoints before applying them, preserving unrelated points', async () => {
    let corrected = false
    const transport = vi.fn(async (o: ChatOptions) => {
      const d = data(o)
      if (d.generationMode === 'verify_lesson_waypoint' && d.candidate.id === 'w2' && !corrected) {
        corrected = true
        return submit(o, { decision: 'revise', reason: 'Improve the explanation.' })
      }
      if (d.generationMode === 'revise_lesson_waypoint' && d.candidateToRevise) {
        const { id: _id, ...fields } = d.candidateToRevise
        return submit(o, { ...fields, explanation: '一杯 means one cup, rather than two.' })
      }
      return fixture(o)
    })
    const result = await prepareWaypointGraph(input, { provider, transport })
    expect(result.graph.waypoints[0]).toEqual(graph.waypoints[0])
    expect(result.graph.waypoints[1]!.explanation).toContain('rather than two')
    expect(transport.mock.calls.filter(([o]) => data(o).generationMode === 'verify_lesson_waypoint')).toHaveLength(3)
  })
  it('routes a final review issue through one replacement and a fresh graph review', async () => {
    let revised = false
    const improved = { ...graph.waypoints[1]!, explanation: '一杯 requests exactly one cup, rather than two.' }
    const transport = vi.fn(async (o: ChatOptions) => {
      if (data(o).generationMode === 'verify_lesson_graph' && data(o).graph.waypoints.length === 2 && !revised) { revised = true; return submit(o, { decision: 'revise', waypointId: 'w2', reason: 'Clarify the quantity.' }) }
      if (data(o).generationMode === 'revise_lesson_waypoint') { const { id: _id, ...fields } = improved; return submit(o, fields) }
      return fixture(o)
    })
    expect((await prepareWaypointGraph(input, { provider, transport })).graph.waypoints).toEqual([graph.waypoints[0], improved])
    const request = transport.mock.calls.find(([o]) => data(o).revision?.waypointId === 'w2')![0]
    expect(data(request).nextWaypointId).toBe('w2')
    expect(data(request).graph.waypoints).toHaveLength(2)
  })
  it('projects validation errors as data in one bounded fresh correction', async () => {
    let malformed = false
    const transport = vi.fn(async (o: ChatOptions) => {
      if (!malformed) { malformed = true; return submit(o, { objective: 'Missing fields' }) }
      expect(o.messages.map(m => m.role)).toEqual(['system', 'user'])
      return fixture(o)
    })
    await prepareWaypointGraph(input, { provider, transport })
    expect(transport.mock.calls[1]![0].messages.at(-1)!.content).toContain('complete corrected')
    expect(data(transport.mock.calls[1]![0]).candidateSubmission).toEqual({ objective: 'Missing fields' })
  })
  it('repairs a completed text-only submission without interpreting its prose as arguments', async () => {
    let echoed = false
    const checkpoints: LessonGraphDraft[] = []
    const transport = vi.fn(async (o: ChatOptions) => {
      if (!echoed) { echoed = true; return { ...fixture(o), content: JSON.stringify({ action: 'finish', overview: 'Do not execute this text.' }), toolCalls: [] } }
      return fixture(o)
    })
    await prepareWaypointGraph(input, { provider, transport, onCheckpoint: async d => { checkpoints.push(d) } })
    expect(transport.mock.calls[1]![0].messages.at(-1)!.content).toContain('nativeSubmissionIssue')
    expect(checkpoints.find(d => d.graph.waypoints.length)!.graph.waypoints).toEqual([graph.waypoints[0]])
    expect(transport.mock.calls[2]![0].messages).toHaveLength(2)
  })
  it('preserves a transport failure after submission feedback and does not retry it', async () => {
    let calls = 0
    await expect(prepareWaypointGraph(input, { provider, transport: async o => {
      if (++calls === 1) return { ...fixture(o), content: 'Not a native call.', toolCalls: [] }
      throw new Error('Disconnected during correction')
    } })).rejects.toThrow('Disconnected during correction')
    expect(calls).toBe(2)
  })
  it('does not retry transport failures or accept prose/batches as native operations', async () => {
    const transport = vi.fn(async () => { throw new Error('Disconnected') })
    await expect(prepareWaypointGraph(input, { provider, transport })).rejects.toThrow('Disconnected')
    expect(transport).toHaveBeenCalledTimes(1)
    await expect(prepareWaypointGraph(input, { provider, transport: async o => ({ ...fixture(o), toolCalls: [] }) })).rejects.toThrow('native submission')
  })
})

describe('question proposals, authoring, evaluation and reprojection', () => {
  it('plans enough positions for a maximum-size graph and completes only after all nine coverage assessments', async () => {
    const large: ReviewedLessonGraph = { ...reviewed, graph: { ...graph, waypoints: Array.from({ length: 9 }, (_, i) => ({
      ...graph.waypoints[0]!, id: `w${i + 1}`, objective: `Synthetic capacity control ${i + 1}: identify the recipient.`,
    })) } }
    const transport = async (o: ChatOptions) => {
      const d = data(o)
      if (d.generationMode === 'list_missing_questions') return submit(o, { waypointId: d.remainingWaypointIds[0], cardId: 'c1', directions: d.graph.waypoints
        .filter((w: any) => !d.coverage.some((c: any) => c.waypointId === w.id)).map((w: any) => `${w.id}: ${w.objective}`).join('\n') })
      if (d.generationMode === 'build_question_answers') {
        const w = d.graph.waypoints.find((w: any) => !d.coverage.some((c: any) => c.waypointId === w.id))
        return submit(o, {
          stem: `For request ${w.id.slice(1)}, who receives the tea?`, passage: '请给我一杯茶。',
          answerA: 'The speaker.', answerB: 'The listener.', answerC: 'A third person.', answerD: 'Nobody.', correct: 'A', feedback: '我 refers to the speaker.' })
      }
      if (d.generationMode === 'evaluate_question_coverage') return submit(o, { waypointIds: [`w${d.question.id.slice(1)}`], assessment: 'Authored capacity assessment; not an independent semantic judgment.' })
      return fixture(o)
    }
    const rejected = vi.fn(transport)
    await expect(buildWaypointQuiz(input, large, 'practice', { provider, transport: rejected, maxQuestions: 6 })).rejects.toMatchObject({ failure: { stage: 'quizPlanning' } })
    expect(rejected).not.toHaveBeenCalled()
    const quiz = await buildWaypointQuiz(input, large, 'practice', { provider, transport })
    expect(quiz.complete).toBe(true)
    expect(quiz.questions).toHaveLength(9)
    expect(quiz.coverage).toHaveLength(9)
  })
  it.each(['authored', 'answer-saved', 'during-review', 'revision-requested', 'replacement'] as const)('resumes a pending question after %s without regenerating it', async interruption => {
    const controller = new AbortController()
    let checkpoint: WaypointQuiz | undefined, requestedRevision = false, interrupted = false
    const calls: string[] = []
    const transport = async (o: ChatOptions) => {
      const d = data(o); calls.push(d.generationMode)
      if (d.generationMode === 'verify_correct_question' && !requestedRevision) {
        requestedRevision = true
        if (interruption === 'during-review') { interrupted = true; throw new Error('Question review interrupted') }
        return submit(o, { decision: 'revise', reason: 'Clarify the recipient explanation.' })
      }
      if (d.generationMode === 'revise_question_answers') return submit(o, { ...d.candidateToRevise, feedback: '我 identifies the speaker as the recipient; 一杯 specifies one cup.' })
      return fixture(o)
    }
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, signal: controller.signal,
      onCheckpoint: async quiz => {
        checkpoint = quiz
        const p = quiz.pending
        if (!interrupted && p && ((interruption === 'authored' && p.reviewRound === 0 && !p.revision)
          || (interruption === 'answer-saved' && p.step === 'solve' && p.answerReview)
          || (interruption === 'revision-requested' && p.revision) || (interruption === 'replacement' && p.reviewRound === 1))) {
          interrupted = true; controller.abort()
        }
      } })).rejects.toThrow()
    expect(checkpoint!.pending).toBeDefined()
    expect(checkpoint!.questions).toEqual([])
    checkpoint = validateLessonPreparation(JSON.parse(JSON.stringify({ input, lesson: reviewed, practice: checkpoint }))).practice!
    if (interruption === 'authored') {
      const stale = structuredClone(checkpoint); stale.proposedDirections += '\nDifferent directions.'
      const rejected = vi.fn(transport)
      await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: rejected, checkpoint: stale })).rejects.toThrow('different accepted quiz state')
      expect(rejected).not.toHaveBeenCalled()
    }
    const resumed = vi.fn(transport)
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: resumed, checkpoint })
    expect(resumed.mock.calls[0]![0].tools![0]!.function.name).toBe(interruption === 'revision-requested' ? 'revise_question_answers' : ['authored', 'replacement'].includes(interruption) ? 'solve_visible_question' : 'verify_correct_question')
    expect(quiz.complete).toBe(true)
    expect(quiz.pending).toBeUndefined()
    expect(calls.filter(name => name === 'build_question_answers')).toHaveLength(2)
  })
  it.each([{ answerIds: [] }, { answerIds: ['A', 'D'] }, { answerIds: ['B'] }])('persists valid solver disagreement $answerIds, resumes remediation and invalidates prior witnesses', async ({ answerIds }) => {
    let checkpoint: WaypointQuiz | undefined, solves = 0, interrupted = false
    const controller = new AbortController(), submissions: Array<{ stage: string; accepted: boolean }> = []
    const transport = vi.fn(async (o: ChatOptions) => {
      if (o.tools?.[0]?.function.name === 'solve_visible_question') {
        solves++
        return submit(o, { answerIds: solves === 2 ? answerIds : ['A'], reason: 'Authored semantic disagreement, not a submission fault.' })
      }
      const d = data(o)
      if (d.generationMode === 'revise_question_answers') return submit(o, { ...d.candidateToRevise, feedback: 'A new reviewed explanation for the same intended task.' })
      return fixture(o)
    })
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, signal: controller.signal,
      onSubmission: event => { submissions.push(event) }, onCheckpoint: async quiz => {
        checkpoint = quiz
        if (!interrupted && quiz.questions.length === 1 && quiz.pending?.step === 'solve' && quiz.pending.answerReview) {
          interrupted = true; controller.abort()
        }
      } })).rejects.toThrow()
    expect(checkpoint!.pending!.answerReview!.answerIds).toEqual(answerIds)
    expect(submissions.filter(event => event.stage === 'solveVisibleQuestion')).toEqual([
      expect.objectContaining({ accepted: true }), expect.objectContaining({ accepted: true }),
    ])
    const first = structuredClone(checkpoint!.questions[0]!)
    const stale = structuredClone(checkpoint!); stale.pending!.answerReview!.questionHash = '0'.repeat(64)
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint: stale })).rejects.toThrow('changed question content')
    checkpoint = validateLessonPreparation(JSON.parse(JSON.stringify({ input, lesson: reviewed, practice: checkpoint }))).practice!
    transport.mockClear()
    const resumed = vi.fn(transport)
    const finished = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: resumed, checkpoint,
      onCheckpoint: async quiz => {
        if (quiz.pending?.step === 'solve' && quiz.pending.reviewRound === 1 && !quiz.pending.answerReview) {
          for (const witness of ['review', 'answerReview', 'coverageReview', 'concealmentReview', 'revision']) expect(quiz.pending).not.toHaveProperty(witness)
        }
      } })
    expect(resumed.mock.calls[0]![0].tools![0]!.function.name).toBe('revise_question_answers')
    expect(solves).toBe(3)
    expect(finished.questions[0]).toEqual(first)
    expect(finished.questions[1]!.answerReview.answerIds).toEqual(['A'])
    expect(finished.questions[1]!.review.decision).toBe('correct')
    const missing = structuredClone(finished) as any; delete missing.questions[0].answerReview
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint: missing })).rejects.toThrow('answerReview')
  })
  it('bounds repeated visible-answer disagreement without losing accepted content or retrying the solver against its key', async () => {
    let checkpoint: WaypointQuiz | undefined, first: WaypointQuiz['questions'][number] | undefined, solves = 0, revisions = 0
    const submissions: Array<{ stage: string; accepted: boolean }> = []
    const transport = vi.fn(async (o: ChatOptions) => {
      if (o.tools?.[0]?.function.name === 'solve_visible_question') {
        solves++
        return submit(o, { answerIds: solves === 1 ? ['A'] : ['A', 'D'], reason: 'Authored persistent ambiguity.' })
      }
      const d = data(o)
      if (d.generationMode === 'revise_question_answers') {
        revisions++
        return submit(o, { ...d.candidateToRevise, feedback: `Authored replacement explanation ${revisions}.` })
      }
      const response = fixture(o)
      if (d.generationMode === 'build_question_answers' && d.rejectedDirections?.length) {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem += ` Alternative ${d.rejectedDirections.length}.`
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    })
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport,
      onSubmission: event => { submissions.push(event) }, onCheckpoint: async quiz => {
        checkpoint = structuredClone(quiz)
        if (quiz.questions.length === 1 && !first) first = structuredClone(quiz.questions[0]!)
      } })).rejects.toMatchObject({ failure: { category: 'budget_exhausted', checkpointId: 'practice-quiz' } })
    expect(solves).toBe(10)
    expect(revisions).toBe(6)
    expect(submissions.filter(event => event.stage === 'solveVisibleQuestion')).toHaveLength(10)
    expect(submissions.filter(event => event.stage === 'solveVisibleQuestion').every(event => event.accepted)).toBe(true)
    expect(checkpoint!.questions).toEqual([first])
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(2)
    expect(checkpoint!.pending).toMatchObject({ step: 'solve', reviewRound: 2, answerReview: { answerIds: ['A', 'D'] } })
    checkpoint = validateLessonPreparation(JSON.parse(JSON.stringify({ input, lesson: reviewed, practice: checkpoint }))).practice!
    transport.mockClear()
    const resumed = vi.fn(transport)
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: resumed, checkpoint,
      onCheckpoint: async quiz => { checkpoint = structuredClone(quiz) } }))
      .rejects.toMatchObject({ failure: { category: 'budget_exhausted' } })
    expect(resumed).toHaveBeenCalled()
    expect(checkpoint!.questions).toEqual([first])
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(4)
  })
  it('stores proposals, selects one Q/A group and projects accepted stems without prior answers', async () => {
    const saved: WaypointQuiz[] = [], transport = vi.fn(async (o: ChatOptions) => {
      const d = data(o)
      if (d.generationMode === 'build_question_answers') expect(saved.at(-1)!.proposedDirections).toBe(d.questionIdeas)
      if (d.generationMode !== 'evaluate_question_coverage') for (const q of [...(d.currentQuestions ?? []), ...(d.practiceQuestions ?? [])]) {
        expect(q).not.toHaveProperty('options'); expect(q).not.toHaveProperty('correctOptionId'); expect(q).not.toHaveProperty('explanation')
      }
      return fixture(o)
    })
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, onCheckpoint: async q => { saved.push(q) } })
    expect(quiz).toMatchObject({ complete: true, questions: [{ id: 'q1' }, { id: 'q2' }] })
    expect(quiz).not.toHaveProperty('proposedDirections')
    expect(quiz.coverage.map(c => c.waypointId)).toEqual(['w1', 'w2'])
    expect(transport.mock.calls.map(([o]) => o.tools![0]!.function.name)).toEqual(Array(2).fill(['list_missing_questions', 'build_question_answers', 'solve_visible_question', 'verify_correct_question', 'solve_english_question', 'evaluate_question_coverage']).flat())
    expect(transport.mock.calls.every(([o]) => o.featherlessThinking === (data(o).generationMode === 'evaluate_question_coverage'))).toBe(true)
    expect(currentQuestionContext(quiz.questions)[0]).toEqual({ id: 'q1', cardId: 'c1', stem: quiz.questions[0]!.question.stem, passage: '请给我一杯茶。' })
  })
  it('keeps a reviewed question pending until coverage and resumes only the missing work', async () => {
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      if (data(o).generationMode === 'evaluate_question_coverage') throw new Error('Interrupted audit')
      return fixture(o)
    }, onCheckpoint: async q => { checkpoint = q } })).rejects.toThrow('Interrupted audit')
    expect(checkpoint!.questions).toHaveLength(0)
    expect(checkpoint!.pending!.step).toBe('coverage')
    const transport = vi.fn(async o => fixture(o))
    const result = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint })
    expect(data(transport.mock.calls[0]![0]).generationMode).toBe('evaluate_question_coverage')
    expect(result.questions[0]!.question.stem).toEqual(checkpoint!.pending!.candidate.stem)
    transport.mockClear()
    expect(await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint: result })).toEqual(result)
    expect(transport).not.toHaveBeenCalled()
  })
  it('resumes saved directions after author failure without repeating proposal generation', async () => {
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      if (data(o).generationMode === 'build_question_answers') throw new Error('Interrupted author')
      return fixture(o)
    }, onCheckpoint: async q => { checkpoint = q } })).rejects.toThrow()
    const transport = vi.fn(async o => fixture(o))
    await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint })
    expect(data(transport.mock.calls[0]![0]).generationMode).toBe('build_question_answers')
  })
  it('evaluates a corrected question again before acceptance', async () => {
    let corrected = false
    const transport = vi.fn(async (o: ChatOptions) => {
      const d = data(o)
      if (d.generationMode === 'verify_correct_question' && !corrected) {
        corrected = true
        return { ...submit(o, { decision: 'revise', reason: 'Improve feedback.' }), model: 'initial-reviewer' }
      }
      if (d.generationMode === 'revise_question_answers') {
        expect(o.tools![0]!.function.parameters.properties).not.toHaveProperty('waypointIds')
        return submit(o, { ...d.candidateToRevise, feedback: '我 refers to the speaker who receives the tea.' })
      }
      if (d.generationMode === 'verify_correct_question') return { ...submit(o, {
        decision: 'accept', reason: 'The revised feedback explains who receives the tea.',
      }), model: 'accepting-reviewer' }
      return fixture(o)
    })
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport })
    expect(transport.mock.calls.filter(([o]) => data(o).generationMode === 'verify_correct_question')).toHaveLength(3)
    expect(transport.mock.calls.filter(([o]) => data(o).generationMode === 'revise_question_answers')).toHaveLength(1)
    expect(quiz.questions[0]!.review).toEqual({ decision: 'correct',
      reason: 'The revised feedback explains who receives the tea.', model: 'accepting-reviewer' })
  })
  it('corrects a nonexistent presentation marker before review or acceptance', async () => {
    let marked = false, corrected = false
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'build_question_answers' && !marked) {
        marked = true
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem = 'What does the underlined expression mean?'
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      } else if (d.generationMode === 'build_question_answers' && d.nativeSubmissionIssue) {
        expect(d.nativeSubmissionIssue).toContain('does not underline')
        corrected = true
      }
      if (d.generationMode === 'verify_correct_question') expect(d.candidate.stem).not.toContain('underlined')
      return response
    } })
    expect(corrected).toBe(true)
    expect(quiz.complete).toBe(true)
    expect(quiz.questions.every(q => !q.question.stem.includes('underlined'))).toBe(true)
  })
  it('withholds questions containing tool serialization tags until authoring fixes them', async () => {
    let marked = false
    const checkpoints: WaypointQuiz[] = []
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const result = fixture(o)
      if (data(o).generationMode === 'build_question_answers' && !marked) {
        marked = true
        const args = JSON.parse(result.toolCalls[0]!.function.arguments); args.answerA += '</answerA>'; result.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return result
    }, onCheckpoint: async q => { checkpoints.push(structuredClone(q)) } })
    expect(quiz.complete).toBe(true)
    expect(quiz.replanning).toBeUndefined()
    expect(checkpoints.every(q => !q.pending?.candidate.answerA.includes('</answerA>'))).toBe(true)
    expect(checkpoints.every(q => q.questions.every(accepted => accepted.question.options.every(option => !option.text.includes('</answerA>'))))).toBe(true)
    expect(quiz.questions[0]!.question.options[0]!.text).toBe('The speaker.')
  })
  it('allows a concise coverage explanation over 400 characters while projecting only its references', async () => {
    const transport = vi.fn(async (o: ChatOptions) => {
      const result = fixture(o)
      if (data(o).generationMode === 'evaluate_question_coverage') {
        const args = JSON.parse(result.toolCalls[0]!.function.arguments)
        args.assessment = 'The actual choices distinguish the relevant meanings. '.repeat(10)
        result.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      if (data(o).generationMode === 'list_missing_questions') expect(data(o).coverage.every((c: any) => !('assessment' in c))).toBe(true)
      return result
    })
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport })
    expect(quiz.complete).toBe(true)
    expect(quiz.coverage[0]!.assessment.length).toBeGreaterThan(400)
  })
  it('replans exhausted empty coverage on resume while preserving accepted questions', async () => {
    const controller = new AbortController()
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, maxQuestions: 2, signal: controller.signal, transport: async o => {
      if (data(o).generationMode === 'evaluate_question_coverage' && data(o).currentQuestions.length) return submit(o, { waypointIds: [], assessment: 'No actual tested understanding.' })
      return fixture(o)
    }, onCheckpoint: async q => {
      checkpoint = q
      if (q.pending?.reviewRound === 2 && q.pending.coverageReview?.waypointIds.length === 0) controller.abort()
    } })).rejects.toThrow()
    checkpoint = validateLessonPreparation(JSON.parse(JSON.stringify({ input, lesson: reviewed, practice: checkpoint }))).practice!
    const accepted = structuredClone(checkpoint.questions)
    expect(accepted).toHaveLength(1)
    expect(checkpoint!.pending!.coverageReview!.waypointIds).toEqual([])
    expect(checkpoint!.pending!.reviewRound).toBe(2)
    const transport = vi.fn(async (o: ChatOptions) => {
      const result = fixture(o)
      if (data(o).generationMode === 'build_question_answers') {
        const value = JSON.parse(result.toolCalls[0]!.function.arguments)
        value.stem = 'Which quantity does this request specify?'
        result.toolCalls[0]!.function.arguments = JSON.stringify(value)
      }
      return result
    })
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint })
    expect(quiz.complete).toBe(true)
    expect(quiz.questions.slice(0, accepted.length)).toEqual(accepted)
    expect(quiz.questions.map(q => q.id)).toEqual(['q1', 'q2'])
    expect(quiz.replanning!.rejectedDirections).toHaveLength(1)
    expect(data(transport.mock.calls[0]![0]).generationMode).toBe('list_missing_questions')
  })
  it('revises a zero-coverage candidate without consuming a question position', async () => {
    let firstCoverage = true
    const transport = vi.fn(async (o: ChatOptions) => {
      if (data(o).generationMode === 'evaluate_question_coverage' && firstCoverage) {
        firstCoverage = false; return submit(o, { waypointIds: [], assessment: 'The question does not test the intended understanding.' })
      }
      return fixture(o)
    })
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, maxQuestions: 2, transport })
    expect(quiz.complete).toBe(true)
    expect(quiz.questions.map(q => q.id)).toEqual(['q1', 'q2'])
    expect(quiz.questions.every(q => q.coverageReview!.waypointIds.length > 0)).toBe(true)
    expect(transport.mock.calls.filter(([o]) => data(o).generationMode === 'revise_question_answers')).toHaveLength(1)
    expect(transport.mock.calls.filter(([o]) => data(o).generationMode === 'build_question_answers')).toHaveLength(2)
  })
  it.each([true, false])('resumes a persisted coverage result without reevaluating the unchanged question (zero=%s)', async zero => {
    const controller = new AbortController()
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, signal: controller.signal,
      transport: async o => zero && data(o).generationMode === 'evaluate_question_coverage'
        ? submit(o, { waypointIds: [], assessment: 'No tested understanding.' }) : fixture(o),
      onCheckpoint: async quiz => { checkpoint = quiz; if (quiz.pending?.coverageReview) controller.abort() },
    })).rejects.toThrow()
    expect(checkpoint!.questions).toEqual([])
    checkpoint = validateLessonPreparation(JSON.parse(JSON.stringify({ input, lesson: reviewed, practice: checkpoint }))).practice!
    const transport = vi.fn(async (o: ChatOptions) => fixture(o))
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint })
    expect(quiz.complete).toBe(true)
    expect(data(transport.mock.calls[0]![0]).generationMode).toBe(zero ? 'revise_question_answers' : 'list_missing_questions')
    expect(transport.mock.calls.filter(([o]) => data(o).generationMode === 'evaluate_question_coverage')).toHaveLength(zero ? 2 : 1)
  })
  it('rejects an unchanged previously rejected candidate and preserves earlier accepted questions', async () => {
    let checkpoint: WaypointQuiz | undefined
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      if (data(o).generationMode === 'verify_correct_question' && data(o).currentQuestions.length) return submit(o, { decision: 'reject', reason: 'Unusable.' })
      return fixture(o)
    }, onCheckpoint: async q => { checkpoint = q } })).rejects.toMatchObject({ failure: {
      category: 'constraints_invalid', stage: 'buildQuestion', correctionExhausted: true,
    } })
    expect(checkpoint!.questions).toHaveLength(1)
    expect(checkpoint!.complete).toBe(false)
  })
  it('rejects completion and coverage claims without their evaluated question evidence', async () => {
    const checkpoint = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => fixture(o) })
    const forged = structuredClone(checkpoint); delete forged.questions[0]!.coverageReview
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => fixture(o), checkpoint: forged })).rejects.toThrow('evaluated question evidence')
    const edited = structuredClone(checkpoint); edited.questions[0]!.question.options[1]!.text = 'A changed choice.'
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => fixture(o), checkpoint: edited })).rejects.toThrow('changed question content')
    const changed = structuredClone(checkpoint); changed.questions[0]!.coverageReview!.waypointIds = ['w2']
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => fixture(o), checkpoint: changed })).rejects.toThrow('evaluated question evidence')
  })
  it('requires completed practice for check and keeps practice answers out of new-question context', async () => {
    await expect(buildWaypointQuiz(input, reviewed, 'check', { provider, transport: async o => fixture(o) })).rejects.toThrow('practice')
    const practice = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => fixture(o) })
    const transport = vi.fn(async (o: ChatOptions) => { if (['solve_english_question', 'solve_visible_question'].includes(o.tools?.[0]?.function.name ?? '')) expect(data(o)).not.toHaveProperty('practiceQuestions'); else expect(data(o).practiceQuestions).toEqual(currentQuestionContext(practice.questions)); return fixture(o) })
    expect((await buildWaypointQuiz(input, reviewed, 'check', { provider, transport, previousPractice: practice })).complete).toBe(true)
  })
  it('does not request the next operation after a failed write or cancellation', async () => {
    const transport = vi.fn(async o => fixture(o))
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, onCheckpoint: async () => { throw new Error('Storage failed') } })).rejects.toMatchObject({
      failure: { category: 'persistence_error', layer: 'persistence', checkpointId: 'practice-quiz' }, cause: { message: 'Storage failed' },
    })
    expect(transport).toHaveBeenCalledTimes(1)
    const controller = new AbortController(); transport.mockClear()
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, signal: controller.signal, onCheckpoint: async () => { controller.abort() } })).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('English-only concealment before question acceptance', () => {
  it.each([
    'This seems conventional, although another choice could fit.',
    'This seems conventional, although another choice could fit.'.padEnd(1000, 'x'),
  ])('preserves uncertainty when a solver choice differs from the key (reason: %.60s)', async reason => {
    let leaked = false, revisions = 0
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      if (o.tools?.[0]?.function.name === 'solve_english_question' && !leaked) {
        leaked = true
        return submit(o, { answerId: 'B', reason })
      }
      if (data(o).generationMode === 'revise_question_answers') {
        revisions++
        expect(data(o).revision).toContain('model observation, not verified evidence')
        expect(data(o).revision).toContain('another choice could fit')
        expect(data(o).revision).not.toContain('English alone supports choice')
        expect(data(o).candidateToRevise.correct).toBe('A')
      }
      return fixture(o)
    } })
    expect(leaked).toBe(true)
    expect(revisions).toBe(1)
    expect(quiz.complete).toBe(true)
    expect(quiz.questions.every(q => q.concealmentReview?.answerId === 'unknown')).toBe(true)
  })

  it('resumes after persisting a solver result without repeating the unchanged question solve', async () => {
    let checkpoint: WaypointQuiz | undefined
    const abort = new AbortController(), solved: string[] = []
    const transport = async (o: ChatOptions) => {
      if (o.tools?.[0]?.function.name === 'solve_english_question') solved.push(data(o).stem)
      return fixture(o)
    }
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, signal: abort.signal,
      onCheckpoint: async q => {
        checkpoint = structuredClone(q)
        if (q.pending?.step === 'concealment' && q.pending.concealmentReview) abort.abort()
      } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(checkpoint!.questions).toHaveLength(0)
    expect(checkpoint!.pending!.concealmentReview!.answerId).toBe('unknown')
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint })
    expect(quiz.complete).toBe(true)
    expect(solved).toHaveLength(2)
    expect(new Set(solved).size).toBe(2)
  })

  it('rejects a changed accepted question with stale concealment evidence', async () => {
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => fixture(o) })
    const altered = structuredClone(quiz)
    altered.questions[0]!.concealmentReview!.questionHash = '0'.repeat(64)
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, checkpoint: altered,
      transport: async () => { throw new Error('No inference should occur for invalid checkpoint evidence.') } })).rejects.toThrow(/Concealment/i)
  })
})

describe('mechanical question repair belongs to authoring', () => {
  it('repairs Hanzi in an English stem with the build tool before any semantic review', async () => {
    let invalidAuthored = false, repaired = false
    const quiz = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport: async o => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'build_question_answers' && !invalidAuthored) {
        invalidAuthored = true
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem += ' 谢谢'
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      } else if (d.generationMode === 'build_question_answers' && d.nativeSubmissionIssue) {
        expect(d.nativeSubmissionIssue).toContain('Lesson instructions must be in English')
        expect(d.candidateSubmission.stem).toContain('谢谢')
        repaired = true
      }
      if (d.generationMode === 'verify_correct_question') expect(d.candidate.stem).not.toMatch(/\p{Script=Han}/u)
      return response
    } })
    expect(repaired).toBe(true)
    expect(quiz.complete).toBe(true)
    expect(quiz.replanning).toBeUndefined()
  })

  it('persists bounded replanning after authoring repairs exhaust, without reviewing or accepting the invalid question', async () => {
    const abort = new AbortController()
    let checkpoint: WaypointQuiz | undefined, invalidAttempts = 0, reviewedInvalid = false
    const transport = async (o: ChatOptions) => {
      const d = data(o), response = fixture(o)
      if (d.generationMode === 'build_question_answers' && !d.currentQuestions.length && !d.rejectedDirections?.length) {
        invalidAttempts++
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.stem += ' 谢谢'
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      if (d.generationMode === 'verify_correct_question' && /\p{Script=Han}/u.test(d.candidate.stem)) reviewedInvalid = true
      return response
    }
    await expect(buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, signal: abort.signal,
      onCheckpoint: async q => { checkpoint = structuredClone(q); if (q.replanning) abort.abort() } })).rejects.toMatchObject({ name: 'AbortError' })
    expect(invalidAttempts).toBe(2)
    expect(reviewedInvalid).toBe(false)
    expect(checkpoint!.questions).toHaveLength(0)
    expect(checkpoint!.pending).toBeUndefined()
    expect(checkpoint!.replanning!.rejectedDirections).toHaveLength(1)
    expect(checkpoint!.replanning!.rejectedDirections[0]!.candidate.stem).toContain('谢谢')
    const resumed = await buildWaypointQuiz(input, reviewed, 'practice', { provider, transport, checkpoint })
    expect(resumed.complete).toBe(true)
    expect(invalidAttempts).toBe(2)
    expect(reviewedInvalid).toBe(false)
  })
})
