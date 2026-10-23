import { randomUUID } from 'node:crypto'
import type { Locator, Page, Request, Route } from '@playwright/test'
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
// Polling de 20 s (M4-15). Repère du poll, en horloge réelle (timing()), que l'horloge installée du navigateur suit jusqu'à pauseAt : la
// liste l'arme au montage, juste après le départ de sa première lecture (`start`) ; le détail quand l'échange arrive en attente, juste
// après la fin de cette lecture (`end`).
const reads = (path: string) => (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === path
async function openFrozen(page: Page, path: string, api: string, armed: 'start' | 'end'): Promise<void> {
  await page.clock.install()
  const first = page.waitForRequest(reads(api))
  await open(page, path)
  const { startTime, responseEnd } = (await first).timing()
  const at = armed === 'start' ? startTime : startTime + responseEnd
  // 5 s pour lire et rendre la page, même sur un banc lent ; le poll est armé avant l'arrêt (data-ready suit son rendu).
  expect(Date.now(), 'page lue et rendue en plus de 5 s').toBeLessThan(at + 5_000)
  await page.clock.pauseAt(at + 5_000)
}
// Horloge arrêtée 5 s après le repère (openFrozen) : jusqu'à 19 s, aucune lecture de `api` ne part (un poll trop tôt partirait pendant
// runFor : 1 s de temps réel suffit à le voir) ; avant 21 s, une part (1 s de marge : rendu lent qui arme le poll, départ réseau).
async function polledAt20s(page: Page, api: string) {
  const early = page.waitForRequest(reads(api), { timeout: 1_000 }).then(() => true, () => false)
  await page.clock.runFor(14_000)
  expect(await early, `${api} relu avant 20 s`).toBe(false)
  const read = page.waitForRequest(reads(api))
  await page.clock.runFor(2_000)
  await read
}
const emptyReceived = (page: Page) => page.getByRole('tabpanel').getByText('Aucune offre reçue en attente.', { exact: true })
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu. L\'échange se met à jour.'
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

  // Échu mais encore pending (P3) ; le compte rendu porte aussi les échus des autres workers (base partagée), d'où « au moins 1 ».
  expect(sql(`select status from public.trades where id = :'id'`, { id })).toBe('pending')
  expect(Number(sql(`select wm.expire_trades()`))).toBeGreaterThanOrEqual(1)
  expect(sql(`select status from public.trades where id = :'id'`, { id })).toBe('expired')
  await open(page)
  await tab(page, 'Historique').click()
  await expect(offers(page).locator('span', { hasText: /^· / })).toHaveText('· Expiré')
})

test('polling 20 s : l\'offre focalisée annulée ailleurs sort de « Reçues », le focus passe à la suivante, puis à l\'état vide, puis à l\'offre arrivée', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const older = propose(other, me, [theirs[0], mine[0]])
  const newer = propose(other, me, [theirs[1], mine[1]])
  await openFrozen(page, '/trades', '/api/trades', 'start')
  await expect(offers(page)).toHaveCount(2)
  // Plus récente d'abord.
  await offerButton(page).first().focus()
  act(other, newer, 'cancel')
  await polledAt20s(page, '/api/trades')
  await expect(offers(page)).toHaveCount(1)
  await expect(offerButton(page)).toBeFocused()
  act(other, older, 'cancel')
  await page.clock.runFor(20_000)
  await expect(offers(page)).toHaveCount(0)
  await expect(emptyReceived(page)).toBeFocused()
  expect(await onBody(page)).toBe(false)
  // L'état vide focalisé disparaît sous une offre arrivée : elle prend le focus.
  propose(other, me, [theirs[2], mine[2]])
  await page.clock.runFor(20_000)
  await expect(offers(page)).toHaveCount(1)
  await expect(offerButton(page)).toBeFocused()
})

