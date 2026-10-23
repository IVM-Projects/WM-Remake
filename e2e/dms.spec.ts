import { randomUUID } from 'node:crypto'
import type { Page, Request } from '@playwright/test'
import { formatInt } from '../lib/format.ts'
import { befriend, expect, hydrated, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (amitiés, messages et notifications suivent).
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

// Message de `from` à `to`, posé par SQL ; renvoie son id.
const say = (from: User, to: User, content: string) =>
  sql(`insert into public.chat_messages (sender_id, recipient_id, content) values (:'f', :'t', :'c') returning id`, { f: from.uid, t: to.uid, c: content })
const sent = (from: User, content: string) =>
  sql(`select count(*) from public.chat_messages where sender_id = :'f' and content = :'c'`, { f: from.uid, c: content })
const unfriend = (id: string) => sql(`delete from public.friendships where id = :'id'`, { id })

// data-ready : la liste lue, avec le fil quand `with` est là (ou l'échec).
async function open(page: Page, peer?: User) {
  await page.goto(peer ? `/dms?with=${peer.uid}` : '/dms')
  await page.locator('main [data-ready]').waitFor()
}
const list = (page: Page) => page.getByRole('list', { name: 'Conversations' })
const entry = (page: Page, u: User) => list(page).getByRole('link').filter({ hasText: u.username })
const log = (page: Page, u: User) => page.getByRole('log', { name: `Messages avec ${u.username}` })
const bubble = (page: Page, u: User, text: string) => log(page, u).getByRole('listitem').filter({ hasText: text })
const field = (page: Page) => page.getByRole('textbox', { name: 'Ton message' })
const send = (page: Page) => page.getByRole('button', { name: 'Envoyer' })
const alert = (page: Page) => page.locator('main').getByRole('alert')
const back = (page: Page) => page.getByRole('link', { name: '← Conversations' })
const onBody = (page: Page) => page.evaluate(() => document.activeElement === document.body)
const isThread = (r: Request, u: User, method = 'GET') => r.method() === method && new URL(r.url()).pathname === `/api/chat/${u.uid}`
// Lecture du fil observée (poll compris) : aucune attente aveugle de 5 s.
const threadRead = (page: Page, u: User) => page.waitForResponse((r) => isThread(r.request(), u))
// Idempotency-Key de chaque POST vers le fil.
function postKeys(page: Page, u: User): string[] {
  const keys: string[] = []
  page.on('request', (r) => { if (isThread(r, u, 'POST')) keys.push(r.headers()['idempotency-key'] ?? '') })
  return keys
}
// Réponse perdue : le serveur crée le message, le navigateur reçoit un 503 sans corps (issue incertaine).
const lose = (page: Page) => routeOnce(page, '**/api/chat/*', async (r) => {
  await r.fetch()
  await r.fulfill({ status: 503 })
}, (r) => r.request().method() === 'POST')
const UNSURE = 'Le message n\'a pas été confirmé : il a peut-être été envoyé. La conversation se met à jour.'
const NOT_FRIENDS = 'Vous devez être amis pour vous écrire'
const LOAD_FAILED = 'Impossible de charger cette page.'
const FAILS = [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const

// Réponse retenue jusqu'à release().
function hold() {
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  return { release, held }
}

test('/dms sans conversation : h1 « Messages », « Aucune conversation. » et le lien « Amis » ; à deux colonnes, « Choisis une conversation. »', async ({ page, login }) => {
  await viewer(login)
  await open(page)
  await expect(page.locator('main h1')).toHaveText('Messages')
  await expect(page).toHaveTitle(/^Messages — /)
  await expect(page.locator('main').getByText('Aucune conversation.', { exact: true })).toBeVisible()
  await expect(page.locator('main').getByRole('link', { name: 'Amis', exact: true })).toHaveAttribute('href', '/friends')
  await expect(page.locator('main').getByText('Choisis une conversation.', { exact: true })).toBeVisible()
  await expect(page.locator('main')).not.toContainText('Cette section arrive bientôt.')
  await expect(list(page)).toHaveCount(0)
})

test('fil au clavier : « Aucun message pour l\'instant. », « Salut » puis Entrée → la bulle, le champ vide et focalisé, une Idempotency-Key ; Maj+Entrée et IME ne l\'envoient pas', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const keys = postKeys(page, friend)
  await open(page, friend)
  await expect(log(page, friend)).toHaveText('Aucun message pour l\'instant.')
  await expect(page.locator('main').getByText('Entrée pour envoyer, Maj+Entrée pour aller à la ligne.', { exact: true })).toBeVisible()
  for (let i = 0; i < 40 && !(await field(page).evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(field(page)).toBeFocused()
  await page.keyboard.type('Salut')
  await expect(send(page)).not.toHaveAttribute('aria-disabled')
  await page.keyboard.press('Enter')
  await expect(bubble(page, friend, 'Salut')).toContainText('Toi : Salut')
  await expect(field(page)).toHaveValue('')
  await expect(field(page)).toBeFocused()
  expect(keys).toHaveLength(1)
  expect(keys[0]).toMatch(/\S/)
  expect(sent(me, 'Salut')).toBe('1')
  // Relue après l'envoi : la conversation entre dans la liste.
  await expect(entry(page, friend)).toContainText('Salut')
  await expect(entry(page, friend)).toHaveAttribute('aria-current', 'page')

  await page.keyboard.type('a')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('b')
  await expect(field(page)).toHaveValue('a\nb')
  // Entrée qui valide une composition IME (Chrome : isComposing ; Safari : keyCode 229 après compositionend) et touche maintenue
  // (repeat) : rien n'est envoyé.
  await field(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
  await field(page).evaluate((el) => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(e, 'keyCode', { value: 229 })
    el.dispatchEvent(e)
  })
  await field(page).dispatchEvent('keydown', { key: 'Enter', repeat: true, bubbles: true })
  await expect(field(page)).toHaveValue('a\nb')
  // Un envoi réel ensuite : un POST parti avant lui serait compté.
  await field(page).fill('fin')
  await page.keyboard.press('Enter')
  await expect(bubble(page, friend, 'fin')).toHaveCount(1)
  await expect(field(page)).toHaveValue('')
  expect(keys).toHaveLength(2)
  expect(sent(me, 'a\nb')).toBe('0')
})

test('poll de 5 s : un message de l\'ami arrive → sa bulle ; PATCH direct de chat_messages, le message lu en base', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await page.clock.install()
  await open(page, friend)
  await expect(log(page, friend)).toHaveText('Aucun message pour l\'instant.')
  const id = say(friend, me, 'Coucou')
  const patched = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/rest/v1/chat_messages')
  const polled = threadRead(page, friend)
  await page.clock.runFor(5_000)
  await polled
  await expect(bubble(page, friend, 'Coucou')).toContainText(`${friend.username} : Coucou`)
  const q = new URL((await patched).url()).searchParams
  expect([q.get('sender_id'), q.get('recipient_id'), q.get('read')]).toEqual([`eq.${friend.uid}`, `eq.${me.uid}`, 'eq.false'])
  await expect.poll(() => sql(`select read from public.chat_messages where id = :'id'`, { id })).toBe('t')
})

test('onglet caché : la lecture ne marque rien lu ; au retour en visible, le poll relit tout de suite et marque', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const id = say(friend, me, 'Coucou')
  // Onglet caché simulé dès le chargement ; visibilitychange le rend visible.
  await page.addInitScript(() => Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => ('__visible' in window ? 'visible' : 'hidden'),
  }))
  const patches: string[] = []
  page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/rest/v1/chat_messages') patches.push(r.url()) })
  await open(page, friend)
  await expect(bubble(page, friend, 'Coucou')).toBeVisible()
  expect(sql(`select read from public.chat_messages where id = :'id'`, { id })).toBe('f')
  const patched = page.waitForRequest((r) => r.method() === 'PATCH' && new URL(r.url()).pathname === '/rest/v1/chat_messages')
  const polled = threadRead(page, friend)
  await page.evaluate(() => {
    Object.assign(window, { __visible: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await polled
  await patched
  await expect.poll(() => sql(`select read from public.chat_messages where id = :'id'`, { id })).toBe('t')
  // Un seul marquage : celui de la lecture faite au retour en visible.
  expect(patches).toHaveLength(1)
})

test('liste : deux conversations, l\'une à 2 non lus → la pastille « 2 » et « 2 messages non lus » ; ce fil ouvert puis quitté → plus de pastille', async ({ page, login }) => {
  const me = await viewer(login)
  const [a, b] = [player(), player()]
  befriend(me, a)
  befriend(me, b)
  say(me, b, 'Pour B')
  say(a, me, 'Premier')
  say(a, me, 'Second')
  await open(page)
  await expect(list(page).getByRole('listitem')).toHaveCount(2)
  await expect(entry(page, a)).toHaveAttribute('href', `/dms?with=${a.uid}`)
  await expect(entry(page, a)).toContainText('Second')
  await expect(entry(page, a).getByText('2', { exact: true })).toBeVisible()
  await expect(entry(page, a).getByText('2 messages non lus', { exact: true })).toHaveCount(1)
  await expect(entry(page, b)).toContainText('Pour B')
  await expect(entry(page, b)).not.toContainText('non lu')
  await hydrated(entry(page, a))
  await entry(page, a).click()
  await expect(page).toHaveURL(`/dms?with=${a.uid}`)
  await expect(entry(page, a)).toHaveAttribute('aria-current', 'page')
  await expect(bubble(page, a, 'Second')).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL('/dms')
  await expect(entry(page, a)).not.toHaveAttribute('aria-current')
  await expect(entry(page, a)).not.toContainText('non lu')
  await expect(entry(page, a).getByText('2', { exact: true })).toHaveCount(0)
})

test('pair inconnu (404) ou adresse qui n\'est pas un UUID (abc, .) : « Joueur introuvable », focalisé, et « Retour aux messages »', async ({ page, login }) => {
  await viewer(login)
  // `.` : /api/chat/. se réduirait à /api/chat/, qui mène à la liste (lecture en échec sans fin) ; refusé avant toute requête.
  for (const peer of [randomUUID(), 'abc', '.']) {
    await page.goto(`/dms?with=${peer}`)
    await page.locator('main [data-ready]').waitFor()
    await expect(page.getByRole('heading', { level: 2, name: 'Joueur introuvable' })).toBeFocused()
    await expect(page.getByRole('link', { name: 'Retour aux messages' })).toHaveAttribute('href', '/dms')
    await expect(field(page)).toHaveCount(0)
  }
})

test('ancien ami : le fil reste lisible, la saisie remplacée par « Vous devez être amis pour vous écrire » et un lien vers son profil', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  const id = befriend(me, friend)
  say(friend, me, 'Avant')
  unfriend(id)
  await open(page, friend)
  await expect(bubble(page, friend, 'Avant')).toBeVisible()
  await expect(page.getByText(NOT_FRIENDS, { exact: true })).toBeVisible()
  await expect(field(page)).toHaveCount(0)
  await expect(send(page)).toHaveCount(0)
  await expect(page.getByRole('link', { name: `Profil de ${friend.username}` })).toHaveAttribute('href', `/profile/${encodeURIComponent(friend.username)}`)
})

test('amitié retirée pendant la saisie : le poll remplace le champ focalisé, le focus passe à « Vous devez être amis pour vous écrire »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  const id = befriend(me, friend)
  await page.clock.install()
  await open(page, friend)
  await field(page).focus()
  unfriend(id)
  const polled = threadRead(page, friend)
  await page.clock.runFor(5_000)
  await polled
  await expect(page.getByText(NOT_FRIENDS, { exact: true })).toBeFocused()
  await expect(field(page)).toHaveCount(0)
})

test('refus 429 : l\'alerte « Le site demande de ralentir », le texte reste dans le champ', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page, friend)
  // Filtré sur POST : la lecture du fil, à la même adresse, prendrait sinon la réponse forcée.
  await routeOnce(page, '**/api/chat/*', (r) => r.fulfill({
    status: 429,
    headers: { 'Retry-After': '30' },
    json: { error: 'Le site demande de ralentir', message: 'Le site demande de ralentir', retry_after: 30 },
  }), (r) => r.request().method() === 'POST')
  await field(page).fill('Salut')
  await field(page).press('Enter')
  await expect(alert(page)).toHaveText('Le site demande de ralentir')
  await expect(field(page)).toHaveValue('Salut')
  await expect(field(page)).toBeFocused()
  expect(sent(me, 'Salut')).toBe('0')
})

