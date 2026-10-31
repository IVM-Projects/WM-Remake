import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import { cookieFor, expect, makePlayer, makeStaff, routeOnce, sql, test } from './fixtures'

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
