import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect, hydrated, routeOnce, sql, test } from './fixtures'

const RARITY_LABEL = '(Légendaire|Ultra rare|Super rare|Rare|Peu commune|Commune)'

// Compteur visible « Carte n / N » (texte exact : la région aria-live dit « Carte n / N : … »).
const counter = (page: Page, n: number, total = 5) => page.getByText(`Carte ${n} / ${total}`, { exact: true })
const openButton = (page: Page) => page.getByRole('button', { name: 'Ouvrir', exact: true })
const stockFrame = (page: Page) => page.locator('div.card-frame').filter({ hasText: 'paquets disponibles' })
// Un seul paquet, posé : la dotation de départ est de 10 (1870). Sans date, la première synchro démarre l'horloge.
const onePack = (uid: string) => sql(`update public.profiles set packs_remaining = 1 where id = :'uid'`, { uid })

async function openPack(page: Page) {
  await openButton(page).click()
  await expect(counter(page, 1)).toBeVisible()
}

// Tirage des joueurs Pro réduit aux L le temps de `run` : le catalogue partagé n'est pas touché, les poids sont rendus dans tous les cas.
// Ces tests se suivent dans un seul worker (pas de fullyParallel) ; deux copies en parallèle (--repeat-each) se gêneraient.
// ⚠ Toute ouverture de paquet en Pro doit rester dans ce fichier : ailleurs, elle tirerait des L pendant la surcharge.
async function onlyLegendariesForPro(run: () => Promise<void>) {
  const before = sql(`select value::text from wm.config where key = 'draw_weights'`)
  // Une surcharge restée d'un run interrompu ne doit jamais devenir la valeur « d'origine » rendue en fin de test.
  expect(JSON.parse(before).pro, 'draw_weights.pro est déjà surchargé à {"L": 1}').not.toEqual({ L: 1 })
  sql(`update wm.config set value = jsonb_set(value, '{pro}', '{"L": 1}') where key = 'draw_weights'`)
  try {
    await run()
  } finally {
    sql(`update wm.config set value = :'before'::jsonb where key = 'draw_weights' and value -> 'pro' = '{"L": 1}'::jsonb`, { before })
  }
}

// Réponse réelle de /api/packs/open, réécrite (paquet d'une carte, paquet vide) : aucune donnée partagée modifiée.
async function rewriteOpen(page: Page, edit: (body: { cards: unknown[] }) => void) {
  await page.route('**/api/packs/open', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    edit(body)
    await route.fulfill({ response: res, json: body })
  })
}