test('issue incertaine (B15) : le poll montre la bulle et efface l\'alerte, Entrée rejoue la même clé ; texte modifié puis retapé → une clé neuve', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const keys = postKeys(page, friend)
  await page.clock.install()
  await open(page, friend)

  await lose(page)
  await field(page).fill('Salut')
  await field(page).press('Enter')
  await expect(alert(page)).toHaveText(UNSURE)
  await expect(field(page)).toHaveValue('Salut')
  expect(sent(me, 'Salut')).toBe('1')
  let polled = threadRead(page, friend)
  await page.clock.runFor(5_000)
  await polled
  await expect(bubble(page, friend, 'Salut')).toHaveCount(1)
  await expect(alert(page)).toHaveCount(0)
  // Le poll n'oublie pas la clé : Entrée sur le texte resté rejoue l'envoi au lieu d'en créer un second.
  await expect(field(page)).toHaveValue('Salut')
  await field(page).press('Enter')
  await expect(field(page)).toHaveValue('')
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
  await expect(bubble(page, friend, 'Salut')).toHaveCount(1)
  expect(sent(me, 'Salut')).toBe('1')

  // Clé périmée : « Bonjour » perdu, le champ modifié (« Ça va ? », envoyé), puis « Bonjour » retapé → un second « Bonjour ».
  await lose(page)
  await field(page).fill('Bonjour')
  await field(page).press('Enter')
  await expect(alert(page)).toHaveText(UNSURE)
  polled = threadRead(page, friend)
  await page.clock.runFor(5_000)
  await polled
  await expect(bubble(page, friend, 'Bonjour')).toHaveCount(1)
  await field(page).fill('Ça va ?')
  await field(page).press('Enter')
  await expect(bubble(page, friend, 'Ça va ?')).toHaveCount(1)
  await expect(field(page)).toHaveValue('')
  await field(page).fill('Bonjour')
  await field(page).press('Enter')
  await expect(field(page)).toHaveValue('')
  await expect(bubble(page, friend, 'Bonjour')).toHaveCount(2)
  expect(keys).toHaveLength(5)
  expect(new Set(keys.slice(2)).size).toBe(3)
  expect(sent(me, 'Bonjour')).toBe('2')

  // Même intention, mais le champ touché entre-temps (onChange) : la clé gardée est oubliée, l'envoi est neuf.
  await lose(page)
  await field(page).fill('Encore')
  await field(page).press('Enter')
  await expect(alert(page)).toHaveText(UNSURE)
  await field(page).press('End')
  await page.keyboard.type('!')
  await page.keyboard.press('Backspace')
  await expect(field(page)).toHaveValue('Encore')
  await field(page).press('Enter')
  await expect(field(page)).toHaveValue('')
  expect(keys).toHaveLength(7)
  expect(keys[6]).not.toBe(keys[5])
  expect(sent(me, 'Encore')).toBe('2')
})

