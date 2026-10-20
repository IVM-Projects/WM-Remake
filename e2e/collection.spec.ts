import type { Page, Route } from '@playwright/test'
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
const isCollectionApi = (u: URL) => u.pathname === '/api/my-collection'

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
  // Horloge pilotée : le délai ne dépend plus de la vitesse de frappe de la machine (la CI ne relance pas).
  await page.clock.install()
  await page.goto('/collection')
  const search = page.locator('input[placeholder="Rechercher par titre ou catégorie..."]')
  await expect(search).toBeFocused()
  await expect(tiles(page)).toHaveCount(50)
  await page.clock.pauseAt(Date.now() + 10_000)
  const qs: (string | null)[] = []
  page.on('request', (r) => { if (isCollectionApi(new URL(r.url()))) qs.push(new URL(r.url()).searchParams.get('q')) })
  await search.pressSequentially('n° 0001')
  // Rien avant 300 ms après la dernière touche (replaceState part dans le minuteur), puis une seule requête, avec le texte entier.
  const urlQ = () => page.evaluate(() => new URLSearchParams(location.search).get('q'))
  await page.clock.runFor(299)
  expect(await urlQ()).toBeNull()
  await page.clock.runFor(1)
  expect(await urlQ()).toBe('n° 0001')
  await expect(tiles(page)).toHaveCount(1)
  expect(qs).toEqual(['n° 0001'])
  await expect(tiles(page).locator('h3')).toHaveText(title(1))
  await page.clock.resume()
  // L'adresse garde la recherche : le rechargement la retrouve.
  await page.reload()
  await expect(search).toHaveValue('n° 0001')
  await expect(tiles(page)).toHaveCount(1)
})

test('tri et rareté, gardés dans l\'adresse', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  // Navigateur sans URLSearchParams.size (Chrome et Firefox 111–112, Safari 16.4–16.7), pris en charge par Next 16.
  await page.addInitScript(() => { delete (URLSearchParams.prototype as { size?: number }).size })
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
  // « Effacer les filtres » disparaît avec son panneau : le focus va à la première tuile.
  await page.getByRole('button', { name: 'Effacer les filtres' }).click()
  await expect(tiles(page)).toHaveCount(50)
  await expect(opener(page, 6)).toBeFocused()
})

// Ouvre n° 0030 (UR) ; Avancer mènera ensuite à ?rarity=L derrière la modale, où la copie ouverte n'est plus.
async function openUr30(page: Page) {
  await page.goto('/collection')
  await expect(tiles(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'L', exact: true }).click()
  await expect(tiles(page)).toHaveCount(6)
  await page.goBack()
  await expect(tiles(page)).toHaveCount(50)
  await opener(page, 30).click()
  const dialog = page.getByRole('dialog', { name: title(30) })
  await expect(dialog).toBeVisible()
  return dialog
}

// Avancer derrière la modale : la grille relue ne garde que les L, la copie ouverte (UR) n'y est plus.
async function openThenLeave(page: Page) {
  const dialog = await openUr30(page)
  await page.goForward()
  await expect(tiles(page)).toHaveCount(6)
  return dialog
}

test('copie sortie de la page pendant la modale : le focus va à la première tuile', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  const dialog = await openThenLeave(page)
  await dialog.getByRole('button', { name: /^Défausser/ }).click()
  await expect(dialog).toBeHidden()
  await expect(opener(page, 6)).toBeFocused()
})

test('copie sortie de la page, modale fermée par Échap sans rien changer : le focus va à la première tuile', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  const dialog = await openThenLeave(page)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener(page, 6)).toBeFocused()
})

test('modale fermée sur une grille en échec : le focus va à « Réessayer »', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  const dialog = await openUr30(page)
  await page.route(isCollectionApi, (r) => r.abort(), { times: 1 })
  await page.goForward()
  await expect(page.getByText('Ta collection n\'a pas pu être chargée.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeFocused()
})

test('modale fermée pendant la relecture : le focus va à la première tuile une fois la grille arrivée', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  const dialog = await openUr30(page)
  let seen = 0
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(isCollectionApi, async (r) => {
    seen++
    await held
    await r.continue()
  }, { times: 1 })
  await page.goForward()
  await expect.poll(() => seen).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  release()
  await expect(tiles(page)).toHaveCount(6)
  await expect(opener(page, 6)).toBeFocused()
  await expect(page.locator('body')).not.toBeFocused()
})

