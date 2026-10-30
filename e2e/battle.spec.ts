import { randomUUID } from 'node:crypto'
import type { Browser, BrowserContext, Locator, Page, Request } from '@playwright/test'
import { befriend, cookieFor, expect, giveCopies, hydrated, makeGuild, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (batailles, decks, amitiés, grand livre et
// notifications suivent en cascade).
const trash: string[] = []
// Cible de 44 px à 0,01 près : la mise en page tombe parfois juste sous le pixel (43,99998 px, CI run 41034418031), comme profile.spec.ts.
const MIN_TARGET = 44 - 0.01
test.afterEach(() => void sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') }))

type User = { uid: string; username: string }
const player = (opts?: Parameters<typeof makePlayer>[0]): User => {
  const u = makePlayer(opts)
  trash.push(u.uid)
  return u
}
const viewer = async (login: () => Promise<User>): Promise<User> => {
  const u = await login()
  trash.push(u.uid)
  return u
}

// Une bataille posée par sql passe par les fonctions (Global Constraints, E2E) : défi de a à b ; renvoie son id.
const challenge = (a: User, b: User) => sql(`select wm.battle_create(:'a', :'b') ->> 'id'`, { a: a.uid, b: b.uid })
const act = (u: User, id: string, action: string) => sql(`select from wm.battle_action(:'u', :'id', :'a')`, { u: u.uid, id, a: action })
// Bataille close : b accepte, chacun pose 3 copies C, b abandonne en partie, a gagne (récompenses normales).
function won(a: User, b: User): string {
  const id = challenge(a, b)
  sql(`select from wm.battle_action(:'b', :'id', 'accept');
select from wm.battle_action(:'a', :'id', 'submit_deck', jsonb_build_object('card_ids', string_to_array(:'ca', ',')));
select from wm.battle_action(:'b', :'id', 'submit_deck', jsonb_build_object('card_ids', string_to_array(:'cb', ',')));
select from wm.battle_action(:'b', :'id', 'forfeit');`,
  { a: a.uid, b: b.uid, id, ca: giveCopies(a, 'C', 3).join(','), cb: giveCopies(b, 'C', 3).join(',') })
  expect(sql(`select status || ' ' || winner_id from public.battles where id = :'id'`, { id })).toBe(`completed ${a.uid}`)
  return id
}
const count = (a: User, b: User) => sql(`select count(*) from public.battles where challenger_id = :'a' and opponent_id = :'b'`, { a: a.uid, b: b.uid })
// Défis lancés par a, du plus ancien au plus récent (un seul attendu là où il sert).
const battleOf = (a: User) => sql(`select id from public.battles where challenger_id = :'a' order by created_at`, { a: a.uid })

// data-ready : batailles et amis lus (ou en échec), session connue.
async function open(page: Page) {
  await page.goto('/battle')
  await page.locator('main [data-ready]').waitFor()
}
// Le temps qu'une lecture reçue soit appliquée (une alerte effacée à tort aurait disparu).
const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
const reads = (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/battles'
const posts = (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/battles'
// Cache Components garde les pages quittées dans le DOM (display: none) : seul le visible compte.
const h1 = (page: Page) => page.locator('main h1').filter({ visible: true })
const region = (page: Page, name: string) => page.getByRole('region', { name })
const friendRow = (page: Page, u: User) => region(page, 'Défier un ami').getByRole('listitem').filter({ hasText: u.username })
const tab = (page: Page, name: string) => page.getByRole('tab', { name })
const battles = (page: Page) => page.getByRole('tabpanel').getByRole('link')
const toasts = (page: Page) => page.locator('#wm-toasts')
const BATTLE_URL = /\/battle\/[0-9a-f-]{36}$/
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'
const LIMIT = 'Limite quotidienne de défis atteinte'
const FAILS = [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const

test('sans ami : h1 et titre, « Aucun ami à défier. » et le lien « Amis », « 0 / 3 défis aujourd\'hui » ; GET /api/battles porte le fuseau du navigateur', async ({ page, login }) => {
  await viewer(login)
  const read = page.waitForRequest(reads)
  await open(page)
  expect(await (await read).headerValue('x-wiki-calendar-tz')).toBe(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone))
  await expect(h1(page)).toHaveText('Bataille')
  await expect(page).toHaveTitle(/^Bataille — /)
  const section = region(page, 'Défier un ami')
  await expect(section).toContainText('Aucun ami à défier.')
  await expect(section).toContainText('Ajoute des amis depuis la page Amis.')
  await expect(section.getByRole('link', { name: 'Amis', exact: true })).toHaveAttribute('href', '/friends')
  await expect(page.getByText('0 / 3 défis aujourd\'hui', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Nouveaux défis à/)).toHaveCount(0)
  await expect(page.getByRole('tabpanel')).toHaveText('Aucune bataille en cours.')
})

test('un ami, au clavier : « Défier » → /battle/<id>, le toast, une bataille en base ; relue à l\'affichage (lien « Amis » puis goBack) : « 1 / 3 défis aujourd\'hui », « Voir la bataille », « Contre <ami> » en attente', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page)
  await expect(friendRow(page, friend).getByRole('link', { name: friend.username })).toHaveAttribute('href', `/profile/${encodeURIComponent(friend.username)}`)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(BATTLE_URL)
  // Navigation client vers l'arène : le toast survit (un rechargement complet l'emporterait).
  await expect(page.getByText(`En attente de la réponse de ${friend.username}.`, { exact: true })).toBeVisible()
  await expect(toasts(page)).toContainText(`Défi envoyé à ${friend.username}.`)
  const id = new URL(page.url()).pathname.split('/').pop()!
  expect(count(me, friend)).toBe('1')
  expect(sql(`select id from public.battles where challenger_id = :'a'`, { a: me.uid })).toBe(id)

  // PF1 : l'arène et son « Retour aux batailles » arrivent avec la Task 13 ; la relecture à l'affichage passe par le lien « Amis ».
  await page.goBack()
  await expect(page).toHaveURL('/battle')
  const nav = page.locator('nav a[href="/friends"]').first()
  await hydrated(nav)
  // Marqueur du document : un rechargement complet l'efface, et la page gardée par Activity avec lui.
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/friends')
  const reread = page.waitForRequest(reads)
  await page.goBack()
  await expect(page).toHaveURL('/battle')
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await reread
  await expect(page.getByText('1 / 3 défis aujourd\'hui', { exact: true })).toBeVisible()
  await expect(friendRow(page, friend).getByRole('link', { name: 'Voir la bataille' })).toHaveAttribute('href', `/battle/${id}`)
  await expect(friendRow(page, friend).getByRole('button', { name: 'Défier' })).toHaveCount(0)
  await expect(tab(page, 'En cours')).toHaveAttribute('aria-selected', 'true')
  await expect(battles(page)).toHaveCount(1)
  await expect(battles(page)).toHaveAttribute('href', `/battle/${id}`)
  await expect(battles(page)).toContainText(`Contre ${friend.username}`)
  await expect(battles(page)).toContainText(`En attente de ${friend.username}`)
})

test('quota atteint (3 défis du jour posés par sql) : « Défier » en aria-disabled et décrit, « Nouveaux défis à <heure> » ; un clic n\'envoie aucun POST', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  // Un défi retiré compte (M5a-12) ; la ligne de l'ami garde « Défier ».
  for (let i = 0; i < 3; i++) act(me, challenge(me, friend), 'withdraw_invite')
  await open(page)
  await expect(page.getByText('3 / 3 défis aujourd\'hui', { exact: true })).toBeVisible()
  await expect(page.getByText(/^Nouveaux défis à \d{2}:\d{2}$/)).toBeVisible()
  const button = friendRow(page, friend).getByRole('button', { name: 'Défier' })
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await expect(button).toHaveAccessibleDescription(/Tu as utilisé tes 3 défis du jour\.$/)
  const sent = page.waitForRequest(posts, { timeout: 1_500 }).then(() => true, () => false)
  // Playwright tient aria-disabled pour inactif et attendrait : le clic est forcé, comme celui d'un joueur.
  await button.click({ force: true })
  await page.keyboard.press('Enter')
  expect(await sent, 'POST /api/battles envoyé malgré le quota atteint').toBe(false)
  await expect(page).toHaveURL('/battle')
  expect(count(me, friend)).toBe('3')
})

test('refus 429 forcé : l\'alerte « Limite quotidienne de défis atteinte » dans « Défier un ami », aucune bataille, la page reste', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page)
  await routeOnce(page, '**/api/battles', (r) => r.fulfill({ status: 429, json: { status: 429, error: LIMIT, message: LIMIT } }),
    (r) => r.request().method() === 'POST')
  const reread = page.waitForResponse((r) => reads(r.request()) && r.status() === 200)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  await expect(region(page, 'Défier un ami').getByRole('alert')).toHaveText(LIMIT)
  // Le quota relu n'est pas atteint (en vrai : la borne de 2 × limite sur 24 h) : l'alerte reste jusqu'au défi suivant.
  await reread
  await settle(page)
  await expect(region(page, 'Défier un ami').getByRole('alert')).toHaveText(LIMIT)
  await expect(page).toHaveURL('/battle')
  expect(count(me, friend)).toBe('0')
})