test('2xx lisible sans « message » : envoyé (champ vidé, sans alerte, la bulle au poll) ; 2xx illisible : incertain, Entrée rejoue la même clé', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const keys = postKeys(page, friend)
  await page.clock.install()
  await open(page, friend)
  const answer = (reply: { status: number; json?: object; body?: string }) => routeOnce(page, '**/api/chat/*', async (r) => {
    await r.fetch()
    await r.fulfill(reply)
  }, (r) => r.request().method() === 'POST')

  // apiOnce a oublié la clé d'un 2xx lisible : le renvoyer doublerait le message.
  await answer({ status: 201, json: {} })
  await field(page).fill('Salut')
  await field(page).press('Enter')
  await expect(field(page)).toHaveValue('')
  await expect(alert(page)).toHaveCount(0)
  const polled = threadRead(page, friend)
  await page.clock.runFor(5_000)
  await polled
  await expect(bubble(page, friend, 'Salut')).toHaveCount(1)
  expect(sent(me, 'Salut')).toBe('1')

  // Corps illisible : la clé est gardée, la relance rejoue.
  await answer({ status: 201, body: 'x' })
  await field(page).fill('Bonjour')
  await field(page).press('Enter')
  await expect(alert(page)).toHaveText(UNSURE)
  await expect(field(page)).toHaveValue('Bonjour')
  await field(page).press('Enter')
  await expect(field(page)).toHaveValue('')
  await expect(bubble(page, friend, 'Bonjour')).toHaveCount(1)
  expect(keys).toHaveLength(3)
  expect(keys[2]).toBe(keys[1])
  expect(sent(me, 'Bonjour')).toBe('1')
})