test('repos : stock, compte à rebours, barre de 10, Ouvrir, Pro du jour, aide', async ({ page, login }) => {
  onePack((await login()).uid)
  await page.goto('/pulls')
  const frame = stockFrame(page)
  await expect(frame).toContainText('1 / 10')
  await expect(frame).toContainText('Prochain dans')
  const timer = frame.locator('span.font-mono')
  await expect(timer).toHaveText(/^\d+:\d\d$/)
  const first = await timer.textContent()
  await expect(timer).not.toHaveText(first!, { timeout: 2_000 })
  await expect(page.locator('[data-stock-bar] > *')).toHaveCount(10)
  await expect(openButton(page)).toBeEnabled()

  const pro = page.getByRole('region', { name: 'Paquet PRO du jour' })
  await expect(pro).toContainText('Réservé aux membres Pro')
  await expect(pro.getByRole('button', { name: 'Récupérer' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Comment ça marche ?' }).click()
  const help = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(help).toContainText('L ≥ 20 000')
  await expect(help).toContainText('C < 50')
  await expect(help).toContainText('vues par mois')
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden()
})

test('première ouverture → vérification anti-bot → révélation', async ({ page, login }) => {
  onePack((await login()).uid)
  await page.goto('/pulls')
  const checks: string[] = []
  page.on('request', (r) => { if (r.url().endsWith('/api/human-check')) checks.push(r.postData() ?? '') })
  await openPack(page)
  // Sans clé de site (banc), le widget rend 'dev-bypass' tout seul et l'ouverture est relancée une fois.
  expect(checks).toEqual([JSON.stringify({ token: 'dev-bypass' })])

  await expect(page.locator('div.animate-card-flip.relative.touch-none.cursor-grab')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Encore 4 cartes' })).toBeDisabled()
  for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowRight')
  await expect(counter(page, 5)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Encore/ })).toHaveCount(0)
  const done = page.getByRole('button', { name: 'Continuer' })
  await expect(done).toBeEnabled()
  await expect(page.locator('main [aria-live="polite"]')).toHaveText(new RegExp(`^Carte 5 / 5 : .+, ${RARITY_LABEL}`))

  await done.click()
  const recap = page.getByRole('region', { name: 'Récapitulatif' })
  await expect(recap.locator('div[class*="glow-"]')).toHaveCount(5)
  // Premier paquet d'un compte neuf : au moins une première copie.
  await expect(recap.getByText('Nouvelle').first()).toBeVisible()
  await recap.getByRole('button', { name: 'Retour aux paquets' }).click()
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(openButton(page)).toBeDisabled()
})

test('balayage de 80 px → carte suivante, puis précédente', async ({ page, login }) => {
  await login({ humanVerified: true })
  await page.goto('/pulls')
  await openPack(page)
  const box = (await page.locator('div.animate-card-flip').boundingBox())!
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  const swipe = async (dx: number) => {
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y, { steps: 6 })
    await page.mouse.up()
  }
  await swipe(-40)
  await expect(counter(page, 1)).toBeVisible()
  await swipe(-80)
  await expect(counter(page, 2)).toBeVisible()
  await swipe(80)
  await expect(counter(page, 1)).toBeVisible()
})

test('boutons ronds et points', async ({ page, login }) => {
  await login({ humanVerified: true })
  await page.goto('/pulls')
  await openPack(page)
  const prev = page.getByRole('button', { name: 'Carte précédente' })
  const next = page.getByRole('button', { name: 'Carte suivante' })
  await expect(prev).toBeDisabled()
  await expect(prev).toHaveClass(/\bw-12\b.*\bh-12\b.*disabled:opacity-20/)
  const dots = page.getByRole('button', { name: /^Aller à la carte \d$/ })
  await expect(dots).toHaveCount(5)
  await expect(dots.first()).toHaveClass(/\bw-3\b.*\bh-3\b.*scale-125/)
  await next.click()
  await expect(counter(page, 2)).toBeVisible()
  await expect(prev).toBeEnabled()
  await expect(dots.nth(1)).toHaveClass(/scale-125/)
  await expect(page.getByRole('button', { name: 'Encore 3 cartes' })).toBeDisabled()
  await dots.first().click()
  await expect(counter(page, 1)).toBeVisible()
  // Clavier : au bout, le focus passe de « Carte suivante » (désactivé) à « Continuer ».
  await next.focus()
  for (let k = 0; k < 4; k++) await page.keyboard.press('Enter')
  await expect(counter(page, 5)).toBeVisible()
  await expect(next).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continuer' })).toBeFocused()
})

test('parcours au clavier : ouvrir, révéler, récapitulatif, retour sur « Ouvrir »', async ({ page, login }) => {
  const { uid } = await login({ humanVerified: true })
  sql(`update public.profiles set packs_remaining = 2 where id = :'uid'`, { uid })
  await page.goto('/pulls')
  await expect(stockFrame(page)).toContainText('2 / 10')
  await openButton(page).focus()
  await page.keyboard.press('Enter')
  await expect(counter(page, 1)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Carte suivante' })).toBeFocused()
  for (let k = 0; k < 4; k++) await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Continuer' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Récapitulatif' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Retour aux paquets' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(openButton(page)).toBeFocused()
  await expect(stockFrame(page)).toContainText('1 / 10')
})

test('paquet d\'une carte : le focus va sur « Continuer », pas sur body', async ({ page, login }) => {
  await login({ humanVerified: true })
  await rewriteOpen(page, (body) => { body.cards = body.cards.slice(-1) })
  await page.goto('/pulls')
  await openButton(page).focus()
  await page.keyboard.press('Enter')
  await expect(counter(page, 1, 1)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Carte suivante' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Continuer' })).toBeFocused()
})