test('deux polls en échec sous une offre focalisée, puis le focus rendu à body : le poll réussi ne le reprend pas', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  propose(other, me, [theirs[0], mine[0]])
  await page.clock.install()
  await open(page)
  await offerButton(page).focus()
  // Le second échec ne change plus rien à l'état de la page.
  for (let n = 0; n < 2; n++) {
    await routeOnce(page, '**/api/trades', (r) => r.fulfill({ status: 500 }))
    const failed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/trades' && r.status() === 500)
    await page.clock.runFor(20_000)
    await failed
  }
  await expect(offers(page)).toHaveCount(1)
  // Le joueur quitte l'offre, qui reste : rien de focalisé n'a disparu.
  await offerButton(page).evaluate((b) => (b as HTMLElement).blur())
  expect(await onBody(page)).toBe(true)
  const ok = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/trades' && r.status() === 200)
  await page.clock.runFor(20_000)
  await ok
  // Le temps que la page déplace le focus si un ancien armement survivait.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  expect(await onBody(page)).toBe(true)
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
  await openFrozen(page, `/trades/${id}`, `/api/trades/${id}`, 'end')
  await expect(page.getByRole('button', { name: 'Accepter' })).toBeVisible()
  act(other, id, 'cancel')
  await polledAt20s(page, `/api/trades/${id}`)
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

test('clé gardée (M4-8) : 503 après le passage au serveur, l\'incertitude dite ; la relance de « Accepter » garde sa clé ; « Refuser » ailleurs en a une autre, et le poll qui le montre refusé efface l\'incertitude', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  const second = propose(other, me, [theirs[1], mine[1]])
  const keys: string[] = []
  page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/trades/')) keys.push(r.headers()['idempotency-key'] ?? '') })
  // Le PATCH atteint le serveur et s'y fait ; sa réponse est remplacée par un 503. Les GET de la même adresse passent.
  const lose = (trade: string) => routeOnce(page, `**/api/trades/${trade}`, async (r) => {
    await r.fetch()
    await r.fulfill({ status: 503, body: '' })
  }, (r) => r.request().method() === 'PATCH')
  const alert = page.locator('main').getByRole('alert')
  // Temps qui s'écoule normalement (toasts) ; seul runFor fait passer le poll de 20 s.
  await page.clock.install()
  await lose(id)
  await open(page, `/trades/${id}`)
  const accept = page.getByRole('button', { name: 'Accepter' })
  const lost = page.waitForResponse((r) => r.url().endsWith(`/api/trades/${id}`) && r.status() === 503)
  await accept.click()
  await lost
  await expect(alert).toHaveText(UNSURE)
  await expect(accept).not.toHaveAttribute('aria-disabled', 'true')
  await accept.click()
  await expect(toasts(page)).toContainText('Échange accepté.')
  await expect(status(page)).toHaveText('Accepté')
  await expect(alert).toHaveCount(0)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])

  await lose(second)
  await open(page, `/trades/${second}`)
  await page.getByRole('button', { name: 'Refuser' }).click()
  await expect(alert).toHaveText(UNSURE)
  expect(keys).toHaveLength(3)
  expect(keys[2]).not.toBe(keys[0])
  // Le poll montre l'échange refusé : l'incertitude ne vaut plus.
  await page.clock.runFor(20_000)
  await expect(status(page)).toHaveText('Refusé')
  await expect(alert).toHaveCount(0)
})

test('« Accepter » qui répond lentement puis en 503 : le poll a montré « Accepté » entre-temps, aucune incertitude affichée', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let seen = () => {}
  const committed = new Promise<void>((r) => { seen = r })
  await page.clock.install()
  await open(page, `/trades/${id}`)
  // Le PATCH atteint le serveur et s'y fait ; sa réponse (un 503) est retenue jusqu'après le poll.
  await routeOnce(page, `**/api/trades/${id}`, async (r) => {
    await r.fetch()
    seen()
    await held
    await r.fulfill({ status: 503, body: '' })
  }, (r) => r.request().method() === 'PATCH')
  await page.getByRole('button', { name: 'Accepter' }).click()
  await committed
  await page.clock.runFor(20_000)
  await expect(status(page)).toHaveText('Accepté')
  const lost = page.waitForResponse((r) => r.url().endsWith(`/api/trades/${id}`) && r.status() === 503)
  release()
  await lost
  // Le temps que la page affiche l'alerte si elle la rattachait au statut relu.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await expect(status(page)).toHaveText('Accepté')
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
})

