import { randomUUID } from 'node:crypto'
import type { Page, Request, Route } from '@playwright/test'
import { expect, giveCopies, makePlayer, routeOnce, sql, test } from './fixtures'

// Les corps de la lecture des joueurs sont posés (fulfill) là où le classement réel est partagé en cache entre les tests et les workers ;
// seul `me` (par requête, exact) se lit en vrai (cas « Lecture réelle »). Les comptes créés sont supprimés dans un finally.
const MIN_TARGET = 44 - 0.01
const h1 = (page: Page) => page.locator('main h1').filter({ visible: true })
const board = (me: unknown, names: string[] = ['Alice', 'Bob', 'Cyrille'], value = 5) => ({
  board: 'battles', period: 'week', week_start: '2026-10-26T00:00:00.000Z',
  entries: names.map((n, i) => ({ rank: i === 2 ? 2 : i + 1, user_id: randomUUID() as string, username: n, avatar_url: null, value: value - i })),
  me,
})
const reads = (r: Request) => new URL(r.url()).pathname === '/api/leaderboard'
const open = async (page: Page) => {
  await page.goto('/leaderboard')
  await page.locator('main [data-ready]').waitFor()
}
const wipe = (...us: { uid: string }[]) => sql(`delete from auth.users where id = any(string_to_array(:'u', ',')::uuid[])`, { u: us.map((u) => u.uid).join(',') })

