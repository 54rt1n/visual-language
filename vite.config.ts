import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { pwaPlugin } from './scripts/pwa-plugin'
import { developmentProviderKeys } from './src/lib/ai/providers'

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const testKeys = command === 'serve' && mode === 'development' ? developmentProviderKeys(env) : {}
  return {
    plugins: [svelte(), pwaPlugin()],
    base: env.PUBLIC_BASE_PATH || './',
    // No wildcard VITE_* injection: a mistakenly configured VITE_*_API_KEY must not leak.
    envPrefix: '__NO_PUBLIC_ENV_AUTO_INJECTION__',
    define: { __VL_TEST_KEYS__: JSON.stringify(testKeys) },
    build: { rollupOptions: { output: { manualChunks: id => id.includes('/node_modules/@pinyin-pro/data/') ? 'mandarin-lexicon' : id.includes('/node_modules/pinyin-pro/') ? 'mandarin-pinyin' : undefined } } },
  }
})
