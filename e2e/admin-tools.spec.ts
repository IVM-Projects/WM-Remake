import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { cookieFor, expect, makeGuild, makePlayer, makeStaff, routeOnce, sql, test } from './fixtures'

// Espace admin (Task 16) : joueurs et sanctions, signalements, images, messages privés. Chaque test crée ses joueurs, son staff, ses cartes
// et ses lignes, supprimés dans un finally (les sanctions, signalements et signalements d'image suivent les profils en cascade ; l'audit, par son staff).
const MIN_TARGET = 44 - 0.01
const REASON = 'Motif de test'
const h1 = (page: Page) => page.locator('main h1').filter({ visible: true })
const wipe = (...ids: string[]) => {
  sql(`delete from wm.staff_actions where staff_id = any(string_to_array(:'u', ',')::uuid[]) or target_id = any(string_to_array(:'u', ','))`, { u: ids.join(',') })
  sql(`delete from auth.users where id = any(string_to_array(:'u', ',')::uuid[])`, { u: ids.join(',') })
}
const dialog = (page: Page) => page.getByRole('dialog')

async function asStaff(page: Page, role: 'admin' | 'moderator' = 'admin') {
  const u = makeStaff(role)
  await page.context().addCookies([{ ...cookieFor(u), url: 'http://127.0.0.1:3100' }])
  return u
}
// Joueur d'un pseudo à préfixe commun, que la recherche par deux lettres retrouve.
const target = () => makePlayer({ username: `zq_${randomUUID().slice(-12)}` })
const report = (by: string, of: string, details = 'détails du test') =>
  sql(`select wm.report_upsert(:'c', :'a', 'spam', :'d') \\gset
select id from public.reports where reporter_id = :'c' and reported_user_id = :'a'`, { c: by, a: of, d: details })
const say = (from: string, to: string, content: string) =>
  sql(`insert into public.chat_messages (sender_id, recipient_id, content) values (:'f', :'t', :'c') returning id`, { f: from, t: to, c: content })
const inDays = (n: number) => new Date(Date.now() + n * 864e5 - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 16)

async function fillReason(scope: Locator, text = REASON) {
  await scope.getByLabel('Motif (obligatoire)').fill(text)
}
// Ouvre /admin/users?user=… (fiche lue).
async function openUser(page: Page, uid: string) {
  await page.goto(`/admin/users?user=${uid}`)
  await page.locator('main [data-ready]').waitFor()
}
const row = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text })

