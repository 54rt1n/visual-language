import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: { __VL_TEST_KEYS__: '{}' },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node', restoreMocks: true },
})