test('paquet vide (cards: []) : pas de révélation, retour au repos', async ({ page, login }) => {
  onePack((await login({ humanVerified: true })).uid)
  await rewriteOpen(page, (body) => { body.cards = [] })
  await page.goto('/pulls')
  await openButton(page).click()
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(page.getByText(/^Carte \d/)).toHaveCount(0)
})

test('une relecture du stock partie avant l\'ouverture n\'écrase pas le stock qu\'elle a rendu', async ({ page, login }) => {
  onePack((await login({ humanVerified: true })).uid)
  await page.goto('/pulls')
  await expect(stockFrame(page)).toContainText('1 / 10')
  // La relecture suivante (retour sur la page gardée par Activity) lit le stock tout de suite (1), mais sa réponse est retenue.
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let fetched = () => {}
  const read = new Promise<void>((r) => { fetched = r })
  let delivered = () => {}
  const served = new Promise<void>((r) => { delivered = r })
  await routeOnce(page, '**/rest/v1/rpc/sync_profile_packs', async (route) => {
    const res = await route.fetch()
    fetched()
    await held
    await route.fulfill({ response: res })
    delivered()
  })
  const nav = page.locator('nav a[href="/collection"]').first()
  await hydrated(nav)
  // Marqueur du document : un rechargement complet l'efface. Sans lui, un retour par rechargement attendait 30 s (stock retenu, release() après openPack).
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/collection')
  await page.locator('nav a[href="/pulls"]').first().click()
  await expect(page).toHaveURL('/pulls')
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await read
  await openPack(page)
  release()
  for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.getByRole('button', { name: 'Retour aux paquets' }).click()
  await served
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(openButton(page)).toBeDisabled()
})

// Le retour sur la page gardée par Activity relit le stock ; cette relecture-là échoue (une fois).
async function failNextRead(page: Page) {
  await expect(stockFrame(page)).toContainText('1 / 10')
  await routeOnce(page, '**/rest/v1/rpc/sync_profile_packs', (route) => route.abort())
  await page.locator('nav a[href="/collection"]').first().click()
  await expect(page).toHaveURL('/collection')
  await page.locator('nav a[href="/pulls"]').first().click()
}
const readFailed = (page: Page) => page.getByRole('status').filter({ hasText: 'Ton stock de paquets n\'a pas pu être lu.' })

test('relecture du stock en échec : message et « Réessayer » à côté du stock ; réussite → focus sur « Ouvrir »', async ({ page, login }) => {
  onePack((await login()).uid)
  await page.goto('/pulls')
  await failNextRead(page)
  await expect(readFailed(page)).toBeVisible()
  // Le bouton vit hors de la région polie.
  await expect(readFailed(page).getByRole('button')).toHaveCount(0)
  await expect(stockFrame(page)).toContainText('1 / 10')
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(readFailed(page)).toHaveCount(0)
  await expect(openButton(page)).toBeFocused()
})

test('relecture en échec puis ouverture réussie : le stock frais efface le message', async ({ page, login }) => {
  onePack((await login({ humanVerified: true })).uid)
  await page.goto('/pulls')
  await failNextRead(page)
  await expect(readFailed(page)).toBeVisible()
  await openPack(page)
  for (let k = 0; k < 4; k++) await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.getByRole('button', { name: 'Retour aux paquets' }).click()
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(readFailed(page)).toHaveCount(0)
})

test('Pro du jour récupéré avant la toute première lecture du stock : le stock s\'affiche quand même', async ({ page, login }) => {
  onePack((await login({ pro: true, humanVerified: true })).uid)
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let delivered = () => {}
  const served = new Promise<void>((r) => { delivered = r })
  await routeOnce(page, '**/rest/v1/rpc/sync_profile_packs', async (route) => {
    const res = await route.fetch()
    await held
    await route.fulfill({ response: res })
    delivered()
  })
  await page.goto('/pulls')
  await page.getByRole('region', { name: 'Paquet PRO du jour' }).getByRole('button', { name: 'Récupérer' }).click()
  await expect(counter(page, 1, 15)).toBeVisible()
  release()
  await served
  for (let k = 0; k < 14; k++) await page.keyboard.press('ArrowRight')
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.getByRole('button', { name: 'Retour aux paquets' }).click()
  await expect(stockFrame(page)).toContainText('1 / 10')
})

