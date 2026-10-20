import type { Page } from '@playwright/test'
import { expect, sql, test } from './fixtures'

// 60 copies des cartes n° 0001 à 0060 du seed (L 1–6, UR 7–30, SR 31–60), la plus récente = le plus grand numéro.
// Tri par rareté : page 1 = L 6…1, UR 30…7, SR 60…41 ; page 2 = SR 40…31, dont n° 0031 en 3 exemplaires.
function seed60(uid: string) {
  sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def, count, obtained_at)
select :'uid', id, wikipedia_title, rarity, category, atk, def, case when right(wikipedia_title, 4) = '0031' then 3 else 1 end,
  now() - (61 - right(wikipedia_title, 4)::int) * interval '1 minute'
from public.cards where wikipedia_title between 'Article d''essai n° 0001' and 'Article d''essai n° 0060'`, { uid })
}

const title = (n: number) => `Article d'essai n° ${String(n).padStart(4, '0')}`
const grid = (page: Page) => page.locator('div.flex.flex-wrap.justify-center.gap-3')
const tiles = (page: Page) => grid(page).locator('> div.relative.isolate.group')
const tile = (page: Page, n: number) => tiles(page).filter({ has: page.locator('h3').getByText(title(n), { exact: true }) })
// Bouton clavier de la tuile (h3 > button[aria-label=titre]) : c'est lui qui ouvre la modale et reçoit le focus.
const opener = (page: Page, n: number) => tile(page, n).getByRole('button', { name: title(n), exact: true })
const balance = (page: Page) => page.locator('main h1 + p')
const tagFilter = (page: Page) => page.getByRole('combobox', { name: 'Filtrer par étiquette' })
const firstTitles = async (page: Page, k: number) => (await tiles(page).locator('h3').allTextContents()).slice(0, k)

test('grille et pagination', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  await expect(page.locator('main h1')).toHaveText('Collection')
  await expect(tiles(page)).toHaveCount(50)
  await expect(page.getByText('Page 1 / 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Suivant' }).click()
  await expect(tiles(page)).toHaveCount(10)
  await expect(page.getByText('Page 2 / 2', { exact: true })).toBeVisible()
  await expect(tile(page, 31)).toContainText('x3')
  await expect(page).toHaveURL(/[?&]page=1(&|$)/)
  await page.getByRole('button', { name: 'Précédent' }).click()
  await expect(tiles(page)).toHaveCount(50)
})

test('recherche : focus au chargement, filtrage serveur avec délai', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  const search = page.locator('input[placeholder="Rechercher par titre ou catégorie..."]')
  await expect(search).toBeFocused()
  await expect(tiles(page)).toHaveCount(50)
  const qs: (string | null)[] = []
  page.on('request', (r) => { if (r.url().includes('/api/my-collection?')) qs.push(new URL(r.url()).searchParams.get('q')) })
  await search.pressSequentially('n° 0001')
  await expect(tiles(page)).toHaveCount(1)
  // Une seule requête après la frappe (délai), avec le texte entier.
  expect(qs).toEqual(['n° 0001'])
  await expect(tiles(page).locator('h3')).toHaveText(title(1))
  // L'adresse garde la recherche : le rechargement la retrouve.
  await page.reload()
  await expect(search).toHaveValue('n° 0001')
  await expect(tiles(page)).toHaveCount(1)
})

