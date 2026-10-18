import { describe, expect, it } from 'vitest'
import type { ChatOptions } from '../../src/lib/ai/types'
import { correctionContext, correctionCue, correctionCandidate } from '../evaluation/correction-context'
import { REPAIR_EXPLANATION } from '../../src/lib/teacher/lessonGeneration/prompts'
import echo from '../evaluation/focused-cases/coverage-repair-echo-p12.json'
import reviewRepair from '../evaluation/focused-cases/question-review-repair-p12.json'

const request: ChatOptions = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture', maxTokens: 4096,
  messages: [{ role: 'system', content: 'Same instructions.' }, { role: 'user', content: 'Current state and precise correction feedback.' }] }
const initial = [request.messages[0]!, { role: 'user' as const, content: 'Current state.' }]

describe('correction history experiment boundary', () => {
  it('removes the recorded overlong review reason while preserving its decision and every other field', async () => {
    const original = { ...request, ...reviewRepair.failedReviews[1]!.call.request } as ChatOptions
    const pruned = await correctionCandidate(original, 'omit-overlong')
    const split = (value: ChatOptions) => value.messages.at(-1)!.content!.split('\n\nTool call:\n')
    const expected = JSON.parse(split(original)[0]!), actual = JSON.parse(split(pruned)[0]!)
    expect(actual.candidateSubmission).toEqual({ decision: expected.candidateSubmission.decision })
    delete expected.candidateSubmission.reason
    expect(actual).toEqual(expected)
    expect(split(pruned)[1]).toBe(split(original)[1])
    expect(pruned.messages[0]).toEqual(original.messages[0])
    expect(JSON.parse(split(original)[0]!).candidateSubmission.reason).toHaveLength(1024)
    const rejected = JSON.parse(split(original)[0]!).candidateSubmission
    const retained = await correctionCandidate(pruned, 'retain', rejected)
    expect(retained.messages).toEqual(original.messages)
    expect(await correctionCandidate(pruned, 'production', rejected)).toBe(pruned)
    expect(await correctionCandidate(pruned, 'omit-overlong', rejected)).toBe(pruned)
  })
  it('omits only the actual rejected overlong assessment, preserving valid candidate fields and the rest of the request', async () => {
    const original = { ...request, ...echo.failedAssessments[1]!.call.request } as ChatOptions
    const before = structuredClone(original)
    const pruned = await correctionCandidate(original, 'omit-overlong')
    const split = (value: ChatOptions) => value.messages.at(-1)!.content!.split('\n\nTool call:\n')
    const first = JSON.parse(split(original)[0]!), second = JSON.parse(split(pruned)[0]!)
    expect(second.candidateSubmission).toEqual({ waypointIds: first.candidateSubmission.waypointIds })
    delete first.candidateSubmission.assessment
    expect(second).toEqual(first)
    expect(split(pruned)[1]).toBe(split(original)[1])
    expect(pruned.messages[0]).toEqual(original.messages[0])
    expect(pruned.tools).toBe(original.tools)
    expect(pruned.maxTokens).toBe(original.maxTokens)
    expect(pruned.contextBudget!.inputTokens).toBeLessThan(original.contextBudget!.inputTokens)
    expect(original).toEqual(before)
    expect(await correctionCandidate(original, 'retain')).toBe(original)
  })
  it('refuses candidate pruning without rejected overlong fields or an owned projection', async () => {
    await expect(correctionCandidate(request, 'omit-overlong')).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
    const original = { ...request, ...echo.failedAssessments[1]!.call.request } as ChatOptions
    const parts = original.messages.at(-1)!.content!.split('\n\nTool call:\n'), data = JSON.parse(parts[0]!)
    data.candidateSubmission.assessment = 'Valid short explanation.'
    const short = { ...original, messages: [...original.messages.slice(0, -1), { role: 'user' as const,
      content: JSON.stringify(data) + '\n\nTool call:\n' + parts[1] }] }
    await expect(correctionCandidate(short, 'omit-overlong')).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
    const invalid = { ...original, messages: [original.messages[0]!, { role: 'user' as const, content: 'null\n\nTool call:\nprobe()' }] }
    await expect(correctionCandidate(invalid, 'omit-overlong')).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
  })
  it('replaces the owned production repair cue while preserving rejected data and the final tool hint', async () => {
    const projection = JSON.stringify({ candidateSubmission: { reason: REPAIR_EXPLANATION } })
    const original = { ...request, messages: [request.messages[0]!, { role: 'user' as const,
      content: `${projection}\n\nTool call:\n${REPAIR_EXPLANATION}\nprobe(reason: string)\nLimits: reason: at most 1000 characters.` }] }
    const guided = await correctionCue(original, 'Experimental replacement cue.')
    expect(guided.messages[1]!.content).toBe(`${projection}\n\nTool call:\nExperimental replacement cue.\nprobe(reason: string)\nLimits: reason: at most 1000 characters.`)
    expect(original.messages[1]!.content).toContain(`Tool call:\n${REPAIR_EXPLANATION}`)
    const same = await correctionCue(original, REPAIR_EXPLANATION)
    expect(same.messages).toEqual(original.messages)
  })
  it('changes only the correction footer while preserving JSON state, system, tools and settings', async () => {
    const original = { ...request, messages: [request.messages[0]!, { role: 'user' as const,
      content: '{"generationMode":"probe","candidateSubmission":{"reason":"too long"}}\n\nTool call:\nprobe(reason: string)\nSubmit exactly one native tool call.' }] }
    const guided = await correctionCue(original, 'Repair the named issue; keep valid fields.')
    expect(guided.messages[0]).toEqual(original.messages[0])
    expect(guided.messages[1]!.content!.split('\n\nTool call:')[0]).toBe(original.messages[1]!.content!.split('\n\nTool call:')[0])
    expect(guided.messages[1]!.content).toContain('Tool call:\nRepair the named issue; keep valid fields.\nprobe(')
    expect(guided.messages[1]!.content).toMatch(/Submit exactly one native tool call\.$/)
    expect(guided.maxTokens).toBe(original.maxTokens)
    expect(guided.tools).toBe(original.tools)
    expect(guided.contextBudget!.inputTokens).toBeGreaterThan((await correctionContext(original, [original.messages[0]!, original.messages[1]!], '', 'fresh')).contextBudget!.inputTokens)
    expect(original.messages[1]!.content).not.toContain('Repair the named')
  })
  it('rejects an empty cue or a message without the owned footer', async () => {
    await expect(correctionCue(request, 'A repair cue')).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
    await expect(correctionCue(request, '')).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
  })
  it('changes only history while keeping correction feedback, settings and tool contracts identical', async () => {
    const fresh = await correctionContext(request, initial, 'Recorded malformed response.', 'fresh')
    const replay = await correctionContext(request, initial, 'Recorded malformed response.', 'replay')
    expect(fresh.messages.map(m => m.role)).toEqual(['system', 'user'])
    expect(replay.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(replay.messages.at(-1)).toEqual(fresh.messages.at(-1))
    expect(replay.messages[2]).toEqual({ role: 'assistant', content: 'Recorded malformed response.' })
    expect(replay.maxTokens).toBe(fresh.maxTokens)
    expect(replay.tools).toBe(fresh.tools)
    expect(replay.contextBudget!.inputTokens).toBeGreaterThan(fresh.contextBudget!.inputTokens)
    expect(request.messages).toHaveLength(2)
  })
  it('rejects empty replay and changed system guidance before transport', async () => {
    await expect(correctionContext(request, initial, '', 'replay')).rejects.toMatchObject({ failure: { category: 'request_invalid' } })
    await expect(correctionContext(request, [{ role: 'system', content: 'Different instructions.' }, initial[1]!], 'Bad response', 'replay'))
      .rejects.toMatchObject({ failure: { category: 'request_invalid' } })
  })
  it('enforces the context budget again after adding replay history', async () => {
    const large = { ...request, messages: [request.messages[0]!, { role: 'user' as const, content: 'A useful explanation. '.repeat(4_000) }] }
    expect((await correctionContext(large, large.messages, 'Bad response', 'fresh')).contextBudget).toBeDefined()
    await expect(correctionContext(large, large.messages, 'Bad response', 'replay')).rejects.toMatchObject({ failure: { category: 'budget_exhausted' } })
  })
})