test('poll du détail en vol pendant « Accepter », rendu après la réponse : jeté, l\'échange reste accepté', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const id = propose(other, me, [theirs[0], mine[0]])
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let seen = () => {}
  const fetched = new Promise<void>((r) => { seen = r })
  await page.clock.install()
  await open(page, `/trades/${id}`)
  // Le poll lit l'échange encore en attente ; sa réponse est retenue jusqu'après l'acceptation.
  await routeOnce(page, `**/api/trades/${id}`, async (r) => {
    const res = await r.fetch()
    seen()
    await held
    await r.fulfill({ response: res })
  }, (r) => r.request().method() === 'GET')
  await page.clock.runFor(20_000)
  await fetched
  await page.getByRole('button', { name: 'Accepter' }).click()
  await expect(status(page)).toHaveText('Accepté')
  const stale = page.waitForResponse((r) => r.url().endsWith(`/api/trades/${id}`) && r.request().method() === 'GET')
  release()
  await stale
  // Le temps que la page l'applique si elle ne la jetait pas.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await expect(status(page)).toHaveText('Accepté')
  await expect(actions(page)).toHaveCount(0)
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

test('lecture en échec puis « Réessayer » sur un échange introuvable : le focus sur « Retour aux échanges »', async ({ page, login }) => {
  trash.push((await login()).uid)
  const unknown = randomUUID()
  await routeOnce(page, `**/api/trades/${unknown}`, (r) => r.fulfill({ status: 500 }))
  await open(page, `/trades/${unknown}`)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.locator('main h1')).toHaveText('Échange introuvable')
  await expect(page.getByRole('link', { name: 'Retour aux échanges' })).toBeFocused()
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

test('lecture en échec : « Impossible de charger cette page. » et « Réessayer », qui rend les onglets ; un 200 illisible ou sans `trades` de même', async ({ page, login }) => {
  trash.push((await login()).uid)
  await routeOnce(page, '**/api/trades', (r) => r.fulfill({ status: 500 }))
  await open(page)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('tab')).toHaveText(['Reçues', 'Envoyées', 'Historique'])
  // « Réessayer » disparu sous le focus : l'état vide de l'onglet le prend.
  await expect(emptyReceived(page)).toBeFocused()

  // 200 au corps illisible (portail captif, connexion coupée après les en-têtes) : api() rend null, une lecture en échec comme une autre.
  await routeOnce(page, '**/api/trades', (r) => r.fulfill({ status: 200, body: 'x' }))
  await open(page)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('tab')).toHaveText(['Reçues', 'Envoyées', 'Historique'])

  // 200 en JSON sans `trades` : de même, jamais une erreur au rendu.
  await routeOnce(page, '**/api/trades', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await open(page)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('tab')).toHaveText(['Reçues', 'Envoyées', 'Historique'])
})