test('refus 429 de la borne glissante (quota du jour sous la limite) : passé retry_after, le poll suivant efface l\'alerte', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await page.clock.install()
  await open(page)
  const until = Date.now() + 2_000
  await routeOnce(page, '**/api/battles', (r) => r.fulfill({ status: 429,
    json: { status: 429, error: LIMIT, message: LIMIT, retry_after: new Date(until).toISOString() } }), (r) => r.request().method() === 'POST')
  const reread = page.waitForResponse((r) => reads(r.request()) && r.status() === 200)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  const alert = region(page, 'Défier un ami').getByRole('alert')
  await expect(alert).toHaveText(LIMIT)
  await reread
  // retry_after passé (l'heure du serveur, estimée par l'en-tête Date à la seconde près, retarde d'une seconde au plus).
  await wait(Math.max(0, until + 1_500 - Date.now()))
  await page.clock.runFor(15_000)
  await expect(alert).toHaveCount(0)
  expect(count(me, friend)).toBe('0')
})

test('session illisible (getSession nul) : les batailles en échec ; session revenue, « Réessayer » des batailles → les onglets, le focus sur l\'onglet sélectionné', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  // Cookies cachés au JS jusqu'à __session : getSession() rend null, les requêtes gardent leur cookie.
  await page.addInitScript(() => {
    const d = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!
    Object.defineProperty(document, 'cookie', { configurable: true, get: () => ('__session' in window ? d.get!.call(document) : ''),
      set: (v: string) => d.set!.call(document, v) })
  })
  await open(page)
  const failed = page.locator('main').getByRole('alert').filter({ hasText: 'Tes batailles n\'ont pas pu être chargées.' })
  await expect(failed).toBeVisible()
  await page.evaluate(() => void Object.assign(window, { __session: true }))
  // Les amis (et la session) relus après les batailles : le focus attend la session.
  const listed = page.waitForResponse((r) => reads(r.request()) && r.status() === 200)
  await routeOnce(page, '**/api/friends', async (r) => {
    await listed
    await wait(300)
    await r.fallback()
  })
  await press(failed.locator('xpath=..').getByRole('button', { name: 'Réessayer' }))
  await expect(tab(page, 'En cours')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'En cours')).toBeFocused()
  await expect(friendRow(page, friend).getByRole('button', { name: 'Défier' })).toBeVisible()
})

test('refus du quota par le serveur (atteint ailleurs après la lecture) : l\'alerte reste tant que le quota relu est atteint ; passé Pro, le poll le relit sous la limite → l\'alerte tombe', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await page.clock.install()
  await open(page)
  // Trois défis posés ailleurs (un autre onglet) après la lecture : la page montre encore 0 / 3 et « Défier » actif.
  for (let i = 0; i < 3; i++) act(me, challenge(me, friend), 'withdraw_invite')
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  const alert = region(page, 'Défier un ami').getByRole('alert')
  await expect(alert).toHaveText(LIMIT)
  await expect(page.getByText('3 / 3 défis aujourd\'hui', { exact: true })).toBeVisible()
  await expect(friendRow(page, friend).getByRole('button', { name: 'Défier' })).toHaveAttribute('aria-disabled', 'true')
  await settle(page)
  await expect(alert).toHaveText(LIMIT)
  sql(`update public.profiles set is_pro = true where id = :'uid'`, { uid: me.uid })
  await page.clock.runFor(15_000)
  await expect(page.getByText('3 / 10 défis aujourd\'hui', { exact: true })).toBeVisible()
  await expect(alert).toHaveCount(0)
})

// Le POST atteint le serveur, sa réponse est perdue (500) ; puis la seule relecture qui suit l'échec est retenue jusqu'à release() (sans
// elle, l'alerte ne vit que l'aller-retour de cette relecture). Jamais la lecture initiale, déjà faite, ni le poll de 15 s, encore loin.
async function lostReply(page: Page): Promise<() => void> {
  let armed = false
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await routeOnce(page, '**/api/battles', async (r) => {
    await r.fetch()
    armed = true
    await r.fulfill({ status: 500 })
  }, (r) => r.request().method() === 'POST')
  await routeOnce(page, '**/api/battles', async (r) => {
    await held
    await r.fallback()
  }, (r) => armed && r.request().method() === 'GET')
  return release
}

test('issue incertaine (bataille créée, réponse 500) : l\'alerte UNSURE dans « Défier un ami », sans toast ; la relecture relâchée → « Voir la bataille » focalisé, l\'alerte tombe, une seule bataille ; retirée ensuite, la ligne revient à « Défier » sans l\'alerte', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await page.clock.install()
  await open(page)
  const release = await lostReply(page)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).focus()
  await page.keyboard.press('Enter')
  const alert = region(page, 'Défier un ami').getByRole('alert')
  await expect(alert).toHaveText(UNSURE)
  await expect(page).toHaveURL('/battle')
  await expect(toasts(page).locator('p')).toHaveCount(0)
  release()
  const see = friendRow(page, friend).getByRole('link', { name: 'Voir la bataille' })
  await expect(see).toBeFocused()
  await expect(alert).toBeHidden()
  expect(count(me, friend)).toBe('1')
  // L'issue incertaine est effacée, pas masquée : la ligne qui change encore (défi retiré, lu au poll) ne la fait pas revenir.
  act(me, battleOf(me), 'withdraw_invite')
  await page.clock.runFor(15_000)
  await expect(friendRow(page, friend).getByRole('button', { name: 'Défier' })).toBeVisible()
  await settle(page)
  await expect(alert).toHaveCount(0)
})

test('issue incertaine, défi jamais arrivé (500 sans le serveur) : la relecture ne montre aucune bataille, l\'alerte reste ; « Défier » de nouveau → la même Idempotency-Key, la bataille créée', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page)
  await routeOnce(page, '**/api/battles', (r) => r.fulfill({ status: 500 }), (r) => r.request().method() === 'POST')
  const first = page.waitForRequest(posts)
  const reread = page.waitForResponse((r) => reads(r.request()) && r.status() === 200)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  const key = await (await first).headerValue('idempotency-key')
  await reread
  await settle(page)
  const alert = region(page, 'Défier un ami').getByRole('alert')
  await expect(alert).toHaveText(UNSURE)
  expect(count(me, friend)).toBe('0')
  const second = page.waitForRequest(posts)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  expect(await (await second).headerValue('idempotency-key')).toBe(key)
  await expect(page).toHaveURL(BATTLE_URL)
  expect(count(me, friend)).toBe('1')
})

test('issue incertaine, bataille créée puis refusée avant toute relecture : la ligne garde « Défier », l\'alerte reste ; « Défier » de nouveau → une clé neuve et une seconde bataille, jamais le 201 rejoué de la première', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page)
  const release = await lostReply(page)
  const first = page.waitForRequest(posts)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  const key = await (await first).headerValue('idempotency-key')
  const alert = region(page, 'Défier un ami').getByRole('alert')
  await expect(alert).toHaveText(UNSURE)
  const old = battleOf(me)
  act(friend, old, 'decline')
  release()
  // Relecture appliquée : le défi refusé compte au quota et passe sous « Terminées ».
  await expect(page.getByText('1 / 3 défis aujourd\'hui', { exact: true })).toBeVisible()
  await expect(alert).toHaveText(UNSURE)
  const second = page.waitForRequest(posts)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  expect(await (await second).headerValue('idempotency-key')).not.toBe(key)
  await expect(page).toHaveURL(BATTLE_URL)
  expect(new URL(page.url()).pathname).not.toBe(`/battle/${old}`)
  expect(count(me, friend)).toBe('2')
})

test('réponse du défi arrivée après un départ vers « Amis » : le joueur reste sur /friends, le toast dit le défi envoyé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page)
  let go!: () => void
  const gate = new Promise<void>((r) => { go = r })
  await routeOnce(page, '**/api/battles', async (r) => {
    await gate
    await r.fallback()
  }, (r) => r.request().method() === 'POST')
  const nav = page.locator('nav a[href="/friends"]').first()
  await hydrated(nav)
  const sent = page.waitForRequest(posts)
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).click()
  await sent
  await nav.click()
  await expect(page).toHaveURL('/friends')
  const answered = page.waitForResponse((r) => posts(r.request()))
  go()
  expect((await answered).status()).toBe(201)
  await expect(toasts(page)).toContainText(`Défi envoyé à ${friend.username}.`)
  expect(await page.waitForURL(BATTLE_URL, { timeout: 1_500 }).then(() => true, () => false), 'la réponse tardive a emmené le joueur vers l\'arène').toBe(false)
  await expect(page).toHaveURL('/friends')
  expect(count(me, friend)).toBe('1')
})

