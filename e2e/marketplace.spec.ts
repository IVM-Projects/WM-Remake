import { randomUUID } from 'node:crypto'
import type { Locator, Page, Request, Route } from '@playwright/test'
import { formatInt } from '../lib/format.ts'
import { expect, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a sa carte au titre unique, filtre par ce titre et nettoie à la fin (Global Constraints).
const title = () => `Zz marché e2e ${randomUUID().slice(-12)}`
// Tuiles de l'onglet visible (Activity : une page gardée resterait dans le DOM, preserving-ui-state.md:355-389).
const tiles = (page: Page) => page.locator('[id^="marketplace-auction-"]').filter({ visible: true })
const tile = (page: Page, id: string) => page.locator(`[id="marketplace-auction-${id}"]`).filter({ visible: true })
const ACTIVE = /border-b-2 border-amber-500 text-amber-600/
const order = (page: Page) => tiles(page).evaluateAll((els) => els.map((e) => e.id.replace('marketplace-auction-', '')))
// Relecture de la page sans attendre son polling : un retour en visible lance tout de suite un passage (lib/poll.ts), répété tant que le
// cache partagé (liste 2 s, détail 1 s) sert l'état d'avant.
async function rereadUntil(page: Page, read: () => Promise<unknown>, expected: number | RegExp) {
  await expect.poll(async () => {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    return read()
  }).toEqual(typeof expected === 'number' ? expected : expect.stringMatching(expected))
}

// Comptes et cartes du test : auth.users d'abord (cascade vers profils, enchères, copies), puis la carte (clés sans cascade).
const trash = { uids: [] as string[], cards: [] as string[] }
test.afterEach(() => {
  sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[]);
delete from public.cards where id = any(string_to_array(:'cards', ',')::uuid[])`, { uids: trash.uids.join(','), cards: trash.cards.join(',') })
  trash.uids = []
  trash.cards = []
})

function cardOf(t: string, rarity = 'C'): string {
  const card = sql(`insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
values (:'t', 'https://fr.wikipedia.org/wiki/' || replace(:'t', ' ', '_'), :'rarity', 100, 100, 'Essai', 'Résumé') returning id`, { t, rarity })
  trash.cards.push(card)
  return card
}

// n enchères actives d'une carte neuve (100 wikibidous, 1 h), d'un vendeur Pro par lot de 10 (plafond Pro, M3-10). Le compteur de rafale
// est remis à zéro après chaque mise en vente : sinon la 5e de la fenêtre retirerait la vérification humaine (P3).
function listAuctions(n: number, t: string, rarity = 'C'): { card: string; ids: string[] } {
  const card = cardOf(t, rarity)
  const [ids, sellers] = sql(`\\o /dev/null
create temp table s as select i, tests.make_user('zz_' || left(md5(random()::text), 12)) uid from generate_series(0, (:'n'::int - 1) / 10) i;
update public.profiles set is_pro = true where id in (select uid from s);
select wm.set_human_verified(uid) from s;
create temp table k as select g, (wm.grant_copy(s.uid, :'card', false)).id from generate_series(0, :'n'::int - 1) g join s on s.i = g / 10;
select format('select wm.create_auction(%L, %L, 100, 60)', s.uid, k.id),
  format('update wm.user_state set list_window_count = 0 where user_id = %L', s.uid)
from k join s on s.i = k.g / 10 order by k.g \\gexec
\\o
select string_agg(id::text, ',' order by created_at, id) from public.auctions where card_id = :'card';
select string_agg(uid::text, ',') from s`, { card, n: String(n) }).split('\n')
  trash.uids.push(...sellers.split(','))
  return { card, ids: ids.split(',') }
}

// /marketplace filtrée par le titre unique du test.
async function search(page: Page, t: string) {
  await page.goto('/marketplace')
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).fill(t)
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).press('Enter')
}
// Échue puis réglée, comme par le cron (absent du banc).
const settle = (id: string) => sql(`update public.auctions set end_at = now() - interval '1 second' where id = :'id';
select from wm.settle_auction(:'id') \\g /dev/null`, { id })

test('en-tête, sous-titre, cinq onglets (Parcourir actif) ; une recherche d\'un caractère est refusée sans requête', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  await page.goto('/marketplace')
  await expect(page.locator('main h1')).toHaveText('Marché')
  await expect(page.getByText('Enchérissez sur des cartes ou vendez les vôtres contre des wikis.', { exact: true })).toBeVisible()
  const tablist = page.getByRole('tablist', { name: 'Vues du marché' })
  await expect(tablist.getByRole('tab')).toHaveText(['Parcourir', 'Mes ventes (0/5)', 'Mes enchères (0)', 'Gagnées', 'Historique (0)'])
  await expect(tablist.getByRole('tab', { name: 'Parcourir' })).toHaveClass(ACTIVE)
  await expect(tablist.getByRole('tab', { name: 'Parcourir' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('combobox', { name: 'Trier' }).locator('option')).toHaveText(['Récentes', 'Prix croissant', 'Prix décroissant', 'Fin proche'])

  const asked: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname === '/api/marketplace' && u.searchParams.has('q')) asked.push(u.search)
  })
  const field = page.getByRole('searchbox', { name: 'Rechercher une enchère' })
  await field.fill('a')
  await field.press('Enter')
  await expect(page.locator('main').getByRole('alert')).toHaveText('La recherche demande au moins 2 caractères')
  expect(asked).toEqual([])

  // Clavier des onglets (CardModal.tsx:175-192) : flèches et Fin, l'onglet suit le focus.
  await tablist.getByRole('tab', { name: 'Parcourir' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tablist.getByRole('tab', { name: 'Mes ventes (0/5)' })).toBeFocused()
  await expect(tablist.getByRole('tab', { name: 'Mes ventes (0/5)' })).toHaveClass(ACTIVE)
  await expect(page.getByText('Tu n\'as aucune vente en cours.', { exact: true })).toBeVisible()
  await page.keyboard.press('End')
  await expect(tablist.getByRole('tab', { name: 'Historique (0)' })).toBeFocused()
  await expect(page.getByText('Aucune vente terminée.', { exact: true })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(tablist.getByRole('tab', { name: 'Parcourir' })).toBeFocused()

  // 360 px : les onglets restent sur une ligne et défilent dans leur conteneur ; ni la page ni main ne défilent en largeur.
  await page.setViewportSize({ width: 360, height: 800 })
  expect(await tablist.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  const sides = await tablist.getByRole('tab').evaluateAll((els) => els.map((e) => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height)))
  expect(Math.min(...sides)).toBeGreaterThanOrEqual(44)
  await page.keyboard.press('End')
  await expect(tablist.getByRole('tab', { name: 'Historique (0)' })).toBeFocused()
  await expect(tablist.getByRole('tab', { name: 'Historique (0)' })).toBeInViewport()
})

test('51 enchères d\'une carte : 50 tuiles du contrat, puis 51 après « Charger la suite » ; cibles ≥ 44 px', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const t = title()
  const { ids } = listAuctions(51, t)
  await page.goto('/marketplace')
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).fill(t)
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).press('Enter')
  await expect(tiles(page)).toHaveCount(50)
  // Tri « Récentes » par défaut : la plus ancienne attend la page 2.
  await expect(tile(page, ids[0])).toHaveCount(0)
  await tiles(page).evaluateAll((els) => els.forEach((e) => e.setAttribute('data-e2e-first', '')))

  const more = page.getByRole('button', { name: 'Charger la suite' })
  const sides = await page.locator('[role=tab]').filter({ visible: true }).or(more)
    .evaluateAll((els) => els.map((e) => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height)))
  expect(sides).toHaveLength(6)
  expect(Math.min(...sides)).toBeGreaterThanOrEqual(44)

  await more.click()
  await expect(tiles(page)).toHaveCount(51)
  await expect(tile(page, ids[0])).toBeVisible()
  // Ajoutées au DOM : les 50 premières tuiles sont les mêmes nœuds.
  await expect(page.locator('[data-e2e-first]')).toHaveCount(50)
  await expect(more).toHaveCount(0)
  await expect(tiles(page).locator(':scope > a.card-frame.block.p-3[href^="/marketplace/"]')).toHaveCount(51)
  await expect(tiles(page).locator('time[datetime].text-amber-600.tabular-nums')).toHaveCount(51)
  await expect(tiles(page).locator('p.truncate')).toHaveText(Array(51).fill(/^Vendu par zz_/))
  await expect(tile(page, ids[0]).locator('a')).toHaveAttribute('href', `/marketplace/${ids[0]}`)
})

test('relecture de « Parcourir » : la tuile focalisée est réglée, puis « Charger la suite » disparaît ; le focus reste sur la liste, jamais sur body', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const t = title()
  // « Récentes » : ids[51] en tête ; la page 1 en a 50, la 2 les deux plus anciennes.
  const { ids } = listAuctions(52, t)
  await search(page, t)
  await expect(tiles(page)).toHaveCount(50)

  await tile(page, ids[51]).locator('a').focus()
  settle(ids[51])
  await rereadUntil(page, () => tile(page, ids[51]).count(), 0)
  // Même rang : la suivante.
  await expect(tile(page, ids[50]).locator('a')).toBeFocused()

  const more = page.getByRole('button', { name: 'Charger la suite' })
  await more.focus()
  settle(ids[50])
  await rereadUntil(page, () => more.count(), 0)
  await expect(tiles(page)).toHaveCount(50)
  // Rang du bouton, après la dernière tuile : la dernière.
  await expect(tile(page, ids[0]).locator('a')).toBeFocused()
})

test('relecture de « Parcourir » : la seule tuile, focalisée, est réglée → l\'état vide prend le focus', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const t = title()
  const { ids: [id] } = listAuctions(1, t)
  await search(page, t)
  await tile(page, id).locator('a').focus()
  settle(id)
  await rereadUntil(page, () => tiles(page).count(), 0)
  await expect(page.getByText('Aucune enchère ne correspond à ta recherche.', { exact: true })).toBeFocused()
})

test('tri « Prix croissant » sur coalesce(current_bid, base_amount) ; pastille UR : aucune tuile pour une carte R', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const t = title()
  const { ids } = listAuctions(3, t, 'R')
  const bidder = makePlayer({ balance: 1000, humanVerified: true })
  trash.uids.push(bidder.uid)
  // Mises sur les plus récentes : « Prix croissant » donne l'inverse de « Récentes », un tri ignoré ne passerait pas.
  sql(`\\o /dev/null
select wm.place_bid(:'b', :'a2', 300);
select wm.place_bid(:'b', :'a1', 200)`, { b: bidder.uid, a1: ids[1], a2: ids[2] })
  await page.goto('/marketplace')
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).fill(t)
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).press('Enter')
  await expect.poll(() => order(page)).toEqual([ids[2], ids[1], ids[0]])
  const sorted = page.waitForResponse((r) => {
    const u = new URL(r.url())
    return u.pathname === '/api/marketplace' && u.searchParams.get('sort') === 'price_asc' && u.searchParams.get('q') === t
  })
  await page.getByRole('combobox', { name: 'Trier' }).selectOption({ label: 'Prix croissant' })
  expect((await sorted).ok()).toBe(true)
  await expect.poll(() => order(page)).toEqual([ids[0], ids[1], ids[2]])
  await expect(tiles(page).nth(0)).toContainText('Mise de départ')
  await expect(tiles(page).nth(2)).toContainText('Mise actuelle')

  await page.getByRole('button', { name: 'UR', exact: true }).click()
  await expect(page.getByText('Aucune enchère ne correspond à ta recherche.', { exact: true })).toBeVisible()
  await expect(tiles(page)).toHaveCount(0)
})

test('« Mes ventes (1/5) » et sa tuile ; « Mes enchères » : « En tête » sur l\'enchère où il mène', async ({ page, login }) => {
  const me = await login({ humanVerified: true, balance: 1000 })
  trash.uids.push(me.uid)
  const t = title()
  const { card, ids: [other] } = listAuctions(1, t)
  const own = sql(`select from wm.grant_copy(:'me', :'card', false) \\g /dev/null
select wm.create_auction(:'me', :'card', 50, 60) ->> 'id';
update wm.user_state set list_window_count = 0 where user_id = :'me';
select from wm.place_bid(:'me', :'other', 100) \\g /dev/null`, { me: me.uid, card, other })
  await page.goto('/marketplace')
  const tablist = page.getByRole('tablist', { name: 'Vues du marché' })
  await tablist.getByRole('tab', { name: 'Mes ventes (1/5)' }).click()
  await expect(tile(page, own)).toBeVisible()
  await expect(tiles(page)).toHaveCount(1)
  await expect(tile(page, own)).toContainText('Mise de départ')

  await tablist.getByRole('tab', { name: 'Mes enchères (1)' }).click()
  await expect(tablist.getByRole('tab', { name: 'Mes enchères (1)' })).toHaveClass(ACTIVE)
  await expect(tile(page, other)).toContainText('En tête')
  await expect(tiles(page)).toHaveCount(1)
})

test('« Gagnées » : 50 tuiles puis 51, « Vendue pour 20 wikibidous » ; « Historique » : « Retirée » et « Invendue »', async ({ page, login }) => {
  const me = await login()
  const seller = makePlayer()
  trash.uids.push(me.uid, seller.uid)
  const card = cardOf(title())
  // Lignes réglées posées à la main : ni séquestre (enchères active seulement) ni mouvement d'argent (M3-26).
  const [cancelled, unsold] = sql(`insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, base_amount, listing_base_amount,
  current_bid, current_bidder_id, bids_count, final_price, status, end_at, created_at, settled_at, winner_id)
select :'seller', :'card', gen_random_uuid(), 'C', 10, 10, 20, :'me', 1, 20, 'settled_sold', now() - make_interval(mins => g),
  now() - make_interval(mins => g + 60), now() - make_interval(mins => g), :'me'
from generate_series(1, 51) g;
insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, base_amount, listing_base_amount, status, end_at, created_at, settled_at)
values (:'me', :'card', gen_random_uuid(), 'C', 10, 10, 'cancelled', now() + interval '1 hour', now() - interval '5 minutes', null),
  (:'me', :'card', gen_random_uuid(), 'C', 10, 10, 'settled_unsold', now() - interval '10 minutes', now() - interval '70 minutes', now() - interval '10 minutes')
