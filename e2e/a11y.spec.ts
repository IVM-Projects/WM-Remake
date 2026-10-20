import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// D§8.6 : 0 violation serious ou critical (WCAG 2.2 AA).
async function expectNoSeriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${v.id} : ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

// Contenu rendu après l'hydratation (useSearchParams, session lue par le client) : attendu avant l'analyse.
const READY: Record<string, string> = {
  '/reset-password': 'main [role=alert]', '/verify-email?email=a11y%40test.local': '#signup-otp-code', '/pulls': '[data-stock-bar]',
}

// Animations finies (fondu, pivot de la carte) : axe mesurerait le contraste d'un texte encore à demi transparent.
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
  .map((a) => a.finished.catch(() => null))))

for (const path of ['/', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email?email=a11y%40test.local', '/terms', '/rules',
  'http://127.0.0.1:3101/gate', '/pulls', '/collection']) {
  test(`axe ${path}`, async ({ page, login }) => {
    if (path === '/pulls' || path === '/collection') await login()
    await page.goto(path)
    if (READY[path]) await page.locator(READY[path]).waitFor()
    await settled(page)
    await expectNoSeriousViolations(page)
  })
}

test('axe /pulls mobile, feuille « Plus » ouverte', async ({ page, login }) => {
  await login(); await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Plus' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoSeriousViolations(page)
})

test('axe /pulls en révélation', async ({ page, login }) => {
  await login({ humanVerified: true })
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Ouvrir', exact: true }).click()
  await expect(page.getByText('Carte 1 / 5', { exact: true })).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
})