test('onglets : la bataille close (B abandonne, A gagne) sous « Terminées » en « Victoire » ; flèches et Entrée ; la bataille focalisée retirée par sql → au poll de 15 s, celle de même rang, puis l\'état vide, focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const [b, c, d] = [player(), player(), player()]
  for (const f of [b, c, d]) befriend(me, f)
  won(me, b)
  const older = challenge(me, c)
  const newer = challenge(me, d)
  await page.clock.install()
  await open(page)
  const tablist = page.locator('[role=tablist][aria-label="Vues des batailles"]')
  await expect(tablist.getByRole('tab')).toHaveText(['En cours', 'Terminées'])
  await expect(tab(page, 'En cours')).toHaveAttribute('aria-selected', 'true')
  await expect(tab(page, 'En cours')).toContainClass('border-b-2 border-[var(--color-accent)]')
  // Plus récente d'abord.
  await expect(battles(page)).toHaveCount(2)
  await expect(battles(page).first()).toContainText(`Contre ${d.username}`)
  await tab(page, 'En cours').focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab(page, 'Terminées')).toBeFocused()
  await expect(tab(page, 'Terminées')).toHaveAttribute('aria-selected', 'true')
  await expect(battles(page)).toHaveCount(1)
  await expect(battles(page)).toContainText(`Contre ${b.username}`)
  await expect(battles(page).getByText('Victoire', { exact: true })).toContainClass('text-green-400')
  await expect(battles(page).locator('time')).toHaveAttribute('datetime', /^\d{4}-\d\d-\d\dT/)
  await page.keyboard.press('ArrowLeft')
  await expect(tab(page, 'En cours')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(tab(page, 'En cours')).toHaveAttribute('aria-selected', 'true')
  await expect(battles(page)).toHaveCount(2)

  await battles(page).first().focus()
  act(me, newer, 'withdraw_invite')
  await page.clock.runFor(15_000)
  await expect(battles(page)).toHaveCount(1)
  await expect(battles(page)).toContainText(`Contre ${c.username}`)
  await expect(battles(page)).toBeFocused()
  act(me, older, 'withdraw_invite')
  await page.clock.runFor(15_000)
  await expect(page.getByRole('tabpanel').getByText('Aucune bataille en cours.', { exact: true })).toBeFocused()
  await tab(page, 'Terminées').click()
  await expect(battles(page)).toHaveCount(3)
  await expect(battles(page).getByText('Annulée', { exact: true })).toHaveCount(2)
  await expect(battles(page).getByText('Annulée', { exact: true }).first()).toContainClass('text-[var(--color-foreground)]/60')
})

test('« Comment ça marche ? » : la modale au titre, « 3 défis par jour, 10 avec Pro », +500 points de guilde ; Échap → le focus sur le bouton ; quota_free à 5 dans la config → le texte suit', async ({ page, login }) => {
  await viewer(login)
  await open(page)
  const button = page.getByRole('button', { name: 'Comment ça marche ?' })
  await button.click()
  const dialog = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(dialog.getByRole('heading', { name: 'Comment ça marche ?' })).toBeVisible()
  await expect(dialog).toContainText('Défie un ami : il a 24 h pour accepter.')
  await expect(dialog).toContainText('3 défis par jour, 10 avec Pro, selon ton fuseau horaire.')
  await expect(dialog).toContainText('Gagnant : +50 wikibidous ; perdant : +10 wikibidous.')
  await expect(dialog).toContainText('Gagnant : +500 points pour sa guilde, s\'il en a une.')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(button).toBeFocused()

  // M5a-16 : les règles viennent de wm.config. Valeur d'avant relue et refusée si elle est déjà la surcharge (run interrompu).
  const before = sql(`select value::text from wm.config where key = 'battle'`)
  expect(JSON.parse(before).quota_free, 'battle.quota_free est déjà surchargé à 5').not.toBe(5)
  sql(`update wm.config set value = jsonb_set(value, '{quota_free}', '5') where key = 'battle'`)
  try {
    await open(page)
    await expect(page.getByText('0 / 5 défis aujourd\'hui', { exact: true })).toBeVisible()
    await button.click()
    await expect(dialog).toContainText('5 défis par jour, 10 avec Pro, selon ton fuseau horaire.')
  } finally {
    sql(`update wm.config set value = :'before'::jsonb where key = 'battle' and value -> 'quota_free' = '5'::jsonb`, { before })
  }
})

for (const [label, reply] of FAILS) {
  test(`lecture des batailles en échec (${label}) : l'alerte et « Réessayer », les amis lus, data-ready ; « Réessayer » → les onglets, le focus sur l'onglet sélectionné`, async ({ page, login }) => {
    const me = await viewer(login)
    const friend = player()
    befriend(me, friend)
    await routeOnce(page, '**/api/battles', (r) => r.fulfill(reply))
    await open(page)
    await expect(page.locator('main').getByRole('alert')).toHaveText('Tes batailles n\'ont pas pu être chargées.')
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect(friendRow(page, friend).getByRole('button', { name: 'Défier' })).toBeVisible()
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await expect(tab(page, 'En cours')).toHaveAttribute('aria-selected', 'true')
    await expect(tab(page, 'En cours')).toBeFocused()
    await expect(page.getByText('0 / 3 défis aujourd\'hui', { exact: true })).toBeVisible()
  })

  test(`lecture des amis en échec (${label}) : l'alerte et « Réessayer » dans « Défier un ami », les batailles lues, data-ready ; « Réessayer » → les lignes, le titre de la section focalisé`, async ({ page, login }) => {
    const me = await viewer(login)
    const friend = player()
    befriend(me, friend)
    await routeOnce(page, '**/api/friends', (r) => r.fulfill(reply))
    await open(page)
    const section = region(page, 'Défier un ami')
    await expect(section.getByRole('alert')).toHaveText('Tes amis n\'ont pas pu être chargés.')
    await expect(friendRow(page, friend)).toHaveCount(0)
    await expect(tab(page, 'En cours')).toBeVisible()
    await section.getByRole('button', { name: 'Réessayer' }).click()
    await expect(friendRow(page, friend).getByRole('button', { name: 'Défier' })).toBeVisible()
    await expect(section.getByRole('heading', { name: 'Défier un ami' })).toBeFocused()
  })
}

test('360 px, un ami au pseudo de 24 caractères qui me défie, un autre à défier : aucun défilement horizontal ; boutons et liens de 44 px au moins', async ({ page, login }) => {
  const me = await viewer(login)
  const long = player({ username: `w${randomUUID().replaceAll('-', '').slice(0, 23)}` })
  expect(long.username).toHaveLength(24)
  const other = player()
  befriend(me, long)
  befriend(me, other)
  challenge(long, me)
  await page.setViewportSize({ width: 360, height: 800 })
  await open(page)
  await expect(battles(page)).toContainText('Défi reçu : à toi de répondre')
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const root = page.locator('main [data-ready]')
  const targets = root.getByRole('button').or(root.getByRole('link')).or(root.getByRole('tab'))
  // « Comment ça marche ? », les deux pseudos, « Voir la bataille », « Défier », les deux onglets, la bataille.
  await expect(targets).toHaveCount(8)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(MIN_TARGET)
  }
})

// ─── Arène, /battle/[id] (Task 13) ───

