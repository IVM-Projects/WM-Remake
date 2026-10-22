import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { befriend, expect, giveCopies, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (amitiés et échanges suivent en cascade).
const trash: string[] = []
test.afterEach(() => void sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') }))

type User = { uid: string; username: string }
const player = (opts?: Parameters<typeof makePlayer>[0]): User => {
  const u = makePlayer(opts)
  trash.push(u.uid)
  return u
}
// Demande en attente de `from` vers `to`, posée par SQL ; renvoie son id.
const ask = (from: User, to: User) =>
  sql(`insert into public.friendships (requester_id, addressee_id) values (:'r', :'a') returning id`, { r: from.uid, a: to.uid })

// Page lue et hydratée : data-ready est posé par le client après la première lecture.
async function open(page: Page) {
  await page.goto('/friends')
  await page.locator('main [data-ready]').waitFor()
}
const section = (page: Page, title: string) =>
  page.locator('main section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
const toasts = (page: Page) => page.locator('#wm-toasts')
const results = (page: Page) => page.getByRole('list', { name: 'Résultats de la recherche' }).getByRole('listitem')
const field = (page: Page) => page.locator('#friend-list-search')
const NO_FRIENDS = 'Tu n\'as pas encore d\'amis. Cherche un joueur par son pseudo.'

async function search(page: Page, q: string) {
  await field(page).fill(q)
  await field(page).press('Enter')
}

test('h1 « Amis », #friend-list-search rendu une seule fois, trois sections vides', async ({ page, login }) => {
  trash.push((await login()).uid)
  await open(page)
  await expect(page.locator('main h1')).toHaveText('Amis')
  await expect(page.locator('#friend-list-search')).toHaveCount(1)
  await expect(page.getByRole('searchbox', { name: 'Rechercher un joueur' })).toHaveAttribute('id', 'friend-list-search')
  await expect(section(page, 'Demandes reçues')).toContainText('Aucune demande reçue.')
  await expect(section(page, 'Demandes envoyées')).toContainText('Aucune demande envoyée.')
  await expect(section(page, 'Amis')).toContainText(NO_FRIENDS)
  // « Tout accepter » seulement s'il y a une demande reçue.
  await expect(page.getByRole('button', { name: 'Tout accepter' })).toHaveCount(0)
})

test('recherche d\'un joueur neuf, « Ajouter » : toast, la ligne sous « Demandes envoyées » ; « Retirer » : l\'état vide', async ({ page, login }) => {
  trash.push((await login()).uid)
  const other = player()
  await open(page)
  await search(page, other.username)
  await expect(results(page)).toHaveCount(1)
  await expect(results(page)).toContainText(other.username)
  await results(page).getByRole('button', { name: 'Ajouter' }).click()
  await expect(toasts(page)).toContainText(`Demande envoyée à ${other.username}.`)
  const sent = section(page, 'Demandes envoyées')
  await expect(sent.getByRole('listitem')).toHaveCount(1)
  await expect(sent.getByRole('listitem')).toContainText(other.username)
  await sent.getByRole('button', { name: 'Retirer' }).click()
  await expect(toasts(page)).toContainText('Demande retirée.')
  // La ligne disparue sous le focus : l'état vide de sa section le prend.
  await expect(sent.getByText('Aucune demande envoyée.', { exact: true })).toBeFocused()
})

test('une recherche d\'un caractère : le message, sans requête ; un préfixe inconnu : « Aucun joueur ne correspond. »', async ({ page, login }) => {
  trash.push((await login()).uid)
  const asked: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname === '/api/friends/search') asked.push(u.searchParams.get('q') ?? '')
  })
  await open(page)
  await search(page, ' a ')
  await expect(page.locator('main').getByRole('alert')).toHaveText('La recherche demande au moins 2 caractères')
  await expect(field(page)).toHaveAttribute('aria-invalid', 'true')
  // Une vraie recherche ensuite : la requête observée prouve que l'écoute marche, et qu'elle est la seule.
  const q = `zz${randomUUID().slice(-10)}`
  const sent = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/friends/search')
  await search(page, q)
  await sent
  await expect(page.locator('main').getByText('Aucun joueur ne correspond.', { exact: true })).toBeVisible()
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  expect(asked).toEqual([q])
})

test('demande reçue → « Accepter » : toast, la ligne sous « Amis », « Échanger » vers /trades/new?with=<id>', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const other = player()
  ask(other, me)
  await open(page)
  const received = section(page, 'Demandes reçues')
  await expect(received.getByRole('listitem')).toHaveCount(1)
  await expect(received.getByRole('listitem')).toContainText(other.username)
  await received.getByRole('button', { name: 'Accepter', exact: true }).click()
  await expect(toasts(page)).toContainText(`${other.username} fait maintenant partie de tes amis.`)
  await expect(received.getByText('Aucune demande reçue.', { exact: true })).toBeFocused()
  const row = section(page, 'Amis').getByRole('listitem')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(other.username)
  await expect(row.getByRole('link', { name: 'Échanger' })).toHaveAttribute('href', `/trades/new?with=${other.uid}`)
})

test('deux demandes reçues → « Tout accepter » au clavier : « 2 demandes acceptées. », focus sur le premier ami ajouté', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [a, b, old] = [player(), player(), player()]
  ask(a, me)
  ask(b, me)
  // Ami posé après les demandes : la liste (plus récente d'abord) le met en tête, avant les deux amis ajoutés.
  befriend(old, me)
  await open(page)
  await expect(section(page, 'Demandes reçues').getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: 'Tout accepter' }).focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('2 demandes acceptées.')
  const rows = section(page, 'Amis').getByRole('listitem')
  await expect(rows).toHaveText([old.username, b.username, a.username].map((u) => new RegExp(`^${u}`)))
  await expect(rows.nth(1).getByRole('link', { name: 'Échanger' })).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  await expect(page.getByRole('button', { name: 'Tout accepter' })).toHaveCount(0)
})

