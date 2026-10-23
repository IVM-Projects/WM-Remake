import { randomUUID } from 'node:crypto'
import type { Locator, Page, Request, Route } from '@playwright/test'
import { expect, makePlayer, routeOnce, sql, test } from './fixtures'
import { stubPush } from './push-stub'

const fresh = (prefix: string) => `${prefix}_${randomUUID().slice(-12)}`
const pseudo = (page: Page) => page.getByLabel('Pseudo', { exact: true })
const savePseudo = (page: Page) => page.getByRole('button', { name: 'Enregistrer le pseudo' })
// Laisse la page traiter une réponse déjà reçue (promesse, rendu React) avant de vérifier qu'elle n'a rien changé.
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))))
const prefsSaved = (page: Page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings/preferences' && r.request().method() === 'POST')

test('pseudo : un changement vers un pseudo libre réussit, le second est refusé pendant 30 jours', async ({ page, login }) => {
  const { uid, username } = await login()
  await page.goto('/settings')
  await expect(page.locator('main h1')).toHaveText('Paramètres')
  await expect(page.getByRole('tab', { name: 'Général' })).toHaveAttribute('aria-selected', 'true')
  for (const h of ['Profil', 'Préférences', 'Compte']) await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible()
  await expect(pseudo(page)).toHaveValue(username)
  // Inchangé : rien à enregistrer.
  await expect(savePseudo(page)).toBeDisabled()

  const next = fresh('n')
  await pseudo(page).fill(next)
  await savePseudo(page).click()
  await expect(page.getByRole('status').filter({ hasText: 'Pseudo modifié.' })).toBeVisible()
  expect(sql(`select username from public.profiles where id = :'uid'`, { uid })).toBe(next)
  await expect(savePseudo(page)).toBeFocused()

  await pseudo(page).fill(fresh('m'))
  await savePseudo(page).click()
  await expect(page.locator('main').getByRole('alert')).toContainText('Un seul changement de pseudo tous les 30 jours.')
  await expect(pseudo(page)).toHaveAttribute('aria-invalid', 'true')
  // Entrer puis sortir du champ sans rien taper : la pré-vérification (pseudo libre) n'efface pas le refus du serveur.
  await pseudo(page).focus()
  const checked = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/username-available')
  await pseudo(page).blur()
  expect(await (await checked).json()).toEqual({ available: true })
  await settle(page)
  await expect(page.locator('main').getByRole('alert')).toContainText('Un seul changement de pseudo tous les 30 jours.')
  expect(sql(`select username from public.profiles where id = :'uid'`, { uid })).toBe(next)
})

test('pseudo : pré-vérification au départ du champ, sautée pour la seule casse du sien', async ({ page, login }) => {
  const { uid, username } = await login()
  const other = makePlayer()
  await page.goto('/settings')
  await expect(pseudo(page)).toHaveValue(username)
  const checks: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/username-available') checks.push(new URL(r.url()).searchParams.get('u')!) })

  // Pseudo d'un autre : refusé avant l'envoi.
  await pseudo(page).fill(other.username.toUpperCase())
  await pseudo(page).blur()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Ce pseudo est déjà pris')
  expect(checks).toEqual([other.username.toUpperCase()])

  // Sa propre casse : la route anonyme le dirait pris, aucune pré-vérification, le serveur accepte.
  await pseudo(page).fill(username.toUpperCase())
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  await pseudo(page).blur()
  await savePseudo(page).click()
  await expect(page.getByRole('status').filter({ hasText: 'Pseudo modifié.' })).toBeVisible()
  expect(checks).toEqual([other.username.toUpperCase()])
  expect(sql(`select username from public.profiles where id = :'uid'`, { uid })).toBe(username.toUpperCase())
})

test('préférences : images sensibles, sons et profil public enregistrés', async ({ page, login }) => {
  const { uid } = await login()
  await page.goto('/settings')
  const hide = page.getByRole('checkbox', { name: 'Masquer les images sensibles', exact: true })
  const sounds = page.getByRole('checkbox', { name: 'Sons', exact: true })
  const pub = page.getByRole('checkbox', { name: 'Profil public', exact: true })
  await expect(hide).toBeChecked()
  let saved = prefsSaved(page)
  await hide.uncheck()
  expect((await saved).ok()).toBe(true)
  await page.reload()
  await expect(hide).not.toBeChecked()

  for (const box of [sounds, pub]) {
    await expect(box).toBeChecked()
    saved = prefsSaved(page)
    await box.uncheck()
    expect((await saved).ok()).toBe(true)
  }
  const row = () => sql(`select u.sounds, u.hide_sensitive, p.is_public from wm.user_prefs u join public.profiles p on p.id = u.user_id where u.user_id = :'uid'`, { uid })
  expect(row()).toBe('f|f|f')
  saved = prefsSaved(page)
  await sounds.check()
  expect((await saved).ok()).toBe(true)
  expect(row()).toBe('t|f|f')
})

test('préférences : un enregistrement refusé revient en arrière, une lecture en échec se réessaie', async ({ page, login }) => {
  await login()
  // Routes désarmées par phase, jamais retirées : un unroute enverrait Fetch.disable (routeOnce).
  let phase = 1
  await page.route('**/api/settings/preferences', (route) => (phase === 1 && route.request().method() === 'GET' ? route.abort() : route.fallback()))
  await page.goto('/settings')
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Préférences' }) })
  await expect(section.getByRole('alert')).toHaveText('Tes préférences n\'ont pas pu être chargées.')
  phase = 2
  await section.getByRole('button', { name: 'Réessayer' }).click()
  const sounds = page.getByRole('checkbox', { name: 'Sons', exact: true })
  await expect(sounds).toBeChecked()
  await expect(page.getByRole('heading', { name: 'Préférences', exact: true })).toBeFocused()

  // 200, mais le serveur garde l'autre valeur : pas de « Préférence enregistrée. », la case revient, l'erreur est dite.
  await page.route('**/api/settings/preferences', (route) => (phase === 2 && route.request().method() === 'POST'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sounds: true, hide_sensitive: true, is_public: true }) })
    : route.fallback()))
  await sounds.click()
  await expect(section.getByRole('alert')).toHaveText('Ta préférence n\'a pas pu être enregistrée.')
  await expect(sounds).toBeChecked()
  await expect(section.getByRole('status')).toHaveText('')
  phase = 3

  await page.route('**/api/settings/preferences', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }) : route.fallback())
  // click et non uncheck : la case revient cochée, uncheck() échouerait sur ce retour.
  await sounds.click()
  await expect(section.getByRole('alert')).toHaveText('Ta préférence n\'a pas pu être enregistrée.')
  await expect(sounds).toBeChecked()
})