test('modale fermée pendant une relecture qui échoue : le focus va à « Réessayer »', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  const dialog = await openUr30(page)
  let seen = 0
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(isCollectionApi, async (r) => {
    seen++
    await held
    await r.abort()
  }, { times: 1 })
  await page.goForward()
  await expect.poll(() => seen).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  release()
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeFocused()
})

test('tuile d\'origine remontée (Avancer puis Retour derrière la modale) : Échap rend le focus à la même copie', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  const dialog = await openThenLeave(page)
  await page.goBack()
  await expect(tiles(page)).toHaveCount(50)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener(page, 30)).toBeFocused()
})

test('échec effacé au changement de requête : pas d\'erreur pendant la relecture d\'une adresse qui avait échoué', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  let calls = 0
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(isCollectionApi, async (r) => {
    if (++calls === 1) return r.abort()
    await held
    await r.continue()
  })
  await page.goto('/collection?rarity=L')
  const failed = page.getByText('Ta collection n\'a pas pu être chargée.')
  await expect(failed).toBeVisible()
  // L+UR puis L à nouveau, avant toute réponse : la requête de ?rarity=L repart, son échec d'avant ne s'affiche pas.
  await page.getByRole('button', { name: 'UR', exact: true }).click()
  await page.getByRole('button', { name: 'UR', exact: true }).click()
  await expect.poll(() => calls).toBe(3)
  await expect(failed).toHaveCount(0)
  release()
  await expect(tiles(page)).toHaveCount(6)
  await expect(failed).toHaveCount(0)
})

test('erreur de chargement : « Réessayer » qui échoue encore garde le focus, « Effacer les filtres » en sort', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  let calls = 0
  let fail = true
  await page.route(isCollectionApi, (r) => {
    calls++
    return fail ? r.abort() : r.continue()
  })
  await page.goto('/collection?rarity=L')
  const failed = page.getByText('Ta collection n\'a pas pu être chargée.')
  await expect(failed).toBeVisible()
  await page.getByRole('button', { name: 'Réessayer' }).click()
  // Nouvel échec : le « Réessayer » du nouveau panneau prend le focus, jamais body.
  await expect.poll(() => calls).toBe(2)
  await expect(failed).toBeVisible()
  await expect(page.getByRole('button', { name: 'Réessayer' })).toBeFocused()
  fail = false
  await page.getByRole('button', { name: 'Effacer les filtres' }).click()
  await expect(tiles(page)).toHaveCount(50)
  await expect(page).toHaveURL(/\/collection$/)
  await expect(opener(page, 6)).toBeFocused()
})