test('joueurs : recherche, fiche, sanction « Restriction » (refus 403 dit, puis posée), levée', async ({ page }) => {
  const staff = await asStaff(page)
  const a = target()
  try {
    await page.goto('/admin/users')
    await expect(h1(page)).toHaveText('Joueurs')
    await expect(page).toHaveTitle(/^Joueurs — /)
    const search = page.getByRole('searchbox', { name: 'Rechercher un joueur' })
    expect(await search.getAttribute('placeholder')).toBeNull()
    let reads = 0
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/admin/users') reads++ })
    await search.fill('z')
    await search.press('Enter')
    await expect(page.getByText('Tape au moins 2 caractères.')).toBeVisible()
    expect(reads).toBe(0)
    await search.fill('zq')
    await search.press('Enter')
    await page.getByRole('link', { name: new RegExp(a.username) }).click()
    await expect(page).toHaveURL(new RegExp(`user=${a.uid}`))
    await expect(page.getByRole('heading', { name: a.username })).toBeVisible()
    await expect(page.getByText(/^Profil (public|privé)$/)).toBeVisible()
    await expect(page.getByText('Signalements reçus : 0')).toBeVisible()
    await expect(page.getByText('Signalements déposés : 0')).toBeVisible()
    await expect(page.getByText('Aucune sanction.')).toBeVisible()

    const open = page.getByRole('button', { name: 'Sanctionner', exact: true })
    await open.click()
    await expect(dialog(page).getByRole('heading', { name: `Sanctionner ${a.username}` })).toBeVisible()
    await expect(dialog(page).getByRole('radio')).toHaveCount(4)
    await dialog(page).getByRole('radio', { name: 'Restriction' }).check()
    await expect(dialog(page).getByText('Le joueur ne peut plus agir dans le jeu jusqu\'à la fin, il peut encore consulter.')).toBeVisible()
    await dialog(page).getByLabel('Fin').fill(inDays(2))
    const go = dialog(page).getByRole('button', { name: 'Sanctionner', exact: true })
    await fillReason(dialog(page), 'ab')
    await expect(go).toHaveAttribute('aria-disabled', 'true')
    await fillReason(dialog(page))
    await expect(go).not.toHaveAttribute('aria-disabled', 'true')
    await routeOnce(page, '**/api/admin/users/*/sanctions', (r) => r.fulfill({ status: 403, json: { error: 'Action réservée aux administrateurs', message: 'Action réservée aux administrateurs' } }))
    await go.click()
    await expect(dialog(page).getByRole('alert')).toHaveText('Action réservée aux administrateurs')
    await go.click()
    await expect(page.getByRole('status').filter({ hasText: 'Sanction enregistrée.' })).toBeVisible()
    await expect(dialog(page)).toHaveCount(0)
    await expect(open).toBeFocused()
    const table = page.getByRole('table', { name: `Sanctions de ${a.username}` })
    await expect(table.getByRole('row').nth(1)).toContainText('Restriction')
    await expect(table.getByRole('row').nth(1)).toContainText(REASON)
    await expect(table.getByRole('row').nth(1)).toContainText('Active')
    expect(sql(`select kind || ':' || (revoked_at is null) from wm.sanctions where user_id = :'a'`, { a: a.uid })).toBe('restriction:true')
    expect(sql(`select count(*) from wm.staff_actions where action = 'sanction' and target_id = :'a' and staff_id = :'s'`, { a: a.uid, s: staff.uid })).toBe('1')

    await table.getByRole('button', { name: 'Lever' }).click()
    await fillReason(dialog(page), 'Erreur de jugement')
    await dialog(page).getByRole('button', { name: 'Lever' }).click()
    await expect(table.getByRole('row').nth(1)).toContainText(/Levée le /)
    await expect(table.getByRole('button', { name: 'Lever' })).toHaveCount(0)
    await expect(table.locator('caption')).toBeFocused()
    expect(sql(`select count(*) from wm.sanctions where user_id = :'a' and revoked_at is not null`, { a: a.uid })).toBe('1')

    // « Rouvrir le check » : audité.
    await page.getByRole('button', { name: 'Rouvrir le check' }).click()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Rouvrir le check' }).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(sql(`select count(*) from wm.staff_actions where action = 'achievements_recheck' and target_id = :'a'`, { a: a.uid })).toBe('1')
  } finally {
    wipe(staff.uid, a.uid)
  }
})

