import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const UID = '00000000-0000-0000-0000-0000000000a2'

// D§8.6 : 0 violation serious ou critical (WCAG 2.2 AA).
async function expectNoSeriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${v.id} : ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
}

for (const path of ['/', '/login', 'http://127.0.0.1:3101/gate', '/pulls', '/collection']) {
  test(`axe ${path}`, async ({ page, login }) => {
    if (path === '/pulls' || path === '/collection') await login(UID)
    await page.goto(path)
    await expectNoSeriousViolations(page)
  })
}

test('axe /pulls mobile, feuille « Plus » ouverte', async ({ page, login }) => {
  await login(UID); await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Plus' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoSeriousViolations(page)
})
