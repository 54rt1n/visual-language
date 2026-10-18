import { parseToolContext } from '../fixtures/tool-context'
import { openTool } from './navigation'
import { expect, test, type Page, type Route } from '@playwright/test'
import { topicFixture } from '../fixtures/topic-lesson'
import { lessonSourceFixture, sourceFixtureTools } from '../fixtures/lesson-source'

const NOW = Date.UTC(2026, 8, 10, 12), DAY = 86_400_000
async function close(page: Page) {
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('dialog', { name: 'Your lesson', exact: true })).toHaveCount(0)
  const lessons = page.getByRole('dialog', { name: 'Lessons', exact: true })
  if (await lessons.isVisible()) await lessons.getByRole('button', { name: 'Close dialog' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
}
async function ready(page: Page, web = true) {
  await page.clock.setFixedTime(NOW); await page.goto('/')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://api.discovery-fixture.example/v1')
  await page.getByLabel('Model ID').fill('requested-discovery-fixture')
  await page.getByLabel('Custom endpoint API key').fill('PRIVATE_DISCOVERY_MODEL_KEY')
  if (web) {
    await page.getByText('Optional web search', { exact: true }).click()
    await page.getByLabel('Tavily API key', { exact: true }).fill('PRIVATE_DISCOVERY_SEARCH_KEY')
  }
  await page.getByRole('button', { name: 'Save connection', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI connection' })).toHaveCount(0)
}
async function download(page: Page) {
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full backup' }).click()
  const file = await pending, stream = await file.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const buffer = Buffer.concat(chunks); await close(page)
  return { buffer, state: JSON.parse(buffer.toString()).data }
}
async function result(route: Route, value: unknown, name?: string) {
  const valueText = JSON.stringify(value)
  const delta = name ? { tool_calls: [{ index: 0, id: `${name}-fixture`, type: 'function', function: { name, arguments: valueText } }] } : { content: valueText }
  const frames = [{ model: 'actual-discovery-fixture', choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] }]
  await route.fulfill({ contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n' })
}
async function fixtures(page: Page) {
  const controls = { failSearch: false, failDraft: false, failReview: false, published: '2026-09-10' }, calls: string[] = [], searches: { query: string; topic: string }[] = []
  await page.route('https://api.tavily.com/search', async route => {
    const body = route.request().postDataJSON(); searches.push(body)
    if (controls.failSearch) { await route.abort('internetdisconnected'); return }
    expect(JSON.stringify(body)).not.toContain('PRIVATE_')
    expect(body).toMatchObject({ search_depth: 'basic', max_results: 5, include_answer: false, include_raw_content: false, auto_parameters: false })
    await route.fulfill({ json: { results: [{ title: 'Mandarin café source fixture', url: 'https://example.org/mandarin-cafe', content: '请给我一杯茶 is a polite request for one cup of tea. The following practice uses a simulated café, not live menu information.', ...(controls.published ? { published_date: controls.published } : {}) }] } })
  })
  await page.route('https://api.discovery-fixture.example/v1/chat/completions', async route => {
    const body = route.request().postDataJSON(), transcript = JSON.stringify(body.messages)
    expect(transcript).not.toMatch(/PRIVATE_DISCOVERY_MODEL_KEY|PRIVATE_DISCOVERY_SEARCH_KEY/)
    let input
    for (const message of [...body.messages].reverse()) if (message.role === 'user') try { input = parseToolContext(message.content); break } catch { /* repair instructions */ }
    if (!sourceFixtureTools.includes(body.tools?.[0]?.function.name ?? '')) {
      calls.push(input.generationMode ?? body.tools?.[0]?.function.name ?? 'guidance-review')
      const generated = topicFixture({ ...body, handlers: {} })
      if (generated.toolCalls.length) {
        const delta = { tool_calls: generated.toolCalls.map((call, index) => ({ ...call, index })) }
        await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ model: 'actual-discovery-fixture', choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n` })
      }
      else await result(route, JSON.parse(generated.content))
      return
    }
    const name = body.tools?.[0]?.function.name ?? ''
    const review = name === 'review_lesson_source'
    calls.push(review ? 'lesson-review' : 'lesson-draft')
    if (review ? controls.failReview : controls.failDraft) { await route.abort('internetdisconnected'); return }
    await result(route, lessonSourceFixture(name), name)
  })
  return { controls, calls, searches }
}
async function discovery(page: Page, kind = 'topic', topic = 'Ordering tea') {
  await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
  await page.getByRole('combobox', { name: 'Lesson type', exact: true }).selectOption(kind)
  await page.getByLabel('Topic or scenario', { exact: true }).fill(topic)
}

for (const kind of ['topic', 'roleplay', 'interest']) test(`${kind} uses the shared prepared lesson and restores a selected answer without network`, async ({ page, browser }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await ready(page); const f = await fixtures(page)
  if (kind === 'topic') f.controls.failReview = true
  await discovery(page, kind)
  await page.getByRole('combobox', { name: 'Quiz level', exact: true }).selectOption('responsePinyin')
  await page.getByRole('button', { name: 'Create lesson', exact: true }).click()
  if (kind === 'topic') {
    await expect(page.getByRole('button', { name: 'Continue creating lesson', exact: true })).toBeEnabled()
    await close(page)
    const pending = await download(page)
    expect(pending.state.cards).toHaveLength(0)
    const calls = f.calls.length
    await page.reload(); await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
    expect(f.calls).toHaveLength(calls)
    await expect(page.getByRole('combobox', { name: 'Quiz level', exact: true })).toHaveValue('responsePinyin')
    f.controls.failReview = false
    await page.getByRole('button', { name: 'Continue creating lesson', exact: true }).click()
  }
  let dialog = page.getByRole('dialog', { name: 'Your lesson', exact: true })
  await expect(dialog.getByRole('region', { name: 'Lesson material' })).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Type the Mandarin answer' })).toHaveCount(0)
  if (kind === 'roleplay') { await dialog.getByText('Your scenario', { exact: true }).click(); await expect(dialog).toContainText('Café server') }
  if (kind === 'interest') { await dialog.getByText('Your reading', { exact: true }).click(); await expect(dialog).toContainText('我想喝茶') }
  const calls = f.calls.length
  expect(f.searches).toHaveLength(1)
  await close(page)
  const captured = await download(page)
  expect(captured.state.cards).toHaveLength(1)
  expect(captured.state.cards[0]).toMatchObject({ skill: 'recognition', status: 'new', dueAt: null })
  expect(captured.state.events).toHaveLength(0)
  await page.getByRole('button', { name: 'Lessons', exact: true }).click()
  await page.getByRole('dialog', { name: 'Lessons', exact: true }).getByRole('button', { name: 'Continue', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Your lesson', exact: true })
  await expect(dialog.getByRole('region', { name: 'Lesson material' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Try it', exact: true }).click()
  await expect(dialog.getByLabel('Your answer', { exact: true })).toHaveCount(0)
  await dialog.getByRole('radio', { name: /请给我一杯茶/ }).check()
  await close(page)
  const quiz = await download(page)
  expect(quiz.state.lessons.find((l: any) => l.id === quiz.state.sessions.at(-1).lessonAttempt.lessonId).kind).toBe(kind === 'roleplay' ? 'scenario' : kind === 'interest' ? 'reading' : 'topic')
  expect(quiz.state.exercises[0]).toMatchObject({ mode: 'practice', format: 'multipleChoice' })
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } }), restored = await fresh.newPage(), requests: string[] = []
  restored.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173')) requests.push(r.url()) })
  await restored.clock.setFixedTime(NOW + 2 * DAY); await restored.goto('/')
  await expect(restored.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(restored, 'Backup & restore')
  await restored.getByLabel('Choose backup file').setInputFiles({ name: 'lesson-quiz.json', mimeType: 'application/json', buffer: quiz.buffer })
  await restored.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
  await restored.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await expect(restored.getByText('Workspace restored.', { exact: false })).toBeVisible(); await close(restored)
  await restored.getByRole('button', { name: 'Resume lesson', exact: true }).click()
  dialog = restored.getByRole('dialog', { name: 'Your lesson' })
  await dialog.getByRole('button', { name: 'Resume lesson', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: /请给我一杯茶/ })).toBeChecked()
  await dialog.getByRole('button', { name: 'Check answer', exact: true }).click()
  await expect(dialog.getByText('Correct.', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Start quiz', exact: true }).click()
  // A wrong quiz answer is kept; corrections appear only after submitting the quiz.
  await dialog.getByRole('radio', { name: /你好/ }).check()
  await expect(dialog.getByRole('button', { name: 'Check answer', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('group', { name: 'Choose again', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Submit quiz', exact: true }).click()
  await expect(dialog).toContainText('0 of 1 correct')
  await expect(dialog.getByRole('region', { name: 'Quiz answers', exact: true })).toContainText('Correct answer: 请给我一杯茶')
  await restored.screenshot({ path: `test-results/prepared-${kind}-mobile.png`, fullPage: true })
  await close(restored)
  const scored = await download(restored)
  expect(scored.state.cards).toEqual(quiz.state.cards)
  expect(scored.state.events.filter((e: { kind: string }) => e.kind === 'review')).toHaveLength(0)
  expect(requests).toEqual([]); expect(f.calls).toHaveLength(calls)
  expect(quiz.buffer.toString()).not.toContain('PRIVATE_DISCOVERY_')
  await fresh.close(); expect(errors).toEqual([])
})

test('current-interest reading refuses undated news and shows dates after an explicit refreshed request', async ({ page }) => {
  await ready(page); const f = await fixtures(page); f.controls.published = ''
  await discovery(page, 'interest', 'Tea culture news')
  await page.getByRole('button', { name: 'Create lesson', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.locator('.action-status').getByText('Details', { exact: true }).click()
  await expect(page.locator('.action-status')).toContainText('last 30 days')
  await expect(page.getByRole('article', { name: 'Reviewed discovery lesson' })).toHaveCount(0)
  expect(f.calls).toEqual([])
  await page.getByRole('button', { name: 'New lesson', exact: true }).click()
  await page.getByLabel('Topic or scenario', { exact: true }).fill('Tea culture news')
  await page.locator('.search-options > summary').click()
  await page.getByRole('checkbox', { name: 'Get fresh search results', exact: true }).check()
  f.controls.published = '2026-09-10'
  await page.getByRole('button', { name: 'Create lesson', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Your lesson' }).getByRole('region', { name: 'Lesson material' })).toBeVisible()
  await close(page)
  await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
  await page.getByText('Web · Mandarin café source fixture', { exact: true }).click()
  await expect(page.getByRole('region', { name: 'Saved sources' })).toContainText('Published 2026-09-10')
  await expect(page.getByText('Adapted Mandarin reading', { exact: true })).toBeVisible()
  expect(f.searches).toHaveLength(2); expect(f.searches.every(s => s.topic === 'news')).toBe(true)
  await close(page); const saved = await download(page)
  expect(saved.state.cards).toHaveLength(1); expect(saved.state.events).toHaveLength(0)
  expect(saved.state.drafts.filter((d: { kind: string }) => d.kind === 'discovery')).toHaveLength(2)
})

test('interrupted lesson creation stays editable and resumes saved work without another search', async ({ page }) => {
  await ready(page); const f = await fixtures(page)
  f.controls.failSearch = true
  await discovery(page, 'topic', 'Ordering Chinese food')
  const dialog = page.getByRole('dialog', { name: 'Explore a topic', exact: true })
  await expect(dialog.getByText('Request limits & privacy', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Create lesson', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: 'Lesson type', exact: true })).toBeEnabled()
  await expect(dialog.getByLabel('Topic or scenario', { exact: true })).toBeEditable()
  f.controls.failSearch = false; f.controls.failDraft = true
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Continue creating lesson', exact: true })).toBeEnabled()
  const original = await dialog.getByRole('combobox', { name: 'Saved lesson', exact: true }).inputValue(), searches = f.searches.length, calls = f.calls.length
  await page.reload(); await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
  expect(f.calls).toHaveLength(calls)
  await page.setViewportSize({ width: 390, height: 568 })
  const type = dialog.getByRole('combobox', { name: 'Lesson type', exact: true }), picker = dialog.getByRole('combobox', { name: 'Saved lesson', exact: true })
  await expect(type).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Continue creating lesson', exact: true })).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: 'test-results/discovery-resume-mobile.png', fullPage: true })
  await type.selectOption('roleplay')
  await expect(picker).not.toHaveValue(original)
  await expect(picker.locator('option')).toHaveCount(3)
  await picker.selectOption(original)
  await expect(type).toHaveValue('topic')
  f.controls.failDraft = false
  await dialog.getByRole('button', { name: 'Continue creating lesson', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Your lesson' }).getByRole('region', { name: 'Lesson material' })).toBeVisible()
  expect(f.searches).toHaveLength(searches)
  await close(page)
  await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
  await dialog.getByRole('button', { name: 'New lesson', exact: true }).click()
  await expect(dialog.getByLabel('Topic or scenario', { exact: true })).toHaveValue('')
  await picker.selectOption({ index: 1 })
  await expect(type).toHaveValue('roleplay')
  await expect(type).toBeEnabled()
})

test('Create lesson reaches the shared waypoint and quiz harness without a web-search account', async ({ page }) => {
  await ready(page, false); const f = await fixtures(page)
  await discovery(page, 'topic', 'Ordering Chinese food')
  await page.getByRole('button', { name: 'Create lesson', exact: true }).click()
  const lesson = page.getByRole('dialog', { name: 'Your lesson', exact: true })
  await expect(lesson.getByRole('region', { name: 'Lesson material', exact: true })).toBeVisible()
  await expect(lesson.getByRole('button', { name: 'Try it', exact: true })).toBeEnabled()
  expect(f.searches).toHaveLength(0)
  expect(f.calls).toContain('add_lesson_waypoint')
  expect(f.calls).toContain('build_question_answers')
  await page.screenshot({ path: 'test-results/discovery-ai-created-lesson.png', fullPage: true })
})