test('joueurs : un modérateur ne voit ni Suspension ni Bannissement ; admin : session à resynchroniser quand auth_synced est faux', async ({ page }) => {
  const mod = await asStaff(page, 'moderator')
  const a = target()
  const boss = makeStaff('admin')
  try {
    await openUser(page, a.uid)
    await page.getByRole('button', { name: 'Sanctionner', exact: true }).click()
    await expect(dialog(page).getByRole('radio')).toHaveCount(2)
    await expect(dialog(page).getByRole('radio', { name: 'Avertissement' })).toBeChecked()
    await expect(dialog(page).getByRole('radio', { name: 'Suspension' })).toHaveCount(0)
    await expect(dialog(page).getByRole('radio', { name: 'Bannissement' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Resynchroniser la session' })).toHaveCount(0)

    await page.context().clearCookies()
    await page.context().addCookies([{ ...cookieFor(boss), url: 'http://127.0.0.1:3100' }])
    await openUser(page, a.uid)
    await expect(page.getByText('La session GoTrue n\'a pas pu être mise à jour')).toHaveCount(0)
    await page.getByRole('button', { name: 'Sanctionner', exact: true }).click()
    await expect(dialog(page).getByRole('radio')).toHaveCount(4)
    await fillReason(dialog(page))
    await routeOnce(page, '**/api/admin/users/*/sanctions', async (r) => {
      const real = await (await r.fetch()).json()
      await r.fulfill({ status: 201, json: { ...real, auth_synced: false } })
    })
    await dialog(page).getByRole('button', { name: 'Sanctionner', exact: true }).click()
    await expect(page.getByText('La session GoTrue n\'a pas pu être mise à jour : resynchronise-la.')).toBeVisible()
    await page.getByRole('button', { name: 'Resynchroniser la session' }).click()
    await fillReason(dialog(page), 'Session à resynchroniser')
    await dialog(page).getByRole('button', { name: 'Resynchroniser', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Resynchroniser la session' })).toHaveCount(0)
    expect(sql(`select count(*) from wm.staff_actions where action = 'auth_sync' and target_id = :'a'`, { a: a.uid })).toBe('1')
  } finally {
    wipe(mod.uid, boss.uid, a.uid)
  }
})

test('signalements : lire (auditée) et supprimer un message, marquer traité, sanctionner depuis la ligne', async ({ page }) => {
  const staff = await asStaff(page, 'moderator')
  const [a, c, d] = [makePlayer(), makePlayer(), makePlayer()]
  try {
    const r1 = report(c.uid, a.uid)
    const msg = say(a.uid, c.uid, 'premier message du test')
    say(c.uid, a.uid, 'réponse du test')
    await page.goto('/admin/reports')
    await page.locator('main [data-ready]').waitFor()
    await expect(h1(page)).toHaveText('Signalements')
    await expect(page).toHaveTitle(/^Signalements — /)
    const tabs = page.getByRole('tablist', { name: 'Files de signalements' })
    await expect(tabs.getByRole('tab')).toHaveText(['Joueurs', 'Images'])
    await expect(tabs.getByRole('tab', { name: 'Joueurs' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: 'À traiter' })).toHaveAttribute('aria-pressed', 'true')
    const line = row(page, `${c.username} a signalé ${a.username}`)
    await expect(line).toContainText('Spam')
    await expect(line).toContainText('détails du test')

    await line.getByRole('button', { name: 'Lire les messages' }).click()
    await expect(dialog(page).getByText('Cette lecture est enregistrée au journal avec ton motif.')).toBeVisible()
    const read = dialog(page).getByRole('button', { name: 'Lire les messages' })
    await expect(read).toHaveAttribute('aria-disabled', 'true')
    expect(sql(`select count(*) from wm.staff_actions where action = 'dm_read' and staff_id = :'s'`, { s: staff.uid })).toBe('0')
    await fillReason(dialog(page))
    await read.click()
    const log = dialog(page).getByRole('log', { name: `Messages entre ${c.username} et ${a.username}` })
    await expect(log.getByText('premier message du test')).toBeVisible()
    await expect(log.getByText('réponse du test')).toBeVisible()
    expect(sql(`select count(*) from wm.staff_actions where action = 'dm_read' and staff_id = :'s'`, { s: staff.uid })).toBe('1')

    await log.getByRole('button', { name: 'Supprimer' }).first().click()
    await expect(page.getByRole('heading', { name: 'Supprimer ce message ?' })).toBeVisible()
    await expect(page.getByText('Le message disparaît pour les deux joueurs.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Supprimer ce message ?' })).toHaveCount(0)
    await expect(log).toBeVisible()
    await log.getByRole('button', { name: 'Supprimer' }).first().click()
    await fillReason(dialog(page).last(), 'Message injurieux')
    await dialog(page).last().getByRole('button', { name: 'Supprimer', exact: true }).click()
    await expect(log.getByText('premier message du test')).toHaveCount(0)
    expect(sql(`select count(*) from public.chat_messages where id = :'m'`, { m: msg })).toBe('0')
    await expect(log.getByRole('button', { name: 'Supprimer' })).toBeFocused()
    await log.getByRole('button', { name: 'Supprimer' }).click()
    await fillReason(dialog(page).last(), 'Message injurieux')
    await dialog(page).last().getByRole('button', { name: 'Supprimer', exact: true }).click()
    await expect(dialog(page).getByText('Aucun message entre ces deux joueurs.')).toBeFocused()
    await dialog(page).getByRole('button', { name: 'Fermer' }).click()
    await expect(line.getByRole('button', { name: 'Lire les messages' })).toBeFocused()

    await line.getByRole('button', { name: 'Marquer traité' }).click()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Marquer traité' }).click()
    await expect(line).toHaveCount(0)
    await expect(page.locator(':focus')).not.toHaveJSProperty('tagName', 'BODY')
    expect(sql(`select status from wm.report_reviews where report_id = :'r'`, { r: r1 })).toBe('resolved')
    await page.getByRole('button', { name: 'Traités' }).click()
    await expect(row(page, `${c.username} a signalé ${a.username}`)).toContainText(`Traité le`)
    await expect(row(page, `${c.username} a signalé ${a.username}`)).toContainText(`par ${staff.username}`)

    // Sanctionner depuis une ligne : la revue passe à « traité ».
    const r2 = report(d.uid, a.uid)
    await page.getByRole('button', { name: 'À traiter' }).click()
    const second = row(page, `${d.username} a signalé ${a.username}`)
    await second.getByRole('button', { name: 'Sanctionner' }).click()
    await expect(dialog(page).getByRole('heading', { name: `Sanctionner ${a.username}` })).toBeVisible()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Sanctionner', exact: true }).click()
    await expect(second).toHaveCount(0)
    expect(sql(`select status from wm.report_reviews where report_id = :'r'`, { r: r2 })).toBe('resolved')
    expect(sql(`select kind from wm.sanctions where user_id = :'a'`, { a: a.uid })).toBe('warning')
  } finally {
    wipe(staff.uid, a.uid, c.uid, d.uid)
  }
})

test('images : une carte à 2 signalements → « Masquer l\'image » : masquée, compteur effacé, la ligne quitte la file', async ({ page }) => {
  const staff = await asStaff(page, 'moderator')
  const [p, q] = [makePlayer(), makePlayer()]
  const title = `Zz image report ${randomUUID().slice(-12)} z`
  let card = ''
  try {
    card = sql(`select tests.image_card(:'t')`, { t: title })
    sql(`insert into wm.card_image_reports (card_id, user_id) values (:'c', :'p'), (:'c', :'q')`, { c: card, p: p.uid, q: q.uid })
    await page.goto('/admin/reports')
    await page.locator('main [data-ready]').waitFor()
    await page.getByRole('tab', { name: 'Images' }).click()
    const line = row(page, title)
    await expect(line).toContainText('2 signalements')
    await expect(line).toContainText('Visible')
    await expect(line.getByRole('button')).toHaveText(['Masquer l\'image', 'Marquer sensible', 'Garder l\'image'])
    await line.getByRole('button', { name: 'Masquer l\'image' }).click()
    await expect(dialog(page).getByText('Les signalements de cette carte sont effacés : le compteur repart de zéro.')).toBeVisible()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Masquer l\'image' }).click()
    await expect(line).toHaveCount(0)
    expect(sql(`select hide_image from public.cards where id = :'c'`, { c: card })).toBe('t')
    expect(sql(`select count(*) from wm.card_image_reports where card_id = :'c'`, { c: card })).toBe('0')
    // Focus : le texte du vide si la file est vide, sinon l'action de la ligne suivante (la base du banc est partagée).
    await expect.poll(() => page.evaluate(() => {
      const f = document.activeElement
      return f?.textContent === 'Aucune image signalée.' || (f?.tagName === 'BUTTON' && !!f.closest('li'))
    })).toBe(true)
  } finally {
    if (card) sql(`delete from public.cards where id = :'c'`, { c: card })
    wipe(staff.uid, p.uid, q.uid)
  }
})

test('lectures en échec : joueurs (recherche et fiche), signalements, images → « Réessayer »', async ({ page }) => {
  const staff = await asStaff(page)
  const a = target()
  try {
    for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
      await page.goto('/admin/users')
      await routeOnce(page, '**/api/admin/users*', (r) => r.fulfill(reply))
      await page.getByRole('searchbox', { name: 'Rechercher un joueur' }).fill('zq')
      await page.getByRole('searchbox', { name: 'Rechercher un joueur' }).press('Enter')
      await expect(page.getByText('La recherche n\'a pas abouti.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('heading', { name: 'Résultats' }), label).toBeFocused()

      await routeOnce(page, '**/api/admin/users/*', (r) => r.fulfill(reply))
      await page.goto(`/admin/users?user=${a.uid}`)
      await expect(page.getByText('La fiche n\'a pas pu être chargée.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('heading', { name: a.username }), label).toBeFocused()

      await routeOnce(page, '**/api/admin/reports*', (r) => r.fulfill(reply))
      await page.goto('/admin/reports')
      await expect(page.getByText('Les signalements n\'ont pas pu être chargés.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('tab', { name: 'Joueurs' }), label).toBeFocused()

      await routeOnce(page, '**/api/admin/image-reports*', (r) => r.fulfill(reply))
      await page.getByRole('tab', { name: 'Images' }).click()
      await expect(page.getByText('Les signalements n\'ont pas pu être chargés.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('tab', { name: 'Images' }), label).toBeFocused()
    }
  } finally {
    wipe(staff.uid, a.uid)
  }
})

test('360 px : aucun défilement horizontal (message de 2 000 caractères sans espace), cibles de 44 px', async ({ page }) => {
  const staff = await asStaff(page)
  const [a, c] = [target(), makePlayer()]
  try {
    report(c.uid, a.uid, 'x'.repeat(480))
    say(a.uid, c.uid, 'm'.repeat(2000))
    sql(`insert into wm.sanctions (user_id, kind, reason, ends_at) values (:'a', 'restriction', :'r', now() + interval '1 day')`, { a: a.uid, r: 'y'.repeat(100) })
    await page.setViewportSize({ width: 360, height: 740 })
    const fits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
    }
    await openUser(page, a.uid)
    await expect(page.getByRole('table')).toBeVisible()
    await fits()
    await page.goto('/admin/reports')
    await page.locator('main [data-ready]').waitFor()
    const line = row(page, `${c.username} a signalé ${a.username}`)
    await fits()
    for (const b of await line.getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
    await line.getByRole('button', { name: 'Lire les messages' }).click()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Lire les messages' }).click()
    await expect(dialog(page).getByRole('log')).toContainText('m'.repeat(50))
    await fits()
    expect(await dialog(page).evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true)
    for (const b of await dialog(page).getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
  } finally {
    wipe(staff.uid, a.uid, c.uid)
  }
})

// --- Task 17 : cartes et guildes. Une carte retirée, masquée ou signalée est toujours une carte dédiée (tests.image_card), supprimée en finally.
const newCard = (title: string, pool = false) => {
  const card = sql(`select tests.image_card(:'t')`, { t: title })
  if (pool) sql(`select wm.pool_add(:'c', 'R')`, { c: card })
  return card
}
const dropCard = (card: string) => {
  if (!card) return
  sql(`select wm.pool_remove(:'c');
delete from public.auction_bids where auction_id in (select id from public.auctions where card_id = :'c');
delete from public.auctions where card_id = :'c';
delete from public.user_cards where card_id = :'c';
delete from wm.card_removals where card_id = :'c';
delete from wm.card_quizzes where card_id = :'c';
delete from wm.staff_actions where target_id = :'c';
delete from public.cards where id = :'c'`, { c: card })
}
const invariants = (...uids: string[]) => sql(`select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(wm.check_invariants()) v where v ->> 'user_id' = any(string_to_array(:'u', ','))`, { u: uids.join(',') })
const toastOf = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text })

test('cartes : choisir, masquer l\'image, retirer (enchère dénouée, 409 dit), cartes retirées, remettre', async ({ page }) => {
  const staff = await asStaff(page)
  const seller = makePlayer({ humanVerified: true })
  const bidder = makePlayer({ balance: 100, humanVerified: true })
  const title = `Zz carte admin ${randomUUID().slice(-12)} z`
  let card = ''
  try {
    card = newCard(title, true)
    const auction = sql(`select from wm.grant_copy(:'s', :'c', false) \\g /dev/null
select wm.create_auction(:'s', :'c', 10, 60) ->> 'id' as id \\gset
select from wm.place_bid(:'b', :'id', 10) \\g /dev/null
\\echo :id`, { s: seller.uid, b: bidder.uid, c: card })
    await page.goto('/admin/cards')
    await page.locator('main [data-ready]').waitFor()
    await expect(h1(page)).toHaveText('Cartes')
    await expect(page).toHaveTitle(/^Cartes — /)
    await page.getByRole('button', { name: 'Choisir une carte' }).click()
    await dialog(page).getByRole('searchbox', { name: 'Rechercher une carte' }).fill(title)
    await dialog(page).getByRole('searchbox', { name: 'Rechercher une carte' }).press('Enter')
    await dialog(page).getByRole('button', { name: new RegExp(title) }).first().click()
    await expect(page).toHaveURL(new RegExp(`card=${card}`))
    const name = page.getByRole('heading', { name: title, level: 2 })
    await expect(name).toBeVisible()
    await expect(page.getByText('1 ventes actives')).toBeVisible()
    await expect(page.getByText('0 échanges en attente')).toBeVisible()
    await expect(page.getByText('0 demandes de guilde')).toBeVisible()
    await expect(page.getByText('0 vitrines')).toBeVisible()
    await expect(page.getByText('0 avatars')).toBeVisible()
    await expect(page.getByText('0 signalements d\'image')).toBeVisible()
    await expect(page.getByText('Banque de quiz : non')).toBeVisible()
    await expect(page.getByText('Image masquée')).toHaveCount(0)

    await page.getByRole('button', { name: 'Masquer l\'image' }).click()
    await expect(dialog(page).getByText('Les avatars qui montrent cette image sont retirés ; les signalements sont effacés.')).toBeVisible()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Masquer l\'image' }).click()
    await expect(page.getByText('Image masquée', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Afficher l\'image' })).toBeVisible()
    expect(sql(`select hide_image from public.cards where id = :'c'`, { c: card })).toBe('t')

    await page.getByRole('button', { name: 'Retirer la carte' }).click()
    await expect(dialog(page).getByText('La carte sort du catalogue et des tirages.', { exact: false })).toBeVisible()
    await expect(dialog(page).getByText('Les copies restent chez leurs propriétaires.', { exact: false })).toBeVisible()
    await expect(dialog(page).getByText('1 ventes actives')).toBeVisible()
    await fillReason(dialog(page))
    await routeOnce(page, '**/api/admin/cards/*/removal', (r) => r.fulfill({ status: 409, json: { error: 'Cette carte est déjà retirée', message: 'Cette carte est déjà retirée' } }), (r) => r.request().method() === 'POST')
    await dialog(page).getByRole('button', { name: 'Retirer la carte' }).click()
    await expect(dialog(page).getByRole('alert')).toHaveText('Cette carte est déjà retirée')
    await dialog(page).getByRole('button', { name: 'Retirer la carte' }).click()
    await expect(toastOf(page, 'Carte retirée : 1 ventes annulées, 0 échanges annulés.')).toBeVisible()
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByText(new RegExp(`^Retirée le .* : ${REASON}$`))).toBeVisible()
    await expect(name).toBeFocused()
    const table = page.getByRole('table', { name: 'Cartes retirées' })
    await expect(table.getByRole('row').filter({ hasText: title })).toContainText(REASON)
    await expect(table.getByRole('row').filter({ hasText: title })).toContainText(staff.username)
    expect(sql(`select status from public.auctions where id = :'a'`, { a: auction })).toBe('cancelled')
    expect(sql(`select wikibidous_balance from public.profiles where id = :'b'`, { b: bidder.uid })).toBe('100')
    expect(invariants(seller.uid, bidder.uid)).toBe('[]')
    expect(sql(`select count(*) from wm.staff_actions where action = 'card_remove' and target_id = :'c'`, { c: card })).toBe('1')

    await page.getByRole('button', { name: 'Remettre la carte' }).click()
    await expect(dialog(page).getByText('La carte revient au catalogue. Les ventes et échanges annulés ne reviennent pas.')).toBeVisible()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Remettre la carte' }).click()
    await expect(page.getByText(/^Retirée le /)).toHaveCount(0)
    await expect(table.getByRole('row').filter({ hasText: title })).toHaveCount(0)
    expect(sql(`select count(*) from wm.card_removals where card_id = :'c'`, { c: card })).toBe('0')

    // Banque de quiz : effacée, la mention passe à « non ».
    sql(`insert into wm.card_quizzes (card_id, prompt_version, source, questions) values (:'c', 1, 'template', '[]')`, { c: card })
    await page.reload()
    await expect(page.getByText('Banque de quiz : oui')).toBeVisible()
    await page.getByRole('button', { name: 'Effacer la banque de quiz' }).click()
    await expect(dialog(page).getByText('La banque sera recréée par modèles à la prochaine bataille, et par le générateur au prochain passage.')).toBeVisible()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Effacer la banque de quiz' }).click()
    await expect(page.getByText('Banque de quiz : non')).toBeVisible()
  } finally {
    dropCard(card)
    wipe(staff.uid, seller.uid, bidder.uid)
  }
})

test('cartes : un modérateur ne voit ni « Retirer la carte » ni « Effacer la banque de quiz » ; l\'API refuse', async ({ page }) => {
  const mod = await asStaff(page, 'moderator')
  const title = `Zz carte mod ${randomUUID().slice(-12)} z`
  let card = ''
  try {
    card = newCard(title)
    await page.goto(`/admin/cards?card=${card}`)
    await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Masquer l\'image' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Marquer sensible' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retirer la carte' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remettre la carte' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Effacer la banque de quiz' })).toHaveCount(0)
    const res = await page.request.post(`/api/admin/cards/${card}/removal`, { data: { reason: REASON }, headers: { 'idempotency-key': randomUUID() } })
    expect(res.status()).toBe(403)
    expect(sql(`select count(*) from wm.card_removals where card_id = :'c'`, { c: card })).toBe('0')
  } finally {
    dropCard(card)
    wipe(mod.uid)
  }
})

test('guildes : recherche, fiche, message supprimé, demande retirée, dissolution (focus sur le champ, trois guild_kicked)', async ({ page }) => {
  const staff = await asStaff(page)
  const [lead, m1, m2] = [makePlayer(), makePlayer(), makePlayer()]
  const name = `Zq${randomUUID().replaceAll('-', '').slice(0, 14)}`
  let gid = ''
  try {
    gid = makeGuild(lead, [m1, m2], name)
    sql(`insert into public.guild_chat_messages (guild_id, user_id, content) values (:'g', :'u', 'premier message de guilde'), (:'g', :'v', 'second message de guilde')`, { g: gid, u: m1.uid, v: m2.uid })
    const cardId = sql(`select id from public.cards where rarity = 'C' order by id limit 1`)
    const wish = sql(`select wm.guild_wish_set(:'u', :'c') -> 'wishlist' ->> 'id'`, { u: m1.uid, c: cardId })
    await page.goto('/admin/guilds')
    await expect(h1(page)).toHaveText('Guildes')
    await expect(page).toHaveTitle(/^Guildes — /)
    const search = page.getByRole('searchbox', { name: 'Rechercher une guilde' })
    await search.fill('z')
    await search.press('Enter')
    await expect(page.getByText('Tape au moins 2 caractères.')).toBeVisible()
    await search.fill(name)
    await search.press('Enter')
    await page.getByRole('link', { name: new RegExp(name) }).click()
    await expect(page).toHaveURL(new RegExp(`guild=${gid}`))
    await expect(page.getByRole('heading', { name })).toBeVisible()
    const members = page.getByRole('list').filter({ hasText: 'Membre depuis le' })
    await expect(members.getByRole('listitem')).toHaveCount(3)
    await expect(members.getByRole('listitem').first()).toContainText(lead.username)
    await expect(members.getByRole('listitem').first()).toContainText('Chef')
    const log = page.getByRole('log', { name: 'Messages de la guilde' })
    await expect(log).toContainText('premier message de guilde')
    await expect(log.getByRole('button', { name: 'Supprimer' })).toHaveCount(2)

    await log.getByText('premier message de guilde').locator('..').getByRole('button', { name: 'Supprimer' }).click()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Supprimer', exact: true }).click()
    await expect(toastOf(page, 'Message supprimé.')).toBeVisible()
    await expect(log.getByText('premier message de guilde')).toHaveCount(0)
    await expect(log.getByText('second message de guilde')).toBeVisible()
    expect(sql(`select count(*) from public.guild_chat_messages where guild_id = :'g'`, { g: gid })).toBe('1')

    await page.getByRole('button', { name: 'Retirer la demande' }).click()
    await fillReason(dialog(page))
    await dialog(page).getByRole('button', { name: 'Retirer la demande' }).click()
    await expect(toastOf(page, 'Demande retirée.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retirer la demande' })).toHaveCount(0)
    expect(sql(`select count(*) from public.guild_wishlists where id = :'w'`, { w: wish })).toBe('0')

    await page.getByRole('button', { name: 'Dissoudre la guilde' }).click()
    await expect(dialog(page).getByText('Les membres sont prévenus. Messages, demandes, dons et scores de la guilde disparaissent.')).toBeVisible()
    await fillReason(dialog(page))
    const go = dialog(page).getByRole('button', { name: 'Dissoudre la guilde' })
    await expect(go).toHaveAttribute('aria-disabled', 'true')
    await dialog(page).getByLabel('Tape le nom de la guilde pour confirmer').fill(name)
    await expect(go).not.toHaveAttribute('aria-disabled', 'true')
    await go.click()
    await expect(toastOf(page, 'Guilde dissoute.')).toBeVisible()
    await expect(page).toHaveURL(/\/admin\/guilds$/)
    await expect(search).toBeFocused()
    await expect(page.getByRole('heading', { name })).toHaveCount(0)
    expect(sql(`select count(*) from public.guilds where id = :'g'`, { g: gid })).toBe('0')
    expect(sql(`select count(*) from public.notifications where type = 'guild_kicked' and user_id = any(string_to_array(:'u', ',')::uuid[])`, { u: [lead.uid, m1.uid, m2.uid].join(',') })).toBe('3')
  } finally {
    sql(`delete from public.guilds where id = :'g' or leader_id = :'l'`, { g: gid || randomUUID(), l: lead.uid })
    wipe(staff.uid, lead.uid, m1.uid, m2.uid)
  }
})

