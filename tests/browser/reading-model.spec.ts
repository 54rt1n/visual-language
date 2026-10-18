import { openTool } from './navigation'
import { expect, test, type Page } from '@playwright/test'
test.use({ actionTimeout: 10_000 })

const source = '我还没有还书。他跑得很快。我慢慢地走回家。银行行长在银行工作。'
async function backup(page: Page) {
  await openTool(page, 'Backup & restore')
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full backup' }).click()
  const download = await downloading, stream = await download.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  return JSON.parse(Buffer.concat(chunks).toString()).data
}
async function setup(page: Page) {
  const external: string[] = [], assets: string[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (request.url().includes('/reading-model/')) assets.push(request.url()) })
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === 'http://127.0.0.1:4173') return route.continue()
    if (url.origin === 'https://pronunciation-fixture.example') {
      const frame = { choices: [{ index: 0, delta: { content: source }, finish_reason: null }] }
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(frame)}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n` })
    }
    external.push(url.origin); return route.abort()
  })
  await page.goto('/'); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://pronunciation-fixture.example/v1')
  await page.getByLabel('Model ID', { exact: true }).fill('synthetic-pronunciation-fixture')
  await page.getByLabel('Custom endpoint API key').fill('synthetic-key')
  await page.getByRole('button', { name: 'Save connection' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Show me useful Mandarin.')
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Show me useful Mandarin.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Explore 还书', exact: true })).toBeVisible()
  return { external, assets, errors }
}
async function openPinyinAccuracy(page: Page) {
  await openTool(page, 'Audio & pinyin settings')
  const dialog = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  return { dialog, section: dialog.getByRole('region', { name: 'Pinyin accuracy', exact: true }) }
}

test('actual optional model corrects the source occurrence, survives offline reload, and removes without touching learning state', async ({ page, context }) => {
  test.setTimeout(120_000)
  const observed = await setup(page)
  expect(observed.assets).toEqual([])
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Keep my next question.')
  const initial = await page.evaluate(() => localStorage.getItem('vl-settings-v2')), before = await backup(page)
  let { dialog, section } = await openPinyinAccuracy(page)
  await section.getByRole('button', { name: 'Download context-aware pinyin · 81.2 MB', exact: true }).click()
  await expect(section.getByRole('button', { name: 'Remove pinyin accuracy data' })).toBeVisible({ timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Explore 还书', exact: true }).click()
  const details = page.getByRole('region', { name: 'Word details' })
  await expect(details.locator('.pronunciation')).toHaveText('huán shū', { timeout: 30_000 })
  await details.getByRole('button', { name: 'Close word details' }).click()
  await page.locator('.assistant .configuration > summary').click()
  await expect(page.getByRole('button', { name: 'Explore 还书', exact: true }).locator('rt')).toHaveText('huán shū', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Explore 跑得', exact: true }).locator('rt')).toHaveText('pǎo de', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Explore 慢慢地', exact: true }).locator('rt')).toHaveText('màn màn de', { timeout: 30_000 })
  await page.screenshot({ path: 'test-results/local-pronunciation-reader-desktop.png' })
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload(); await expect(page.locator('.word-text .word').first()).toBeVisible()
  await context.setOffline(true); await page.reload()
  await page.getByRole('button', { name: 'Explore 还书', exact: true }).click()
  await expect(details.locator('.pronunciation')).toHaveText('huán shū', { timeout: 30_000 })
  await details.getByRole('button', { name: 'Close word details' }).click()
  ;({ dialog, section } = await openPinyinAccuracy(page)); await section.getByRole('button', { name: 'Remove pinyin accuracy data' }).click()
  await expect(section.getByRole('button', { name: 'Download context-aware pinyin · 81.2 MB', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  expect(await page.evaluate(() => caches.keys())).not.toEqual(expect.arrayContaining([expect.stringMatching(/^vl-pronunciation-/)]))
  expect(await page.evaluate(() => localStorage.getItem('vl-settings-v2'))).toBe(initial)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep my next question.')
  const after = await backup(page)
  for (const field of ['nodes', 'edges', 'items', 'cards', 'events', 'attempts', 'sessions', 'exercises', 'drafts']) expect(after[field]).toEqual(before[field])
  await page.getByRole('button', { name: 'Explore 还书', exact: true }).click()
  await expect(details.locator('.pronunciation')).toHaveText('hái shū')
  expect(observed.external).toEqual([]); expect(observed.errors).toEqual([])
})

test('a corrupt optional pack fails visibly; basic reading and explicit retry remain available', async ({ page }) => {
  const observed = await setup(page)
  await page.route('**/reading-model/**/model.onnx', route => route.fulfill({ status: 200, body: 'corrupt model' }))
  const { dialog, section } = await openPinyinAccuracy(page)
  await section.getByRole('button', { name: 'Download context-aware pinyin · 81.2 MB', exact: true }).click()
  await expect(section.getByRole('status')).toContainText('could not be used')
  await expect(section.getByRole('button', { name: 'Retry pinyin accuracy download' })).toBeVisible()
  await section.getByText('Accuracy, privacy and troubleshooting').click(); await expect(section).toContainText('integrity check')
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Explore 还书', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Word details' }).locator('.pronunciation')).toHaveText('hái shū')
  expect(observed.errors).toEqual([])
})

test('download cancellation leaves reading usable and a late response cannot enable the pack', async ({ page }) => {
  const observed = await setup(page)
  let release!: () => void, started!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), requested = new Promise<void>(resolve => { started = resolve })
  await page.route('**/reading-model/**/model.onnx', async route => { started(); await waiting; await route.fulfill({ status: 200, body: 'late cancelled response' }).catch(() => {}) })
  const { dialog, section } = await openPinyinAccuracy(page)
  await section.getByRole('button', { name: 'Download context-aware pinyin · 81.2 MB', exact: true }).click(); await requested
  await section.getByRole('button', { name: 'Cancel download' }).click(); release()
  await expect(section.getByRole('button', { name: 'Download context-aware pinyin · 81.2 MB', exact: true })).toBeVisible()
  await expect(section.getByRole('button', { name: 'Remove pinyin accuracy data' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Explore 还书', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Word details' }).locator('.pronunciation')).toHaveText('hái shū')
  expect(observed.errors).toEqual([])
})

test('short-screen pinyin accuracy settings stay out of the word explorer and keep actions reachable', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(HTMLElement.prototype, 'showPopover', { value: undefined, configurable: true }) })
  await page.setViewportSize({ width: 320, height: 568 })
  await setup(page)
  const reader = page.locator('.assistant .reader'), word = reader.getByRole('button', { name: 'Explore 还书', exact: true })
  const before = await word.boundingBox()
  await expect(reader.getByRole('button', { name: /pinyin accuracy|context-aware|Improve pinyin/i })).toHaveCount(0)
  const { dialog, section } = await openPinyinAccuracy(page)
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeInViewport({ ratio: 1 })
  expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  const download = section.getByRole('button', { name: 'Download context-aware pinyin · 81.2 MB', exact: true })
  await download.scrollIntoViewIfNeeded(); await expect(download).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: 'test-results/local-pronunciation-settings-320.png' })
  await dialog.getByRole('button', { name: 'Close dialog' }).click()
  expect(await word.boundingBox()).toEqual(before)
  await word.click(); await expect(page.getByRole('region', { name: 'Word details' })).toBeVisible()
})

test('refusing the optional worker cannot prevent word splitting or dictionary meanings', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker
    window.Worker = new Proxy(NativeWorker, { construct(target, args) {
      if (String(args[0]).includes('readingModel.worker')) throw new DOMException('Optional worker blocked by browser policy', 'SecurityError')
      return Reflect.construct(target, args)
    } })
  })
  const observed = await setup(page)
  await page.getByRole('button', { name: 'Explore 还书', exact: true }).click()
  const details = page.getByRole('region', { name: 'Word details' })
  await expect(details.locator('.pronunciation')).toHaveText('hái shū')
  await details.getByRole('button', { name: 'Close word details' }).click()
  await page.getByRole('button', { name: 'Read response', exact: true }).click()
  const reader = page.getByRole('region', { name: 'Response reader' })
  await reader.getByRole('button', { name: 'Play 还书', exact: true }).click()
  await expect(reader.getByRole('region', { name: 'Selected word definition' })).toContainText('return books')
  expect(observed.assets).toEqual([]); expect(observed.errors).toEqual([])
})