test('mot de passe : le nouveau permet de se reconnecter ; « Se déconnecter » mène à /login', async ({ page, login }) => {
  const { uid } = await login()
  await page.goto('/settings')
  const change = page.getByRole('button', { name: 'Changer le mot de passe' })
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('nouveau-mdp-e2e')
  await page.getByLabel('Confirme le nouveau mot de passe').fill('autre-mdp-e2e')
  await change.click()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Les deux mots de passe ne correspondent pas.')

  await page.getByLabel('Confirme le nouveau mot de passe').fill('nouveau-mdp-e2e')
  await change.click()
  await expect(page.getByRole('status').filter({ hasText: 'Mot de passe modifié.' })).toBeVisible()
  await expect(page.getByLabel('Nouveau mot de passe', { exact: true })).toHaveValue('')

  await page.getByRole('button', { name: 'Se déconnecter' }).click()
  await expect(page).toHaveURL('/login')
  await page.goto('/settings')
  await expect(page).toHaveURL('/login?next=%2Fsettings')

  await page.goto('/login')
  await page.getByLabel('Adresse courriel').fill(`${uid}@test.local`)
  await page.getByLabel('Mot de passe', { exact: true }).fill('nouveau-mdp-e2e')
  await page.getByRole('button', { name: 'Se connecter' }).click()
  await expect(page).toHaveURL('/pulls')
})

test('préférences : une relecture partie pendant un enregistrement ne l\'écrase pas en revenant après lui', async ({ page, login }) => {
  await login()
  await page.goto('/settings')
  const sounds = page.getByRole('checkbox', { name: 'Sons', exact: true })
  await expect(sounds).toBeChecked()
  const held: { POST?: Route; GET?: Route } = {}
  await page.route('**/api/settings/preferences', (route) => { held[route.request().method() as 'POST' | 'GET'] = route })
  await sounds.click()
  await expect.poll(() => !!held.POST).toBe(true)
  // Page quittée puis rouverte (Activity) pendant l'enregistrement : la relecture part avant sa fin.
  await page.locator('nav.hidden').getByRole('link', { name: 'Paquets' }).click()
  await expect(page).toHaveURL('/pulls')
  await page.locator('nav.hidden').getByRole('link', { name: 'Paramètres' }).click()
  await expect(page).toHaveURL('/settings')
  await expect.poll(() => !!held.GET).toBe(true)
  await held.POST!.continue()
  await expect(page.getByRole('status').filter({ hasText: 'Préférence enregistrée.' })).toBeVisible()
  await expect(sounds).not.toBeChecked()
  // La relecture revient ensuite avec l'ancienne valeur.
  const stale = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/settings/preferences' && r.request().method() === 'GET')
  await held.GET!.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sounds: true, hide_sensitive: true, is_public: true }) })
  await (await stale).finished()
  await settle(page)
  await expect(sounds).not.toBeChecked()
})