test('lecture en échec, « Réessayer » focalisé, puis le poll réussit : les onglets, le focus sur l\'état vide', async ({ page, login }) => {
  trash.push((await login()).uid)
  await routeOnce(page, '**/api/trades', (r) => r.fulfill({ status: 500 }))
  await page.clock.install()
  await open(page)
  await page.getByRole('button', { name: 'Réessayer' }).focus()
  await page.clock.runFor(20_000)
  await expect(page.getByRole('tab')).toHaveText(['Reçues', 'Envoyées', 'Historique'])
  await expect(emptyReceived(page)).toBeFocused()
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

// Composer /trades/new (P18) : panneaux « Tu offres » (mes copies, des PC) et « Tu demandes » (celles de l'ami, des C), sélecteurs bornés
// à leur panneau.
const offerPanel = (page: Page) => page.getByRole('region', { name: /^Tu offres/ })
const askPanel = (page: Page) => page.getByRole('region', { name: /^Tu demandes/ })
const qty = (panel: Locator, copy: string) => panel.getByLabel(`Quantité de ${titleOf(copy)}`, { exact: true })
const posts = (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/trades'
const TRADE_URL = /\/trades\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UNSURE_SEND = 'L\'envoi n\'a pas été confirmé : l\'échange a peut-être été proposé. Réessaie, il ne sera pas créé deux fois.'
// La ligne d'une copie dans son panneau (le `has` est relatif à la ligne).
const copyRow = (panel: Locator, copy: string) =>
  panel.getByRole('listitem').filter({ has: panel.page().getByLabel(`Quantité de ${titleOf(copy)}`, { exact: true }) })
const LOCKED = 'Déjà dans un échange'
// Première requête de `url` qui vérifie `when`, retenue jusqu'à release() ; `arrived` se résout à son arrivée.
async function holdOnce(page: Page, url: Parameters<Page['route']>[0], when: (r: Route) => boolean = () => true) {
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let seen = () => {}
  const arrived = new Promise<void>((r) => { seen = r })
  await routeOnce(page, url, async (route) => {
    seen()
    await held
    await route.fallback()
  }, when)
  return { release, arrived }
}
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 80 && !(await target.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(target).toBeFocused()
}

test('composer au clavier : une copie de chaque côté, 10 wikibidous offerts, « Proposer l\'échange » → POST à 2 éléments et l\'en-tête du fuseau, détail, toast', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  await open(page, `/trades/new?with=${other.uid}`)
  await expect(page.locator('main h1')).toHaveText('Nouvel échange')
  await expect(page.locator('main')).toContainText(`Échange avec ${other.username}`)
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (0/100)')
  await expect(askPanel(page).getByRole('heading')).toHaveText('Tu demandes (0/100)')
  await tabTo(page, qty(offerPanel(page), mine[2]))
  await page.keyboard.type('1')
  await tabTo(page, qty(askPanel(page), theirs[1]))
  await page.keyboard.type('1')
  await tabTo(page, page.getByLabel('Wikibidous offerts'))
  await page.keyboard.type('10')
  const posted = page.waitForRequest(posts)
  await tabTo(page, page.getByRole('button', { name: 'Proposer l\'échange' }))
  await page.keyboard.press('Enter')
  const req = await posted
  const body = req.postDataJSON()
  expect(body.items).toEqual([
    { user_card_id: mine[2], card_id: sql(`select card_id from public.user_cards where id = :'c'`, { c: mine[2] }), offered_by: me.uid },
    { user_card_id: theirs[1], card_id: sql(`select card_id from public.user_cards where id = :'c'`, { c: theirs[1] }), offered_by: other.uid },
  ])
  expect([body.recipient_id, body.initiator_wikibidous, body.recipient_wikibidous]).toEqual([other.uid, 10, 0])
  expect(body).not.toHaveProperty('parent_trade_id')
  expect(req.headers()['x-wiki-calendar-tz']).toBeTruthy()
  await expect(page).toHaveURL(TRADE_URL)
  await expect(toasts(page)).toContainText(`Échange proposé à ${other.username}.`)
})

test('compteur : une pile de 3, quantité 3 → « Tu offres (3/100) » ; 5 saisi, ramené à 3 en quittant le champ', async ({ page, login }) => {
  const { other, mine } = await friends(login, 1)
  sql(`update public.user_cards set count = 3 where id = :'c'`, { c: mine[0] })
  await open(page, `/trades/new?with=${other.uid}`)
  const input = qty(offerPanel(page), mine[0])
  await expect(input).toHaveAttribute('max', '3')
  await expect(offerPanel(page)).toContainText('×3')
  await input.fill('3')
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (3/100)')
  await input.fill('5')
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (3/100)')
  await input.blur()
  await expect(input).toHaveValue('3')
})

test('sans carte : « Proposer l\'échange » en aria-disabled, Entrée n\'envoie rien ; une carte choisie, Entrée → un POST', async ({ page, login }) => {
  const { other, mine } = await friends(login, 1)
  await open(page, `/trades/new?with=${other.uid}`)
  await page.getByLabel('Wikibidous offerts').fill('5')
  const send = page.getByRole('button', { name: 'Proposer l\'échange' })
  await expect(send).toHaveAttribute('aria-disabled', 'true')
  await send.focus()
  // Une absence ne se prouve qu'avec une borne (settings.spec.ts) : un envoi partirait aussitôt après Entrée.
  const sent = page.waitForRequest(posts, { timeout: 2000 }).catch(() => null)
  await page.keyboard.press('Enter')
  expect(await sent).toBeNull()
  await qty(offerPanel(page), mine[0]).fill('1')
  await expect(send).not.toHaveAttribute('aria-disabled', 'true')
  const witness = page.waitForRequest(posts)
  await send.focus()
  await page.keyboard.press('Enter')
  await witness
  await expect(page).toHaveURL(TRADE_URL)
})

test('verrou (M4-2) : ma copie déjà dans un échange en attente porte « Déjà dans un échange » et reste choisissable', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login, 2)
  propose(me, other, [mine[0], theirs[0]])
  await open(page, `/trades/new?with=${other.uid}`)
  await expect(copyRow(offerPanel(page), mine[0])).toContainText(LOCKED)
  await expect(copyRow(offerPanel(page), mine[1])).not.toContainText(LOCKED)
  await qty(offerPanel(page), mine[0]).fill('1')
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (1/100)')
  await page.getByRole('button', { name: 'Proposer l\'échange' }).click()
  await expect(page).toHaveURL(TRADE_URL)
})

