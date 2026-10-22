import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, makePlayer, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a sa carte au titre unique, filtre par ce titre et nettoie à la fin (Global Constraints).
const title = () => `Zz marché e2e ${randomUUID().slice(-12)}`
// Tuiles de l'onglet visible (Activity : une page gardée resterait dans le DOM, preserving-ui-state.md:355-389).
const tiles = (page: Page) => page.locator('[id^="marketplace-auction-"]').filter({ visible: true })
const tile = (page: Page, id: string) => page.locator(`[id="marketplace-auction-${id}"]`).filter({ visible: true })
const ACTIVE = /border-b-2 border-amber-500 text-amber-600/
const order = (page: Page) => tiles(page).evaluateAll((els) => els.map((e) => e.id.replace('marketplace-auction-', '')))

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
  // Retirée avec un end_at encore futur : terminée quand même, jamais un compte à rebours.
  await expect(tile(page, cancelled).locator('time')).toHaveText('Terminée')
  await expect(tile(page, unsold).locator('time')).toHaveText('Terminée')
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

  const add = page.getByRole('button', { name: 'Ajouter à ma liste de souhaits' })
  await expect(add).toHaveAttribute('aria-pressed', 'false')
  expect(await side(add)).toBeGreaterThanOrEqual(44)
  await add.click()
  const remove = page.getByRole('button', { name: 'Retirer de ma liste de souhaits' })
  await expect(remove).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(remove).toHaveAttribute('aria-pressed', 'true')
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

test('vendeur, moitié de la durée passée : « Baisser le prix », « Nouveau prix » 5, « Valider » → « Prix baissé à 5 wikibidous »', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  trash.uids.push(me.uid)
  const { id } = sellOne(me.uid)
  // L'UI compte la moitié sur end_at − created_at ; le serveur sur la durée du séquestre (60 min) : 31 min passées pour les deux.
  sql(`update public.auctions set created_at = created_at - interval '31 minutes', end_at = end_at - interval '31 minutes' where id = :'id'`, { id })
  await page.goto(`/marketplace/${id}`)
  await page.getByRole('button', { name: 'Baisser le prix' }).click()
  const price = page.getByRole('spinbutton', { name: 'Nouveau prix' })
  await expect(price).toHaveValue('5')
  await page.getByRole('button', { name: 'Valider' }).click()
  await expect(toastOf(page, 'Prix baissé à 5 wikibidous')).toBeVisible()
  await expect(priceRow(page)).toHaveText(/^Mise de départ\s*5\b/)
  await expect(page.getByRole('button', { name: 'Baisser le prix' })).toHaveCount(0)
  // Le bouton pressé disparaît : le focus passe à « Retirer », jamais sur body.
  await expect(page.getByRole('button', { name: 'Retirer', exact: true })).toBeFocused()
})

test('« Finaliser la vente » à l\'échéance, sans règlement paresseux : POST /settle → « Remportée »', async ({ page, login }) => {
  const me = await login({ balance: 100, humanVerified: true })
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(me.uid, seller.uid)
  const { id } = sellOne(seller.uid)
  // end_at posé après la mise : sinon l'anti-snipe le repousserait de 60 s (M3-15).
  sql(`select from wm.place_bid(:'me', :'id', 10) \\g /dev/null
update public.auctions set end_at = now() + interval '4 seconds' where id = :'id'`, { me: me.uid, id })
  // Toute lecture rejoue la première réponse : aucune ne règle par la voie paresseuse. Corps seul, sans l'en-tête Date d'origine,
  // qui ferait reculer serverNow() à chaque relecture (lib/clock.ts, noteServerDate).
  let first: Promise<unknown> | undefined
  await page.route(`**/api/marketplace/${id}`, async (route) => {
    first ??= route.fetch().then((r) => r.json())
    await route.fulfill({ json: await first })
  })
  await page.goto(`/marketplace/${id}`)
  await expect(page.locator('main').getByText('En tête', { exact: true })).toBeVisible()
  const settle = page.getByRole('button', { name: 'Finaliser la vente' })
  await expect(settle).toBeVisible({ timeout: 10_000 })
  const settled = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/marketplace/${id}/settle`)
  await settle.click()
  expect((await settled).status()).toBe(200)
  await expect(page.locator('main').getByText('Remportée', { exact: true })).toBeVisible()
  await expect(page.getByText('Vendue pour 10 wikibidous', { exact: true })).toBeVisible()
  await expect(settle).toHaveCount(0)
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

test('liste affichée : aucun GET /api/marketplace/<id> avant le clic (le prefetch des tuiles ne charge que la coquille)', async ({ page, login }) => {
  trash.uids.push((await login()).uid)
  const seller = makePlayer({ humanVerified: true })
  trash.uids.push(seller.uid)
  const t = title()
  const { id } = sellOne(seller.uid, t)
  // Lectures du détail de toute enchère (les tuiles des autres workers aussi) ; prefetchs de toute tuile : la coquille est la même pour
  // toutes les enchères, et une fois la route apprise d'une tuile, Next ne prefetch plus forcément l'adresse des suivantes.
  const reads: string[] = []
  let prefetches = 0
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (/^\/api\/marketplace\/[0-9a-f-]{36}$/.test(path)) reads.push(`${r.method()} ${path}`)
    if (path.startsWith('/marketplace/') && r.headers()['next-router-prefetch']) prefetches++
  })
  await page.goto('/marketplace')
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).fill(t)
  await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).press('Enter')
  await expect(tile(page, id)).toBeVisible()
  // Un prefetch de tuile est parti (production seulement), et aucun n'a lu ni réglé d'enchère.
  await expect.poll(() => prefetches).toBeGreaterThan(0)
  await page.waitForLoadState('networkidle')
  expect(reads).toEqual([])
  await tile(page, id).locator('a').click()
  // Activity garde /marketplace cachée, avec son h1 : seul le visible compte.
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText(t)
  expect(reads).toEqual([`GET /api/marketplace/${id}`])
  // /marketplace gardée par Activity reste dans le document, cachée : aucune tuile visible dans main (M3-2).
  await expect(page.locator('main [id^="marketplace-auction-"]').filter({ visible: true })).toHaveCount(0)
})
