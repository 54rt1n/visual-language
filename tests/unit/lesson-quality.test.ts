import { describe, expect, it } from 'vitest'
import { lessonCases, rawLessonCases, runCase, lessonFixture, digest } from '../evaluation/lesson-runner'
import { auditPacket, compareQualityScores, scoreLessons, scoreMarkdown, RUBRIC_VERSION, type QualityAnnotations } from '../evaluation/lesson-quality'
import { currentToolMessage, parseToolContext } from '../fixtures/tool-context'
import { englishOnlyUnit, lessonCriterionRequest, parseCriterionGrade } from '../evaluation/lesson-quality-grader'
import type { ChatResult } from '../../src/lib/ai/types'
import type { InferenceFailureRecord } from '../../src/lib/ai/inferenceFailure'
import { lessonQualityControls, summarizeGraderCalibration } from '../evaluation/lesson-quality-controls'

async function report(transport?: typeof lessonFixture) {
  const result = await runCase(lessonCases[0]!, { mode: 'fixture' }, undefined, transport)
  return JSON.stringify({ format: 'visual-language-lessons-evaluation', version: 2, status: 'finished', requestedProvider: 'fixture', requestedModel: 'fixture',
    corpusHash: 'fixed-corpus', codeHashes: { production: 'fixed' }, selectedCaseIds: [result.caseId], repetitions: 1, results: [{ ...result, repetition: 1 }] })
}
async function labels(source: string): Promise<QualityAnnotations> {
  const packet = await auditPacket(source)
  return { format: 'visual-language-lesson-quality-annotations', version: 1, rubricVersion: RUBRIC_VERSION, sourceSha256: await digest(source),
    reviewer: { id: 'authored-unit-test', type: 'human', independent: true, qualifiedMandarin: false }, units: packet.units.map(unit => ({ id: unit.id,
      ratings: unit.criteria.map(criterion => ({ criterion, score: 2, rationale: 'Synthetic grading control only.', evidence: [unit.stage === 'solve_visible_question' ? { path: 'context.prompt', quote: unit.context.prompt } : unit.stage === 'solve_english_question' ? { path: 'context.stem', quote: unit.context.stem } : { path: 'context.objective', quote: 'Distinguish thanking someone' }] })),
      ...(['verify_lesson_graph', 'verify_lesson_waypoint', 'verify_correct_question'].includes(unit.stage)
        ? { expectedDecision: unit.decision as 'accept' | 'correct' | 'reject' } : {}) })) }
}

