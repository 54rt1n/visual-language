import { defineConfig } from '@playwright/test'
import { returningVisitor } from './tests/browser/navigation'

export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4173', storageState: returningVisitor, browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort', url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 30_000 },
})
