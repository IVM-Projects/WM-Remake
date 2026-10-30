import { randomUUID } from 'node:crypto'
import type { Page, Request } from '@playwright/test'
import { befriend, expect, giveCopies, hydrated, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (batailles, decks, amitiés, grand livre et
// notifications suivent en cascade).
const trash: string[] = []
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
  // shortcut: l'arène n'existe qu'à la Task 13 : /battle/<id> rend 404, et Next fait une navigation complète qui emporte le toast ; la
  // première requête vers l'arène est retenue le temps de le lire. À retirer quand la page existe.
  let go!: () => void
  const gate = new Promise<void>((r) => { go = r })
  await routeOnce(page, (u) => BATTLE_URL.test(u.pathname), async (r) => {
    await gate
    await r.fallback()
  })
  await friendRow(page, friend).getByRole('button', { name: 'Défier' }).focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText(`Défi envoyé à ${friend.username}.`)
  go()
  await expect(page).toHaveURL(BATTLE_URL)
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

test('« Comment ça marche ? » : la modale au titre, « 3 défis par jour, 10 avec Pro », aucun point de guilde ; Échap → le focus sur le bouton ; quota_free à 5 dans la config → le texte suit', async ({ page, login }) => {
  await viewer(login)
  await open(page)
  const button = page.getByRole('button', { name: 'Comment ça marche ?' })
  await button.click()
  const dialog = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(dialog.getByRole('heading', { name: 'Comment ça marche ?' })).toBeVisible()
  await expect(dialog).toContainText('Défie un ami : il a 24 h pour accepter.')
  await expect(dialog).toContainText('3 défis par jour, 10 avec Pro, selon ton fuseau horaire.')
  await expect(dialog).toContainText('Gagnant : +50 wikibidous ; perdant : +10 wikibidous.')
  await expect(dialog).not.toContainText(/guilde/i)
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
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
  }
})