test.describe('en cours, sans mouvement', () => {
  test.use({ reducedMotion: 'reduce' })
  test('« Ouverture… » visible et annoncé pendant la requête', async ({ page, login }) => {
    await login({ humanVerified: true })
    let release = () => {}
    const held = new Promise<void>((r) => { release = r })
    await page.route('**/api/packs/open', async (route) => { await held; await route.continue() })
    await page.goto('/pulls')
    await openButton(page).click()
    await expect(page.getByRole('button', { name: 'Ouverture…' })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByRole('status').filter({ hasText: 'Ouverture du paquet…' })).toBeAttached()
    release()
    await expect(counter(page, 1)).toBeVisible()
  })
})

test('stock vide : Ouvrir désactivé, message et compte à rebours', async ({ page, login }) => {
  const { uid } = await login({ humanVerified: true })
  sql(`update public.profiles set packs_remaining = 0, packs_last_regen_at = now() where id = :'uid'`, { uid })
  await page.goto('/pulls')
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(openButton(page)).toBeDisabled()
  await expect(page.getByText('Plus de paquets disponibles')).toBeVisible()
  await expect(stockFrame(page).locator('span.font-mono')).toHaveText(/^\d+:\d\d$/)
})

test.describe('animation réduite', () => {
  test.use({ reducedMotion: 'reduce' })
  test('simple fondu, aucune cinématique même pour une L', async ({ page, login }) => {
    await onlyLegendariesForPro(async () => {
      await login({ pro: true, humanVerified: true })
      await page.goto('/pulls')
      await openPack(page)
    })
    await expect(page.locator('div.glow-l').first()).toBeVisible()
    await expect(page.locator('[data-motion="reduced"]')).toBeVisible()
    await expect(page.locator('[data-cinematic]')).toHaveCount(0)
  })
})

test.describe('animation complète', () => {
  test.use({ reducedMotion: 'no-preference' })
  test('une L déclenche la cinématique', async ({ page, login }) => {
    await onlyLegendariesForPro(async () => {
      await login({ pro: true, humanVerified: true })
      await page.goto('/pulls')
      await openPack(page)
    })
    await expect(page.locator('div.glow-l').first()).toBeVisible()
    await expect(page.locator('[data-motion="full"]')).toBeVisible()
    await expect(page.locator('[data-cinematic]').first()).toBeAttached()
  })
})

test('Pro du jour : Récupérer → révélation de 15 cartes', async ({ page, login }) => {
  await login({ pro: true, humanVerified: true })
  await page.goto('/pulls')
  const pro = page.getByRole('region', { name: 'Paquet PRO du jour' })
  await pro.getByRole('button', { name: 'Récupérer' }).click()
  await expect(counter(page, 1, 15)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Aller à la carte \d+$/ })).toHaveCount(15)
})

// Page d'erreur de la plateforme (délai de la fonction dépassé) : texte brut, aucun JSON.
const PLATFORM_504 = { status: 504, contentType: 'text/plain', body: 'An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT' }
const OPEN_UNSURE = 'L\'ouverture n\'a pas été confirmée : le paquet a peut-être été ouvert, ses cartes sont alors déjà dans ta collection. Ton stock se met à jour.'
// Zone de repos (tabindex=-1) : elle reprend le focus quand « Ouvrir » se désactive.
const idleZone = (page: Page) => page.locator('div[tabindex="-1"]').filter({ has: openButton(page) })

