import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { befriend, expect, hydrated, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a son joueur, supprimé à la fin (ses notifications suivent en cascade).
const trash: string[] = []
test.afterEach(() => void sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') }))

// n trade_received non lues, data de wm.notify_trade (M4-12) au nom d'Alice ; renvoie leurs trade_id.
const received = (uid: string, n: number) => sql(`insert into public.notifications (user_id, type, data)
select :'uid', 'trade_received', jsonb_build_object('trade_id', gen_random_uuid(), 'user_id', gen_random_uuid(), 'username', 'Alice')
from generate_series(1, :'n'::int) returning data ->> 'trade_id'`, { uid, n: String(n) }).split('\n')

const bell = (page: Page) => page.locator('button[aria-label="Notifications"]')
// Badge à côté du bouton (Bell.tsx).
const badge = (page: Page) => page.locator('button[aria-label="Notifications"] + span')
const panel = (page: Page) => page.getByRole('dialog', { name: 'Notifications' })
const ALICE = 'Alice te propose un échange'

test('trois échanges reçus : badge lu par PostgREST, panneau au clavier, marquage un par un puis en bloc, Échap', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  received(uid, 3)
  const asked: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/notifications') asked.push(r.method()) })
  const read = page.waitForRequest((r) => new URL(r.url()).pathname === '/rest/v1/notifications')
  await page.goto('/pulls')
  const url = new URL((await read).url())
  expect(url.pathname + url.search).toBe('/rest/v1/notifications?select=id&read=eq.false&limit=10')
  await expect(badge(page)).toHaveText('3')
  // Nom figé, compte dans la description (aria-describedby).
  await expect(bell(page)).toHaveAccessibleName('Notifications')
  await expect(bell(page)).toHaveAccessibleDescription('3 notifications non lues')
  // Le panneau seul lit /api/notifications, à son ouverture.
  expect(asked).toEqual([])

  await hydrated(bell(page))
  for (let i = 0; i < 40 && !(await bell(page).evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(bell(page)).toBeFocused()
  await page.keyboard.press('Enter')
  const rows = panel(page).getByRole('list', { name: 'Notifications récentes' }).getByRole('listitem')
  await expect(rows).toHaveCount(3)
  for (const row of await rows.all()) await expect(row.getByRole('link')).toHaveText(ALICE)
  expect(asked).toEqual(['GET'])

  // Le bouton lu disparaît sous le focus : le suivant le prend, puis « Tout marquer comme lu » après le dernier.
  const marks = panel(page).getByRole('button', { name: 'Marquer comme lu', exact: true })
  const all = panel(page).getByRole('button', { name: 'Tout marquer comme lu' })
  await marks.first().focus()
  await page.keyboard.press('Enter')
  await expect(badge(page)).toHaveText('2')
  await expect(marks).toHaveCount(2)
  await expect(marks.first()).toBeFocused()
  await marks.last().focus()
  await page.keyboard.press('Enter')
  await expect(badge(page)).toHaveText('1')
  await expect(bell(page)).toHaveAccessibleDescription('1 notification non lue')
  await expect(all).toBeFocused()
  // Relecture du badge retenue : un second Entrée pendant ce temps ne renvoie aucun PATCH (mark attend store.refresh()).
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  await routeOnce(page, (u) => u.pathname === '/rest/v1/notifications', async (route) => {
    await held
    await route.fallback()
  })
  const reread = page.waitForRequest((r) => new URL(r.url()).pathname === '/rest/v1/notifications')
  await page.keyboard.press('Enter')
  await reread
  await page.keyboard.press('Enter')
  release()
  await expect(badge(page)).toHaveCount(0)
  await expect(bell(page)).toHaveAccessibleDescription('Aucune notification non lue')
  await expect(marks).toHaveCount(0)
  await expect(all).toHaveAttribute('aria-disabled', 'true')
  expect(asked).toEqual(['GET', 'PATCH', 'PATCH', 'PATCH'])

  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await expect(bell(page)).toBeFocused()
})

test('douze non lues : « 9+ » ; le lien d\'un échange reçu mène à /trades/<trade_id>', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  const trades = received(uid, 12)
  await page.goto('/pulls')
  await expect(badge(page)).toHaveText('9+')
  await expect(bell(page)).toHaveAccessibleDescription('Plus de 9 notifications non lues')
  await bell(page).click()
  const links = panel(page).getByRole('link', { name: ALICE })
  await expect(links).toHaveCount(12)
  expect((await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')))).sort()).toEqual(trades.map((t) => `/trades/${t}`).sort())
})

test('lecture en échec : « Impossible de charger cette page. » et « Réessayer », qui rend la liste ; un 200 illisible de même', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  received(uid, 1)
  await routeOnce(page, '**/api/notifications', (r) => r.fulfill({ status: 500 }))
  await page.goto('/pulls')
  await expect(badge(page)).toHaveText('1')
  await bell(page).click()
  await expect(panel(page).getByText('Impossible de charger cette page.', { exact: true })).toBeVisible()
  await panel(page).getByRole('button', { name: 'Réessayer' }).click()
  await expect(panel(page).getByRole('link', { name: ALICE })).toBeVisible()
  await expect(page.locator('body')).not.toBeFocused()

  // 200 au corps illisible (api() rend null) : une lecture en échec, jamais « Chargement des notifications » sans fin.
  await page.keyboard.press('Escape')
  await expect(panel(page)).toBeHidden()
  await routeOnce(page, '**/api/notifications', (r) => r.fulfill({ status: 200, body: 'x' }))
  await bell(page).click()
  await expect(panel(page).getByRole('alert')).toHaveText('Impossible de charger cette page.')
  await panel(page).getByRole('button', { name: 'Réessayer' }).click()
  await expect(panel(page).getByRole('link', { name: ALICE })).toBeVisible()
})

test('surenchère du M3 : « Tu as été surenchéri sur <card_title> », lien vers l\'enchère', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  const title = `Zz carte e2e ${randomUUID().slice(-12)}`
  // data de wm.notification_data (1600_wm_market_core.sql) : card_title est le titre de la copie, avant celui du catalogue.
  const auction = sql(`insert into public.notifications (user_id, type, data) values (:'uid', 'auction_outbid', jsonb_build_object(
  'auction_id', gen_random_uuid(), 'card_id', gen_random_uuid(), 'card_title', :'t', 'wikipedia_title', 'Autre titre', 'amount', 120))
returning data ->> 'auction_id'`, { uid, t: title })
  await page.goto('/pulls')
  await expect(badge(page)).toHaveText('1')
  await bell(page).click()
  await expect(panel(page).getByRole('link', { name: `Tu as été surenchéri sur ${title}`, exact: true })).toHaveAttribute('href', `/marketplace/${auction}`)
})

test('message privé : « Alice t\'a écrit », lien vers le fil /dms?with=<user_id>', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  const from = sql(`insert into public.notifications (user_id, type, data) values (:'uid', 'chat_message',
  jsonb_build_object('user_id', gen_random_uuid(), 'username', 'Alice')) returning data ->> 'user_id'`, { uid })
  await page.goto('/pulls')
  await expect(badge(page)).toHaveText('1')
  await bell(page).click()
  await expect(panel(page).getByRole('link', { name: 'Alice t\'a écrit', exact: true })).toHaveAttribute('href', `/dms?with=${from}`)
})

test('défi reçu (wm.battle_create par sql) : « <pseudo> te défie en bataille », lien vers /battle/<id>', async ({ page, login }) => {
  const me = await login()
  const from = makePlayer()
  trash.push(me.uid, from.uid)
  befriend(from, me)
  // Une bataille posée par sql passe par les fonctions : battle_create écrit la battle_invite de wm.notify_battle.
  const battle = sql(`select wm.battle_create(:'a', :'b') ->> 'id'`, { a: from.uid, b: me.uid })
  await page.goto('/pulls')
  await expect(badge(page)).toHaveText('1')
  await bell(page).click()
  await expect(panel(page).getByRole('link', { name: `${from.username} te défie en bataille`, exact: true })).toHaveAttribute('href', `/battle/${battle}`)
})

test('vide : « Aucune notification. » ; la cloche et « Tout marquer comme lu » font au moins 44 px', async ({ page, login }) => {
  trash.push((await login()).uid)
  await page.goto('/pulls')
  await hydrated(bell(page))
  await bell(page).click()
  await expect(panel(page).getByText('Aucune notification.', { exact: true })).toBeVisible()
  const all = panel(page).getByRole('button', { name: 'Tout marquer comme lu' })
  await expect(all).toHaveAttribute('aria-disabled', 'true')
  for (const target of [bell(page), all]) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
  }
})