returning id`, { me: me.uid, seller: seller.uid, card }).split('\n')
  await page.goto('/marketplace')
  const tablist = page.getByRole('tablist', { name: 'Vues du marché' })
  await tablist.getByRole('tab', { name: 'Gagnées' }).click()
  await expect(tiles(page)).toHaveCount(50)
  await page.getByRole('button', { name: 'Charger la suite' }).click()
  await expect(tiles(page)).toHaveCount(51)
  await expect(page.getByRole('button', { name: 'Charger la suite' })).toHaveCount(0)
  await expect(tiles(page).first()).toContainText('Vendue pour 20 wikibidous')

  await tablist.getByRole('tab', { name: 'Historique (2)' }).click()
  await expect(tiles(page)).toHaveCount(2)
  // Retirée avec un end_at encore futur : terminée quand même, jamais un compte à rebours.
  await expect(tile(page, cancelled).locator('time')).toHaveText('Terminée')
  await expect(tile(page, unsold).locator('time')).toHaveText('Terminée')
  // Issue de chaque vente : une retirée ne ressemble plus à une invendue.
  await expect(tile(page, cancelled)).toContainText('Retirée')
  await expect(tile(page, cancelled)).not.toContainText('Invendue')
  await expect(tile(page, unsold)).toContainText('Invendue')
})

// Détail (Task 12) : une enchère d'une carte neuve, base 10, 1 h, mise en vente par `seller` (vérifié : M3-13).
function sellOne(seller: string, t = title()): { card: string; id: string } {
  const card = cardOf(t)
  const id = sql(`select from wm.grant_copy(:'s', :'card', false) \\g /dev/null
