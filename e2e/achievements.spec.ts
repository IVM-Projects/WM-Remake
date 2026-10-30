import type { Page, Request } from '@playwright/test'
import { expect, giveCopies, hydrated, routeOnce, sql, test } from './fixtures'

// Cible de 44 px à 0,01 près (battle.spec.ts).
const MIN_TARGET = 44 - 0.01
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'
const CATEGORIES = ['Cartes et rareté', 'Collection', 'Combat', 'Échanges', 'Enchères']
const h1 = (page: Page) => page.locator('main h1').filter({ visible: true })
const toasts = (page: Page) => page.locator('#wm-toasts')
const checks = (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/achievements/check'
// Le succès « Débutant » (50 cartes, 10 wikibidous) : l'id est md5('wm-ach:cards_50')::uuid.
const DEBUTANT = `md5('wm-ach:cards_50')::uuid`
const item = (page: Page, title: string) => page.getByRole('listitem').filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) })

async function open(page: Page) {
  await page.goto('/achievements')
  await page.locator('main [data-ready]').waitFor()
}
// Joueur qui a 50 cartes : « Débutant » est débloqué par le check de l'ouverture.
async function openWithCards(page: Page, login: () => Promise<{ uid: string; username: string }>) {
  const me = await login()
  giveCopies(me, 'C', 50)
  const sent = page.waitForRequest(checks)
  await page.goto('/achievements')
  await sent
  await expect(item(page, 'Débutant').getByRole('button', { name: 'Réclamer' })).toBeVisible()
  return me
}

test('h1, titre, cinq catégories dans l\'ordre, 51 succès, « Légendaire ! » verrouillé', async ({ page, login }) => {
  await login()
  await open(page)
  await expect(h1(page)).toHaveText('Succès')
  await expect(page).toHaveTitle(/^Succès — /)
  await expect(page.locator('main h2')).toHaveText(CATEGORIES)
  await expect(page.locator('main h3')).toHaveCount(51)
  await expect(item(page, 'Légendaire !')).toContainText('Verrouillé')
  await expect(page.locator('main')).toContainText('0 / 51 succès débloqués')
  await expect(page.locator('main')).not.toContainText('Cette section arrive bientôt.')
})

test('le check part une fois ; revenir dans les 5 min n\'en envoie pas un second ; un 429 n\'affiche rien', async ({ page, login }) => {
  await login()
  await page.setViewportSize({ width: 1280, height: 800 })
  let sent = 0
  page.on('request', (r) => { if (checks(r)) sent++ })
  await routeOnce(page, '**/api/achievements/check', (r) => r.fulfill({ status: 429, json: { error: 'Trop de demandes', message: 'Trop de demandes', retry_after: 300 } }))
  const first = page.waitForRequest(checks)
  await open(page)
  await first
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  await expect(toasts(page)).toHaveCount(0)
  // Navigation client vers une autre page puis retour : Activity remonte la page, la fenêtre de 5 min tient.
  const link = page.locator('nav.hidden a[href="/battle"]')
  await hydrated(link)
  await link.click()
  await expect(page).toHaveURL(/\/battle/)
  await page.locator('nav.hidden a[href="/achievements"]').click()
  await expect(page).toHaveURL('/achievements')
  await expect(h1(page)).toHaveText('Succès')
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)))
  expect(sent).toBe(1)
})

test('Review Focus, réclamation : clavier, toast, « Réclamé le … » focalisé, solde + 10 et une seule ligne ach:<id>', async ({ page, login }) => {
  const me = await openWithCards(page, login)
  await expect(page.locator('main')).toContainText('à réclamer')
  const before = Number(sql(`select wikibidous_balance from public.profiles where id = :'u'`, { u: me.uid }))
  const btn = item(page, 'Débutant').getByRole('button', { name: 'Réclamer' })
  await expect(btn).toHaveAccessibleDescription('Débutant')
  await btn.focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Débutant : +10 wikibidous')
  const done = item(page, 'Débutant').getByText(/^Réclamé le /)
  await expect(done).toBeVisible()
  await expect(done).toBeFocused()
  expect(Number(sql(`select wikibidous_balance from public.profiles where id = :'u'`, { u: me.uid }))).toBe(before + 10)
  expect(sql(`select count(*) from wm.wb_ledger where user_id = :'u' and ref = 'ach:' || ${DEBUTANT}`, { u: me.uid })).toBe('1')
})

test('issue incertaine : UNSURE, la relecture montre « Réclamé le … » ; la même clé rejouée → { ok: true }, une seule ligne', async ({ page, login }) => {
  const me = await openWithCards(page, login)
  let key = ''
  await routeOnce(page, '**/api/achievements/claim', async (r) => {
    key = r.request().headers()['idempotency-key']
    await r.fetch()
    await r.fulfill({ status: 500 })
  })
  await item(page, 'Débutant').getByRole('button', { name: 'Réclamer' }).click()
  await expect(item(page, 'Débutant').getByRole('alert')).toHaveText(UNSURE)
  await expect(item(page, 'Débutant').getByText(/^Réclamé le /)).toBeVisible()
  expect(key).not.toBe('')
  const id = sql(`select ${DEBUTANT}`)
  const res = await page.request.post('/api/achievements/claim', { headers: { 'Idempotency-Key': key }, data: { achievement_id: id } })
  expect(await res.json()).toEqual({ ok: true })
  expect(sql(`select count(*) from wm.wb_ledger where user_id = :'u' and ref = 'ach:' || :'id'`, { u: me.uid, id })).toBe('1')
})

test('refus forcé 409 : l\'alerte est sur la ligne, avec le texte du serveur', async ({ page, login }) => {
  await openWithCards(page, login)
  await routeOnce(page, '**/api/achievements/claim', (r) => r.fulfill({ status: 409, json: { error: 'Ce succès a déjà été réclamé', message: 'Ce succès a déjà été réclamé' } }))
  await item(page, 'Débutant').getByRole('button', { name: 'Réclamer' }).click()
  await expect(item(page, 'Débutant').getByRole('alert')).toHaveText('Ce succès a déjà été réclamé')
  await expect(item(page, 'Débutant').getByRole('button', { name: 'Réclamer' })).toBeVisible()
})

for (const url of ['**/rest/v1/achievements*', '**/rest/v1/user_achievements*']) {
  test(`lecture en échec (${url}) : LoadError, data-ready ; « Réessayer » → la liste, h1 focalisé`, async ({ page, login }) => {
    await login()
    await routeOnce(page, url, (r) => r.fulfill({ status: 500, json: { message: 'boom' } }))
    await page.goto('/achievements')
    await page.locator('main [data-ready]').waitFor()
    await expect(page.locator('main').getByRole('alert')).toContainText('Impossible de charger cette page.')
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await expect(page.locator('main h3')).toHaveCount(51)
    await expect(h1(page)).toBeFocused()
  })
}

test('360 px : aucun défilement horizontal ; « Réclamer » de 44 px', async ({ page, login }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await openWithCards(page, login)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const box = await item(page, 'Débutant').getByRole('button', { name: 'Réclamer' }).boundingBox()
  expect(box!.height).toBeGreaterThanOrEqual(MIN_TARGET)
  expect(box!.width).toBeGreaterThanOrEqual(MIN_TARGET)
})