const ARENA_UNSURE = `${UNSURE} La bataille se met à jour.`
const fmt = (n: number) => new Intl.NumberFormat('fr-FR').format(n)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Copy = { id: string; card: string; title: string; atk: number; def: number }
// n copies du seed (sans image), de cartes distinctes : la copie, sa carte, son titre et ses stats figés.
const copies = (u: User, n = 3, rarity = 'C'): Copy[] => giveCopies(u, rarity, n).map((id) => JSON.parse(sql(`select json_build_object('id', id, 'card', card_id,
'title', snapshot_title, 'atk', snapshot_atk, 'def', snapshot_def) from public.user_cards where id = :'id'`, { id })) as Copy)
const accepted = (a: User, b: User) => {
  const id = challenge(a, b)
  act(b, id, 'accept')
  return id
}
const submitDeck = (u: User, id: string, cards: Copy[]) => sql(`select from wm.battle_action(:'u', :'id', 'submit_deck',
jsonb_build_object('card_ids', string_to_array(:'c', ',')))`, { u: u.uid, id, c: cards.map((c) => c.id).join(',') })
// a défie b, b accepte, a pose 3 copies C et b 3 copies PC (des cartes différentes, sans KO possible en un tour : DEF de PC ≥ 2 500 et
// ATK de C ≤ 2 500) : la bataille est active, a attaque au tour 1.
function active(a: User, b: User) {
  const id = accepted(a, b)
  const [ca, cb] = [copies(a), copies(b, 3, 'PC')]
  submitDeck(a, id, ca)
  submitDeck(b, id, cb)
  return { id, ca, cb }
}
// u attaque avec sa première carte non engagée ; renvoie les ids des questions tirées, dans l'ordre.
function attack(u: User, id: string): string[] {
  sql(`select from wm.battle_action(:'u', :'id', 'submit_attack', jsonb_build_object('attack_card_id', (select c
from public.battles b, jsonb_array_elements_text(b.game_state #> array['players', :'u', 'cardIds']) with ordinality t (c, o)
where b.id = :'id' and not b.game_state #> array['players', :'u', 'usedCardIds'] ? c order by o limit 1)))`, { u: u.uid, id })
  return sql(`select q ->> 'id' from public.battles b, jsonb_array_elements(b.game_state #> '{pendingAttack,questions}') with ordinality t (q, o)
where b.id = :'id' order by o`, { id }).split('\n')
}
// Option juste (ou une autre) de la question q en attente : son id ou son texte. Le secret est lu par sql (fixture de test, jamais l'app).
const option = (id: string, q: string, right: boolean, col: 'id' | 'text' = 'id') => sql(`select o ->> :'col' from wm.battle_secrets s,
public.battles b, jsonb_array_elements(b.game_state #> '{pendingAttack,questions}') x, jsonb_array_elements(x -> 'options') o
where s.battle_id = :'id' and s.question_id = :'q' and b.id = s.battle_id and x ->> 'id' = :'q'
and (o ->> 'id' = s.correct_option_id) = :'right'::boolean limit 1`, { id, q, right: String(right), col })
const answer = (u: User, id: string, q: string, right = true) => sql(`select from wm.battle_action(:'u', :'id', 'submit_single_answer',
jsonb_build_object('questionId', :'q', 'answerId', :'a'))`, { u: u.uid, id, q, a: option(id, q, right) })
// Un tour entier par sql : att attaque, def répond juste aux 3 questions (aucun dégât, aucun KO).
const turn = (att: User, def: User, id: string) => { for (const q of attack(att, id)) answer(def, id, q) }
const stateOf = (id: string, col: string) => sql(`select ${col} from public.battles where id = :'id'`, { id })

const ready = (page: Page) => page.locator('main [data-ready]').filter({ visible: true }).waitFor()
async function enter(page: Page, id: string) {
  await page.goto(`/battle/${id}`)
  await ready(page)
}
// Horloge arrêtée 2 s après le départ de la première lecture : le poll de 3 s, armé au montage juste avant elle, ne passe jamais.
async function openFrozen(page: Page, id: string) {
  await page.clock.install()
  const first = page.waitForRequest(arenaReads(id)).then(() => Date.now())
  await enter(page, id)
  const t0 = await first
  expect(Date.now(), 'arène lue et rendue en plus de 1,5 s').toBeLessThan(t0 + 1_500)
  await page.clock.pauseAt(t0 + 2_000)
}
const arenaReads = (id: string) => (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/battles/${id}`
const patches = (r: Request) => r.method() === 'PATCH' && new URL(r.url()).pathname.startsWith('/api/battles/')
const arenaHead = (page: Page, me: User, other: User) =>
  page.getByRole('heading', { level: 2, name: `${me.username} contre ${other.username}`, exact: true })
const line = (page: Page, text: string) => page.locator('main').getByText(text, { exact: true }).filter({ visible: true })
const question = (page: Page, k: number) => page.getByRole('heading', { level: 3, name: `Question ${k} / 3`, exact: true })
const radios = (page: Page) => page.locator('main').getByRole('radio')
const verdict = (page: Page) => page.locator('main').getByRole('status').filter({ hasText: /^(Bonne réponse !|Mauvaise réponse\.)/ })
const send = (page: Page) => page.getByRole('button', { name: 'Valider ma réponse' })
const next = (page: Page) => page.getByRole('button', { name: 'Continuer' })
const panel = (page: Page, u: User) => page.getByRole('region', { name: u.username, exact: true })
const cardIn = (page: Page, u: User, c: Copy) => panel(page, u).getByRole('listitem').filter({ hasText: c.title })
const slots = (page: Page) => page.getByRole('region', { name: 'Choisis tes 3 cartes' }).getByRole('listitem')
const validate = (page: Page) => page.getByRole('button', { name: 'Valider mon deck' })
const quit = (page: Page) => page.locator('main').getByRole('button', { name: 'Abandonner' })
const arenaAlert = (page: Page) => page.locator('main').getByRole('alert')
const expected = (right: boolean, text: string) => (right ? 'Bonne réponse !' : `Mauvaise réponse. La bonne réponse était : ${text}`)

async function press(target: Locator) {
  await target.focus()
  await target.press('Enter')
}
// Emplacement n (1 à 3) au clavier : « Ajouter… » ou « Changer », puis Entrée sur la carte du sélecteur ; le focus va à « Changer ».
async function place(page: Page, n: number, title: string) {
  const slot = slots(page).nth(n - 1)
  await press(slot.getByRole('button', { name: `Ajouter une carte à l'emplacement ${n}` }).or(slot.getByRole('button', { name: 'Changer' })))
  const dialog = page.getByRole('dialog', { name: 'Choisir une carte pour ton deck' })
  await press(dialog.getByRole('button', { name: title, exact: true }).first())
  await expect(dialog).toHaveCount(0)
  await expect(slot.getByRole('button', { name: 'Changer' })).toBeFocused()
}
// Deux joueurs connectés à la fois : un contexte par joueur et son cookie ; contextes fermés, puis joueurs supprimés.
async function both(browser: Browser, baseURL: string | undefined, users: User[], run: (pages: Page[]) => Promise<void>) {
  const contexts: BrowserContext[] = []
  try {
    for (const u of users) {
      const ctx = await browser.newContext()
      contexts.push(ctx)
      await ctx.addCookies([{ ...cookieFor(u), url: baseURL! }])
    }
    await run(await Promise.all(contexts.map((c) => c.newPage())))
  } finally {
    // allSettled : une fermeture en échec ne masque pas l'erreur du test et n'empêche pas la suppression des joueurs.
    await Promise.allSettled(contexts.map((c) => c.close()))
    sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: users.map((u) => u.uid).join(',') })
  }
}

test('arène : /battle/abc → « Bataille introuvable » et « Retour aux batailles », sans requête ; une bataille d\'autres joueurs → « Bataille introuvable »', async ({ page, login }) => {
  await viewer(login)
  const [a, b] = [player(), player()]
  befriend(a, b)
  const theirs = challenge(a, b)
  const asked: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/battles/')) asked.push(r.url()) })
  await enter(page, 'abc')
  await expect(page.locator('main h1')).toHaveText('Bataille introuvable')
  await expect(page.locator('main').getByRole('link', { name: 'Retour aux batailles' })).toHaveAttribute('href', '/battle')
  await settle(page)
  expect(asked).toEqual([])
  await enter(page, theirs)
  await expect(page.locator('main h1')).toHaveText('Bataille introuvable')
  expect(asked).toHaveLength(1)
})

test('défi au clavier : reçu, « Accepter » → « Choisis tes 3 cartes », le h2 focalisé ; reçu, « Refuser » → « Bataille annulée », le h2 focalisé ; envoyé, « Retirer le défi » → « Bataille annulée », le h2 focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const [a, b, c] = [player(), player(), player()]
  for (const f of [a, b, c]) befriend(me, f)
  const first = challenge(a, me)
  await enter(page, first)
  await expect(page).toHaveTitle(/^Bataille — /)
  await expect(page.locator('main h1')).toHaveText('Bataille')
  await expect(line(page, `${a.username} te défie.`)).toBeVisible()
  await expect(page.locator('main').getByText('Expire dans', { exact: true })).toBeVisible()
  await expect(page.locator('main time')).toHaveText(/^\d+h \d\dm \d\ds$/)
  await expect(page.getByRole('button', { name: 'Accepter' })).toContainClass('bg-[var(--color-accent)]')
  await expect(page.getByRole('button', { name: 'Refuser' })).toContainClass('border-[var(--color-foreground)]/40')
  await press(page.getByRole('button', { name: 'Accepter' }))
  await expect(page.getByRole('heading', { name: 'Choisis tes 3 cartes' })).toBeVisible()
  await expect(arenaHead(page, me, a)).toBeFocused()
  expect(stateOf(first, 'status')).toBe('deck_selection')

  const second = challenge(b, me)
  await enter(page, second)
  await press(page.getByRole('button', { name: 'Refuser' }))
  await expect(line(page, 'Bataille annulée')).toBeVisible()
  await expect(arenaHead(page, me, b)).toBeFocused()
  expect(stateOf(second, 'status')).toBe('cancelled')

  const third = challenge(me, c)
  await enter(page, third)
  await expect(line(page, `En attente de la réponse de ${c.username}.`)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accepter' })).toHaveCount(0)
  await press(page.getByRole('button', { name: 'Retirer le défi' }))
  await expect(line(page, 'Bataille annulée')).toBeVisible()
  await expect(arenaHead(page, me, c)).toBeFocused()
  expect(stateOf(third, 'status')).toBe('cancelled')
})