select wm.create_auction(:'s', :'card', 10, 60) ->> 'id'`, { s: seller, card })
  return { card, id }
}
const toastOf = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text })
const amountField = (page: Page) => page.getByRole('spinbutton', { name: 'Montant de la mise' })
const priceRow = (page: Page) => page.locator('main p').filter({ hasText: /^(Mise actuelle|Mise de départ)/ })
const side = (l: ReturnType<Page['locator']>) => l.evaluate((e) => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))

test('détail : h1, mise préremplie à 10, « Miser » → toast, « Mise actuelle » 10, « En tête », pseudo dans l\'historique ; liste de souhaits ; cibles', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(me.uid, seller.uid)
  const t = title()
  const { id } = sellOne(seller.uid, t)
  await page.goto(`/marketplace/${id}`)
  await expect(page.locator('main h1')).toHaveText(t)
  // M3-2 : la page de détail ne rend aucune tuile du contrat (une page /marketplace gardée par Activity resterait dans le document),
  // ni aucun id d'élément (aria-label et data-* seulement).
  await expect(page.locator('main').filter({ visible: true }).locator('[id^="marketplace-auction-"]')).toHaveCount(0)
  await expect(page.locator('main [id]')).toHaveCount(0)
  await expect(page.getByText(`Vendu par ${seller.username}`, { exact: true })).toBeVisible()
  await expect(priceRow(page)).toHaveText(/^Mise de départ\s*10\b/)
  await expect(amountField(page)).toHaveValue('10')
  const bid = page.getByRole('button', { name: 'Miser' })
  expect(await side(bid)).toBeGreaterThanOrEqual(44)
  expect(await side(amountField(page))).toBeGreaterThanOrEqual(44)

  await bid.click()
  await expect(toastOf(page, 'Mise de 10 wikibidous placée.')).toBeVisible()
  await expect(priceRow(page)).toHaveText(/^Mise actuelle\s*10\b/)
  await expect(page.locator('main').getByText('En tête', { exact: true })).toBeVisible()
  // Le champ reprend le minimum suivant de la réponse : max(ceil(10 × 1,1), 11).
  await expect(amountField(page)).toHaveValue('11')
  await expect(page.getByRole('list', { name: 'Historique des mises' }).getByRole('listitem'))
    .toHaveText([new RegExp(`^${me.username} · 10 wikibidous · `)])

  // Bouton bascule (APG) : le libellé reste « Liste de souhaits », l'état est dans aria-pressed.
  const wish = page.getByRole('button', { name: 'Liste de souhaits', exact: true })
  await expect(wish).toHaveAttribute('aria-pressed', 'false')
  expect(await side(wish)).toBeGreaterThanOrEqual(44)
  await wish.click()
  await expect(wish).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(wish).toHaveAttribute('aria-pressed', 'true')
})

test('mise trop basse : un autre joueur a misé 10 entre-temps → « Mise trop basse (minimum 11 wikibidous) », le champ prend 11', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const seller = makePlayer({ humanVerified: true })
  const other = makePlayer({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid, seller.uid, other.uid)
  const { id } = sellOne(seller.uid)
  await page.goto(`/marketplace/${id}`)
  await amountField(page).fill('10')
  sql(`select from wm.place_bid(:'o', :'id', 10) \\g /dev/null`, { o: other.uid, id })
  await page.getByRole('button', { name: 'Miser' }).click()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Mise trop basse (minimum 11 wikibidous)')
  await expect(amountField(page)).toHaveValue('11')
  // Relu une fois le cache périmé : la mise de l'autre s'affiche, et le refus qu'elle explique reste (même minimum).
  await expect(priceRow(page)).toHaveText(/^Mise actuelle\s*10\b/)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Mise trop basse (minimum 11 wikibidous)')
})

test('« Tu es déjà en tête », puis la surenchère d\'un autre arrive par le polling : le refus tombe avec l\'état qu\'il décrivait', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const seller = makePlayer({ humanVerified: true })
  const other = makePlayer({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid, seller.uid, other.uid)
  const { id } = sellOne(seller.uid)
  sql(`select from wm.place_bid(:'me', :'id', 10) \\g /dev/null`, { me: me.uid, id })
  await page.goto(`/marketplace/${id}`)
  await expect(page.locator('main').getByText('En tête', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Miser' }).click()
  const alert = page.locator('main').getByRole('alert')
  await expect(alert).toHaveText('Tu es déjà en tête')
  sql(`select from wm.place_bid(:'o', :'id', 11) \\g /dev/null`, { o: other.uid, id })
  await rereadUntil(page, () => priceRow(page).textContent(), /^Mise actuelle\s*11\b/)
  await expect(page.locator('main').getByText('En tête', { exact: true })).toHaveCount(0)
  await expect(amountField(page)).toHaveValue('13')
  await expect(alert).toHaveCount(0)
})

test('réponse d\'une mise perdue, puis un autre montant : clé neuve, le nouveau montant est placé (aucune réponse rejouée)', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const seller = makePlayer({ humanVerified: true })
  const other = makePlayer({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid, seller.uid, other.uid)
  const { id } = sellOne(seller.uid)
  const keys: string[] = []
  await page.route(`**/api/marketplace/${id}/bid`, async (route) => {
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length > 1) return route.continue()
    // La première mise atteint le serveur et y est validée ; sa réponse est perdue.
    await route.fetch()
    await route.abort()
  })
  await page.goto(`/marketplace/${id}`)
  await page.getByRole('button', { name: 'Miser' }).click()
  await expect(page.locator('main').getByRole('alert'))
    .toHaveText('La mise n\'a pas été confirmée : elle a peut-être été placée. L\'enchère se met à jour.')
  // Surenchère d'un autre joueur (11) : le minimum suivant passe à 13.
  sql(`select from wm.place_bid(:'o', :'id', 11) \\g /dev/null`, { o: other.uid, id })
  await amountField(page).fill('13')
  await page.getByRole('button', { name: 'Miser' }).click()
  await expect(toastOf(page, 'Mise de 13 wikibidous placée.')).toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[1]).not.toBe(keys[0])
  expect(sql(`select current_bid || ' ' || (current_bidder_id = :'me') from public.auctions where id = :'id'`, { me: me.uid, id })).toBe('13 true')
})

test('clavier : focus sur « Montant de la mise », saisie, Entrée → mise placée, sans souris', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(me.uid, seller.uid)
  const { id } = sellOne(seller.uid)
  await page.goto(`/marketplace/${id}`)
  await amountField(page).focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('12')
  await page.keyboard.press('Enter')
  await expect(toastOf(page, 'Mise de 12 wikibidous placée.')).toBeVisible()
  await expect(priceRow(page)).toHaveText(/^Mise actuelle\s*12\b/)
})

test('joueur non vérifié : « Miser » → 403 → /api/human-check → une seule relance, clé neuve (P27) → toast', async ({ page, login }) => {
  const me = await login({ balance: 100 })
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(me.uid, seller.uid)
  const { id } = sellOne(seller.uid)
  await page.goto(`/marketplace/${id}`)
  const seen: string[] = []
  const keys: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path !== `/api/marketplace/${id}/bid` && path !== '/api/human-check') return
    seen.push(`${r.method()} ${path}`)
    if (path.endsWith('/bid')) keys.push(r.headers()['idempotency-key'])
  })
  await page.getByRole('button', { name: 'Miser' }).click()
  await expect(toastOf(page, 'Mise de 10 wikibidous placée.')).toBeVisible()
  expect(seen).toEqual([`POST /api/marketplace/${id}/bid`, 'POST /api/human-check', `POST /api/marketplace/${id}/bid`])
  expect(keys[0]).toBeTruthy()
  expect(keys[1]).not.toBe(keys[0])
})

test('vendeur sans mise : pas de champ de mise ni de baisse avant la moitié ; « Retirer » → toast, puis /marketplace', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid)
  const { id } = sellOne(me.uid)
  await page.goto(`/marketplace/${id}`)
  const cancel = page.getByRole('button', { name: 'Retirer', exact: true })
  await expect(cancel).toBeVisible()
  await expect(amountField(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Baisser le prix' })).toHaveCount(0)
  await cancel.click()
  await expect(toastOf(page, 'Enchère retirée : la carte est revenue dans ta collection.')).toBeVisible()
  await expect(page).toHaveURL(/\/marketplace$/)
})

test('vendeur, une mise arrivée entre-temps : « Retirer » → refus affiché tout de suite et bouton libéré, même si la relecture ne répond pas', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const bidder = makePlayer({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid, bidder.uid)
  const { id } = sellOne(me.uid)
  // Première lecture servie ; les suivantes (relecture du refus, polling) restent sans réponse, comme un serveur saturé.
  let served = false
  await page.route(`**/api/marketplace/${id}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (served) return
    served = true
    return route.fallback()
  })
  await page.goto(`/marketplace/${id}`)
  const cancel = page.getByRole('button', { name: 'Retirer', exact: true })
  await expect(cancel).toBeVisible()
  sql(`select from wm.place_bid(:'b', :'id', 10) \\g /dev/null`, { b: bidder.uid, id })
  await cancel.click()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Une enchère en cours ne peut pas être retirée')
  await expect(cancel).not.toHaveAttribute('aria-disabled')
})

