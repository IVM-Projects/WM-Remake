import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, makePlayer, sql, test } from './fixtures'

type Known = { rule: string; selector: string }

// D§8.6 : 0 violation serious ou critical (WCAG 2.2 AA). `known` tolère une seule règle sur les seuls nœuds d'un sélecteur.
async function expectNoSeriousViolations(page: Page, known?: Known) {
  // Fondus et transitions de couleur finis avant chaque analyse : en CI, axe lisait un bouton à mi-chemin vers l'accent.
  await settled(page)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const serious: string[] = []
  for (const v of violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
    const nodes: string[] = []
    for (const n of v.nodes) {
      const target = n.target.join(' ')
      const tolerated = known?.rule === v.id && await page.locator(target).evaluate((el, s) => el.matches(s), known.selector)
      if (!tolerated) nodes.push(target)
    }
    if (nodes.length) serious.push(`${v.id} : ${nodes.join(' | ')}`)
  }
  expect(serious).toEqual([])
}

// R21 : écart de contrat connu, consigné pour le M7 (parity/allowed-diffs) — le DOM de R§6.5 `[role=listbox] li[role=option] button`
// fait lever nested-interactive à axe tant que la liste est ouverte (boutons hors tabulation, clavier par aria-activedescendant).
const TAG_OPTION: Known = { rule: 'nested-interactive', selector: '[role=listbox] li[role=option]' }

// Contenu rendu après l'hydratation (sessionStorage, session lue par le client) : attendu avant l'analyse.
const READY: Record<string, string> = {
  '/reset-password': 'main [role=alert]', '/verify-email': '#signup-otp-code', '/pulls': '[data-stock-bar]',
  '/collection': 'main a[href="/pulls"]', '/global-collection': 'main nav[aria-label="Pagination"]',
  // Les deux lectures de /settings finies : pseudo et préférences.
  '/settings': 'main:has(#settings-username) input[name="sounds"]',
}

// Animations finies (fondu, pivot de la carte) : axe mesurerait le contraste d'un texte encore à demi transparent.
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
  .map((a) => a.finished.catch(() => null))))

for (const path of ['/', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/terms', '/rules', '/credits',
  'http://127.0.0.1:3101/gate', '/pulls', '/collection', '/global-collection', '/settings']) {
  test(`axe ${path}`, async ({ page, login }) => {
    if (['/pulls', '/collection', '/global-collection', '/settings'].includes(path)) await login()
    // Adresse posée par /login (compte non confirmé) dans sessionStorage, jamais dans l'URL.
    if (path === '/verify-email') await page.addInitScript(() => sessionStorage.setItem('wm.verifyEmail', 'a11y@test.local'))
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

// Collection garnie : une copie de chaque rareté (2 de C), pour que la grille, les pastilles et la modale aient de quoi s'afficher.
async function collection(page: Page, login: () => Promise<{ uid: string }>) {
  const { uid } = await login()
  sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards
where right(wikipedia_title, 4) in ('0001', '0007', '0031', '0121', '0401', '1001', '1002')`, { uid })
  await page.goto('/collection')
  await expect(page.locator('div.relative.isolate.group')).toHaveCount(7)
  await settled(page)
}

test('axe /collection : grille, pastille de rareté active, sélection', async ({ page, login }) => {
  await collection(page, login)
  await expectNoSeriousViolations(page)
  // Un filtre posé : les autres pastilles passent à l'état inactif.
  await page.getByRole('button', { name: 'L', exact: true }).click()
  await expect(page.locator('div.relative.isolate.group')).toHaveCount(1)
  await expectNoSeriousViolations(page)
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expectNoSeriousViolations(page)
  // Confirmation de la défausse en masse ouverte (bouton rouge, D§8.6).
  await page.getByRole('button', { name: 'Défausser', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Défausser 1 carte ?' })).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
})

test('axe /collection, modale de carte ouverte', async ({ page, login }) => {
  await collection(page, login)
  await page.locator('div.relative.isolate.group h3 button').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
})

test('axe /collection, liste d\'étiquettes ouverte', async ({ page, login }) => {
  await collection(page, login)
  await page.locator('div.relative.isolate.group h3 button').first().click()
  await page.getByPlaceholder('Ajouter une étiquette…').fill('t')
  await expect(page.getByRole('listbox')).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page, TAG_OPTION)
})

test('axe /global-collection : modale de carte ouverte, liste de souhaits vide, recherche active', async ({ page, login }) => {
  await login()
  await page.goto('/global-collection')
  const cards = page.locator('main div.flex.flex-wrap.justify-center.gap-3 > div[class*="glow-"]')
  await expect(cards).toHaveCount(50)
  await cards.first().locator('h3 button').click()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Ajouter à ma liste de souhaits' })).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
  await page.keyboard.press('Escape')
  // Bascule pressée (plein émeraude) et état vide de la liste.
  await page.getByRole('button', { name: 'Liste de souhaits', exact: true }).click()
  await expect(page.getByText('Ta liste de souhaits est vide', { exact: true })).toBeVisible()
  await expectNoSeriousViolations(page)
  await page.getByRole('searchbox', { name: 'Rechercher une carte' }).fill('x')
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click()
  await expect(page.locator('main').getByRole('alert')).toBeVisible()
  await expectNoSeriousViolations(page)
})

test('axe /settings : erreurs affichées (pseudo pris, mots de passe différents)', async ({ page, login }) => {
  await login()
  const { username } = makePlayer()
  await page.goto('/settings')
  await page.getByLabel('Pseudo', { exact: true }).fill(username)
  await page.getByLabel('Pseudo', { exact: true }).blur()
  await expect(page.getByText('Ce pseudo est déjà pris', { exact: true })).toBeVisible()
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('abcdef')
  await page.getByLabel('Confirme le nouveau mot de passe').fill('abcdeg')
  await page.getByRole('button', { name: 'Changer le mot de passe' }).click()
  await expect(page.getByText('Les deux mots de passe ne correspondent pas.', { exact: true })).toBeVisible()
  await expect(page.locator('input[name="sounds"]')).toBeVisible()
  await expectNoSeriousViolations(page)
})