test('contre-offre : quantités et WB inversés, préremplis ; copie du parent sans « Déjà dans un échange », celle d\'un autre échange marquée ; « Envoyer la contre-offre » → l\'enfant, toast ; le parent « Contre-offre » ; rouvert → « déjà traité »', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login)
  const parent = propose(other, me, [theirs[0], mine[0]], { iwb: 300 })
  propose(me, other, [mine[1], theirs[2]])
  const path = `/trades/new?with=${other.uid}&parent=${parent}`
  await open(page, path)
  await expect(page.locator('main h1')).toHaveText('Contre-offre')
  await expect(page.locator('main')).toContainText(`Échange avec ${other.username}`)
  await expect(qty(offerPanel(page), mine[0])).toHaveValue('1')
  await expect(qty(offerPanel(page), mine[1])).toHaveValue('0')
  await expect(qty(askPanel(page), theirs[0])).toHaveValue('1')
  // La contre-offre clôt son parent : sa copie n'est pas engagée ailleurs ; celle d'un autre échange en attente, si.
  await expect(copyRow(offerPanel(page), mine[0])).not.toContainText(LOCKED)
  await expect(copyRow(offerPanel(page), mine[1])).toContainText(LOCKED)
  await expect(page.getByLabel('Wikibidous offerts')).toHaveValue('')
  await expect(page.getByLabel('Wikibidous demandés')).toHaveValue('300')
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (1/100)')
  await expect(askPanel(page).getByRole('heading')).toHaveText('Tu demandes (1/100)')
  const posted = page.waitForRequest(posts)
  await page.getByRole('button', { name: 'Envoyer la contre-offre' }).click()
  const body = (await posted).postDataJSON()
  expect([body.recipient_id, body.parent_trade_id, body.initiator_wikibidous, body.recipient_wikibidous]).toEqual([other.uid, parent, 0, 300])
  await expect(page).toHaveURL(TRADE_URL)
  const child = new URL(page.url()).pathname.split('/')[2]
  expect(sql(`select parent_trade_id from public.trades where id = :'child'`, { child })).toBe(parent)
  await expect(toasts(page)).toContainText('Contre-offre envoyée.')
  await open(page, `/trades/${parent}`)
  await expect(status(page)).toHaveText('Contre-offre')
  await open(page, path)
  await expect(page.locator('main')).toContainText('Cet échange n\'est plus en attente (déjà traité)')
  await expect(page.getByRole('button', { name: 'Envoyer la contre-offre' })).toHaveCount(0)
})

test('contre-offre hors de la première page : la copie demandée sort en 51e, listée sous « Tu offres » ; le POST porte un card_id uuid par élément', async ({ page, login }) => {
  const me = await login({ balance: 1000 })
  trash.push(me.uid)
  const other = player({ balance: 1000 })
  befriend(me, other)
  giveCopies(me, 'C', 51)
  const theirs = giveCopies(other, 'PC', 1)
  // Ordre de wm.my_collection (tri par défaut) : la 51e est en page 2.
  const far = sql(`select id from public.user_cards where user_id = :'me' order by snapshot_rarity desc, obtained_at desc, id offset 50 limit 1`, { me: me.uid })
  const parent = propose(other, me, [theirs[0], far])
  await open(page, `/trades/new?with=${other.uid}&parent=${parent}`)
  const offer = offerPanel(page)
  await expect(offer.getByRole('spinbutton')).toHaveCount(50)
  await expect(qty(offer, far)).toHaveCount(0)
  await expect(offer.getByRole('list', { name: 'Tes choix' })).toContainText(titleOf(far))
  await expect(offer.getByRole('heading')).toHaveText('Tu offres (1/100)')
  const posted = page.waitForRequest(posts)
  await page.getByRole('button', { name: 'Envoyer la contre-offre' }).click()
  const { items } = (await posted).postDataJSON() as { items: { user_card_id: string; card_id: string }[] }
  expect(items.map((i) => i.user_card_id).sort()).toEqual([far, theirs[0]].sort())
  for (const i of items) expect(i.card_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  await expect(page).toHaveURL(TRADE_URL)
})

test('contre-offre : le parent demandait 2 unités d\'une pile qui n\'en a plus qu\'une → ramené à 1 dès que la copie s\'affiche, et le POST en porte une', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login, 1)
  sql(`update public.user_cards set count = 2 where id = :'c'`, { c: mine[0] })
  const unit = `jsonb_build_object('user_card_id', id, 'card_id', card_id, 'offered_by', user_id)`
  const parent = sql(`select wm.create_trade(:'a', :'b', jsonb_build_array(x, x, y)) ->> 'id'
from (select ${unit} x from public.user_cards where id = :'m') a, (select ${unit} y from public.user_cards where id = :'t') b`,
  { a: other.uid, b: me.uid, m: mine[0], t: theirs[0] })
  sql(`update public.user_cards set count = 1 where id = :'c'`, { c: mine[0] })
  await open(page, `/trades/new?with=${other.uid}&parent=${parent}`)
  await expect(qty(offerPanel(page), mine[0])).toHaveAttribute('max', '1')
  await expect(qty(offerPanel(page), mine[0])).toHaveValue('1')
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (1/100)')
  const posted = page.waitForRequest(posts)
  await page.getByRole('button', { name: 'Envoyer la contre-offre' }).click()
  const { items } = (await posted).postDataJSON() as { items: { user_card_id: string }[] }
  expect(items.filter((i) => i.user_card_id === mine[0])).toHaveLength(1)
  await expect(page).toHaveURL(TRADE_URL)
})

