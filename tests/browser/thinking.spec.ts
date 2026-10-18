import { openTool } from './navigation'
import { expect, test } from '@playwright/test'

test('thinking is collapsed during streaming and after reload, with keyboard disclosure and unchanged saved content', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const fetchOriginal = window.fetch, encoder = new TextEncoder()
    let stream: ReadableStreamDefaultController<Uint8Array>
    const fixture = window as typeof window & { finishThinkingFixture(): void; thinkingFixtureStarted?: boolean }
    const send = (delta: Record<string, string>, finish_reason: string | null = null) => stream.enqueue(encoder.encode(`data: ${JSON.stringify({ model: 'thinking-fixture', choices: [{ delta, finish_reason }] })}\n\n`))
    fixture.finishThinkingFixture = () => {
      send({ reasoning_content: '\nA second planning note.' }); send({ content: '我想喝咖啡，谢谢。' }, 'stop')
      stream.enqueue(encoder.encode('data: [DONE]\n\n')); stream.close()
    }
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== 'https://thinking-fixture.example/v1/chat/completions') return fetchOriginal(input, init)
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; fixture.thinkingFixtureStarted = true; send({ reasoning_content: 'A synthetic planning note, not the learner response.' }) } }), { headers: { 'content-type': 'text/event-stream' } })
    }
  })
  await page.goto('/'); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
  await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://thinking-fixture.example/v1')
  await page.getByLabel('Model ID', { exact: true }).fill('thinking-fixture')
  await page.getByLabel('Custom endpoint API key').fill('synthetic-thinking-key')
  await page.getByRole('button', { name: 'Save connection' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('A useful sentence, please.')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const disclosure = page.locator('.thinking-disclosure'), summary = disclosure.locator('summary'), thinking = disclosure.locator('.reasoning')
  const configuration = page.locator('.assistant .configuration')
  await expect(configuration).toHaveCount(0); await expect(thinking).toBeHidden()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as typeof window & { thinkingFixtureStarted?: boolean }).thinkingFixtureStarted)).toBe(true)
  await page.evaluate(() => (window as typeof window & { finishThinkingFixture(): void }).finishThinkingFixture())
  await expect(page.locator('.assistant').getByRole('button', { name: 'Explore 咖啡', exact: true })).toBeVisible()
  await expect(configuration).not.toHaveAttribute('open')
  await configuration.locator(':scope > summary').click()
  await expect(summary.getByText('Show thinking', { exact: true })).toBeVisible()
  await expect(disclosure).not.toHaveAttribute('open'); await expect(thinking).toBeHidden()
  await summary.focus(); await page.keyboard.press('Enter')
  await expect(thinking).toBeVisible(); await expect(thinking).toContainText('A second planning note.')
  await expect(summary.getByText('Hide thinking', { exact: true })).toBeVisible()
  await summary.focus(); await page.keyboard.press('Space'); await expect(thinking).toBeHidden()
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Keep my draft.')
  await openTool(page, 'Backup & restore')
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download full backup' }).click()
  const stream = await (await pending).createReadStream(), chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  const saved = JSON.parse(Buffer.concat(chunks).toString()).data
  expect(saved.nodes.find((node: { type: string }) => node.type === 'assistant').data).toMatchObject({ text: '我想喝咖啡，谢谢。', reasoning: 'A synthetic planning note, not the learner response.\nA second planning note.' })
  expect(saved.events).toEqual([])
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await summary.click(); await expect(thinking).toBeVisible()
  await page.reload(); await expect(page.locator('.assistant .word').first()).toBeVisible()
  await expect(configuration).not.toHaveAttribute('open')
  await configuration.locator(':scope > summary').click()
  await expect(disclosure).not.toHaveAttribute('open'); await expect(thinking).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep my draft.')
  await page.screenshot({ path: 'test-results/thinking-collapsed.png', fullPage: true })
  expect(errors).toEqual([])
})
