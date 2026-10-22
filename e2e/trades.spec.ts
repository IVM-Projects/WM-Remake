import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { befriend, expect, giveCopies, hydrated, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (échanges, éléments, amitiés et notifications
// suivent en cascade), et ses cartes ajoutées.
const trash: string[] = []
const cards: string[] = []
test.afterEach(() => {
  sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') })
  sql(`delete from public.cards where id = any(string_to_array(:'ids', ',')::uuid[])`, { ids: cards.splice(0).join(',') })
})

type User = { uid: string; username: string }
const player = (opts?: Parameters<typeof makePlayer>[0]): User => {
  const u = makePlayer(opts)
  trash.push(u.uid)
  return u
}
// Moi (session du navigateur) et un ami, chacun avec ses copies : des PC pour moi, des C pour l'ami (P20).
async function friends(login: (o?: { balance?: number }) => Promise<User>, n = 4, other: User = player({ balance: 1000 })) {
  const me = await login({ balance: 1000 })
  trash.push(me.uid)
  befriend(me, other)
  return { me, other, mine: giveCopies(me, 'PC', n), theirs: giveCopies(other, 'C', n) }
}

// Éléments [{user_card_id, card_id, offered_by}] de ces copies, une unité chacune, offertes par leur propriétaire.
const ITEMS = `(select jsonb_agg(jsonb_build_object('user_card_id', id, 'card_id', card_id, 'offered_by', user_id) order by id)
from public.user_cards where id = any(string_to_array(:'copies', ',')::uuid[]))`
// Échange de `from` vers `to` par wm.create_trade (contre-offre si `parent`) ; renvoie son id.
const propose = (from: User, to: User, copies: string[], { iwb = 0, rwb = 0, parent = '' } = {}) =>
  sql(`select wm.create_trade(:'a', :'b', ${ITEMS}, :'iwb'::int, :'rwb'::int, nullif(:'parent', '')::uuid) ->> 'id'`,
    { a: from.uid, b: to.uid, copies: copies.join(','), iwb: String(iwb), rwb: String(rwb), parent })
// accept, decline ou cancel par wm.trade_action, au nom de `by` (« ailleurs », hors de la page).
const act = (by: User, trade: string, action: string) =>
  sql(`select wm.trade_action(:'u', :'t', :'a') ->> 'status'`, { u: by.uid, t: trade, a: action })

// Page lue et hydratée : data-ready est posé par le client après la première lecture.
async function open(page: Page, path = '/trades') {
  await page.goto(path)
  await page.locator('main [data-ready]').waitFor()
}
const tab = (page: Page, name: string) => page.getByRole('tab', { name })
const offers = (page: Page) => page.getByRole('tabpanel').locator('div.card-frame.p-4')
const offerButton = (page: Page) => offers(page).locator(':scope > button')
const toasts = (page: Page) => page.locator('#wm-toasts')
const ACTIONS = /^(Accepter|Refuser|Annuler|Contre-offre)$/
const actions = (page: Page) => page.locator('main').getByRole('button', { name: ACTIONS }).or(page.locator('main').getByRole('link', { name: 'Contre-offre', exact: true }))
// Statut du détail (p[tabIndex=-1]) ; une page quittée reste dans le DOM, masquée (Activity) : seul le visible compte.
const status = (page: Page) => page.locator('main p[tabindex="-1"]').filter({ visible: true })
const onBody = (page: Page) => page.evaluate(() => document.activeElement === document.body)
const short = (iso: string) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(new Date(iso))
const titleOf = (copy: string) => sql(`select c.wikipedia_title from public.user_cards u join public.cards c on c.id = u.card_id where u.id = :'copy'`, { copy })
// Polling de 20 s (M4-15), horloge du navigateur arrêtée juste après la lecture (pauseAt) : 10 s passent sans qu'une lecture de `path`
// parte. Un poll trop tôt partirait pendant runFor : 1 s de temps réel suffit à le voir.
async function quiet(page: Page, path: string) {
  const early = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === path, { timeout: 1_000 }).then(() => true, () => false)
  await page.clock.runFor(10_000)
  expect(await early, `${path} relu avant 20 s`).toBe(false)
}
const ACTIVE = 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]'