test('pages et filtre : « Charger la suite » → 51 copies, le focus sur la 51e ; un filtre revient en page 0 et garde le choix qu\'il cache ; quantité de l\'ancienne liste cliquée pendant sa lecture → le focus au filtre ; « Retirer »', async ({ page, login }) => {
  const me = await login({ balance: 1000 })
  trash.push(me.uid)
  const other = player()
  befriend(me, other)
  const mine = giveCopies(me, 'C', 51)
  giveCopies(other, 'PC', 1)
  await open(page, `/trades/new?with=${other.uid}`)
  const offer = offerPanel(page)
  await expect(offer.getByRole('spinbutton')).toHaveCount(50)
  await offer.getByRole('spinbutton').first().fill('1')
  const more = offer.getByRole('button', { name: 'Charger la suite' })
  await more.focus()
  await page.keyboard.press('Enter')
  await expect(offer.getByRole('spinbutton')).toHaveCount(51)
  await expect(more).toHaveCount(0)
  await expect(offer.getByRole('spinbutton').nth(50)).toBeFocused()
  // Le filtre garde une autre copie que celle choisie ; un titre du seed se termine par un numéro unique (contract/spec/collection.ts).
  const picked = (await offer.getByRole('spinbutton').first().getAttribute('aria-label'))!.replace('Quantité de ', '')
  const kept = titleOf(mine[0]) === picked ? mine[1] : mine[0]
  const filter = offer.getByRole('searchbox', { name: 'Filtrer mes cartes' })
  const { release, arrived } = await holdOnce(page, (url) => url.pathname === '/api/my-collection' && url.searchParams.has('q'))
  await filter.fill(titleOf(kept).slice(-4))
  await filter.press('Enter')
  await arrived
  // Pendant la lecture, une quantité de l'ancienne liste prend le focus ; elle disparaît avec elle.
  await offer.getByRole('spinbutton').first().click()
  release()
  await expect(offer.getByRole('spinbutton')).toHaveCount(1)
  await expect(filter).toBeFocused()
  await expect(qty(offer, kept)).toBeVisible()
  await expect(offer.getByRole('heading')).toHaveText('Tu offres (1/100)')
  const choices = offer.getByRole('list', { name: 'Tes choix' })
  await expect(choices.getByRole('listitem')).toHaveCount(1)
  await expect(choices).toContainText(`${picked} ×1`)
  await choices.getByRole('button', { name: 'Retirer' }).click()
  await expect(offer.getByRole('heading')).toHaveText('Tu offres (0/100)')
  await expect(choices).toHaveCount(0)
  expect(await onBody(page)).toBe(false)
})

test('réaffichage par Activity : le choix d\'avant reste ; un filtre posé pendant la relecture du retour n\'est pas défait par elle', async ({ page, login }) => {
  const { other, mine } = await friends(login, 3)
  const path = `/trades/new?with=${other.uid}`
  await open(page, path)
  await qty(offerPanel(page), mine[1]).fill('1')
  const nav = page.locator('nav a[href="/pulls"]').first()
  await hydrated(nav)
  // Marqueur du document : un rechargement complet l'efface, et la page gardée par Activity avec lui.
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/pulls')
  // Relecture du retour : la page 0 de mes cartes, sans filtre, retenue jusqu'à release().
  const unfiltered = (url: URL) => url.pathname === '/api/my-collection' && url.search === '?page=0'
  const { release, arrived } = await holdOnce(page, unfiltered)
  await page.goBack()
  await expect(page).toHaveURL(path)
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await arrived
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (1/100)')
  const filter = offerPanel(page).getByRole('searchbox', { name: 'Filtrer mes cartes' })
  await filter.fill(titleOf(mine[0]).slice(-4))
  await filter.press('Enter')
  await expect(offerPanel(page).getByRole('spinbutton')).toHaveCount(1)
  const done = page.waitForResponse((r) => unfiltered(new URL(r.url())))
  release()
  await done
  // Le temps que la page applique la relecture si elle l'écrivait encore.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await expect(offerPanel(page).getByRole('spinbutton')).toHaveCount(1)
  await expect(qty(offerPanel(page), mine[0])).toBeVisible()
  await expect(filter).toHaveValue(titleOf(mine[0]).slice(-4))
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (1/100)')
})

test('lecture en échec : « Impossible de charger cette page. » et « Réessayer », qui rend le composer ; un 200 illisible de même', async ({ page, login }) => {
  const { other } = await friends(login, 1)
  const path = `/trades/new?with=${other.uid}`
  await routeOnce(page, '**/api/friends', (r) => r.fulfill({ status: 500 }))
  await open(page, path)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.locator('main')).toContainText(`Échange avec ${other.username}`)
  await expect(offerPanel(page).getByRole('searchbox', { name: 'Filtrer mes cartes' })).toBeFocused()

  await routeOnce(page, (url) => url.pathname === '/api/my-collection', (r) => r.fulfill({ status: 200, body: 'x' }))
  await open(page, path)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(askPanel(page).getByRole('heading')).toHaveText('Tu demandes (0/100)')
})

