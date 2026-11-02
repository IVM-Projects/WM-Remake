import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { cookieFor, expect, makePlayer, makeStaff, routeOnce, sql, test } from './fixtures'

// Espace admin (Task 15) : garde serveur, tableau de bord, journal. Chaque test crée son staff et ses lignes, supprimés dans un finally.
const MIN_TARGET = 44 - 0.01
const h1 = (page: Page) => page.locator('main h1').filter({ visible: true })
const wipe = (...ids: string[]) => sql(`delete from auth.users where id = any(string_to_array(:'u', ',')::uuid[])`, { u: ids.join(',') })
const unlog = (...ids: string[]) => sql(`delete from wm.staff_actions where target_id = any(string_to_array(:'t', ','))`, { t: ids.join(',') })

async function asStaff(page: Page, role: 'admin' | 'moderator' = 'admin') {
  const u = makeStaff(role)
  await page.context().addCookies([{ ...cookieFor(u), url: page.url().startsWith('http') ? page.url() : 'http://127.0.0.1:3100' }])
  return u
}
const seed = (target: string, n = 1, type = 'user') => sql(`insert into wm.staff_actions (staff_id, action, target_type, target_id, reason)
select null, 'image_auto_hide', :'type', :'t', 'lot de test' from generate_series(1, :'n'::int)`, { t: target, n: String(n), type })

test('un joueur : 404 sur /admin, /admin/audit et /admin/users, sans titre « Administration » ni lien au pied', async ({ page, login }) => {
  await login()
  for (const path of ['/admin', '/admin/audit', '/admin/users']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible()
    await expect(page).not.toHaveTitle(/^Administration — /)
    await expect(page).not.toHaveTitle(/^Journal des actions — /)
  }
  const me = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/me')
  await page.goto('/leaderboard')
  expect(await (await me).json()).toEqual({ role: null })
  await page.locator('main [data-ready]').waitFor()
  await expect(page.getByRole('link', { name: 'Administration', exact: true })).toHaveCount(0)
})

test('sans session : /login?next=%2Fadmin', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/)
})

test('un admin : h1, lien au pied, AdminNav avec « Tableau de bord » courant ; modérateur : son rôle', async ({ page }) => {
  const u = await asStaff(page)
  const m = makeStaff('moderator')
  try {
    await page.goto('/admin')
    await page.locator('main [data-ready]').waitFor()
    await expect(h1(page)).toHaveText('Administration')
    await expect(page).toHaveTitle(/^Administration — /)
    const nav = page.getByRole('navigation', { name: 'Administration' })
    await expect(nav.getByRole('link')).toHaveText(['Tableau de bord', 'Signalements', 'Joueurs', 'Cartes', 'Guildes', 'Journal'])
    await expect(nav.getByRole('link', { name: 'Tableau de bord' })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText('Rôle : administrateur', { exact: true })).toBeVisible()
    await expect(page.locator('footer').getByRole('link', { name: 'Administration', exact: true })).toBeVisible()
    await expect(page.locator('nav.hidden a')).toHaveCount(13)
    await page.context().clearCookies()
    await page.context().addCookies([{ ...cookieFor(m), url: page.url() }])
    await page.reload()
    await expect(page.getByText('Rôle : modérateur', { exact: true })).toBeVisible()
  } finally {
    wipe(u.uid, m.uid)
  }
})

test('un staff sous suspension : 404', async ({ page }) => {
  const u = await asStaff(page)
  try {
    sql(`insert into wm.sanctions (user_id, kind, ends_at, reason, created_by) values (:'u', 'suspension', now() + interval '1 hour', 'test', :'u')`, { u: u.uid })
    await page.goto('/admin')
    await expect(page.getByRole('heading', { name: 'Page introuvable' })).toBeVisible()
  } finally {
    wipe(u.uid)
  }
})

