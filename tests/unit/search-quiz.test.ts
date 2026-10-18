import { describe, expect, it, vi } from 'vitest'
import { boundedJsonResponse, publicSourceUrl } from '../../src/lib/ai/http'
import { extractSources, searchWeb } from '../../src/lib/search/tavily'
import { scoreOption, shuffleOptions, studentQuestion, validateQuizDraft } from '../../src/lib/learning/quiz'
import { NOW } from './fixtures'

const input = { query: 'Mandarin café phrase', purpose: 'A source-grounded recall example' }
const result = { title: 'Useful phrases', url: 'https://example.com/phrases', content: '你好 '.repeat(300) }
describe('direct Tavily search and frozen sources', () => {
  it('uses bounded explicit search parameters and keeps keys out of results/body', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ results: [result] })))
    const cache = await searchWeb(input, { apiKey: 'fixture-private-key', fetcher, now: () => NOW })
    const [url, request] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.tavily.com/search'); expect(request).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(JSON.parse(request!.body as string)).toMatchObject({ search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false, auto_parameters: false })
    expect(request!.body).not.toContain('fixture-private-key')
    expect(JSON.stringify(cache)).not.toContain('fixture-private-key')
    expect(cache.sources[0]!.excerpt).toHaveLength(500)
    expect(cache.expiresAt).toBe(NOW + 86_400_000)
  })
  it('reuses unexpired cache but refreshes current topics after 15 minutes without changing old snapshots', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [result] })))
    const first = await searchWeb({ ...input, current: true }, { apiKey: 'fixture', fetcher, now: () => NOW })
    const cached = await searchWeb({ ...input, current: true }, { apiKey: 'fixture', fetcher, now: () => NOW + 100 }, first)
    expect(cached).toEqual(first); expect(fetcher).toHaveBeenCalledTimes(1)
    const fresh = await searchWeb({ ...input, current: true }, { apiKey: 'fixture', fetcher, now: () => NOW + 900_000 }, first)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fresh.sources[0]!.id).not.toBe(first.sources[0]!.id); expect(first.sources[0]!.retrievedAt).toBe(NOW)
  })
  it('extracts only selected action sources and creates a new bounded snapshot', async () => {
    const source = { id: 'source', kind: 'web' as const, title: result.title, url: result.url, excerpt: 'Saved snippet', retrievedAt: NOW }
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{ ...result, raw_content: '你'.repeat(3000) }] })))
    await expect(extractSources(['invented'], [source], { apiKey: 'fixture', fetcher })).rejects.toThrow('this action')
    expect(fetcher).not.toHaveBeenCalled()
    const extracted = await extractSources(['source'], [source], { apiKey: 'fixture', fetcher, now: () => NOW + 100 })
    expect(extracted.sources[0]!.excerpt).toHaveLength(2000); expect(extracted.sources[0]!.id).not.toBe(source.id)
    expect(source.excerpt).toBe('Saved snippet')
    await expect(extractSources(['source', 'source'], [source], { apiKey: 'fixture', fetcher })).rejects.toThrow('distinct')
  })
  it('handles empty/unusable results and rejects executable/local/credential-bearing URLs', async () => {
    const cache = await searchWeb(input, { apiKey: 'fixture', fetcher: async () => new Response(JSON.stringify({ results: [{ ...result, url: 'http://localhost/private' }] })) })
    expect(cache.sources).toEqual([])
    for (const url of ['javascript:alert(1)', 'https://user:password@example.com', 'http://127.0.0.1', 'https://example.com?api_key=private', 'https://example.com?token=private']) expect(() => publicSourceUrl(url)).toThrow()
    expect(publicSourceUrl('https://example.com?q=mandarin#section')).toBe('https://example.com/?q=mandarin')
  })
  it('bounds streamed JSON before allocating the whole response and sanitizes malformed/error bodies', async () => {
    const controller = new AbortController()
    await expect(boundedJsonResponse(new Response('字'.repeat(10)), controller.signal, 20)).rejects.toThrow('size limit')
    await expect(boundedJsonResponse(new Response('not JSON private-value'), controller.signal)).rejects.toThrow('malformed JSON')
    await expect(searchWeb(input, { apiKey: 'fixture', fetcher: async () => new Response('echo-private-key', { status: 401 }) })).rejects.toThrow('key is missing or invalid')
  })
})

describe('quiz publication boundary', () => {
  const draft = { title: 'Polite greetings', questions: [{ cardId: 'card', stem: 'Choose “thank you”.', options: [
    { id: 'a', text: '谢谢' }, { id: 'b', text: '你好' }, { id: 'c', text: '再见' }, { id: 'd', text: '不客气' }],
    correctOptionId: 'a', explanation: '谢谢 expresses thanks.', distractorFeedback: [
      { optionId: 'b', explanation: '你好 is a greeting.' }, { optionId: 'c', explanation: '再见 is a farewell.' }, { optionId: 'd', explanation: '不客气 responds to thanks.' }],
    sourceIds: ['source'], objective: 'Recognize the phrase used to thank someone.' }] }
  it('requires known cards/sources, four distinct options, one key and complete distractor feedback', () => {
    expect(validateQuizDraft(draft, ['card'], ['source'])).toEqual(draft)
    expect(() => validateQuizDraft(draft, [], ['source'])).toThrow('targets')
    expect(() => validateQuizDraft(draft, ['card'], [])).toThrow('sources')
    const duplicate = structuredClone(draft); duplicate.questions[0]!.options[1]!.text = '谢谢'
    expect(() => validateQuizDraft(duplicate, ['card'], ['source'])).toThrow('distinct')
    const wrongKey = structuredClone(draft); wrongKey.questions[0]!.correctOptionId = 'missing'
    expect(() => validateQuizDraft(wrongKey, ['card'], ['source'])).toThrow('answer key')
    const wrongFeedback = structuredClone(draft); wrongFeedback.questions[0]!.distractorFeedback[0]!.optionId = 'a'
    expect(() => validateQuizDraft(wrongFeedback, ['card'], ['source'])).toThrow('distractor')
    expect(() => validateQuizDraft({ ...draft, dueAt: NOW }, ['card'], ['source'])).toThrow()
  })
  it('freezes a shuffled order without changing the key and hides answer-bearing fields', () => {
    const question = shuffleOptions(draft.questions[0]!, () => 0)
    expect(question.options.map(o => o.id)).toEqual(['b', 'c', 'd', 'a'])
    expect(scoreOption(question, 'a')).toBe(true); expect(scoreOption(question, 'b')).toBe(false)
    expect(() => scoreOption(question, 'missing')).toThrow('Choose')
    expect(JSON.parse(JSON.stringify(question))).toEqual(question)
    expect(studentQuestion(question)).toEqual({ stem: question.stem, passage: undefined, options: question.options })
    expect(JSON.stringify(studentQuestion(question))).not.toMatch(/correctOptionId|explanation|Feedback|objective/)
    expect(draft.questions[0]!.options[0]!.id).toBe('a')
  })
})