test('?with= d\'un non-ami → « Vous devez être amis pour échanger » et « Amis » ; parent dont `with` n\'est pas l\'initiateur, de même ; parent échu → « déjà traité »', async ({ page, login }) => {
  const { me, other, mine, theirs } = await friends(login, 2)
  const stranger = player()
  await open(page, `/trades/new?with=${stranger.uid}`)
  await expect(page.locator('main')).toContainText('Vous devez être amis pour échanger')
  await expect(page.locator('main').getByRole('link', { name: 'Amis', exact: true })).toHaveAttribute('href', '/friends')
  await expect(page.getByRole('button', { name: 'Proposer l\'échange' })).toHaveCount(0)

  // Mon propre échange : son initiateur, c'est moi.
  const mineOut = propose(me, other, [mine[0], theirs[0]])
  await open(page, `/trades/new?with=${other.uid}&parent=${mineOut}`)
  await expect(page.locator('main')).toContainText('Vous devez être amis pour échanger')

  const due = propose(other, me, [theirs[1], mine[1]])
  sql(`update public.trades set expires_at = now() - interval '1 minute' where id = :'due'`, { due })
  await open(page, `/trades/new?with=${other.uid}&parent=${due}`)
  await expect(page.locator('main')).toContainText('Cet échange n\'est plus en attente (déjà traité)')
  await expect(page.getByRole('button', { name: 'Envoyer la contre-offre' })).toHaveCount(0)
})

test('wikibidous : chiffres seuls, 5 au plus ; « 10 000 » collé (espace fine de formatInt) → 10000, « abc » collé sur 300 → 300, « 000 » après « 10 » → 10000 ; 10 001 → l\'alerte « Entre 0 et 10 000 wikibidous par côté »', async ({ page, login }) => {
  const { other, mine } = await friends(login, 1)
  await open(page, `/trades/new?with=${other.uid}`)
  const wb = page.getByLabel('Wikibidous offerts')
  await expect(wb).toHaveAttribute('maxlength', '5')
  await expect(wb).toHaveAttribute('inputmode', 'numeric')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('10\u202f000'))
  await wb.focus()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(wb).toHaveValue('10000')
  // Collage à la sélection : sans chiffre, rien ne change ; après « 10 », « 000 » complète le montant.
  await wb.fill('300')
  await page.evaluate(() => navigator.clipboard.writeText('abc'))
  await wb.press('ControlOrMeta+A')
  await page.keyboard.press('ControlOrMeta+V')
  await expect(wb).toHaveValue('300')
  await wb.fill('10')
  await wb.press('End')
  await page.evaluate(() => navigator.clipboard.writeText('000'))
  await page.keyboard.press('ControlOrMeta+V')
  await expect(wb).toHaveValue('10000')
  await wb.fill('')
  await wb.pressSequentially('1a00012')
  await expect(wb).toHaveValue('10001')
  await qty(offerPanel(page), mine[0]).fill('1')
  await page.getByRole('button', { name: 'Proposer l\'échange' }).click()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Entre 0 et 10 000 wikibidous par côté')
  await expect(page).toHaveURL(/\/trades\/new\?/)
})

test('clé gardée (M4-8) : POST passé au serveur puis 503, l\'incertitude dite, effacée par une modification ; la relance du même corps garde sa clé et rejoue, un seul échange', async ({ page, login }) => {
  const { me, other, mine } = await friends(login, 1)
  const keys: string[] = []
  page.on('request', (r) => { if (posts(r)) keys.push(r.headers()['idempotency-key'] ?? '') })
  // Le POST atteint le serveur et s'y fait (puis rejoue sa réponse) ; sa réponse est remplacée par un 503.
  const lose = () => routeOnce(page, '**/api/trades', async (r) => {
    await r.fetch()
    await r.fulfill({ status: 503, body: '' })
  }, (r) => r.request().method() === 'POST')
  const alert = page.locator('main').getByRole('alert')
  await lose()
  await open(page, `/trades/new?with=${other.uid}`)
  const input = qty(offerPanel(page), mine[0])
  await input.fill('1')
  const send = page.getByRole('button', { name: 'Proposer l\'échange' })
  await send.click()
  await expect(alert).toHaveText(UNSURE_SEND)
  await expect(send).not.toHaveAttribute('aria-disabled', 'true')
  // Une modification fait un autre corps, donc une autre clé : la promesse « pas créé deux fois » ne tient plus, l'alerte part.
  await input.fill('0')
  await expect(alert).toHaveCount(0)
  // Revenu au même corps : la même intention, sa clé gardée ; la réponse rejouée est encore perdue.
  await input.fill('1')
  await lose()
  await send.click()
  await expect(alert).toHaveText(UNSURE_SEND)
  await page.getByLabel('Wikibidous offerts').fill('5')
  await expect(alert).toHaveCount(0)
  await page.getByLabel('Wikibidous offerts').fill('')
  await send.click()
  await expect(page).toHaveURL(TRADE_URL)
  expect(keys).toHaveLength(3)
  expect(new Set(keys).size).toBe(1)
  expect(sql(`select count(*) from public.trades where initiator_id = :'me'`, { me: me.uid })).toBe('1')
})

