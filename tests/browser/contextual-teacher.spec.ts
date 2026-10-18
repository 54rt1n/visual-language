import { openTool } from './navigation'
import { expect, test, type Page, type Route } from '@playwright/test'
import { THANKS_EXAMPLE, TEA_EXAMPLE } from '../fixtures/worked-examples'

const NOW = Date.UTC(2026, 8, 10, 12), DAY = 86_400_000
const MODEL_ENDPOINT = 'https://api.context-fixture.example/v1/chat/completions'
const WEB_CHOICE = 'Use Tavily examples for questions and corrective practice'
async function close(page: Page) { await page.getByRole('button', { name: 'Close dialog' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0) }
async function ready(page: Page) {
  await page.clock.setFixedTime(NOW + 40 * DAY)
  await page.goto('/#demo')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://api.context-fixture.example/v1')
  await page.getByLabel('Model ID').fill('context-fixture-requested')
  await page.getByLabel('Custom endpoint API key').fill('CONTEXT_FIXTURE_MODEL_KEY')
  await page.getByText('Optional web search', { exact: true }).click()
  await page.getByLabel('Tavily API key', { exact: true }).fill('CONTEXT_FIXTURE_TAVILY_KEY')
  await page.getByRole('button', { name: 'Save connection', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI connection' })).toHaveCount(0)
}
async function download(page: Page) {
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download full backup' }).click()
  const file = await pending, stream = await file.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const buffer = Buffer.concat(chunks); await close(page)
  return { buffer, state: JSON.parse(buffer.toString()).data }
}
async function result(route: Route, value: unknown, tool?: string) {
  const encoded = JSON.stringify(value)
  const delta = tool ? { tool_calls: [{ index: 0, id: `${tool}-fixture`, type: 'function', function: { name: tool, arguments: encoded } }] } : { content: encoded }
  const frames = [{ model: 'actual-context-fixture', choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] }]
  await route.fulfill({ contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n' })
}
async function fixtures(page: Page) {
  const controls = { empty: false, failGrade: false }, calls: string[] = [], searches: unknown[] = []
  await page.route('https://api.tavily.com/search', async route => {
    const body = route.request().postDataJSON(); searches.push(body)
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|CONTEXT_FIXTURE_|coffee/)
    expect(body).toMatchObject({ search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false, auto_parameters: false })
    await route.fulfill({ json: { results: controls.empty ? [] : [{ title: 'Specialist usage fixture', url: 'https://example.org/mandarin-usage', content: '谢谢 means thank you. 请给我一杯茶 politely requests a cup of tea. Source fixture, not live retrieval.', published_date: '2026-09-09' }] } })
  })
  await page.route('https://api.tavily.com/extract', async route => {
    expect(route.request().postDataJSON().urls).toEqual(['https://example.org/mandarin-usage'])
    await route.fulfill({ json: { results: [{ url: 'https://example.org/mandarin-usage', raw_content: 'Frozen full example: 谢谢 means thank you; 请给我一杯茶 politely asks for a cup of tea, not coffee.' }] } })
  })
  await page.route(MODEL_ENDPOINT, async route => {
    const body = route.request().postDataJSON(), transcript = JSON.stringify(body.messages)
    expect(transcript).not.toContain('CONTEXT_FIXTURE_')
    const tool = body.tools?.[0]?.function.name
    let input
    for (const message of [...body.messages].reverse()) if (message.role === 'user') {
      try { input = JSON.parse(message.content); break } catch { /* extraction instruction */ }
    }
    if (tool === 'search_web') {
      calls.push('search-tool'); expect(transcript).not.toContain('PRIVATE_')
      expect(Object.keys(input[0]).sort()).toEqual(['language', 'meaning', 'phrase'])
      await result(route, { query: `Mandarin ${input[0].phrase} usage fixture`, purpose: 'Public phrase usage' }, 'search_web'); return
    }
    if (tool === 'extract_sources') {
      calls.push('extract-tool'); expect(transcript).not.toContain('PRIVATE_')
      const toolMessage = body.messages.findLast((m: { role: string }) => m.role === 'tool')
      const sources = JSON.parse(toolMessage.content).result.sources
      await result(route, { sourceIds: [sources[0].id] }, 'extract_sources'); return
    }
    const cited = input.sources?.find((s: { kind: string }) => s.kind === 'web') ?? input.sources?.[0]
    if (body.tools) {
      calls.push('native-quiz')
      await result(route, { title: 'Cited recognition fixture', questions: input.targets.map((t: { target: { cardId: string } }) => ({
        cardId: t.target.cardId, stem: 'A colleague helped you. Which expression thanks them?',
        options: [{ id: 'thanks', text: '谢谢' }, { id: 'hello', text: '你好' }, { id: 'bye', text: '再见' }, { id: 'sorry', text: '对不起' }], correctOptionId: 'thanks', workedExample: THANKS_EXAMPLE,
        explanation: 'Use thanks, not a greeting or apology.', objective: 'Recognize thanks in a social context.', sourceIds: [cited.id],
        distractorFeedback: ['hello', 'bye', 'sorry'].map(optionId => ({ optionId, explanation: 'This expression serves a different social purpose.' })),
      })) }, 'draft_multiple_choice_quiz'); return
    }
    if (input.quiz) {
      calls.push('content-review')
      expect(body.messages.some((m: { role: string; tool_call_id?: string }) => m.role === 'tool' && m.tool_call_id === 'draft_multiple_choice_quiz-fixture')).toBe(true)
      await result(route, { verdict: 'supported', reasons: 'Labeled browser fixture, not live semantic review.', questions: input.quiz.questions.map((q: { cardId: string }) => ({ cardId: q.cardId, oneCorrectAnswer: true, sourceSupported: true, skillAligned: true, answerHidden: true, levelAppropriate: true, evidence: 'The fixture explicitly defines thanks.' })) }); return
    }
    if (input.exercise) {
      calls.push('grade')
      if (controls.failGrade) { await route.abort('internetdisconnected'); return }
      expect(input.context.sources.some((s: { excerpt: string }) => s.excerpt.includes('cup of tea'))).toBe(true)
      const correct = input.answer === '请给我一杯茶'
      await result(route, { exerciseId: input.exercise.id, grade: correct ? 'correct' : 'incorrect', criteria: input.exercise.rubric.map((r: { id: string }) => ({ criterionId: r.id, met: correct, evidence: 'Fixture checks the frozen tea-request rubric.' })), feedback: correct ? 'A polite tea request.' : 'You asked for coffee. Practice the polite request for tea.', workedExample: TEA_EXAMPLE }); return
    }
    calls.push('typed-exercise')
    expect(input.learner.goal).toContain('PRIVATE_')
    await result(route, { prompt: input.practiceFocus === 'mistakeContrast' ? 'At a café, politely request one cup of tea in Mandarin, not another drink.' : 'At a café, politely request one cup of tea in Mandarin.', expectedAnswer: '请给我一杯茶', acceptedAlternatives: [], rubric: [{ id: 'tea', description: 'Politely request one cup of tea in Mandarin.', required: true }], allowedAids: [], sourceIds: [cited.id], answerPolicy: 'contextual', workedExample: TEA_EXAMPLE })
  })
  return { calls, searches, controls }
}

test('Tavily contexts support native recognition, typed recall and corrective practice without leaking sources or adding credit', async ({ page }) => {
  test.setTimeout(60000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await ready(page); const f = await fixtures(page)
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await page.getByLabel('Learning goal', { exact: true }).fill('PRIVATE_GOAL — order drinks politely.')
  await page.getByRole('dialog').getByRole('button', { name: 'Start practice' }).click()
  await page.getByText('Context for the next question', { exact: true }).click()
  await page.getByRole('checkbox', { name: WEB_CHOICE }).check()
  await page.getByRole('checkbox', { name: 'Extract selected pages if useful', exact: true }).check()
  await page.getByRole('button', { name: 'Review next due card' }).click()
  await expect(page.getByTestId('question-context')).toContainText('Cites a saved web source')
  await expect(page.getByRole('region', { name: 'Saved sources' })).toHaveCount(0)
  await expect(page.getByRole('dialog')).not.toContainText('PRIVATE_GOAL')
  await page.getByRole('radio', { name: /谢谢/ }).check()
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(page.getByText('Scheduled result:', { exact: false })).toContainText('box 2')
  await expect(page.getByRole('region', { name: 'Saved sources' })).toContainText('Specialist usage fixture')
  await page.getByRole('button', { name: 'Next review', exact: true }).click()
  await expect(page.getByLabel('Your answer', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).not.toContainText('请给我一杯茶')
  await expect(page.getByRole('region', { name: 'Saved sources' })).toHaveCount(0)
  await page.getByLabel('Your answer', { exact: true }).fill('我要咖啡')
  f.controls.failGrade = true
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry assessment' })).toBeVisible()
  await close(page); const pending = await download(page)
  const tea = pending.state.cards.find((c: { id: string }) => c.id === 'demo-tea-card')
  expect(tea.box).toBe(3)
  const count = f.calls.length
  await page.reload(); await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await expect(page.getByLabel('Your answer', { exact: true })).toHaveValue('我要咖啡')
  expect(f.calls).toHaveLength(count)
  await page.getByRole('dialog').getByRole('button', { name: 'Resume practice' }).click()
  f.controls.failGrade = false; await page.getByRole('button', { name: 'Retry assessment' }).click()
  await expect(page.getByText('Scheduled result:', { exact: false })).toContainText('not recalled · box 1')
  await page.getByText('Context for the next question', { exact: true }).click()
  await page.getByRole('checkbox', { name: WEB_CHOICE }).check()
  await page.getByRole('button', { name: 'Fresh corrective practice' }).click()
  await expect(page.getByTestId('question-context')).toContainText('Focused contrast using recent difficulties')
  await page.getByLabel('Your answer', { exact: true }).fill('请给我一杯茶')
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(page.getByText('Practice only: box and due date are unchanged.', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('region', { name: 'Saved sources' }).getByText('Web · Specialist usage fixture', { exact: true }).click()
  await page.getByRole('region', { name: 'Saved sources' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/contextual-feedback-mobile.png', fullPage: true })
  await close(page); const final = await download(page)
  expect(final.state.cards.find((c: { id: string }) => c.id === 'demo-tea-card')).toMatchObject({ box: 1, dueAt: NOW + DAY, revision: tea.revision + 1 })
  expect(final.state.exercises.filter((e: { learningContext?: unknown }) => e.learningContext)).toHaveLength(3)
  expect(final.state.sources.filter((s: { kind: string }) => s.kind === 'web').every((s: { retrievedAt: number }) => s.retrievedAt === NOW + 40 * DAY)).toBe(true)
  expect(f.calls.filter(c => c === 'native-quiz')).toHaveLength(1)
  expect(f.calls.filter(c => c === 'content-review')).toHaveLength(1)
  expect(f.searches).toHaveLength(3) // Explicit page reload discarded the in-memory cache before corrective practice.
  expect(final.buffer.toString()).not.toContain('CONTEXT_FIXTURE_')
  expect(errors).toEqual([])
})

test('empty Tavily results keep a visible saved-context fallback through pending-question backup restore', async ({ page, browser }) => {
  await ready(page); const f = await fixtures(page); f.controls.empty = true
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Start practice' }).click()
  await page.getByText('Context for the next question', { exact: true }).click()
  await page.getByRole('checkbox', { name: WEB_CHOICE }).check()
  await page.getByRole('button', { name: 'Review next due card' }).click()
  await expect(page.getByTestId('question-context')).toContainText('Uses saved learning examples')
  await expect(page.getByRole('status').filter({ hasText: 'No usable web sources' }).first()).toBeVisible()
  await page.getByRole('radio', { name: /谢谢/ }).check(); await close(page)
  const backup = await download(page)
  const fresh = await browser.newContext(), restored = await fresh.newPage(), external: string[] = []
  restored.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173')) external.push(r.url()) })
  await restored.goto('/#demo'); await expect(restored.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(restored, 'Backup & restore')
  await restored.getByLabel('Choose backup file').setInputFiles({ name: 'contextual-demo.json', mimeType: 'application/json', buffer: backup.buffer })
  await restored.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
  await restored.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await expect(restored.getByText('Workspace restored.', { exact: false })).toBeVisible(); await close(restored)
  await restored.getByRole('button', { name: 'Daily review', exact: true }).click()
  await expect(restored.getByTestId('question-context')).toContainText('Uses saved learning examples')
  await expect(restored.getByRole('status').filter({ hasText: 'No usable web sources' })).toBeVisible()
  await restored.getByRole('dialog').getByRole('button', { name: 'Resume practice' }).click()
  await restored.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(restored.getByText('Scheduled result:', { exact: false })).toContainText('box 2')
  expect(external).toEqual([]); await fresh.close()
})