test('Activity : une lecture encore en vol quand le fil est caché ne marque rien lu ; réaffiché, il est relu puis marqué', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  // Lectures du fil et marquages, dans l'ordre.
  const events: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/rest/v1/chat_messages') events.push('PATCH')
    else if (isThread(r, friend)) events.push('GET')
  })
  await page.clock.install()
  await open(page, friend)
  await expect(log(page, friend)).toHaveText('Aucun message pour l\'instant.')
  const id = say(friend, me, 'Coucou')
  // Le passage suivant du poll retenu jusqu'à ce que la page soit cachée.
  const { release, held } = hold()
  await routeOnce(page, '**/api/chat/*', async (r) => {
    await held
    await r.fallback()
  }, (r) => r.request().method() === 'GET')
  const polled = page.waitForRequest((r) => isThread(r, friend))
  await page.clock.runFor(5_000)
  await polled
  const nav = page.locator('nav a[href="/friends"]').first()
  await hydrated(nav)
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/friends')
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText('Amis')
  const mark = events.length
  const answered = threadRead(page, friend)
  release()
  await answered
  await page.goBack()
  await expect(page).toHaveURL(`/dms?with=${friend.uid}`)
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await expect(bubble(page, friend, 'Coucou')).toBeVisible()
  await expect.poll(() => sql(`select read from public.chat_messages where id = :'id'`, { id })).toBe('t')
  // La lecture cachée n'a rien marqué : le marquage suit la relecture du réaffichage.
  expect(events.slice(mark, mark + 2)).toEqual(['GET', 'PATCH'])
})