test('réponse perdue après l\'ouverture (504) : message français, stock relu, la relance garde la clé et rejoue le même paquet', async ({ page, login }) => {
  const { uid } = await login({ humanVerified: true })
  sql(`update public.profiles set packs_remaining = 3 where id = :'uid'`, { uid })
  const keys: string[] = []
  page.on('request', (r) => { if (r.url().endsWith('/api/packs/open')) keys.push(r.headers()['idempotency-key'] ?? '') })
  // L'ouverture atteint le serveur et s'y fait ; sa réponse est remplacée par la page d'erreur de la plateforme.
  await routeOnce(page, '**/api/packs/open', async (route) => {
    await route.fetch()
    await route.fulfill(PLATFORM_504)
  })
  await page.goto('/pulls')
  await expect(stockFrame(page)).toContainText('3 / 10')
  await openButton(page).click()
  // Le stock est relu : le paquet ouvert là-bas est décompté.
  await expect(stockFrame(page)).toContainText('2 / 10')
  await expect(page.getByText(OPEN_UNSURE)).toBeVisible()
  await expect(page.getByText('Erreur 504')).toHaveCount(0)
  await openButton(page).click()
  await expect(counter(page, 1)).toBeVisible()
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
  // Un seul paquet consommé : la relance a rejoué la réponse stockée.
  expect(sql(`select packs_remaining from public.profiles where id = :'uid'`, { uid })).toBe('2')
})

test('stock vidé ailleurs : « Ouvrir » refusé (0 paquet) garde le focus dans la page et annonce le stock vide', async ({ page, login }) => {
  const { uid } = await login({ humanVerified: true })
  onePack(uid)
  await page.goto('/pulls')
  await expect(stockFrame(page)).toContainText('1 / 10')
  // Un autre onglet vient d'ouvrir le dernier paquet : la base dit 0, la page montre encore 1.
  sql(`update public.profiles set packs_remaining = 0, packs_last_regen_at = now() where id = :'uid'`, { uid })
  await openButton(page).focus()
  await page.keyboard.press('Enter')
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(openButton(page)).toBeDisabled()
  await expect(page.getByRole('status').filter({ hasText: 'Plus de paquets disponibles' })).toBeVisible()
  await expect(page.locator('body')).not.toBeFocused()
  await expect(page.locator('main :focus')).toHaveCount(1)
})

test('dernier paquet ouvert, réponse perdue (504) : stock relu à 0, le focus passe à la zone de repos, le message est annoncé', async ({ page, login }) => {
  onePack((await login({ humanVerified: true })).uid)
  // L'ouverture du dernier paquet se fait côté serveur ; sa réponse est remplacée par la page d'erreur de la plateforme.
  await routeOnce(page, '**/api/packs/open', async (route) => {
    await route.fetch()
    await route.fulfill(PLATFORM_504)
  })
  await page.goto('/pulls')
  await expect(stockFrame(page)).toContainText('1 / 10')
  await openButton(page).focus()
  await page.keyboard.press('Enter')
  // La relecture voit 0 : « Ouvrir » se désactive, le focus ne doit pas tomber sur body.
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(openButton(page)).toBeDisabled()
  await expect(page.locator('body')).not.toBeFocused()
  await expect(idleZone(page)).toBeFocused()
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(OPEN_UNSURE)
})

// --- M6b Task 10 : bannière à stock vide, liens vers l'abonnement, « Comment ça marche ? » lu de la config, paquets offerts ---

const SUBSCRIBE = 'Voir l\'abonnement'
const BANNER = 'Avec Pro, un paquet revient toutes les 3 minutes.'
const shopDialog = (page: Page) => page.getByRole('dialog', { name: 'Boutique' })
const empty = (uid: string) => sql(`update public.profiles set packs_remaining = 0, packs_last_regen_at = now() where id = :'uid'`, { uid })
const proBlock = (page: Page) => page.getByRole('region', { name: 'Paquet PRO du jour' })

// Réponse réelle de GET /api/shop, réécrite : la config (wm.config) est globale à la base partagée par les workers, jamais touchée ici.
async function rewriteShop(page: Page, edit: (body: { rules: Record<string, unknown>; me: Record<string, unknown> }) => void) {
  await page.route('**/api/shop*', async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    edit(body)
    await route.fulfill({ response: res, json: body })
  })
}