test('deck au clavier : sélecteur « Choisir une carte pour ton deck », « Changer » focalisé ; « Valider mon deck » inactif et décrit par sa raison ; doublon → « Choisis 3 cartes différentes. » et « Valider mon deck » inactif ; « Retirer » → « Ajouter… » focalisé ; PV = Σ DEF ; « Valider mon deck » → « Deck validé… » focalisé ; second deck par sql, poll → « Attaquer » de la première carte focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = accepted(me, friend)
  const [x, y, z] = copies(me)
  await page.clock.install()
  await enter(page, id)
  await expect(page.getByRole('heading', { name: 'Choisis tes 3 cartes' })).toBeVisible()
  await expect(line(page, 'Il te faut 3 cartes différentes de ta collection.')).toBeVisible()
  await expect(page.locator('main').getByRole('link', { name: 'Ouvrir des paquets' })).toHaveAttribute('href', '/pulls')
  await expect(line(page, 'PV de ton deck : 0')).toBeVisible()
  await expect(validate(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(validate(page)).toHaveAccessibleDescription('Il te faut 3 cartes différentes de ta collection.')
  await place(page, 1, x.title)
  await place(page, 2, x.title)
  await expect(line(page, 'Choisis 3 cartes différentes.')).toBeVisible()
  await place(page, 3, z.title)
  await expect(validate(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(validate(page)).toHaveAccessibleDescription('Choisis 3 cartes différentes.')
  // Un clic sur le bouton inactif n'envoie rien.
  const sent = page.waitForRequest(patches, { timeout: 1_000 }).then(() => true, () => false)
  await validate(page).click({ force: true })
  expect(await sent, 'PATCH envoyé avec un doublon').toBe(false)
  await place(page, 2, y.title)
  await expect(line(page, 'Choisis 3 cartes différentes.')).toHaveCount(0)
  await expect(line(page, `PV de ton deck : ${fmt(x.def + y.def + z.def)}`)).toBeVisible()
  await press(slots(page).nth(2).getByRole('button', { name: 'Retirer' }))
  await expect(slots(page).nth(2).getByRole('button', { name: 'Ajouter une carte à l\'emplacement 3' })).toBeFocused()
  await expect(line(page, `PV de ton deck : ${fmt(x.def + y.def)}`)).toBeVisible()
  await expect(validate(page)).toHaveAttribute('aria-disabled', 'true')
  await place(page, 3, z.title)
  await expect(validate(page)).not.toHaveAttribute('aria-disabled')
  await expect(validate(page)).not.toHaveAttribute('aria-describedby')
  await press(validate(page))
  await expect(line(page, `Deck validé. En attente du deck de ${friend.username}.`)).toBeFocused()
  expect(sql(`select card_ids from public.battle_decks where battle_id = :'id' and user_id = :'u'`, { id, u: me.uid })).toBe(`{${x.card},${y.card},${z.card}}`)
  await expect(cardIn(page, me, x)).toBeVisible()
  submitDeck(friend, id, copies(friend))
  await page.clock.runFor(3_000)
  await expect(line(page, 'À toi d\'attaquer : choisis une carte.')).toBeVisible()
  await expect(cardIn(page, me, x).getByRole('button', { name: 'Attaquer' })).toBeFocused()
})

test('deck relu : validé, puis page.reload() → « Deck validé. En attente du deck de <adversaire>. », sans « Ajouter une carte à l\'emplacement 1 »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = accepted(friend, me)
  const [x, y, z] = copies(me)
  await enter(page, id)
  for (const [n, c] of [x, y, z].entries()) await place(page, n + 1, c.title)
  await press(validate(page))
  const done = line(page, `Deck validé. En attente du deck de ${friend.username}.`)
  await expect(done).toBeFocused()
  await page.reload()
  await ready(page)
  await expect(done).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ajouter une carte à l\'emplacement 1' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Choisis tes 3 cartes' })).toHaveCount(0)
  // Le deck adverse reste tu (M5a-11) : un seul panneau.
  await expect(panel(page, me)).toBeVisible()
  await expect(panel(page, friend)).toHaveCount(0)
})

test('second deck au clavier, chez le challenger (deck adverse posé par sql) : « Valider mon deck » → « Attaquer » de la première carte focalisé, les deux panneaux', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = accepted(me, friend)
  submitDeck(friend, id, copies(friend))
  const [x, y, z] = copies(me)
  await enter(page, id)
  for (const [n, c] of [x, y, z].entries()) await place(page, n + 1, c.title)
  await press(validate(page))
  await expect(cardIn(page, me, x).getByRole('button', { name: 'Attaquer' })).toBeFocused()
  await expect(line(page, 'À toi d\'attaquer : choisis une carte.')).toBeVisible()
  await expect(panel(page, friend).getByRole('listitem')).toHaveCount(3)
  await expect(panel(page, me).getByText(`PV ${fmt(x.def + y.def + z.def)} / ${fmt(x.def + y.def + z.def)}`, { exact: true })).toBeVisible()
  expect(stateOf(id, 'status')).toBe('active')
})

test('deck impossible (2 cartes distinctes) : la 3ᵉ en double → « Choisis 3 cartes différentes. », « Valider mon deck » inactif, « Ouvrir des paquets » ; « Abandonner » confirmé → « Bataille annulée », le h2 focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = accepted(friend, me)
  const [x, y] = copies(me, 2)
  await enter(page, id)
  await place(page, 1, x.title)
  await place(page, 2, y.title)
  await place(page, 3, x.title)
  await expect(line(page, 'Choisis 3 cartes différentes.')).toBeVisible()
  await expect(validate(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(page.locator('main').getByRole('link', { name: 'Ouvrir des paquets' })).toHaveAttribute('href', '/pulls')
  await expect(page.locator('main').getByText(/^Sans action de ta part avant le \d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d, la bataille sera annulée\.$/)).toBeVisible()
  await press(quit(page))
  const dialog = page.getByRole('dialog', { name: 'Abandonner la bataille ?' })
  await expect(dialog).toContainText('La bataille sera annulée.')
  await press(dialog.getByRole('button', { name: 'Abandonner' }))
  await expect(line(page, 'Bataille annulée')).toBeVisible()
  await expect(arenaHead(page, me, friend)).toBeFocused()
  expect(stateOf(id, 'status')).toBe('cancelled')
})

test('attaque et quiz au clavier, deux joueurs : « Attaquer » → « <B> répond aux questions : 0 / 3 » focalisé ; chez B, « Question 1 / 3 », flèches entre radios, « Valider ma réponse » → le retour d\'après le secret, focalisé ; « Continuer » → « Question 2 / 3 » focalisé ; chez A, le poll lit « 1 / 3 »', async ({ browser, baseURL }) => {
  const [a, b] = [makePlayer(), makePlayer()]
  await both(browser, baseURL, [a, b], async ([pa, pb]) => {
    befriend(a, b)
    const { id, ca } = active(a, b)
    await pa.clock.install()
    await enter(pa, id)
    await expect(line(pa, 'À toi d\'attaquer : choisis une carte.')).toBeVisible()
    await expect(pa.locator('main').getByText(/^Sans action de ta part avant le .+, tu perds la partie\.$/)).toBeVisible()
    const attackButton = cardIn(pa, a, ca[0]).getByRole('button', { name: 'Attaquer' })
    await expect(attackButton).toHaveAccessibleDescription(ca[0].title)
    await expect(panel(pa, a).getByRole('button', { name: 'Attaquer' })).toHaveCount(3)
    await press(attackButton)
    await expect(line(pa, `${b.username} répond aux questions : 0 / 3`)).toBeFocused()
    await expect(cardIn(pa, a, ca[0]).getByText('Déjà utilisée', { exact: true })).toBeVisible()
    await expect(panel(pa, a).getByRole('button', { name: 'Attaquer' })).toHaveCount(0)
    const [q1] = sql(`select q ->> 'id' from public.battles b, jsonb_array_elements(b.game_state #> '{pendingAttack,questions}') q where b.id = :'id'`,
      { id }).split('\n')

    await enter(pb, id)
    await expect(question(pb, 1)).toBeVisible()
    await expect(radios(pb)).toHaveCount(4)
    await expect(send(pb)).toHaveAttribute('aria-disabled', 'true')
    await expect(pb.locator('main').getByRole('link', { name: ca[0].title })).toHaveAttribute('href', /^https:\/\//)
    await expect(pb.locator('main').getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/deed.fr')
    await radios(pb).first().focus()
    await pb.keyboard.press('Space')
    await expect(radios(pb).first()).toBeChecked()
    await pb.keyboard.press('ArrowDown')
    await expect(radios(pb).nth(1)).toBeChecked()
    await expect(radios(pb).nth(1)).toBeFocused()
    const right = (await radios(pb).nth(1).getAttribute('value')) === option(id, q1, true)
    const text = option(id, q1, true, 'text')
    await press(send(pb))
    await expect(verdict(pb)).toHaveText(expected(right, text))
    await expect(verdict(pb)).toBeFocused()
    await press(next(pb))
    await expect(question(pb, 2)).toBeFocused()
    await pa.clock.runFor(3_000)
    await expect(line(pa, `${b.username} répond aux questions : 1 / 3`)).toBeVisible()
  })
})

test('poll sans effacement, en quiz : attaque adverse posée par sql → au poll, « Question 1 / 3 » focalisé ; le retour et « Continuer » restent après 6 s de poll, le h3 inchangé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(friend, me)
  await page.clock.install()
  await enter(page, id)
  await expect(line(page, `${friend.username} choisit sa carte d'attaque.`)).toBeVisible()
  const [q1] = attack(friend, id)
  await page.clock.runFor(3_000)
  await expect(question(page, 1)).toBeFocused()
  await radios(page).first().check()
  const right = (await radios(page).first().getAttribute('value')) === option(id, q1, true)
  const text = option(id, q1, true, 'text')
  await send(page).click()
  await expect(verdict(page)).toHaveText(expected(right, text))
  const polled = page.waitForResponse((r) => arenaReads(id)(r.request()))
  await page.clock.runFor(6_000)
  await polled
  await settle(page)
  await expect(verdict(page)).toHaveText(expected(right, text))
  await expect(next(page)).toBeVisible()
  await expect(question(page, 1)).toBeVisible()
  await expect(question(page, 2)).toHaveCount(0)
})

test('poll sans effacement, choix des cartes : 2 cartes posées, 6 s de poll → elles restent, « Valider mon deck » inactif', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = accepted(friend, me)
  const [x, y] = copies(me)
  await page.clock.install()
  await enter(page, id)
  await place(page, 1, x.title)
  await place(page, 2, y.title)
  const polled = page.waitForResponse((r) => arenaReads(id)(r.request()))
  await page.clock.runFor(6_000)
  await polled
  await settle(page)
  await expect(slots(page).getByRole('button', { name: 'Changer' })).toHaveCount(2)
  await expect(slots(page).nth(0)).toContainText(x.title)
  await expect(slots(page).nth(1)).toContainText(y.title)
  await expect(validate(page)).toHaveAttribute('aria-disabled', 'true')
})

test('dernière question d\'un tour (deux tours sans erreur, puis q1 fausse et q2 juste par sql) : une réponse fausse → le retour avec le texte juste et « Continuer », focalisé ; phase attack en base ; 6 s de poll → le même retour, sans « Attaquer » ; « Continuer » → « À toi d\'attaquer : choisis une carte. » focalisé ; le journal dit chaque tour', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id, ca, cb } = active(friend, me)
  turn(friend, me, id)
  turn(me, friend, id)
  const [q1, q2, q3] = attack(friend, id)
  answer(me, id, q1, false)
  answer(me, id, q2)
  await page.clock.install()
  await enter(page, id)
  await expect(question(page, 3)).toBeVisible()
  const [wrong, text] = [option(id, q3, false), option(id, q3, true, 'text')]
  await page.locator(`main input[type=radio][value="${wrong}"]`).check()
  await press(send(page))
  await expect(verdict(page)).toHaveText(expected(false, text))
  await expect(verdict(page)).toBeFocused()
  await expect(next(page)).toBeVisible()
  expect(stateOf(id, `game_state ->> 'phase'`)).toBe('attack')
  const polled = page.waitForResponse((r) => arenaReads(id)(r.request()))
  await page.clock.runFor(6_000)
  await polled
  await settle(page)
  await expect(verdict(page)).toHaveText(expected(false, text))
  await expect(page.getByRole('button', { name: 'Attaquer' })).toHaveCount(0)
  await press(next(page))
  await expect(line(page, 'À toi d\'attaquer : choisis une carte.')).toBeFocused()
  const damage = Number(stateOf(id, `game_state #>> '{turnHistory,2,damageDealt}'`))
  expect(damage).toBeGreaterThan(0)
  await expect(page.getByRole('log', { name: 'Déroulé de la bataille' }).getByRole('listitem')).toHaveText([
    `Tour 1 : ${friend.username} attaque avec ${ca[0].title}. Aucune erreur : aucun dégât.`,
    `Tour 2 : ${me.username} attaque avec ${cb[0].title}. Aucune erreur : aucun dégât.`,
    `Tour 3 : ${friend.username} attaque avec ${ca[1].title}. 2 mauvaises réponses sur 3 : ${fmt(damage)} dégâts.`,
  ])
})