test('retrait d\'un ami avec un échange en attente : modale, toast, focus sur l\'état vide, échange annulé, nouvelle demande possible', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const other = player()
  befriend(me, other)
  const [copy] = giveCopies(me, 'C')
  const trade = sql(`select wm.create_trade(:'me', :'other', jsonb_build_array(jsonb_build_object('user_card_id', id, 'card_id', card_id,
  'offered_by', user_id))) ->> 'id' from public.user_cards where id = :'copy'`, { me: me.uid, other: other.uid, copy })
  await open(page)
  const friends = section(page, 'Amis')
  await friends.getByRole('button', { name: 'Retirer' }).click()
  const dialog = page.getByRole('dialog', { name: `Retirer ${other.username} de tes amis ?` })
  await expect(dialog.getByRole('heading')).toHaveText(`Retirer ${other.username} de tes amis ?`)
  await expect(dialog.getByText('Les échanges en attente entre vous seront annulés.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button')).toHaveText(['Annuler', 'Retirer'])
  await dialog.getByRole('button', { name: 'Retirer' }).click()
  await expect(toasts(page)).toContainText(`${other.username} a été retiré de tes amis.`)
  await expect(dialog).toBeHidden()
  // Après le démontage de la modale (focus rendu au « Retirer » de la ligne, puis la ligne retirée) : l'état vide de « Amis ».
  await expect(friends.getByText(NO_FRIENDS, { exact: true })).toBeFocused()
  expect(sql(`select status from public.trades where id = :'t'`, { t: trade })).toBe('cancelled')
  // Une nouvelle demande passe ensuite.
  await search(page, other.username)
  await results(page).getByRole('button', { name: 'Ajouter' }).click()
  await expect(toasts(page)).toContainText(`Demande envoyée à ${other.username}.`)
  await expect(section(page, 'Demandes envoyées').getByRole('listitem')).toContainText(other.username)
})

test('une ligne d\'ami : le lien « Échanger » et le bouton « Retirer », aucun « Message » (M4-1)', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const other = player()
  befriend(other, me)
  await open(page)
  const row = section(page, 'Amis').getByRole('listitem')
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('link')).toHaveText(['Échanger'])
  await expect(row.getByRole('button')).toHaveText(['Retirer'])
  await expect(page.locator('main').getByText(/Message/)).toHaveCount(0)
})

test('lecture en échec : « Impossible de charger cette page. » et « Réessayer », qui rend les sections', async ({ page, login }) => {
  trash.push((await login()).uid)
  await routeOnce(page, '**/api/friends', (r) => r.fulfill({ status: 500 }))
  await open(page)
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await expect(section(page, 'Demandes reçues')).toHaveCount(0)
  await page.getByRole('button', { name: 'Réessayer' }).click()
  for (const title of ['Demandes reçues', 'Demandes envoyées', 'Amis']) await expect(section(page, title)).toBeVisible()
  // « Réessayer » disparu sous le focus : la première section le prend.
  await expect(section(page, 'Demandes reçues').getByText('Aucune demande reçue.', { exact: true })).toBeFocused()
})

test('clavier : Tab jusqu\'à la recherche, saisie, Entrée, Tab jusqu\'à « Ajouter », Entrée → toast ; « Refuser » : focus à la ligne suivante', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [other, a, b] = [player(), player(), player()]
  ask(a, me)
  ask(b, me)
  await open(page)
  for (let i = 0; i < 40 && !(await field(page).evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(field(page)).toBeFocused()
  await page.keyboard.type(other.username)
  await page.keyboard.press('Enter')
  const add = results(page).getByRole('button', { name: 'Ajouter' })
  await expect(add).toBeVisible()
  for (let i = 0; i < 5 && !(await add.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText(`Demande envoyée à ${other.username}.`)

  // Plus récente d'abord : b, puis a. « Refuser » sur b : la ligne de a prend sa place, et le focus avec elle.
  const received = section(page, 'Demandes reçues')
  await expect(received.getByRole('listitem')).toHaveText([b.username, a.username].map((u) => new RegExp(`^${u}`)))
  await received.getByRole('listitem').first().getByRole('button', { name: 'Refuser' }).focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Demande refusée.')
  await expect(received.getByRole('listitem')).toHaveCount(1)
  await expect(received.getByRole('listitem').getByRole('button', { name: 'Accepter', exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  expect(sql(`select count(*) from public.friendships where requester_id = :'b'`, { b: b.uid })).toBe('0')
})

test('360 px, un ami au pseudo de 24 caractères sans coupure : ni main ni la page ne défilent en largeur ; cibles ≥ 44 px', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const long = player({ username: `w${randomUUID().replaceAll('-', '').slice(0, 23)}` })
  expect(long.username).toHaveLength(24)
  befriend(me, long)
  ask(player(), me)
  ask(me, player())
  await page.setViewportSize({ width: 360, height: 800 })
  await open(page)
  await expect(section(page, 'Amis').getByRole('listitem')).toContainText(long.username)
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const targets = page.locator('main').getByRole('button').or(page.locator('main').getByRole('link', { name: 'Échanger' }))
  // Tout accepter, Accepter, Refuser, Retirer (envoyée), Échanger, Retirer (ami).
  await expect(targets).toHaveCount(6)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
  }
})