// Révélation de n cartes jusqu'au retour aux paquets.
async function finishReveal(page: Page, n: number) {
  for (let k = 1; k < n; k++) await page.getByRole('button', { name: 'Carte suivante' }).click()
  await page.getByRole('button', { name: 'Continuer' }).click()
  await page.getByRole('button', { name: 'Retour aux paquets' }).click()
}

test('stock vide d\'un joueur gratuit : la bannière exacte, « Voir l\'abonnement » ouvre la boutique', async ({ page, login }) => {
  empty((await login({ humanVerified: true })).uid)
  await page.goto('/pulls')
  await expect(page.getByText('Plus de paquets disponibles')).toBeVisible()
  await expect(page.getByText(BANNER, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: SUBSCRIBE }).first().click()
  await expect(shopDialog(page)).toBeVisible()
})

test('stock vide d\'un joueur Pro : aucune bannière, aucun lien vers l\'abonnement', async ({ page, login }) => {
  empty((await login({ pro: true, humanVerified: true })).uid)
  await page.goto('/pulls')
  await expect(page.getByText('Plus de paquets disponibles')).toBeVisible()
  await expect(proBlock(page).getByRole('button', { name: 'Récupérer' })).toBeVisible()
  await expect(page.getByText(/^Avec Pro/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: SUBSCRIBE })).toHaveCount(0)
})

test('stock non vide d\'un joueur gratuit : pas de bannière ; le bloc Pro du jour garde son lien', async ({ page, login }) => {
  onePack((await login()).uid)
  await page.goto('/pulls')
  await expect(proBlock(page)).toContainText('Réservé aux membres Pro')
  await expect(page.getByText(/^Avec Pro/)).toHaveCount(0)
  await proBlock(page).getByRole('button', { name: SUBSCRIBE }).click()
  await expect(shopDialog(page)).toBeVisible()
})

test('« Comment ça marche ? » : périodes, tailles et réserve lues de la boutique (réponse réécrite), aucune valeur en dur', async ({ page, login }) => {
  await login()
  await rewriteShop(page, (b) => {
    b.rules.pack_period_s = { free: 1200, pro: 180 }
    b.rules.pack_size = 7
    b.rules.pro_daily_size = 9
    b.me.pack_cap = 12
  })
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Comment ça marche ?' }).click()
  const help = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(help).toContainText('Tu gagnes un paquet toutes les 20 minutes (toutes les 3 minutes avec Pro)')
  await expect(help).toContainText('Un paquet contient 7 cartes')
  await expect(help).toContainText('Ta réserve monte jusqu\'à 12 paquets')
  await expect(help).toContainText('un paquet de 9 cartes chaque jour')
  await expect(help).toContainText('L ≥ 20 000')
})

test('« Comment ça marche ? » avec les valeurs de la config : 5 cartes, toutes les 10 minutes, réserve de 10, Pro du jour de 15', async ({ page, login }) => {
  await login()
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Comment ça marche ?' }).click()
  const help = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(help).toContainText('Un paquet contient 5 cartes')
  await expect(help).toContainText('toutes les 10 minutes (toutes les 3 minutes avec Pro)')
  await expect(help).toContainText('Ta réserve monte jusqu\'à 10 paquets')
  await expect(help).toContainText('un paquet de 15 cartes chaque jour')
})

test('« Comment ça marche ? » : lecture de la boutique en échec → « Les règles n\'ont pas pu être lues. », les seuils de rareté restent', async ({ page, login }) => {
  await login()
  await page.route('**/api/shop*', (r) => r.fulfill({ status: 500 }))
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Comment ça marche ?' }).click()
  const help = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(help.getByText('Les règles n\'ont pas pu être lues.', { exact: true })).toBeVisible()
  await expect(help).not.toContainText('Un paquet contient')
  await expect(help).toContainText('L ≥ 20 000')
})

test('« Comment ça marche ? » : lecture de la boutique en cours → « Chargement… »', async ({ page, login }) => {
  await login()
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/shop*', async (r) => { await held; await r.continue() })
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Comment ça marche ?' }).click()
  const help = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(help.getByRole('status')).toBeAttached()
  release()
  await expect(help).toContainText('Un paquet contient 5 cartes')
})

