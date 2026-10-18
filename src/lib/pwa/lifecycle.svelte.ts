type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

/** No activation messages, background paid work, or automatic reloads. */
export class PwaLifecycle {
  installed = $state(false)
  installAvailable = $state(false)
  updateAvailable = $state(false)
  shell = $state('App shell status has not been checked.')
  message = $state('')
  private promptEvent?: InstallPrompt
  private registration?: ServiceWorkerRegistration
  start() {
    let disposed = false
    const display = matchMedia('(display-mode: standalone)')
    const installed = () => { this.installed = display.matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone); if (this.installed) this.installAvailable = false }
    const prompt = (event: Event) => { event.preventDefault(); this.promptEvent = event as InstallPrompt; this.installAvailable = true }
    const appInstalled = () => { this.installed = true; this.installAvailable = false; this.promptEvent = undefined }
    const refresh = () => {
      if (disposed || !this.registration) return
      this.updateAvailable = Boolean(this.registration.waiting)
      this.shell = this.registration.active?.state === 'activated' ? 'App shell cache ready. Online services still need a connection.' : this.registration.installing ? 'Preparing the app shell cache…' : 'The shell cache is not ready. Keep this page open while it installs.'
    }
    const updateFound = () => { const worker = this.registration?.installing; refresh(); worker?.addEventListener('statechange', refresh) }
    installed(); display.addEventListener('change', installed)
    window.addEventListener('beforeinstallprompt', prompt); window.addEventListener('appinstalled', appInstalled)
    if (!import.meta.env.PROD) this.shell = 'Development mode: the app shell worker is disabled.'
    else if (!window.isSecureContext || !('serviceWorker' in navigator)) this.shell = 'This browser cannot prepare an app shell here. The loaded workspace still supports local backups.'
    else {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI)
      void navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname, updateViaCache: 'none' }).then(registration => {
        if (disposed) return
        this.registration = registration; registration.addEventListener('updatefound', updateFound); updateFound(); refresh()
        void navigator.serviceWorker.ready.then(() => { if (!disposed) refresh() })
      }).catch(() => { if (!disposed) this.shell = 'The app shell could not be prepared. Your learning database is separate and has not been deleted.' })
    }
    return () => {
      disposed = true; display.removeEventListener('change', installed)
      window.removeEventListener('beforeinstallprompt', prompt); window.removeEventListener('appinstalled', appInstalled)
      this.registration?.removeEventListener('updatefound', updateFound)
    }
  }
  async install() {
    if (!this.promptEvent) { this.message = 'Use your browser’s Install app or Add to Home Screen action if available.'; return }
    const prompt = this.promptEvent; this.promptEvent = undefined; this.installAvailable = false
    try { await prompt.prompt(); const choice = await prompt.userChoice; this.message = choice.outcome === 'accepted' ? 'Installation was accepted. You can continue learning here.' : 'Installation dismissed. You can still use the complete web app.' }
    catch { this.message = 'The install prompt is unavailable. Try the browser’s app installation menu.' }
  }
  async checkUpdates() {
    try {
      if (!this.registration) throw new Error('unavailable')
      await this.registration.update()
      this.updateAvailable = Boolean(this.registration.waiting)
      this.message = this.updateAvailable ? 'An update is ready. Save and pause, then close all app tabs/windows before reopening.' : 'Update check finished. Any downloading update will be offered when ready.'
    } catch { this.message = 'Could not check for an update. Existing saved work and the current app remain available.' }
  }
}