test.describe('avant l\'hydratation (JavaScript coupé)', () => {
  test.use({ javaScriptEnabled: false })
  test('mot de passe : jamais envoyé nativement, donc jamais dans une adresse', async ({ page, login }) => {
    await login()
    const urls: string[] = []
    page.on('request', (r) => urls.push(r.url()))
    await page.goto('/settings')
    await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('fuite-mdp-e2e')
    await page.getByLabel('Confirme le nouveau mot de passe').fill('fuite-mdp-e2e')
    // Une absence ne se prouve qu'avec une borne : un envoi natif (GET ou POST, mot de passe dans l'adresse ou le corps)
    // partirait aussitôt après Entrée ; JavaScript coupé, aucune autre requête n'est attendue.
    const sent = page.waitForRequest(() => true, { timeout: 2000 }).catch(() => null)
    await page.getByLabel('Confirme le nouveau mot de passe').press('Enter')
    expect((await sent)?.url() ?? null).toBeNull()
    expect(urls.filter((u) => u.includes('settings-password'))).toEqual([])
    await expect(page.getByRole('button', { name: 'Changer le mot de passe' })).toBeDisabled()
    await expect(page).toHaveURL('/settings')
  })
})

// Section « Notifications » (Task 14) : familles en opt-in (M4b-13, B17), abonnement de l'appareil (B18), push simulé (B19).
const trash: string[] = []
test.afterEach(() => void sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') }))
const PREFS = '/api/settings/notifications'
const SUBSCRIBE = '/api/push/subscribe'
const FAMILIES = ['Messages', 'Échanges', 'Amis', 'Marché']
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'
const ACTIVE = 'Notifications activées sur cet appareil.'
const FAILED = 'L\'activation a échoué, réessaie.'
const push = (page: Page) => page.locator('section[aria-labelledby="settings-notifications"]')
const family = (page: Page, name: string) => push(page).getByRole('checkbox', { name, exact: true })
const activate = (page: Page) => push(page).getByRole('button', { name: 'Activer sur cet appareil' })
const deactivate = (page: Page) => push(page).getByRole('button', { name: 'Désactiver sur cet appareil' })
const is = (method: string, path: string) => (r: Request) => r.method() === method && new URL(r.url()).pathname === path
const onBody = (page: Page) => page.evaluate(() => document.activeElement === document.body)
const pushTypes = (uid: string) => sql(`select push_types from wm.notification_prefs where user_id = :'uid'`, { uid })
const rows = (endpoint: string) => sql(`select user_id from public.push_subscriptions where endpoint = :'endpoint'`, { endpoint })
// Requêtes d'une méthode et d'un chemin, dans l'ordre d'envoi.
function record(page: Page, method: string, path: string): Request[] {
  const seen: Request[] = []
  page.on('request', (r) => { if (is(method, path)(r)) seen.push(r) })
  return seen
}
async function openPush(page: Page) {
  await page.goto('/settings')
  await push(page).and(page.locator('[data-ready]')).waitFor()
}
async function big(target: Locator) {
  const box = (await target.boundingBox())!
  expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
}
// Une case cochée ou décochée : le POST de la liste entière, attendu jusqu'à sa réponse.
async function toggle(page: Page, name: string, on: boolean): Promise<unknown> {
  const sent = page.waitForResponse((r) => is('POST', PREFS)(r.request()))
  await (on ? family(page, name).check() : family(page, name).uncheck())
  return (await sent).request().postDataJSON()
}

test('push : quatre familles décochées, « Activer » inactif ; « Messages » puis « Activer » → un abonnement, aucune préférence de plus ; « Désactiver » → DELETE ; cibles ≥ 44 px', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  const endpoint = await stubPush(page)
  const subs = record(page, 'POST', SUBSCRIBE)
  const prefs = record(page, 'POST', PREFS)
  await openPush(page)
  await expect(push(page).getByRole('heading')).toHaveText('Notifications')
  await expect(push(page)).toContainText('Ces choix valent pour tous tes appareils.')
  for (const f of FAMILIES) await expect(family(page, f)).not.toBeChecked()
  await expect(activate(page)).toHaveAttribute('aria-disabled', 'true')
  await expect(activate(page)).toHaveAccessibleDescription('Coche d\'abord au moins une famille.')
  // Inactif : Entrée n'abonne rien (compté à la fin : un seul POST, celui du clic qui suit « Messages »).
  await activate(page).focus()
  await page.keyboard.press('Enter')

  expect(await toggle(page, 'Messages', true)).toEqual({ push_types: ['chat_message'] })
  await expect(activate(page)).not.toHaveAttribute('aria-disabled')
  await activate(page).click()
  await expect(push(page).getByRole('status')).toHaveText(ACTIVE)
  await expect(deactivate(page)).toBeFocused()
  expect(subs.map((r) => r.postDataJSON().endpoint)).toEqual([endpoint])
  expect(prefs).toHaveLength(1)
  for (const f of FAMILIES) await (f === 'Messages' ? expect(family(page, f)).toBeChecked() : expect(family(page, f)).not.toBeChecked())
  expect(pushTypes(uid)).toBe('{chat_message}')
  expect(rows(endpoint)).toBe(uid)
  await big(deactivate(page))
  for (const label of await push(page).locator('label').all()) await big(label)
  await expect(push(page).locator('label')).toHaveCount(4)

  const removed = page.waitForRequest(is('DELETE', SUBSCRIBE))
  await deactivate(page).click()
  expect((await removed).postDataJSON()).toEqual({ endpoint })
  await expect(activate(page)).toBeFocused()
  await expect(push(page).getByRole('status')).toHaveText('')
  await big(activate(page))
  expect(rows(endpoint)).toBe('')
  expect(await onBody(page)).toBe(false)
  expect(subs).toHaveLength(1)
})