test('vendeur, une mise arrivée entre-temps : « Retirer » au clavier → refus relu, le bouton disparaît, le focus passe au prix (jamais sur body)', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const bidder = makePlayer({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid, bidder.uid)
  const { id } = sellOne(me.uid)
  await page.goto(`/marketplace/${id}`)
  const cancel = page.getByRole('button', { name: 'Retirer', exact: true })
  await cancel.focus()
  sql(`select from wm.place_bid(:'b', :'id', 10) \\g /dev/null`, { b: bidder.uid, id })
  // Détail partagé en cache (1 s, servi 2 s au plus) : attendu frais, pour que la relecture qui suit le refus voie la mise.
  await expect.poll(async () => (await (await page.request.get(`/api/marketplace/${id}`)).json()).auction.current_bid).toBe(10)
  await page.keyboard.press('Enter')
  await expect(page.locator('main').getByRole('alert')).toHaveText('Une enchère en cours ne peut pas être retirée')
  await expect(cancel).toHaveCount(0)
  await expect(priceRow(page).locator('..')).toBeFocused()
})

test('vendeur, moitié de la durée passée : « Baisser le prix », « Nouveau prix » 5 proposé, 1 saisi, « Valider » → « Prix baissé à 1 wikibidou »', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid)
  const { id } = sellOne(me.uid)
  // L'UI compte la moitié sur end_at − created_at ; le serveur sur la durée du séquestre (60 min) : 31 min passées pour les deux.
  sql(`update public.auctions set created_at = created_at - interval '31 minutes', end_at = end_at - interval '31 minutes' where id = :'id'`, { id })
  await page.goto(`/marketplace/${id}`)
  await page.getByRole('button', { name: 'Baisser le prix' }).click()
  const price = page.getByRole('spinbutton', { name: 'Nouveau prix' })
  await expect(price).toHaveValue('5')
  await price.fill('1')
  await page.getByRole('button', { name: 'Valider' }).click()
  await expect(toastText(page, 'Prix baissé à 1 wikibidou')).toBeVisible()
  await expect(priceRow(page)).toHaveText(/^Mise de départ\s*1 wikibidou\b/)
  await expect(page.getByRole('button', { name: 'Baisser le prix' })).toHaveCount(0)
  // Le bouton pressé disparaît : le focus passe à « Retirer », jamais sur body.
  await expect(page.getByRole('button', { name: 'Retirer', exact: true })).toBeFocused()
})