// Paquet spécial posé par sql, retiré en finally (cascade sur ses réclamations). Il est actif pour tous les joueurs le temps du test.
async function withSpecial(run: (pack: { id: string; name: string }) => Promise<void>, size = 3) {
  const name = `Cadeau e2e ${randomUUID().slice(-8)}`
  const id = sql(`insert into wm.special_packs (name, description, size) values (:'name', 'Un cadeau de test.', :'size') returning id`, { name, size: String(size) })
  try {
    await run({ id, name })
  } finally {
    sql(`delete from wm.special_packs where id = :'id'`, { id })
  }
}
const offered = (page: Page) => page.getByRole('region', { name: 'Paquets offerts' })

test('paquet spécial : « Récupérer » → révélation de ses cartes, puis la section disparaît (un seul POST au double clic)', async ({ page, login }) => {
  await login({ humanVerified: true })
  await withSpecial(async ({ id, name }) => {
    const posts: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/packs/special') posts.push(r.postData() ?? '') })
    await page.goto('/pulls')
    await expect(offered(page)).toContainText(`${name} : 3 cartes`)
    await expect(offered(page)).toContainText('Un cadeau de test.')
    await offered(page).getByRole('button', { name: `Récupérer ${name}` }).dblclick()
    await expect(counter(page, 1, 3)).toBeVisible()
    expect(posts).toEqual([JSON.stringify({ packId: id })])
    await finishReveal(page, 3)
    await expect(openButton(page)).toBeVisible()
    await expect(offered(page)).toHaveCount(0)
    await expect(page.getByText(name)).toHaveCount(0)
  })
})

test('paquet spécial d\'un joueur jamais vérifié : la vérification anti-bot passe, puis la révélation', async ({ page, login }) => {
  await login()
  await withSpecial(async ({ name }) => {
    await page.goto('/pulls')
    await offered(page).getByRole('button', { name: `Récupérer ${name}` }).click()
    await expect(counter(page, 1, 3)).toBeVisible()
  })
})

test('paquet spécial : 409 « déjà récupéré » → son message en alerte, la section reste utilisable', async ({ page, login }) => {
  await login({ humanVerified: true })
  await withSpecial(async ({ name }) => {
    await routeOnce(page, '**/api/packs/special', (r) => r.fulfill({ status: 409, json: { code: 'already_claimed', error: 'Paquet déjà récupéré' } }), (r) => r.request().method() === 'POST')
    await page.goto('/pulls')
    const button = offered(page).getByRole('button', { name: `Récupérer ${name}` })
    await button.click()
    await expect(page.getByRole('alert').filter({ hasText: 'Paquet déjà récupéré' })).toBeVisible()
    await expect(button).not.toHaveAttribute('aria-disabled', 'true')
  })
})

test('dotation de grâce : « Récupérer le paquet offert » → révélation, puis la section disparaît', async ({ page, login }) => {
  const { uid } = await login({ humanVerified: true })
  sql(`insert into wm.grace_grants (user_id, size, reason) values (:'uid', 3, 'e2e')`, { uid })
  try {
    await page.goto('/pulls')
    await expect(offered(page)).toContainText('Paquet offert par l\'équipe : 3 cartes')
    await offered(page).getByRole('button', { name: 'Récupérer le paquet offert' }).click()
    await expect(counter(page, 1, 3)).toBeVisible()
    await finishReveal(page, 3)
    await expect(openButton(page)).toBeVisible()
    await expect(offered(page)).toHaveCount(0)
  } finally {
    sql(`delete from wm.grace_grants where user_id = :'uid'`, { uid })
  }
})

test('rien à récupérer : aucune section « Paquets offerts »', async ({ page, login }) => {
  await login({ humanVerified: true })
  // Réponses vides posées : un paquet spécial d'un autre test (actif pour tous les joueurs) ne doit pas compter.
  await page.route('**/api/packs/special', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { packs: [], available: false } }) : r.fallback()))
  await page.route('**/api/packs/grace', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { available: 0, size: null } }) : r.fallback()))
  await page.goto('/pulls')
  await expect(proBlock(page)).toBeVisible()
  await expect(page.getByText('Paquets offerts')).toHaveCount(0)
})