test('réponse qui clôt la partie (cinq tours et deux réponses du 6ᵉ par sql) : chez le challenger, « Valider ma réponse » → le retour et « Continuer », sans l\'écran de fin ; « Continuer » → « Victoire ! » ou « Défaite » selon winner_id, focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(me, friend)
  for (let n = 1; n <= 5; n++) {
    if (n % 2) turn(me, friend, id)
    else turn(friend, me, id)
  }
  const [q1, q2] = attack(friend, id)
  answer(me, id, q1)
  answer(me, id, q2)
  await enter(page, id)
  await expect(question(page, 3)).toBeVisible()
  await expect(page.getByRole('log', { name: 'Déroulé de la bataille' }).getByRole('listitem')).toHaveCount(5)
  await radios(page).first().check()
  await press(send(page))
  await expect(verdict(page)).toBeFocused()
  await expect(next(page)).toBeVisible()
  expect(stateOf(id, 'status')).toBe('completed')
  await expect(page.getByRole('heading', { name: /^(Victoire !|Défaite)$/ })).toHaveCount(0)
  await press(next(page))
  const won = stateOf(id, 'winner_id') === me.uid
  await expect(page.getByRole('heading', { level: 2, name: won ? 'Victoire !' : 'Défaite', exact: true })).toBeFocused()
  await expect(line(page, won ? '+50 wikibidous' : '+10 wikibidous')).toBeVisible()
})

test('issue incertaine sur une réponse (PATCH coupé) : le texte d\'incertitude ; « Valider ma réponse » de nouveau → la même Idempotency-Key, et le retour', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(friend, me)
  attack(friend, id)
  await enter(page, id)
  await radios(page).first().check()
  await routeOnce(page, '**/api/battles/*', (r) => r.abort(), (r) => r.request().method() === 'PATCH')
  const first = page.waitForRequest(patches)
  await send(page).click()
  const key = await (await first).headerValue('idempotency-key')
  await expect(arenaAlert(page)).toHaveText(ARENA_UNSURE)
  await expect(question(page, 1)).toBeVisible()
  const second = page.waitForRequest(patches)
  await send(page).click()
  expect(await (await second).headerValue('idempotency-key')).toBe(key)
  await expect(verdict(page)).toBeVisible()
  await expect(arenaAlert(page)).toHaveCount(0)
  expect(stateOf(id, `jsonb_array_length(game_state #> '{pendingAttack,answered}')`)).toBe('1')
})

