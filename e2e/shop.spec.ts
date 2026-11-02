import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (achats, grand livre et notifications suivent en cascade).
const trash: string[] = []
test.afterEach(() => void sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') }))

const balance = (page: Page) => page.locator('header button[title="Ouvrir la boutique"]')
const shop = (page: Page) => page.getByRole('dialog', { name: 'Boutique' })
const toasts = (page: Page) => page.locator('#wm-toasts')
const hex = () => randomUUID().replaceAll('-', '')
const PRO_409 = 'Tu as déjà un abonnement Pro : gère-le depuis les paramètres.'
const MAINTENANCE = 'Maintenance en cours, reviens dans quelques minutes.'

// Une page factice tient lieu de Checkout : aucune requête ne part vers Stripe depuis le navigateur.
const fakeStripe = (page: Page) => page.route('https://checkout.stripe.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Checkout</title>' }))

test('en-tête : solde du joueur ; clic → la modale, focus dedans ; Échap → focus rendu au solde', async ({ page, login }) => {
  trash.push((await login({ balance: 120 })).uid)
  await page.goto('/pulls')
  await expect(balance(page)).toHaveText('120 wikibidous')
  await expect(balance(page)).toHaveAttribute('aria-haspopup', 'dialog')
  await balance(page).click()
  await expect(shop(page)).toBeVisible()
  await expect(shop(page).getByRole('heading', { name: 'Boutique' })).toBeVisible()
  await expect.poll(() => shop(page).evaluate((d) => d.contains(document.activeElement))).toBe(true)
  // Tab reste dans le dialogue : jamais sur la page derrière.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await shop(page).evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(shop(page)).toBeHidden()
  await expect(balance(page)).toBeFocused()
  // Fermeture par le bouton.
  await balance(page).click()
  await shop(page).getByRole('button', { name: 'Fermer la boutique' }).click()
  await expect(shop(page)).toBeHidden()
  await expect(balance(page)).toBeFocused()
})

test('« Acheter » : une requête avec sa clé, puis la page Checkout de Stripe', async ({ page, login }) => {
  trash.push((await login({ balance: 5 })).uid)
  await fakeStripe(page)
  await page.goto('/pulls')
  await balance(page).click()
  const sent = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/stripe/checkout')
  await shop(page).getByRole('button', { name: /^Acheter 2.500 wikibidous pour 4,99.CAD$/ }).click()
  const req = await sent
  expect(req.postDataJSON()).toEqual({ item: 'wb_2500' })
  expect(req.headers()['idempotency-key']).toMatch(/^[0-9a-f-]{32,36}$/)
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_bench_/)
})

test('« S\'abonner » : 409 forcé → l\'alerte exacte ; 503 maintenance → son message ; un clic en vol ne part qu\'une fois', async ({ page, login }) => {
  trash.push((await login()).uid)
  await page.goto('/pulls')
  await balance(page).click()
  const subscribe = shop(page).getByRole('button', { name: /^S'abonner à Pro pour 9,99.CAD par mois$/ })
  await routeOnce(page, '**/api/stripe/checkout', (r) => r.fulfill({
    status: 409, contentType: 'application/json', body: JSON.stringify({ status: 409, code: 'already_subscribed', error: PRO_409, message: PRO_409 }),
  }))
  await subscribe.click()
  await expect(shop(page).getByRole('alert')).toHaveText(PRO_409)
  await expect(subscribe).not.toHaveAttribute('aria-disabled', 'true')
  await routeOnce(page, '**/api/stripe/checkout', (r) => r.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ status: 503, code: 'maintenance', error: MAINTENANCE, message: MAINTENANCE }),
  }))
  await subscribe.click()
  await expect(shop(page).getByRole('alert')).toHaveText(MAINTENANCE)
  // Un 502 sans corps lisible : le repli.
  await routeOnce(page, '**/api/stripe/checkout', (r) => r.fulfill({ status: 502, body: 'bad gateway' }))
  await subscribe.click()
  await expect(shop(page).getByRole('alert')).toHaveText('Le paiement n\'a pas pu démarrer.')
  // Double clic : une seule requête.
  await fakeStripe(page)
  let posts = 0
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/stripe/checkout') posts++ })
  await subscribe.dblclick()
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_bench_/)
  expect(posts).toBe(1)
})

