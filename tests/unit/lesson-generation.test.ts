import { buildChatRequest } from '../../src/lib/ai/chatRequest'
import { LESSON_WORKFLOW_VERSION, LESSON_PROMPT_VERSION } from '../../src/lib/teacher/lessonGeneration/stages'
import { describe, expect, it, vi } from 'vitest'
import type { ChatOptions } from '../../src/lib/ai/types'
import { executeLessonStage } from '../../src/lib/teacher/lessonGeneration/executeStage'
import { lessonStages } from '../../src/lib/teacher/lessonGeneration/stages'
import evaluatedProfile from '../../src/lib/teacher/lessonGeneration/profiles/featherless-qwen-v6.json'
import glmProfile from '../../src/lib/teacher/lessonGeneration/profiles/featherless-glm-native-v1.json'
import { assembleLessonPrompt } from '../../src/lib/teacher/lessonGeneration/assemblePrompt'
import { selectLessonModelProfile, resolveLessonModelProfile, lessonModelProfileSchema, type LessonModelProfile } from '../../src/lib/teacher/lessonGeneration/modelProfiles'
import { generateLesson } from '../../src/lib/teacher/lessonGeneration/workflow'
import { lessonFixture, lessonCases, runCase } from '../evaluation/lesson-runner'
import { waypointResult } from '../fixtures/topic-lesson'
import { currentToolMessage, parseToolContext, parseToolProjection } from '../fixtures/tool-context'
import type { LessonPreparation, LessonGraphDraft } from '../../src/lib/domain/lessonPreparation'
import type { WaypointLessonInput } from '../../src/lib/domain/lessonGraph'
import { validateGap } from '../../src/lib/teacher/questionGapTools'
import { applyWaypoint } from '../../src/lib/teacher/lessonGraphTools'

const provider = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', compatibility: 'featherless' as const }
const input: WaypointLessonInput = {
  kind: 'topic', objective: 'Understand thanks and apologies.', conversationContext: '谢谢。对不起。',
  settings: { quizLevel: 'meaningHanzi', complexity: 'phrases', scope: 'everyday', focus: 'characters', topic: 'Courtesy' },
  targets: [{ cardId: 'c1', hanzi: '谢谢', meaning: 'Thank you.' }, { cardId: 'c2', hanzi: '对不起', meaning: 'Sorry.' }],
  sources: [{ id: 's1', title: 'Courtesy', excerpt: '谢谢 means thank you; 对不起 means sorry.' }],
}
const profile: LessonModelProfile = { id: 'test-model', version: '1', guidance: 'Use the named native tool.',
  stages: { reviewWaypoint: { guidance: 'Keep the reason short.', generation: { temperature: 0, maxTokens: 1024, reasoning: 'on' } } } }
const verdict = { decision: 'accept', reason: 'Authored review.' }