test('Review Focus, contenu : 2 000 « 😀 » collés → 1 000 gardés (unités UTF-16), « 2 000 / 2 000 », envoi accepté ; des espaces seuls → « Envoyer » inactif', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const keys = postKeys(page, friend)
  await open(page, friend)
  await expect(page.getByText(`${formatInt(0)} / ${formatInt(2000)}`, { exact: true })).toBeVisible()
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true')
  await field(page).focus()
  // Collé : le texte inséré d'un bloc passe par maxLength, comme un collage.
  await page.keyboard.insertText('😀'.repeat(2000))
  await expect(field(page)).toHaveValue('😀'.repeat(1000))
  await expect(page.getByText(`${formatInt(2000)} / ${formatInt(2000)}`, { exact: true })).toBeVisible()
  await field(page).press('Enter')
  await expect(field(page)).toHaveValue('')
  expect(sql(`select char_length(content) from public.chat_messages where sender_id = :'f'`, { f: me.uid })).toBe('1000')

  await field(page).fill('   ')
  await expect(send(page)).toHaveAttribute('aria-disabled', 'true')
  // aria-disabled : Playwright refuse le clic sans force ; la garde, elle, est éprouvée.
  await send(page).click({ force: true })
  await field(page).press('Enter')
  await expect(field(page)).toHaveValue('   ')
  expect(keys).toHaveLength(1)
})