test('tri et rareté, gardés dans l\'adresse', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  const sort = page.getByRole('combobox', { name: 'Trier les cartes' })
  await expect(sort.locator('option:checked')).toHaveText('Rareté')
  await expect(tiles(page)).toHaveCount(50)
  expect(await firstTitles(page, 3)).toEqual([title(6), title(5), title(4)])
  await sort.selectOption({ label: 'Nom' })
  await expect(tiles(page).first().locator('h3')).toHaveText(title(1))
  expect(await firstTitles(page, 3)).toEqual([title(1), title(2), title(3)])

  await page.getByRole('button', { name: 'L', exact: true }).click()
  await expect(page.getByRole('button', { name: 'L', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(tiles(page)).toHaveCount(6)
  await expect(tiles(page).locator('div.absolute.top-2.left-2')).toHaveText(Array(6).fill('L'))

  await page.reload()
  await expect(tiles(page)).toHaveCount(6)
  await expect(sort.locator('option:checked')).toHaveText('Nom')
  // Retour : l'état d'avant la pastille (tri par nom, toutes les raretés).
  await page.goBack()
  await expect(tiles(page)).toHaveCount(50)
  await expect(tiles(page).first().locator('h3')).toHaveText(title(1))
})

test('étiquette depuis la modale, Échap et retour du focus, filtre, retrait', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  await opener(page, 5).click()
  const dialog = page.getByRole('dialog', { name: title(5) })
  await expect(dialog).toBeVisible()
  const field = dialog.getByPlaceholder('Ajouter une étiquette…')
  await field.fill('test')
  await field.press('Enter')
  await expect(dialog.getByText('#test', { exact: true })).toBeVisible()

  // R18 (a) : Échap ferme la modale et rend le focus à la tuile d'origine.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener(page, 5)).toBeFocused()

  await expect(tagFilter(page).locator('option:checked')).toHaveText('Toutes les étiquettes')
  await expect(tagFilter(page).locator('option', { hasText: 'test (1)' })).toHaveCount(1)
  await tagFilter(page).selectOption({ label: 'test (1)' })
  await expect(tiles(page)).toHaveCount(1)
  await expect(tiles(page).locator('h3')).toHaveText(title(5))

  // R18 (c) : « Retirer l'étiquette test » retire la puce.
  await opener(page, 5).click()
  await dialog.getByRole('button', { name: 'Retirer l\'étiquette test' }).click()
  await expect(dialog.getByText('#test', { exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Fermer' }).click()
  // La copie ne porte plus l'étiquette filtrée : la grille relue est vide, le focus ne tombe pas sur body.
  await expect(tiles(page)).toHaveCount(0)
  await expect(page.getByText('Aucune carte ne correspond à ces filtres.')).toBeVisible()
  await expect(page.locator('body')).not.toBeFocused()
  await expect(tagFilter(page).locator('option', { hasText: 'test (0)' })).toHaveCount(1)
})

test('favori : l\'étoile de la tuile bascule et persiste au rechargement', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  const star = tile(page, 6).getByRole('button', { name: 'Ajouter aux favoris' })
  const saved = page.waitForResponse((r) => r.url().includes('/rest/v1/user_cards') && r.request().method() === 'PATCH')
  await star.click()
  await expect(tile(page, 6).getByRole('button', { name: 'Retirer des favoris' })).toBeVisible()
  expect((await saved).ok()).toBe(true)
  await page.reload()
  await expect(tile(page, 6).getByRole('button', { name: 'Retirer des favoris' })).toBeVisible()
  await expect(tile(page, 5).getByRole('button', { name: 'Ajouter aux favoris' })).toBeVisible()
})

test('défausse unitaire : solde en haut à droite +1, tuile retirée, focus sur la suivante', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  await page.goto('/collection')
  await expect(balance(page)).toHaveText('100 wikibidous')
  const h1 = await page.locator('main h1').boundingBox()
  const box = await balance(page).boundingBox()
  expect(box!.x).toBeGreaterThan(h1!.x + h1!.width)

  await opener(page, 6).click()
  const dialog = page.getByRole('dialog', { name: title(6) })
  // R18 (b) : « Défausser » envoie une Idempotency-Key.
  const sent = page.waitForRequest((r) => r.url().endsWith('/discard') && r.method() === 'POST')
  await dialog.getByRole('button', { name: /^Défausser/ }).click()
  expect((await sent).headers()['idempotency-key']).toMatch(/^[0-9a-f-]{32,36}$/)
  await expect(dialog).toBeHidden()
  await expect(balance(page)).toHaveText('101 wikibidous')
  await expect(tile(page, 6)).toHaveCount(0)
  await expect(tiles(page)).toHaveCount(50)
  // La tuile d'origine a disparu : le focus passe à la suivante, jamais à body.
  await expect(opener(page, 5)).toBeFocused()
})

test('multi-sélection : tout sélectionner, défausser 50 cartes', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  await page.goto('/collection')
  await expect(tiles(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expect(grid(page).getByRole('checkbox', { checked: true })).toHaveCount(50)

  await page.getByRole('button', { name: 'Défausser', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Défausser 50 cartes ?' })
  await expect(confirm).toContainText('Défausser 50 cartes ? Tu gagneras 50 wikibidous. Action irréversible.', { useInnerText: true })
  const calls: string[] = []
  page.on('request', (r) => { if (r.url().endsWith('/api/user-cards/bulk-discard')) calls.push(r.headers()['idempotency-key'] ?? '') })
  await confirm.getByRole('button', { name: 'Défausser', exact: true }).click()
  await expect(confirm).toBeHidden()
  await expect(balance(page)).toHaveText('150 wikibidous')
  await expect(tiles(page)).toHaveCount(10)
  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toBe('')
})

test('défausse en masse découpée en lots de 50', async ({ page, login }) => {
  const { uid } = await login({ balance: 0 })
  seed60(uid)
  await page.goto('/collection')
  await expect(tiles(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expect(page.getByText('50 cartes sélectionnées')).toBeVisible()
  await page.getByRole('button', { name: 'Suivant' }).click()
  await expect(tiles(page)).toHaveCount(10)
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expect(page.getByText('60 cartes sélectionnées')).toBeVisible()
  const sizes: number[] = []
  page.on('request', (r) => { if (r.url().endsWith('/api/user-cards/bulk-discard')) sizes.push(r.postDataJSON().card_ids.length) })
  await page.getByRole('button', { name: 'Défausser', exact: true }).click()
  await page.getByRole('dialog', { name: 'Défausser 60 cartes ?' }).getByRole('button', { name: 'Défausser', exact: true }).click()
  await expect(balance(page)).toHaveText('60 wikibidous')
  expect(sizes).toEqual([50, 10])
  // Reste n° 0031 (3 exemplaires, un seul retiré) : la page 2 vidée renvoie à la dernière page.
  await expect(tiles(page)).toHaveCount(1)
  await expect(tile(page, 31)).toContainText('x2')
})

test('étiquette en masse : appliquer « lot » à 3 tuiles, filtrer, retirer', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  for (const n of [6, 5, 4]) await tile(page, n).getByRole('checkbox').check()
  await expect(page.getByText('3 cartes sélectionnées')).toBeVisible()
  await page.getByRole('button', { name: 'Appliquer une étiquette' }).click()
  const apply = page.getByRole('dialog', { name: 'Appliquer une étiquette' })
  await apply.getByLabel('Étiquette').fill('lot')
  await apply.getByRole('button', { name: 'Appliquer', exact: true }).click()
  await expect(apply).toBeHidden()

  await tagFilter(page).selectOption({ label: 'lot (3)' })
  await expect(tiles(page)).toHaveCount(3)
  await page.getByRole('button', { name: 'Retirer l\'étiquette', exact: true }).click()
  const remove = page.getByRole('dialog', { name: 'Retirer l\'étiquette' })
  await remove.getByLabel('Étiquette').selectOption({ label: 'lot' })
  await remove.getByRole('button', { name: 'Retirer', exact: true }).click()
  await expect(remove).toBeHidden()
  await expect(tiles(page)).toHaveCount(0)
  await expect(tagFilter(page).locator('option', { hasText: 'lot (0)' })).toHaveCount(1)
})

test('collection vide : état vide et lien vers les paquets', async ({ page, login }) => {
  await login()
  await page.goto('/collection')
  await expect(page.getByText('Ta collection est vide')).toBeVisible()
  await expect(page.locator('main').getByRole('link', { name: 'Ouvrir des paquets' })).toHaveAttribute('href', '/pulls')
})