test('push : « Marché » écrit ses 5 types en bloc, décoché les retire ; « Échanges » à l\'issue incertaine → le texte du B12, puis la case relue', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  await stubPush(page)
  await openPush(page)
  await toggle(page, 'Messages', true)
  expect(await toggle(page, 'Marché', true)).toEqual({ push_types: ['auction_outbid', 'auction_sold', 'auction_unsold', 'auction_won', 'chat_message', 'wishlist_listed'] })
  await expect(family(page, 'Marché')).toBeChecked()
  expect(await toggle(page, 'Marché', false)).toEqual({ push_types: ['chat_message'] })
  await expect(family(page, 'Marché')).not.toBeChecked()
  expect(pushTypes(uid)).toBe('{chat_message}')

  // Le serveur enregistre, la réponse se perd : l'incertitude dite, puis la liste relue par GET.
  await routeOnce(page, `**${PREFS}`, async (r) => {
    await r.fetch()
    await r.fulfill({ status: 500 })
  }, (r) => r.request().method() === 'POST')
  const reread = page.waitForRequest(is('GET', PREFS))
  await family(page, 'Échanges').check()
  await reread
  await expect(push(page).getByRole('alert')).toHaveText(UNSURE)
  await expect(family(page, 'Échanges')).toBeChecked()
  await expect(family(page, 'Messages')).toBeChecked()
  expect(pushTypes(uid)).toBe('{chat_message,trade_accepted,trade_cancelled,trade_countered,trade_declined,trade_received}')
  expect(await onBody(page)).toBe(false)
})

test('push : deux réponses perdues de suite (« Messages » coché, puis décoché), puis coché de nouveau → une clé neuve, la base suit', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  await stubPush(page)
  await openPush(page)
  const posts = record(page, 'POST', PREFS)
  // Deux POST enregistrés par le serveur, réponses perdues : chaque fois l'incertitude, puis la case relue.
  for (const on of [true, false]) {
    await routeOnce(page, `**${PREFS}`, async (r) => {
      await r.fetch()
      await r.fulfill({ status: 500 })
    }, (r) => r.request().method() === 'POST')
    const reread = page.waitForResponse((r) => is('GET', PREFS)(r.request()))
    await (on ? family(page, 'Messages').check() : family(page, 'Messages').uncheck())
    await reread
    await expect(push(page).getByRole('alert')).toHaveText(UNSURE)
    await (on ? expect(family(page, 'Messages')).toBeChecked() : expect(family(page, 'Messages')).not.toBeChecked())
  }
  // La clé du premier envoi, gardée, rejouerait sa réponse stockée (la case cochée, la base vide).
  expect(await toggle(page, 'Messages', true)).toEqual({ push_types: ['chat_message'] })
  const keys = posts.map((r) => r.headers()['idempotency-key'])
  expect(new Set(keys).size).toBe(3)
  await expect(family(page, 'Messages')).toBeChecked()
  expect(pushTypes(uid)).toBe('{chat_message}')
})

