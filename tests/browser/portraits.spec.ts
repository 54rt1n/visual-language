import { openTool } from './navigation'
import { expect, test, type Page } from '@playwright/test'

async function ready(page: Page) { await page.goto('/'); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible() }
async function close(page: Page) { await page.getByRole('button', { name: 'Close dialog' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0) }
async function download(page: Page) {
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full backup' }).click()
  const file = await pending, stream = await file.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const buffer = Buffer.concat(chunks); await close(page); return buffer
}
test('text-only teacher preserves controls and restores without fetching portraits, including at startup', async ({ page, browser }) => {
  await ready(page)
  await expect(page.getByTestId('teacher-portrait').locator('img')).toHaveAttribute('alt', '')
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Keep this draft when the portrait is hidden.')
  await page.getByRole('button', { name: 'Hide teacher portrait', exact: true }).click()
  await expect(page.getByTestId('teacher-portrait')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this draft when the portrait is hidden.')
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await expect(page.getByTestId('teacher-portrait')).toHaveCount(0)
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Start practice', exact: true })).toBeVisible()
  await page.getByRole('dialog').getByText(/^Lesson options/).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Show teacher portrait', exact: true }).click()
  await expect(page.getByTestId('teacher-portrait').locator('img')).toHaveAttribute('data-pose', 'attentive')
  await page.getByRole('dialog').getByRole('button', { name: 'Hide teacher portrait', exact: true }).click(); await close(page)
  await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
  await expect(page.getByTestId('teacher-portrait')).toHaveCount(0)
  await close(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Show Zheng’s portrait' }).check()
  await expect(page.getByRole('checkbox', { name: 'Show Zheng’s portrait' })).toBeEnabled()
  await close(page)
  await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
  await expect(page.getByTestId('teacher-portrait').locator('img')).toHaveAttribute('data-pose', 'welcome')
  await close(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Show Zheng’s portrait' }).uncheck()
  await expect(page.getByRole('checkbox', { name: 'Show Zheng’s portrait' })).toBeEnabled()
  await close(page)
  const buffer = await download(page), saved = JSON.parse(buffer.toString()).data
  expect(saved.view).toMatchObject({ teacherPortraits: false, teacherCollapsed: false, composerDraft: 'Keep this draft when the portrait is hidden.' })
  expect(saved.events).toHaveLength(0); expect(saved.cards).toHaveLength(0)
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }), restored = await fresh.newPage()
  await ready(restored)
  await openTool(restored, 'Backup & restore')
  await restored.getByLabel('Choose backup file').setInputFiles({ name: 'text-only.json', mimeType: 'application/json', buffer })
  await restored.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
  await restored.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await expect(restored.getByText('Workspace restored.', { exact: false })).toBeVisible(); await close(restored)
  const portraits: string[] = []
  restored.on('request', request => { if (request.url().includes('/avatars/')) portraits.push(request.url()) })
  await restored.reload(); await expect(restored.getByText('Saved on this device', { exact: false })).toBeVisible()
  await expect(restored.getByTestId('teacher-portrait')).toHaveCount(0)
  await expect(restored.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue(saved.view.composerDraft)
  await restored.getByRole('button', { name: 'Daily review', exact: true }).click()
  await restored.getByRole('dialog').getByText(/^Lesson options/).click()
  await expect(restored.getByRole('dialog').getByRole('button', { name: 'Show teacher portrait', exact: true })).toBeVisible()
  await restored.screenshot({ path: 'test-results/teacher-text-only-mobile.png', fullPage: true })
  expect(portraits).toEqual([])
  expect(await restored.evaluate(() => localStorage.getItem('vl-settings-v2'))).toBeNull()
  await fresh.close()
})

test('missing images fall back finitely to a text teacher without blocking shell installation or learner controls', async ({ page }) => {
  const requests: string[] = [], errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/avatars/zheng/*.png', async route => { requests.push(new URL(route.request().url()).pathname); await route.abort('failed') })
  await ready(page)
  await expect(page.getByText('Portrait unavailable', { exact: true })).toBeVisible()
  expect(requests).toEqual(['/avatars/zheng/attentive-v1.png'])
  await page.getByRole('button', { name: 'Explore a topic', exact: true }).click()
  await expect(page.getByRole('dialog').getByText('Portrait unavailable', { exact: true })).toBeVisible()
  expect(requests).toEqual(['/avatars/zheng/attentive-v1.png', '/avatars/zheng/welcome-v1.png', '/avatars/zheng/attentive-v1.png'])
  await close(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Show Zheng’s portrait' }).uncheck()
  await expect(page.getByRole('checkbox', { name: 'Show Zheng’s portrait' })).toBeEnabled()
  await expect(page.getByTestId('teacher-portrait')).toHaveCount(0)
  await close(page)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Text remains usable when artwork fails.')
  const worker = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)
  expect(worker).toBe('activated')
  const cached = await page.evaluate(async () => (await Promise.all((await caches.keys()).filter(k => k.startsWith('visual-language-shell:')).map(async k => (await (await caches.open(k)).keys()).map(r => r.url)))).flat())
  expect(cached.some(url => url.includes('/avatars/'))).toBe(false)
  expect(errors).toEqual([])
})

test('reviewed masters retain alpha and render at display size on light and dark surfaces', async ({ page }) => {
  const budget = await (await page.request.get('/asset-budget.json')).json()
  await page.goto('/asset-budget.json')
  await page.setViewportSize({ width: 720, height: 720 })
  await page.setContent(`<title>Portrait asset inspection</title><style>body{font:14px system-ui;background:#293241;color:#fff;margin:24px}h1{font-size:18px}.row{display:flex;align-items:center;gap:20px;margin:8px 0}.label{width:170px}.surface{width:100px;height:100px;padding:2px;background:#fff;border-radius:6px}.dark{background:#111722}img{display:block;width:100px;height:100px;object-fit:contain}</style><h1>Asset inspection only · 100px portraits</h1><p>Original artwork on light and dark surfaces; not a new app theme.</p>${budget.portraits.files.map((entry: { state: string; file: string }) => `<div class="row"><span class="label">${entry.state}</span><div class="surface"><img src="/${entry.file}" alt="${entry.state} on light" /></div><div class="surface dark"><img src="/${entry.file}" alt="${entry.state} on dark" /></div></div>`).join('')}`)
  const alpha = await page.evaluate(async () => {
    const images = [...document.querySelectorAll('img')]; await Promise.all(images.map(image => image.decode()))
    return images.filter((_image, i) => i % 2 === 0).map(image => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let transparent = 0, solid = 0
      for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]! < 5) transparent++; if (pixels[i]! > 250) solid++ }
      return { width: image.naturalWidth, height: image.naturalHeight, transparent, solid }
    })
  })
  expect(alpha).toHaveLength(5)
  for (const result of alpha) { expect(result).toMatchObject({ width: 1254, height: 1254 }); expect(result.transparent).toBeGreaterThan(10_000); expect(result.solid).toBeGreaterThan(10_000) }
  await page.screenshot({ path: 'test-results/portrait-display-surfaces.png', fullPage: true })
})
