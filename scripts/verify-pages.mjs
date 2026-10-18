import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { build } from 'vite'
import { chromium } from '@playwright/test'

// A local subpath rehearsal, never a publication or authenticated provider test.
const output = await mkdtemp(join(tmpdir(), 'visual-language-pages-check-'))
const base = '/visual-language/'
let server, browser, candidate = false
const avatarRequests = []
try {
  await build({ base, logLevel: 'error', build: { outDir: output, emptyOutDir: true } })
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      if (!pathname.startsWith(base)) { response.writeHead(404).end(); return }
      // Deliberately unavailable optional artwork must not prevent shell install.
      if (pathname.startsWith(base + 'avatars/')) { avatarRequests.push(pathname); response.writeHead(404).end(); return }
      if (pathname.startsWith(base + 'reading-model/')) { response.writeHead(404).end(); return }
      const file = resolve(output, pathname.slice(base.length) || 'index.html')
      if (!file.startsWith(output + sep)) { response.writeHead(404).end(); return }
      let content = await readFile(file)
      if (candidate && file === join(output, 'sw.js')) content = Buffer.from(content.toString().replace('const VERSION = "', 'const VERSION = "candidate-'))
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }); response.end(content)
    } catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`, url = origin + base
  browser = await chromium.launch()
  const context = await browser.newContext(), page = await context.newPage(), errors = [], external = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (!request.url().startsWith(origin)) external.push(request.url()) })
  await page.goto(url)
  await page.getByText('Saved on this device', { exact: false }).waitFor()
  await page.getByRole('dialog', { name: 'Welcome to Visual Language', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Explore first', exact: true }).click()
  assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), `${base}manifest.webmanifest`)
  const manifest = await (await page.request.get(url + 'manifest.webmanifest')).json()
  for (const property of ['id', 'scope', 'start_url']) assert.equal(new URL(manifest[property], url + 'manifest.webmanifest').href, url)
  for (const icon of manifest.icons) assert.equal((await page.request.get(new URL(icon.src, url + 'manifest.webmanifest').href)).status(), 200)
  const budget = await (await page.request.get(url + 'asset-budget.json')).json()
  assert(budget.shell.bytes <= budget.shell.limit)
  assert(budget.shell.core.bytes <= 1.5 * 1024 * 1024)
  assert(budget.shell.language.bytes > 0 && budget.shell.language.bytes <= 3 * 1024 * 1024)
  assert(budget.shell.meanings.bytes > 0 && budget.shell.meanings.bytes <= 4.25 * 1024 * 1024)
  assert.equal(budget.shell.bytes, budget.shell.core.bytes + budget.shell.language.bytes + budget.shell.meanings.bytes)
  let shellBytes = 0
  for (const entry of budget.shell.files) {
    const content = await readFile(join(output, entry.file)); assert.equal(content.byteLength, entry.bytes); shellBytes += content.byteLength
    assert(!entry.file.startsWith('avatars/'))
    assert(!entry.file.startsWith('reading-model/'))
  }
  assert.equal(shellBytes, budget.shell.bytes)
  assert(budget.tokenizer.bytes > 0 && budget.tokenizer.bytes <= budget.tokenizer.limit)
  let tokenizerBytes = 0
  for (const entry of budget.tokenizer.files) {
    const content = await readFile(join(output, entry.file))
    assert.equal(content.byteLength, entry.bytes); tokenizerBytes += content.byteLength
    assert(!budget.shell.files.some(required => required.file === entry.file))
  }
  assert.equal(tokenizerBytes, budget.tokenizer.bytes)
  assert.equal(budget.pronunciation.bytes, 81_154_648)
  assert(budget.pronunciation.bytes <= budget.pronunciation.limit)
  for (const entry of budget.pronunciation.files) {
    const shipped = await readFile(join(output, budget.pronunciation.directory, entry.file))
    assert.equal(shipped.length, entry.bytes); assert.equal(createHash('sha256').update(shipped).digest('hex'), entry.sha256)
  }
  for (const entry of budget.portraits.files) {
    const original = await readFile(entry.file.replace('avatars/', 'public/avatars/')), shipped = await readFile(join(output, entry.file))
    assert(original.equals(shipped)); assert.equal(createHash('sha256').update(shipped).digest('hex'), entry.sha256)
    assert.equal(shipped.byteLength, entry.bytes); assert(entry.bytes <= budget.portraits.perFileLimit)
  }
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope), url)
  await page.reload()
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL), url + 'sw.js')
  const cached = await page.evaluate(async () => {
    const keys = (await caches.keys()).filter(k => k.startsWith('visual-language-shell:'))
    return (await Promise.all(keys.map(async k => (await (await caches.open(k)).keys()).map(r => r.url)))).flat()
  })
  assert.deepEqual(cached.sort(), budget.shell.files.map(entry => new URL(entry.file, url).href).sort())
  assert(cached.every(entry => entry.startsWith(url))); assert(!cached.some(entry => entry.includes('/avatars/')))
  assert(!cached.some(entry => budget.tokenizer.files.some(file => entry === new URL(file.file, url).href)))
  await page.getByRole('button', { name: 'More tools', exact: true }).click()
  await page.getByRole('button', { name: 'About', exact: true }).click()
  const about = page.getByRole('dialog', { name: 'About Visual Language' })
  await about.waitFor()
  assert.equal(await about.getByRole('link', { name: 'Full dictionary and decompression notices' }).evaluate(link => link.href), url + 'dictionaries/NOTICE.txt')
  assert.equal(await about.getByRole('link', { name: 'Model modifications and source credits' }).evaluate(link => link.href), url + 'reading-model/g2pw-v2-int4-1/NOTICE.txt')
  assert.equal((await page.request.get(url + 'dictionaries/NOTICE.txt')).status(), 200)
  await page.keyboard.press('Escape')
  await about.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Audio & pinyin settings', exact: true }).click()
  const languageSetup = page.getByRole('dialog', { name: 'Audio & pinyin settings', exact: true })
  await languageSetup.waitFor()
  await languageSetup.getByLabel('Instructions for').selectOption('windows')
  assert.equal(await languageSetup.getByRole('link', { name: 'Microsoft voice setup guide' }).evaluate(link => link.href), 'https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-a-supported-languages-and-voices')
  await languageSetup.getByRole('button', { name: 'Recheck voices' }).click()
  await page.keyboard.press('Escape'); await languageSetup.waitFor({ state: 'detached' })
  // This host serves the unchanged gzip as application/octet-stream. Vite preview
  // serves Content-Encoding: gzip instead; production reading tests cover that
  // decoded representation. Exercise the actual worker on both hosting paths.
  const dictionary = JSON.parse(await readFile('src/lib/mandarin/dictionarySnapshot.json', 'utf8'))
  const lookup = await page.evaluate(async ({ workerUrl, dictionaryUrl }) => {
    const worker = new Worker(workerUrl, { type: 'module' })
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Dictionary worker did not complete.')), 10_000)
        worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)) }
        worker.onmessage = event => {
          if (event.data.type === 'ready') worker.postMessage({ type: 'lookup', id: 1, text: '圖書館' })
          else if (event.data.type === 'result') { clearTimeout(timeout); resolve(event.data.result) }
          else { clearTimeout(timeout); reject(new Error('Dictionary worker rejected the raw gzip asset.')) }
        }
        worker.postMessage({ type: 'load', url: dictionaryUrl })
      })
    } finally { worker.terminate() }
  }, { workerUrl: new URL(budget.shell.files.find(entry => entry.file.includes('dictionary.worker')).file, url).href, dictionaryUrl: new URL(`dictionaries/${dictionary.file}`, url).href })
  assert(lookup.entries.some(entry => entry.senses.includes('library')))
  await page.getByText('Portrait unavailable', { exact: true }).waitFor()
  assert(avatarRequests.length > 0); assert(avatarRequests.every(path => path.endsWith('/attentive-v1.png')))
  await page.getByRole('textbox', { name: 'Message to Zheng' }).fill('Keep this pending draft through the update.')
  const documentIdentity = await page.evaluate(() => performance.timeOrigin)
  candidate = true
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update() })
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed')
  assert.equal(await page.evaluate(() => performance.timeOrigin), documentIdentity)
  assert.equal(await page.getByRole('textbox', { name: 'Message to Zheng' }).inputValue(), 'Keep this pending draft through the update.')
  await page.getByRole('button', { name: 'App update ready', exact: true }).click()
  await page.getByRole('button', { name: 'Save & prepare to update' }).click()
  await page.getByRole('status').filter({ hasText: 'Drafts are saved' }).waitFor()
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting.state), 'installed')
  await page.close() // Explicitly close the last app window, as the update UI instructs.
  const reopened = await context.newPage()
  await reopened.goto(url)
  await reopened.getByText('Saved on this device', { exact: false }).waitFor()
  assert.equal(await reopened.getByRole('textbox', { name: 'Message to Zheng' }).inputValue(), 'Keep this pending draft through the update.')
  const version = await reopened.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready, channel = new MessageChannel()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Shell status timed out')), 5000)
      channel.port1.onmessage = event => { clearTimeout(timeout); resolve(event.data.version) }
      registration.active.postMessage({ type: 'SHELL_STATUS' }, [channel.port2])
    })
  })
  assert(String(version).startsWith('candidate-'))
  assert.equal(await reopened.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('visual-language-shell:')).length), 2)
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
  console.log(`Pages subpath rehearsal passed: exact ${budget.shell.bytes}-byte shell inventory without portrait precache, preserved masters, install despite missing artwork, scoped manifest/icons/About credits, waiting update and recovered draft. No deployment or live provider calls.`)
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  // Exact temporary build directory created above; never the user's workspace.
  await rm(output, { recursive: true, force: true })
}
