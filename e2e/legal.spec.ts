import { brand } from '../lib/brand.ts'
import { expect, test } from './fixtures'

const PAGES = [
  ['/terms', 'Conditions d\'utilisation', '2 novembre 2026'],
  ['/rules', 'Règles de la communauté', '31 octobre 2026'],
  ['/privacy', 'Politique de confidentialité', '2 novembre 2026'],
] as const

for (const [path, h1, updated] of PAGES) {
  test(`${path} : titre, sommaire et ancres`, async ({ page }) => {
    await page.goto(path)
    await expect(page.locator('main h1')).toHaveText(h1)
    await expect(page).toHaveTitle(new RegExp(`^${h1} — `))
    await expect(page.getByText(`Dernière mise à jour : ${updated}`, { exact: true })).toBeVisible()
    const links = page.getByRole('navigation', { name: 'Sommaire' }).getByRole('link')
    const n = await links.count()
    await expect(page.locator('article h2')).toHaveCount(n)
    for (let i = 0; i < n; i++) {
      const href = (await links.nth(i).getAttribute('href'))!
      await links.nth(i).click()
      await expect(page.locator(href)).toBeFocused()
      await expect(page.locator(href).getByRole('heading', { level: 2 })).toHaveText(await links.nth(i).innerText())
    }
    for (const name of ['Conditions d\'utilisation', 'Règles de la communauté', 'Confidentialité', 'Crédits']) {
      await expect(page.locator('article footer').getByRole('link', { name, exact: true })).toBeVisible()
    }
  })
}

test('/rules : neuf sections', async ({ page }) => {
  await page.goto('/rules')
  await expect(page.locator('article h2')).toHaveCount(9)
})

test('/terms : mentions légales à compléter, marque et version', async ({ page }) => {
  await page.goto('/terms')
  const mentions = page.locator('section', { has: page.getByRole('heading', { name: 'Mentions légales' }) })
  await expect(mentions.getByText('à compléter')).toHaveCount(5)
  await expect(page.getByText(brand.name).first()).toBeVisible()
  await expect(page.getByText('Version du 2026-11-02')).toBeVisible()
})

test('/privacy : responsable à compléter, CNIL, conservation et droits', async ({ page }) => {
  await page.goto('/privacy')
  const resp = page.locator('section', { has: page.getByRole('heading', { name: 'Responsable du traitement' }) })
  await expect(resp.getByText('à compléter').first()).toBeVisible()
  await expect(page.getByText('CNIL').first()).toBeVisible()
  await expect(page.getByText('dans la mesure du possible')).toBeVisible()
  await expect(page.getByText('Joueur supprimé …').first()).toBeVisible()
  // Conséquences de la suppression, comme dans /settings : batailles et guilde dont on est le seul membre.
  await expect(page.getByText('tes batailles en cours aussi (perdues si elles avaient commencé)', { exact: false })).toBeVisible()
  await expect(page.getByText('si tu en es le seul membre, elle est dissoute', { exact: false })).toBeVisible()
  await expect(page.getByText('suspendu ou banni', { exact: false })).toBeVisible()
})

test('/terms : achats et abonnement Pro (prix, Portail, rétractation, test, compte banni)', async ({ page }) => {
  await page.goto('/terms')
  await expect(page.locator('#achats')).toBeAttached()
  await expect(page.locator('#abonnement')).toBeAttached()
  const abo = page.locator('#abonnement')
  await expect(abo.getByRole('heading', { level: 2 })).toHaveText('Abonnement Pro')
  await expect(abo).toContainText('9,99 CAD')
  await expect(abo).toContainText('Gérer mon abonnement')
  await expect(page.locator('article')).toContainText('rétractation')
  await expect(page.locator('article')).toContainText('banni')
  await expect(page.locator('article')).toContainText('mode test')
})

test('/privacy : Stripe, aucun numéro de carte, e-mail transmis, export', async ({ page }) => {
  await page.goto('/privacy')
  const a = page.locator('article')
  for (const t of ['Stripe', 'aucun numéro de carte', 'e-mail', 'export']) await expect(a).toContainText(t)
})

for (const path of ['/terms', '/privacy']) {
  test(`${path} : aucune promesse de meilleures cotes (C27)`, async ({ page }) => {
    await page.goto(path)
    await expect(page.locator('article')).not.toContainText(/meilleures cotes/i)
  })
}
