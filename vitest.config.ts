import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    // e2e = Playwright ; contract/run.test.ts a besoin des serveurs de vitest.contract.config.ts
    exclude: [...configDefaults.exclude, 'e2e/**', 'contract/run.test.ts'],
  },
})
