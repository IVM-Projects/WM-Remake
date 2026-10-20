import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, makePlayer, sql, test } from './fixtures'

const fresh = (prefix: string) => `${prefix}_${randomUUID().slice(-12)}`
const pseudo = (page: Page) => page.getByLabel('Pseudo', { exact: true })
const savePseudo = (page: Page) => page.getByRole('button', { name: 'Enregistrer le pseudo' })
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
  await page.route('**/api/settings/preferences', (route) => (route.request().method() === 'GET' ? route.abort() : route.fallback()))
  await page.goto('/settings')
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Préférences' }) })
  await expect(section.getByRole('alert')).toHaveText('Tes préférences n\'ont pas pu être chargées.')
  await page.unroute('**/api/settings/preferences')
  await section.getByRole('button', { name: 'Réessayer' }).click()
  const sounds = page.getByRole('checkbox', { name: 'Sons', exact: true })
  await expect(sounds).toBeChecked()
  await expect(page.locator('body')).not.toBeFocused()

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