test('« Finaliser la vente » à l\'échéance, par l\'horloge et sans règlement paresseux : POST /settle → « Remportée »', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(me.uid, seller.uid)
  const { id } = sellOne(seller.uid)
  sql(`select from wm.place_bid(:'me', :'id', 10) \\g /dev/null`, { me: me.uid, id })
  // Première lecture : la vraie, échéance posée à 4 s dans son corps et dans la base (corps seul : sa Date ferait reculer serverNow()).
  // Les suivantes restent sans réponse : aucune ne règle l'enchère ni ne rend la page, « Finaliser » ne peut venir que de l'horloge.
  let end: string | undefined
  await page.route(`**/api/marketplace/${id}`, async (route) => {
    if (end) return
    end = new Date(Date.now() + 4_000).toISOString()
    const body = await (await route.fetch()).json()
    sql(`update public.auctions set end_at = :'end' where id = :'id'`, { end, id })
    body.auction.end_at = end
    await route.fulfill({ json: body })
  })
  await page.goto(`/marketplace/${id}`)
  await expect(page.locator('main').getByText('En tête', { exact: true })).toBeVisible()
  const settle = page.getByRole('button', { name: 'Finaliser la vente' })
  await expect(settle).toBeVisible({ timeout: 10_000 })
  expect(sql(`select status from public.auctions where id = :'id'`, { id })).toBe('active')
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/marketplace/${id}/settle`)
  await settle.click()
  expect((await settled).status()).toBe(200)
  await expect(page.locator('main').getByText('Remportée', { exact: true })).toBeVisible()
  await expect(page.getByText('Vendue pour 10 wikibidous', { exact: true })).toBeVisible()
  await expect(settle).toHaveCount(0)
})

test('détail à 360 px : un titre d\'un seul long mot passe à la ligne, ni la page ni main ne défilent en largeur', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(seller.uid)
  // Un mot de 31 caractères en Rubik gras de 24 px, bien plus large que les ≈ 184 px laissés au titre à côté des deux boutons ronds.
  const t = `Zzélectromagnétisme${randomUUID().slice(-12)}`
  const { id } = sellOne(seller.uid, t)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto(`/marketplace/${id}`)
  await expect(page.locator('main h1')).toHaveText(t)
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('enchère inconnue → « Auction not found » et « Retour au marché »', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  await page.goto(`/marketplace/${randomUUID()}`)
  await expect(page.getByText('Auction not found', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Retour au marché' }).click()
  await expect(page).toHaveURL(/\/marketplace$/)
})

test('« Analyse du marché » : résumé pour tous ; joueur gratuit → « Fonction réservée aux membres Pro » ; un Pro voit les ventes', async ({ page, login }) => {
  const free = await login()
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(free.uid, seller.uid)
  const { card, id } = sellOne(seller.uid)
  // Une vente réglée posée à la main avant toute lecture du résumé (caché 60 s) : ni séquestre ni argent (M3-26).
  sql(`insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, base_amount, listing_base_amount, current_bid,
  current_bidder_id, bids_count, final_price, status, end_at, created_at, settled_at, winner_id)
values (:'s', :'card', gen_random_uuid(), 'C', 10, 10, 12, :'w', 1, 12, 'settled_sold', now() - interval '1 hour', now() - interval '2 hours',
  now() - interval '1 hour', :'w')`, { s: seller.uid, card, w: free.uid })
  const open = async () => {
    await page.goto(`/marketplace/${id}`)
    await page.getByRole('button', { name: 'Analyse du marché' }).click()
    return page.getByRole('dialog', { name: 'Analyse du marché' })
  }
  let dialog = await open()
  await expect(dialog.getByText('Marché · Commune : 12 wikibidous (1 vente)', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Fonction réservée aux membres Pro', { exact: true })).toBeVisible()

  trash.uids.push((await login({ pro: true })).uid)
  dialog = await open()
  await expect(dialog.getByRole('list', { name: 'Ventes récentes' }).getByRole('listitem')).toHaveText([/^Commune · 12 wikibidous · /])
  await expect(dialog.getByText('Fonction réservée aux membres Pro', { exact: true })).toHaveCount(0)
})

test('liste affichée : le prefetch des tuiles ne lit ni ne règle aucune enchère, même échue ; après le clic, une seule lecture', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const seller = makePlayer({ humanVerified: true })
  const bidder = makePlayer({ balance: 100, humanVerified: true })
  trash.uids.push(seller.uid, bidder.uid)
  const t = title()
  const { card, id } = sellOne(seller.uid, t)
  // Échue avec une mise, pas encore réglée (aucun cron au banc) : un auction_detail côté serveur pendant un prefetch la réglerait.
  const due = sql(`select from wm.grant_copy(:'s', :'card', false) \\g /dev/null