test('push : notifications bloquées → le texte en role="status", aucun bouton d\'activation, aucune alerte ; les familles restent', async ({ page, login }) => {
  trash.push((await login()).uid)
  await stubPush(page, { permission: 'denied' })
  await openPush(page)
  await expect(push(page).getByRole('status')).toHaveText('Les notifications sont bloquées pour ce site : autorise-les dans les réglages de ton navigateur.')
  await expect(push(page).getByRole('button')).toHaveCount(0)
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  for (const f of FAMILIES) await expect(family(page, f)).toBeVisible()
})

test.describe('Review Focus, navigateur partagé', () => {
  // Endpoint E déjà enregistré pour un autre joueur, le navigateur abonné à E.
  const shared = () => {
    const other = makePlayer()
    trash.push(other.uid)
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${randomUUID()}`
    sql(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (:'u', :'e', 'x', 'y')`, { u: other.uid, e: endpoint })
    return endpoint
  }

  test('l\'arrivée sur /settings renvoie l\'abonnement, sans clic ni préférence : E passe au joueur connecté, « activées », familles décochées', async ({ page, login }) => {
    const { uid } = await login()
    trash.push(uid)
    const endpoint = shared()
    await stubPush(page, { endpoint })
    const subs = record(page, 'POST', SUBSCRIBE)
    const prefs = record(page, 'POST', PREFS)
    await openPush(page)
    await expect(push(page).getByRole('status')).toHaveText(ACTIVE)
    for (const f of FAMILIES) await expect(family(page, f)).not.toBeChecked()
    expect(subs.map((r) => r.postDataJSON().endpoint)).toEqual([endpoint])
    expect(prefs).toHaveLength(0)
    expect(rows(endpoint)).toBe(uid)
  })

  test('renvoi en 500 → « L\'activation a échoué, réessaie. » et « Activer sur cet appareil »', async ({ page, login }) => {
    trash.push((await login()).uid)
    const endpoint = shared()
    await stubPush(page, { endpoint })
    const subs = record(page, 'POST', SUBSCRIBE)
    await routeOnce(page, `**${SUBSCRIBE}`, (r) => r.fulfill({ status: 500 }))
    await openPush(page)
    await expect(push(page).getByRole('alert')).toHaveText(FAILED)
    await expect(activate(page)).toBeVisible()
    await expect(push(page).getByRole('status')).toHaveText('')
    // Issue incertaine : « Activer » reprend la même intention, donc la même clé.
    await toggle(page, 'Messages', true)
    await activate(page).click()
    await expect(push(page).getByRole('status')).toHaveText(ACTIVE)
    await expect(deactivate(page)).toBeFocused()
    expect(subs.map((r) => r.headers()['idempotency-key'])).toEqual(Array(2).fill(subs[0].headers()['idempotency-key']))
  })

  test('« Se déconnecter » désabonne l\'appareil : DELETE de E avant /login, plus de ligne pour E', async ({ page, login }) => {
    trash.push((await login()).uid)
    const endpoint = shared()
    await stubPush(page, { endpoint })
    await openPush(page)
    await expect(push(page).getByRole('status')).toHaveText(ACTIVE)
    const order: string[] = []
    page.on('request', (r) => { if (is('DELETE', SUBSCRIBE)(r)) order.push(`DELETE ${r.postDataJSON().endpoint}`) })
    // Une fois : /login peut renaviguer (remplacement d'adresse).
    page.on('framenavigated', (f) => { if (f === page.mainFrame() && new URL(f.url()).pathname === '/login' && !order.includes('/login')) order.push('/login') })
    await page.getByRole('button', { name: 'Se déconnecter' }).click()
    await expect(page).toHaveURL('/login')
    expect(order).toEqual([`DELETE ${endpoint}`, '/login'])
    expect(rows(endpoint)).toBe('')
  })
})

// 500, ou 200 au corps illisible : la section atteint son état d'échec (data-ready posé), les autres restent lues.
for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
  test(`push : lecture en échec (${label}) → alerte et « Réessayer » dans la section, « Profil » et « Préférences » lues ; « Réessayer » → les familles, focus sur le titre`, async ({ page, login }) => {
    trash.push((await login()).uid)
    await stubPush(page)
    await routeOnce(page, `**${PREFS}`, (r) => r.fulfill(reply))
    await openPush(page)
    await expect(push(page).getByRole('alert')).toBeVisible()
    await expect(push(page).getByRole('checkbox')).toHaveCount(0)
    await expect(pseudo(page)).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'Sons', exact: true })).toBeVisible()
    await push(page).getByRole('button', { name: 'Réessayer' }).click()
    for (const f of FAMILIES) await expect(family(page, f)).not.toBeChecked()
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeFocused()
  })
}