test('téléphone (390 px) : la liste seule ; une conversation → le fil seul, « ← Conversations », focus sur son h2 ; retour → la liste, focus sur l\'entrée du pair', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  say(friend, me, 'Coucou')
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page)
  await expect(list(page)).toBeVisible()
  await expect(page.locator('main').getByText('Choisis une conversation.', { exact: true })).toBeHidden()
  await hydrated(entry(page, friend))
  await entry(page, friend).click()
  await expect(page).toHaveURL(`/dms?with=${friend.uid}`)
  await expect(log(page, friend)).toBeVisible()
  await expect(list(page)).toBeHidden()
  await expect(back(page)).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: friend.username })).toBeFocused()
  await back(page).click()
  await expect(page).toHaveURL('/dms')
  await expect(list(page)).toBeVisible()
  await expect(page.locator('div[role="log"]').filter({ visible: true })).toHaveCount(0)
  await expect(entry(page, friend)).toBeFocused()
})

test('Activity : « brouillon » dans le fil, « Amis » puis retour → la même page, relue, le même fil et son brouillon', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page, friend)
  await field(page).fill('brouillon')
  const nav = page.locator('nav a[href="/friends"]').first()
  await hydrated(nav)
  // Marqueur du document : un rechargement complet l'efface, et la page gardée par Activity avec lui.
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/friends')
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText('Amis')
  const reread = page.waitForRequest((r) => isThread(r, friend))
  await page.goBack()
  await expect(page).toHaveURL(`/dms?with=${friend.uid}`)
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  // Relu à chaque affichage.
  await reread
  await expect(log(page, friend)).toBeVisible()
  await expect(field(page)).toHaveValue('brouillon')
})

test('360 px, un message d\'un seul mot de 300 caractères : aucun défilement horizontal ; « ← Conversations », « Envoyer » et chaque conversation ≥ 44 px', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  const word = `w${'x'.repeat(299)}`
  say(friend, me, word)
  await page.setViewportSize({ width: 360, height: 800 })
  const noScroll = async () => {
    expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  const atLeast44 = async (target: ReturnType<Page['locator']>) => {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
  }
  await open(page, friend)
  await expect(bubble(page, friend, word)).toBeVisible()
  await noScroll()
  await atLeast44(back(page))
  await atLeast44(send(page))
  await open(page)
  await expect(entry(page, friend)).toBeVisible()
  await noScroll()
  const links = list(page).getByRole('link')
  await expect(links).toHaveCount(1)
  for (const link of await links.all()) await atLeast44(link)
})