test('/trades : trois onglets, « Reçues » actif ; offres reçue, envoyée, refusée et acceptée sous leur onglet, au DOM du contrat', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  propose(other, me, [theirs[0], mine[0]], { iwb: 300 })
  propose(me, other, [mine[1], theirs[1]])
  act(me, propose(other, me, [theirs[2]]), 'decline')
  act(other, propose(me, other, [mine[3], theirs[3]]), 'accept')
  await open(page)
  await expect(page.locator('main h1')).toHaveText('Échanges')
  const tablist = page.locator('[role=tablist][aria-label="Vues des échanges"]')
  await expect(tablist.getByRole('tab')).toHaveText(['Reçues', 'Envoyées', 'Historique'])
  await expect(tab(page, 'Reçues')).toContainClass(ACTIVE)
  await expect(tab(page, 'Reçues')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'Envoyées')).not.toContainClass('border-[var(--color-accent)]')

  await expect(offers(page)).toHaveCount(1)
  const card = offers(page).first()
  await expect(card.locator(':scope > button')).toHaveAttribute('aria-label', 'Voir le détail de l\'échange')
  await expect(card).toContainText(`De ${other.username}`)
  await expect(card.locator('.text-amber-600')).toHaveText('· En attente')
  const time = card.locator('time[datetime]')
  await expect(time).toHaveText(short((await time.getAttribute('datetime'))!))
  await expect(card).toContainText(`${other.username} offre`)
  await expect(card).toContainText('En échange de')
  await expect(card.locator('svg.lucide-arrow-left-right')).toHaveCount(1)
  await expect(card.locator('span[title]')).toHaveCount(2)
  await expect(card.locator(`span[title="${titleOf(theirs[0])}"]`)).toHaveText(new RegExp(`^C · ${titleOf(theirs[0]).slice(0, 20)}…$`))
  await expect(card).toContainText('300 wikibidous')

  await tab(page, 'Envoyées').click()
  await expect(tab(page, 'Envoyées')).toContainClass(ACTIVE)
  // Un seul panneau monté.
  await expect(page.getByRole('tabpanel')).toHaveCount(1)
  await expect(offers(page)).toHaveCount(1)
  await expect(offers(page)).toContainText(`De ${me.username}`)
  await expect(offers(page)).toContainText('· En attente')

  await tab(page, 'Historique').click()
  await expect(offers(page)).toHaveCount(2)
  await expect(offers(page).locator('.text-red-400')).toHaveText('· Refusé')
  await expect(offers(page).locator('.text-green-400')).toHaveText('· Accepté')
})

test('Review Focus, échéance passée sans cron : « · Expiré » sous « Historique », détail sans action ; après wm.expire_trades, toujours « · Expiré »', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  sql(`update public.trades set expires_at = now() - interval '1 minute' where id = :'id'`, { id })
  await open(page)
  await expect(page.getByRole('tabpanel')).toContainText('Aucune offre reçue en attente.')
  await expect(offers(page)).toHaveCount(0)
  await tab(page, 'Historique').click()
  await expect(offers(page)).toHaveCount(1)
  await expect(offers(page).locator('.text-\\[var\\(--color-foreground\\)\\]\\/60')).toHaveText('· Expiré')

  await open(page, `/trades/${id}`)
  await expect(status(page)).toHaveText('Expiré')
  await expect(page.locator('main time')).toHaveText('Terminée')
  await expect(actions(page)).toHaveCount(0)

  expect(sql(`select wm.expire_trades()`)).not.toBe('')
  expect(sql(`select status from public.trades where id = :'id'`, { id })).toBe('expired')
  await open(page)
  await tab(page, 'Historique').click()
  await expect(offers(page).locator('span', { hasText: /^· / })).toHaveText('· Expiré')
})

test('polling 20 s : l\'offre focalisée annulée ailleurs sort de « Reçues », le focus passe à la suivante, puis à l\'état vide', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const older = propose(other, me, [theirs[0], mine[0]])
  const newer = propose(other, me, [theirs[1], mine[1]])
  await page.clock.install()
  await open(page)
  await expect(offers(page)).toHaveCount(2)
  // Plus récente d'abord.
  await offerButton(page).first().focus()
  act(other, newer, 'cancel')
  await page.clock.pauseAt(Date.now() + 1_000)
  await quiet(page, '/api/trades')
  await page.clock.runFor(10_000)
  await expect(offers(page)).toHaveCount(1)
  await expect(offerButton(page)).toBeFocused()
  act(other, older, 'cancel')
  await page.clock.runFor(20_000)
  await expect(offers(page)).toHaveCount(0)
  await expect(page.getByRole('tabpanel').getByText('Aucune offre reçue en attente.', { exact: true })).toBeFocused()
  expect(await onBody(page)).toBe(false)
})

