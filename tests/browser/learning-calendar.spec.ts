import { expect, test, type Page } from '@playwright/test'
import type { LearningCalendar } from '../../src/lib/domain/learningCalendar'

test.use({ timezoneId: 'America/Chicago', locale: 'en-US' })

async function ready(page: Page, time: string) {
  await page.clock.setFixedTime(new Date(time))
  await page.goto('/')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
}

/** Read the backed-up learner record, independently of the UI projection. */
async function storedCalendar(page: Page): Promise<LearningCalendar> {
  return page.evaluate(() => new Promise<LearningCalendar>((resolve, reject) => {
    const request = indexedDB.open('visual-language-workspace-v1')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['meta', 'datasets', 'learners'])
      const control = tx.objectStore('meta').get('control')
      control.onsuccess = () => {
        const datasetId = control.result.activeDatasetId
        const dataset = tx.objectStore('datasets').get(datasetId)
        dataset.onsuccess = () => {
          const learner = tx.objectStore('learners').get([datasetId, dataset.result.metadata.activeLearnerId])
          learner.onsuccess = () => resolve(learner.result.value.learningCalendar)
        }
      }
      tx.oncomplete = () => db.close()
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}

test('a saved cutoff takes effect on reopening after the old day ends, with no rollover write', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await ready(page, '2026-10-16T12:00:00Z')
  const cutoff = page.getByLabel('Learning day starts at')
  await expect(cutoff).toHaveValue('03:00')
  const originalDay = await page.getByLabel('Current learning day').innerText()
  await cutoff.fill('04:00')
  await page.getByRole('button', { name: 'Save learning day' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Learning-day preference saved.' })).toBeVisible()
  await expect(page.getByLabel('Current learning day')).toHaveText(originalDay)
  await expect(page.getByText('Change applies after the current learning day ends:', { exact: false })).toBeVisible()
  const saved = await storedCalendar(page)
  expect(saved).toMatchObject({ startMinute: 180, timeZone: 'America/Chicago',
    pending: { startMinute: 240, effectiveAt: Date.parse('2026-10-17T08:00:00Z') } })
  await page.screenshot({ path: 'test-results/learning-calendar-settings-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 568 })
  expect(await page.getByRole('dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true)
  await page.getByRole('button', { name: 'Save learning day' }).focus()
  await expect(page.getByRole('button', { name: 'Save learning day' })).toBeInViewport()
  await page.close()

  const resumed = await context.newPage()
  await ready(resumed, '2026-10-17T08:30:00Z')
  await expect(resumed.getByLabel('Learning day starts at')).toHaveValue('04:00')
  await expect(resumed.getByLabel('Current learning day')).toContainText('Oct 17, 2026, 3:00 AM – Oct 17, 2026, 4:00 AM')
  await expect(resumed.getByText('Change applies after the current learning day ends:', { exact: false })).toHaveCount(0)
  expect(await storedCalendar(resumed)).toEqual(saved)
})

test('focus refreshes the learning day after 3am without changing the saved calendar', async ({ page }) => {
  await ready(page, '2026-10-16T07:59:00Z')
  await expect(page.getByLabel('Current learning day')).toContainText('Oct 15, 2026, 3:00 AM – Oct 16, 2026, 3:00 AM')
  const saved = await storedCalendar(page)
  await page.clock.setFixedTime(new Date('2026-10-16T08:01:00Z'))
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByLabel('Current learning day')).toContainText('Oct 16, 2026, 3:00 AM – Oct 17, 2026, 3:00 AM')
  expect(await storedCalendar(page)).toEqual(saved)
})

test.describe('browser travel', () => {
  test.use({ timezoneId: undefined })
  test('a detected time-zone change is saved prospectively and survives another reopen', async ({ page }) => {
    const client = await page.context().newCDPSession(page)
    await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Chicago' })
    await ready(page, '2026-10-16T12:00:00Z')
    await page.getByRole('button', { name: 'Save learning day' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Learning-day preference saved.' })).toBeVisible()
    const saved = await storedCalendar(page)
    await client.send('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' })
    await ready(page, '2026-10-16T13:00:00Z')
    const pending = await storedCalendar(page)
    expect(pending.anchor).toEqual(saved.anchor)
    expect(pending.pending).toEqual({ startMinute: 180, timeZone: 'America/Los_Angeles', effectiveAt: saved.anchor!.endAt })
    await expect(page.getByText('Time zone: America/Chicago. Next time zone: America/Los_Angeles.', { exact: false })).toBeVisible()
    await ready(page, '2026-10-17T08:30:00Z')
    await expect(page.getByLabel('Current learning day')).toContainText('Oct 17, 2026, 1:00 AM – Oct 17, 2026, 3:00 AM')
    await expect(page.getByText('Change applies after the current learning day ends:', { exact: false })).toHaveCount(0)
    expect(await storedCalendar(page)).toEqual(pending)
    await page.getByRole('button', { name: 'Save learning day' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Learning-day preference saved.' })).toBeVisible()
    const applied = await storedCalendar(page)
    expect(applied).toMatchObject({ timeZone: 'America/Los_Angeles', anchor: { sequence: saved.anchor!.sequence + 1, startAt: saved.anchor!.endAt, endAt: Date.parse('2026-10-17T10:00:00Z') } })
    expect(applied.pending).toBeUndefined()
  })
})
