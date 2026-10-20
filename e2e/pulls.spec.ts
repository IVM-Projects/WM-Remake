import type { Page } from '@playwright/test'
import { expect, sql, test } from './fixtures'

const RARITY_LABEL = '(Légendaire|Ultra rare|Super rare|Rare|Peu commune|Commune)'

// Compteur visible « Carte n / N » (texte exact : la région aria-live dit « Carte n / N : … »).
const counter = (page: Page, n: number, total = 5) => page.getByText(`Carte ${n} / ${total}`, { exact: true })
const openButton = (page: Page) => page.getByRole('button', { name: 'Ouvrir', exact: true })
const stockFrame = (page: Page) => page.locator('div.card-frame').filter({ hasText: 'paquets disponibles' })

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
  await login()
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
  await login()
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
  await login({ humanVerified: true })
  await rewriteOpen(page, (body) => { body.cards = [] })
  await page.goto('/pulls')
  await openButton(page).click()
  await expect(stockFrame(page)).toContainText('0 / 10')
  await expect(page.getByText(/^Carte \d/)).toHaveCount(0)
})

test('une relecture du stock partie avant l\'ouverture n\'écrase pas le stock qu\'elle a rendu', async ({ page, login }) => {
  await login({ humanVerified: true })
  await page.goto('/pulls')
  await expect(stockFrame(page)).toContainText('1 / 10')
  // La relecture suivante (retour sur la page gardée par Activity) lit le stock tout de suite (1), mais sa réponse est retenue.
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let fetched = () => {}
  const read = new Promise<void>((r) => { fetched = r })
  let delivered = () => {}
  const served = new Promise<void>((r) => { delivered = r })
  await page.route('**/rest/v1/rpc/sync_profile_packs', async (route) => {
    const res = await route.fetch()
    fetched()
    await held
    await route.fulfill({ response: res })
    delivered()
  }, { times: 1 })
  await page.locator('nav a[href="/collection"]').first().click()
  await expect(page).toHaveURL('/collection')
  await page.locator('nav a[href="/pulls"]').first().click()
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
  await page.route('**/rest/v1/rpc/sync_profile_packs', (route) => route.abort(), { times: 1 })
  await page.locator('nav a[href="/collection"]').first().click()
  await expect(page).toHaveURL('/collection')
  await page.locator('nav a[href="/pulls"]').first().click()
}
const readFailed = (page: Page) => page.getByRole('status').filter({ hasText: 'Ton stock de paquets n\'a pas pu être lu.' })

test('relecture du stock en échec : message et « Réessayer » à côté du stock ; réussite → focus sur « Ouvrir »', async ({ page, login }) => {
  await login()
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
  await login({ humanVerified: true })
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
  await login({ pro: true, humanVerified: true })
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let delivered = () => {}
  const served = new Promise<void>((r) => { delivered = r })
  await page.route('**/rest/v1/rpc/sync_profile_packs', async (route) => {
    const res = await route.fetch()
    await held
    await route.fulfill({ response: res })
    delivered()
  }, { times: 1 })
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