test('détail en destinataire : compte à rebours, « Contre-offre » ; « Accepter » au clavier → toast, statut focalisé, plus d\'action', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]], { rwb: 50 })
  await open(page, `/trades/${id}`)
  await expect(page.locator('main h1')).toHaveText('Détail de l\'échange')
  await expect(page.locator('main')).toContainText(`De ${other.username} à ${me.username}`)
  await expect(status(page)).toHaveText('En attente')
  await expect(page.locator('main')).toContainText('Expire dans')
  await expect(page.locator('main time')).toHaveText(/^1[67]\dh \d\dm \d\ds$/)
  await expect(page.locator('main')).toContainText(`${other.username} offre`)
  await expect(page.locator('main')).toContainText('50 wikibidous')
  await expect(page.getByRole('link', { name: 'Contre-offre', exact: true })).toHaveAttribute('href', `/trades/new?with=${other.uid}&parent=${id}`)
  await expect(page.getByRole('button', { name: ACTIONS })).toHaveText(['Accepter', 'Refuser'])
  await page.getByRole('button', { name: 'Accepter' }).focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Échange accepté.')
  await expect(status(page)).toHaveText('Accepté')
  await expect(actions(page)).toHaveCount(0)
  await expect(status(page)).toBeFocused()
  expect(await onBody(page)).toBe(false)
  expect(sql(`select user_id from public.user_cards where id = :'c'`, { c: theirs[0] })).toBe(me.uid)

  const second = propose(other, me, [theirs[1], mine[1]])
  await open(page, `/trades/${second}`)
  await page.getByRole('button', { name: 'Refuser' }).click()
  await expect(toasts(page)).toContainText('Échange refusé.')
  await expect(status(page)).toHaveText('Refusé')
  await expect(status(page)).toBeFocused()
})

test('polling du détail : annulé ailleurs → « Annulé », sans bouton, focus jamais sur body', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  await page.clock.install()
  await open(page, `/trades/${id}`)
  await expect(page.getByRole('button', { name: 'Accepter' })).toBeVisible()
  act(other, id, 'cancel')
  await page.clock.pauseAt(Date.now() + 1_000)
  await quiet(page, `/api/trades/${id}`)
  await page.clock.runFor(10_000)
  await expect(status(page)).toHaveText('Annulé')
  await expect(actions(page)).toHaveCount(0)
  expect(await onBody(page)).toBe(false)
})

test('détail en initiateur : seul « Annuler » → « Échange annulé. »', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(me, other, [mine[0], theirs[0]])
  await open(page, `/trades/${id}`)
  await expect(page.getByRole('button', { name: ACTIONS })).toHaveText(['Annuler'])
  await expect(page.getByRole('link', { name: 'Contre-offre', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Annuler' }).click()
  await expect(toasts(page)).toContainText('Échange annulé.')
  await expect(status(page)).toHaveText('Annulé')
  await expect(status(page)).toBeFocused()
})

test('accepté ailleurs entre la lecture et le clic : « Accepter » → le refus en alerte, puis le statut relu', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  await page.clock.install()
  await open(page, `/trades/${id}`)
  // Plus aucun minuteur : aucun poll entre la lecture et le clic.
  await page.clock.pauseAt(Date.now() + 1_000)
  act(me, id, 'accept')
  await page.getByRole('button', { name: 'Accepter' }).click()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Cet échange n\'est plus en attente (déjà traité)')
  await expect(status(page)).toHaveText('Accepté')
  await expect(actions(page)).toHaveCount(0)
  await expect(status(page)).toBeFocused()
})

test('clé gardée (M4-8) : 503 après le passage au serveur, la relance de « Accepter » garde sa clé ; « Refuser » ailleurs en a une autre', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  const keys: string[] = []
  page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/trades/')) keys.push(r.headers()['idempotency-key'] ?? '') })
  await open(page, `/trades/${id}`)
  // Après la lecture (même adresse) : le premier PATCH atteint le serveur et s'y fait ; sa réponse est remplacée par un 503.
  await routeOnce(page, `**/api/trades/${id}`, async (r) => {
    await r.fetch()
    await r.fulfill({ status: 503, body: '' })
  })
  const accept = page.getByRole('button', { name: 'Accepter' })
  const lost = page.waitForResponse((r) => r.url().endsWith(`/api/trades/${id}`) && r.status() === 503)
  await accept.click()
  await lost
  await expect(page.locator('main').getByRole('alert')).toHaveText('L\'action n\'a pas abouti.')
  await expect(accept).not.toHaveAttribute('aria-disabled', 'true')
  await accept.click()
  await expect(toasts(page)).toContainText('Échange accepté.')
  await expect(status(page)).toHaveText('Accepté')
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])

  const second = propose(other, me, [theirs[1], mine[1]])
  await open(page, `/trades/${second}`)
  await page.getByRole('button', { name: 'Refuser' }).click()
  await expect(toasts(page)).toContainText('Échange refusé.')
  expect(keys).toHaveLength(3)
  expect(keys[2]).not.toBe(keys[0])
})