for (const [label, reply] of FAILS) {
  test(`liste en échec (${label}) : « Impossible de charger cette page. » et « Réessayer », sans liste ; « Réessayer » → « Aucune conversation. », focus sur le h1`, async ({ page, login }) => {
    await viewer(login)
    // Les deux lectures de l'arrivée à froid : le montage, puis la première version de unreadStore() (e2e/friends.spec.ts). Monté sous
    // Suspense après la cloche, DmsClient peut naître après cette version (une seule lecture) : la première lecture de la cloche attend
    // donc celle de la liste.
    let failed = 0
    let bell = 0
    const { release: mounted, held } = hold()
    await routeOnce(page, '**/rest/v1/notifications*', async (r) => {
      bell++
      await held
      await r.fallback()
    })
    for (let i = 0; i < 2; i++) {
      await routeOnce(page, '**/api/chat', (r) => {
        failed++
        mounted()
        return r.fulfill(reply)
      })
    }
    await open(page)
    await expect(alert(page)).toHaveText(LOAD_FAILED)
    await expect(list(page)).toHaveCount(0)
    await expect.poll(() => failed).toBe(2)
    expect(bell).toBe(1)
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await expect(page.locator('main').getByText('Aucune conversation.', { exact: true })).toBeVisible()
    // « Réessayer » disparu sous le focus, aucune conversation : le h1 (PF15).
    await expect(page.locator('main h1')).toBeFocused()
    expect(await onBody(page)).toBe(false)
  })

  test(`liste en échec (${label}), « Réessayer » focalisé sans être pressé : une relecture de fond réussie le retire, le focus va au h1`, async ({ page, login }) => {
    await viewer(login)
    let failed = 0
    const { release: mounted, held } = hold()
    await routeOnce(page, '**/rest/v1/notifications*', async (r) => {
      await held
      await r.fallback()
    })
    for (let i = 0; i < 2; i++) {
      await routeOnce(page, '**/api/chat', (r) => {
        failed++
        mounted()
        return r.fulfill(reply)
      })
    }
    await page.clock.install()
    await open(page)
    await expect(alert(page)).toHaveText(LOAD_FAILED)
    await expect.poll(() => failed).toBe(2)
    await page.getByRole('button', { name: 'Réessayer' }).focus()
    // Passage de 30 s de la cloche : sa version relit la liste, qui réussit.
    await page.clock.runFor(30_000)
    await expect(page.locator('main').getByText('Aucune conversation.', { exact: true })).toBeVisible()
    await expect(page.locator('main h1')).toBeFocused()
  })

  test(`fil en échec (${label}) : l'alerte et « Réessayer » à la place du fil, la liste lue ; « Réessayer » → « Aucun message pour l'instant. » et le champ`, async ({ page, login }) => {
    const me = await viewer(login)
    const friend = player()
    befriend(me, friend)
    await routeOnce(page, '**/api/chat/*', (r) => r.fulfill(reply))
    // Horloge arrêtée avant le premier passage du poll (mount + 5 s), sur le temps de la page : « Réessayer » est le seul lecteur.
    await page.clock.install()
    await open(page, friend)
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
    await expect(alert(page)).toHaveText(LOAD_FAILED)
    await expect(page.getByRole('log')).toHaveCount(0)
    await expect(page.locator('main').getByText('Aucune conversation.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await expect(log(page, friend)).toHaveText('Aucun message pour l\'instant.')
    await expect(field(page)).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: friend.username })).toBeFocused()
  })

  test(`poll en échec (${label}) : la bulle reste, sans alerte`, async ({ page, login }) => {
    const me = await viewer(login)
    const friend = player()
    befriend(me, friend)
    say(friend, me, 'Coucou')
    await page.clock.install()
    await open(page, friend)
    await expect(bubble(page, friend, 'Coucou')).toBeVisible()
    await field(page).fill('brouillon')
    // Le passage en échec, puis le suivant retenu : parti, il prouve que l'échec a été traité.
    let reads = 0
    page.on('request', (r) => { if (isThread(r, friend)) reads++ })
    const { release, held } = hold()
    await routeOnce(page, '**/api/chat/*', async (r) => {
      await held
      await r.fallback()
    }, (r) => r.request().method() === 'GET')
    await routeOnce(page, '**/api/chat/*', (r) => r.fulfill(reply), (r) => r.request().method() === 'GET')
    const failedRead = threadRead(page, friend)
    await page.clock.runFor(5_000)
    await failedRead
    await expect.poll(async () => {
      await page.clock.runFor(1_000)
      return reads
    }).toBe(2)
    await expect(bubble(page, friend, 'Coucou')).toBeVisible()
    await expect(alert(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0)
    await expect(field(page)).toHaveValue('brouillon')
    release()
  })
}

test('Review Focus, pseudo hérité : un ami renommé x?y#z → le lien du h2 vers /profile/<encodeURIComponent>, qui affiche ce h1', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  // Suffixe aléatoire : l'index unique sur lower(username) vaut pour les workers parallèles.
  const name = `x?y#z ${randomUUID().slice(-6)}`
  sql(`update public.profiles set username = :'name' where id = :'uid'`, { name, uid: friend.uid })
  await open(page, friend)
  const link = page.getByRole('heading', { level: 2, name }).getByRole('link', { name })
  await expect(link).toHaveAttribute('href', `/profile/${encodeURIComponent(name)}`)
  expect(await link.getAttribute('href')).toMatch(/^\/profile\/x%3Fy%23z%20/)
  await hydrated(link)
  await link.click()
  await expect(page).toHaveURL(`/profile/${encodeURIComponent(name)}`)
  await expect(page.locator('main h1').filter({ visible: true })).toHaveText(name)
})
