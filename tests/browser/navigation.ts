import { expect, type Page } from '@playwright/test'

/** Navigate through the same grouped tools a learner uses. */
export async function prepareTool(page: Page, name: string) {
  if (['Backup & restore', 'Install app', 'App updates', 'About', 'Demo workspace'].includes(name)) {
    await page.getByRole('button', { name: 'More tools', exact: true }).click()
  } else if (name === 'AI connection' || name === 'Audio & pinyin settings') {
    if (!await page.getByRole('button', { name, exact: true }).isVisible()) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
    }
  } else if (name === 'Node tools') {
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Fit View', exact: true }).click()
    const selected = page.locator('.svelte-flow__node.selected').last()
    const node = await selected.count() ? selected : page.locator('.svelte-flow__node').last()
    if (!await selected.count()) await node.click({ position: { x: 15, y: 15 } })
    const configuration = node.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Configuration$/ }) }).first()
    if (await configuration.count() && !await configuration.evaluate(element => (element as HTMLDetailsElement).open)) await configuration.locator('summary').first().click()
    return node.getByRole('button', { name, exact: true })
  }
  const railButton = page.getByRole('navigation', { name: 'Workspace tools' }).getByRole('button', { name, exact: true })
  return await railButton.count() ? railButton : page.getByRole('button', { name, exact: true })
}

export async function openTool(page: Page, name: string) {
  const button = await prepareTool(page, name)
  await button.click()
  if (name === 'Node tools') {
    const dialog = page.getByRole('dialog', { name: 'Node tools', exact: true })
    await expect(dialog).toBeVisible()
    // Existing graph contract tests exercise the advanced controls too.
    for (const selector of ['.branch-settings', '.danger']) {
      const section = dialog.locator(selector)
      if (await section.count() && !await section.evaluate(element => (element as HTMLDetailsElement).open)) await section.locator('summary').first().click()
    }
  }
}
