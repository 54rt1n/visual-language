import { candidateModels, modelMatrix, evaluationApiKey } from '../evaluation/model-matrix'
import { LESSON_WORKFLOW_VERSION, LESSON_PROMPT_VERSION } from '../../src/lib/teacher/lessonGeneration/stages'
import { englishAnswers } from '../../src/lib/domain/lessonSettings'
import { currentToolMessage, parseToolContext } from '../fixtures/tool-context'
import { describe, expect, it, vi } from 'vitest'
import { lessonCases, rawLessonCases, rawLessonEvaluationPolicy, lessonFixture, runCase, summarize, validateCorpus } from '../evaluation/lesson-runner'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const fixture = { mode: 'fixture' as const }
describe('prepared waypoint lesson evaluation', () => {
  it('evaluates raw topic entry through reviewed scope, both quizzes and complete playback', async () => {
    const result = await runCase(rawLessonCases[0]!, fixture)
    expect(result.entryPoint).toBe('raw-request')
    expect(result.failure).toBeNull()
    expect(result.scriptedPlaybackCompleted).toBe(true)
    expect(result.artifacts.creation!.discoveryPlanning!.accepted!.points).toHaveLength(4)
    const prep = result.artifacts.plan!.preparation!
    expect(prep.input.sourceMaterial!.scope).toEqual(result.artifacts.creation!.discoveryPlanning!.accepted)
    expect(prep.input.targets).toHaveLength(4)
    expect(prep.practice!.coverage).toHaveLength(4); expect(prep.check!.coverage).toHaveLength(4)
    expect(result.calls.slice(0, 4).map(c => c.mode)).toEqual(['ground_lesson', 'propose_lesson_points', 'review_lesson_scope', 'review_lesson_source'])
    expect(result.checkpointCommits.filter(c => c.checkpointId === 'lesson-scope').every(c => c.persisted)).toBe(true)
    expect(Object.values(result.invariants).every(Boolean)).toBe(true)
    expect(rawLessonEvaluationPolicy.evaluation).toEqual({ maxRequests: 272, timeBudgetMs: 2_700_000 })
  }, 15_000) // Full offline creation, both quizzes and playback need headroom on shared CI runners.
  it('retains raw creation checkpoints and failure evidence before a canonical lesson exists', async () => {
    const result = await runCase(rawLessonCases[0]!, fixture, undefined, async options => {
      if (options.tools?.[0]?.function.name === 'review_lesson_scope') throw new Error('Interrupted scope review fixture.')
      return lessonFixture(options)
    })
    expect(result.failure!.message).toBe('Interrupted scope review fixture.')
    expect(result.prepared).toBe(false)
    expect(result.artifacts.creation!.discoveryPlanning!.candidate).toHaveLength(4)
    expect(result.artifacts.creation!.discoveryPlanning!.accepted).toBeUndefined()
    expect(result.invariants.backupRoundTrip).toBe(true)
  })
  it('lists provider-qualified candidates and resolves credentials without cross-provider fallback', () => {
    expect(new Set(modelMatrix.map(row => `${row.provider}:${row.model}`)).size).toBe(modelMatrix.length)
    expect(candidateModels).toEqual(expect.arrayContaining(['MiniMax-M2.7', 'MiniMax-M3', 'MiniMax-M3.1-Flash-Preview', 'qwen3.8-max', 'deepseek-ai/DeepSeek-V4-Flash-0731']))
    expect(modelMatrix.find(row => row.model === 'MiniMax-M3')?.provider).toBe('minimax')
    expect(modelMatrix.find(row => row.model === 'nvidia/nemotron-3.5-lightning:free')?.provider).toBe('openrouter')
    expect(modelMatrix.find(row => row.model === 'nvidia/Nemotron-3_5-Lightning')?.provider).toBe('nebius')
    const env = { MINIMAX_TOKEN_KEY: 'mini', ALIBABA_TOKEN_KEY: 'ali', FEATHERLESS_API_KEY: 'feather', OPENROUTER_API_KEY: 'router' }
    expect(evaluationApiKey('minimax', env)).toBe('mini')
    expect(evaluationApiKey('alibaba', env)).toBe('ali')
    expect(evaluationApiKey('nebius', env)).toBe('')
    expect(evaluationApiKey('openrouter', env)).toBe('router')
    expect(evaluationApiKey('openrouter', { FEATHERLESS_API_KEY: 'feather' })).toBe('')
    expect(evaluationApiKey('minimax', { ...env, MINIMAX_API_KEY: 'primary' })).toBe('primary')
  })
  it.each([{ caseId: 'topic-meaningPinyin', invalid: true }, { caseId: 'topic-responseHanzi', invalid: false }])(
    'reconstructs $caseId without stale instructions and uses production coverage guards', async ({ caseId, invalid }) => {
      const result = await runCase(lessonCases.find(entry => entry.id === caseId)!, fixture)
      const call = structuredClone(result.calls.find(call => call.mode === 'evaluate_question_coverage')!)
      const context = parseToolContext(currentToolMessage(call.request.messages).content!)
      // Requesting the ordinal second question makes the authored CLI fixture
      // choose w2, which is a real graph ID but is not visible in this question.
      if (invalid) {
        context.question.id = 'q2'
        delete context.recognitionEligibleWaypointIds
      }
      context.currentTask = 'STALE_CAPTURED_TASK'
      currentToolMessage(call.request.messages).content = JSON.stringify(context) + '\n\nTool call:\nCaptured signature.'
      const directory = await mkdtemp(join(tmpdir(), 'lesson-stage-cli-'))
      try {
        const source = join(directory, 'source.json'), candidate = join(directory, 'profile.json'), out = join(directory, 'out.json')
        await writeFile(source, JSON.stringify({ status: 'finished', results: [{ ...result, calls: [call, ...result.calls.filter(entry => entry.mode !== 'evaluate_question_coverage')] }] }))
        await writeFile(candidate, JSON.stringify({ id: 'coverage-control', version: '1' }))
        await promisify(execFile)(process.execPath, ['scripts/experiment-lesson-stage.mjs', '--from', source,
          '--case', result.caseId, '--stage', 'evaluateCoverage', '--candidate', candidate, '--fixture', '--out', out])
        const report = JSON.parse(await readFile(out, 'utf8'))
        expect(report.scope).toMatchObject({ request: 'reconstructed_current_guidance', baseline: 'explicit_shared_profile', validation: 'production_coverage_submission' })
        expect(report.maximumDispatchesPerOperation).toBe(8)
        expect(report.maximumModelCalls).toBe(16)
        expect(report.codeHashes['tests/fixtures/tool-context.ts']).toMatch(/^[a-f0-9]{64}$/)
        for (const operation of report.operations) {
          expect(operation.accepted).toBe(!invalid)
          if (invalid) expect(operation.failureDetail).toMatchObject({ category: 'constraints_invalid', correctionExhausted: true })
          else expect(operation.result.value.waypointIds).toEqual(['w1'])
          expect(operation.modelCalls).toHaveLength(invalid ? 2 : 1)
          for (const attempt of operation.modelCalls) {
            expect(JSON.stringify(attempt.request.messages)).not.toContain('STALE_CAPTURED_TASK')
            const projected = parseToolContext(currentToolMessage(attempt.request.messages).content)
            expect(projected.graph).toEqual(context.graph)
            expect(projected.question).toEqual(context.question)
            expect(projected.question).not.toHaveProperty('correctOptionId')
          }
        }
        expect(report.summary.baseline).toMatchObject({ accepted: invalid ? 0 : 1, dispatches: invalid ? 2 : 1, corrections: invalid ? 1 : 0, requestRecoveryDispatches: 0, capacityEvents: 0 })
        if (!invalid) {
          const contaminated = join(directory, 'contaminated.json')
          await writeFile(contaminated, JSON.stringify({ id: 'undeclared-examples', version: '1', replyGuidance: 'A second experimental change.' }))
          await expect(promisify(execFile)(process.execPath, ['scripts/experiment-lesson-stage.mjs', '--from', source,
            '--case', result.caseId, '--stage', 'reviewWaypoint', '--candidate', contaminated, '--candidate-tool', 'submit_other_review']))
            .rejects.toThrow('identical resolved guidance')
          context.question.stem += ' Changed after capture.'
          currentToolMessage(call.request.messages).content = JSON.stringify(context) + '\n\nTool call:\nCaptured signature.'
          await writeFile(source, JSON.stringify({ status: 'finished', results: [{ ...result, calls: [call] }] }))
          await expect(promisify(execFile)(process.execPath, ['scripts/experiment-lesson-stage.mjs', '--from', source,
            '--case', result.caseId, '--stage', 'evaluateCoverage', '--candidate', candidate]))
            .rejects.toThrow('exactly matching reviewed question')
        }
      } finally { await rm(directory, { recursive: true, force: true }) }
  }, 15_000)
  it.each(lessonCases.flatMap(entry => ['verify_lesson_waypoint', 'verify_correct_question'].map(stage => ({ entry, stage }))))(
    'persists pending content through repository and backup before interrupted $stage for $entry.id', async ({ entry, stage }) => {
      const result = await runCase(entry, fixture, undefined, async options => {
        if (parseToolContext(currentToolMessage(options.messages).content!).generationMode === stage) throw new Error('Injected review interruption')
        return lessonFixture(options)
      })
      expect(result.failure!.message).toBe('Injected review interruption')
      expect(result.prepared).toBe(false)
      expect(result.invariants.backupRoundTrip).toBe(true)
      const plan = result.artifacts.plan!
      if (stage === 'verify_lesson_waypoint') {
        expect(plan.waypointDraft!.pending).toBeDefined()
        expect(plan.waypointDraft!.graph.waypoints).toEqual([])
        expect(plan.waypointDraft!.construction.operations).toBe(1)
      } else {
        expect(plan.preparation!.practice!.pending).toBeDefined()
        expect(plan.preparation!.practice!.questions).toEqual([])
      }
    })
  it.each([undefined, false, true, 'coverage' as const])('records the actual thinking wire flag and streamed activity: %s', async thinking => {
    const bodies: any[] = [], observed: unknown[] = []
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toContain('api.featherless.ai')
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const authored = await lessonFixture({ ...body, handlers: {} })
      const frame = { model: 'authored-wire-fixture', choices: [{ index: 0, delta: { reasoning_content: 'fixture reasoning', tool_calls: authored.toolCalls.map((c, index) => ({ ...c, index })) }, finish_reason: 'tool_calls' }] }
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      const result = await runCase(lessonCases[0]!, { mode: 'live', provider: 'featherless', model: 'authored-wire-fixture', apiKey: 'fixture-only', confirmed: true, featherlessThinking: thinking }, undefined, undefined, call => { observed.push(call) })
      expect(result.failure).toBeNull()
      expect(bodies).toHaveLength(30)
      expect(observed).toEqual(result.calls.map(({ submissionAccepted: _accepted, ...beforeAcceptance }) => beforeAcceptance))
      expect(result.calls.every(c => c.submissionAccepted === true)).toBe(true)
      for (const [index, call] of result.calls.entries()) {
        expect(bodies[index].chat_template_kwargs).toEqual({ enable_thinking: thinking === 'coverage' || thinking === undefined ? call.mode === 'evaluate_question_coverage' : thinking })
        expect(call.wireRequest).toEqual(bodies[index])
        expect(bodies[index]).not.toHaveProperty('generationTrace')
        expect(call.request.generationTrace).toMatchObject({ workflowVersion: LESSON_WORKFLOW_VERSION, modelProfile: { id: 'shared' } })
        expect(call.streamActivity).toEqual({ reasoningCharacters: 17, contentCharacters: 0 })
        expect(call.response).not.toHaveProperty('reasoning')
      }
    } finally { fetcher.mockRestore() }
  })
  it('covers three lesson kinds and four formats with fixed material across formats', () => {
    expect(validateCorpus()).toMatchObject({ cases: 12, kinds: ['topic', 'scenario', 'reading'], formats: ['meaningPinyin', 'responsePinyin', 'meaningHanzi', 'responseHanzi'] })
  })
  it.each(['topic', 'scenario', 'reading'])('uses identical initial projected context across independent %s runs', async kind => {
    const entry = lessonCases.find(entry => entry.kind === kind)!
    const first = await runCase(entry, fixture), second = await runCase(entry, fixture)
    expect(first.failure).toBeNull()
    expect(second.failure).toBeNull()
    expect(currentToolMessage(first.calls[0]!.request.messages)).toEqual(currentToolMessage(second.calls[0]!.request.messages))
    expect(first.artifacts.plan!.cardIds).toEqual(['evaluation-card-1', 'evaluation-card-2'])
    expect(first.artifacts.sources.filter(source => source.id.startsWith('evaluation-card-source-')).map(source => source.id))
      .toEqual(['evaluation-card-source-1', 'evaluation-card-source-2'])
    expect(first.artifacts.sources.map(source => source.id)).toEqual(second.artifacts.sources.map(source => source.id))
  })
  it.each(lessonCases)('prepares and exercises $id using production services', async entry => {
    const result = await runCase(entry, fixture)
    expect(result.failure).toBeNull()
    expect(result).toMatchObject({ prepared: true, scriptedPlaybackCompleted: true, humanReview: { status: 'pending', releaseReady: false } })
    expect(result.calls).toHaveLength(englishAnswers(entry.settings.quizLevel) ? 30 : 26)
    expect(Object.values(result.invariants).every(Boolean)).toBe(true)
    expect(result.calls.slice(0, 2).map(c => c.mode)).toEqual(['add_lesson_waypoint', 'verify_lesson_waypoint'])
    expect(result.calls.filter(c => c.mode === 'build_question_answers')).toHaveLength(4)
    for (const call of result.calls) {
      expect(call.request.tools).toHaveLength(1)
      const messages = call.request.messages
      expect(messages[0]!.role).toBe('system')
      expect(messages.at(-1)!.role).toBe('user')
      const examples = messages.slice(1, -1)
      expect(examples.length % 3).toBe(0)
      for (let i = 0; i < examples.length; i += 3) expect(examples.slice(i, i + 3).map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
      expect(call.repair).toBe(false)
      if (call.mode === 'verify_correct_question') {
        const context = parseToolContext(currentToolMessage(call.request.messages).content!), view = context.visibleQuestion
        expect(view.choices.map((choice: { id: string; text: string }) => ({ id: choice.id, text: choice.text })))
          .toEqual(['A', 'B', 'C', 'D'].map(id => ({ id, text: context.candidate[`answer${id}`] })))
        const pinyin = entry.settings.quizLevel.endsWith('Pinyin')
        expect(view.choices.some((choice: { pinyin?: string }) => Boolean(choice.pinyin))).toBe(pinyin && !englishAnswers(entry.settings.quizLevel))
        expect(Boolean(view.passagePinyin)).toBe(pinyin && Boolean(context.candidate.passage))
        expect(view).not.toHaveProperty('correct')
        expect(view).not.toHaveProperty('feedback')
      }
    }
    expect(result.artifacts.plan!.preparation!.practice!.complete).toBe(true)
    expect(result.artifacts.plan!.preparation!.check!.complete).toBe(true)
    expect(result.artifacts.practice!.generation.promptVersion).toBe(LESSON_PROMPT_VERSION)
    expect(result.artifacts.plan!.kind).toBe(entry.kind)
    expect(result.scriptedInteraction).toMatchObject({ total: 2, correct: 1, helped: 1 })
    expect(summarize([result], fixture, 1)).toMatchObject({ allTrialsFinished: true, lessonsReady: 1, scriptedPlaybackCompleted: 1, submissionsAccepted: englishAnswers(entry.settings.quizLevel) ? 30 : 26, submissionOutcomesUnknown: 0, liveModelCalls: 0, repairCalls: 0, humanReview: 'pending', usage: { reportedTokens: null } })
  })
  it('records a rejected question and retains earlier accepted checkpoints as evidence', async () => {
    const result = await runCase(lessonCases[0]!, fixture, undefined, async options => {
      const response = await lessonFixture(options), input = parseToolContext(currentToolMessage(options.messages).content as string)
      if (input.generationMode === 'verify_correct_question' && input.currentQuestions.length) response.toolCalls[0]!.function.arguments = JSON.stringify({ decision: 'reject', reason: 'Authored rejection.' })
      return response
    })
    expect(result.prepared).toBe(false)
    expect(result.artifacts.plan!.preparation!.practice!.questions).toHaveLength(1)
    expect(result.artifacts.practice).toBeNull()
    expect(result.invariants).toMatchObject({ preparationPreservesCardsAndEvents: true, backupRoundTrip: true })
  })
  it('rejects attempts to replace the reviewed reading example during question correction', async () => {
    const entry = lessonCases.find(c => c.id === 'reading-responsePinyin')!
    const result = await runCase(entry, fixture, undefined, async options => {
      const response = await lessonFixture(options), input = parseToolContext(currentToolMessage(options.messages).content as string)
      if (input.generationMode === 'verify_correct_question') response.toolCalls[0]!.function.arguments = JSON.stringify({ decision: 'revise', reason: 'Invalid authored correction.', ...input.candidate, workedExample: { hanzi: '塑料瓶可以回收利用。' } })
      return response
    })
    expect(result.failure!.message).toContain('workedExample')
    expect(result.prepared).toBe(false)
    expect(result.artifacts.plan!.preparation!.practice!.questions).toEqual([])
  })
  it('records transport failure and cancellation without fixture fallback', async () => {
    const result = await runCase(lessonCases[0]!, fixture, undefined, async () => { throw new Error('Fixture disconnected') })
    expect(result.failure!.message).toBe('Fixture disconnected')
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]!.parsedResponseReceived).toBe(false)
    const controller = new AbortController(); controller.abort()
    const cancelled = await runCase(lessonCases[0]!, fixture, controller.signal)
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.calls).toHaveLength(0)
    expect(cancelled.prepared).toBe(false)
    expect(summarize([cancelled], fixture, 1)).toMatchObject({ attempted: 1, trialsFinished: 0, allTrialsFinished: false })
    expect(summarize([result], fixture, 1)).toMatchObject({ trialsFinished: 1, allTrialsFinished: true, lessonsReady: 0,
      scriptedPlaybackCompleted: 0, requestsAttempted: 1, parsedResponsesReceived: 0, requestsWithoutParsedResponse: 1 })
  })
  it('rejects fake live evidence before network access', async () => {
    await expect(runCase(lessonCases[0]!, { mode: 'live', provider: 'featherless', model: 'selected', apiKey: 'test', confirmed: true }, undefined, lessonFixture)).rejects.toThrow('no fixture substitution')
  })
})
