import type { Page } from '@playwright/test'
import { formatInt } from '../lib/format.ts'
import { expect, sql, test } from './fixtures'

// Catalogue d'essai (supabase/seed.sql) : 2 000 cartes, L 6 · UR 24 · SR 90 · R 280 · PC 600 · C 1 000.
const COUNTS = [['L', 6], ['UR', 24], ['SR', 90], ['R', 280], ['PC', 600], ['C', 1000]] as const
const title = (n: number) => `Article d'essai n° ${String(n).padStart(4, '0')}`
// Grille du R§2.2, cartes posées directement dedans (sans wrapper).
const grid = (page: Page) => page.locator('main div.flex.flex-wrap.justify-center.gap-3')
const cards = (page: Page) => grid(page).locator('> div[class*="glow-"]')
const opener = (page: Page, name: string) => cards(page).getByRole('button', { name, exact: true })
const isCardsApi = (u: string) => new URL(u).pathname === '/api/cards'

test('catalogue : en-tête, totaux par rareté, grille sans marqueur de possession, tri, recherche', async ({ page, login }) => {
  const { uid } = await login()
  // Une copie de n° 0001 (L, en tête du catalogue) : la grille ne la marque pas pour autant.
  sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where wikipedia_title = 'Article d''essai n° 0001'`, { uid })
  await page.goto('/global-collection')
  await expect(page.locator('main h1')).toHaveText('Collection Globale')
  await expect(page.getByText('Toutes les cartes existantes dans le jeu', { exact: true })).toBeVisible()

  const header = page.locator('main .card-frame').filter({ hasText: 'cartes au total' })
  await expect(header).toContainText(`${formatInt(2000)} cartes au total`)
  await expect(header.locator('li')).toHaveText(COUNTS.map(([code, n]) => new RegExp(`^${code}.* ${formatInt(n)}$`)))

  await expect(cards(page)).toHaveCount(50)
  await expect(grid(page)).toHaveClass(/sm:gap-\[22px\] md:gap-\[26px\]/)
  await expect(cards(page).locator('div.absolute.top-2.left-2')).toHaveText([...Array(6).fill('L'), ...Array(24).fill('UR'), ...Array(20).fill('SR')])
  await expect(grid(page).locator('button[aria-label$="des favoris"]')).toHaveCount(0)
  await expect(grid(page).locator('div.absolute.top-2.right-2')).toHaveCount(0)
  await expect(grid(page).locator('div.relative.isolate.group')).toHaveCount(0)
  await expect(page.getByText('Page 1 / 40', { exact: true })).toBeVisible()

  const sort = page.locator('[aria-label="Trier les cartes"]')
  await expect(sort).toHaveText('Rareté')

  const field = page.getByRole('searchbox', { name: 'Rechercher une carte' })
  const search = page.getByRole('button', { name: 'Rechercher', exact: true })
  await expect(search).toBeDisabled()
  // Un caractère : refusé sur place, sans requête (le serveur exige 2 caractères).
  const asked: string[] = []
  page.on('request', (r) => { if (isCardsApi(r.url())) asked.push(new URL(r.url()).search) })
  await field.fill('a')
  await expect(search).toBeEnabled()
  await search.click()
  await expect(page.locator('main').getByRole('alert')).toHaveText('La recherche demande au moins 2 caractères')
  expect(asked).toEqual([])

  await field.fill('0002')
  await field.press('Enter')
  await expect(page.getByText('Recherche active : pas de décompte par rareté ni de total exact', { exact: true })).toBeVisible()
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).locator('h3')).toHaveText(title(2))
  await expect(page.getByText('cartes au total')).toHaveCount(0)
  expect(asked).toEqual(['?page=0&sort=rarity&q=0002'])

  // Préfixe de 2 caractères : tout le catalogue correspond, total inconnu, la pagination suit searchHasMore.
  await field.fill('Ar')
  await search.click()
  await expect(page.getByText('Page 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Suivant' }).click()
  await expect(page.getByText('Page 2', { exact: true })).toBeVisible()
  await expect(cards(page)).toHaveCount(50)

  // Champ vidé : retour au catalogue entier.
  await field.fill('')
  await expect(header).toContainText(`${formatInt(2000)} cartes au total`)
  await expect(page.getByText('Page 1 / 40', { exact: true })).toBeVisible()
  await expect(search).toBeDisabled()
})

test('liste de souhaits : ajout depuis la modale, bascule, retrait, focus jamais sur body', async ({ page, login }) => {
  await login()
  await page.goto('/global-collection')
  await expect(cards(page)).toHaveCount(50)
  const name = (await cards(page).nth(7).locator('h3').textContent())!
  await opener(page, name).click()
  const dialog = page.getByRole('dialog', { name })
  const writes: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/rest/v1/wishlist_items' && r.method() !== 'GET') writes.push(r.method()) })
  await dialog.getByRole('button', { name: 'Ajouter à ma liste de souhaits' }).click()
  await expect(dialog.getByRole('button', { name: 'Retirer de ma liste de souhaits' })).toBeVisible()
  expect(writes).toEqual(['POST'])
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener(page, name)).toBeFocused()

  const toggle = page.getByRole('button', { name: 'Liste de souhaits', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle.locator('svg')).toHaveClass(/lucide-bookmark/)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(cards(page)).toHaveCount(1)
  await expect(cards(page).locator('h3')).toHaveText(name)
  await expect(page.getByText('1 carte dans ta liste de souhaits', { exact: true })).toBeVisible()

  // Retirée depuis la vue liste : la grille relue est vide, le focus ne tombe pas sur body.
  await opener(page, name).click()
  await dialog.getByRole('button', { name: 'Retirer de ma liste de souhaits' }).click()
  await expect(dialog.getByRole('button', { name: 'Ajouter à ma liste de souhaits' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Fermer' }).click()
  await expect(page.getByText('Ta liste de souhaits est vide', { exact: true })).toBeVisible()
  await expect(cards(page)).toHaveCount(0)
  await expect(page.locator('body')).not.toBeFocused()

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(cards(page)).toHaveCount(50)
})

test('liste de souhaits : une écriture sans ligne renvoyée (RLS) n\'est pas un succès', async ({ page, login }) => {
  const { uid } = await login()
  sql(`insert into public.wishlist_items (user_id, card_id) select :'uid', id from public.cards where wikipedia_title = 'Article d''essai n° 0003'`, { uid })
  await page.goto('/global-collection')
  await page.getByRole('button', { name: 'Liste de souhaits', exact: true }).click()
  await expect(cards(page)).toHaveCount(1)
  await opener(page, title(3)).click()
  const dialog = page.getByRole('dialog', { name: title(3) })
  const remove = dialog.getByRole('button', { name: 'Retirer de ma liste de souhaits' })
  await page.route('**/rest/v1/wishlist_items**', (route) =>
    route.request().method() === 'DELETE' ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }) : route.fallback())
  await remove.click()
  await expect(dialog.getByRole('alert')).toHaveText('La liste de souhaits n\'a pas pu être mise à jour.')
  await expect(remove).toBeVisible()
  await expect(remove).toBeFocused()
  expect(sql(`select count(*) from public.wishlist_items where user_id = :'uid'`, { uid })).toBe('1')
})

test('liste de souhaits : un état illisible dans la modale est dit, l\'ajout reste possible', async ({ page, login }) => {
  await login()
  // 500 et non abort : postgrest-js relance un GET sur erreur réseau.
  await page.route('**/rest/v1/wishlist_items**', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.fallback())
  await page.goto('/global-collection')
  await expect(cards(page)).toHaveCount(50)
  await opener(page, title(4)).click()
  const dialog = page.getByRole('dialog', { name: title(4) })
  await expect(dialog.getByRole('alert')).toHaveText('Ta liste de souhaits n\'a pas pu être lue.')
  await dialog.getByRole('button', { name: 'Ajouter à ma liste de souhaits' }).click()
  await expect(dialog.getByRole('button', { name: 'Retirer de ma liste de souhaits' })).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
})

test('erreur de chargement : message, « Réessayer », focus jamais sur body', async ({ page, login }) => {
  await login()
  let fail = 1
  await page.route((u) => isCardsApi(u.href), (route) => (fail-- > 0 ? route.abort() : route.fallback()))
  await page.goto('/global-collection')
  await expect(page.locator('main').getByRole('alert')).toHaveText('Les cartes n\'ont pas pu être chargées.')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(cards(page)).toHaveCount(50)
  await expect(page.locator('body')).not.toBeFocused()
  await expect(page.locator('main')).toContainText('cartes au total')

  // Page suivante en échec : le panneau d'erreur remplace la grille et sa pagination, le focus va à « Réessayer ».
  fail = 1
  await page.getByRole('button', { name: 'Suivant' }).click()
  const retry = page.getByRole('button', { name: 'Réessayer' })
  await expect(retry).toBeFocused()
  await retry.click()
  await expect(page.getByText('Page 2 / 40', { exact: true })).toBeVisible()
  // Pendant la relecture, l'ancienne grille reste affichée (aria-busy) : attendre la page 2.
  await expect(grid(page)).toHaveAttribute('aria-busy', 'false')
  await expect(opener(page, (await cards(page).first().locator('h3').textContent())!)).toBeFocused()
})