select wm.create_auction(:'s', :'card', 10, 60) ->> 'id' as id \\gset
select from wm.place_bid(:'b', :'id', 10) \\g /dev/null
update public.auctions set end_at = now() - interval '1 minute' where id = :'id';
\\echo :id`, { s: seller.uid, b: bidder.uid, card })
  // Lectures du détail de toute enchère, et adresses prefetchées.
  const reads: string[] = []
  const prefetched: string[] = []
  const pending = new Set<Request>()
  let last = 0
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (/^\/api\/marketplace\/[0-9a-f-]{36}$/.test(path)) reads.push(`${r.method()} ${path}`)
    if (!path.startsWith('/marketplace/') || !r.headers()['next-router-prefetch']) return
    prefetched.push(path)
    pending.add(r)
    last = Date.now()
  })
  // Next apprend la route d'une seule adresse, puis ne prefetch plus forcément les suivantes, survol compris (1 fois sur 12 mesurée) :
  // les prefetchs des tuiles des autres workers sont coupés, pour que l'adresse de l'enchère échue soit toujours demandée.
  await page.route('**/marketplace/*', (route) => {
    const path = new URL(route.request().url()).pathname
    const ours = path === `/marketplace/${due}` || path === `/marketplace/${id}`
    return route.request().headers()['next-router-prefetch'] && !ours ? route.abort() : route.fallback()
  })
  const done = (r: Request) => { if (pending.delete(r)) last = Date.now() }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  await page.goto('/marketplace')
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).fill(t)
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).press('Enter')
  await page.getByRole('combobox', { name: 'Trier' }).selectOption({ label: 'Fin proche' })
  await expect.poll(() => order(page)).toEqual([due, id])
  // Prefetch de l'enchère échue parti (production seulement), tous finis, et plus aucun depuis 500 ms.
  await expect.poll(() => prefetched.includes(`/marketplace/${due}`) && pending.size === 0 && Date.now() - last > 500).toBe(true)
  expect(reads).toEqual([])
  expect(sql(`select status from public.auctions where id = :'due'`, { due })).toBe('active')
  await tile(page, id).locator('a').click()
  // Activity garde /marketplace cachée, avec son h1 : seul le visible compte.
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText(t)
  expect(reads).toEqual([`GET /api/marketplace/${id}`])
  // /marketplace gardée par Activity reste dans le document, cachée : aucune tuile visible dans main (M3-2).
  await expect(page.locator('main [id^="marketplace-auction-"]').filter({ visible: true })).toHaveCount(0)
})

// Modale de carte (Task 13) : une copie d'une carte neuve chez `uid` ; la modale s'ouvre depuis /collection.
function copyOf(uid: string, rarity = 'C'): { t: string; card: string } {
  const t = title()
  const card = cardOf(t, rarity)
  sql(`select from wm.grant_copy(:'u', :'card', false) \\g /dev/null`, { u: uid, card })
  return { t, card }
}
async function openCopy(page: Page, t: string) {
  await page.goto('/collection')
  await page.getByRole('button', { name: t, exact: true }).click()
  const dialog = page.getByRole('dialog', { name: t })
  await expect(dialog).toBeVisible()
  return dialog
}
// Ventes réglées posées à la main avant toute lecture du résumé de la carte (caché 60 s) : ni séquestre ni argent (M3-26).
function sold(card: string, rarity: string, prices: number[], seller: string, winner: string) {
  sql(`insert into public.auctions (seller_id, card_id, user_card_id, snapshot_rarity, base_amount, listing_base_amount, current_bid,
  current_bidder_id, bids_count, final_price, status, end_at, created_at, settled_at, winner_id)
select :'s', :'card', gen_random_uuid(), :'r', 10, 10, p, :'w', 1, p, 'settled_sold', now() - interval '1 hour', now() - interval '2 hours',
  now() - interval '1 hour', :'w'
