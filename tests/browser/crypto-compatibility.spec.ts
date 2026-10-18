import { openTool } from './navigation'
import { expect, test } from '@playwright/test'

test('plain HTTP without randomUUID or subtle supports local editing, reload and backup restore', async ({ page }) => {
  // Serve the production artifact on a non-loopback HTTP origin. Chromium must
  // decide API availability itself; do not mock crypto or isSecureContext.
  await page.route('http://insecure-app.test/**', async route => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `http://127.0.0.1:4173${url.pathname}${url.search}` })
    await route.fulfill({ response })
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://insecure-app.test/')
  expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID, subtle: typeof crypto.subtle, random: typeof crypto.getRandomValues }))).toEqual({ secure: false, uuid: 'undefined', subtle: 'undefined', random: 'function' })
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'New topic', exact: true }).click()
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Local HTTP draft — no credentials.')
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download full backup' }).click()
  const download = await pending, stream = await download.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const buffer = Buffer.concat(chunks), backup = JSON.parse(buffer.toString('utf8'))
  expect(backup.data.nodes.filter((node: { type: string }) => node.type === 'root')).toHaveLength(2)
  expect(backup.data.operations.length).toBeGreaterThan(0)
  expect(backup.data.operations.every((op: { fingerprint: string }) => /^[a-f0-9]{64}$/.test(op.fingerprint))).toBe(true)
  expect(backup.data.view.composerDraft).toBe('Local HTTP draft — no credentials.')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Local HTTP draft — no credentials.')
  await openTool(page, 'Backup & restore')
  await page.getByLabel('Choose backup file').setInputFiles({ name: 'local-workspace.json', mimeType: 'application/json', buffer })
  await page.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
  await page.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await expect(page.getByText('Workspace restored.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await openTool(page, 'AI connection')
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Use HTTPS before entering real API keys')
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await openTool(page, 'App updates')
  await expect(page.getByText('This browser cannot prepare an app shell here.', { exact: false })).toBeVisible()
  expect(errors).toEqual([])
})