test('envoi en vol : quantité, « Retirer », wikibidous et filtre figés pendant le POST ; le 503 qui suit vaut pour le corps envoyé, la relance garde sa clé, un seul échange', async ({ page, login }) => {
  const { me, other, mine } = await friends(login, 1)
  const keys: string[] = []
  page.on('request', (r) => { if (posts(r)) keys.push(r.headers()['idempotency-key'] ?? '') })
  // Le POST passe au serveur et s'y fait ; sa réponse est retenue jusqu'à release(), puis remplacée par un 503.
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let seen = () => {}
  const arrived = new Promise<void>((r) => { seen = r })
  await routeOnce(page, '**/api/trades', async (r) => {
    await r.fetch()
    seen()
    await held
    await r.fulfill({ status: 503, body: '' })
  }, (r) => r.request().method() === 'POST')
  await open(page, `/trades/new?with=${other.uid}`)
  const input = qty(offerPanel(page), mine[0])
  const wb = page.getByLabel('Wikibidous offerts')
  await input.fill('1')
  await wb.fill('5')
  await page.getByRole('button', { name: 'Proposer l\'échange' }).click()
  await arrived
  await expect(input).toHaveAttribute('readonly', '')
  await expect(wb).toHaveAttribute('readonly', '')
  // Au clavier : fill attendrait un champ modifiable.
  for (const [field, text] of [[input, '0'], [wb, '7']] as const) {
    await field.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(text)
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('42'))
  await wb.focus()
  await page.keyboard.press('ControlOrMeta+V')
  await offerPanel(page).getByRole('list', { name: 'Tes choix' }).getByRole('button', { name: 'Retirer' }).focus()
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('1')
  await expect(wb).toHaveValue('5')
  await expect(offerPanel(page).getByRole('heading')).toHaveText('Tu offres (1/100)')
  // Filtre envoyé pendant l'envoi : aucune lecture, qui bornerait un choix (une absence se prouve avec une borne).
  const filtered = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/my-collection', { timeout: 1000 }).catch(() => null)
  await offerPanel(page).getByRole('searchbox', { name: 'Filtrer mes cartes' }).fill('zz')
  await page.keyboard.press('Enter')
  expect(await filtered).toBeNull()
  release()
  await expect(page.locator('main').getByRole('alert')).toHaveText(UNSURE_SEND)
  await expect(input).not.toHaveAttribute('readonly')
  await page.getByRole('button', { name: 'Proposer l\'échange' }).click()
  await expect(page).toHaveURL(TRADE_URL)
  expect(keys).toHaveLength(2)
  expect(new Set(keys).size).toBe(1)
  expect(sql(`select count(*) from public.trades where initiator_id = :'me'`, { me: me.uid })).toBe('1')
})

test('composer à 360 px, ami au pseudo de 24 caractères et carte au titre long : aucun défilement horizontal ; champs et boutons ≥ 44 px', async ({ page, login }) => {
  const long = player({ username: `w${randomUUID().replaceAll('-', '').slice(0, 23)}` })
  expect(long.username).toHaveLength(24)
  const { other } = await friends(login, 2, long)
  const t = `Zz échange e2e ${randomUUID()}${randomUUID()}`.replaceAll('-', '')
  const card = sql(`insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
values (:'t', 'https://fr.wikipedia.org/wiki/' || :'t', 'SR', 100, 100, 'Essai', 'Résumé') returning id`, { t })
  cards.push(card)
  sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
values (:'u', :'card', :'t', 'SR', 'Essai', 100, 100)`, { u: other.uid, card, t })
  await page.setViewportSize({ width: 360, height: 800 })
  await open(page, `/trades/new?with=${other.uid}`)
  await expect(page.locator('main')).toContainText(`Échange avec ${long.username}`)
  await askPanel(page).getByLabel(`Quantité de ${t}`, { exact: true }).fill('1')
  await expect(askPanel(page).getByRole('list', { name: 'Tes choix' })).toContainText(t)
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const targets = page.locator('main').locator('input, button')
  expect(await targets.count()).toBeGreaterThan(8)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height), await target.evaluate((e) => e.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44)
  }
})
