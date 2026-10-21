type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

type ShellStatus = { version: string; ready: boolean }
function workerStatus(worker: ServiceWorker, signal: AbortSignal): Promise<ShellStatus | undefined> {
  return new Promise(resolve => {
    const channel = new MessageChannel()
    const finish = (value?: ShellStatus) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancelled)
      channel.port1.close(); channel.port2.close(); resolve(value)
    }
    const cancelled = () => { finish() }
    const timer = setTimeout(cancelled, 2000)
    channel.port1.onmessage = event => { finish(typeof event.data?.version === 'string' && typeof event.data?.ready === 'boolean' ? { version: event.data.version, ready: event.data.ready } : undefined) }
    signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted) { finish(); return }
    try { worker.postMessage({ type: 'SHELL_STATUS' }, [channel.port2]) }
    catch { finish() }
  })
}

/** No activation messages, background paid work, or automatic reloads. */
export class PwaLifecycle {
  installed = $state(false)
  installAvailable = $state(false)
  updateAvailable = $state(false)
  updateNoticeDismissed = $state(true)
  checking = $state(false)
  shell = $state('App shell status has not been checked.')
  message = $state('')
  private promptEvent?: InstallPrompt
  private registration?: ServiceWorkerRegistration
  private noticedWorker?: ServiceWorker
  private noticedVersion?: string
  private updateCheck: Promise<void> = Promise.resolve()
  private refreshUpdate?: () => void
  start() {
    let disposed = false, checkSequence = 0
    const status = new AbortController()
    const watchedWorkers = new Set<ServiceWorker>()
    const display = matchMedia('(display-mode: standalone)')
    const installed = () => { this.installed = display.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone); if (this.installed) this.installAvailable = false }
    const prompt = (event: Event) => { event.preventDefault(); this.promptEvent = event as InstallPrompt; this.installAvailable = true }
    const appInstalled = () => { this.installed = true; this.installAvailable = false; this.promptEvent = undefined }
    const refresh = () => {
      if (disposed || !this.registration) return
      const controller = navigator.serviceWorker.controller
      const candidate = this.registration.waiting
      // First installation and an uncontrolled page are not app updates.
      const waiting = controller && this.registration.active === controller && candidate?.state === 'installed' ? candidate : undefined
      if (waiting !== this.noticedWorker) {
        const sequence = ++checkSequence
        this.noticedWorker = waiting; this.noticedVersion = undefined; this.updateNoticeDismissed = true; this.updateAvailable = false
        this.updateCheck = waiting && controller ? Promise.all([workerStatus(waiting, status.signal), workerStatus(controller, status.signal)]).then(([next, current]) => {
          if (disposed || sequence !== checkSequence || waiting !== this.noticedWorker || controller !== navigator.serviceWorker.controller) return
          this.noticedVersion = next?.version
          this.updateAvailable = Boolean(next?.ready && current && next.version !== current.version)
          try { this.updateNoticeDismissed = !this.updateAvailable || localStorage.getItem(`vl-app-update-dismissed:${this.registration!.scope}`) === next?.version }
          catch { this.updateNoticeDismissed = false }
        }) : Promise.resolve()
      }
      if (!waiting) this.updateAvailable = false
      this.shell = this.registration.active?.state === 'activated' ? 'App shell cache ready. Online services still need a connection.' : this.registration.installing ? 'Preparing the app shell cache…' : 'The shell cache is not ready. Keep this page open while it installs.'
    }
    const updateFound = () => {
      for (const worker of [this.registration?.installing, this.registration?.waiting, this.registration?.active]) {
        if (!worker || watchedWorkers.has(worker)) continue
        watchedWorkers.add(worker); worker.addEventListener('statechange', refresh)
      }
      refresh()
    }
    this.refreshUpdate = refresh
    installed(); display.addEventListener('change', installed)
    window.addEventListener('beforeinstallprompt', prompt); window.addEventListener('appinstalled', appInstalled)
    if (!import.meta.env.PROD) this.shell = 'Development mode: the app shell worker is disabled.'
    else if (!window.isSecureContext || !('serviceWorker' in navigator)) this.shell = 'This browser cannot prepare an app shell here. The loaded workspace still supports local backups.'
    else {
      navigator.serviceWorker.addEventListener('controllerchange', updateFound)
      const base = new URL(import.meta.env.BASE_URL, document.baseURI)
      void navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' }).then(registration => {
        if (disposed) return
        this.registration = registration; registration.addEventListener('updatefound', updateFound); updateFound(); refresh()
        void navigator.serviceWorker.ready.then(() => { if (!disposed) refresh() })
      }).catch(() => { if (!disposed) this.shell = 'The app shell could not be prepared. Your learning database is separate and has not been deleted.' })
    }
    return () => {
      disposed = true; status.abort(); this.refreshUpdate = undefined; display.removeEventListener('change', installed)
      window.removeEventListener('beforeinstallprompt', prompt); window.removeEventListener('appinstalled', appInstalled)
      this.registration?.removeEventListener('updatefound', updateFound)
      for (const worker of watchedWorkers) worker.removeEventListener('statechange', refresh)
      if (window.isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.removeEventListener('controllerchange', updateFound)
    }
  }
  dismissUpdateNotice() {
    this.updateNoticeDismissed = true
    if (!this.registration || !this.noticedVersion) return
    try { localStorage.setItem(`vl-app-update-dismissed:${this.registration.scope}`, this.noticedVersion) }
    catch { /* Dismiss for this visit when browser storage is unavailable. */ }
  }
  async install() {
    if (!this.promptEvent) { this.message = 'Use your browser’s Install app or Add to Home Screen action if available.'; return }
    const prompt = this.promptEvent; this.promptEvent = undefined; this.installAvailable = false
    try { await prompt.prompt(); const choice = await prompt.userChoice; this.message = choice.outcome === 'accepted' ? 'Installation was accepted. You can continue learning here.' : 'Installation dismissed. You can still use the complete web app.' }
    catch { this.message = 'The install prompt is unavailable. Try the browser’s app installation menu.' }
  }
  async checkUpdates() {
    if (this.checking) return
    this.checking = true; this.message = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!this.registration) throw new Error('unavailable')
      await Promise.race([
        this.registration.update(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 15_000) }),
      ])
      this.noticedWorker = undefined
      this.refreshUpdate?.()
      await this.updateCheck
      this.message = this.updateAvailable ? 'An update is ready. Save and pause, then close all app tabs/windows before reopening.' : 'Update check finished. Any downloading update will be offered when ready.'
    } catch { this.message = 'Could not check for an update. Try again when connected.' }
    finally { clearTimeout(timer); this.checking = false }
  }
}