test('tableau de bord : un compteur distinct par tuile (lecture réelle), « Suppressions GoTrue en attente » absente à 0, présente à 2', async ({ page }) => {
  const u = await asStaff(page)
  const rep = makeStaff('moderator')
  const tag = randomUUID().slice(-8)
  let cards: string[] = []
  try {
    cards = sql(`select string_agg(tests.image_card('Zz dash ' || :'tag' || ' ' || i || ' z')::text, ',') from generate_series(1, 10) i`, { tag }).split(',')
    const ids = (from: number, to: number) => cards.slice(from, to).join(',')
    const ARR = `string_to_array(:'x', ',')::uuid[]`
    // +1 signalement, +2 images signalées, +3 masquées d'office, +4 sanctions actives, +5 cartes retirées
    sql(`insert into public.reports (reporter_id, reported_user_id, reason) values (:'a', :'b', (enum_range(null::public.report_reason))[1])`, { a: rep.uid, b: u.uid })
    sql(`insert into wm.card_image_reports (card_id, user_id) select unnest(${ARR}), :'a'`, { x: ids(0, 2), a: rep.uid })
    sql(`update public.cards set hide_image = true where id = any(${ARR});
insert into wm.staff_actions (staff_id, action, target_type, target_id, reason) select null, 'image_auto_hide', 'card', c::text, 'seuil' from unnest(${ARR}) c`, { x: ids(2, 5) })
    sql(`insert into wm.sanctions (user_id, kind) select :'a', 'warning' from generate_series(1, 4)`, { a: rep.uid })
    sql(`insert into wm.card_removals (card_id, reason) select unnest(${ARR}), 'test'`, { x: ids(5, 10) })
    const d = JSON.parse(sql(`select wm.staff_dashboard(:'u')`, { u: u.uid })) as Record<string, number>
    let pending = 0
    // Seuls auth_pending et la santé sont posés : le reste est la lecture réelle.
    await page.route('**/api/admin/dashboard', async (r) => {
      const real = await (await r.fetch()).json()
      await r.fulfill({ json: { ...real, auth_pending: pending, health: { settle_lag_s: 3, overdue_s: null, push_lag_s: 1200, quiz: { queued: 4, oldest_s: 70 } } } })
    })
    await page.goto('/admin')
    await page.locator('main [data-ready]').waitFor()
    const tile = (label: string) => page.getByRole('listitem').filter({ has: page.getByRole('link', { name: label, exact: true }) })
    const n = (v: number) => new Intl.NumberFormat('fr-FR').format(v)
    for (const [label, key] of [['Signalements à traiter', 'open_reports'], ['Images signalées', 'image_reports'], ['Images masquées d\'office', 'auto_hidden_cards'],
      ['Sanctions actives', 'active_sanctions'], ['Cartes retirées', 'removed_cards']] as const) {
      await expect(tile(label).locator('p').first(), label).toHaveText(n(d[key]))
    }
    await expect(page.getByRole('link', { name: 'Suppressions GoTrue en attente' })).toHaveCount(0)
    await expect(page.getByText('non mesuré', { exact: true })).toBeVisible()
    await expect(page.getByText('4 en attente', { exact: false })).toBeVisible()
    pending = 2
    await page.reload()
    await expect(tile('Suppressions GoTrue en attente')).toContainText('2')
    await expect(page.getByText('Resynchroniser depuis la fiche du joueur')).toBeVisible()
  } finally {
    const x = cards.join(',')
    if (x) {
      sql(`delete from wm.card_removals where card_id = any(string_to_array(:'x', ',')::uuid[])`, { x })
      unlog(...cards)
      sql(`delete from public.cards where id = any(string_to_array(:'x', ',')::uuid[])`, { x })
    }
    wipe(u.uid, rep.uid)
  }
})

