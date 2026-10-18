import { openTool } from './navigation'
import { expect, test, type Locator, type Page } from '@playwright/test'

const response = '我想喝咖啡，谢谢。银行行长喜欢音乐。\n今天我们去图书馆学习中文。\n我还没有还书。他跑得很快。我慢慢地走回家。'

async function setup(page: Page) {
  await page.route('https://layout-fixture.example/v1/chat/completions', route => route.fulfill({
    status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ model: 'layout-fixture', choices: [{ delta: { content: response }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
  }))
  await page.goto('/')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://layout-fixture.example/v1')
  await page.getByLabel('Model ID', { exact: true }).fill('layout-fixture')
  await page.getByLabel('Custom endpoint API key').fill('synthetic-layout-key')
  await page.getByRole('button', { name: 'Save connection' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Show a useful conversation.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.assistant .word').first()).toBeVisible()
  const assistant = page.locator('.assistant'), configuration = assistant.locator('.configuration')
  await expect(configuration).not.toHaveAttribute('open', '')
  await configuration.getByText('Configuration', { exact: true }).click()
  // These cases exercise the node growing when pinyin is revealed.
  await assistant.getByRole('button', { name: 'Hide pinyin', exact: true }).click()
  await expect(assistant.getByRole('button', { name: 'Retry response', exact: true })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Keep this next question.')
}

async function hitTarget(target: Locator) {
  await expect.poll(() => target.evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })).toBe(true)
}

async function floatingDock(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('.canvas')!.getBoundingClientRect()
    const dock = document.querySelector('.teacher-panel')!.getBoundingClientRect()
    const status = document.querySelector('.brand')!.getBoundingClientRect(), tools = document.querySelector('.tool-rail')!.getBoundingClientRect()
    return canvas.top === 0 && canvas.left === 0 && canvas.width === innerWidth && canvas.height === innerHeight
      && dock.top > canvas.top && dock.bottom <= canvas.bottom && document.documentElement.scrollWidth <= innerWidth
      && status.right >= canvas.right - 20 && status.top <= canvas.top + 20 && tools.top <= canvas.top + 20 && tools.right < status.left
  })).toBe(true)
}

test('the conversation and its growing pinyin stay above the dock with visible reply controls', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await setup(page)
  const reply = page.locator('.assistant'), retry = reply.getByRole('button', { name: 'Retry response', exact: true })
  await floatingDock(page); await hitTarget(retry)
  await reply.getByRole('button', { name: 'Show pinyin', exact: true }).click()
  await expect(reply.locator('rt').first()).toBeVisible(); await hitTarget(retry)
  await expect.poll(() => reply.evaluate(element => element.getBoundingClientRect().bottom <= document.querySelector('.teacher-panel')!.getBoundingClientRect().top - 10)).toBe(true)
  await page.getByRole('button', { name: 'Hide teacher portrait', exact: true }).click()
  await floatingDock(page); await hitTarget(retry)
  const toggle = page.getByRole('button', { name: /^Zheng ·/ })
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await floatingDock(page); await hitTarget(retry)
  await toggle.click(); await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await floatingDock(page); await hitTarget(retry)
  await page.getByRole('button', { name: 'Show teacher portrait', exact: true }).click()
  await floatingDock(page); await hitTarget(retry)
  const composer = page.getByRole('textbox', { name: 'Message to Zheng' })
  await composer.evaluate(element => { element.style.height = '240px' })
  await floatingDock(page); await hitTarget(retry)
  await composer.evaluate(element => { element.style.height = '' })
  await floatingDock(page); await hitTarget(retry)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this next question.')
  await page.screenshot({ path: 'test-results/conversation-dock-desktop.png', fullPage: true })
  expect(errors).toEqual([])
})