describe('explicit raw evaluation outcomes', () => {
  it('audits raw creation scope separately from generated graph and quiz artifacts', async () => {
    const result = await runCase(rawLessonCases[0]!, { mode: 'fixture' })
    const source = JSON.stringify({ format: 'visual-language-lessons-evaluation', version: 2, status: 'finished', requestedProvider: 'fixture', requestedModel: 'fixture',
      corpusHash: 'raw-fixture', codeHashes: { production: 'fixed' }, selectedCaseIds: [result.caseId], repetitions: 1, results: [{ ...result, repetition: 1 }] })
    const audit = await auditPacket(source)
    expect(audit.units.find(u => u.stage === 'saved_scope')!.output.points).toHaveLength(4)
    expect(audit.units.find(u => u.stage === 'review_lesson_scope')!.contract.status).toBe('pass')
    expect(audit.units.filter(u => u.scope === 'segment' && u.contract.status !== 'pass').map(u => ({ stage: u.stage, contract: u.contract }))).toEqual([])
    const score = await scoreLessons(source)
    expect(score.prepared).toBe(1)
    expect(score.humanReview).toBe('pending')
  }, 15_000)
  it('reports a capacity-blocked workflow as a harness error without grading the absent submission', async () => {
    const saved = JSON.parse(await report()), result = saved.results[0]
    const call = result.calls.at(-1)
    call.parsedResponseReceived = false
    call.submissionAccepted = false
    call.httpStatus = 429
    call.failure = { category: 'rate_limited', layer: 'request', retryable: true,
      httpStatus: 429, message: 'Busy', provider: { code: 'concurrency_limit_exceeded' } }
    delete call.response
    result.prepared = false
    result.scriptedPlaybackCompleted = false
    result.failure = { stage: call.stage, message: 'Busy', detail: call.failure }
    const score = await scoreLessons(JSON.stringify(saved))
    expect(score.cases[0]!.operationalOutcome).toBe('harness_capacity_error')
    expect(score.reliability).toMatchObject({ plannedTrials: 1, lessonsReady: 0, harnessCapacityErrors: 1, capacityLimitedRequests: 1 })
    const stage = score.stages.find(s => s.stage === call.mode && s.phase === 'check')!
    expect(stage.capacityEvents).toHaveLength(1)
    expect(stage.responseFailures).toHaveLength(0)
    expect(stage.submissionFailures).toHaveLength(0)
    expect(scoreMarkdown(score)).toContain('harness_capacity_error')
  })
  it('requires declared function-opening adaptation and matching normalization provenance', async () => {
    const saved = JSON.parse(await report())
    const call = saved.results[0].calls.find((c: any) => c.mode === 'verify_lesson_waypoint')
    const args = JSON.parse(call.response.toolCalls[0].function.arguments)
    const raw = `<tool_call>\nfunction=${call.mode}>${Object.entries(args).map(([key, value]) => `<parameter=${key}>${value}</parameter>`).join('')}</function></tool_call>`
    call.request.toolResponseDialect = 'qwen_xml'
    call.request.normalizeFunctionOpening = true
    call.requestHash = await digest(JSON.stringify(call.request))
    call.response.content = ''
    call.response.finishReason = 'stop'
    call.response.toolCalls[0].id = 'qwen_template_call_0'
    call.response.toolProtocol = { representation: 'qwen_xml', rawContent: raw,
      normalizations: [`function_opening_angle:${call.mode}`] }
    const compatible = await scoreLessons(JSON.stringify(saved))
    expect(compatible.stages.find(s => s.stage === call.mode && s.phase === 'lesson')).toMatchObject({ adaptedContractPasses: 1, contractFailures: 0 })
    delete call.request.normalizeFunctionOpening
    const undeclared = await scoreLessons(JSON.stringify(saved))
    expect(undeclared.stages.find(s => s.stage === call.mode && s.phase === 'lesson')!.contractFailures).toBe(1)
    call.request.normalizeFunctionOpening = true
    call.response.toolProtocol.normalizations = []
    const missingEvidence = await scoreLessons(JSON.stringify(saved))
    expect(missingEvidence.stages.find(s => s.stage === call.mode && s.phase === 'lesson')!.contractFailures).toBe(1)
  })

  it('rejects retired report formats instead of maintaining a second workflow implementation', async () => {
    const retired = JSON.parse(await report())
    retired.version = 1
    await expect(scoreLessons(JSON.stringify(retired))).rejects.toThrow('version 2')
    const oldContract = JSON.parse(await report())
    oldContract.results[0].calls[0].mode = 'build_lesson_graph'
    await expect(scoreLessons(JSON.stringify(oldContract))).rejects.toThrow('retired or unknown workflow contract')
  })
  it('does not guess missing v2 outcomes from response bodies or older field names', async () => {
    const saved = JSON.parse(await report())
    saved.results[0].calls[0].completed = true
    delete saved.results[0].calls[0].parsedResponseReceived
    await expect(scoreLessons(JSON.stringify(saved))).rejects.toThrow('Explicit playback and parsed-response outcomes')
  })
})

