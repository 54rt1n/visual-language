import { openTool, prepareTool } from './navigation'
import { expect, test, type Page } from '@playwright/test'

type Voice = { name: string; lang: string; localService: boolean; default: boolean; voiceURI: string }
declare global {
  interface Window {
    languageAudioFixture: { voices: Voice[]; online: boolean; error: boolean; utterances: { text: string; voice: string; rate: number }[]; cancels: number; latest?: SpeechSynthesisUtterance }
  }
}
const voice = (name: string, lang: string, localService = true): Voice => ({ name, lang, localService, default: false, voiceURI: name })
const english = voice('English voice', 'en-US'), mandarin = voice('Microsoft Huihui', 'zh-CN'), remote = voice('Online Mandarin', 'cmn-CN', false)

async function installSpeechFixture(page: Page, voices: Voice[] = [], supported = true, unknownDevice = false) {
  await page.addInitScript(({ voices, supported, unknownDevice }) => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: unknownDevice ? 'UnknownAgent' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36' })
    Object.defineProperty(navigator, 'platform', { configurable: true, value: unknownDevice ? '' : 'Win32' })
    Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined })
    const state = window.languageAudioFixture = { voices, online: true, error: false, utterances: [], cancels: 0 } as Window['languageAudioFixture']
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => state.online })
    class Speech extends EventTarget {
      getVoices() { if (state.error) throw new Error('fixture voice service unavailable'); return state.voices }
      cancel() {
        state.cancels++
        const utterance = state.latest; state.latest = undefined
        utterance?.onerror?.call(utterance, new Event('error') as SpeechSynthesisErrorEvent)
      }
      speak(utterance: SpeechSynthesisUtterance) { state.latest = utterance; state.utterances.push({ text: utterance.text, voice: utterance.voice?.name || '', rate: utterance.rate }) }
    }
    class Utterance {
      text: string; voice = null; lang = ''; rate = 1; pitch = 1; onend = null; onerror = null
      constructor(text: string) { this.text = text }
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: supported ? new Speech() : undefined })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: supported ? Utterance : undefined })
  }, { voices, supported, unknownDevice })
}
async function ready(page: Page) {
  await page.goto('/'); await expect(page.getByText('Saved on this device', { exact: false })).toBeVisible()
}
async function setVoices(page: Page, voices: Voice[], event = 'voiceschanged') {
  await page.evaluate(({ voices, event }) => {
    window.languageAudioFixture.voices = voices
    if (event === 'voiceschanged') window.speechSynthesis.dispatchEvent(new Event(event))
    else if (event) window.dispatchEvent(new Event(event))
  }, { voices, event })
}
async function finishAudio(page: Page, error = false) {
  await page.evaluate(error => {
    const utterance = window.languageAudioFixture.latest!
    if (error) utterance.onerror?.call(utterance, new Event('error') as SpeechSynthesisErrorEvent)
    else utterance.onend?.call(utterance, new Event('end') as SpeechSynthesisEvent)
  }, error)
}
async function openReader(page: Page) {
  await page.route('https://language-fixture.example/v1/chat/completions', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: '我想喝咖啡。好的，多少钱？谢谢。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` }))
  await ready(page); await openTool(page, 'AI connection')
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('custom')
  await page.getByLabel('API endpoint').fill('https://language-fixture.example/v1')
  await page.getByLabel('Model ID', { exact: true }).fill('language-fixture')
  await page.getByLabel('Custom endpoint API key').fill('synthetic-language-key')
  await page.getByRole('button', { name: 'Save connection' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Help me read.'); await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.locator('.assistant').getByRole('button', { name: 'Read response', exact: true }).click()
  return page.getByRole('region', { name: 'Response reader' })
}

test('language setup detects Windows/Chrome and updates voice diagnostics without requests or automatic playback', async ({ page }) => {
  await installSpeechFixture(page, [english, voice('Cantonese', 'zh-HK')])
  const errors: string[] = [], external: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173')) external.push(request.url()) })
  await ready(page)
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Keep my question.')
  const viewport = await page.locator('.svelte-flow__viewport').getAttribute('style')
  const trigger = await prepareTool(page, 'Audio & pinyin settings')
  await trigger.focus(); await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused()
  await expect(dialog).toContainText('Chrome / Chromium on Windows')
  await expect(dialog.getByLabel('Instructions for')).toHaveValue('windows')
  await expect(dialog).toContainText('Manage voices')
  await expect(dialog.getByRole('region', { name: 'Mandarin audio status' })).toContainText('2 voices reported · 0 Mandarin')
  await expect(dialog.getByRole('button', { name: 'Test Mandarin audio' })).toBeDisabled()
  await page.screenshot({ path: 'test-results/language-setup-windows.png', fullPage: true })
  await dialog.getByLabel('Instructions for').selectOption('macos')
  await expect(dialog).toContainText('System Settings → Accessibility → Read & Speak')
  await expect(dialog).toContainText('Chrome / Chromium on Windows')
  await dialog.getByLabel('Instructions for').selectOption('windows')
  await setVoices(page, [english, mandarin], '')
  await dialog.getByRole('button', { name: 'Recheck voices' }).click()
  await expect(dialog).toContainText('Mandarin voice available')
  await expect(dialog.getByRole('button', { name: 'Test Mandarin audio' })).toBeEnabled()
  expect(await page.evaluate(() => window.languageAudioFixture.utterances)).toEqual([])
  await dialog.getByRole('button', { name: 'Test Mandarin audio' }).click()
  await expect(dialog.getByRole('button', { name: 'Stop test audio' })).toBeVisible()
  expect(await page.evaluate(() => window.languageAudioFixture.utterances)).toEqual([{ text: '你好，我们开始学习吧。', voice: 'Microsoft Huihui', rate: 0.7 }])
  await finishAudio(page); await expect(dialog).toContainText('The browser reported playback finished.')
  await setVoices(page, [])
  await expect(dialog).toContainText('Waiting for browser voices')
  await expect(dialog).toContainText('does not prove that no voices are installed')
  await setVoices(page, [remote])
  await page.evaluate(() => { window.languageAudioFixture.online = false; window.dispatchEvent(new Event('offline')) })
  await expect(dialog).toContainText('Mandarin voice needs a connection')
  await expect(dialog.getByRole('button', { name: 'Test Mandarin audio' })).toBeDisabled()
  await page.evaluate(() => { window.languageAudioFixture.online = true; window.dispatchEvent(new Event('online')) })
  await expect(dialog.getByRole('button', { name: 'Test Mandarin audio' })).toBeEnabled()
  await expect(dialog).toContainText('browser’s online speech service')
  await page.evaluate(() => { window.languageAudioFixture.error = true; window.dispatchEvent(new Event('focus')) })
  await expect(dialog).toContainText('Voice check failed')
  await page.evaluate(() => { window.languageAudioFixture.error = false; window.dispatchEvent(new Event('focus')) })
  await expect(dialog).toContainText('Mandarin voice available')
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused()
  expect(await page.locator('.svelte-flow__viewport').getAttribute('style')).toBe(viewport)
  await expect(page.getByRole('textbox', { name: 'Message to Zheng' })).toHaveValue('Keep my question.')
  expect(external).toEqual([]); expect(errors).toEqual([])
})

test('audio setup preserves the capture form draft and focus, and re-enables playback on return', async ({ page }) => {
  await installSpeechFixture(page, [english]); await ready(page)
  await page.getByRole('button', { name: 'Save for practice', exact: true }).click()
  const capture = page.getByRole('dialog', { name: 'Save for practice', exact: true })
  await capture.getByLabel('Mandarin word or phrase').fill('咖啡')
  await capture.getByLabel('Meaning in this context').fill('my unsaved meaning')
  await capture.getByRole('button', { name: 'Mandarin audio settings', exact: true }).click()
  const setup = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  await expect(setup).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(2)
  await setVoices(page, [mandarin], 'focus')
  await page.keyboard.press('Escape')
  await expect(capture.getByLabel('Mandarin word or phrase')).toHaveValue('咖啡')
  await expect(capture.getByLabel('Meaning in this context')).toHaveValue('my unsaved meaning')
  await expect(capture.getByRole('button', { name: 'Play Mandarin audio' })).toBeEnabled()
  expect(await capture.evaluate(element => element.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => localStorage.getItem('vl-settings-v2'))).toBeNull()
})

test('voice and speaking speed choices persist and control browser playback', async ({ page }) => {
  const alternate = voice('Microsoft Xiaoxiao', 'zh-CN')
  await installSpeechFixture(page, [mandarin, alternate]); await ready(page)
  await openTool(page, 'Audio & pinyin settings')
  let dialog = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  await dialog.getByLabel('Playback voice', { exact: true }).selectOption(alternate.voiceURI)
  await dialog.getByLabel('Speaking speed', { exact: true }).fill('0.55')
  await dialog.getByLabel('Speaking speed', { exact: true }).press('Tab')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vl-speech-v1')!))).toEqual({ voiceURI: alternate.voiceURI, rate: 0.55 })
  await dialog.getByRole('button', { name: 'Test Mandarin audio' }).click()
  expect((await page.evaluate(() => window.languageAudioFixture.utterances)).at(-1)).toEqual({ text: '你好，我们开始学习吧。', voice: alternate.name, rate: 0.55 })
  await finishAudio(page); await page.keyboard.press('Escape')
  await openTool(page, 'Audio & pinyin settings'); dialog = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  await expect(dialog.getByLabel('Playback voice', { exact: true })).toHaveValue(alternate.voiceURI)
  await expect(dialog.getByLabel('Speaking speed', { exact: true })).toHaveValue('0.55')
})

test('pinyin starts visible and its Settings switch persists across reloads and readers', async ({ page }) => {
  const reader = await openReader(page), node = page.locator('.assistant')
  await expect(node.locator('rt').first()).toBeVisible()
  await expect(reader.locator('rt').first()).toBeVisible()
  await reader.getByRole('button', { name: 'Close response reader' }).click()
  await page.setViewportSize({ width: 390, height: 568 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const toggle = page.getByRole('checkbox', { name: 'Show pinyin by default', exact: true })
  await expect(toggle).toBeChecked()
  await toggle.uncheck(); await expect(toggle).toBeEnabled()
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(node.locator('rt')).toHaveCount(0)
  await node.getByRole('button', { name: 'Read response', exact: true }).click()
  await expect(reader.locator('rt')).toHaveCount(0)
  await reader.getByRole('button', { name: 'Close response reader' }).click()
  await page.reload(); await expect(node.locator('.word').first()).toBeVisible()
  await expect(node.locator('rt')).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(toggle).not.toBeChecked()
  await toggle.check(); await expect(toggle).toBeEnabled()
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(node.locator('rt').first()).toBeVisible()
  await node.getByRole('button', { name: 'Read response', exact: true }).click()
  await expect(reader.locator('rt').first()).toBeVisible()
})

test('word definitions leave full-response audio playing and word audio resumes when it stops', async ({ page }) => {
  await installSpeechFixture(page, [mandarin])
  const reader = await openReader(page), header = reader.locator('header')
  const play = header.getByRole('button', { name: 'Play full response', exact: true })
  await expect(play).toBeVisible(); await expect(header.getByText(/Audio problem|Speech playback|Mandarin audio settings/)).toHaveCount(0)
  await play.click()
  await expect(header.getByRole('button', { name: 'Stop full response', exact: true })).toBeVisible()
  const playing = await page.evaluate(() => ({ utterances: window.languageAudioFixture.utterances, cancels: window.languageAudioFixture.cancels }))
  expect(playing.utterances.at(-1)?.text).toBe('我想喝咖啡。好的，多少钱？谢谢。')
  await expect(header).toContainText('Playback will continue.')
  await reader.getByRole('button', { name: 'Explore 咖啡', exact: true }).click()
  await expect(header.getByText(/Audio problem|Speech playback|Mandarin audio settings/)).toHaveCount(0)
  await expect(reader.getByRole('region', { name: 'Selected word definition' })).toContainText('(loanword) coffee')
  await expect(reader.getByRole('region', { name: 'Word details' })).toHaveCount(0)
  await reader.getByRole('button', { name: 'Explore 好的', exact: true }).press('Enter')
  await expect(reader.getByRole('region', { name: 'Selected word definition' })).toContainText('好 — good; appropriate; proper; all right!')
  await expect(reader.getByRole('region', { name: 'Selected word definition' })).toContainText('的 — attributive or sentence particle')
  await reader.getByRole('button', { name: 'Explore 多少钱', exact: true }).click()
  await expect(reader.getByRole('region', { name: 'Selected word definition' })).toContainText('多少 — number; amount; somewhat; how much?; how many?')
  await expect(reader.getByRole('region', { name: 'Selected word definition' })).toContainText('钱 — coin; money')
  expect(await page.evaluate(() => ({ utterances: window.languageAudioFixture.utterances, cancels: window.languageAudioFixture.cancels }))).toEqual(playing)
  await expect(header.getByRole('button', { name: 'Stop full response', exact: true })).toBeVisible()
  await finishAudio(page)
  await expect(play).toBeVisible()
  await reader.getByRole('button', { name: 'Play 咖啡', exact: true }).click()
  expect((await page.evaluate(() => window.languageAudioFixture.utterances)).at(-1)?.text).toBe('咖啡')
  await expect(reader.locator('.reading-status')).toContainText('Playing 咖啡…')
  // Explicit full playback can still take over word audio, then stop normally.
  await play.click()
  await expect(reader.locator('.reading-status')).not.toContainText('Playing 咖啡…')
  await header.getByRole('button', { name: 'Stop full response', exact: true }).click()
  await expect(play).toBeVisible()
  expect(await page.evaluate(() => window.languageAudioFixture.latest === undefined)).toBe(true)
  await reader.getByRole('button', { name: 'Play 好的', exact: true }).click()
  expect((await page.evaluate(() => window.languageAudioFixture.utterances)).at(-1)?.text).toBe('好的')
  await finishAudio(page)
})

test('setup remains usable offline on short screens with no speech API and unknown device information', async ({ page, context }) => {
  await installSpeechFixture(page, [], false, true); await ready(page)
  await page.evaluate(async () => { await navigator.serviceWorker.ready }); await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await context.setOffline(true); await page.reload()
  await page.evaluate(() => { window.languageAudioFixture.online = false; window.dispatchEvent(new Event('offline')) })
  const external: string[] = []
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4173') || request.url().includes('/reading-model/')) external.push(request.url()) })
  for (const [width, height] of [[320, 568], [568, 320]]) {
    await page.setViewportSize({ width: width!, height: height! })
    await openTool(page, 'Audio & pinyin settings')
    const dialog = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
    await expect(dialog).toContainText('Unknown browser on Other / not detected')
    await expect(dialog).toContainText('Browser speech is unavailable')
    await expect(dialog.getByRole('region', { name: 'Mandarin audio status' })).toContainText('Offline')
    await dialog.getByLabel('Instructions for').selectOption('windows')
    await expect(dialog).toContainText('Manage voices')
    for (const name of ['Close dialog', 'Recheck voices', 'Test Mandarin audio']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth && element.querySelector('.modal-body')!.scrollWidth <= element.querySelector('.modal-body')!.clientWidth)).toBe(true)
    await page.screenshot({ path: `test-results/language-setup-${width}.png`, fullPage: true })
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  }
  expect(external).toEqual([])
})

test('sample playback exposes failure and stop, and closing setup cancels only its running test', async ({ page }) => {
  await installSpeechFixture(page, [mandarin]); await ready(page)
  await openTool(page, 'Audio & pinyin settings')
  const dialog = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  await dialog.getByRole('button', { name: 'Test Mandarin audio' }).click()
  await finishAudio(page, true); await expect(dialog).toContainText('Speech playback was unavailable or interrupted.')
  await dialog.getByRole('button', { name: 'Test Mandarin audio' }).click()
  await dialog.getByRole('button', { name: 'Stop test audio' }).click()
  await expect(dialog).toContainText('Sample stopped.')
  await dialog.getByRole('button', { name: 'Test Mandarin audio' }).click()
  const before = await page.evaluate(() => window.languageAudioFixture.cancels)
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0)
  expect(await page.evaluate(() => window.languageAudioFixture.cancels)).toBe(before + 1)
  await openTool(page, 'Audio & pinyin settings'); await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.languageAudioFixture.cancels)).toBe(before + 1)
})

test('online voice disclosure and completed playback cannot push controls off a short landscape screen', async ({ page }) => {
  await installSpeechFixture(page, [remote]); await ready(page)
  await page.setViewportSize({ width: 568, height: 320 })
  await openTool(page, 'Audio & pinyin settings')
  const dialog = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  await dialog.getByRole('button', { name: 'Test Mandarin audio' }).click(); await finishAudio(page)
  await expect(dialog).toContainText('The browser reported playback finished.')
  for (const name of ['Close dialog', 'Recheck voices', 'Test Mandarin audio']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
  const body = dialog.locator('.modal-body')
  expect(await body.evaluate(element => element.clientHeight)).toBeGreaterThan(40)
  await dialog.getByRole('link', { name: 'Microsoft voice setup guide' }).scrollIntoViewIfNeeded()
  await expect(dialog.getByRole('link', { name: 'Microsoft voice setup guide' })).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: 'test-results/language-setup-online-568.png', fullPage: true })
})