test('grille en échec : aucune sélection sur les copies de la requête d\'avant', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  await expect(tiles(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  await page.route(isCollectionApi, (r) => r.abort(), { times: 1 })
  await page.getByRole('button', { name: 'L', exact: true }).click()
  await expect(page.getByText('Ta collection n\'a pas pu être chargée.')).toBeVisible()
  // Les 50 copies d'avant restent en mémoire : ni « Tout sélectionner » ni « Défausser » ne s'y appliquent.
  const all = page.getByRole('button', { name: 'Tout sélectionner' })
  await expect(all).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('button', { name: 'Défausser', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await all.click({ force: true })
  await expect(page.getByText('Aucune carte sélectionnée')).toBeVisible()
})

test('erreur effacée par un succès : Retour sur l\'adresse qui avait échoué', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  let fail = true
  await page.route((u) => isCollectionApi(u) && u.searchParams.get('rarity') === 'L', (r) => (fail ? r.abort() : r.continue()))
  await page.goto('/collection?rarity=L')
  const failed = page.getByText('Ta collection n\'a pas pu être chargée.')
  await expect(failed).toBeVisible()
  await page.getByRole('button', { name: 'Effacer les filtres' }).click()
  await expect(tiles(page)).toHaveCount(50)
  fail = false
  await page.goBack()
  await expect(tiles(page)).toHaveCount(6)
  await expect(failed).toHaveCount(0)
})

test('adresse périmée : valeurs refusées par l\'API ignorées, seules les cinq clés partent', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  const sent = page.waitForRequest((r) => isCollectionApi(new URL(r.url())))
  await page.goto('/collection?sort=foo&page=abc&tag_id=nope&rarity=X&limit=5&x=1')
  expect(Object.fromEntries(new URL((await sent).url()).searchParams)).toEqual({ limit: '50', page: '0', sort: 'rarity' })
  await expect(tiles(page)).toHaveCount(50)
  await expect(page.getByText('Ta collection n\'a pas pu être chargée.')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Trier les cartes' }).locator('option:checked')).toHaveText('Rareté')
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

  // Une ligne que la RLS écarte revient vide (0 ligne) : ce n'est pas un succès, l'étoile revient et le dit.
  await page.route((u) => u.pathname === '/rest/v1/user_cards', (r) => (r.request().method() === 'PATCH'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    : r.continue()))
  await tile(page, 5).getByRole('button', { name: 'Ajouter aux favoris' }).click()
  await expect(page.getByText('Le favori n\'a pas pu être enregistré.')).toBeVisible()
  await expect(tile(page, 5).getByRole('button', { name: 'Ajouter aux favoris' })).toBeVisible()
  await opener(page, 5).click()
  const dialog = page.getByRole('dialog', { name: title(5) })
  await dialog.getByRole('button', { name: 'Ajouter aux favoris' }).click()
  await expect(dialog.getByText('Le favori n\'a pas pu être enregistré.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Ajouter aux favoris' })).toBeVisible()
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
  const all = page.getByRole('button', { name: 'Tout sélectionner' })
  await all.click()
  await expect(grid(page).getByRole('checkbox', { checked: true })).toHaveCount(50)

  // Changer de pastille vide la sélection ; pendant la relecture, rien ne se sélectionne dans la grille d'avant.
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(isCollectionApi, async (r) => { await held; await r.continue() }, { times: 1 })
  await page.getByRole('button', { name: 'L', exact: true }).click()
  await expect(page.getByText('Aucune carte sélectionnée')).toBeVisible()
  await expect(all).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('button', { name: 'Défausser', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await all.click({ force: true })
  await expect(page.getByText('Aucune carte sélectionnée')).toBeVisible()
  release()
  // Les 6 L étaient dans la grille d'avant : aucune n'est cochée.
  await expect(tiles(page)).toHaveCount(6)
  await expect(grid(page).getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(page.getByText('Aucune carte sélectionnée')).toBeVisible()
  await page.getByRole('button', { name: 'L', exact: true }).click()
  await expect(tiles(page)).toHaveCount(50)
  await all.click()
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

test('défausse en masse découpée en lots de 50, solde illisible relu après', async ({ page, login }) => {
  const { uid } = await login({ balance: 0 })
  seed60(uid)
  await page.route('**/api/wikibidous', (r) => r.abort(), { times: 1 })
  await page.goto('/collection')
  await expect(tiles(page)).toHaveCount(50)
  // Lecture du solde échouée : « — » et un nom lisible, jamais rien.
  await expect(balance(page)).toHaveText('—Solde indisponible')
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
  // Pas encore d'étiquette : « Retirer » est inactif.
  await page.getByRole('button', { name: 'Retirer l\'étiquette', exact: true }).click()
  const none = page.getByRole('dialog', { name: 'Retirer l\'étiquette' })
  await expect(none.getByText('Tu n\'as encore aucune étiquette.')).toBeVisible()
  await none.getByRole('button', { name: 'Retirer', exact: true }).click({ force: true })
  await expect(none).toBeVisible()
  await expect(none.getByRole('button', { name: 'Retirer', exact: true })).toHaveAttribute('aria-disabled', 'true')
  await none.getByRole('button', { name: 'Annuler' }).click()
  await page.getByRole('button', { name: 'Appliquer une étiquette' }).click()
  const apply = page.getByRole('dialog', { name: 'Appliquer une étiquette' })
  await apply.getByLabel('Étiquette').fill('lot')
  await apply.getByRole('button', { name: 'Appliquer', exact: true }).click()
  await expect(apply).toBeHidden()

  await tagFilter(page).selectOption({ label: 'lot (3)' })
  await expect(tiles(page)).toHaveCount(3)
  // Le filtre a vidé la sélection : on reprend les 3 copies filtrées.
  await expect(page.getByText('Aucune carte sélectionnée')).toBeVisible()
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expect(page.getByText('3 cartes sélectionnées')).toBeVisible()
  await page.getByRole('button', { name: 'Retirer l\'étiquette', exact: true }).click()
  const remove = page.getByRole('dialog', { name: 'Retirer l\'étiquette' })
  await remove.getByLabel('Étiquette').selectOption({ label: 'lot' })
  await remove.getByRole('button', { name: 'Retirer', exact: true }).click()
  await expect(remove).toBeHidden()
  await expect(tiles(page)).toHaveCount(0)
  await expect(tagFilter(page).locator('option', { hasText: 'lot (0)' })).toHaveCount(1)
})

test('étiquettes illisibles signalées, nom fait d\'espaces refusé', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  // La lecture des étiquettes de la page (avec leurs nombres de copies) échoue une fois ; un 500, que postgrest-js ne relance pas.
  await page.route((u) => u.pathname === '/rest/v1/tags' && !!u.searchParams.get('select')?.includes('user_card_tags'),
    (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"échec"}' }), { times: 1 })
  await page.goto('/collection')
  await expect(page.getByText('Étiquettes indisponibles', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  await tile(page, 6).getByRole('checkbox').check()

  await page.getByRole('button', { name: 'Retirer l\'étiquette', exact: true }).click()
  const remove = page.getByRole('dialog', { name: 'Retirer l\'étiquette' })
  await expect(remove.getByText('Tes étiquettes n\'ont pas pu être chargées.')).toBeVisible()
  await expect(remove.getByText('Tu n\'as encore aucune étiquette.')).toHaveCount(0)
  // Rien à retirer : « Retirer » est inactif et ne ferme pas la modale.
  const confirmRemove = remove.getByRole('button', { name: 'Retirer', exact: true })
  await expect(confirmRemove).toHaveAttribute('aria-disabled', 'true')
  await confirmRemove.click({ force: true })
  await expect(remove).toBeVisible()
  await remove.getByRole('button', { name: 'Annuler' }).click()

  await page.getByRole('button', { name: 'Appliquer une étiquette' }).click()
  const apply = page.getByRole('dialog', { name: 'Appliquer une étiquette' })
  await expect(apply.getByText('Tes étiquettes n\'ont pas pu être chargées.')).toBeVisible()
  await apply.getByLabel('Étiquette').fill('   ')
  await apply.getByRole('button', { name: 'Appliquer', exact: true }).click()
  await expect(apply.getByText('Le nom de l\'étiquette ne peut pas être vide.')).toBeVisible()
  await expect(apply).toBeVisible()
  await apply.getByLabel('Étiquette').fill('lot')
  await apply.getByRole('button', { name: 'Appliquer', exact: true }).click()
  await expect(apply).toBeHidden()
  // Étiquettes relues après l'application : l'erreur s'efface.
  await expect(tagFilter(page).locator('option', { hasText: 'lot (1)' })).toHaveCount(1)
  await expect(page.getByText('Étiquettes indisponibles', { exact: true })).toHaveCount(0)
})

test('collection vide : état vide et lien vers les paquets', async ({ page, login }) => {
  await login()
  await page.goto('/collection')
  await expect(page.getByText('Ta collection est vide')).toBeVisible()
  await expect(page.locator('main').getByRole('link', { name: 'Ouvrir des paquets' })).toHaveAttribute('href', '/pulls')
})

// Page d'erreur de la plateforme (délai de la fonction dépassé) : texte brut, aucun JSON.
const PLATFORM_504 = { status: 504, contentType: 'text/plain', body: 'An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT' }
const DISCARD_UNSURE = 'La défausse n\'a pas été confirmée : la carte a peut-être été défaussée. Ton solde et ta collection se mettent à jour.'
const BULK_UNSURE = 'La défausse n\'a pas été confirmée : une partie a peut-être eu lieu. Ton solde et ta collection se mettent à jour.'
const isDiscard = (u: URL) => u.pathname.endsWith('/discard')

test('défausse : 504 en texte brut de la plateforme → message français, solde relu', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  await page.goto('/collection')
  await expect(balance(page)).toHaveText('100 wikibidous')
  await page.route(isDiscard, (r) => r.fulfill(PLATFORM_504), { times: 1 })
  await opener(page, 6).click()
  const dialog = page.getByRole('dialog', { name: title(6) })
  const reread = page.waitForRequest((r) => r.url().endsWith('/api/wikibidous'))
  await dialog.getByRole('button', { name: /^Défausser/ }).click()
  await expect(dialog.getByRole('alert')).toHaveText(DISCARD_UNSURE)
  await reread
  await expect(balance(page)).toHaveText('100 wikibidous')
})

test('réponse perdue après la défausse (504) : la relance garde la clé, un seul exemplaire retiré', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  const keys: string[] = []
  page.on('request', (r) => { if (isDiscard(new URL(r.url()))) keys.push(r.headers()['idempotency-key'] ?? '') })
  // La défausse atteint le serveur et s'y fait ; sa réponse est remplacée par la page d'erreur de la plateforme.
  await page.route(isDiscard, async (r) => {
    await r.fetch()
    await r.fulfill(PLATFORM_504)
  }, { times: 1 })
  await page.goto('/collection?page=1')
  await opener(page, 31).click()
  const dialog = page.getByRole('dialog', { name: title(31) })
  await expect(dialog).toContainText('Exemplaires : 3')
  const discard = dialog.getByRole('button', { name: /^Défausser/ })
  const lost = page.waitForResponse((r) => isDiscard(new URL(r.url())) && r.status() === 504)
  await discard.click()
  await lost
  await expect(discard).not.toHaveAttribute('aria-disabled', 'true')
  await discard.click()
  await expect(dialog).toBeHidden()
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
  expect(sql(`select count from public.user_cards where user_id = :'uid' and snapshot_title = :'t'`, { uid, t: title(31) })).toBe('2')
  await expect(tile(page, 31)).toContainText('x2')
  await expect(balance(page)).toHaveText('101 wikibidous')
})

// 60 copies sélectionnées et défaussées ; le second lot se fait côté serveur mais sa réponse est perdue (504). Rend les envois (clé, taille).
async function loseSecondChunk(page: Page) {
  const sent: { key: string; size: number }[] = []
  page.on('request', (r) => {
    if (r.url().endsWith('/api/user-cards/bulk-discard')) sent.push({ key: r.headers()['idempotency-key'] ?? '', size: r.postDataJSON().card_ids.length })
  })
  let calls = 0
  await page.route('**/api/user-cards/bulk-discard', async (r) => {
    if (++calls !== 2) return r.continue()
    await r.fetch()
    await r.fulfill(PLATFORM_504)
  })
  await page.goto('/collection')
  await expect(tiles(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await page.getByRole('button', { name: 'Suivant' }).click()
  await expect(tiles(page)).toHaveCount(10)
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expect(page.getByText('60 cartes sélectionnées')).toBeVisible()
  await page.getByRole('button', { name: 'Défausser', exact: true }).click()
  await page.getByRole('dialog', { name: 'Défausser 60 cartes ?' }).getByRole('button', { name: 'Défausser', exact: true }).click()
  await expect(page.getByText(BULK_UNSURE)).toBeVisible()
  // Le premier lot a répondu : il sort de la sélection ; le second, à l'issue inconnue, y reste.
  await expect(page.getByText('10 cartes sélectionnées')).toBeVisible()
  await expect(balance(page)).toHaveText('60 wikibidous')
  return sent
}

async function discard10(page: Page) {
  await page.getByRole('button', { name: 'Défausser', exact: true }).click()
  await page.getByRole('dialog', { name: 'Défausser 10 cartes ?' }).getByRole('button', { name: 'Défausser', exact: true }).click()
}

test('défausse en masse, réponse du second lot perdue : la sélection garde ce lot, la relance rejoue sa clé', async ({ page, login }) => {
  const { uid } = await login({ balance: 0 })
  seed60(uid)
  const sent = await loseSecondChunk(page)
  await discard10(page)
  await expect(page.getByText('Aucune carte sélectionnée')).toBeVisible()
  expect(sent.map((s) => s.size)).toEqual([50, 10, 10])
  expect(sent[1].key).not.toBe(sent[0].key)
  expect(sent[2].key).toBe(sent[1].key)
  expect(sql(`select wikibidous_balance from public.profiles where id = :'uid'`, { uid })).toBe('60')
  await expect(tile(page, 31)).toContainText('x2')
})

test('défausse en masse, lot perdu puis sélection refaite (même contenu) : nouvelle intention, clé neuve, rien de rejoué', async ({ page, login }) => {
  const { uid } = await login({ balance: 0 })
  seed60(uid)
  const sent = await loseSecondChunk(page)
  // Grille relue : du second lot, fait côté serveur, il ne reste que n° 0031 (x2).
  await expect(tiles(page)).toHaveCount(1)
  await expect(tile(page, 31)).toContainText('x2')
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expect(page.getByText('10 cartes sélectionnées')).toBeVisible()
  await discard10(page)
  await expect(page.getByText('9 cartes n\'ont pas pu être défaussées.')).toBeVisible()
  expect(sent.map((s) => s.size)).toEqual([50, 10, 10])
  expect(sent[2].key).not.toBe(sent[1].key)
  // Défausse réelle : n° 0031 perd un exemplaire (rejouée, l'ancienne réponse aurait annoncé 10 cartes sans rien retirer).
  expect(sql(`select count from public.user_cards where user_id = :'uid' and snapshot_title = :'t'`, { uid, t: title(31) })).toBe('1')
  expect(sql(`select wikibidous_balance from public.profiles where id = :'uid'`, { uid })).toBe('61')
})

// Défausse de n° 0006 retenue, sa modale fermée par Échap, puis (another) n° 0005 ouverte avant la réponse.
async function discardThenClose(page: Page, answer: (r: Route) => Promise<void>, another = true) {
  let seen = 0
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(isDiscard, async (r) => {
    seen++
    await held
    await answer(r)
  }, { times: 1 })
  await page.goto('/collection')
  await expect(balance(page)).toHaveText('100 wikibidous')
  await opener(page, 6).click()
  const first = page.getByRole('dialog', { name: title(6) })
  await first.getByRole('button', { name: /^Défausser/ }).click()
  await expect.poll(() => seen).toBe(1)
  await page.keyboard.press('Escape')
  await expect(first).toBeHidden()
  const second = page.getByRole('dialog', { name: title(5) })
  if (another) {
    await opener(page, 5).click()
    await expect(second).toBeVisible()
  }
  release()
  return second
}

test('défausse finie après la fermeture de sa modale : la modale ouverte ensuite reste, toast, solde et grille relus', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  const second = await discardThenClose(page, (r) => r.continue())
  await expect(page.locator('#wm-toasts')).toContainText('Carte défaussée : +1 wikibidou')
  await expect(balance(page)).toHaveText('101 wikibidous')
  await expect(tile(page, 6)).toHaveCount(0)
  await expect(second).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(opener(page, 5)).toBeFocused()
})

test('défausse finie après la fermeture de sa modale, aucune autre ouverte : sa tuile retirée, le focus passe à la suivante', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  await discardThenClose(page, (r) => r.continue(), false)
  await expect(page.locator('#wm-toasts')).toContainText('Carte défaussée : +1 wikibidou')
  await expect(tile(page, 6)).toHaveCount(0)
  await expect(balance(page)).toHaveText('101 wikibidous')
  await expect(opener(page, 5)).toBeFocused()
})

test('défausse en échec après la fermeture de sa modale : le message passe par un toast', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  const second = await discardThenClose(page, (r) => r.fulfill(PLATFORM_504))
  await expect(page.locator('#wm-toasts')).toContainText(DISCARD_UNSURE)
  await expect(second).toBeVisible()
  await expect(second.getByRole('alert')).toHaveCount(0)
})

test('défausse finie pendant que /collection est cachée (Activity) : au retour, sa modale est fermée et la grille relue', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  seed60(uid)
  sql(`update public.user_cards set count = 3 where user_id = :'uid' and snapshot_title = :'t'`, { uid, t: title(6) })
  let seen = 0
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(isDiscard, async (r) => {
    seen++
    await held
    await r.continue()
  }, { times: 1 })
  await page.goto('/collection')
  await opener(page, 6).click()
  const dialog = page.getByRole('dialog', { name: title(6) })
  await expect(dialog).toContainText('Exemplaires : 3')
  await dialog.getByRole('button', { name: /^Défausser/ }).click()
  await expect.poll(() => seen).toBe(1)
  // Le voile de la modale couvre la barre latérale : le clic est remis au lien lui-même (navigation du routeur, page gardée par Activity).
  await page.locator('nav a[href="/pulls"]').first().dispatchEvent('click')
  await expect(page).toHaveURL('/pulls')
  await expect(page.getByRole('button', { name: 'Ouvrir', exact: true })).toBeVisible()
  const answered = page.waitForResponse((r) => isDiscard(new URL(r.url())))
  release()
  await answered
  await expect(page.locator('#wm-toasts')).toContainText('Carte défaussée : +1 wikibidou')
  // Retour comme un joueur (Précédent) : rien ne prend le focus en route, la refocalisation de la page le rend à la tuile.
  await page.goBack()
  await expect(page).toHaveURL('/collection')
  await expect(tile(page, 6)).toContainText('x2')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(balance(page)).toHaveText('101 wikibidous')
  await expect(opener(page, 6)).toBeFocused()
})

test('étoile sur une grille périmée : inactive (aria-disabled) et focalisable, jamais écrasée par la relecture en cours', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  await expect(tiles(page)).toHaveCount(50)
  // La relecture de ?rarity=L lit la base tout de suite, mais sa réponse est retenue.
  let fetched!: () => void
  const read = new Promise<void>((r) => { fetched = r })
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(isCollectionApi, async (r) => {
    const res = await r.fetch()
    fetched()
    await held
    await r.fulfill({ response: res })
  }, { times: 1 })
  await page.getByRole('button', { name: 'L', exact: true }).click()
  await read
  const star = tile(page, 6).getByRole('button', { name: 'Ajouter aux favoris' })
  await expect(star).toHaveAttribute('aria-disabled', 'true')
  await star.focus()
  await expect(star).toBeFocused()
  await star.click({ force: true })
  release()
  await expect(tiles(page)).toHaveCount(6)
  expect(sql(`select starred from public.user_cards where user_id = :'uid' and snapshot_title = :'t'`, { uid, t: title(6) })).toBe('f')
  await expect(tile(page, 6).getByRole('button', { name: 'Ajouter aux favoris' })).toBeVisible()
  // Grille à jour : l'étoile marche de nouveau.
  await tile(page, 6).getByRole('button', { name: 'Ajouter aux favoris' }).click()
  await expect(tile(page, 6).getByRole('button', { name: 'Retirer des favoris' })).toBeVisible()
})

test('modale réaffichée par Activity : Échap rend le focus à la tuile d\'origine, pas au lien de navigation', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/pulls')
  const nav = page.locator('nav a[href="/collection"]').first()
  await nav.click()
  await expect(tiles(page)).toHaveCount(50)
  await opener(page, 6).click()
  const dialog = page.getByRole('dialog', { name: title(6) })
  await expect(dialog).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('/pulls')
  await nav.click()
  // Effets repris (panneau focalisé, Échap écouté) : la page réaffichée est prête.
  await expect(dialog).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener(page, 6)).toBeFocused()
})

test('chargement complet : l\'en-tête n\'est inséré qu\'une fois (pas de second fondu à l\'hydratation)', async ({ page, login }) => {
  await login()
  await page.addInitScript(() => {
    // Chaque h1 de PageHeader inséré, par l'analyse du HTML statique comme par React, compté une fois (le logo du shell a aussi un h1).
    const header = 'h1[class*="md:text-3xl"]'
    const h1s = new Set<Element>()
    ;(window as unknown as { h1s: Set<Element> }).h1s = h1s
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n instanceof Element) for (const h of [n, ...n.querySelectorAll(header)]) if (h.matches(header)) h1s.add(h)
      }
    }).observe(document, { childList: true, subtree: true })
  })
  await page.goto('/collection')
  await expect(page.getByText('Ta collection est vide')).toBeVisible()
  await expect(balance(page)).toHaveText('0 wikibidous')
  expect(await page.evaluate(() => (window as unknown as { h1s: Set<Element> }).h1s.size)).toBe(1)
})

test('lien « Voir l\'article sur Wikipédia → » de la modale : cible de 44 px', async ({ page, login }) => {
  const { uid } = await login()
  seed60(uid)
  await page.goto('/collection')
  await opener(page, 6).click()
  const link = page.getByRole('dialog', { name: title(6) }).locator('a', { hasText: 'Voir l\'article sur Wikipédia →' })
  // Hauteur de mise en page : la boîte englobante suit l'entrée animée du panneau (translate), d'où un 43,99… possible.
  expect(await link.evaluate((a) => (a as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44)
})
