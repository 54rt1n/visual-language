import { expect, test } from '@playwright/test'

test('About centralizes credits, stays reachable above the background, and works offline without downloading a model', async ({ page, context }) => {
  const external: string[] = [], packs: string[] = [], errors: string[] = []
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4173')) external.push(request.url())
    if (request.url().includes('/reading-model/')) packs.push(request.url())
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/'); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await page.evaluate(async () => { await navigator.serviceWorker.ready }); await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await context.setOffline(true); await page.reload()
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 720 })
    const viewport = await page.locator('.svelte-flow__viewport').getAttribute('style')
    await page.getByRole('button', { name: 'More tools', exact: true }).click()
    const about = page.getByRole('button', { name: 'About', exact: true })
    await about.scrollIntoViewIfNeeded()
    expect(await about.evaluate(element => { const b = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) })).toBe(true)
    await about.focus(); await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'About Visual Language' })
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused()
    await expect(dialog).toContainText('MDBG and CC-CEDICT contributors')
    await expect(dialog.getByRole('link', { name: /Creative Commons Attribution-ShareAlike/ })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/')
    await expect(dialog.getByRole('link', { name: 'Full dictionary and decompression notices' })).toHaveJSProperty('href', new URL('dictionaries/NOTICE.txt', page.url()).href)
    await expect(dialog.getByRole('link', { name: 'Model modifications and source credits' })).toHaveJSProperty('href', new URL('reading-model/g2pw-v2-int4-1/NOTICE.txt', page.url()).href)
    await expect(dialog).toContainText('The archive is unchanged.')
    await expect(dialog).toContainText('quantizes its pronunciation predictor')
    await expect(dialog).not.toContainText('adapted from the original')
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth && element.querySelector('.modal-body')!.scrollWidth <= element.querySelector('.modal-body')!.clientWidth)).toBe(true)
    if (width === 320) await page.screenshot({ path: 'test-results/about-credits-320.png', fullPage: true })
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: 'More tools', exact: true })).toBeFocused()
    expect(await page.locator('.svelte-flow__viewport').getAttribute('style')).toBe(viewport)
  }
  expect(external).toEqual([]); expect(packs).toEqual([]); expect(errors).toEqual([])
})