test('une URL qui n\'est pas celle de Stripe n\'est jamais suivie', async ({ page, login }) => {
  trash.push((await login()).uid)
  await page.goto('/pulls')
  await balance(page).click()
  await routeOnce(page, '**/api/stripe/checkout', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://example.com/pay' }) }))
  await shop(page).getByRole('button', { name: /^Acheter/ }).click()
  await expect(shop(page).getByRole('alert')).toHaveText('Le paiement n\'a pas pu démarrer.')
  await expect(page).toHaveURL(/\/pulls$/)
})

// Achat posé comme le ferait le webhook (G18) : la ligne d'achat et son crédit en une seule instruction, invariants intacts.
const credit = (uid: string, session: string) => sql(`with p as (
  insert into wm.purchases (session_id, user_id, item, amount, currency, wb) values (:'s', :'u', 'wb_2500', 499, 'cad', 2500) returning user_id
) select wm.wallet_apply(:'u', 2500, 'stripe', 'stripe:' || :'s') from p`, { u: uid, s: session })
const violations = (uid: string) => sql(`select count(*) from jsonb_array_elements(wm.check_invariants()) e where e ->> 'user_id' = :'u'`, { u: uid })

test('retour de Checkout : confirmation attendue du serveur, toast, solde relu, adresse nettoyée', async ({ page, login }) => {
  const { uid } = await login({ balance: 100 })
  trash.push(uid)
  const session = `cs_test_bench_${hex()}`
  await page.goto(`/pulls?shop=success&session=${session}`)
  // L'adresse n'accorde rien : tant que le serveur ne voit aucun achat, l'attente continue.
  await expect(page.getByRole('status').filter({ hasText: 'Paiement reçu, confirmation en cours…' })).toBeVisible()
  await expect(balance(page)).toHaveText('100 wikibidous')
  await page.waitForTimeout(3000)
  expect(page.url()).toContain('shop=success')
  credit(uid, session)
  await expect(toasts(page)).toContainText('2 500 wikibidous crédités.')
  await expect(balance(page)).toHaveText('2 600 wikibidous')
  await expect(page).toHaveURL(/\/pulls$/)
  await expect(page.getByText('Paiement reçu, confirmation en cours…')).toHaveCount(0)
  expect(violations(uid)).toBe('0')
})

test('retour de Checkout sans achat : après 30 s, « en cours de confirmation », l\'attente s\'arrête', async ({ page, login }) => {
  trash.push((await login({ balance: 100 })).uid)
  await page.clock.install()
  let reads = 0
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/shop' && r.url().includes('session=')) reads++ })
  await page.goto(`/pulls?shop=success&session=cs_test_bench_${hex()}`)
  await expect(page.getByRole('status').filter({ hasText: 'Paiement reçu, confirmation en cours…' })).toBeVisible()
  await page.clock.fastForward(31_000)
  await expect(toasts(page)).toContainText('Ton paiement est en cours de confirmation : il apparaîtra d\'ici quelques minutes.')
  await expect(page).toHaveURL(/\/pulls$/)
  await expect(page.getByText('Paiement reçu, confirmation en cours…')).toHaveCount(0)
  // Plus aucune sonde une fois l'échéance passée.
  const done = reads
  await page.clock.fastForward(20_000)
  expect(reads).toBe(done)
})

test('retour de Checkout, abonnement : « Bienvenue chez les membres Pro ! » une fois Pro vu par le serveur', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  const session = `cs_test_bench_${hex()}`
  await page.goto(`/pulls?shop=success&session=${session}`)
  await expect(page.getByRole('status').filter({ hasText: 'Paiement reçu, confirmation en cours…' })).toBeVisible()
  // Abonnement actif, Pro dérivé (G4), achat pro_monthly de la session : comme après les événements du webhook.
  sql(`update public.profiles set is_pro = true where id = :'u';
insert into wm.stripe_customers (customer_id, user_id) values ('cus_bench_' || :'h', :'u');
insert into wm.subscriptions (id, user_id, customer_id, status, event_created) values ('sub_bench_' || :'h', :'u', 'cus_bench_' || :'h', 'active', now());
insert into wm.purchases (session_id, user_id, item, amount, currency, wb) values (:'s', :'u', 'pro_monthly', 999, 'cad', 0)`, { u: uid, s: session, h: hex() })
  await expect(toasts(page)).toContainText('Bienvenue chez les membres Pro !', { timeout: 10_000 })
  await expect(page.locator('header').getByText('PRO', { exact: true })).toBeVisible()
  expect(violations(uid)).toBe('0')
})

test('retour annulé : la boutique s\'ouvre sur « Paiement annulé : rien n\'a été débité. », adresse nettoyée', async ({ page, login }) => {
  trash.push((await login()).uid)
  await page.goto('/pulls?shop=cancel')
  await expect(shop(page)).toBeVisible()
  await expect(shop(page).getByRole('status').filter({ hasText: 'Paiement annulé : rien n\'a été débité.' })).toBeVisible()
  await expect(page).toHaveURL(/\/pulls$/)
  await page.keyboard.press('Escape')
  await expect(shop(page)).toBeHidden()
})

