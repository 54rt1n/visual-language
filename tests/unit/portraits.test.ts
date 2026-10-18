import { describe, expect, it, vi } from 'vitest'
import { availablePortrait, portraitFile, portraitState, portraitStates, teacherExpression } from '../../src/lib/teacher/portrait'
import { TeacherActivity } from '../../src/lib/teacher/activity'
import { searchWeb } from '../../src/lib/search/tavily'
import { validateWorkspace } from '../../src/lib/domain/workspace'
import { workspaceFixture } from './fixtures'

describe('teacher presentation policy', () => {
  it('uses only the manifest states and local files, including neutral fallback for untrusted values', () => {
    expect(portraitStates).toHaveLength(5)
    for (const state of portraitStates) expect(portraitFile(state)).toMatch(/^avatars\/zheng\/[a-z-]+-v1\.png$/)
    for (const value of ['https://untrusted.example/avatar.png', '<img onerror=alert(1)>', null, 'gentle-correction']) {
      expect(portraitState(value)).toBe('attentive'); expect(portraitFile(value)).toBe('avatars/zheng/attentive-v1.png')
    }
  })
  it('ends a failed-image chain after at most the selected and default poses', () => {
    expect(availablePortrait('thinking', [])).toBe('thinking')
    expect(availablePortrait('thinking', ['thinking'])).toBe('attentive')
    expect(availablePortrait('thinking', ['thinking', 'attentive'])).toBeUndefined()
    expect(availablePortrait('encouraging', ['thinking', 'attentive'])).toBe('encouraging')
  })
  it('requires confirmed assessment for success/correction and uses neutral for failures and disputes', () => {
    expect(teacherExpression({ pending: false, grade: 'incorrect' })).toBe('attentive')
    expect(teacherExpression({ pending: false, committed: true, grade: 'incorrect' })).toBe('gentleCorrection')
    expect(teacherExpression({ pending: false, committed: true, grade: 'correct' })).toBe('encouraging')
    expect(teacherExpression({ pending: false, committed: true, grade: 'correct', failed: true })).toBe('attentive')
    expect(teacherExpression({ pending: false, committed: true, grade: 'incorrect', disputed: true })).toBe('attentive')
    expect(teacherExpression({ pending: false, committed: true, grade: 'uncertain' })).toBe('attentive')
    expect(teacherExpression({ pending: true, committed: true, grade: 'incorrect' })).toBe('thinking')
    expect(teacherExpression({ pending: false, welcoming: true })).toBe('welcome')
  })
  it('tracks real request settlement, overlapping calls and cancellation without a timer or background task', async () => {
    const activity = new TeacherActivity()
    let finish!: () => void, fail!: (reason: unknown) => void
    const first = activity.track(() => new Promise<void>(resolve => { finish = resolve }))
    const second = activity.track(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    expect(activity.pending).toBe(2)
    finish(); await first; expect(activity.pending).toBe(1)
    const cancelled = expect(second).rejects.toThrow('Cancelled')
    fail(new DOMException('Cancelled', 'AbortError')); await cancelled; expect(activity.pending).toBe(0)
    await expect(activity.track(async () => { throw new Error('Network failure') })).rejects.toThrow('Network failure')
    expect(activity.pending).toBe(0)
  })
  it('preserves text-only workspace preferences while accepting old backups without the field', () => {
    const state = workspaceFixture(); state.view.teacherPortraits = false
    expect(validateWorkspace(state).view.teacherPortraits).toBe(false)
    delete state.view.teacherPortraits
    expect(validateWorkspace(state).view.teacherPortraits ?? true).toBe(true)
    expect(() => validateWorkspace({ ...state, view: { ...state.view, teacherPortraits: 'hidden' } })).toThrow()
  })
  it('keeps retrieval active through a delayed body, not just headers, and skips activity for cached results', async () => {
    const activity = new TeacherActivity(), onRequest = vi.fn(activity.begin)
    let body!: ReadableStreamDefaultController<Uint8Array>
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } })))
    const input = { query: 'Mandarin portrait fixture', purpose: 'fixture' }, options = { apiKey: 'fixture-only', fetcher, onRequest }
    const pending = searchWeb(input, options)
    await Promise.resolve(); await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(1); expect(activity.pending).toBe(1)
    body.enqueue(new TextEncoder().encode('{"results":[]}')); body.close()
    const cached = await pending; expect(activity.pending).toBe(0)
    await searchWeb(input, options, cached)
    expect(fetcher).toHaveBeenCalledTimes(1); expect(onRequest).toHaveBeenCalledTimes(1)
  })
  it('ends retrieval activity on body cancellation and HTTP failure without animating missing-key validation', async () => {
    const activity = new TeacherActivity(), onRequest = vi.fn(activity.begin), cancelled = vi.fn()
    const controller = new AbortController(), input = { query: 'Mandarin cancellation fixture', purpose: 'fixture' }
    const pending = searchWeb(input, { apiKey: 'fixture-only', onRequest, signal: controller.signal,
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })) })
    await Promise.resolve(); await Promise.resolve(); expect(activity.pending).toBe(1)
    const rejected = expect(pending).rejects.toThrow('Cancelled')
    controller.abort(new DOMException('Cancelled', 'AbortError')); await rejected
    expect(cancelled).toHaveBeenCalledTimes(1); expect(activity.pending).toBe(0)
    await expect(searchWeb(input, { apiKey: 'fixture-only', onRequest, fetcher: async () => new Response(null, { status: 429 }) })).rejects.toThrow('limiting requests')
    expect(activity.pending).toBe(0); expect(onRequest).toHaveBeenCalledTimes(2)
    await expect(searchWeb(input, { apiKey: '', onRequest })).rejects.toThrow('Tavily key')
    expect(onRequest).toHaveBeenCalledTimes(2)
  })
})
