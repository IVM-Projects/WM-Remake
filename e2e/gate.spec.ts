import type { Page } from '@playwright/test'
import { GATE } from '../contract/harness.ts'
import { GATE_COOKIE, gateToken } from '../lib/gate.ts'
import { expect, test } from './fixtures'

// Pile avec porte de contract/serve.ts.
const GATED = 'http://127.0.0.1:3101'

async function submit(page: Page, next: string, password: string) {
  await page.goto(`${GATED}/gate?next=${encodeURIComponent(next)}`)
  await page.getByLabel('Mot de passe de la démo').fill(password)
  await page.getByRole('button', { name: 'Entrer' }).click()
}

test('porte : mauvais mot de passe → alerte, aucun cookie', async ({ page, context }) => {
  await submit(page, '/', 'faux')
  // Dans main : l'annonceur de route de Next porte aussi role=alert.
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Mot de passe incorrect.')
  await expect(page).toHaveURL(`${GATED}/gate?next=%2F`)
  expect((await context.cookies(GATED)).map((c) => c.name)).not.toContain(GATE_COOKIE)
})

test('porte : bon mot de passe → next, cookie httpOnly (non secure sur 127.0.0.1)', async ({ page, context }) => {
  await submit(page, '/', GATE.password)
  await expect(page).toHaveURL(`${GATED}/`)
  await expect(page.getByRole('link', { name: 'Se connecter' })).toBeVisible()
  const cookie = (await context.cookies(GATED)).find((c) => c.name === GATE_COOKIE)
  expect(cookie).toMatchObject({
    value: await gateToken(GATE.secret, GATE.password),
    httpOnly: true,
    secure: false, // actions.ts : secure partout sauf localhost / 127.0.0.1 / [::1]
    sameSite: 'Lax',
    path: '/',
  })
  expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 24 * 3600) // maxAge 30 jours
})

// Sans JS (ou clic avant l'hydratation) : envoi natif du formulaire ; `next` et l'erreur doivent survivre.
test('porte sans JavaScript : erreur affichée, puis bon mot de passe → next', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await submit(page, '/collection', 'faux')
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Mot de passe incorrect.')
  await submit(page, '/', GATE.password)
  await expect(page).toHaveURL(`${GATED}/`)
  expect((await context.cookies(GATED)).map((c) => c.name)).toContain(GATE_COOKIE)
  await context.close()
})

test('porte : next=//evil.example → /pulls (où le proxy sert /login faute de session)', async ({ page }) => {
  const hosts = new Set<string>()
  page.on('request', (r) => void hosts.add(new URL(r.url()).host))
  await submit(page, '//evil.example', GATE.password)
  // safeNext → /pulls. Next suit la redirection de l'action côté serveur (fetch interne, qui traverse le proxy) :
  // l'URL affichée est celle de l'action, le contenu celui de /login ; un rechargement montre le renvoi du proxy.
  await expect(page).toHaveURL(`${GATED}/pulls`)
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText('Connexion')
  await page.reload()
  await expect(page).toHaveURL(`${GATED}/login?next=%2Fpulls`)
  expect([...hosts]).toEqual(['127.0.0.1:3101'])
})