test('tableau de bord : 500 et 200 illisible → échec et « Réessayer »', async ({ page }) => {
  const u = await asStaff(page)
  try {
    for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
      await routeOnce(page, '**/api/admin/dashboard', (r) => r.fulfill(reply))
      await page.goto('/admin')
      await expect(page.getByText('Le tableau de bord n\'a pas pu être chargé.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('heading', { name: 'Santé' }), label).toBeVisible()
      await expect(h1(page)).toBeFocused()
    }
  } finally {
    wipe(u.uid)
  }
})

test('journal : trois actions des fonctions wm.admin_*, la plus récente d\'abord ; filtre Carte ; Système', async ({ page }) => {
  const u = await asStaff(page)
  const target = makeStaff('moderator') // cible quelconque (joueur)
  const title = `Zz audit e2e ${randomUUID().slice(-12)} z`
  let card = ''
  try {
    card = sql(`select tests.image_card(:'t')`, { t: title })
    const as = (q: string) => sql(q, { a: u.uid, t: target.uid, c: card })
    as(`select wm.admin_sanction(:'a', :'t', 'warning', null, 'premier motif')`)
    as(`select wm.admin_auth_sync(:'a', :'t', 'second motif')`)
    as(`select wm.admin_achievements_recheck(:'a', :'t', 'troisième motif')`)
    as(`select wm.admin_card_flags(:'a', :'c', true, false, 'motif carte')`)
    seed(target.uid)
    await page.goto('/admin/audit')
    await expect(h1(page)).toHaveText('Journal des actions')
    await page.getByLabel('Identifiant de cible').fill(target.uid)
    await page.getByLabel('Identifiant de cible').press('Enter')
    const rows = page.getByRole('table').getByRole('row')
    await expect(rows).toHaveCount(5) // en-tête + Système + trois actions
    await expect(rows.nth(1)).toContainText('Système')
    await expect(rows.nth(1)).toContainText('Image masquée d\'office')
    await expect(rows.nth(2)).toContainText('Check rouvert')
    await expect(rows.nth(2)).toContainText('troisième motif')
    await expect(rows.nth(2)).toContainText(u.username)
    await expect(rows.nth(3)).toContainText('Session resynchronisée')
    await expect(rows.nth(4)).toContainText('Sanction')
    // Entrée sans rien changer : le tableau reste, jamais « Chargement » (data-ready gardé).
    await page.getByLabel('Identifiant de cible').press('Enter')
    await page.getByLabel('Identifiant de cible').press('Enter')
    await expect(rows).toHaveCount(5)
    await expect(page.locator('main [data-ready]')).toBeVisible()
    // Le champ montre toujours le filtre actif : le changement de type applique le brouillon.
    const reads: string[] = []
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/admin/audit') reads.push(r.url()) })
    await page.getByLabel('Type de cible').selectOption({ label: 'Carte' })
    await expect(page.getByText('Aucune action enregistrée.')).toBeVisible()
    await expect(page.getByLabel('Identifiant de cible')).toHaveValue(target.uid)
    expect(reads.at(-1)).toContain(`target_id=${target.uid}`)
    await page.getByLabel('Identifiant de cible').fill(card)
    await page.getByLabel('Identifiant de cible').press('Enter')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(1)).toContainText('Drapeaux d\'image')
    await expect(rows.nth(1)).toContainText('Carte ' + card)
  } finally {
    unlog(target.uid, card)
    if (card) sql(`delete from public.cards where id = :'c'`, { c: card })
    wipe(u.uid, target.uid)
  }
})

test('journal : Entrée sur un champ vide ou inchangé garde l\'écran lu', async ({ page }) => {
  const u = await asStaff(page)
  try {
    seed(u.uid)
    await page.goto('/admin/audit')
    await page.locator('main [data-ready]').waitFor()
    await page.getByLabel('Identifiant de cible').press('Enter')
    await expect(page.getByRole('table')).toBeVisible()
    await expect(page.locator('main [data-ready]')).toBeVisible()
    await page.getByLabel('Identifiant de cible').fill(randomUUID())
    await page.getByLabel('Identifiant de cible').press('Enter')
    await expect(page.getByText('Aucune action enregistrée.')).toBeVisible()
    await page.getByLabel('Identifiant de cible').press('Enter')
    await expect(page.getByText('Aucune action enregistrée.')).toBeVisible()
    await expect(page.locator('main [data-ready]')).toBeVisible()
    await expect(page.getByRole('status')).toHaveCount(0)
  } finally {
    unlog(u.uid)
    wipe(u.uid)
  }
})

test('journal : 51 actions → Suivant, page 2 d\'une ligne', async ({ page }) => {
  const u = await asStaff(page)
  const t = randomUUID()
  try {
    seed(t, 51)
    await page.goto('/admin/audit')
    await page.getByLabel('Identifiant de cible').fill(t)
    await page.getByLabel('Identifiant de cible').press('Enter')
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(51)
    await page.getByRole('button', { name: /Suivant/ }).click()
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(2)
    await expect(page.getByText('Page 2', { exact: true })).toBeVisible()
    await expect(page.getByRole('table').locator('caption')).toBeFocused()
  } finally {
    unlog(t)
    wipe(u.uid)
  }
})

