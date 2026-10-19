import { defineConfig } from '@playwright/test'

// Banc de contrat (contract/serve.ts) : 3100 sans porte, 3101 avec porte. Exige un `npm run build:test` préalable.
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  // CI : rapport HTML dans playwright-report/, téléversé en artefact si le job échoue.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    // Bac à sable : chromium préinstallé (/opt/pw-browsers/chromium-*/chrome-linux/chrome) ; CI : `npx playwright install chromium`.
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH },
  },
  webServer: {
    command: 'node contract/serve.ts',
    // 3101 (exemptée de la porte) démarre après 3100 : l'attendre garantit les deux serveurs.
    url: 'http://127.0.0.1:3101/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // serve.ts arrête PostgREST, Next et le postmaster sur SIGTERM ; sinon postgres survit au run.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
})