describe('lesson generation framework boundaries', () => {
  it('opts one stage into task placement without changing accepted work or correction dispatches', async () => {
    const run = async (tail: boolean) => {
      const requests: ChatOptions[] = []
      let injected = false
      const selected: LessonModelProfile = { id: 'layout-control', version: '1',
        ...(tail ? { stages: { buildQuestion: { taskPlacement: 'user_context_tail' } } } : {}) }
      const preparation = await generateLesson(input, { provider, modelProfile: selected, transport: async request => {
        requests.push(request)
        const response = await lessonFixture(request)
        if (!injected && request.generationTrace!.stage === 'buildQuestion') {
          injected = true
          const args = JSON.parse(response.toolCalls[0]!.function.arguments)
          delete args.answerA
          response.toolCalls[0]!.function.arguments = JSON.stringify(args)
        }
        return response
      } })
      return { preparation, requests }
    }
    const baseline = await run(false), candidate = await run(true)
    expect(candidate.preparation).toEqual(baseline.preparation)
    expect(candidate.requests.map(r => r.generationTrace!.stage)).toEqual(baseline.requests.map(r => r.generationTrace!.stage))
    let corrected = false
    for (const [index, request] of candidate.requests.entries()) {
      const original = baseline.requests[index]!
      if (request.generationTrace!.stage !== 'buildQuestion') {
        expect(request.messages).toEqual(original.messages)
        expect(request.generationTrace!.taskPlacement).toBe('system')
        continue
      }
      expect(request.generationTrace!.taskPlacement).toBe('user_context_tail')
      const { currentTask, ...projected } = parseToolProjection(currentToolMessage(request.messages).content!)
      expect(Object.keys(parseToolProjection(currentToolMessage(request.messages).content!)).at(-1)).toBe('currentTask')
      expect(parseToolContext(currentToolMessage(request.messages).content!)).toEqual(projected)
      expect(projected).toEqual(parseToolContext(original.messages[1]!.content!))
      expect(request.messages[0]!.content).toBe(original.messages[0]!.content!.replace(currentTask, ''))
      expect(request.tools).toEqual(original.tools)
      corrected ||= Boolean(projected.nativeSubmissionIssue)
    }
    expect(corrected).toBe(true)
    const inherited: LessonModelProfile = { id: 'inheritance', version: '1', taskPlacement: 'user_context_tail',
      stages: { reviewWaypoint: { taskPlacement: 'system' } } }
    expect(resolveLessonModelProfile(inherited, 'buildQuestion').taskPlacement).toBe('user_context_tail')
    expect(resolveLessonModelProfile(inherited, 'reviewWaypoint').taskPlacement).toBe('system')
    expect(resolveLessonModelProfile(undefined, 'buildQuestion', { ...provider, model: 'Qwen/Qwen3.8-27B' }).taskPlacement).toBe('system')
  })
  it.each(['meaningPinyin', 'meaningHanzi', 'responsePinyin', 'responseHanzi'] as const)(
    'selects only the guidance for the actual answer direction: %s', async quizLevel => {
      const requests: ChatOptions[] = []
      const selected: LessonModelProfile = { id: 'direction-test', version: '1', guidance: 'Common protocol.',
        stages: { reviewWaypoint: { comprehensionGuidance: 'English-comprehension demonstration.', replyGuidance: 'Mandarin-reply demonstration.' } } }
      await executeLessonStage({ provider, modelProfile: selected,
        transport: async request => { requests.push(request); return waypointResult(request, verdict) },
      }, lessonStages.reviewWaypoint, { ...input, settings: { ...input.settings, quizLevel } })
      const system = requests[0]!.messages[0]!.content!
      const comprehension = quizLevel.startsWith('meaning')
      expect(system).toContain(comprehension ? 'English-comprehension demonstration.' : 'Mandarin-reply demonstration.')
      expect(system).not.toContain(comprehension ? 'Mandarin-reply demonstration.' : 'English-comprehension demonstration.')
      expect(requests[0]!.generationTrace!.modelProfile.id).toBe('direction-test')
      expect(resolveLessonModelProfile(selected, 'buildWaypoint', provider, quizLevel).guidance).toBe('Common protocol.')
    },
  )
  it('changes only local decoding when function-opening compatibility is selected', async () => {
    const requests: ChatOptions[] = []
    const selectedProvider = { ...provider, model: 'Qwen/Qwen3.8-27B' }
    const transport = async (request: ChatOptions) => { requests.push(request); return waypointResult(request, verdict) }
    const selected = selectLessonModelProfile(undefined, selectedProvider)
    const strict = { ...selected, protocol: { ...selected.protocol!, normalizeFunctionOpening: false } }
    await executeLessonStage({ provider: selectedProvider, transport, modelProfile: strict }, lessonStages.reviewWaypoint, input)
    await executeLessonStage({ provider: selectedProvider, transport }, lessonStages.reviewWaypoint, input)
    expect(requests[0]!.normalizeFunctionOpening).toBe(false)
    expect(requests[1]!.normalizeFunctionOpening).toBe(true)
    expect(buildChatRequest(requests[0]!)).toEqual(buildChatRequest(requests[1]!))
    expect(requests[0]!.generationTrace!.modelProfile.hash).not.toBe(requests[1]!.generationTrace!.modelProfile.hash)
  })

  it.each(['c1, c2', 'unknown'])('repairs an invalid single question target %s using its supplied alternatives', async invalid => {
    let injected = false
    const repairs: ReturnType<typeof parseToolContext>[] = []
    const preparation = await generateLesson(input, { provider, transport: async request => {
      const context = parseToolContext(currentToolMessage(request.messages).content!)
      const result = await lessonFixture(request)
      if (request.tools?.[0]?.function.name === 'list_missing_questions') {
        if (!injected) {
          injected = true
          const call = result.toolCalls[0]!, args = JSON.parse(call.function.arguments)
          call.function.arguments = JSON.stringify({ ...args, cardId: invalid })
        } else if (context.candidateSubmission?.cardId === invalid) repairs.push(context)
      }
      return result
    } })
    expect(preparation.check!.complete).toBe(true)
    expect(repairs).toHaveLength(1)
    expect(repairs[0]!.nativeSubmissionIssue).toContain('cardId')
    expect(repairs[0]!.nativeSubmissionIssue).toContain('cardId')
    for (const quiz of [preparation.practice!, preparation.check!]) {
      expect(quiz.questions.every(question => input.targets.some(target => target.cardId === question.gap.cardId))).toBe(true)
    }
  })

  it('identifies both valid target choices and the teaching waypoint when references disagree', async () => {
    const preparation = await generateLesson(input, { provider, transport: lessonFixture })
    const graph = preparation.lesson!.graph
    const first = graph.waypoints.find(waypoint => waypoint.cardIds.includes('c1'))!
    const second = graph.waypoints.find(waypoint => waypoint.cardIds.includes('c2'))!
    const gap = { waypointIds: [first.id], cardId: 'c2', intent: 'Recognize an apology.', whyMissing: 'This understanding is not assessed.' }
    expect(() => validateGap(gap, graph, input)).toThrow(`These waypoints teach ["c1"]`)
    expect(() => validateGap(gap, graph, input)).toThrow(`This target is taught by ["${second.id}"]`)
    expect(() => validateGap({ ...gap, cardId: 'c1, c2' }, graph, input)).toThrow('Choose exactly one supplied target ID: ["c1","c2"]')
  })

  it('assembles identical requests for implicit and explicitly injected evaluated profiles', async () => {
    const requests: ChatOptions[] = []
    const selectedProvider = { ...provider, model: 'Qwen/Qwen3.8-27B' }
    const context = { ...input, graph: { overview: '', waypoints: [] }, candidate: { id: 'w1' } }
    const transport = async (request: ChatOptions) => { requests.push(request); return waypointResult(request, verdict) }
    await executeLessonStage({ provider: selectedProvider, transport }, lessonStages.reviewWaypoint, context)
    await executeLessonStage({ provider: selectedProvider, transport, modelProfile: lessonModelProfileSchema.parse(evaluatedProfile) }, lessonStages.reviewWaypoint, context)
    expect(buildChatRequest(requests[0]!)).toEqual(buildChatRequest(requests[1]!))
    expect(requests[0]!.generationTrace).toEqual(requests[1]!.generationTrace)
    expect(requests[0]!.toolResponseDialect).toBe(requests[1]!.toolResponseDialect)
    expect(requests[0]!.normalizeParameterNameQuotes).toBe(requests[1]!.normalizeParameterNameQuotes)
    expect(requests[0]!.allowAssistantPrefix).toBe(requests[1]!.allowAssistantPrefix)
  })

  it.each(['Qwen/Qwen3.8-27B', 'Qwen/Qwen3.8-Flash-Next'])('selects the evaluated profile consistently for %s without caller injection', async model => {
    const selectedProvider = { ...provider, model }
    expect(selectLessonModelProfile(undefined, selectedProvider)).toEqual(lessonModelProfileSchema.parse(evaluatedProfile))
    const requests: ChatOptions[] = []
    const transport = async (request: ChatOptions) => { requests.push(request); return lessonFixture(request) }
    const preparation = await generateLesson(input, { provider: selectedProvider, transport })
    expect(preparation.practice!.complete && preparation.check!.complete).toBe(true)
    expect(requests.every(request => request.generationTrace!.modelProfile.id === evaluatedProfile.id)).toBe(true)
    expect(requests.every(request => request.toolResponseDialect === 'qwen_xml')).toBe(true)
    expect(requests.every(request => currentToolMessage(request.messages).content!.includes('<tool_call><function='))).toBe(true)
    expect(requests.filter(request => request.generationTrace!.stage === 'evaluateCoverage').every(request => request.featherlessThinking === false)).toBe(true)
  })
  it('retains the shared profile for unknown aliases and other providers', () => {
    for (const candidate of [{ ...provider, model: 'Qwen/untested' }, { ...provider, model: 'qwen/qwen3.8-27b' },
      { ...provider, model: 'Qwen/Qwen3.8-27B', compatibility: 'nebius' as const },
      { ...provider, model: 'zai-org/GLM-5.3-Flash', compatibility: 'nebius' as const }]) {
      expect(selectLessonModelProfile(undefined, candidate)).toEqual({ id: 'shared', version: '1' })
      expect(resolveLessonModelProfile(undefined, 'evaluateCoverage', candidate)).toMatchObject({ protocol: { toolResponseDialect: 'native' }, generation: { reasoning: 'on' } })
    }
  })
  it('completes a GLM fixture lesson with native demonstrations preserved through correction', async () => {
    const selectedProvider = { ...provider, model: 'zai-org/GLM-5.3-Flash' }
    expect(selectLessonModelProfile(undefined, selectedProvider)).toEqual(lessonModelProfileSchema.parse(glmProfile))
    expect(selectLessonModelProfile(profile, selectedProvider)).toEqual(profile)
    const requests: ChatOptions[] = []
    let failed = false
    const completed = await generateLesson(input, { provider: selectedProvider, transport: async request => {
      requests.push(request)
      if (request.tools?.[0]?.function.name === 'verify_correct_question' && !failed) {
        failed = true
        return { content: '', reasoning: '', toolCalls: [], model: selectedProvider.model, finishReason: 'stop' }
      }
      return lessonFixture(request)
    } })
    expect(completed.check?.complete).toBe(true)
    const reviews = requests.filter(r => r.tools?.[0]?.function.name === 'verify_correct_question')
    expect(reviews.length).toBeGreaterThan(2)
    for (const request of reviews) {
      expect(request.toolResponseDialect).toBe('native')
      expect(request.generationTrace?.modelProfile.id).toBe(glmProfile.id)
      expect(request.messages[0]!.role).toBe('system')
      expect(request.messages.at(-1)!.role).toBe('user')
      const examples = request.messages.slice(1, -1)
      expect(examples.length).toBeGreaterThanOrEqual(6)
      for (let i = 0; i < examples.length; i += 3) expect(examples.slice(i, i + 3).map(m => m.role)).toEqual(['user', 'assistant', 'tool'])
      expect(buildChatRequest(request).payload.messages).toEqual(request.messages)
      const context = parseToolContext(request.messages.at(-1)!.content!)
      expect(context.generationMode).toBe('verify_correct_question')
      expect(context.candidate).toBeDefined()
    }
    expect(reviews[1]!.messages.slice(0, -1)).toEqual(reviews[0]!.messages.slice(0, -1))
    expect(parseToolContext(reviews[1]!.messages.at(-1)!.content!).nativeSubmissionIssue).toBeTruthy()
    expect(requests.filter(r => !['verify_correct_question', 'add_lesson_waypoint'].includes(r.tools?.[0]?.function.name ?? '')).every(r => r.messages.length === 2)).toBe(true)
    const evaluated = await runCase(lessonCases.find(c => c.id === 'topic-responsePinyin')!, {
      mode: 'fixture', lessonModelProfile: lessonModelProfileSchema.parse(glmProfile),
    })
    expect(evaluated.prepared && evaluated.scriptedPlaybackCompleted).toBe(true)
    expect(evaluated.calls.every(c => !c.repair)).toBe(true)
  })
  it('corrects a bundled phrase example through the native waypoint tool while preserving its valid fields', async () => {
    for (const example of glmProfile.stages.buildWaypoint.nativeExamples) {
      expect(() => applyWaypoint({ overview: '', waypoints: [] }, 'w1', example.arguments, example.context as unknown as WaypointLessonInput)).not.toThrow()
    }
    const candidate = { cardIds: ['c1', 'c2'], dependsOn: [], objective: 'Distinguish thanks from apologies.',
      explanation: 'Use 谢谢 to thank someone and 对不起 to apologize.', exampleHanzi: '谢谢。对不起。', exampleMeaning: 'Thank you. Sorry.', sourceIds: ['s1'] }
    const corrected = { ...candidate, exampleHanzi: '谢谢。', exampleMeaning: 'Thank you.' }
    const requests: ChatOptions[] = []
    const result = await executeLessonStage({ provider: { ...provider, model: 'zai-org/GLM-5.3-Flash' }, transport: async request => {
      requests.push(request)
      return waypointResult(request, requests.length === 1 ? candidate : corrected)
    } }, lessonStages.buildWaypoint, { ...input, graph: { overview: '', waypoints: [] }, nextWaypointId: 'w1' },
    value => { applyWaypoint({ overview: '', waypoints: [] }, 'w1', value, input) })
    expect(result.value).toEqual(corrected)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.slice(0, -1)).toEqual(requests[0]!.messages.slice(0, -1))
    const correction = parseToolContext(requests[1]!.messages.at(-1)!.content!)
    expect(correction.candidateSubmission).toEqual(candidate)
    expect(correction.nativeSubmissionIssue).toContain('2 separate Mandarin sentences')
    expect(requests[1]!.messages.filter(m => m.role === 'assistant')).toHaveLength(2)
  })
  it('rejects malformed native example arguments before dispatch', async () => {
    const transport = vi.fn()
    await expect(executeLessonStage({ provider, transport, modelProfile: { id: 'invalid-example', version: '1',
      stages: { reviewQuestion: { nativeExamples: [{ context: {}, arguments: { decision: 'unknown' } }] } } } },
    lessonStages.reviewQuestion, { ...input, phase: 'practice' })).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
  it('excludes native examples from isolated solver prompts and XML profiles', () => {
    const nativeExamples = glmProfile.stages.reviewQuestion.nativeExamples
    const tool = { name: 'solve_english_question', description: 'Solve the visible English.', parameters: {} }
    for (const options of [{ isolatedContext: { stem: 'What does this expression mean?' } }, { dialect: 'qwen_xml' as const }]) {
      const compiled = assembleLessonPrompt(tool, { ...input, phase: 'practice' }, 'Solve the exercise.', { nativeExamples, ...options })
      expect(compiled.messages).toHaveLength(2)
      expect(JSON.stringify(compiled.messages)).not.toContain('demo-w1')
    }
  })
  it('keeps an explicit experimental override authoritative for a known model', async () => {
    const selectedProvider = { ...provider, model: 'Qwen/Qwen3.8-27B' }
    expect(selectLessonModelProfile(profile, selectedProvider)).toEqual(profile)
    const requests: ChatOptions[] = []
    await executeLessonStage({ provider: selectedProvider, modelProfile: profile,
      transport: async request => { requests.push(request); return waypointResult(request, verdict) } },
      lessonStages.reviewWaypoint, { ...input, graph: { overview: '', waypoints: [] }, candidate: { id: 'w1' } })
    expect(requests[0]).toMatchObject({ toolResponseDialect: 'native', generationTrace: { modelProfile: { id: profile.id } } })
    expect(requests[0]!.messages[1]!.content).toContain('Submit exactly one native tool call.')
  })

  it('stops at the whole-lesson request budget and resumes its saved candidate without reauthoring', async () => {
    let draft: LessonGraphDraft | undefined
    const transport = vi.fn(lessonFixture)
    await expect(generateLesson(input, { provider, transport, workflowPolicy: { maxRequests: 1 },
      onGraphDraft: async value => { draft = value } })).rejects.toMatchObject({ failure: { category: 'budget_exhausted', checkpointId: 'lesson-workflow' } })
    expect(transport).toHaveBeenCalledOnce()
    expect(draft!.pending).toBeDefined()
    transport.mockClear()
    const lesson = await generateLesson(input, { provider, transport, graphDraft: draft })
    expect(parseToolContext(currentToolMessage(transport.mock.calls[0]![0].messages).content!).generationMode).toBe('verify_lesson_waypoint')
    expect(lesson.check!.complete).toBe(true)
  })
  it('changes model guidance and settings without changing tools, projections, or acceptance', async () => {
    const requests: ChatOptions[] = []
    const transport = vi.fn(async (o: ChatOptions) => { requests.push(o); return waypointResult(o, verdict) })
    const context = { ...input, graph: { overview: '', waypoints: [] }, candidate: { id: 'w1' } }
    await executeLessonStage({ provider, transport }, lessonStages.reviewWaypoint, context)
    await executeLessonStage({ provider, transport, modelProfile: profile }, lessonStages.reviewWaypoint, context)
    const [base, adapted] = requests as [ChatOptions, ChatOptions]
    expect(adapted.tools).toEqual(base.tools)
    expect(adapted.toolChoice).toEqual(base.toolChoice)
    expect(adapted.messages[1]).toEqual(base.messages[1])
    expect(adapted.messages[0]!.content).toBe(base.messages[0]!.content + '\n\nModel guidance:\nUse the named native tool.\nKeep the reason short.')
    expect(adapted.messages[0]!.content?.startsWith('Tool: verify_lesson_waypoint')).toBe(true)
    expect(adapted.messages[1]!.content?.endsWith('Submit exactly one native tool call.')).toBe(true)
    expect(adapted).toMatchObject({ maxTokens: 1024, temperature: 0, featherlessThinking: true,
      generationTrace: { workflowVersion: LESSON_WORKFLOW_VERSION, promptVersion: LESSON_PROMPT_VERSION,
        modelProfile: { id: 'test-model', version: '1' }, stage: 'reviewWaypoint' } })
    expect(adapted.generationTrace!.modelProfile.hash).not.toBe(base.generationTrace!.modelProfile.hash)
    expect(base).toMatchObject({ maxTokens: 4096, temperature: 0.2, featherlessThinking: false })
    expect(context).not.toHaveProperty('generationMode')
  })

  it('keeps model revisions distinguishable even if their profile version was not bumped', async () => {
    const traces: ChatOptions['generationTrace'][] = []
    const transport = async (o: ChatOptions) => { traces.push(o.generationTrace); return waypointResult(o, verdict) }
    await executeLessonStage({ provider, transport, modelProfile: profile }, lessonStages.reviewWaypoint, input)
    await executeLessonStage({ provider, transport, modelProfile: { ...profile, guidance: 'A revised instruction.' } }, lessonStages.reviewWaypoint, input)
    expect(traces[0]!.modelProfile.hash).not.toBe(traces[1]!.modelProfile.hash)
  })

  it('does not leak provider-specific reasoning parameters to other providers', async () => {
    const transport = vi.fn(async (o: ChatOptions) => waypointResult(o, verdict))
    await executeLessonStage({ provider: { ...provider, compatibility: 'standard' }, transport, modelProfile: profile }, lessonStages.reviewWaypoint, input)
    expect(transport.mock.calls[0]![0]).not.toHaveProperty('featherlessThinking')
  })

  it('rejects attempts to put workflow policy, unknown stages, or oversized budgets in profiles', () => {
    for (const extra of [{ retries: 20 }, { generation: { maxTokens: 4097 } }, { stages: { madeUpStage: {} } }, { stages: { reviewWaypoint: { schema: {} } } }]) {
      expect(() => lessonModelProfileSchema.parse({ ...profile, ...extra })).toThrow()
    }
  })

  it('retains validation and bounded corrections under an adapted profile', async () => {
    const transport = vi.fn(async (o: ChatOptions) => waypointResult(o, { ...verdict, replacement: 'not allowed' }))
    await expect(executeLessonStage({ provider, transport, modelProfile: profile }, lessonStages.reviewWaypoint, input)).rejects.toThrow('correction budget exhausted')
    expect(transport).toHaveBeenCalledTimes(2)
    const corrected = transport.mock.calls[1]![0]
    expect(corrected.messages.map(m => m.role)).toEqual(['system', 'user'])
    expect(parseToolContext(currentToolMessage(corrected.messages).content!).candidateSubmission).toMatchObject({ replacement: 'not allowed' })
  })

  it('saves the approved lesson before any quiz work, then resumes from it', async () => {
    let checkpoint: LessonPreparation | undefined, draft: LessonGraphDraft | undefined
    const transport = vi.fn(lessonFixture)
    await expect(generateLesson(input, { provider, transport,
      onGraphDraft: async value => { draft = value },
      onLesson: async value => { checkpoint = value; throw new Error('Storage unavailable') },
    })).rejects.toMatchObject({ failure: { category: 'persistence_error', checkpointId: 'reviewed-lesson' }, cause: { message: 'Storage unavailable' } })
    expect(draft!.graph.waypoints.length).toBeGreaterThan(0)
    expect(transport.mock.calls.every(([o]) => !parseToolContext(currentToolMessage(o.messages).content!).phase)).toBe(true)
    transport.mockClear()
    const completed = await generateLesson(input, { provider, transport, checkpoint,
      onQuiz: async (phase, quiz) => { checkpoint = { ...checkpoint!, [phase]: quiz } },
    })
    expect(completed.check?.complete).toBe(true)
    expect(transport.mock.calls.every(([o]) => ['solve_english_question', 'solve_visible_question'].includes(o.tools?.[0]?.function.name ?? '') || parseToolContext(currentToolMessage(o.messages).content!).phase)).toBe(true)
    transport.mockClear()
    await generateLesson(input, { provider, transport, checkpoint: completed })
    expect(transport).not.toHaveBeenCalled()
  })

  it('records the selected model profile through the real service and evaluator', async () => {
    const result = await runCase(lessonCases[0]!, { mode: 'fixture', lessonModelProfile: profile })
    expect(result.failure).toBeNull()
    expect(result.scriptedPlaybackCompleted).toBe(true)
    expect(result.calls.every(c => c.request.generationTrace?.modelProfile.id === profile.id)).toBe(true)
    const review = result.calls.find(c => c.mode === 'verify_lesson_waypoint')!
    expect(review.request.maxTokens).toBe(1024)
    expect(review.request.messages[0]!.content).toContain('Keep the reason short.')
    const build = result.calls.find(c => c.mode === 'add_lesson_waypoint')!
    expect(build.request.maxTokens).toBe(4096)
    expect(build.request.messages[0]!.content).not.toContain('Keep the reason short.')
  })

  it('does not begin the check when saving completed practice fails', async () => {
    let saved: LessonPreparation | undefined
    const transport = vi.fn(lessonFixture)
    await expect(generateLesson(input, { provider, transport,
      onLesson: async value => { saved = value },
      onQuiz: async (phase, quiz) => {
        if (quiz.complete) throw new Error('Practice write failed')
        saved = { ...saved!, [phase]: quiz }
      },
    })).rejects.toMatchObject({ failure: { category: 'persistence_error', checkpointId: 'practice-quiz' }, cause: { message: 'Practice write failed' } })
    expect(saved!.practice?.complete).toBe(false)
    expect(saved!.check).toBeUndefined()
    expect(transport.mock.calls.some(([o]) => parseToolContext(currentToolMessage(o.messages).content!).phase === 'check')).toBe(false)
    transport.mockClear()
    const resumed = await generateLesson(input, { provider, transport, checkpoint: saved })
    expect(resumed.check?.complete).toBe(true)
    expect(transport.mock.calls.every(([o]) => ['solve_english_question', 'solve_visible_question'].includes(o.tools?.[0]?.function.name ?? '') || parseToolContext(currentToolMessage(o.messages).content!).phase === 'check')).toBe(true)
  })
})
