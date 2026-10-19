import { defineConfig } from 'vitest/config'

// Contrat HTTP : contract/global-setup.ts démarre le banc (120 s max par processus, voir harness.ts).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['contract/run.test.ts'],
    globalSetup: ['contract/global-setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 120_000,
  },
})