test('cloche : le lien d\'une trade_received réelle mène au détail', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  await open(page)
  await page.locator('button[aria-label="Notifications"]').click()
  const link = page.getByRole('dialog', { name: 'Notifications' }).getByRole('link', { name: `${other.username} te propose un échange` })
  await expect(link).toHaveAttribute('href', `/trades/${id}`)
  await link.click()
  await expect(page).toHaveURL(`/trades/${id}`)
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText('Détail de l\'échange')
})

test('contre-offre : le parent « Contre-offre » mène à l\'enfant par « Voir la contre-offre », l\'enfant revient par « Voir l\'offre d\'origine »', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const parent = propose(other, me, [theirs[0], mine[0]])
  const child = propose(me, other, [mine[0], theirs[0]], { parent })
  await open(page, `/trades/${parent}`)
  await expect(status(page)).toHaveText('Contre-offre')
  await expect(actions(page)).toHaveCount(0)
  const toChild = page.getByRole('link', { name: 'Voir la contre-offre' })
  await expect(toChild).toHaveAttribute('href', `/trades/${child}`)
  await expect(page.getByRole('link', { name: 'Voir l\'offre d\'origine' })).toHaveCount(0)
  await hydrated(toChild)
  await toChild.click()
  await expect(page).toHaveURL(`/trades/${child}`)
  await expect(status(page)).toHaveText('En attente')
  await expect(page.getByRole('link', { name: 'Voir l\'offre d\'origine' })).toHaveAttribute('href', `/trades/${parent}`)
  await expect(page.getByRole('button', { name: ACTIONS })).toHaveText(['Annuler'])
})

test('/trades/<uuid inconnu> : « Échange introuvable » et « Retour aux échanges »', async ({ page, login }) => {
  trash.push((await login()).uid)
  await open(page, `/trades/${randomUUID()}`)
  await expect(page.locator('main h1')).toHaveText('Échange introuvable')
  await expect(page.getByRole('link', { name: 'Retour aux échanges' })).toHaveAttribute('href', '/trades')
})

test('clavier : Tab jusqu\'à l\'offre, Entrée → détail ; Tab jusqu\'à « Accepter », Entrée → toast', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  await open(page)
  const offer = offerButton(page)
  for (let i = 0; i < 40 && !(await offer.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(offer).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(`/trades/${id}`)
  await page.locator('main [data-ready]').filter({ visible: true }).waitFor()
  const accept = page.getByRole('button', { name: 'Accepter' })
  for (let i = 0; i < 40 && !(await accept.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(accept).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Échange accepté.')
})

test('lecture en échec : « Impossible de charger cette page. » et « Réessayer », qui rend les onglets', async ({ page, login }) => {
  trash.push((await login()).uid)
  await routeOnce(page, '**/api/trades', (r) => r.fulfill({ status: 500 }))
  await open(page)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('tab')).toHaveText(['Reçues', 'Envoyées', 'Historique'])
  // « Réessayer » disparu sous le focus : l'état vide de l'onglet le prend.
  await expect(page.getByRole('tabpanel').getByText('Aucune offre reçue en attente.', { exact: true })).toBeFocused()
})

test('360 px, initiateur au pseudo de 24 caractères et carte au titre long : aucun défilement horizontal ; cibles ≥ 44 px', async ({ page, login }) => {
  const long = player({ username: `w${randomUUID().replaceAll('-', '').slice(0, 23)}`, balance: 10_000 })
  expect(long.username).toHaveLength(24)
  const { me, other, mine } = await friends(login, 1, long)
  const t = `Zz échange e2e ${randomUUID()}${randomUUID()}`.replaceAll('-', '')
  const card = sql(`insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
values (:'t', 'https://fr.wikipedia.org/wiki/' || :'t', 'SR', 100, 100, 'Essai', 'Résumé') returning id`, { t })
  cards.push(card)
  const copy = sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
values (:'u', :'card', :'t', 'SR', 'Essai', 100, 100) returning id`, { u: other.uid, card, t })
  const id = propose(other, me, [copy, mine[0]], { iwb: 10_000 })
  await page.setViewportSize({ width: 360, height: 800 })
  const fits = async () => {
    expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  const big = async (targets: ReturnType<Page['locator']>, n: number) => {
    await expect(targets).toHaveCount(n)
    for (const target of await targets.all()) {
      const box = (await target.boundingBox())!
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
    }
  }
  await open(page)
  await expect(offers(page)).toContainText(`De ${long.username}`)
  await expect(offers(page).locator(`span[title="${t}"]`)).toHaveText(`SR · ${t.slice(0, 20)}…`)
  await fits()
  await big(page.getByRole('tab').or(offerButton(page)), 4)

  await open(page, `/trades/${id}`)
  await expect(page.locator('main')).toContainText(`De ${long.username} à ${me.username}`)
  await fits()
  await big(actions(page), 3)
})
