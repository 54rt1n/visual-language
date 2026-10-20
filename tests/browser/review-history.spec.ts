import { openTool, returningVisitor } from './navigation'
import { expect, test, type Page } from '@playwright/test'

async function close(page: Page) { await page.getByRole('button', { name: 'Close dialog' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0) }
async function ready(page: Page) {
  await page.goto('/#demo'); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
}
async function history(page: Page) {
  await page.getByRole('button', { name: 'Library', exact: true }).click()
  const item = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '请给我一杯茶 Write in Mandarin', exact: true }) })
  await item.getByRole('button', { name: 'Review history', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Saved review history' })).toBeVisible()
}
async function download(page: Page) {
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full backup' }).click()
  const file = await pending, stream = await file.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const buffer = Buffer.concat(chunks); await close(page)
  return { buffer, state: JSON.parse(buffer.toString()).data }
}
test('past-review correction previews cancel safely, retain original grades, flag old disputes and survive fresh-profile restore', async ({ page, browser }) => {
  const external: string[] = [], errors: string[] = []
  page.on('request', req => { if (!req.url().startsWith('http://127.0.0.1:4173')) external.push(req.url()) })
  page.on('pageerror', e => errors.push(e.message))
  await ready(page); const before = await download(page)
  await history(page)
  await page.getByRole('button', { name: 'Preview correction: not recalled', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Confirm grade correction' })).toContainText('calculated from the original review')
  await page.getByRole('button', { name: 'Cancel correction', exact: true }).click()
  await close(page); const cancelled = await download(page)
  expect(cancelled.state.cards).toEqual(before.state.cards); expect(cancelled.state.events).toEqual(before.state.events)
  await history(page)
  await page.getByRole('button', { name: 'Preview correction: not recalled', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm correction', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Correction saved' })).toBeVisible()
  const latest = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Preview correction: recalled', exact: true }) })
  await expect(latest).toContainText('Original assessment: correct')
  await expect(latest).toContainText('Effective scheduling result: not recalled')
  await expect(latest).toContainText('learner-corrected')
  await close(page); const corrected = await download(page)
  expect(corrected.state.cards.find((c: { id: string }) => c.id === 'demo-tea-card').box).toBe(1)
  expect(corrected.state.events.filter((e: { kind: string }) => e.kind === 'correction')).toHaveLength(1)
  await history(page)
  const oldest = page.getByRole('article').filter({ hasText: 'Prerecorded prior mistake' })
  await oldest.getByRole('button', { name: 'Flag historical result for review', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Confirm grade correction' })).toContainText('does not rewrite the later chain')
  await page.getByRole('button', { name: 'Save historical dispute', exact: true }).click()
  await expect(oldest).toContainText('Historical dispute flagged')
  await close(page); const disputed = await download(page)
  expect(disputed.state.cards).toEqual(corrected.state.cards)
  expect(disputed.state.events.filter((e: { disputed?: boolean }) => e.disputed)).toHaveLength(1)
  const fresh = await browser.newContext({ storageState: returningVisitor, viewport: { width: 390, height: 844 } }), restored = await fresh.newPage()
  restored.on('request', req => { if (!req.url().startsWith('http://127.0.0.1:4173')) external.push(req.url()) })
  await ready(restored); await openTool(restored, 'Backup & restore')
  await restored.getByLabel('Choose backup file').setInputFiles({ name: 'review-history.json', mimeType: 'application/json', buffer: disputed.buffer })
  await restored.getByRole('checkbox', { name: 'Replace the current workspace' }).check()
  await restored.getByRole('button', { name: 'Replace workspace', exact: true }).click()
  await expect(restored.getByText('Workspace restored.', { exact: false })).toBeVisible(); await close(restored)
  await history(restored)
  await expect(restored.getByRole('dialog')).toContainText('Historical dispute flagged')
  await expect(restored.getByRole('dialog')).toContainText('learner-corrected')
  await restored.getByText('Effective scheduling result: not recalled', { exact: false }).first().scrollIntoViewIfNeeded()
  await restored.screenshot({ path: 'test-results/review-history-mobile.png', fullPage: true })
  expect(external).toEqual([]); expect(errors).toEqual([]); await fresh.close()
})

test('history access from an unresolved review needs explicit help and cannot promote an aided answer through correction', async ({ page }) => {
  await ready(page)
  await page.getByRole('button', { name: 'Daily review', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Start practice', exact: true }).click()
  await page.getByRole('button', { name: 'Review next due card', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Zheng’s session reflection' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Browse saved review history', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Reveal learning material?' })).toBeVisible()
  await page.getByRole('button', { name: 'Return to the question', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Daily review' })).toBeVisible()
  await page.getByRole('button', { name: 'Browse saved review history', exact: true }).click()
  await page.getByRole('button', { name: 'Reveal material and record help', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Saved review history' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview correction: recalled', exact: true })).toBeDisabled()
  await expect(page.getByRole('article')).toContainText('Help recorded: source')
  await close(page); const saved = await download(page)
  const active = saved.state.sessions.find((s: { status: string }) => s.status !== 'completed').activeExerciseId
  expect(saved.state.events.filter((e: { exerciseId?: string; kind: string }) => e.exerciseId === active && e.kind === 'review')).toHaveLength(1)
})