for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
  test(`lecture en échec (${label}) : « — » dans l'en-tête, « Réessayer » dans la modale, puis tout rentre dans l'ordre`, async ({ page, login }) => {
    trash.push((await login({ balance: 120 })).uid)
    await routeOnce(page, '**/api/shop*', (r) => r.fulfill(reply))
    await page.goto('/pulls')
    await expect(balance(page)).toHaveText('—Solde indisponible')
    await balance(page).click()
    await expect(shop(page).getByRole('alert')).toBeVisible()
    await shop(page).getByRole('button', { name: 'Réessayer' }).click()
    await expect(shop(page).getByRole('button', { name: /^Acheter/ })).toBeVisible()
    await expect(balance(page)).toHaveText('120 wikibidous')
  })
}

test('« Chargement de la boutique… » pendant une lecture retenue', async ({ page, login }) => {
  trash.push((await login({ balance: 120 })).uid)
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/shop*', async (r) => { await held; await r.continue() })
  await page.goto('/pulls?shop=cancel')
  await expect(shop(page).getByRole('status').filter({ hasText: 'Chargement de la boutique…' })).toBeAttached()
  await expect(balance(page)).toHaveCount(0)
  release()
  await expect(shop(page).getByRole('button', { name: /^Acheter/ })).toBeVisible()
  await expect(balance(page)).toHaveText('120 wikibidous')
})

test('compte Pro de fixture « carol » sans abonnement : pastille PRO, l\'offre reste visible', async ({ page, login }) => {
  trash.push((await login({ pro: true, username: `carol_${hex().slice(0, 8)}` })).uid)
  await page.goto('/pulls')
  await expect(balance(page)).toBeVisible()
  await expect(page.locator('header').getByText('PRO', { exact: true })).toBeVisible()
  await balance(page).click()
  await expect(shop(page).getByRole('button', { name: /^S'abonner/ })).toBeVisible()
  await expect(shop(page).getByText('Tu es membre Pro.')).toHaveCount(0)
  await expect(shop(page).getByText('Avantages Pro accordés par l\'équipe.')).toHaveCount(0)
})

test('Pro accordé par l\'équipe (VIP) : la mention, aucun bouton d\'abonnement', async ({ page, login }) => {
  const { uid } = await login()
  trash.push(uid)
  sql(`update public.profiles set is_vip = true where id = :'u'`, { u: uid })
  await page.goto('/pulls')
  await balance(page).click()
  await expect(shop(page).getByText('Avantages Pro accordés par l\'équipe.')).toBeVisible()
  await expect(shop(page).getByRole('button', { name: /S'abonner/ })).toHaveCount(0)
  await expect(page.locator('header').getByText('PRO', { exact: true })).toBeVisible()
})

// La maintenance est un réglage global de la base partagée par les workers : on ne la bascule pas, la réponse de la lecture la dit.
const inMaintenance = (page: Page) => page.route('**/api/shop*', async (r) => {
  const res = await r.fetch()
  await r.fulfill({ response: res, json: { ...(await res.json()), maintenance: true } })
})

test('maintenance : la boutique est fermée, les deux achats sont inactifs et ne partent pas', async ({ page, login }) => {
  trash.push((await login()).uid)
  await inMaintenance(page)
  await page.goto('/pulls')
  await balance(page).click()
  await expect(shop(page).getByRole('status').filter({ hasText: 'La boutique est fermée pendant la maintenance.' })).toBeVisible()
  let posts = 0
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/stripe/checkout') posts++ })
  for (const name of [/^S'abonner/, /^Acheter/]) {
    const b = shop(page).getByRole('button', { name })
    await expect(b).toHaveAttribute('aria-disabled', 'true')
    await b.click({ force: true })
  }
  expect(posts).toBe(0)
})

test('360 px : en-tête sans défilement horizontal (solde à 5 chiffres et PRO), modale lisible', async ({ page, login }) => {
  trash.push((await login({ pro: true, balance: 99_999 })).uid)
  await page.setViewportSize({ width: 360, height: 640 })
  await page.goto('/pulls')
  await expect(balance(page)).toHaveText('99 999 wikibidous')
  const overflow = () => page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    header: (() => { const h = document.querySelector('header')!; return h.scrollWidth - h.clientWidth })(),
  }))
  expect(await overflow()).toEqual({ page: 0, header: 0 })
  const bell = await page.locator('button[aria-label="Notifications"]').boundingBox()
  // Le contenu de l'en-tête reste dans sa marge de 16 px.
  expect(bell!.x + bell!.width).toBeLessThanOrEqual(360 - 16)
  await balance(page).click()
  await expect(shop(page)).toBeVisible()
  const box = await shop(page).boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(360)
  expect(await shop(page).evaluate((d) => d.scrollWidth - d.clientWidth)).toBe(0)
  // Défilement interne : le dernier achat s'atteint.
  await shop(page).getByRole('button', { name: /^Acheter/ }).scrollIntoViewIfNeeded()
  await expect(shop(page).getByRole('button', { name: /^Acheter/ })).toBeVisible()
})