test('journal : 500 et 200 illisible → échec, « Réessayer », caption focalisée', async ({ page }) => {
  const u = await asStaff(page)
  try {
    seed(u.uid)
    for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
      await routeOnce(page, '**/api/admin/audit*', (r) => r.fulfill(reply))
      await page.goto('/admin/audit')
      await expect(page.getByText('Le journal n\'a pas pu être chargé.'), label).toBeVisible()
      await page.getByRole('button', { name: 'Réessayer' }).click()
      await expect(page.getByRole('table').locator('caption'), label).toBeFocused()
    }
  } finally {
    unlog(u.uid)
    wipe(u.uid)
  }
})

test('360 px : aucun défilement horizontal, liens et champs de 44 px', async ({ page }) => {
  const u = await asStaff(page)
  const t = randomUUID()
  try {
    seed(t, 3)
    await page.setViewportSize({ width: 360, height: 740 })
    for (const path of ['/admin', '/admin/audit']) {
      await page.goto(path)
      await page.locator('main [data-ready]').waitFor()
      if (path === '/admin/audit') {
        await page.getByLabel('Identifiant de cible').fill(t)
        await page.getByLabel('Identifiant de cible').press('Enter')
        await expect(page.getByRole('table')).toBeVisible()
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
      for (const l of await page.getByRole('navigation', { name: 'Administration' }).getByRole('link').all()) {
        expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
      }
    }
  } finally {
    unlog(t)
    wipe(u.uid)
  }
})

// Régression (Vercel, M6a) : le client à clé secrète lit Date.now() à sa création ; sans `await connection()` avant, Next journalise
// « unstable value » à chaque rendu de l'admin. Le journal de next start (contract/harness.ts) ne doit en contenir aucun.
test('pages de l’admin : aucun « unstable value » au journal du serveur', async ({ page }) => {
  const u = await asStaff(page)
  try {
    for (const path of ['/admin', '/admin/reports', '/admin/users', '/admin/cards', '/admin/guilds', '/admin/audit']) {
      await page.goto(path)
      await page.locator('main [data-ready]').waitFor()
    }
    const log = readFileSync(new URL('../.cache/logs/next-plain.log', import.meta.url), 'utf8')
    expect(log.split('\n').filter((l) => l.includes('unstable value'))).toEqual([])
  } finally {
    wipe(u.uid)
  }
})

// Stripe au tableau de bord (Task 11) : litiges ouverts et résiliations en attente. Les compteurs sont ceux de la base partagée :
// on ne compare que `>=`, et les lignes sont celles du test.
const stripeWipe = (users: string[], dispute: string) => sql(`delete from wm.stripe_disputes where id = :'d';
select set_config('wm.allow_tombstone_delete', 'on', false);
delete from auth.users where id = any(string_to_array(:'u', ',')::uuid[])`, { d: dispute, u: users.join(',') })
// Joueur Pro dont le compte supprimé garde un abonnement `sub_bench_fail_…` (la passerelle du banc refuse sa résiliation), et un litige ouvert.
function seedStripe() {
  const h = randomUUID().replaceAll('-', '')
  const d = makePlayer({ pro: true })
  const ids = { fail: `sub_bench_fail_${h}`, ok: `sub_bench_ok_${h}`, dispute: `dp_bench_${h}` }
  return { d, h, ...ids }
}
type Seed = ReturnType<typeof seedStripe>
const subscribe = (s: Seed, id: string, status: string) => sql(`insert into wm.subscriptions (id, user_id, customer_id, status, event_created)
values (:'id', :'u', 'cus_bench_' || :'h', :'s', now())`, { id, u: s.d.uid, h: s.h, s: status })
function tombstone(s: Seed) {
  subscribe(s, s.fail, 'active')
  sql(`insert into wm.deleted_accounts (user_id, auth_done_at) values (:'u', now())`, { u: s.d.uid })
  sql(`insert into wm.stripe_disputes (id, charge_id, amount, currency, reason, status, created_at, event_created)
values (:'d', 'ch_bench_' || :'h', 1250, 'cad', 'fraudulent', 'needs_response', now(), now())`, { d: s.dispute, h: s.h })
}
const tileCount = async (page: Page, label: string) => {
  const tile = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: label, exact: true }) })
  return Number((await tile.locator('p').first().innerText()).replace(/\s/g, ''))
}