test('paquet de 1 carte : « {name} : 1 carte » au singulier', async ({ page, login }) => {
  await login({ humanVerified: true })
  await withSpecial(async ({ name }) => {
    await page.goto('/pulls')
    await expect(offered(page)).toContainText(`${name} : 1 carte`)
    await expect(offered(page)).not.toContainText(`${name} : 1 cartes`)
  }, 1)
})

test('paquet spécial retiré côté serveur avant le clic : 404 « Paquet introuvable » en alerte, la section part et le focus ne tombe pas sur body', async ({ page, login }) => {
  await login({ humanVerified: true })
  await withSpecial(async ({ id, name }) => {
    await page.goto('/pulls')
    const button = offered(page).getByRole('button', { name: `Récupérer ${name}` })
    await expect(button).toBeVisible()
    sql(`delete from wm.special_packs where id = :'id'`, { id })
    await button.click()
    await expect(page.getByRole('alert').filter({ hasText: 'Paquet introuvable' })).toBeVisible()
    await expect(button).toHaveCount(0)
    await expect(page.locator('body')).not.toBeFocused()
    await expect(openButton(page)).toBeFocused()
  })
})

test('stock vide d\'un VIP (pas Pro) : aucune bannière', async ({ page, login }) => {
  const { uid } = await login({ humanVerified: true })
  empty(uid)
  sql(`update public.profiles set is_vip = true where id = :'uid'`, { uid })
  await page.goto('/pulls')
  await expect(page.getByText('Plus de paquets disponibles')).toBeVisible()
  await expect(page.getByText(/^Avec Pro/)).toHaveCount(0)
})

test('« Comment ça marche ? » : une règle déjà lue reste affichée si une relecture échoue ensuite', async ({ page, login }) => {
  await login()
  await page.goto('/pulls')
  await expect(page.locator('header button[title="Ouvrir la boutique"]')).toHaveText(/wikibidou/)
  await page.route('**/api/shop*', (r) => r.fulfill({ status: 500 }))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('header button[title="Ouvrir la boutique"]')).toHaveText('—Solde indisponible')
  await page.getByRole('button', { name: 'Comment ça marche ?' }).click()
  const help = page.getByRole('dialog', { name: 'Comment ça marche ?' })
  await expect(help).toContainText('Un paquet contient 5 cartes')
  await expect(help.getByText('Les règles n\'ont pas pu être lues.')).toHaveCount(0)
})

for (const path of ['special', 'grace']) {
  for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
    test(`lecture de /api/packs/${path} en échec (${label}) : alerte et « Réessayer », puis tout rentre dans l'ordre`, async ({ page, login }) => {
      const { uid } = await login({ humanVerified: true })
      sql(`insert into wm.grace_grants (user_id, size, reason) values (:'uid', 3, 'e2e')`, { uid })
      try {
        await routeOnce(page, `**/api/packs/${path}`, (r) => r.fulfill(reply), (r) => r.request().method() === 'GET')
        await page.goto('/pulls')
        const alert = page.getByRole('alert').filter({ hasText: 'Tes paquets offerts n\'ont pas pu être lus.' })
        await expect(alert).toBeVisible()
        // Ce qui a pu être lu reste réclamable.
        if (path === 'special') await expect(offered(page)).toContainText('Paquet offert par l\'équipe : 3 cartes')
        await page.getByRole('button', { name: 'Réessayer' }).click()
        await expect(alert).toHaveCount(0)
        // Le bouton disparu ne laisse pas le focus sur body.
        await expect(openButton(page)).toBeFocused()
        await expect(offered(page)).toContainText('Paquet offert par l\'équipe : 3 cartes')
      } finally {
        sql(`delete from wm.grace_grants where user_id = :'uid'`, { uid })
      }
    })
  }
}
