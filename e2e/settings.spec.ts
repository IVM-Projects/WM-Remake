import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Locator, Page, Request, Route } from '@playwright/test'
import { brand } from '../lib/brand.ts'
import { befriend, cookieFor, expect, makePlayer, routeOnce, sql, test } from './fixtures'
import { UNSURE as UNSURE_TEXT } from '../lib/api.ts'
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
  for (const h of ['Profil', 'Préférences', 'Compte', 'Mes données', 'Supprimer mon compte']) await expect(page.getByRole('heading', { name: h, exact: true })).toBeVisible()
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

test('préférences : un enregistrement refusé revient en arrière, une lecture en échec se réessaie, une réponse perdue relit la valeur', async ({ page, login }) => {
  const { uid } = await login()
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

  // 500 après l'enregistrement (réponse perdue) : issue inconnue, dite comme telle (B12), et la case prend la valeur relue.
  await page.route('**/api/settings/preferences', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fetch()
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
  })
  await sounds.click()
  await expect(section.getByRole('alert')).toHaveText(UNSURE)
  await expect(sounds).not.toBeChecked()
  expect(sql(`select sounds from wm.user_prefs where user_id = :'uid'`, { uid })).toBe('f')
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

test('push : « Bloquer » à l\'invite → l\'état bloqué (le texte en role="status", plus de bouton), aucune alerte, le focus sur le titre', async ({ page, login }) => {
  trash.push((await login()).uid)
  await stubPush(page, { answer: 'denied' })
  const subs = record(page, 'POST', SUBSCRIBE)
  await openPush(page)
  await toggle(page, 'Messages', true)
  await activate(page).click()
  await expect(push(page).getByRole('status')).toHaveText('Les notifications sont bloquées pour ce site : autorise-les dans les réglages de ton navigateur.')
  await expect(push(page).getByRole('button')).toHaveCount(0)
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeFocused()
  expect(subs).toHaveLength(0)
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

  test('« Se déconnecter », le désabonnement du navigateur en échec : le DELETE de E part quand même, avant /login, plus de ligne pour E', async ({ page, login }) => {
    trash.push((await login()).uid)
    const endpoint = shared()
    await stubPush(page, { endpoint, unsubscribeFails: true })
    await openPush(page)
    await expect(push(page).getByRole('status')).toHaveText(ACTIVE)
    const order: string[] = []
    page.on('request', (r) => { if (is('DELETE', SUBSCRIBE)(r)) order.push(`DELETE ${r.postDataJSON().endpoint}`) })
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

const EXPORT = '/api/settings/export'
const DELETE = '/api/settings/delete-account'
const MIN_TARGET = 44 - 0.01
const exportButton = (page: Page) => page.getByRole('button', { name: 'Télécharger mes données' })
const deleteButton = (page: Page) => page.getByRole('button', { name: 'Supprimer mon compte' })

test('export : fichier téléchargé, toast, seconde demande ralentie, échecs 500 et 200 illisible', async ({ page, login }) => {
  const { uid, username } = await login()
  try {
    await page.goto('/settings')
    await expect(pseudo(page)).toHaveValue(username)
    // Échecs d'abord (la première réponse réelle consomme la limite de débit).
    for (const reply of [{ status: 500 }, { status: 200, body: 'x' }]) {
      await routeOnce(page, `**${EXPORT}`, (r) => r.fulfill(reply))
      await exportButton(page).click()
      await expect(page.locator('main').getByRole('alert').filter({ hasText: 'L\'export n\'a pas pu être préparé, réessaie.' })).toBeVisible()
    }
    const download = page.waitForEvent('download')
    await exportButton(page).click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(new RegExp(`^${brand.name.toLowerCase()}-export-\\d{4}-\\d{2}-\\d{2}\\.json$`))
    const body = JSON.parse(readFileSync((await file.path())!, 'utf8')) as { format: string; profile?: { username?: string } }
    expect(body.format).toBe('export-compte')
    expect(JSON.stringify(body)).toContain(username)
    await expect(page.getByRole('status').filter({ hasText: 'Export téléchargé.' })).toBeVisible()
    await exportButton(page).click()
    await expect(page.locator('main').getByRole('alert')).toContainText('Le site demande de ralentir')
  } finally {
    sql(`delete from auth.users where id = :'uid'`, { uid })
  }
})

test('suppression : confirmation par le pseudo, modale annulée sans effet, 500 → incertain', async ({ page, login }) => {
  const { uid, username } = await login()
  try {
    await page.goto('/settings')
    await expect(pseudo(page)).toHaveValue(username)
    const consequences = page.locator('section', { has: page.getByRole('heading', { name: 'Supprimer mon compte', exact: true }) }).getByRole('listitem')
    await expect(consequences.filter({ hasText: 'Tes batailles commencées sont perdues, celles qui n\'ont pas commencé sont annulées.' })).toHaveCount(1)
    await expect(consequences.filter({ hasText: 'si tu en es le seul membre, elle est dissoute.' })).toHaveCount(1)
    await deleteButton(page).click()
    const dialog = page.getByRole('dialog', { name: 'Supprimer ton compte ?' })
    const confirm = dialog.getByRole('button', { name: 'Supprimer définitivement' })
    await expect(confirm).toHaveAttribute('aria-disabled', 'true')
    await dialog.getByRole('button', { name: 'Annuler' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(deleteButton(page)).toBeFocused()
    expect(sql(`select username from public.profiles where id = :'uid'`, { uid })).toBe(username)

    await deleteButton(page).click()
    await dialog.getByLabel('Tape ton pseudo pour confirmer').fill(` ${username.toUpperCase()} `)
    await expect(confirm).not.toHaveAttribute('aria-disabled', 'true')
    await routeOnce(page, `**${DELETE}`, async (r) => { await r.fetch(); await r.fulfill({ status: 500 }) })
    await confirm.click()
    await expect(dialog.getByRole('alert')).toHaveText(UNSURE_TEXT)
    await expect(dialog.getByLabel('Tape ton pseudo pour confirmer')).toBeFocused()
    await expect(page).toHaveURL(/\/settings$/)
  } finally {
    sql(`select set_config('wm.allow_tombstone_delete', 'on', false);
delete from auth.users where id = :'uid'`, { uid })
  }
})

test('suppression de bout en bout : tombe, enchère annulée, mise remboursée, ami voit « Joueur supprimé », ancien cookie refusé', async ({ page, login, browser, baseURL }) => {
  const me = await login({ humanVerified: true })
  const [bidder, friend] = [makePlayer({ balance: 500, humanVerified: true }), makePlayer()]
  const title = `Zz suppression e2e ${randomUUID().slice(-12)} z`
  let card: string | undefined
  try {
    card = sql(`select tests.image_card(:'t')`, { t: title })
    const auction = sql(`select from wm.grant_copy(:'s', :'card', true) \\g /dev/null
select wm.create_auction(:'s', :'card', 100, 60) ->> 'id' as id \\gset
select wm.place_bid(:'b', :'id', 150) \\g /dev/null
select :'id'`, { s: me.uid, card, b: bidder.uid })
    befriend(me, friend)
    sql(`insert into public.chat_messages (sender_id, recipient_id, content) values (:'f', :'m', 'bonjour')`, { f: friend.uid, m: me.uid })
    await page.goto('/settings')
    await expect(pseudo(page)).toHaveValue(me.username)
    await deleteButton(page).click()
    const dialog = page.getByRole('dialog', { name: 'Supprimer ton compte ?' })
    await expect(dialog.getByRole('button', { name: 'Supprimer définitivement' })).toHaveAttribute('aria-disabled', 'true')
    await dialog.getByLabel('Tape ton pseudo pour confirmer').fill(me.username)
    await dialog.getByLabel('Tape ton pseudo pour confirmer').press('Enter')
    await expect(page).toHaveURL(/\/login$/)

    expect(sql(`select username from public.profiles where id = :'u'`, { u: me.uid })).toMatch(/^Joueur supprimé /)
    expect(sql(`select auth_done_at is not null from wm.deleted_accounts where user_id = :'u'`, { u: me.uid })).toBe('t')
    expect(sql(`select status from public.auctions where id = :'a'`, { a: auction })).toBe('cancelled')
    expect(sql(`select wikibidous_balance from public.profiles where id = :'b'`, { b: bidder.uid })).toBe('500')
    expect(sql(`select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(wm.check_invariants()) v where v ->> 'user_id' in (:'a', :'b', :'c')`,
      { a: me.uid, b: bidder.uid, c: friend.uid })).toBe('[]')

    const ctx = await browser.newContext()
    try {
      await ctx.addCookies([{ ...cookieFor(friend), url: baseURL! }])
      const fp = await ctx.newPage()
      await fp.goto('/dms')
      await fp.locator('main [data-ready]').waitFor()
      await expect(fp.getByRole('list', { name: 'Conversations' }).getByRole('link').filter({ hasText: 'Joueur supprimé' })).toBeVisible()
    } finally {
      await ctx.close()
    }
    const old = await browser.newContext()
    try {
      await old.addCookies([{ ...cookieFor(me), url: baseURL! }])
      expect((await old.request.get(`${baseURL}/api/my-collection`)).status()).toBe(401)
    } finally {
      await old.close()
    }
  } finally {
    sql(`select set_config('wm.allow_tombstone_delete', 'on', false);
delete from public.auctions where card_id = :'card'::uuid;
delete from auth.users where id = any(string_to_array(:'ids', ',')::uuid[]);
delete from public.cards where id = :'card'::uuid`, { card: card ?? randomUUID(), ids: [me.uid, bidder.uid, friend.uid].join(',') })
  }
})

test('mes données et suppression à 360 px : aucun défilement horizontal, boutons de 44 px', async ({ page, login }) => {
  const { uid, username } = await login()
  try {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/settings')
    await expect(pseudo(page)).toHaveValue(username)
    for (const b of [exportButton(page), deleteButton(page)]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
    await deleteButton(page).click()
    const dialog = page.getByRole('dialog')
    for (const n of ['Supprimer définitivement', 'Annuler']) expect((await dialog.getByRole('button', { name: n }).boundingBox())!.height).toBeGreaterThanOrEqual(MIN_TARGET)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally {
    sql(`delete from auth.users where id = :'uid'`, { uid })
  }
})
