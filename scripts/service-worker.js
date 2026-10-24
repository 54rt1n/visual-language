/* Build substitutes an immutable inventory. Only this app's shell is cached. */
const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self))
const VERSION = __BUILD_VERSION__
const FILES = __SHELL_FILES__
const SCOPE = new URL(worker.registration.scope)
const PREFIX = `visual-language-shell:${encodeURIComponent(SCOPE.pathname)}:`
const CACHE = `${PREFIX}${VERSION}`
const ASSETS = new Set(FILES.map(file => new URL(file, SCOPE).href))
const INDEX = new URL('index.html', SCOPE).href

async function shellReady() {
  if (!await caches.has(CACHE)) return false
  const cached = new Set((await (await caches.open(CACHE)).keys()).map(request => request.url))
  return [...ASSETS].every(url => cached.has(url))
}

/** @param {Request} request */
async function navigate(request) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  let response
  try {
    response = await fetch(new Request(request, { cache: 'no-store', signal: controller.signal }))
    if (response.ok) return response
  } catch { /* Use the complete saved shell when offline or the host is unavailable. */ }
  finally { clearTimeout(timer) }
  // Keep this cache's HTML and assets together; never overwrite it with a newer page.
  return (await (await caches.open(CACHE)).match(INDEX)) ?? response ?? Response.error()
}

worker.addEventListener('install', event => {
  event.waitUntil((async () => {
    const existing = await caches.has(CACHE)
    try {
      const cache = await caches.open(CACHE)
      await cache.addAll([...ASSETS].map(url => new Request(url, { credentials: 'omit', cache: 'reload' })))
    } catch (error) {
      if (!existing) await caches.delete(CACHE)
      throw error
    }
    // No skipWaiting: another app tab may have an unsaved answer or an old schema.
  })())
})
worker.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const owned = (await caches.keys()).filter(key => key.startsWith(PREFIX) && key !== CACHE)
    // Retain one previous app shell. Never touch unrelated caches, IndexedDB, or keys.
    await Promise.all(owned.slice(0, Math.max(0, owned.length - 1)).map(key => caches.delete(key)))
  })())
})
worker.addEventListener('message', event => {
  if (event.data?.type === 'SHELL_STATUS') event.waitUntil((async () => {
    event.ports[0]?.postMessage({ version: VERSION, ready: await shellReady() })
  })())
})
worker.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== SCOPE.origin || request.headers.has('authorization')) return
  if (request.mode === 'navigate' && (url.pathname === SCOPE.pathname || url.pathname === new URL(INDEX).pathname)) {
    event.respondWith(navigate(request)); return
  }
  if (url.search) return
  const key = url.href
  if (!ASSETS.has(key)) return
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    return (await cache.match(key)) ?? fetch(request)
  })())
})