test('short screens retain full-screen flow, a floating teacher, readable word help and reachable controls', async ({ page }) => {
  await setup(page)
  for (const [width, height] of [[390, 568], [320, 568], [568, 320]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await floatingDock(page)
    const tools = (await page.locator('.tool-rail').boundingBox())!, dock = (await page.locator('.teacher-panel').boundingBox())!
    expect(tools.y + tools.height).toBeLessThan(dock.y)
    await hitTarget(page.getByRole('button', { name: 'Zoom Out', exact: true }))
    const open = page.locator('.assistant').getByRole('button', { name: 'Read response', exact: true })
    await hitTarget(open); await open.click()
    const reader = page.getByRole('region', { name: 'Response reader' })
    await reader.getByRole('button', { name: 'Play 咖啡', exact: true }).click()
    await expect(reader.getByRole('region', { name: 'Selected word definition' })).toContainText('(loanword) coffee')
    await expect(reader.getByRole('region', { name: 'Word details' })).toHaveCount(0)
    await reader.getByRole('button', { name: 'Close response reader' }).click()
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await send.scrollIntoViewIfNeeded(); await hitTarget(send)
    await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this next question.')
    await page.screenshot({ path: `test-results/conversation-dock-${width}-${height}.png`, fullPage: true })
  }
})

test('manual panning ends automatic following and a reload retains that chosen view and draft', async ({ page }) => {
  await setup(page)
  const flow = page.locator('.svelte-flow__viewport')
  const before = await flow.getAttribute('style')
  const status = (await page.locator('.brand').boundingBox())!
  await page.mouse.move(status.x - 50, 60); await page.mouse.down(); await page.mouse.move(status.x - 110, 90, { steps: 5 }); await page.mouse.up()
  await expect.poll(() => flow.getAttribute('style')).not.toBe(before)
  const moved = await flow.getAttribute('style')
  await page.locator('.assistant').getByRole('button', { name: 'Show pinyin', exact: true }).click()
  await expect(page.locator('.assistant rt').first()).toBeVisible()
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  expect(await flow.getAttribute('style')).toBe(moved)
  await page.reload()
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  expect(await flow.getAttribute('style')).toBe(moved)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this next question.')
})

test('a phone reader keeps regeneration on the canvas node and preserves the unsent draft', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await setup(page); await page.setViewportSize({ width: 320, height: 568 })
  await page.locator('.assistant').getByRole('button', { name: 'Read response', exact: true }).click()
  const reader = page.getByRole('region', { name: 'Response reader' })
  await expect(reader.getByRole('button', { name: 'Retry response', exact: true })).toHaveCount(0)
  await expect(reader.getByRole('button', { name: 'Play full response', exact: true })).toBeInViewport({ ratio: .99 })
  await page.screenshot({ path: 'test-results/conversation-reader-320.png', fullPage: true })
  await reader.getByRole('button', { name: 'Close response reader' }).click()
  const retry = page.locator('.assistant').getByRole('button', { name: 'Retry response', exact: true })
  await retry.scrollIntoViewIfNeeded(); await hitTarget(retry)
  await expect(retry).toBeEnabled()
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this next question.')
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full backup' }).click()
  const file = await pending, stream = await file.createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const state = JSON.parse(Buffer.concat(chunks).toString()).data
  expect(state.nodes.filter((node: { type: string }) => node.type === 'assistant')).toHaveLength(1)
  for (const node of state.nodes.filter((node: { type: string }) => node.type === 'assistant')) expect(node.data.text).toBe(response)
  expect(state.view.composerDraft).toBe('Keep this next question.')
  for (const key of ['cards', 'items', 'events', 'attempts', 'sessions', 'exercises']) expect(state[key]).toEqual([])
  expect(errors).toEqual([])
})

test('a regenerated response remains draggable while it is streaming', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const original = window.fetch, encoder = new TextEncoder()
    let stream: ReadableStreamDefaultController<Uint8Array>
    const fixture = window as typeof window & { finishRegeneratedResponse(): void }
    fixture.finishRegeneratedResponse = () => {
      stream.enqueue(encoder.encode(`data: ${JSON.stringify({ model: 'layout-fixture', choices: [{ delta: { content: '，谢谢。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`))
      stream.close()
    }
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== 'https://layout-fixture.example/v1/chat/completions') return original(input, init)
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller
        stream.enqueue(encoder.encode(`data: ${JSON.stringify({ model: 'layout-fixture', choices: [{ delta: { content: '新的回答' }, finish_reason: null }] })}\n\n`))
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
  })
  await page.locator('.assistant').getByRole('button', { name: 'Retry response', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  const regenerated = page.locator('.svelte-flow__node-assistant').last(), heading = regenerated.locator('h3')
  const box = (await heading.boundingBox())!, before = await regenerated.getAttribute('style')
  await page.mouse.move(box.x + 12, box.y + 10); await page.mouse.down()
  await page.mouse.move(box.x + 52, box.y + 30, { steps: 6 }); await page.mouse.up()
  await expect.poll(() => regenerated.getAttribute('style')).not.toBe(before)
  await page.evaluate(() => (window as typeof window & { finishRegeneratedResponse(): void }).finishRegeneratedResponse())
  await expect(regenerated.getByRole('button', { name: 'Read response', exact: true })).toBeVisible()
})