test('guildes : un modérateur ne voit pas « Dissoudre la guilde »', async ({ page }) => {
  const mod = await asStaff(page, 'moderator')
  const lead = makePlayer()
  let gid = ''
  try {
    gid = makeGuild(lead, [], `Zq${randomUUID().replaceAll('-', '').slice(0, 14)}`)
    await page.goto(`/admin/guilds?guild=${gid}`)
    await expect(page.getByRole('log', { name: 'Messages de la guilde' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Dissoudre la guilde' })).toHaveCount(0)
  } finally {
    sql(`delete from public.guilds where leader_id = :'l'`, { l: lead.uid })
    wipe(mod.uid, lead.uid)
  }
})

test('lectures en échec : cartes (fiche), cartes retirées, guildes (recherche et fiche) → « Réessayer »', async ({ page }) => {
  const staff = await asStaff(page)
  const lead = makePlayer()
  const title = `Zz carte lecture ${randomUUID().slice(-12)} z`
  const name = `Zq${randomUUID().replaceAll('-', '').slice(0, 14)}`
  let card = ''
  let gid = ''
  try {
    card = newCard(title)
    gid = makeGuild(lead, [], name)
    for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
      await routeOnce(page, '**/api/admin/removals*', (r) => r.fulfill(reply))
      await page.goto('/admin/cards')
      await expect(page.getByText('Les cartes retirées n\'ont pas pu être chargées.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('heading', { name: 'Cartes retirées' }), label).toBeFocused()

      await routeOnce(page, '**/api/admin/cards/*', (r) => r.fulfill(reply))
      await page.goto(`/admin/cards?card=${card}`)
      await expect(page.getByText('La fiche n\'a pas pu être chargée.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('heading', { name: title, level: 2 }), label).toBeFocused()

      await page.goto('/admin/guilds')
      await routeOnce(page, '**/api/admin/guilds*', (r) => r.fulfill(reply))
      await page.getByRole('searchbox', { name: 'Rechercher une guilde' }).fill(name)
      await page.getByRole('searchbox', { name: 'Rechercher une guilde' }).press('Enter')
      await expect(page.getByText('La recherche n\'a pas abouti.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('heading', { name: 'Résultats' }), label).toBeFocused()

      await routeOnce(page, '**/api/admin/guilds/*', (r) => r.fulfill(reply))
      await page.goto(`/admin/guilds?guild=${gid}`)
      await expect(page.getByText('La fiche n\'a pas pu être chargée.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('heading', { name }), label).toBeFocused()
    }
  } finally {
    dropCard(card)
    sql(`delete from public.guilds where leader_id = :'l'`, { l: lead.uid })
    wipe(staff.uid, lead.uid)
  }
})

test('360 px : aucun défilement horizontal (nom de guilde de 40 caractères sans espace), cibles de 44 px', async ({ page }) => {
  const staff = await asStaff(page)
  const lead = makePlayer()
  const name = `Zq${'W'.repeat(38)}`
  const title = `Zz${'M'.repeat(40)}${randomUUID().slice(-8)}`
  let gid = ''
  let card = ''
  try {
    gid = makeGuild(lead, [], name)
    card = newCard(title, true)
    sql(`insert into wm.card_removals (card_id, reason) values (:'c', :'r')`, { c: card, r: 'y'.repeat(100) })
    sql(`insert into public.guild_chat_messages (guild_id, user_id, content) values (:'g', :'u', :'m')`, { g: gid, u: lead.uid, m: 'm'.repeat(900) })
    await page.setViewportSize({ width: 360, height: 740 })
    const fits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
    }
    const targets = async (scope: Locator) => {
      for (const b of await scope.getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
    }
    await page.goto(`/admin/guilds?guild=${gid}`)
    await expect(page.getByRole('heading', { name })).toBeVisible()
    await fits()
    await targets(page.locator('main'))
    await page.getByRole('button', { name: 'Dissoudre la guilde' }).click()
    await expect(dialog(page)).toBeVisible()
    await fits()
    expect(await dialog(page).evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true)
    await targets(dialog(page))
    await page.keyboard.press('Escape')
    await page.goto(`/admin/cards?card=${card}`)
    await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible()
    await expect(page.getByRole('table', { name: 'Cartes retirées' })).toBeVisible()
    await fits()
    await targets(page.locator('main'))
  } finally {
    dropCard(card)
    sql(`delete from public.guilds where leader_id = :'l'`, { l: lead.uid })
    wipe(staff.uid, lead.uid)
  }
})
