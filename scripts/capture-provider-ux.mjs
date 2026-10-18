import { chromium, expect } from '@playwright/test'
import { preview } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

// Production UI, isolated browser storage, synthetic provider replies only.
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out') throw Error('Use --out NEW_DIRECTORY after npm run build.')
const output = resolve(args[1])
await mkdir(output, { recursive: false })
const server = await preview({ preview: { host: '127.0.0.1', port: 4174, strictPort: true } })
const browser = await chromium.launch()
const origin = 'http://127.0.0.1:4174'
const report = { scope: 'Production-browser provider usability captures; all remote requests mocked or blocked, no inference usage.', screenshots: [], requests: [], pageErrors: [], observations: [] }
let reply = 'success'
const save = () => writeFile(join(output, 'observations.json'), JSON.stringify(report, null, 2) + '\n')
async function setup(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  page.on('pageerror', error => report.pageErrors.push(error.message))
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === origin) return route.continue()
    report.requests.push({ url: url.href, method: route.request().method(), mocked: true })
    if (url.pathname.endsWith('/models')) return route.fulfill({ json: { data: [{ id: 'deepseek-ai/DeepSeek-V4-Flash-0731' }, { id: 'Qwen/Qwen3.8-27B' }] } })
    if (url.pathname.endsWith('/chat/completions')) {
      if (reply === 'error') return route.fulfill({ status: 401, json: { error: { message: 'Invalid API key', type: 'authentication_error' } } })
      const data = { model: 'deepseek-ai/DeepSeek-V4-Flash-0731', choices: [{ index: 0, delta: { content: '你好！ — Hello!' }, finish_reason: 'stop' }] }
      return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n` })
    }
    return route.abort()
  })
  await page.goto(origin)
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  return { page, context }
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, animations: 'disabled' })
  const state = await page.evaluate(() => {
    const dialog = document.querySelector('dialog[open]'), body = dialog?.querySelector('.modal-body')
    const buttons = Array.from((dialog ?? document).querySelectorAll('button')).filter(e => e.getClientRects().length).map(e => {
      const r = e.getBoundingClientRect()
      return { name: e.getAttribute('aria-label') || e.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height, disabled: e.disabled }
    })
    return { dialog: dialog?.getAttribute('aria-label'), focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 80), horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      focusTag: document.activeElement?.tagName, focusInsideDialog: !!document.activeElement?.closest('dialog[open]'),
      body: body && { scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, horizontalOverflow: body.scrollWidth > body.clientWidth }, buttons }
  })
  report.screenshots.push({ name, file: `${name}.png`, viewport: page.viewportSize(), ...state }); await save()
}
async function focusObservation(page, label) {
  const focused = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, name: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent?.trim().slice(0, 80), insideDialog: !!document.activeElement?.closest('dialog[open]') }))
  const before = await focused()
  await page.keyboard.press('Tab')
  report.observations.push({ label, before, afterTab: await focused() })
}
try {
  const { page, context } = await setup({ width: 1440, height: 900 })
  await capture(page, '01-desktop-first-run')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await capture(page, '02-desktop-settings-hub')
  await page.getByRole('button', { name: 'AI connection', exact: true }).click()
  const provider = page.getByRole('combobox', { name: 'Provider', exact: true })
  await expect(provider).toHaveValue('nebius')
  report.observations.push({ providerOptions: await provider.locator('option').allTextContents(), freshProvider: await provider.inputValue(), freshModel: await page.getByLabel('Model ID', { exact: true }).inputValue() })
  await capture(page, '03-desktop-nebius-default')
  await page.getByText('Choose another model', { exact: true }).click()
  await page.getByRole('button', { name: 'Load provider models', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).not.toBeEmpty()
  await capture(page, '04-desktop-missing-key-feedback')
  await page.getByLabel('Nebius API key', { exact: true }).fill('synthetic-nebius-ux-key')
  await capture(page, '05-desktop-key-entry')
  await page.getByRole('button', { name: 'Load provider models', exact: true }).click()
  await expect(page.getByLabel('Available models')).toBeVisible()
  await capture(page, '06-desktop-model-browser')
  await focusObservation(page, 'after-model-load')
  await page.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toContainText('Connected to Nebius')
  await capture(page, '07-desktop-connected')
  await focusObservation(page, 'after-connection-test')
  reply = 'error'
  await page.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('valid API key')
  await capture(page, '08-desktop-auth-error'); reply = 'success'
  await provider.selectOption('featherless')
  await page.locator('dialog .modal-body').evaluate(e => e.scrollTo(0, 0))
  await capture(page, '09-desktop-featherless')
  await provider.selectOption('custom')
  await capture(page, '10-desktop-custom')
  await page.keyboard.press('Escape')
  report.observations.push({ afterConnectionEscape: await page.evaluate(() => ({ ariaLabel: document.activeElement?.getAttribute('aria-label'), text: document.activeElement?.textContent?.trim() })) })
  await context.close()
  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 568 }, { width: 844, height: 390 }]) {
    const { page, context } = await setup(viewport)
    const prefix = `${viewport.width}x${viewport.height}`
    await capture(page, `${prefix}-first-run`)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await capture(page, `${prefix}-settings-hub`)
    await page.getByRole('button', { name: 'AI connection', exact: true }).click()
    await capture(page, `${prefix}-nebius-default`)
    await page.getByLabel('Nebius API key', { exact: true }).fill('synthetic-nebius-ux-key')
    await capture(page, `${prefix}-key-entry`)
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(page.getByRole('dialog').getByRole('status')).toContainText('Connected to Nebius')
    await capture(page, `${prefix}-connected`)
    await page.getByRole('button', { name: 'Save connection', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await capture(page, `${prefix}-saved-workspace`)
    await context.close()
  }
  report.status = 'finished'; await save()
  console.log(`Captured ${report.screenshots.length} screens in ${output}; page errors: ${report.pageErrors.length}.`)
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error ? error.message : String(error)
  await save()
  throw error
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
}