test('fin par les fonctions (PV à 0, lock_users et battle_finish en une transaction) : chez le gagnant, au poll, « Victoire ! » focalisé et « +50 wikibidous » ; chez le perdant, « Défaite » et « +10 wikibidous »', async ({ browser, baseURL }) => {
  const [a, b] = [makePlayer(), makePlayer()]
  await both(browser, baseURL, [a, b], async ([pa, pb]) => {
    befriend(a, b)
    const { id } = active(a, b)
    await pa.clock.install()
    await enter(pa, id)
    await expect(line(pa, 'À toi d\'attaquer : choisis une carte.')).toBeVisible()
    sql(`begin;
update public.battles set game_state = jsonb_set(game_state, array['players', :'b', 'currentHp'], '0') where id = :'id';
select wm.lock_users(array[:'a', :'b']::uuid[]);
select wm.battle_finish(:'id', :'a');
commit;`, { a: a.uid, b: b.uid, id })
    await pa.clock.runFor(3_000)
    await expect(pa.getByRole('heading', { level: 2, name: 'Victoire !', exact: true })).toBeFocused()
    await expect(line(pa, '+50 wikibidous')).toBeVisible()
    await expect(pa.locator('main').getByRole('link', { name: 'Nouveau défi' })).toHaveAttribute('href', '/battle')
    await expect(quit(pa)).toHaveCount(0)
    await enter(pb, id)
    await expect(pb.getByRole('heading', { level: 2, name: 'Défaite', exact: true })).toBeVisible()
    await expect(line(pb, '+10 wikibidous')).toBeVisible()
    await expect(panel(pb, b).getByText(/^PV 0 \//)).toBeVisible()
  })
})

test('fin de partie : +500 chez le gagnant membre d\'une guilde ; rien chez le gagnant sans guilde, ni chez le perdant membre', async ({ browser, baseURL }) => {
  const [a, b, c, d] = [makePlayer(), makePlayer(), makePlayer(), makePlayer()]
  befriend(a, b)
  befriend(c, d)
  // a (guilde) bat b ; c (sans guilde) bat d (guilde).
  const [ga, gd] = [makeGuild(a), makeGuild(d)]
  const [wa, wc] = [won(a, b), won(c, d)]
  const GUILD = 'points pour ta guilde'
  await both(browser, baseURL, [a, b, c, d], async ([pa, pb, pc, pd]) => {
    try {
      await enter(pa, wa)
      await expect(pa.getByRole('heading', { level: 2, name: 'Victoire !', exact: true })).toBeVisible()
      await expect(line(pa, '+500 points pour ta guilde')).toBeVisible()
      await enter(pb, wa)
      await expect(pb.getByRole('heading', { level: 2, name: 'Défaite', exact: true })).toBeVisible()
      await enter(pc, wc)
      await expect(pc.getByRole('heading', { level: 2, name: 'Victoire !', exact: true })).toBeVisible()
      await enter(pd, wc)
      await expect(pd.getByRole('heading', { level: 2, name: 'Défaite', exact: true })).toBeVisible()
      for (const p of [pb, pc, pd]) await expect(p.getByText(GUILD)).toHaveCount(0)
    } finally {
      // Avant les auth.users (Global Constraints, E2E).
      sql(`delete from public.guilds where id = any(string_to_array(:'g', ',')::uuid[])`, { g: `${ga},${gd}` })
    }
  })
})

test('« Abandonner » en partie : la modale « Abandonner la bataille ? » ; Échap → le focus sur « Abandonner » ; confirmé → « Défaite » focalisé, l\'autre joueur gagnant', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(me, friend)
  await enter(page, id)
  await expect(quit(page)).toContainClass('border-[var(--color-foreground)]/40')
  await press(quit(page))
  const dialog = page.getByRole('dialog', { name: 'Abandonner la bataille ?' })
  await expect(dialog).toContainText('Tu perdras la partie.')
  await expect(dialog.getByRole('button', { name: 'Abandonner' })).toContainClass('bg-red-700')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(quit(page)).toBeFocused()
  expect(stateOf(id, 'status')).toBe('active')
  await press(quit(page))
  await press(dialog.getByRole('button', { name: 'Abandonner' }))
  await expect(page.getByRole('heading', { level: 2, name: 'Défaite', exact: true })).toBeFocused()
  expect(stateOf(id, `status || ' ' || winner_id`)).toBe(`completed ${friend.uid}`)
})

test('copie du deck défaussée pendant la partie : la carte reste dans le panneau, aux mêmes ATK et DEF', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id, ca } = active(me, friend)
  await enter(page, id)
  const stats = `ATK${fmt(ca[0].atk)}DEF${fmt(ca[0].def)}`
  await expect(cardIn(page, me, ca[0])).toContainText(stats)
  sql(`select wm.discard(:'uid', :'copy')`, { uid: me.uid, copy: ca[0].id })
  expect(sql(`select count(*) from public.user_cards where id = :'copy'`, { copy: ca[0].id })).toBe('0')
  await page.reload()
  await ready(page)
  await expect(cardIn(page, me, ca[0])).toContainText(stats)
  await expect(cardIn(page, me, ca[0]).getByRole('button', { name: 'Attaquer' })).toBeVisible()
})

test('relecture à chaque affichage : arène ouverte depuis le lobby ; « Retour aux batailles » → un GET /api/battles ; arène cachée, aucun GET /api/battles/<id> en 9 s ; défi accepté par sql ; goBack() → un GET /api/battles/<id> sans avancer l\'horloge, la page gardée, « Choisis tes 3 cartes »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = challenge(me, friend)
  await page.clock.install()
  await open(page)
  const row = battles(page).first()
  await hydrated(row)
  await row.click()
  await expect(page).toHaveURL(`/battle/${id}`)
  await expect(line(page, `En attente de la réponse de ${friend.username}.`)).toBeVisible()
  // Marqueur du document : un rechargement complet l'efface, et la page gardée par Activity avec lui.
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  const back = page.locator('main').getByRole('link', { name: 'Retour aux batailles' }).filter({ visible: true })
  await hydrated(back)
  const lobby = page.waitForRequest(reads)
  await back.click()
  await expect(page).toHaveURL('/battle')
  await lobby
  // Plus aucun minuteur hors de runFor : une lecture de l'arène ne peut venir que de son affichage.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
  const hidden: string[] = []
  page.on('request', (r) => { if (arenaReads(id)(r)) hidden.push(r.url()) })
  await page.clock.runFor(9_000)
  await wait(500)
  expect(hidden, 'arène cachée relue').toEqual([])
  act(friend, id, 'accept')
  const reread = page.waitForRequest(arenaReads(id))
  await page.goBack()
  await expect(page).toHaveURL(`/battle/${id}`)
  await reread
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await expect(page.getByRole('heading', { name: 'Choisis tes 3 cartes' }).filter({ visible: true })).toBeVisible()
})

for (const [label, reply] of FAILS) {
  test(`arène, première lecture en échec (${label}) : LoadError et data-ready ; « Réessayer », avant tout passage du poll → l'arène, le h2 focalisé`, async ({ page, login }) => {
    const me = await viewer(login)
    const friend = player()
    befriend(me, friend)
    const id = challenge(me, friend)
    await routeOnce(page, '**/api/battles/*', (r) => r.fulfill(reply), (r) => r.request().method() === 'GET')
    await openFrozen(page, id)
    await expect(arenaAlert(page)).toHaveText('Impossible de charger cette page.')
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await expect(line(page, `En attente de la réponse de ${friend.username}.`)).toBeVisible()
    await expect(arenaHead(page, me, friend)).toBeFocused()
  })

  test(`arène, poll en échec (${label}) : l'état affiché reste, sans alerte`, async ({ page, login }) => {
    const me = await viewer(login)
    const friend = player()
    befriend(me, friend)
    const id = challenge(me, friend)
    await page.clock.install()
    await enter(page, id)
    let hit!: () => void
    const failed = new Promise<void>((r) => { hit = r })
    await routeOnce(page, '**/api/battles/*', async (r) => {
      await r.fulfill(reply)
      hit()
    }, (r) => r.request().method() === 'GET')
    await page.clock.runFor(3_000)
    await failed
    await settle(page)
    await expect(line(page, `En attente de la réponse de ${friend.username}.`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retirer le défi' })).toBeVisible()
    await expect(arenaAlert(page)).toHaveCount(0)
  })
}

test('360 px, en quiz, énoncé de 200 caractères : aucun défilement horizontal ; radios et boutons de 44 px au moins', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(friend, me)
  attack(friend, id)
  const prompt = `Énoncé ${'x'.repeat(193)}`
  expect(prompt).toHaveLength(200)
  sql(`update public.battles set game_state = jsonb_set(game_state, '{pendingAttack,questions,0,prompt}', to_jsonb(:'p'::text)) where id = :'id'`,
    { p: prompt, id })
  await page.setViewportSize({ width: 360, height: 800 })
  await enter(page, id)
  await expect(page.getByRole('group', { name: prompt })).toBeVisible()
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const root = page.locator('main [data-ready]')
  const labels = root.locator('label:has(input[type=radio])')
  await expect(labels).toHaveCount(4)
  const buttons = root.getByRole('button')
  // « Valider ma réponse », « Abandonner ».
  await expect(buttons).toHaveCount(2)
  for (const target of [...await labels.all(), ...await buttons.all()]) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(MIN_TARGET)
  }
})

// ─── Arène, fix round 1 ───

test('« Abandonner » confirmé pendant le retour d\'une réponse → « Défaite » focalisé, le retour effacé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(friend, me)
  attack(friend, id)
  await enter(page, id)
  await radios(page).first().check()
  await press(send(page))
  await expect(verdict(page)).toBeFocused()
  await press(quit(page))
  const dialog = page.getByRole('dialog', { name: 'Abandonner la bataille ?' })
  await expect(dialog).toContainText('Tu perdras la partie.')
  await press(dialog.getByRole('button', { name: 'Abandonner' }))
  await expect(page.getByRole('heading', { level: 2, name: 'Défaite', exact: true })).toBeFocused()
  await expect(verdict(page)).toHaveCount(0)
  await expect(next(page)).toHaveCount(0)
  expect(stateOf(id, `status || ' ' || winner_id`)).toBe(`completed ${friend.uid}`)
})