describe('lesson quality scoring methodology', () => {
  it('rejects duplicate and out-of-matrix trials rather than inflating readiness', async () => {
    const saved = JSON.parse(await report())
    const duplicate = structuredClone(saved); duplicate.results.push(duplicate.results[0])
    await expect(scoreLessons(JSON.stringify(duplicate))).rejects.toThrow('distinct trials')
    const unselected = structuredClone(saved); unselected.results[0].caseId = 'unselected-case'
    await expect(scoreLessons(JSON.stringify(unselected))).rejects.toThrow('declared case matrix')
    const outOfRange = structuredClone(saved); outOfRange.results[0].repetition = 2
    await expect(scoreLessons(JSON.stringify(outOfRange))).rejects.toThrow('declared case matrix')
    const zero = structuredClone(saved); zero.repetitions = 0
    await expect(scoreLessons(JSON.stringify(zero))).rejects.toThrow('positive repetitions')
  })
  it('refuses matched-context claims when reference IDs or initial context evidence differ', async () => {
    const source = await report(), a = await scoreLessons(source), b = structuredClone(a)
    b.provenance.model = 'candidate'
    expect(compareQualityScores([a, b]).matchedExperiment).toBe(true)
    const changed = JSON.parse(source), messages = changed.results[0].calls[0].request.messages
    const user = messages.find((m: { role: string }) => m.role === 'user')
    const context = parseToolContext(user.content)
    user.content = user.content.replace(context.targets[0].cardId, 'different-reference-id')
    const packet = await auditPacket(JSON.stringify(changed))
    b.provenance.initialContextHashes = packet.provenance.initialContextHashes
    expect(compareQualityScores([a, b]).mismatches).toContainEqual({ reportIndex: 1, field: 'initialProjectedContexts' })
    b.provenance.initialContextHashes = []
    expect(compareQualityScores([a, b]).mismatches).toContainEqual({ reportIndex: 1, field: 'initialContextEvidence' })
  })
  it('matches projected context from separately seeded workspaces without relaxing comparison checks', async () => {
    const first = await scoreLessons(await report()), second = await scoreLessons(await report())
    expect(second.sourceSha256).not.toBe(first.sourceSha256)
    expect(second.provenance.initialContextHashes).toEqual(first.provenance.initialContextHashes)
    expect(compareQualityScores([first, second]).matchedExperiment).toBe(true)
  })
  it('retains mixed operational failures and counts recovered readiness against every planned trial', async () => {
    const saved = JSON.parse(await report())
    const original = saved.results[0], call = original.calls[0]
    const categories = [
      { category: 'http_rejected', layer: 'request', httpStatus: 422 },
      { category: 'timeout', layer: 'transport' },
      { category: 'stream_incomplete', layer: 'protocol' },
    ] satisfies Array<Pick<InferenceFailureRecord, 'category' | 'layer' | 'httpStatus'>>
    // A later successful correction does not erase the rejected transaction.
    call.request.generationTrace.attempt = { submission: 2, request: 1 }
    for (const [index, failure] of categories.entries()) {
      saved.results.push({ ...structuredClone(original), repetition: index + 2, prepared: false, scriptedPlaybackCompleted: false,
        calls: [{ ...structuredClone(call), parsedResponseReceived: false, response: undefined, submissionAccepted: false,
          httpStatus: failure.httpStatus, error: `Synthetic ${failure.category}`,
          failure: { ...failure, retryable: false, message: `Synthetic ${failure.category}` } }] })
    }
    saved.repetitions = 5 // The fifth planned trial has not been attempted.
    const score = await scoreLessons(JSON.stringify(saved))
    expect(score.reliability).toMatchObject({ plannedTrials: 5, trialsFinished: 4, lessonsReady: 1,
      lessonsReadyWithoutRecovery: 0, lessonsReadyAfterRecovery: 1, lessonReadinessPercentOfPlanned: 20,
      requestsWithoutUsableResponse: 3, submissionsRejectedByExecutor: 3 })
    const stage = score.stages.find(s => s.stage === call.mode && s.phase === 'lesson')!
    expect(stage.responseFailures.map(f => f.category)).toEqual(categories.map(f => f.category))
    expect(stage.operationalContractValidityPercent).toBeLessThan(stage.responseValidityPercent!)
    expect(scoreMarkdown(score)).toContain('| Lessons ready after recovery | 1 |')
    expect(scoreMarkdown(score)).toContain('| Planned trials | 5 |')
  })
  it('keeps rejected requests in the all-attempt denominator and preserves their structured category', async () => {
    const saved = JSON.parse(await report())
    const call = saved.results[0].calls[0]
    saved.results[0].calls.push({ ...call, parsedResponseReceived: false, response: undefined, httpStatus: 422, error: 'Rejected request',
      failure: { category: 'http_rejected', layer: 'request', retryable: false, message: 'Rejected request', httpStatus: 422 } })
    const score = await scoreLessons(JSON.stringify(saved))
    const stage = score.stages.find(s => s.stage === call.mode && s.phase === 'lesson')!
    expect(stage.operationalContractValidityPercent).toBeLessThan(stage.responseValidityPercent!)
    expect(stage.responseFailures).toContainEqual(expect.objectContaining({ category: 'http_rejected', httpStatus: 422 }))
    expect(stage.nativeContractPasses + stage.adaptedContractPasses).toBe(stage.contractPasses)
  })
  it('keeps contract completion, semantic quality and scripted playback separate', async () => {
    const source = await report(), score = await scoreLessons(source)
    expect(score).toMatchObject({ prepared: 1, completed: 1, instructionalQuality: { observedScore: null, auditCoverage: 0, status: 'unrated_or_partial' }, humanReview: 'pending', releaseReady: false })
    expect(score.stages).toHaveLength(18)
    expect(score.stages.every(s => s.contractFailures === 0)).toBe(true)
    expect(score.stages.find(s => s.stage === 'build_question_answers' && s.phase === 'check')).toMatchObject({ attempts: 2, contractPasses: 2 })
    expect(score.stages.every(s => s.tokenUsage.totalTokens === null)).toBe(true)
  })
  it('replays content against the runtime-selected gap rather than author-supplied claims', async () => {
    let previous: unknown, injected = false
    const source = await report(async request => {
      const result = await lessonFixture(request), context = parseToolContext(currentToolMessage(request.messages).content!)
      if (context.generationMode === 'build_question_answers' && context.phase === 'practice') {
        if (!previous) previous = JSON.parse(result.toolCalls[0]!.function.arguments)
        else if (!injected && context.currentQuestions.length) {
          injected = true
          result.toolCalls[0]!.function.arguments = JSON.stringify({ ...(previous as object), stem: 'Which intention does this expression convey?' })
        }
      }
      return result
    })
    const saved = JSON.parse(source), calls = saved.results[0].calls
    const index = calls.findIndex((call: any) => call.submissionAccepted === false && call.failure?.category === 'constraints_invalid')
    expect(injected).toBe(true)
    expect(index).toBeGreaterThan(-1)
    const packet = await auditPacket(source), score = await scoreLessons(source)
    expect(packet.contractValidationScope).toBe('schema_and_content_replay')
    expect(packet.units.find(unit => unit.callIndex === index)?.contract).toMatchObject({ status: 'fail' })
    const stage = score.stages.find(stage => stage.stage === 'build_question_answers' && stage.phase === 'practice')!
    expect(stage.contractFailures).toBeGreaterThan(0)
    expect(scoreMarkdown(score)).toContain('they do not replay every stateful workflow constraint')
    expect(scoreMarkdown(score)).toContain('Executor accepted')
  })
  it('does not allow a high average to hide a critical defect; unknown lowers coverage', async () => {
    const source = await report(), annotation = await labels(source)
    const saved = annotation.units.find(u => u.id.includes('saved-practice-q1'))!
    saved.ratings.find(r => r.criterion === 'answer_validity')!.score = 0
    saved.ratings.find(r => r.criterion === 'accuracy')!.score = null
    const score = await scoreLessons(source, annotation)
    expect(score.instructionalQuality.observedScore).toBeGreaterThan(80)
    expect(score.instructionalQuality).toMatchObject({ status: 'critical_defects', fullyAudited: false })
    expect(score.instructionalQuality.auditCoverage).toBeLessThan(100)
    expect(score.instructionalQuality.criticalDefects).toContainEqual(expect.objectContaining({ unitId: saved.id, criterion: 'answer_validity' }))
  })
  it('rejects stale, fabricated, duplicate and incomplete annotations', async () => {
    const source = await report(), annotation = await labels(source)
    await expect(scoreLessons(source + ' ', annotation)).rejects.toThrow('hash mismatch')
    const fabricated = structuredClone(annotation); fabricated.units[0]!.ratings[0]!.evidence[0]!.quote = 'Words not present'
    await expect(scoreLessons(source, fabricated)).rejects.toThrow('Evidence does not match')
    const duplicate = structuredClone(annotation); duplicate.units.push(duplicate.units[0]!)
    await expect(scoreLessons(source, duplicate)).rejects.toThrow('duplicate annotation')
    const missing = structuredClone(annotation); missing.units[0]!.ratings.pop()
    await expect(scoreLessons(source, missing)).rejects.toThrow('all and only')
  })
  it('scores production validation failures even if HTTP and tool emission completed', async () => {
    const source = await report(async options => {
      const response = await lessonFixture(options), input = parseToolContext(currentToolMessage(options.messages).content!)
      if (input.generationMode === 'verify_lesson_waypoint') {
        response.toolCalls[0]!.function.arguments = JSON.stringify({ decision: 'accept', reason: 'Synthetic invalid accept.' })
        // The author supplied a structurally valid point with an overlong teaching example.
      }
      if (input.generationMode === 'add_lesson_waypoint') {
        const call = response.toolCalls[0]!, args = JSON.parse(call.function.arguments)
        args.exampleHanzi = '谢谢！对不起。'; call.function.arguments = JSON.stringify(args)
      }
      return response
    })
    const score = await scoreLessons(source)
    expect(score.stages.find(s => s.stage === 'add_lesson_waypoint')).toMatchObject({ attempts: 2, completedResponses: 2, contractPasses: 0, contractFailures: 2 })
    expect(score.prepared).toBe(0)
    expect(score.stages.find(s => s.stage === 'build_question_answers')).toMatchObject({ reachedCases: 0, responseValidityPercent: null })
  })
  it('exposes false accepts separately from a valid review envelope', async () => {
    const source = await report(), annotation = await labels(source)
    const packet = await auditPacket(source)
    const id = packet.units.find(u => u.stage === 'verify_correct_question' && u.phase === 'practice')!.id
    const review = annotation.units.find(u => u.id === id)!
    review.expectedDecision = 'correct'
    const rating = review.ratings.find(r => r.criterion === 'decision_accuracy')!
    await expect(scoreLessons(source, annotation)).rejects.toThrow('contradicts')
    rating.score = 0
    const score = await scoreLessons(source, annotation)
    expect(score.stages.find(s => s.stage === 'verify_correct_question' && s.phase === 'practice')!.reviewDecisions.falseAccepts).toHaveLength(1)
    review.expectedDecision = null
    await expect(scoreLessons(source, annotation)).rejects.toThrow('requires independent expected')
    rating.score = null
    await expect(scoreLessons(source, annotation)).resolves.toBeDefined()
    review.expectedDecision = 'accept'; rating.score = 1
    await expect(scoreLessons(source, annotation)).rejects.toThrow('contradicts')
    rating.score = 2
    await expect(scoreLessons(source, annotation)).resolves.toBeDefined()
  })
  it('reports a misleading review rationale even when its verdict agrees with the independent decision', async () => {
    const misleading = 'Authored defect: 给我 requires the speaker to drink the tea personally.'
    const source = await report(async options => {
      const response = await lessonFixture(options)
      if (options.tools?.[0]?.function.name === 'verify_correct_question') {
        const args = JSON.parse(response.toolCalls[0]!.function.arguments)
        args.reason = misleading
        response.toolCalls[0]!.function.arguments = JSON.stringify(args)
      }
      return response
    })
    const packet = await auditPacket(source), annotation = await labels(source)
    const unit = packet.units.find(u => u.stage === 'verify_correct_question' && u.phase === 'practice')!
    expect(unit.criteria).toEqual(['decision_accuracy', 'accuracy'])
    const label = annotation.units.find(u => u.id === unit.id)!
    label.ratings.find(r => r.criterion === 'accuracy')!.score = 0
    label.ratings.find(r => r.criterion === 'accuracy')!.evidence = [{ path: 'output.reason', quote: misleading }]
    const score = await scoreLessons(source, annotation)
    const stage = score.stages.find(s => s.stage === unit.stage && s.phase === unit.phase)!
    expect(stage.reviewDecisions.agreement).toBe(stage.reviewDecisions.rated)
    expect(stage.semantic.criticalDefects).toContainEqual(expect.objectContaining({ unitId: unit.id, criterion: 'accuracy' }))
    expect(stage.semantic.status).toBe('critical_defects')
  })
  it('audits the prepared learner view with shuffled choices and app-owned pronunciation', async () => {
    const saved = JSON.parse(await report())
    const result = saved.results[0], prepared = result.artifacts.check.quiz.questions[0]
    prepared.options.reverse()
    const packet = await auditPacket(JSON.stringify(saved))
    const unit = packet.units.find(u => u.id.endsWith('/saved-check-q1'))!
    expect(unit.context.learnerView).toEqual({
      prompt: prepared.passage ? `${prepared.passage}\n\n${prepared.stem}` : prepared.stem,
      options: prepared.options, quizLevel: prepared.quizLevel, passagePinyin: prepared.passagePinyin,
    })
    expect(unit.context.learnerView.options.map((o: { id: string }) => o.id))
      .not.toEqual(unit.output.options.map((o: { id: string }) => o.id))
    expect(unit.context.learnerView).not.toHaveProperty('correctOptionId')
    expect(unit.context.learnerView).not.toHaveProperty('explanation')
    const masked = JSON.stringify(englishOnlyUnit(unit))
    expect(masked).not.toContain('learnerView')
    expect(masked).not.toMatch(/\p{Script=Han}/u)
    for (const [origin, label] of [['source', 'From your reading'], ['new_example', 'New example']] as const) {
      prepared.passageOrigin = origin
      const labeledPacket = await auditPacket(JSON.stringify(saved))
      const labeled = labeledPacket.units.find(u => u.id === unit.id)!
      expect(labeled.context.learnerView).toMatchObject({ passageOrigin: origin, passageLabel: label })
      expect(lessonCriterionRequest(labeled, 'answer_validity').messages[1]!.content).toContain(label)
      expect(englishOnlyUnit(labeled)).toEqual(englishOnlyUnit(unit))
      expect(labeled.context.learnerView).not.toHaveProperty('correctOptionId')
    }
  })
  it('retains accepted questions from failed flows as partial artifact quality, not completion', async () => {
    const source = await report(async options => {
      const response = await lessonFixture(options), input = parseToolContext(currentToolMessage(options.messages).content!)
      if (input.generationMode === 'verify_correct_question' && input.currentQuestions.length) response.toolCalls[0]!.function.arguments = JSON.stringify({ decision: 'reject', reason: 'Synthetic rejection.' })
      return response
    })
    const packet = await auditPacket(source)
    expect(packet.units.filter(u => u.scope === 'artifact').map(u => u.id)).toEqual([expect.stringContaining('saved-lesson'), expect.stringContaining('saved-practice-q1')])
    expect(packet.units.find(u => u.stage === 'saved_question')!.context.learnerView).toBeNull()
    expect((await scoreLessons(source)).prepared).toBe(0)
  })
  it('retains reviewed draft waypoints as partial content without crediting lesson completion', async () => {
    const source = await report(async options => {
      const input = parseToolContext(currentToolMessage(options.messages).content!)
      if (input.generationMode === 'add_lesson_waypoint' && input.graph.waypoints.length) throw new Error('Interrupted graph build')
      return lessonFixture(options)
    })
    const packet = await auditPacket(source)
    expect(packet.units.find(u => u.stage === 'saved_lesson_draft')).toMatchObject({ context: { draft: true, readinessApproved: false }, output: { waypoints: [{ id: 'w1' }] } })
    expect((await scoreLessons(source)).prepared).toBe(0)
  })
  it('refuses running reports and active-case evidence', async () => {
    const source = JSON.parse(await report()); source.status = 'running'
    await expect(auditPacket(JSON.stringify(source))).rejects.toThrow('terminal finished')
  })
  it('preserves declared policies and compares nested values independently of key order', async () => {
    const saved = JSON.parse(await report())
    saved.runtime = { generationPolicy: { execution: { requestAttempts: 2, submissionAttempts: 2 }, workflow: { timeoutMs: 900_000 } } }
    const a = await scoreLessons(JSON.stringify(saved)), b = structuredClone(a)
    expect(a.provenance.generationPolicy).toEqual(saved.runtime.generationPolicy)
    b.provenance.generationPolicy = { workflow: { timeoutMs: 900_000 }, execution: { submissionAttempts: 2, requestAttempts: 2 } }
    expect(compareQualityScores([a, b]).matchedExperiment).toBe(true)
    b.provenance.generationPolicy = { workflow: { timeoutMs: 900_000 }, execution: { submissionAttempts: 2, requestAttempts: 3 } }
    expect(compareQualityScores([a, b]).mismatches).toEqual([{ reportIndex: 1, field: 'lessonExecutionPolicy' }])
  })
  it('refuses self-review labels and flags incompatible model comparisons', async () => {
    const source = await report(), annotation = await labels(source)
    annotation.reviewer.independent = false
    await expect(scoreLessons(source, annotation)).rejects.toThrow('self-review')
    const a = await scoreLessons(source), b = structuredClone(a)
    b.provenance.model = 'candidate'
    expect(compareQualityScores([a, b]).matchedExperiment).toBe(true)
    b.provenance.codeHashes.production = 'changed'
    expect(compareQualityScores([a, b])).toMatchObject({ matchedExperiment: false, mismatches: [{ reportIndex: 1, field: 'generationCodeHashes' }] })
    b.provenance.codeHashes.production = 'fixed'; b.provenance.thinking = 'on'
    expect(compareQualityScores([a, b]).mismatches[0]!.field).toBe('thinkingPolicy')
    b.provenance.thinking = a.provenance.thinking
    b.provenance.generationConfigurations[0]!.modelProfile.hash = 'changed-profile'
    expect(compareQualityScores([a, b]).mismatches).toEqual([{ reportIndex: 1, field: 'lessonGenerationConfiguration' }])
    b.provenance.generationConfigurations = structuredClone(a.provenance.generationConfigurations)
    b.provenance.generationPolicy = { requestAttempts: 3 }
    expect(compareQualityScores([a, b]).mismatches).toEqual([{ reportIndex: 1, field: 'lessonExecutionPolicy' }])
  })
  it('blinds reviewer verdicts and answer keys, and checks solved keys after grading', async () => {
    const source = await report(), packet = await auditPacket(source)
    const question = packet.units.find(u => u.stage === 'build_question_answers')!
    const masked = englishOnlyUnit(question)
    expect(Object.keys(masked)).toEqual(['stem', 'options'])
    expect(JSON.stringify(masked)).not.toContain('correct')
    const solve = JSON.parse(lessonCriterionRequest(question, 'answer_validity').messages[1]!.content!.split('\n\nTool call:')[0]!)
    expect(solve).not.toHaveProperty('context'); expect(solve.output).not.toHaveProperty('correct'); expect(solve.output).not.toHaveProperty('feedback')
    const review = packet.units.find(u => u.stage === 'verify_correct_question')!
    const reviewInput = JSON.parse(lessonCriterionRequest(review, 'decision_accuracy').messages[1]!.content!.split('\n\nTool call:')[0]!)
    expect(reviewInput).not.toHaveProperty('output'); expect(reviewInput).not.toHaveProperty('contract')
    const grade = (expectedOptionId: string, evidencePath = 'output.answerA', evidenceQuote = question.output.answerA): ChatResult => ({ content: '', reasoning: '', model: 'authored-grader-control', finishReason: 'tool_calls', toolCalls: [{ id: 'grade', type: 'function', function: { name: 'rate_lesson_criterion', arguments: JSON.stringify({ score: 2, expectedOptionId, rationale: 'Synthetic solver control.', evidencePath, evidenceQuote }) } }] })
    expect(parseCriterionGrade(grade(question.output.correct), question, 'answer_validity').rating.score).toBe(2)
    expect(parseCriterionGrade(grade(question.output.correct), question, 'answer_validity').rating.rationale)
      .toContain(`Independent choice: ${question.output.correct}; declared key: ${question.output.correct}.`)
    expect(parseCriterionGrade(grade(question.output.correct === 'A' ? 'B' : 'A'), question, 'answer_validity').rating.score).toBe(0)
    expect(() => parseCriterionGrade(grade('A', 'output.feedback', question.output.feedback), question, 'answer_validity')).toThrow('visible question fields')
  })
  it('solves the prepared display blindly and binds citations to its shuffled order', async () => {
    const source = JSON.parse(await report()), result = source.results[0]
    const original = result.artifacts.plan.preparation.check.questions[0].question
    result.artifacts.check.quiz.questions[0].options = [...original.options].reverse()
    const packet = await auditPacket(JSON.stringify(source))
    const unit = packet.units.find(u => u.id.endsWith('/saved-check-q1'))!
    const input = parseToolContext(lessonCriterionRequest(unit, 'answer_validity').messages[1]!.content!)
    expect(input).toEqual({ criterion: 'answer_validity', context: { learnerView: unit.context.learnerView } })
    expect(JSON.stringify(input)).not.toContain('correctOptionId')
    expect(JSON.stringify(input)).not.toContain('explanation')
    expect(input.context.learnerView.options[0]).toEqual(original.options.at(-1))
    unit.context.learnerView.options[0].pinyin = 'hidden pronunciation control'
    const englishOnly = englishOnlyUnit(unit)
    expect(englishOnly.options).toEqual(unit.context.learnerView.options.map(({ id, text }: { id: string; text: string }) => ({ id, text })))
    expect(JSON.stringify(englishOnly)).not.toContain('hidden pronunciation control')
    const grade = (evidencePath: string, evidenceQuote: string): ChatResult => ({
      content: '', reasoning: '', model: 'authored-grader-control', finishReason: 'tool_calls',
      toolCalls: [{ id: 'grade', type: 'function', function: { name: 'rate_lesson_criterion', arguments: JSON.stringify({
        score: 2, expectedOptionId: original.correctOptionId, rationale: 'Synthetic solver control.', evidencePath, evidenceQuote,
      }) } }],
    })
    const visible = input.context.learnerView.options[0].text
    expect(parseCriterionGrade(grade('context.learnerView.options.0.text', visible), unit, 'answer_validity').rating.score).toBe(2)
    expect(() => parseCriterionGrade(grade('context.learnerView.options.0.text', original.options[0].text), unit, 'answer_validity'))
      .toThrow('does not match')
    expect(() => parseCriterionGrade(grade('output.options.0.text', original.options[0].text), unit, 'answer_validity'))
      .toThrow('visible question fields')
    expect(() => parseCriterionGrade(grade('output.correctOptionId', original.correctOptionId), unit, 'answer_validity'))
      .toThrow('visible question fields')
  })
  it('withholds repair verdicts and prior review hints from independent decision grading', async () => {
    const packet = await auditPacket(await report())
    const unit = packet.units.find(u => u.stage === 'verify_correct_question')!
    unit.context.candidateSubmission = { decision: 'reject', reason: 'LEAKED_PRODUCTION_REASON' }
    unit.context.nativeSubmissionIssue = 'LEAKED_PRODUCTION_DIAGNOSTIC'
    unit.context.previousReview = { decision: 'reject', reason: 'LEAKED_PREVIOUS_REVIEW' }
    const input = parseToolContext(lessonCriterionRequest(unit, 'decision_accuracy').messages[1]!.content!)
    expect(input.context.visibleQuestion).toEqual(unit.context.visibleQuestion)
    expect(input.context.visibleQuestion.choices).toHaveLength(4)
    expect(JSON.stringify(input)).not.toContain('LEAKED_')
    expect(input.context.candidate).toEqual(unit.context.candidate)
    expect(input.context.graph).toEqual(unit.context.graph)
    expect(input.context.sources).toEqual(unit.context.sources)
    expect(input).not.toHaveProperty('output')
    const grade = (evidencePath: string, evidenceQuote: string): ChatResult => ({ content: '', reasoning: '', model: 'authored-grader-control', finishReason: 'tool_calls', toolCalls: [
      { id: 'grade', type: 'function', function: { name: 'rate_lesson_criterion', arguments: JSON.stringify({ score: 2, expectedDecision: 'accept', rationale: 'Synthetic decision control.', evidencePath, evidenceQuote }) } },
    ] })
    expect(() => parseCriterionGrade(grade('context.candidateSubmission.reason', 'LEAKED_PRODUCTION_REASON'), unit, 'decision_accuracy')).toThrow('permitted input')
    expect(parseCriterionGrade(grade('context.candidate.stem', unit.context.candidate.stem), unit, 'decision_accuracy').rating.score).toBe(2)
  })
  it('uses only the prepared option order for feedback evidence', async () => {
    const packet = await auditPacket(await report())
    const unit = packet.units.find(u => u.id.endsWith('/saved-check-q1'))!
    const input = parseToolContext(lessonCriterionRequest(unit, 'feedback').messages[1]!.content!)
    expect(input.context.learnerView).toEqual(unit.context.learnerView)
    expect(input.output).not.toHaveProperty('options')
    expect(input.output.explanation).toBe(unit.output.explanation)
    const response = (evidencePath: string, evidenceQuote: string): ChatResult => ({ content: '', reasoning: '', model: 'authored-grader-control', finishReason: 'tool_calls', toolCalls: [
      { id: 'grade', type: 'function', function: { name: 'rate_lesson_criterion', arguments: JSON.stringify({ score: 0, rationale: 'Synthetic feedback control.', evidencePath, evidenceQuote }) } },
    ] })
    expect(() => parseCriterionGrade(response('output.options.0.text', unit.output.options[0].text), unit, 'feedback')).toThrow('permitted input')
    expect(parseCriterionGrade(response('context.learnerView.options.0.text', unit.context.learnerView.options[0].text), unit, 'feedback').rating.score).toBe(0)
  })
  it('grades solver answer sets with a fresh visible-only solve instead of exposing the observed answer', async () => {
    const packet = await auditPacket(await report())
    const unit = packet.units.find(u => u.stage === 'solve_visible_question')!
    unit.context.target = 'SECRET_TARGET'; unit.context.correct = 'D'; unit.output.reason = 'SECRET_OBSERVED_REASON'
    const request = lessonCriterionRequest(unit, 'answer_set_accuracy')
    expect(JSON.stringify(request.messages)).not.toMatch(/SECRET_TARGET|SECRET_OBSERVED_REASON/)
    expect(Object.keys(request.tools![0]!.function.parameters.properties!)).toEqual(['answerIds', 'reason'])
    const solve = (answerIds: string[] | null): ChatResult => ({ content: '', reasoning: '', model: 'independent-fixture', finishReason: 'tool_calls', toolCalls: [
      { id: 'solve', type: 'function', function: { name: 'solve_visible_question', arguments: JSON.stringify({ answerIds, reason: 'Authored independent solve.' }) } },
    ] })
    expect(parseCriterionGrade(solve(['A']), unit, 'answer_set_accuracy').rating.score).toBe(2)
    expect(parseCriterionGrade(solve(['B']), unit, 'answer_set_accuracy').rating.score).toBe(0)
    expect(() => parseCriterionGrade(solve(['A', 'A']), unit, 'answer_set_accuracy')).toThrow()
    unit.output.answerIds = ['A', 'D']
    const matched = parseCriterionGrade(solve(['D', 'A']), unit, 'answer_set_accuracy').rating
    expect(matched.score).toBe(2)
    expect(matched.rationale).toContain('Independent answer IDs: ["D","A"]; observed answer IDs: ["A","D"].')
    expect(parseCriterionGrade(solve(['B']), unit, 'answer_set_accuracy').rating.rationale)
      .toContain('Independent answer IDs: ["B"]; observed answer IDs: ["A","D"].')
    unit.output.answerIds = []
    expect(parseCriterionGrade(solve([]), unit, 'answer_set_accuracy').rating.score).toBe(2)
    const unresolved = parseCriterionGrade(solve(null), unit, 'answer_set_accuracy').rating
    expect(unresolved.score).toBeNull()
    expect(unresolved.rationale).toContain('Independent answer IDs: null; observed answer IDs: [].')
  })
  it('reports criterion-score disagreements without inventing review decisions', () => {
    const partial = summarizeGraderCalibration([{ id: 'wrong-key', score: 1 }, { id: 'neutral-meaning-valid', score: 1 }, { id: 'mere-rephrasing', score: null }])
    expect(partial).toMatchObject({ exactScoreMatches: 0, overratedControls: ['wrong-key'], underratedControls: ['neutral-meaning-valid'], certified: false, rated: 2 })
    expect(partial).toMatchObject({ controlsVersion: 'lesson-quality-controls-v2', planned: 10, labelsAvailable: 8 })
    expect(partial.unresolvedLabels).toContainEqual({ id: 'mere-rephrasing', observedScore: null })
    expect(partial).not.toHaveProperty('invalidAccepted')
    expect(partial.exactScoreMatches + partial.overratedControls.length + partial.underratedControls.length).toBe(partial.rated)
    expect(partial.rated + partial.unknown.length).toBe(partial.labelsAvailable)
    expect(partial.labelsAvailable + partial.unresolvedLabels.length).toBe(partial.planned)
    const full = summarizeGraderCalibration(lessonQualityControls.map(c => ({ id: c.id, score: c.expectedScore })))
    expect(full).toMatchObject({ exactScoreMatches: full.labelsAvailable, overratedControls: [], underratedControls: [], unknown: [], certified: false })
    const disputed = summarizeGraderCalibration([{ id: 'fresh-sugar-confirmation', score: 2 }, { id: 'mere-rephrasing', score: 0 }])
    expect(disputed).toMatchObject({ rated: 0, exactScoreMatches: 0, overratedControls: [], underratedControls: [],
      unresolvedLabels: [{ id: 'fresh-sugar-confirmation', observedScore: 2 }, { id: 'mere-rephrasing', observedScore: 0 }] })
    expect(disputed.unknown).toHaveLength(8)
  })
})
