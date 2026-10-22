import { randomUUID } from 'node:crypto'
import type { Page, Route } from '@playwright/test'
import { expect, makePlayer, sql, test } from './fixtures'

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