from unnest(string_to_array(:'p', ',')::int[]) p`, { s: seller, w: winner, card, r: rarity, p: prices.join(',') })
}
const UNSURE_SALE = 'La mise aux enchères n\'a pas été confirmée : la carte est peut-être déjà en vente. Relance-la telle quelle pour le savoir.'
const BUSY = 'Le site est très sollicité, réessaie dans un instant.'
const busyReply = { status: 503, headers: { 'Retry-After': '1' }, json: { status: 503, code: 'BUSY', error: BUSY, message: BUSY } }
// Tuiles de /collection (sans le rôle : la modale ouverte peut sortir la page de l'arbre d'accessibilité) et leur bouton d'ouverture.
const gridTiles = (page: Page) => page.locator('div.flex.flex-wrap.justify-center.gap-3 > div.relative.isolate.group')
const openerOf = (page: Page, t: string) => page.locator(`h3 > button[aria-label="${t}"]`)
// Première vente retenue jusqu'à release(), puis passée au serveur, remplacée par `reply`, ou validée avec sa réponse perdue ('lost').
async function holdSale(page: Page, reply?: Parameters<Route['fulfill']>[0] | 'lost') {
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await routeOnce(page, '**/api/marketplace', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await held
    if (reply !== 'lost') return reply ? route.fulfill(reply) : route.fallback()
    await route.fetch()
    return route.abort()
  })
  return () => release()
}
const toastText = (page: Page, text: string) => page.getByRole('status').getByText(text, { exact: true })
const AUCTION_URL = /\/marketplace\/[0-9a-f-]{36}$/
// Mise de départ et durée en minutes de l'enchère affichée, lues en base.
const listed = (page: Page, seller: string) => sql(`select base_amount || ' ' || round(extract(epoch from end_at - created_at) / 60)
from public.auctions where id = :'id' and seller_id = :'s'`, { id: new URL(page.url()).pathname.split('/').pop()!, s: seller })
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 30 && !(await target.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(target).toBeFocused()
}

test('« Mettre aux enchères » : 1 234 et « 30 min » → toast exact, /marketplace/<id> ; de retour, la copie n\'est plus dans /collection ; cibles', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const { t } = copyOf(me.uid)
  const dialog = await openCopy(page, t)
  const sell = dialog.getByRole('button', { name: 'Mettre aux enchères' })
  await expect(sell).toHaveAttribute('aria-expanded', 'false')
  await sell.click()
  await expect(sell).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.getByText('Marché · Commune : aucune vente récente', { exact: true })).toBeVisible()
  const amount = dialog.getByRole('spinbutton', { name: 'Mise de départ' })
  await expect(amount).toHaveValue('10')
  const durations = dialog.getByRole('button', { name: /^\d+ (min|h)$/ })
  await expect(durations).toHaveText(['10 min', '30 min', '1 h', '3 h', '6 h', '12 h'])
  await expect(dialog.getByRole('button', { name: '1 h' })).toHaveAttribute('aria-pressed', 'true')
  const launch = dialog.getByRole('button', { name: 'Lancer l\'enchère' })
  const sides = await durations.or(launch).evaluateAll((els) => els.map((e) => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height)))
  expect(sides).toHaveLength(7)
  expect(Math.min(...sides)).toBeGreaterThanOrEqual(44)

  await amount.fill('1234')
  await dialog.getByRole('button', { name: '30 min' }).click()
  await expect(dialog.getByRole('button', { name: '30 min' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('button', { name: '1 h' })).toHaveAttribute('aria-pressed', 'false')
  await launch.click()
  await expect(toastText(page, `${t} a bien été mise aux enchères pour ${formatInt(1234)} wikibidous`)).toBeVisible()
  await expect(page).toHaveURL(AUCTION_URL)
  expect(listed(page, me.uid)).toBe('1234 30')
  // /collection gardée par Activity : fermée et relue avant la navigation (P20), elle ne montre plus la copie partie au séquestre.
  await page.goBack()
  await expect(page.getByText('Ta collection est vide', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: t, exact: true }).filter({ visible: true })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('joueur non vérifié : « Lancer l\'enchère » → 403 → /api/human-check → une seule relance, clé neuve (P27) → toast', async ({ page, login }) => {
  const me = await login()
  trash.uids.push(me.uid)
  const { t } = copyOf(me.uid)
  const dialog = await openCopy(page, t)
  const seen: string[] = []
  const keys: string[] = []
  page.on('response', (r) => {
    const path = new URL(r.url()).pathname
    if (r.request().method() !== 'POST' || (path !== '/api/marketplace' && path !== '/api/human-check')) return
    seen.push(`${path} ${r.status()}`)
    if (path === '/api/marketplace') keys.push(r.request().headers()['idempotency-key'])
  })
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await expect(toastText(page, `${t} a bien été mise aux enchères pour 10 wikibidous`)).toBeVisible()
  await expect(page).toHaveURL(AUCTION_URL)
  expect(seen).toEqual(['/api/marketplace 403', '/api/human-check 200', '/api/marketplace 201'])
  expect(keys[0]).toBeTruthy()
  expect(keys[1]).not.toBe(keys[0])
  expect(listed(page, me.uid)).toBe('10 60')
})

test('vente à la réponse perdue : un autre montant part avec une clé neuve (refusé, copie au séquestre) ; relancée telle quelle, elle est rejouée', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const { t, card } = copyOf(me.uid)
  const keys: string[] = []
  await page.route('**/api/marketplace', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length > 1) return route.fallback()
    // La première vente atteint le serveur et y est validée ; sa réponse est perdue.
    await route.fetch()
    await route.abort()
  })
  const dialog = await openCopy(page, t)
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  const launch = dialog.getByRole('button', { name: 'Lancer l\'enchère' })
  await launch.click()
  await expect(dialog.getByRole('alert'))
    .toHaveText('La mise aux enchères n\'a pas été confirmée : la carte est peut-être déjà en vente. Relance-la telle quelle pour le savoir.')
  const amount = dialog.getByRole('spinbutton', { name: 'Mise de départ' })
  await amount.fill('20')
  await launch.click()
  await expect(dialog.getByRole('alert')).toHaveText('Vous ne possédez pas cette carte')
  await amount.fill('10')
  await launch.click()
  await expect(toastText(page, `${t} a bien été mise aux enchères pour 10 wikibidous`)).toBeVisible()
  await expect(page).toHaveURL(AUCTION_URL)
  expect(keys).toHaveLength(3)
  expect(keys[1]).not.toBe(keys[0])
  expect(keys[2]).toBe(keys[0])
  expect(sql(`select count(*) from public.auctions where card_id = :'card'`, { card })).toBe('1')
  expect(listed(page, me.uid)).toBe('10 60')
})

test('pile de 2, réponse de la vente perdue : grille relue derrière la modale ; rouverte sur ×1, la même vente part avec une clé neuve', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const { t, card } = copyOf(me.uid)
  sql(`update public.user_cards set count = 2 where user_id = :'u' and card_id = :'card'`, { u: me.uid, card })
  const keys: string[] = []
  await page.route('**/api/marketplace', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    keys.push(route.request().headers()['idempotency-key'])
    if (keys.length > 1) return route.fallback()
    // La vente du premier exemplaire atteint le serveur et y est validée ; sa réponse est perdue.
    await route.fetch()
    await route.abort()
  })
  let dialog = await openCopy(page, t)
  await expect(dialog.getByText('Exemplaires : 2', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  const reread = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/my-collection')
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(UNSURE_SALE)
  // Grille relue derrière la modale, qui reste ouverte : la tuile n'a plus que l'exemplaire restant.
  expect((await reread).ok()).toBe(true)
  await expect(gridTiles(page).getByText('x2', { exact: true })).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveText(UNSURE_SALE)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: t, exact: true }).click()
  dialog = page.getByRole('dialog', { name: t })
  await expect(dialog.getByText('Exemplaires : 1', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await expect(toastText(page, `${t} a bien été mise aux enchères pour 10 wikibidous`)).toBeVisible()
  await expect(page).toHaveURL(AUCTION_URL)
  expect(keys).toHaveLength(2)
  expect(keys[1]).not.toBe(keys[0])
  expect(sql(`select count(*) from public.auctions where card_id = :'card' and status = 'active'`, { card })).toBe('2')
})

test('vente en cours : « Mettre aux enchères » inactif, la boîte reste ouverte ; le refus BUSY s\'y affiche', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const { t } = copyOf(me.uid)
  const release = await holdSale(page, busyReply)
  const dialog = await openCopy(page, t)
  const toggle = dialog.getByRole('button', { name: 'Mettre aux enchères' })
  await toggle.click()
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await expect(toggle).toHaveAttribute('aria-disabled', 'true')
  // Inactif mais focalisable : Entrée ne replie pas la boîte.
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  release()
  await expect(dialog.getByRole('alert')).toHaveText(BUSY)
  await expect(toggle).not.toHaveAttribute('aria-disabled')
  await expect(toggle).toBeFocused()
})

test('modale fermée pendant la vente : le refus BUSY passe par un toast, sans navigation', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const { t } = copyOf(me.uid)
  const release = await holdSale(page, busyReply)
  const dialog = await openCopy(page, t)
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/marketplace')
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await sent
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  release()
  await expect(toastText(page, BUSY)).toBeVisible()
  await expect(page).toHaveURL(/\/collection$/)
  await expect(openerOf(page, t)).toHaveCount(1)
})

test('modale fermée pendant la vente, une autre ouverte depuis : succès → toast, l\'autre modale reste, aucune navigation ; la copie quitte la grille', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const a = copyOf(me.uid)
  const b = copyOf(me.uid)
  const release = await holdSale(page)
  const dialog = await openCopy(page, a.t)
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/marketplace')
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await sent
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await openerOf(page, b.t).click()
  const other = page.getByRole('dialog', { name: b.t })
  await expect(other).toBeVisible()
  release()
  await expect(toastText(page, `${a.t} a bien été mise aux enchères pour 10 wikibidous`)).toBeVisible()
  // Grille relue (P20) derrière la modale ouverte depuis, qui reste ouverte ; la page ne quitte pas /collection.
  await expect(openerOf(page, a.t)).toHaveCount(0)
  await expect(openerOf(page, b.t)).toHaveCount(1)
  await expect(other).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/collection')
  expect(sql(`select count(*) from public.auctions where card_id = :'card' and status = 'active'`, { card: a.card })).toBe('1')
})

test('issue inconnue de la vente d\'une copie unique : grille relue sous la modale ; Échap rend le focus à sa voisine, pas à la première tuile', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  for (let i = 0; i < 3; i++) copyOf(me.uid)
  await routeOnce(page, '**/api/marketplace', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fetch()
    await route.abort()
  })
  await page.goto('/collection')
  const openers = page.locator('h3 > button[aria-label]')
  await expect(openers).toHaveCount(3)
  const names = await openers.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!))
  await openers.nth(1).click()
  const dialog = page.getByRole('dialog', { name: names[1] })
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await expect(dialog.getByRole('alert')).toHaveText(UNSURE_SALE)
  await expect(openers).toHaveCount(2)
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(openerOf(page, names[2])).toBeFocused()
})

test('modale fermée pendant une vente d\'issue inconnue (copie unique) : toast, grille relue, le focus va à la voisine, jamais à body', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  for (let i = 0; i < 3; i++) copyOf(me.uid)
  const release = await holdSale(page, 'lost')
  await page.goto('/collection')
  const openers = page.locator('h3 > button[aria-label]')
  await expect(openers).toHaveCount(3)
  const names = await openers.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!))
  await openers.nth(1).click()
  const dialog = page.getByRole('dialog', { name: names[1] })
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/marketplace')
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await sent
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(openerOf(page, names[1])).toBeFocused()
  const reread = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/my-collection')
  release()
  await expect(toastText(page, UNSURE_SALE)).toBeVisible()
  expect((await reread).ok()).toBe(true)
  await expect(openers).toHaveCount(2)
  await expect(openerOf(page, names[2])).toBeFocused()
})

test('/collection cachée par Activity pendant la vente : refus BUSY en toast, et au retour la boîte le montre encore', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const { t } = copyOf(me.uid)
  const release = await holdSale(page, busyReply)
  const dialog = await openCopy(page, t)
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  const sent = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/marketplace')
  await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
  await sent
  // Le voile de la modale couvre la barre latérale : le clic est remis au lien lui-même (navigation du routeur, page gardée par Activity).
  await page.locator('nav a[href="/pulls"]').first().dispatchEvent('click')
  await expect(page).toHaveURL('/pulls')
  release()
  await expect(toastText(page, BUSY)).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('/collection')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('alert')).toHaveText(BUSY)
})

test('boîte de vente : « Marché · Rare : 12 wikibidous », moyenne arrondie des ventes de la carte en R (11 et 12)', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  const seller = makePlayer()
  trash.uids.push(me.uid, seller.uid)
  const { t, card } = copyOf(me.uid, 'R')
  sold(card, 'R', [11, 12], seller.uid, me.uid)
  const dialog = await openCopy(page, t)
  await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
  await expect(dialog.getByText('Marché · Rare : 12 wikibidous', { exact: true })).toBeVisible()
})

test('clavier : Tab jusqu\'à « Mettre aux enchères », Entrée, mise, Tab vers « 3 h », Entrée, Tab vers « Lancer l\'enchère », Entrée → l\'enchère', async ({ page, login }) => {
  const me = await login({ humanVerified: true })
  trash.uids.push(me.uid)
  const { t } = copyOf(me.uid)
  await page.goto('/collection')
  await page.getByRole('button', { name: t, exact: true }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: t })
  await tabTo(page, dialog.getByRole('button', { name: 'Mettre aux enchères' }))
  await page.keyboard.press('Enter')
  // La boîte s'ouvre sur sa mise de départ.
  await expect(dialog.getByRole('spinbutton', { name: 'Mise de départ' })).toBeFocused()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('77')
  await tabTo(page, dialog.getByRole('button', { name: '3 h' }))
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('button', { name: '3 h' })).toHaveAttribute('aria-pressed', 'true')
  await tabTo(page, dialog.getByRole('button', { name: 'Lancer l\'enchère' }))
  await page.keyboard.press('Enter')
  await expect(toastText(page, `${t} a bien été mise aux enchères pour 77 wikibidous`)).toBeVisible()
  await expect(page).toHaveURL(AUCTION_URL)
  expect(listed(page, me.uid)).toBe('77 180')
})

test('onglet « Marché » de la modale : résumé pour tous ; joueur gratuit → « Fonction réservée aux membres Pro » ; un Pro voit les ventes', async ({ page, login }) => {
  const free = await login()
  const seller = makePlayer()
  trash.uids.push(free.uid, seller.uid)
  const { t, card } = copyOf(free.uid)
  sold(card, 'C', [12], seller.uid, free.uid)
  const market = async () => {
    const dialog = await openCopy(page, t)
    await dialog.getByRole('tab', { name: /^Marché/ }).click()
    return dialog
  }
  let dialog = await market()
  await expect(dialog.getByText('Marché · Commune : 12 wikibidous (1 vente)', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Fonction réservée aux membres Pro', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Arrive bientôt')).toHaveCount(0)

  const pro = await login({ pro: true })
  trash.uids.push(pro.uid)
  sql(`select from wm.grant_copy(:'u', :'card', false) \\g /dev/null`, { u: pro.uid, card })
  dialog = await market()
  await expect(dialog.getByText('Marché · Commune : 12 wikibidous (1 vente)', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('list', { name: 'Ventes récentes' }).getByRole('listitem')).toHaveText([/^Commune · 12 wikibidous · /])
  await expect(dialog.getByText('Fonction réservée aux membres Pro', { exact: true })).toHaveCount(0)
})