test('h1, titre, Joueurs sélectionné, Victoires et Cette semaine pressés ; plus « bientôt »', async ({ page, login }) => {
  await login()
  await page.route('**/api/leaderboard*', (r) => r.fulfill({ json: board(null) }))
  await open(page)
  await expect(h1(page)).toHaveText('Classement')
  await expect(page).toHaveTitle(/^Classement — /)
  await expect(page.getByRole('tablist', { name: 'Vues du classement' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Joueurs' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('group', { name: 'Classer par' }).getByRole('button', { name: 'Victoires' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('group', { name: 'Période' }).getByRole('button', { name: 'Cette semaine' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('main')).not.toContainText('Cette section arrive bientôt.')
  for (const b of await page.getByRole('button').and(page.locator('main button')).all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
})

test('trois lignes, « Ton rang : 2 (3) », ligne du lecteur en aria-current ; Collection → une requête, focus gardé, colonne « Cartes » ; réponse lente jetée', async ({ page, login }) => {
  const me = await login()
  const body = board({ rank: 2, value: 3 })
  body.entries[2].user_id = me.uid
  body.entries[2].username = me.username
  const urls: string[] = []
  page.on('request', (r) => { if (reads(r)) urls.push(new URL(r.url()).search) })
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  await page.route('**/api/leaderboard*', (r) => r.fulfill({ json: r.request().url().includes('legendary') ? board(null, ['Legende']) : body }))
  // La réponse de « Collection » est retenue ; « Légendaires » répond tout de suite.
  await routeOnce(page, '**/api/leaderboard*', async (r: Route) => { await gate; await r.fulfill({ json: { ...board(null, ['Fantome']), board: 'collection' } }) }, (r) => r.request().url().includes('board=collection'))
  await open(page)
  const table = page.getByRole('table')
  await expect(table.getByRole('row')).toHaveCount(4)
  await expect(page.getByText('Ton rang : 2 (3)', { exact: true })).toBeVisible()
  await expect(table.getByRole('row', { name: new RegExp(me.username) })).toHaveAttribute('aria-current', 'true')
  await expect(table.getByRole('columnheader', { name: 'Victoires' })).toBeVisible()
  await expect(table.locator('caption')).toHaveText('Classement des joueurs : Victoires, Cette semaine')
  await expect(table.getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/profile/Alice')
  urls.length = 0
  const collection = page.getByRole('button', { name: 'Collection' })
  await collection.click()
  await expect(collection).toBeFocused()
  await expect(collection).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('status')).toContainText('Chargement du classement')
  await page.getByRole('button', { name: 'Légendaires' }).click()
  await expect(page.getByRole('link', { name: 'Legende' })).toBeVisible()
  release()
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await expect(page.getByRole('link', { name: 'Fantome' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Legende' })).toBeVisible()
  expect(urls).toEqual(['?board=collection&period=week', '?board=legendary&period=week'])
  await page.getByRole('button', { name: 'Collection' }).click()
  await expect(page.getByRole('columnheader', { name: 'Cartes' })).toBeVisible()
})

test('lecture réelle : deux victoires cette semaine → « Ton rang : n (2) » (me est par requête, exact)', async ({ page, login }) => {
  const me = await login()
  const loser = makePlayer()
  const other = makePlayer()
  try {
    for (const l of [loser, other]) {
      sql(`insert into public.friendships (requester_id, addressee_id, status) values (:'a', :'b', 'accepted')`, { a: me.uid, b: l.uid })
      const id = sql(`select wm.battle_create(:'a', :'b') ->> 'id'`, { a: me.uid, b: l.uid })
      sql(`select from wm.battle_action(:'b', :'id', 'accept');
select from wm.battle_action(:'a', :'id', 'submit_deck', jsonb_build_object('card_ids', string_to_array(:'ca', ',')));
select from wm.battle_action(:'b', :'id', 'submit_deck', jsonb_build_object('card_ids', string_to_array(:'cb', ',')));
select from wm.battle_action(:'b', :'id', 'forfeit');`, { a: me.uid, b: l.uid, id, ca: giveCopies(me, 'C', 3).join(','), cb: giveCopies(l, 'C', 3).join(',') })
    }
    await open(page)
    await expect(page.getByText(/^Ton rang : [\d  ]+ \(2\)$/)).toBeVisible()
  } finally {
    wipe(loser, other)
  }
})

test('sans victoire : « Tu n\'es pas encore classé. »', async ({ page, login }) => {
  await login()
  await open(page)
  await expect(page.getByText('Tu n\'es pas encore classé.', { exact: true })).toBeVisible()
})

test('classement vide : « Personne n\'est encore classé. »', async ({ page, login }) => {
  await login()
  await page.route('**/api/leaderboard*', (r) => r.fulfill({ json: { ...board(null, []), entries: [] } }))
  await open(page)
  await expect(page.getByText('Personne n\'est encore classé.')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
})

test('« Guildes » → GuildBoard (corps posé)', async ({ page, login }) => {
  await login()
  await page.route('**/api/leaderboard*', (r) => r.fulfill({ json: board(null) }))
  await routeOnce(page, '**/api/guilds/leaderboard', (r) => r.fulfill({ json: {
    entries: [{ rank: 1, guild_id: randomUUID(), guild_name: 'Les Sages', member_count: 2, score_battles: 500, score_wb: 7, total_score: 507 }],
    week_start: '2026-10-26T00:00:00.000Z', week_end: '2026-11-02T00:00:00.000Z', season: 'S53', reset_in_ms: 3_600_000, user_guild_id: null } }))
  await open(page)
  await page.getByRole('tab', { name: 'Guildes' }).click()
  await expect(page.getByRole('tab', { name: 'Guildes' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('table').locator('caption')).toHaveText('Classement des guildes, saison S53')
  await expect(page.getByRole('cell', { name: 'Les Sages' })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Classer par' })).toHaveCount(0)
})

test('lecture en échec : l\'échec, « Réessayer » → la caption focalisée', async ({ page, login }) => {
  await login()
  await routeOnce(page, '**/api/leaderboard*', (r) => r.fulfill({ status: 500, json: { message: 'boom' } }))
  await page.goto('/leaderboard')
  await page.locator('main [data-ready]').waitFor()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Le classement n\'a pas pu être chargé.')
  await page.route('**/api/leaderboard*', (r) => r.fulfill({ json: board(null) }))
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('table').locator('caption')).toBeFocused()
})

test('360 px, pseudos de 24 caractères : aucun défilement horizontal', async ({ page, login }) => {
  await login()
  await page.setViewportSize({ width: 360, height: 800 })
  const long = ['a', 'b', 'c'].map((c) => c.repeat(24))
  await page.route('**/api/leaderboard*', (r) => r.fulfill({ json: board({ rank: 1, value: 1_234_500 }, long, 1_234_500) }))
  await open(page)
  await expect(page.getByRole('table')).toBeVisible()
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