test('node configuration deletes through a simple confirm or cancel dialog', async ({ page }) => {
  await setup(page)
  const assistant = page.locator('.assistant'), button = assistant.getByRole('button', { name: 'Delete node…', exact: true })
  await button.click()
  let dialog = page.getByRole('dialog', { name: 'Delete node?', exact: true })
  await expect(dialog).toContainText('Saved learning history is kept.')
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await expect(dialog.getByRole('textbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0); await expect(assistant).toBeVisible()
  await button.click(); dialog = page.getByRole('dialog', { name: 'Delete node?', exact: true })
  await dialog.getByRole('button', { name: 'Delete node', exact: true }).click()
  await expect(dialog).toHaveCount(0); await expect(assistant).toHaveCount(0)
  await expect(page.locator('.user')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this next question.')
})

test('keyboard zoom controls also end automatic following', async ({ page }) => {
  await setup(page)
  const flow = page.locator('.svelte-flow__viewport'), before = await flow.getAttribute('style')
  await page.getByRole('button', { name: 'Zoom Out', exact: true }).focus(); await page.keyboard.press('Enter')
  await expect.poll(() => flow.getAttribute('style')).not.toBe(before)
  const chosen = await flow.getAttribute('style')
  await page.locator('.assistant').getByRole('button', { name: 'Show pinyin', exact: true }).click()
  await expect(page.locator('.assistant rt').first()).toBeVisible()
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  expect(await flow.getAttribute('style')).toBe(chosen)
})

test('background status allows canvas dragging through its text and graph nodes render in front of it', async ({ page }) => {
  await setup(page)
  const status = (await page.locator('.brand').boundingBox())!, flow = page.locator('.svelte-flow__viewport')
  const before = await flow.getAttribute('style')
  await page.mouse.move(status.x + 30, status.y + 20); await page.mouse.down()
  await page.mouse.move(status.x + 10, status.y + 50, { steps: 5 }); await page.mouse.up()
  await expect.poll(() => flow.getAttribute('style')).not.toBe(before)
  const heading = page.locator('.assistant h3'), source = (await heading.boundingBox())!
  await page.mouse.move(source.x + 10, source.y + 8); await page.mouse.down()
  await page.mouse.move(status.x + 10, status.y + 20, { steps: 10 }); await page.mouse.up()
  await expect.poll(() => heading.evaluate(element => {
    const box = element.getBoundingClientRect(), status = document.querySelector('.brand')!.getBoundingClientRect()
    return box.left < status.right && box.right > status.left && box.top < status.bottom && box.bottom > status.top
  })).toBe(true)
  // The ordinary text is behind the node. About remains an explicit foreground
  // action, so use a point away from that small button when checking the layer.
  await expect.poll(() => heading.evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.x + 10, box.y + 8))
  })).toBe(true)
  await hitTarget(page.getByRole('button', { name: 'More tools', exact: true }))
  await page.screenshot({ path: 'test-results/background-status-node-overlap.png', fullPage: true })
})