test('tableau de bord : tuiles et listes Stripe ; « Résilier » échoue chez Stripe (toast), puis réussit et la ligne disparaît', async ({ page }) => {
  const boss = await asStaff(page)
  const s = seedStripe()
  try {
    tombstone(s)
    await page.goto('/admin')
    await page.locator('main [data-ready]').waitFor()
    expect(await tileCount(page, 'Litiges Stripe ouverts')).toBeGreaterThanOrEqual(1)
    expect(await tileCount(page, 'Résiliations Stripe en attente')).toBeGreaterThanOrEqual(1)

    const dispute = page.getByRole('listitem').filter({ hasText: s.dispute })
    await expect(dispute).toContainText(/12,50\s*CAD/)
    await expect(dispute).toContainText('fraudulent')
    const stripeLink = dispute.getByRole('link', { name: /^Voir dans Stripe/ })
    await expect(stripeLink).toHaveAttribute('href', `https://dashboard.stripe.com/test/disputes/${s.dispute}`)
    await expect(stripeLink).toHaveAttribute('target', '_blank')
    await expect(stripeLink).toHaveAttribute('rel', 'noopener noreferrer')

    const row = page.getByRole('listitem').filter({ hasText: s.d.username })
    await expect(row.getByRole('button', { name: /^Résilier/ })).toBeVisible()
    const dialog = page.getByRole('dialog', { name: 'Résilier l\'abonnement ?' })
    const cancel = async () => {
      await row.getByRole('button', { name: /^Résilier/ }).click()
      await expect(dialog.getByText('L\'abonnement Stripe de ce compte supprimé est résilié tout de suite, sans remboursement.', { exact: true })).toBeVisible()
      await dialog.getByLabel('Motif').fill('Résiliation à rejouer')
      await dialog.getByRole('button', { name: 'Résilier', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    }
    const toasts = page.locator('#wm-toasts')
    await cancel()
    await expect(toasts.getByText('La résiliation a échoué chez Stripe : réessaie plus tard.', { exact: true })).toBeVisible()
    await expect(row).toBeVisible()
    await expect(row.getByRole('button', { name: /^Résilier/ })).toBeFocused()

    // Le Stripe en panne rétabli : la ligne échouée passée à canceled, un abonnement qui se résilie.
    sql(`update wm.subscriptions set status = 'canceled' where id = :'s'`, { s: s.fail })
    subscribe(s, s.ok, 'active')
    await cancel()
    await expect(toasts.getByText('Abonnement résilié.', { exact: true })).toBeVisible()
    await expect(row).toHaveCount(0)
    await expect(h1(page)).toBeFocused()
    expect(sql(`select stripe_pending from wm.deleted_accounts where user_id = :'u'`, { u: s.d.uid })).toBe('f')
  } finally {
    unlog(s.d.uid)
    stripeWipe([s.d.uid, boss.uid], s.dispute)
  }
})

test('tableau de bord : un modérateur voit les files Stripe mais pas « Résilier »', async ({ page }) => {
  const mod = await asStaff(page, 'moderator')
  const s = seedStripe()
  try {
    tombstone(s)
    await page.goto('/admin')
    await page.locator('main [data-ready]').waitFor()
    await expect(page.getByText('Rôle : modérateur', { exact: true })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: s.d.username })).toBeVisible()
    await expect(page.getByRole('listitem').filter({ hasText: s.dispute })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Résilier/ })).toHaveCount(0)
    // 360 px : rien ne déborde, le lien vers Stripe garde sa cible de 44 px.
    await page.setViewportSize({ width: 360, height: 800 })
    expect((await page.getByRole('listitem').filter({ hasText: s.dispute }).getByRole('link', { name: /^Voir dans Stripe/ }).boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    stripeWipe([s.d.uid, mod.uid], s.dispute)
  }
})

test('tableau de bord : sans litige ni résiliation en attente, ni tuile ni liste Stripe (réponse posée)', async ({ page }) => {
  const u = await asStaff(page)
  try {
    await page.route('**/api/admin/dashboard', async (r) => {
      const real = await (await r.fetch()).json()
      await r.fulfill({ json: { ...real, stripe_disputes_open: 0, stripe_disputes: [], stripe_pending: 0, stripe_pending_users: [] } })
    })
    await page.goto('/admin')
    await page.locator('main [data-ready]').waitFor()
    await expect(page.getByRole('link', { name: 'Litiges Stripe ouverts' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Résiliations Stripe en attente' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Litiges Stripe' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Comptes supprimés à résilier' })).toHaveCount(0)
  } finally {
    wipe(u.uid)
  }
})
