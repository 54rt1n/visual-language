import { prepareTool } from './navigation'
import { expect, test, type Page } from '@playwright/test'
import type { Workspace } from '../../src/lib/domain/workspace'

const activities = [
  ['Lessons', 'Lessons'],
  ['Daily review', 'Daily review'],
  ['Explore a topic', 'Explore a topic'],
  ['Save for practice', 'Save for practice'],
  ['Library', 'Library'],
  ['Search', 'Search'],
  ['Topics', 'Topics'],
  ['More tools', 'More tools'],
  ['Settings', 'Settings'],
  ['Try demo', 'Demo'],
] as const

async function ready(page: Page) {
  await page.goto('/')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
}

test('tool-rail activities support keyboard entry, modal containment, Escape and return focus without moving the graph', async ({ page }) => {
  await ready(page)
  const viewport = await page.locator('.svelte-flow__viewport').getAttribute('style')
  const requests: string[] = [], errors: string[] = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173')) requests.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  for (const [tool, title] of activities) {
    await test.step(title, async () => {
      const trigger = (tool === 'Try demo' ? page : page.getByRole('navigation', { name: 'Workspace tools' })).getByRole('button', { name: tool, exact: true })
      await trigger.focus(); await page.keyboard.press('Enter')
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await expect(dialog).toBeVisible(); await expect(page.locator('dialog[open]')).toHaveCount(1)
      await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused()
      // Native showModal makes the graph inert. Chromium may move to browser
      // chrome at a tab boundary; that is not a focusable app control escaping.
      for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Tab']) {
        await page.keyboard.press(key)
        const focus = await dialog.evaluate(element => ({ inside: element.contains(document.activeElement), tag: document.activeElement?.tagName, pageFocused: document.hasFocus() }))
        expect(focus.inside || (!focus.pageFocused && focus.tag === 'BODY'), `${title}: ${key}: ${JSON.stringify(focus)}`).toBe(true)
      }
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).focus()
      await trigger.focus() // Inert graph controls cannot steal focus from the modal.
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0); await expect(trigger).toBeFocused()
      expect(await page.locator('.svelte-flow__viewport').getAttribute('style')).toBe(viewport)
    })
  }
  expect(requests).toEqual([]); expect(errors).toEqual([])
})

for (const width of [390, 320]) test(`focused activities reflow at ${width}px without horizontal clipping`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); await ready(page)
  for (const [tool, title] of activities) {
    await test.step(title, async () => {
      await page.getByRole('button', { name: tool, exact: true }).click()
      const dialog = page.getByRole('dialog', { name: title, exact: true })
      await expect(dialog).toBeVisible()
      const geometry = await dialog.evaluate(element => ({
        width: element.clientWidth, scrollWidth: element.scrollWidth,
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        bodyWidth: element.querySelector('.modal-body')!.clientWidth,
        bodyScrollWidth: element.querySelector('.modal-body')!.scrollWidth,
      }))
      expect.soft(geometry.scrollWidth, `${title} should not require horizontal scrolling`).toBeLessThanOrEqual(geometry.width + 1)
      expect.soft(geometry.bodyScrollWidth, `${title}: clipping the dialog must not hide overflowing content`).toBeLessThanOrEqual(geometry.bodyWidth + 1)
      expect.soft(geometry.left).toBeGreaterThanOrEqual(0); expect.soft(geometry.right).toBeLessThanOrEqual(width)
      await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeInViewport()
      if (title === 'Library') await page.screenshot({ path: `test-results/library-reflow-${width}.png`, fullPage: true })
      await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0)
    })
  }
})

test('a modal handoff returns focus to the original workspace tool', async ({ page }) => {
  await ready(page)
  const trigger = page.getByRole('button', { name: 'Library', exact: true })
  await trigger.focus(); await page.keyboard.press('Enter')
  const add = page.getByRole('dialog').getByRole('button', { name: 'Save for practice', exact: true })
  await add.focus(); await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Save for practice', exact: true })).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('keyboard quiz selection survives Escape and reload before one explicit submission', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  const requests: string[] = [], errors: string[] = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173')) requests.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  async function activate(name: string) {
    const button = ['Start practice', 'Resume practice'].includes(name) ? page.getByRole('dialog').getByRole('button', { name, exact: true }) : await prepareTool(page, name)
    await expect(button).toBeEnabled(); await button.focus(); await expect(button).toBeFocused()
    await page.keyboard.press('Enter')
  }
  async function close() { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0) }
  async function snapshot(): Promise<Workspace> {
    await activate('Backup & restore')
    const pending = page.waitForEvent('download'); await activate('Download full backup')
    const download = await pending, stream = await download.createReadStream(), chunks: Buffer[] = []
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
    await close()
    return JSON.parse(Buffer.concat(chunks).toString()).data
  }
  await page.goto('/#demo'); await expect(page.locator('.demo-badge')).toContainText('DEMO')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await expect(page.locator('.demo-badge')).toContainText('Sample content')
  const before = await snapshot()
  await activate('Daily review'); await activate('Start practice'); await activate('Review next due card')
  await expect(page.locator('.question .prompt')).toBeFocused()
  await expect(page.locator('.question .prompt')).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Submit answer', exact: true })).toBeInViewport()
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  const option = page.getByRole('radio', { name: /谢谢/ })
  await option.focus(); await page.keyboard.press('Space'); await expect(option).toBeChecked()
  const viewport = await page.locator('.svelte-flow__viewport').getAttribute('style')
  await close()
  await expect(page.getByRole('button', { name: 'Daily review', exact: true })).toBeFocused()
  expect(await page.locator('.svelte-flow__viewport').getAttribute('style')).toBe(viewport)
  const paused = await snapshot(), session = paused.sessions.find(s => s.status === 'paused' && s.activeExerciseId)!
  const exercise = paused.exercises.find(e => e.id === session.activeExerciseId)!
  const draft = paused.drafts.find(d => d.kind === 'answer' && d.exerciseId === exercise.id)!
  expect(draft.selectedOptionId).toBeTruthy(); expect(paused.cards).toEqual(before.cards)
  expect(paused.events).toEqual(before.events)
  expect(paused.attempts.filter(a => a.exerciseId === exercise.id)).toHaveLength(0)
  await page.reload(); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await activate('Daily review'); await expect(option).toBeChecked(); await activate('Resume practice')
  await activate('Submit answer')
  await expect(page.getByRole('dialog').getByText('Correct', { exact: true })).toBeVisible()
  await expect(page.locator('.feedback')).toBeFocused()
  await expect(page.locator('.feedback')).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Next review', exact: true })).toBeInViewport()
  expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: 'test-results/keyboard-quiz-feedback-320.png', fullPage: true })
  await close()
  const finished = await snapshot()
  expect(finished.events.filter(e => e.exerciseId === exercise.id && e.kind === 'review')).toHaveLength(1)
  expect(finished.attempts.filter(a => a.exerciseId === exercise.id)).toHaveLength(1)
  expect(finished.exercises.find(e => e.id === exercise.id)!.multipleChoice?.options).toEqual(exercise.multipleChoice?.options)
  expect(requests).toEqual([]); expect(errors).toEqual([])
})
