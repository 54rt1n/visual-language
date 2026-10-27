import { openTool } from './navigation'
import { expect, test, type Page } from '@playwright/test'

const reply = '我想喝咖啡，谢谢。银行行长喜欢音乐。'
async function setup(page: Page, source = reply) {
  const requests: Record<string, unknown>[] = []
  await page.route('https://reading-fixture.example/v1/chat/completions', async route => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: responseBody(source) })
  })
  await page.goto('/'); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://reading-fixture.example/v1')
  await page.getByLabel('Model ID', { exact: true }).fill('reading-fixture')
  await page.getByLabel('Custom endpoint API key').fill('synthetic-reading-key')
  await page.getByRole('button', { name: 'Save connection' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Explain a useful sentence.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.word-text .word').first()).toBeVisible()
  await page.locator('.assistant .configuration > summary').click()
  return requests
}
async function backup(page: Page) {
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full backup' }).click()
  const file = await pending, stream = await file.createReadStream(), buffers: Buffer[] = []
  for await (const chunk of stream!) buffers.push(Buffer.from(chunk))
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return JSON.parse(Buffer.concat(buffers).toString())
}

async function addWord(page: Page) {
  await page.getByRole('button', { name: 'Explore 咖啡', exact: true }).click()
  await page.getByRole('region', { name: 'Word details' }).getByRole('button', { name: 'Pin on canvas', exact: true }).click()
  const word = page.locator('.learning-word')
  await expect(word).toBeVisible()
  return word
}
const responseBody = (text: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`
async function speechFixture(page: Page, hold = false) {
  await page.addInitScript(hold => {
    const utterances: string[] = []; Object.assign(window, { wordAudioFixture: utterances })
    const control = { cancellations: 0 }
    Object.assign(window, { wordAudioControl: control })
    class Speech extends EventTarget {
      getVoices() { return [{ name: 'Mandarin', lang: 'zh-CN', localService: true, default: true, voiceURI: 'fixture' }] }
      cancel() { control.cancellations++ }
      speak(utterance: SpeechSynthesisUtterance) { utterances.push(utterance.text); if (!hold) setTimeout(() => utterance.onend?.(new Event('end') as SpeechSynthesisEvent), 20) }
    }
    class Utterance { constructor(public text: string) {} }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: new Speech() })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: Utterance })
  }, hold)
}

test('simple word card uses automatic audio and replay, remains keyboard accessible on mobile, and makes no model request', async ({ page }) => {
  await speechFixture(page)
  const requests = await setup(page)
  const before = await backup(page)
  await page.setViewportSize({ width: 320, height: 568 })
  await page.getByRole('button', { name: 'Explore 咖啡', exact: true }).focus(); await page.keyboard.press('Enter')
  const card = page.getByRole('region', { name: 'Word details' })
  await expect(card.getByRole('heading')).toHaveText('咖啡')
  await expect(card.locator('.pronunciation')).toHaveText('kā fēi')
  await expect(card.getByRole('button', { name: 'Save for practice', exact: true })).toBeInViewport({ ratio: 1 })
  await expect.poll(() => page.evaluate(() => (window as unknown as { wordAudioFixture: string[] }).wordAudioFixture)).toEqual(['咖啡'])
  await card.getByRole('button', { name: 'Play Mandarin audio', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { wordAudioFixture: string[] }).wordAudioFixture)).toEqual(['咖啡', '咖啡'])
  await expect(card.getByRole('button', { name: 'Pin on canvas', exact: true })).toBeInViewport({ ratio: 1 })
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/word-card-320.png' })
  await card.getByRole('button', { name: 'Close word details' }).focus(); await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  const after = await backup(page)
  for (const field of ['nodes', 'edges', 'items', 'cards', 'events', 'drafts']) expect(after.data[field]).toEqual(before.data[field])
  expect(requests).toHaveLength(1)
})

test('hover exploration is optional, keeps focus and audio quiet, and persists across keyless reloads', async ({ page }) => {
  await speechFixture(page)
  const requests = await setup(page)
  const toggle = page.getByRole('checkbox', { name: 'Hover to explore', exact: true })
  const coffee = page.getByRole('button', { name: 'Explore 咖啡', exact: true })
  const card = page.getByRole('region', { name: 'Word details' })
  await expect(toggle).not.toBeChecked()
  await coffee.hover()
  await expect(card).toHaveCount(0)
  await toggle.check()
  await expect(toggle).toBeEnabled()
  const composer = page.getByRole('textbox', { name: 'Message to Zheng' })
  await composer.focus()
  await coffee.hover()
  await expect(card.getByRole('heading')).toHaveText('咖啡')
  await expect(card).toContainText('coffee')
  await expect(composer).toBeFocused()
  await page.getByRole('button', { name: 'Explore 谢谢', exact: true }).hover()
  await expect(card.getByRole('heading')).toHaveText('谢谢')
  await card.hover()
  await expect(card.getByRole('button', { name: 'Pin on canvas', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { wordAudioFixture: string[] }).wordAudioFixture)).toEqual([])
  await card.getByRole('button', { name: 'Close word details' }).click()
  await page.evaluate(() => localStorage.removeItem('vl-settings-v2'))
  await page.reload()
  await expect(toggle).toBeChecked()
  await coffee.dispatchEvent('pointerenter', { pointerType: 'touch' })
  await expect(card).toHaveCount(0)
  await coffee.hover()
  await expect(card.getByRole('heading')).toHaveText('咖啡')
  await card.getByRole('button', { name: 'Close word details' }).click()
  await toggle.uncheck()
  await expect(toggle).toBeEnabled()
  await coffee.hover()
  await expect(card).toHaveCount(0)
  await coffee.focus(); await page.keyboard.press('Enter')
  await expect(card.getByRole('heading')).toHaveText('咖啡')
  await card.getByRole('button', { name: 'Close word details' }).click()
  const saved = (await backup(page)).data
  expect(saved.view.hoverToExplore).toBe(false)
  for (const field of ['items', 'cards', 'events', 'drafts']) expect(saved[field]).toHaveLength(0)
  expect(requests).toHaveLength(1)
  await page.setViewportSize({ width: 320, height: 568 })
  await expect(toggle).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: 'test-results/hover-explore-320.png' })
})

test('hovering another word or reply preserves ongoing playback until an explicit audio action', async ({ page }) => {
  await speechFixture(page, true)
  const requests = await setup(page)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Another tea example.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.assistant')).toHaveCount(2)
  const toggle = page.getByRole('checkbox', { name: 'Hover to explore', exact: true })
  await toggle.check(); await expect(toggle).toBeEnabled()
  const first = page.locator('.assistant').first(), second = page.locator('.assistant').last()
  await page.getByRole('button', { name: 'Fit View', exact: true }).click()
  await expect(first.getByRole('button', { name: 'Explore 咖啡', exact: true })).toBeInViewport()
  await first.getByRole('button', { name: 'Explore 咖啡', exact: true }).click()
  const card = page.getByRole('region', { name: 'Word details' })
  await expect(card.getByRole('button', { name: 'Stop audio', exact: true })).toBeVisible()
  const cancellations = () => page.evaluate(() => (window as unknown as { wordAudioControl: { cancellations: number } }).wordAudioControl.cancellations)
  const before = await cancellations()
  await first.getByRole('button', { name: 'Explore 谢谢', exact: true }).hover()
  await expect(card.getByRole('heading')).toHaveText('谢谢')
  await expect(card.getByRole('button', { name: 'Stop audio', exact: true })).toBeVisible()
  expect(await cancellations()).toBe(before)
  await second.getByRole('button', { name: 'Explore 谢谢', exact: true }).hover()
  await expect(second.getByRole('button', { name: 'Explore 谢谢', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(await cancellations()).toBe(before)
  expect(await page.evaluate(() => (window as unknown as { wordAudioFixture: string[] }).wordAudioFixture)).toEqual(['咖啡'])
  await card.getByRole('button', { name: 'Play Mandarin audio', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Stop audio', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { wordAudioFixture: string[] }).wordAudioFixture)).toEqual(['咖啡', '谢谢'])
  expect(await cancellations()).toBeGreaterThan(before)
  const playing = await cancellations()
  await card.getByRole('button', { name: 'Stop audio', exact: true }).click()
  await expect(card.getByRole('button', { name: 'Play Mandarin audio', exact: true })).toBeVisible()
  expect(await cancellations()).toBe(playing + 1)
  await card.getByRole('button', { name: 'Close word details', exact: true }).click()
  await second.getByRole('button', { name: 'Read response', exact: true }).click()
  const reader = page.getByRole('region', { name: 'Response reader', exact: true })
  await reader.getByRole('button', { name: 'Play full response', exact: true }).click()
  await expect(reader.getByRole('button', { name: 'Stop full response', exact: true })).toBeVisible()
  const fullPlayback = await cancellations()
  await reader.getByRole('button', { name: 'Explore 咖啡', exact: true }).hover()
  await expect(reader.getByRole('region', { name: 'Selected word definition', exact: true })).toContainText('咖啡')
  await reader.getByRole('button', { name: 'Explore 谢谢', exact: true }).hover()
  await expect(reader.getByRole('region', { name: 'Selected word definition', exact: true })).toContainText('谢谢')
  await expect(reader.getByRole('button', { name: 'Stop full response', exact: true })).toBeVisible()
  expect(await cancellations()).toBe(fullPlayback)
  await reader.getByRole('button', { name: 'Stop full response', exact: true }).click()
  expect(await cancellations()).toBe(fullPlayback + 1)
  expect(requests).toHaveLength(2)
})

test('dropping a word creates a durable keyless node with audio and pinyin without enrolling it', async ({ page }) => {
  await speechFixture(page)
  const requests = await setup(page)
  await page.evaluate(() => localStorage.removeItem('vl-settings-v2')); await page.reload()
  const word = await addWord(page)
  await expect(word.locator('.body')).toHaveText('咖啡')
  await expect(word.locator('.pinyin')).toHaveText('kā fēi')
  await word.getByRole('button', { name: 'Hide pinyin', exact: true }).click(); await expect(word.locator('.pinyin')).toHaveCount(0)
  await word.getByRole('button', { name: 'Show pinyin', exact: true }).click()
  await word.getByRole('button', { name: 'Play Mandarin audio', exact: true }).click()
  await expect(word.getByRole('button', { name: 'Explain', exact: true })).toBeVisible()
  await expect(word.getByRole('button', { name: 'Save for practice', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/learning-word-desktop.png' })
  const saved = await backup(page), node = saved.data.nodes.find((n: { type: string }) => n.type === 'chunk')
  expect(node.data.wordSource).toMatchObject({ start: 3, end: 5, context: '我想喝咖啡，谢谢。' })
  for (const field of ['cards', 'items', 'events', 'drafts']) expect(saved.data[field]).toHaveLength(0)
  await page.reload(); await expect(word.locator('.body')).toHaveText('咖啡')
  await addWord(page); await expect(word).toHaveCount(1)
  expect(requests).toHaveLength(1)
})

test('Explain survives outside clicks, saves its connected response, and reloads without another request', async ({ page }) => {
  const requests = await setup(page), word = await addWord(page)
  let release!: () => void, started = false
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('https://reading-fixture.example/v1/chat/completions', async route => {
    started = true; requests.push(route.request().postDataJSON()); await pending
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: responseBody('咖啡 means coffee here. 喝咖啡 means to drink coffee.') }).catch(() => {})
  })
  try {
    await word.getByRole('button', { name: 'Explain', exact: true }).click()
    const result = page.locator('.explanation')
    await expect.poll(() => started).toBe(true)
    await expect(result).toContainText('Zheng is explaining…')
    await page.locator('.svelte-flow__pane').click({ position: { x: 1100, y: 350 } })
    await expect(result.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    release()
    await expect(result.getByRole('region', { name: 'Word explanation' })).toHaveText('咖啡 means coffee here. 喝咖啡 means to drink coffee.')
    await expect(result.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
    const saved = await backup(page), node = saved.data.nodes.find((n: { type: string }) => n.type === 'explanation')
    expect(node.data.state).toBe('complete')
    expect(saved.data.edges).toContainEqual(expect.objectContaining({ source: node.data.wordNodeId, target: node.id, data: { kind: 'derived' } }))
    for (const field of ['cards', 'items', 'events', 'drafts']) expect(saved.data[field]).toHaveLength(0)
    expect(JSON.stringify(saved)).not.toContain('synthetic-reading-key')
    expect(JSON.stringify(requests[1])).toContain('startInContext')
    await page.evaluate(() => localStorage.removeItem('vl-settings-v2')); await page.reload()
    await expect(result).toContainText('咖啡 means coffee here.')
    expect(requests).toHaveLength(2)
    await page.screenshot({ path: 'test-results/word-explanation-desktop.png' })
  } finally { release() }
})

test('a failed explanation stays on the graph with Retry and preserves the original attempt', async ({ page }) => {
  await setup(page); const word = await addWord(page)
  let count = 0
  await page.route('https://reading-fixture.example/v1/chat/completions', route => {
    count++
    return count === 1 ? route.fulfill({ status: 503, body: 'temporarily unavailable' }) : route.fulfill({ status: 200, contentType: 'text/event-stream', body: responseBody('咖啡 means coffee.') })
  })
  await word.getByRole('button', { name: 'Explain', exact: true }).click()
  await expect(page.locator('.explanation').getByRole('alert')).toBeVisible()
  await page.locator('.explanation').getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.locator('.explanation')).toHaveCount(2)
  await expect(page.locator('.explanation').last()).toContainText('咖啡 means coffee.')
  const saved = await backup(page)
  expect(saved.data.nodes.filter((n: { type: string }) => n.type === 'explanation').map((n: { data: { state: string } }) => n.data.state)).toEqual(['error', 'complete'])
})

test('Stop interrupts only the explanation and reload does not restart it', async ({ page }) => {
  await setup(page); const word = await addWord(page)
  let release!: () => void, started = false
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('https://reading-fixture.example/v1/chat/completions', async route => { started = true; await pending; await route.fulfill({ status: 200, contentType: 'text/event-stream', body: responseBody('late response') }).catch(() => {}) })
  try {
    await word.getByRole('button', { name: 'Explain', exact: true }).click(); await expect.poll(() => started).toBe(true)
    const result = page.locator('.explanation')
    await result.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(result.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    release()
    await page.reload(); await expect(result.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    const saved = await backup(page)
    expect(saved.data.nodes.find((n: { type: string }) => n.type === 'explanation').data).toMatchObject({ state: 'interrupted', text: '' })
  } finally { release() }
})

test('Save for practice reviews the meaning and enrolls the existing node only after saving', async ({ page }) => {
  const requests = await setup(page), word = await addWord(page)
  await word.getByRole('button', { name: 'Save for practice', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Save for practice', exact: true })
  await expect(dialog.getByLabel('Mandarin word or phrase')).toHaveValue('咖啡')
  await expect(dialog.locator('.pinyin')).toHaveText('kā fēi')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  const before = await backup(page); expect(before.data.items).toHaveLength(0)
  await word.getByRole('button', { name: 'Save for practice', exact: true }).click()
  await dialog.getByLabel('Meaning in this context').fill('coffee')
  await dialog.getByRole('button', { name: 'Save for practice', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(word.getByRole('button', { name: 'Practice this phrase', exact: true })).toBeVisible()
  const after = await backup(page)
  expect(after.data.nodes).toHaveLength(before.data.nodes.length)
  expect(after.data.items).toHaveLength(1); expect(after.data.cards).toHaveLength(1)
  expect(after.data.cards[0]).toMatchObject({ status: 'new', box: 1 })
  expect(after.data.events.filter((e: { kind: string }) => e.kind === 'review')).toHaveLength(0)
  expect(requests).toHaveLength(1)
})

test('a stalled explanation times out visibly instead of thinking forever', async ({ page }) => {
  await page.addInitScript(() => {
    const schedule = window.setTimeout.bind(window)
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => schedule(handler, delay === 60_000 ? 300 : delay, ...args)) as typeof window.setTimeout
  })
  await setup(page); const word = await addWord(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('https://reading-fixture.example/v1/chat/completions', async route => { await pending; await route.abort().catch(() => {}) })
  try {
    await word.getByRole('button', { name: 'Explain', exact: true }).click()
    await expect(page.locator('.explanation').getByRole('alert')).toContainText('timed out')
    await expect(page.locator('.explanation').getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
    const saved = await backup(page)
    expect(saved.data.nodes.find((n: { type: string }) => n.type === 'explanation').data.state).toBe('error')
  } finally { release() }
})
