import { openTool, returningVisitor } from './navigation'
import { expect, test, type Page } from '@playwright/test'
import { THANKS_EXAMPLE } from '../fixtures/worked-examples'

const NOW = Date.UTC(2026, 8, 10, 12), DAY = 86_400_000
async function ready(page: Page) {
  await page.clock.setFixedTime(NOW)
  await page.goto('/')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
}
async function configure(page: Page) {
  await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://api.teacher-fixture.example/v1')
  await page.getByLabel('Model ID').fill('teacher-fixture-requested')
  await page.getByLabel('Custom endpoint API key').fill('teacher-fixture-key')
  await page.getByRole('button', { name: 'Save connection', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'AI connection' })).toHaveCount(0)
}
async function fixture(page: Page) {
  const calls: string[] = []
  const controls: { failGrade: boolean; delayExample: boolean; releaseExample?: () => void; failReview: boolean; rejectReview: boolean; delayReview: boolean; releaseReview?: () => void } = { failGrade: false, delayExample: false, failReview: false, rejectReview: false, delayReview: false }
  await page.route('https://api.teacher-fixture.example/v1/chat/completions', async route => {
    const body = route.request().postDataJSON()
    let input
    try { input = JSON.parse(body.messages.findLast((m: { role: string }) => m.role === 'user').content) }
    catch {
      calls.push('conversation')
      const frame = { model: 'actual-teacher-fixture', choices: [{ index: 0, delta: { content: '谢谢 means thank you. Use it to thank someone.' }, finish_reason: null }] }
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(frame)}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` })
      return
    }
    let result: unknown
    if (body.tools) {
      calls.push('native-quiz')
      const quiz = { title: 'Fixture recognition quiz', questions: input.targets.map((entry: { target: { cardId: string } }) => ({ cardId: entry.target.cardId, stem: input.regeneration ? 'A friend helped you. Which expression conveys thanks?' : 'Which expression thanks someone?',
        options: [{ id: 'thanks', text: '谢谢' }, { id: 'hello', text: '你好' }, { id: 'bye', text: '再见' }, { id: 'welcome', text: '不客气' }], correctOptionId: 'thanks', workedExample: THANKS_EXAMPLE,
        explanation: '谢谢 expresses thanks.', objective: 'Recognize thanks in Mandarin.', sourceIds: [input.sources[0].id],
        distractorFeedback: ['hello', 'bye', 'welcome'].map(optionId => ({ optionId, explanation: 'This expression does not convey thanks.' })),
      })) }
      const args = JSON.stringify(quiz), half = Math.floor(args.length / 2)
      const frames = [{ model: 'actual-teacher-fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'native-quiz-call', type: 'function', function: { name: 'draft_multiple_choice_quiz', arguments: args.slice(0, half) } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n' })
      return
    } else if (input.quiz) {
      calls.push('content-review')
      if (body.messages.some((m: { role: string }) => m.role === 'assistant')) expect(body.messages.some((m: { role: string; tool_call_id?: string }) => m.role === 'tool' && m.tool_call_id === 'native-quiz-call')).toBe(true)
      if (controls.delayReview) await new Promise<void>(resolve => { controls.releaseReview = resolve })
      if (controls.failReview) { await route.abort('internetdisconnected'); return }
      result = { verdict: controls.rejectReview ? 'uncertain' : 'supported', reasons: controls.rejectReview ? 'ANSWER_LEAK: 谢谢 is the answer.' : 'Deterministic test fixture, not live semantic evidence.', questions: input.quiz.questions.map((q: { cardId: string }) => ({ cardId: q.cardId, oneCorrectAnswer: true, sourceSupported: !controls.rejectReview, skillAligned: true, answerHidden: true, levelAppropriate: true, evidence: 'Saved fixture source explicitly supports thanks.' })) }
    } else if (input.originalAssessment) {
      calls.push('worked-example')
      if (controls.delayExample) await new Promise<void>(resolve => { controls.releaseExample = resolve })
      result = THANKS_EXAMPLE
    } else if (input.exercise) {
      calls.push('grade')
      if (controls.failGrade) { await route.abort('internetdisconnected'); return }
      result = { exerciseId: input.exercise.id, grade: input.answer === '谢谢' ? 'correct' : 'incorrect', criteria: input.exercise.rubric.map((r: { id: string }) => ({ criterionId: r.id, met: input.answer === '谢谢', evidence: 'Compared with the saved thanks rubric in this labeled fixture.' })), feedback: input.answer === '谢谢' ? 'You expressed thanks correctly.' : 'Use the expression for thanks, not a greeting.', workedExample: THANKS_EXAMPLE }
    } else if (body.messages[0].content.includes('Prepare one')) {
      calls.push('exercise')
      result = { prompt: 'Someone helped you. Write a short Mandarin expression of thanks.', expectedAnswer: '谢谢', acceptedAlternatives: [], rubric: [{ id: 'meaning', description: 'Express thanks in Mandarin.', required: true }], allowedAids: [], sourceIds: [input.sources[0].id], answerPolicy: 'contextual', workedExample: THANKS_EXAMPLE }
    } else {
      calls.push('introduction')
      result = { explanation: 'Use this expression to thank someone.', exampleHanzi: '谢谢你的帮助。', exampleMeaning: 'Thank you for your help.', sourceIds: [input.sources[0].id] }
    }
    const frame = { model: 'actual-teacher-fixture', choices: [{ index: 0, delta: { content: JSON.stringify(result) }, finish_reason: null }] }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(frame)}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` })
  })
  return { calls, controls }
}
async function captureAndIntroduce(page: Page, recognition = false, expectQuestion = true) {
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Teach me how to thank someone.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.svelte-flow__node-assistant')).toContainText('谢谢 means thank you.')
  await page.getByRole('button', { name: 'Save for practice', exact: true }).click()
  await page.getByLabel('Mandarin word or phrase').fill('谢谢')
  await page.getByLabel('Meaning in this context').fill('thank you')
  await page.getByText(/^Practice options/).click()
  await page.getByRole('checkbox', { name: 'Type the Mandarin answer', exact: true }).setChecked(!recognition)
  await page.getByRole('checkbox', { name: 'Choose an answer (multiple choice)', exact: true }).setChecked(recognition)
  await page.getByRole('dialog', { name: 'Save for practice', exact: true }).getByRole('button', { name: 'Save for practice', exact: true }).click()
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await page.getByLabel('Learning goal', { exact: true }).fill('Use 谢谢 to thank someone naturally.')
  await page.getByRole('dialog').getByRole('button', { name: 'Start practice' }).click()
  await page.getByRole('button', { name: 'Teach this item' }).click()
  await expect(page.getByText('Use this expression to thank someone.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Finish introduction — first review tomorrow' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Introduction complete' })).toBeVisible()
  await page.getByRole('button', { name: 'End session', exact: true }).click()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.clock.setFixedTime(NOW + DAY)
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Start practice' }).click()
  await page.getByRole('button', { name: 'Review next due card' }).click()
  if (expectQuestion) await expect(page.getByRole('region', { name: 'Saved exercise' })).toBeVisible()
}
async function download(page: Page) {
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download full backup' }).click()
  const file = await pending, stream = await file.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const buffer = Buffer.concat(chunks)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  return buffer
}

test('inactive quiz survives interruption, cancellation, regeneration and keyless recovery into a new lesson', async ({ page, browser }) => {
  await ready(page); await configure(page)
  const { calls, controls } = await fixture(page); controls.failReview = true
  await captureAndIntroduce(page, true, false)
  const panel = page.getByRole('region', { name: 'Saved quiz work' })
  await expect(panel).toContainText('content review needed')
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(panel).not.toContainText('谢谢'); await expect(panel).not.toContainText('Fixture recognition quiz')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const original = JSON.parse((await download(page)).toString()).data, originalQuiz = original.drafts.find((d: { kind: string }) => d.kind === 'quiz')
  const count = calls.length
  await page.reload(); await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await expect(panel).toBeVisible(); expect(calls).toHaveLength(count)
  controls.failReview = false; controls.delayReview = true
  await panel.getByRole('button', { name: 'Review saved quiz', exact: true }).click()
  await expect.poll(() => Boolean(controls.releaseReview)).toBe(true)
  await expect(page.getByTestId('teacher-portrait').locator('img')).toHaveAttribute('data-pose', 'thinking')
  await page.getByRole('button', { name: 'Cancel current request', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Saved work is available')
  await expect(page.getByTestId('teacher-portrait').locator('img')).toHaveAttribute('data-pose', 'attentive')
  controls.releaseReview!(); controls.delayReview = false
  await expect(panel).toContainText('content review needed')
  controls.rejectReview = true
  await panel.getByRole('button', { name: 'Review saved quiz', exact: true }).click()
  await expect(panel).toContainText('review not supported')
  await expect(page.getByRole('alert')).not.toContainText('ANSWER_LEAK')
  await expect(panel).not.toContainText('ANSWER_LEAK')
  await panel.getByRole('button', { name: 'Discard candidate', exact: true }).click()
  await panel.getByRole('button', { name: 'Keep candidate', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Review saved quiz', exact: true })).toBeEnabled()
  controls.rejectReview = false; controls.failReview = true
  await panel.getByRole('button', { name: 'Regenerate from saved sources', exact: true }).click()
  await expect(panel).toContainText('Replacement version')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const replacing = JSON.parse((await download(page)).toString()).data
  const replacement = replacing.drafts.find((d: { replacesDraftId?: string }) => d.replacesDraftId === originalQuiz.id)
  expect(replacing.drafts.find((d: { id: string }) => d.id === originalQuiz.id).discardedAt).toBe(NOW + DAY)
  expect(replacement).toMatchObject({ status: 'pending', sourceIds: originalQuiz.sourceIds, quizTargets: originalQuiz.quizTargets })
  expect(replacing.cards).toEqual(original.cards); expect(replacing.events).toEqual(original.events); expect(replacing.exercises).toEqual([])
  controls.failReview = false
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await panel.getByRole('button', { name: 'Review saved quiz', exact: true }).click()
  await expect(panel).toContainText('ready to use')
  await page.getByRole('button', { name: 'End session', exact: true }).click()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const buffer = await download(page)
  expect(calls.filter(c => c === 'native-quiz')).toHaveLength(2)
  const fresh = await browser.newContext({ storageState: returningVisitor, viewport: { width: 390, height: 844 } }), restored = await fresh.newPage(), external: string[] = []
  restored.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173')) external.push(r.url()) })
  await ready(restored); await restored.clock.setFixedTime(NOW + DAY)
  await openTool(restored, 'Backup & restore')
  await restored.getByLabel('Choose backup file').setInputFiles({ name: 'quiz-recovery.json', mimeType: 'application/json', buffer })
  await restored.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
  await restored.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await expect(restored.getByText('Workspace restored.', { exact: false })).toBeVisible()
  await restored.getByRole('button', { name: 'Close dialog' }).click()
  await restored.getByRole('button', { name: 'Daily review', exact: true }).click()
  await restored.getByRole('dialog').getByRole('button', { name: 'Start practice', exact: true }).click()
  await restored.getByRole('region', { name: 'Saved quiz work' }).scrollIntoViewIfNeeded()
  await restored.screenshot({ path: 'test-results/quiz-recovery-mobile.png', fullPage: true })
  await restored.getByRole('button', { name: 'Use reviewed quiz', exact: true }).click()
  await expect(restored.getByRole('region', { name: 'Saved exercise' })).toContainText('A friend helped you')
  await expect(restored.getByRole('region', { name: 'Saved quiz work' })).toHaveCount(0)
  await restored.getByRole('radio', { name: /谢谢/ }).check()
  await restored.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(restored.getByRole('dialog').getByText('Correct', { exact: true })).toBeVisible()
  await restored.getByRole('button', { name: 'Close dialog' }).click()
  const finished = JSON.parse((await download(restored)).toString()).data
  expect(finished.cards[0]).toMatchObject({ box: 2, dueAt: NOW + 4 * DAY })
  expect(finished.events.filter((e: { kind: string }) => e.kind === 'review')).toHaveLength(1)
  expect(finished.drafts.filter((d: { kind: string }) => d.kind === 'quiz')).toHaveLength(2)
  expect(external).toEqual([]); expect(await restored.evaluate(() => localStorage.getItem('vl-settings-v2'))).toBeNull()
  await fresh.close()
})

test('confirmed quiz discard archives only unused candidate data without a model call or review credit', async ({ page }) => {
  await ready(page); await configure(page)
  const { calls, controls } = await fixture(page); controls.failReview = true
  await captureAndIntroduce(page, true, false)
  const panel = page.getByRole('region', { name: 'Saved quiz work' })
  await expect(panel).toBeVisible(); await expect(page.getByRole('alert')).toBeVisible()
  const count = calls.length
  await panel.getByRole('button', { name: 'Discard candidate', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Confirm quiz discard' })).toContainText('remain in backups')
  await panel.getByRole('button', { name: 'Confirm discard', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Candidate archived' })).toBeVisible()
  expect(calls).toHaveLength(count)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const state = JSON.parse((await download(page)).toString()).data
  expect(state.cards[0]).toMatchObject({ box: 1, revision: 1, dueAt: NOW + DAY })
  expect(state.events.filter((e: { kind: string }) => e.kind === 'review')).toHaveLength(0)
  expect(state.exercises).toHaveLength(0)
  expect(state.drafts.find((d: { kind: string }) => d.kind === 'quiz')).toMatchObject({ discardedAt: NOW + DAY, status: 'pending' })
})

test('production teacher persists interrupted grading and applies one aided review across pause/reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await ready(page); await configure(page)
  const { calls, controls } = await fixture(page)
  await captureAndIntroduce(page)
  const lesson = page.getByRole('dialog', { name: 'Daily review' })
  await expect(page.getByRole('region', { name: 'Worked Mandarin example' })).toHaveCount(0)
  await expect(lesson).not.toContainText('Use 谢谢 to thank someone naturally.')
  await expect(page.locator('.svelte-flow__node-chunk')).not.toContainText('谢谢')
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveCount(0)
  await page.getByLabel('Your answer', { exact: true }).fill('谢谢')
  controls.failGrade = true
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry assessment' })).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const saved = JSON.parse((await download(page)).toString())
  expect(saved.data.cards[0]).toMatchObject({ box: 1, dueAt: NOW + DAY, revision: 1 })
  expect(saved.data.attempts[0]).toMatchObject({ answer: '谢谢', status: 'needsReview' })
  expect(saved.data.nodes.find((n: { id: string }) => n.id === saved.data.items[0].sourceNodeIds[0])).toMatchObject({ type: 'assistant', data: { text: '谢谢 means thank you. Use it to thank someone.' } })
  const count = calls.length
  await page.reload()
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await expect(page.getByLabel('Your answer', { exact: true })).toHaveValue('谢谢')
  // Resume is the sole primary action while paused; retry is offered afterwards.
  await expect(page.getByRole('button', { name: 'Retry assessment' })).toHaveCount(0)
  expect(calls).toHaveLength(count)
  await page.getByRole('dialog').getByRole('button', { name: 'Resume practice' }).click()
  await expect(page.getByRole('button', { name: 'Retry assessment' })).toBeEnabled()
  await page.getByRole('button', { name: 'Hint', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm help', exact: true }).click()
  await expect(lesson.getByText('Expected answer', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Reveal answer', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm help', exact: true }).click()
  await expect(lesson.getByText('Expected answer', { exact: true })).toBeVisible()
  controls.failGrade = false
  await page.getByRole('button', { name: 'Retry assessment' }).click()
  await expect(lesson.getByText('Correct', { exact: true })).toBeVisible()
  await expect(page.getByTestId('teacher-portrait').locator('img')).toHaveAttribute('data-pose', 'encouraging')
  const worked = lesson.getByRole('region', { name: 'Worked Mandarin example' })
  await expect(worked).toContainText(THANKS_EXAMPLE.hanzi)
  await expect(worked).toContainText(THANKS_EXAMPLE.meaning)
  await expect(worked).toContainText('saved with this assessment')
  await expect(worked.locator('.pinyin-control')).toBeVisible()
  await expect(worked).toContainText('xiè')
  await worked.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/teacher-feedback.png', fullPage: true })
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const finished = JSON.parse((await download(page)).toString())
  expect(finished.data.cards[0]).toMatchObject({ box: 1, dueAt: NOW + 2 * DAY, revision: 2 })
  expect(finished.data.events.filter((e: { kind: string }) => e.kind === 'review')).toHaveLength(1)
  expect(finished.data.attempts[0]).toMatchObject({ status: 'committed', helpUsed: true })
  expect(finished.data.attempts[0].assessment.workedExample).toMatchObject(THANKS_EXAMPLE)
  expect(errors).toEqual([])
})

test('legacy feedback repair is explicit, cancellable, separately saved and readable after a keyless restore', async ({ page, browser }) => {
  await ready(page); await configure(page)
  const { calls, controls } = await fixture(page)
  await captureAndIntroduce(page)
  await page.getByLabel('Your answer', { exact: true }).fill('你好')
  await page.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('Let’s work on this', { exact: true })).toBeVisible()
  await expect(page.getByTestId('teacher-portrait').locator('img')).toHaveAttribute('data-pose', 'gentleCorrection')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const legacy = JSON.parse((await download(page)).toString())
  delete legacy.data.exercises[0].workedExample
  delete legacy.data.attempts[0].assessment.workedExample
  legacy.data.attempts[0].assessment.correctedExample = THANKS_EXAMPLE.hanzi
  async function restore(target: Page, buffer: Buffer) {
    await openTool(target, 'Backup & restore')
    await target.getByLabel('Choose backup file').setInputFiles({ name: 'saved-feedback.json', mimeType: 'application/json', buffer })
    await target.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
    await target.getByRole('button', { name: 'Replace workspace', exact: true }).click()
    await expect(target.getByText('Workspace restored.', { exact: false })).toBeVisible()
    await target.getByRole('button', { name: 'Close dialog' }).click()
  }
  async function openHistory(target: Page) {
    await target.getByRole('button', { name: 'Daily review', exact: true }).click()
    await target.getByRole('button', { name: 'Browse saved review history', exact: true }).click()
    await expect(target.getByRole('dialog', { name: 'Saved review history' })).toBeVisible()
  }
  await restore(page, Buffer.from(JSON.stringify(legacy)))
  const before = JSON.parse((await download(page)).toString()).data
  const originalCalls = calls.length
  await openHistory(page)
  await expect(page.getByRole('region', { name: 'Worked Mandarin example' })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toContainText('No paired example was saved')
  expect(calls).toHaveLength(originalCalls)
  controls.delayExample = true
  await page.getByRole('button', { name: 'Prepare worked example for this result', exact: true }).click()
  await expect.poll(() => Boolean(controls.releaseExample)).toBe(true)
  await page.getByRole('button', { name: 'Cancel example request', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('No automatic retry')
  controls.releaseExample!(); controls.delayExample = false
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const cancelled = JSON.parse((await download(page)).toString()).data
  expect(cancelled.cards).toEqual(before.cards); expect(cancelled.attempts).toEqual(before.attempts); expect(cancelled.events).toEqual(before.events)
  expect(cancelled.drafts.filter((d: { kind: string }) => d.kind === 'feedback')).toHaveLength(0)
  await openHistory(page)
  await page.getByRole('button', { name: 'Prepare worked example for this result', exact: true }).click()
  const worked = page.getByRole('region', { name: 'Worked Mandarin example' })
  await expect(worked).toContainText(THANKS_EXAMPLE.meaning)
  await expect(worked).toContainText('original grade is unchanged')
  await expect(page.getByRole('dialog')).toContainText('Original assessment: incorrect')
  await worked.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/worked-example-history.png', fullPage: true })
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const buffer = await download(page), saved = JSON.parse(buffer.toString()).data
  expect(saved.cards).toEqual(before.cards); expect(saved.attempts).toEqual(before.attempts); expect(saved.events).toEqual(before.events)
  expect(saved.drafts.filter((d: { kind: string }) => d.kind === 'feedback')).toHaveLength(1)
  expect(calls.filter(c => c === 'worked-example')).toHaveLength(2)
  const fresh = await browser.newContext({ storageState: returningVisitor }), restored = await fresh.newPage(), external: string[] = []
  restored.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173')) external.push(r.url()) })
  await ready(restored); await restored.clock.setFixedTime(NOW + DAY)
  await restore(restored, buffer); await openHistory(restored)
  await expect(restored.getByRole('region', { name: 'Worked Mandarin example' })).toContainText(THANKS_EXAMPLE.meaning)
  await expect(restored.getByRole('button', { name: 'Prepare worked example for this result', exact: true })).toHaveCount(0)
  await restored.getByRole('button', { name: 'Close dialog' }).click()
  await restored.setViewportSize({ width: 390, height: 844 })
  await restored.getByRole('button', { name: 'Search', exact: true }).click()
  await restored.getByRole('combobox', { name: 'Type', exact: true }).selectOption('feedback')
  for (const query of ['for your help', '你的帮助', 'bang zhu']) {
    await restored.getByLabel('Search query').fill(query)
    await expect(restored.getByRole('article')).toHaveCount(1)
    await expect(restored.getByRole('article')).toContainText(THANKS_EXAMPLE.meaning)
    await expect(restored.getByRole('article').getByRole('button', { name: 'Practice this', exact: true })).toBeVisible()
  }
  await restored.screenshot({ path: 'test-results/worked-example-search-mobile.png', fullPage: true })
  expect(external).toEqual([])
  expect(await restored.evaluate(() => localStorage.getItem('vl-settings-v2'))).toBeNull()
  await fresh.close()
})

test('native quiz survives a fresh-profile backup restore and scores without a key or network', async ({ page, browser }) => {
  await ready(page); await configure(page)
  const { calls } = await fixture(page)
  await captureAndIntroduce(page, true)
  await expect(page.getByRole('region', { name: 'Worked Mandarin example' })).toHaveCount(0)
  await page.getByRole('radio', { name: /谢谢/ }).check()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const buffer = await download(page), saved = JSON.parse(buffer.toString())
  expect(calls).toEqual(['conversation', 'introduction', 'native-quiz', 'content-review'])
  expect(saved.data.exercises[0].multipleChoice.options).toHaveLength(4)
  expect(saved.data.drafts.find((d: { kind: string }) => d.kind === 'answer').selectedOptionId).toBe('thanks')
  const fresh = await browser.newContext({ storageState: returningVisitor, viewport: { width: 390, height: 844 } }), restored = await fresh.newPage()
  const requests: string[] = [], errors: string[] = []
  restored.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173')) requests.push(r.url()) })
  restored.on('pageerror', e => errors.push(e.message))
  await ready(restored); await restored.clock.setFixedTime(NOW + DAY)
  await openTool(restored, 'Backup & restore')
  await restored.getByLabel('Choose backup file').setInputFiles({ name: 'quiz.json', mimeType: 'application/json', buffer })
  await restored.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
  await restored.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await expect(restored.getByText('Workspace restored.', { exact: false })).toBeVisible()
  await restored.getByRole('button', { name: 'Close dialog' }).click()
  await restored.getByRole('button', { name: 'Daily review', exact: true }).click()
  await expect(restored.getByRole('radio', { name: /谢谢/ })).toBeChecked()
  await expect(restored.getByRole('region', { name: 'Worked Mandarin example' })).toHaveCount(0)
  await restored.getByRole('dialog').getByRole('button', { name: 'Resume practice' }).click()
  await restored.screenshot({ path: 'test-results/teacher-quiz-mobile.png', fullPage: true })
  await restored.getByRole('button', { name: 'Submit answer', exact: true }).click()
  await expect(restored.getByRole('dialog').getByText('Correct', { exact: true })).toBeVisible()
  await expect(restored.getByRole('region', { name: 'Worked Mandarin example' })).toContainText(THANKS_EXAMPLE.meaning)
  await expect(restored.getByRole('region', { name: 'Worked Mandarin example' })).toContainText('frozen with this question')
  await restored.getByRole('region', { name: 'Worked Mandarin example' }).scrollIntoViewIfNeeded()
  await restored.screenshot({ path: 'test-results/worked-example-mobile.png', fullPage: true })
  await restored.getByRole('button', { name: 'Close dialog' }).click()
  const finished = JSON.parse((await download(restored)).toString())
  expect(finished.data.cards[0]).toMatchObject({ skill: 'recognition', box: 2, dueAt: NOW + 4 * DAY })
  expect(finished.data.exercises[0].multipleChoice.options).toEqual(saved.data.exercises[0].multipleChoice.options)
  expect(finished.data.events.filter((e: { kind: string }) => e.kind === 'review')).toHaveLength(1)
  await restored.getByRole('button', { name: 'Search', exact: true }).click()
  await restored.getByRole('combobox', { name: 'Type', exact: true }).selectOption('feedback')
  await restored.getByLabel('Search query').fill('for your help')
  await expect(restored.getByRole('article')).toHaveCount(1)
  await expect(restored.getByRole('article')).toContainText(THANKS_EXAMPLE.meaning)
  expect(await restored.evaluate(() => localStorage.getItem('vl-settings-v2'))).toBeNull()
  expect(requests).toEqual([]); expect(errors).toEqual([])
  await fresh.close()
})
