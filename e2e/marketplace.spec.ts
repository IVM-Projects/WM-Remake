import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, makePlayer, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a sa carte au titre unique, filtre par ce titre et nettoie à la fin (Global Constraints).
const title = () => `Zz marché e2e ${randomUUID().slice(-12)}`
// Tuiles de l'onglet visible (Activity : une page gardée resterait dans le DOM, preserving-ui-state.md:355-389).
const tiles = (page: Page) => page.locator('[id^="marketplace-auction-"]').filter({ visible: true })
const tile = (page: Page, id: string) => page.locator(`[id="marketplace-auction-${id}"]`).filter({ visible: true })
const ACTIVE = /border-b-2 border-amber-500 text-amber-600/

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

test('tri « Prix croissant » sur coalesce(current_bid, base_amount) ; pastille UR : aucune tuile pour une carte R', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const t = title()
  const { ids } = listAuctions(3, t, 'R')
  const bidder = makePlayer({ balance: 1000, humanVerified: true })
  trash.uids.push(bidder.uid)
  sql(`\\o /dev/null
select wm.place_bid(:'b', :'a0', 300);
select wm.place_bid(:'b', :'a1', 200)`, { b: bidder.uid, a0: ids[0], a1: ids[1] })
  await page.goto('/marketplace')
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).fill(t)
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).press('Enter')
  await expect(tiles(page)).toHaveCount(3)
  await page.getByRole('combobox', { name: 'Trier' }).selectOption({ label: 'Prix croissant' })
  for (const [i, id] of [ids[2], ids[1], ids[0]].entries()) await expect(tiles(page).nth(i)).toHaveId(`marketplace-auction-${id}`)
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

test('« Gagnées » : 50 tuiles puis 51 ; « Historique » : une vente retirée et une invendue', async ({ page, login }) => {
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

  await tablist.getByRole('tab', { name: 'Historique (2)' }).click()
  await expect(tiles(page)).toHaveCount(2)
  await expect(tile(page, cancelled)).toBeVisible()
  await expect(tile(page, unsold)).toBeVisible()
})