test('grab-cursor reader chrome drags the response while word and toolbar controls do not', async ({ page }) => {
  await setup(page)
  const node = page.locator('.svelte-flow__node-assistant'), reader = node.locator('.reader')
  const configuration = node.locator('.configuration')
  await configuration.locator(':scope > summary').click()
  await expect(configuration).not.toHaveAttribute('open', '')
  expect((await configuration.boundingBox())!.width).toBeLessThan((await node.boundingBox())!.width / 2)
  await page.waitForTimeout(400)
  const flow = page.locator('.svelte-flow__viewport'); let viewport = await flow.getAttribute('style')
  expect(await node.evaluate(element => [...element.querySelectorAll('*')].filter(child => child.closest('.nodrag') && getComputedStyle(child).cursor === 'grab').map(child => child.className))).toEqual([])
  for (const [target, edge] of [[reader.locator('.reading-hint').first(), false]] as const) {
    await expect(target).toHaveCSS('cursor', 'grab')
    const box = (await target.boundingBox())!, before = await node.getAttribute('style')
    const x = edge ? box.x + box.width - 6 : box.x + 10, y = edge ? box.y + box.height - 10 : box.y + box.height / 2
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 24, y + 12, { steps: 5 }); await page.mouse.up()
    await expect.poll(() => node.getAttribute('style')).not.toBe(before)
    expect(await flow.getAttribute('style')).toBe(viewport)
  }
  await configuration.locator(':scope > summary').click()
  await page.waitForTimeout(400)
  viewport = await flow.getAttribute('style')
  const position = await node.getAttribute('style'), pinyin = configuration.getByRole('button', { name: 'Show pinyin', exact: true })
  const box = (await pinyin.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 4, { steps: 4 }); await page.mouse.up()
  expect(await node.getAttribute('style')).toBe(position)
  const word = reader.getByRole('button', { name: 'Explore 咖啡', exact: true })
  await word.click()
  const details = page.getByRole('region', { name: 'Word details' })
  await expect(details).toHaveCSS('cursor', 'default')
  await expect(details.getByRole('button', { name: 'Pin on canvas', exact: true })).toBeVisible()
  await page.keyboard.press('Escape'); await expect(details).toHaveCount(0)
  await configuration.getByRole('button', { name: 'Plain text', exact: true }).click()
  await expect(reader.getByRole('region', { name: 'Original response text' })).toHaveCSS('cursor', 'text')
  expect(await node.getAttribute('style')).toBe(position)
  expect(await flow.getAttribute('style')).toBe(viewport)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this next question.')
})