test('partie finie par l\'adversaire pendant le retour d\'une réponse, focus sur « Abandonner » : au poll, le retour reste et prend le focus ; « Continuer » → « Victoire ! » focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(friend, me)
  attack(friend, id)
  await page.clock.install()
  await enter(page, id)
  await radios(page).first().check()
  await press(send(page))
  const said = await verdict(page).textContent()
  await quit(page).focus()
  act(friend, id, 'forfeit')
  await page.clock.runFor(3_000)
  await expect(quit(page)).toHaveCount(0)
  await expect(verdict(page)).toHaveText(said!)
  await expect(verdict(page)).toBeFocused()
  await expect(page.getByRole('heading', { name: /^(Victoire !|Défaite)$/ })).toHaveCount(0)
  await press(next(page))
  await expect(page.getByRole('heading', { level: 2, name: 'Victoire !', exact: true })).toBeFocused()
})

test('poll qui relit l\'arène après une première lecture en échec, focus sur « Réessayer » : l\'arène, le h2 focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = challenge(me, friend)
  await routeOnce(page, '**/api/battles/*', (r) => r.fulfill({ status: 500 }), (r) => r.request().method() === 'GET')
  await openFrozen(page, id)
  await page.getByRole('button', { name: 'Réessayer' }).focus()
  await page.clock.runFor(3_000)
  await expect(line(page, `En attente de la réponse de ${friend.username}.`)).toBeVisible()
  await expect(arenaHead(page, me, friend)).toBeFocused()
})

test('confirmation d\'abandon ouverte pendant « Deck validé », second deck posé par sql : au poll, la modale se ferme, le focus sur « Abandonner »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = accepted(friend, me)
  submitDeck(me, id, copies(me))
  await page.clock.install()
  await enter(page, id)
  await press(quit(page))
  const dialog = page.getByRole('dialog', { name: 'Abandonner la bataille ?' })
  await expect(dialog).toContainText('La bataille sera annulée.')
  submitDeck(friend, id, copies(friend, 3, 'PC'))
  await page.clock.runFor(3_000)
  await expect(line(page, `${friend.username} choisit sa carte d'attaque.`)).toBeVisible()
  await expect(dialog).toHaveCount(0)
  await expect(quit(page)).toBeFocused()
  expect(stateOf(id, 'status')).toBe('active')
})

test('« Abandonner » confirmé sur « La bataille sera annulée. », second deck posé par sql avant tout poll : refusé, la partie n\'est pas perdue ; l\'arène relue, l\'alerte « La bataille a changé… », le focus sur « Abandonner »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = accepted(friend, me)
  submitDeck(me, id, copies(me))
  await openFrozen(page, id)
  await press(quit(page))
  const dialog = page.getByRole('dialog', { name: 'Abandonner la bataille ?' })
  await expect(dialog).toContainText('La bataille sera annulée.')
  // Horloge arrêtée : aucun poll ne lit le second deck avant la confirmation.
  submitDeck(friend, id, copies(friend, 3, 'PC'))
  await press(dialog.getByRole('button', { name: 'Abandonner' }))
  await expect(line(page, `${friend.username} choisit sa carte d'attaque.`)).toBeVisible()
  await expect(arenaAlert(page)).toHaveText('La bataille a changé : relis-la avant d\'abandonner.')
  await expect(quit(page)).toBeFocused()
  expect(stateOf(id, 'status')).toBe('active')
  expect(sql(`select count(*) from wm.wb_ledger where ref = 'battle:' || :'id'`, { id })).toBe('0')
})

test('arène relue après « Bataille introuvable » (404 au poll) : « Retour aux batailles », goBack() → la relecture à l\'affichage rend l\'arène, le h2 focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = challenge(me, friend)
  await openFrozen(page, id)
  const gone = 'Bataille introuvable'
  await routeOnce(page, '**/api/battles/*', (r) => r.fulfill({ status: 404, json: { status: 404, error: gone, message: gone } }),
    (r) => r.request().method() === 'GET')
  await page.clock.runFor(3_000)
  await expect(h1(page)).toHaveText(gone)
  const back = page.locator('main').getByRole('link', { name: 'Retour aux batailles' }).filter({ visible: true })
  await hydrated(back)
  await back.click()
  await expect(page).toHaveURL('/battle')
  await ready(page)
  const reread = page.waitForResponse((r) => arenaReads(id)(r.request()) && r.status() === 200)
  await page.goBack()
  await expect(page).toHaveURL(`/battle/${id}`)
  await reread
  await expect(line(page, `En attente de la réponse de ${friend.username}.`)).toBeVisible()
  await expect(arenaHead(page, me, friend)).toBeFocused()
})

test('question déjà répondue ailleurs (juste, par sql) puis une autre option envoyée : le retour enregistré « Bonne réponse ! », sans radio cochée', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id } = active(friend, me)
  const [q1] = attack(friend, id)
  await openFrozen(page, id)
  await expect(question(page, 1)).toBeVisible()
  answer(me, id, q1)
  await page.locator(`main input[type=radio][value="${option(id, q1, false)}"]`).check()
  await send(page).click()
  await expect(verdict(page)).toHaveText('Bonne réponse !')
  await expect(page.locator('main').getByRole('radio', { checked: true })).toHaveCount(0)
})

test('refus d\'une attaque (déjà faite ailleurs, par sql) : l\'alerte sous l\'écran relu ; le tour suivant, au poll, sans l\'alerte', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id, ca } = active(me, friend)
  await openFrozen(page, id)
  const qs = attack(me, id)
  await press(cardIn(page, me, ca[1]).getByRole('button', { name: 'Attaquer' }))
  await expect(arenaAlert(page)).toHaveText('Ce n\'est pas à toi d\'attaquer')
  await expect(line(page, `${friend.username} répond aux questions : 0 / 3`)).toBeVisible()
  for (const q of qs) answer(friend, id, q)
  await page.clock.runFor(3_000)
  await expect(line(page, `${friend.username} choisit sa carte d'attaque.`)).toBeVisible()
  await expect(arenaAlert(page)).toHaveCount(0)
})

test('arène devenue introuvable au poll (404), focus sur « Retirer le défi » : « Bataille introuvable », le focus sur « Retour aux batailles »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = challenge(me, friend)
  await openFrozen(page, id)
  await page.getByRole('button', { name: 'Retirer le défi' }).focus()
  const gone = 'Bataille introuvable'
  await routeOnce(page, '**/api/battles/*', (r) => r.fulfill({ status: 404, json: { status: 404, error: gone, message: gone } }),
    (r) => r.request().method() === 'GET')
  await page.clock.runFor(3_000)
  await expect(page.locator('main h1')).toHaveText(gone)
  await expect(page.locator('main').getByRole('link', { name: 'Retour aux batailles' })).toBeFocused()
})

test('refus d\'une attaque, un passage du poll pendant la relecture du refus : l\'alerte reste sous l\'écran relu', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const { id, ca } = active(me, friend)
  await openFrozen(page, id)
  attack(me, id)
  // La relecture qui suit le refus est retenue le temps de faire passer l'horloge du poll ; seule la première lecture après le PATCH l'est.
  let armed = false
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let reached!: () => void
  const waiting = new Promise<void>((r) => { reached = r })
  await routeOnce(page, '**/api/battles/*', async (r) => {
    armed = true
    await r.fallback()
  }, (r) => r.request().method() === 'PATCH')
  await routeOnce(page, '**/api/battles/*', async (r) => {
    reached()
    await held
    await r.fallback()
  }, (r) => armed && r.request().method() === 'GET')
  try {
    await press(cardIn(page, me, ca[1]).getByRole('button', { name: 'Attaquer' }))
    await waiting
    await page.clock.runFor(3_000)
    await wait(500)
  } finally {
    release()
  }
  await expect(line(page, `${friend.username} répond aux questions : 0 / 3`)).toBeVisible()
  await expect(arenaAlert(page)).toHaveText('Ce n\'est pas à toi d\'attaquer')
  // Un passage du poll, relâché, sur le même écran : l'alerte reste (horloge arrêtée, l'attente se fait côté test).
  const polled = page.waitForResponse((r) => arenaReads(id)(r.request()))
  await page.clock.runFor(3_000)
  await polled
  await wait(300)
  await expect(line(page, `${friend.username} répond aux questions : 0 / 3`)).toBeVisible()
  await expect(arenaAlert(page)).toHaveText('Ce n\'est pas à toi d\'attaquer')
})

test('première lecture en échec, focus sur « Réessayer », puis le poll lit un 404 : « Bataille introuvable », le focus sur « Retour aux batailles »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = challenge(me, friend)
  await routeOnce(page, '**/api/battles/*', (r) => r.fulfill({ status: 500 }), (r) => r.request().method() === 'GET')
  await openFrozen(page, id)
  const gone = 'Bataille introuvable'
  await routeOnce(page, '**/api/battles/*', (r) => r.fulfill({ status: 404, json: { status: 404, error: gone, message: gone } }),
    (r) => r.request().method() === 'GET')
  await page.getByRole('button', { name: 'Réessayer' }).focus()
  await page.clock.runFor(3_000)
  await expect(page.locator('main h1')).toHaveText(gone)
  await expect(page.locator('main').getByRole('link', { name: 'Retour aux batailles' })).toBeFocused()
})