for (const width of [1440, 390]) test(`new topic shows a fresh tree and restores the previous conversation at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 568 : 900 })
  await setup(page)
  const oldReplyId = await page.locator('.svelte-flow__node-assistant').getAttribute('data-id')
  await page.locator('.assistant').getByRole('button', { name: 'Read response', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Response reader' })).toBeVisible()
  if (width === 390) await page.getByRole('button', { name: 'Close response reader', exact: true }).click()
  await page.getByRole('button', { name: 'New topic', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Response reader' })).toHaveCount(0)
  await expect(page.locator('.svelte-flow__node-assistant')).toHaveCount(0)
  await expect(page.locator('.svelte-flow__node-user')).toHaveCount(0)
  const root = page.locator('.svelte-flow__node-root')
  await expect(root).toHaveCount(1)
  await expect(root).toContainText('Topic 2')
  await expect(root).toBeInViewport({ ratio: 0.99 })
  const newRootId = await root.getAttribute('data-id')
  await page.reload()
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await expect(page.locator('.svelte-flow__node-assistant')).toHaveCount(0)
  await expect(root).toHaveAttribute('data-id', newRootId!)
  await page.getByRole('button', { name: 'Topics', exact: true }).click()
  await page.getByRole('article', { name: 'Conversation', exact: true }).getByRole('button', { name: 'Open topic', exact: true }).click()
  await expect(page.locator('.svelte-flow__node-assistant')).toHaveAttribute('data-id', oldReplyId!)
  await expect(root).toContainText('Conversation')
  await expect(page.getByRole('region', { name: 'Response reader' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this next question.')
})

test('background status keeps explicit save-recovery actions clickable above the canvas', async ({ page, context }) => {
  await setup(page)
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  const second = await context.newPage(); await second.goto('/')
  await expect(second.getByText('Saved on this device', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'New topic', exact: true }).click()
  await expect(second.getByRole('alert')).toContainText('Another tab changed')
  const recover = second.getByRole('button', { name: 'Reload saved state', exact: true })
  await hitTarget(recover)
  second.on('dialog', dialog => dialog.accept()); await recover.click()
  await expect(second.locator('.svelte-flow__node-root')).toHaveCount(1)
  await expect(second.locator('.svelte-flow__node-root')).toContainText('Topic 2')
})

test('successive replies and long messages stay separate and Fit View keeps them above the dock', async ({ page }) => {
  await setup(page)
  await page.locator('.assistant .configuration > summary').click()
  for (const prompt of ['Tell me more.', 'A longer learner message with several lines.\n'.repeat(14)]) {
    const count = await page.locator('.svelte-flow__node-assistant').count()
    await page.getByRole('textbox', { name: 'Message to Zheng' }).fill(prompt)
    if (prompt === 'Tell me more.') await page.getByRole('textbox', { name: 'Message to Zheng' }).press('Control+Enter')
    else await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.svelte-flow__node-assistant')).toHaveCount(count + 1)
    await expect(page.locator('.assistant').last().getByRole('button', { name: 'Read response', exact: true })).toBeVisible()
  }
  const overlaps = () => page.locator('.svelte-flow__node').evaluateAll(elements => {
    const boxes = elements.map(element => element.getBoundingClientRect())
    return boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top))
      .length
  })
  await expect.poll(overlaps).toBe(0)
  await page.getByRole('button', { name: 'Fit View', exact: true }).click()
  await expect.poll(() => page.locator('.svelte-flow__node').evaluateAll(elements => {
    const dock = document.querySelector('.teacher-panel')!.getBoundingClientRect()
    const rail = document.querySelector('.tool-rail')!.getBoundingClientRect()
    return elements.every(element => {
      const box = element.getBoundingClientRect()
      return box.top >= 15 && box.bottom <= dock.top - 15 && box.left >= rail.right + 15 && box.right <= innerWidth - 19
    })
  })).toBe(true)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Keep this draft after fitting.')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  const positions = await page.locator('.svelte-flow__node').evaluateAll(elements => elements.map(element => (element as HTMLElement).style.transform))
  await page.screenshot({ path: 'test-results/conversation-fit-without-overlap.png', fullPage: true })
  await page.reload()
  await expect(page.locator('.assistant .word').last()).toBeVisible()
  await expect.poll(overlaps).toBe(0)
  expect(await page.locator('.svelte-flow__node').evaluateAll(elements => elements.map(element => (element as HTMLElement).style.transform))).toEqual(positions)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep this draft after fitting.')
})

test('dragging a second parent connection leaves the graph saveable, including after unlocking', async ({ page }) => {
  await setup(page)
  await page.locator('.assistant .configuration > summary').click()
  await page.getByRole('button', { name: 'Fit View', exact: true }).click()
  await page.waitForTimeout(300)
  const edgeCount = await page.locator('.svelte-flow__edge').count()
  for (let attempt = 0; attempt < 2; attempt++) {
    const source = (await page.locator('.svelte-flow__node-root .source').boundingBox())!
    const target = (await page.locator('.svelte-flow__node-assistant .target').boundingBox())!
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 })
    await page.mouse.up()
    expect(await page.locator('.svelte-flow__edge').count()).toBe(edgeCount)
    await page.locator('.svelte-flow__controls-interactive').click()
    await page.locator('.svelte-flow__controls-interactive').click()
  }
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Still saveable after dragging.')
  await openTool(page, 'Node tools')
  await expect(page.getByRole('dialog', { name: 'Node tools' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Still saveable after dragging.')
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(edgeCount)
})

test('a short phone toolbar exposes a visible control for reaching Settings', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto('/')
  await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  const more = page.getByRole('button', { name: 'Scroll to more tools', exact: true })
  await expect(more).toBeInViewport({ ratio: 1 })
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const reachable = () => settings.evaluate(element => {
    const box = element.getBoundingClientRect()
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
  })
  expect(await reachable()).toBe(false)
  for (let i = 0; i < 4 && !await reachable(); i++) {
    await more.click()
    await page.waitForTimeout(350)
  }
  await expect.poll(reachable).toBe(true)
  await page.screenshot({ path: 'test-results/phone-more-tools.png', fullPage: true })
  await settings.click()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeFocused()
})
