import type { BrowserContext, Page } from '@playwright/test'
import { formatInt } from '../lib/format.ts'
import { cookieFor, expect, makePlayer, sql, test } from './fixtures'

const tiles = (page: Page) => page.locator('div.flex.flex-wrap.justify-center.gap-3 > div.relative.isolate.group')
const balance = (page: Page) => page.locator('main h1 + p')
const amountField = (page: Page) => page.getByRole('spinbutton', { name: 'Montant de la mise' })
const leading = (page: Page) => page.locator('main').getByText('En tête', { exact: true })
// Durée d'une étape, en annotation du test (rapport HTML de la CI).
const timed = async (step: string, run: () => Promise<void>) => {
  const t0 = Date.now()
  await run()
  test.info().annotations.push({ type: step, description: `${Date.now() - t0} ms` })
}

// Critère de fin du M3 (D§13, M3-25) : mise en vente → mise → remboursement de l'ancien meneur → règlement sans clic → copie chez le
// gagnant. Un contexte de navigateur par joueur (P22) ; la copie vient d'un paquet ; seule écriture SQL : end_at ramené à maintenant.
test('parcours M3 : mise en vente → mise → surenchère et remboursement → règlement à la lecture → copie chez le gagnant', async ({ browser, baseURL }) => {
  // Les étapes 4 et 7 attendent chacune jusqu'à 15 s : au-delà des 30 s par défaut.
  test.setTimeout(90_000)
  const seller = makePlayer({ humanVerified: true })
  const a = makePlayer({ balance: 100, humanVerified: true })
  const b = makePlayer({ balance: 100, humanVerified: true })
  // Chaque contexte rangé dès sa création : un échec d'addCookies n'en laisse aucun ouvert.
  const contexts: BrowserContext[] = []
  // Règlement sans clic : aucun POST …/settle d'aucun des trois joueurs.
  const settles: string[] = []
  try {
    for (const u of [seller, a, b]) {
      const ctx = await browser.newContext()
      contexts.push(ctx)
      await ctx.addCookies([{ ...cookieFor(u), url: baseURL! }])
      ctx.on('request', (r) => { if (new URL(r.url()).pathname.endsWith('/settle')) settles.push(r.url()) })
    }
    const [sp, ap, bp] = await Promise.all(contexts.map((c) => c.newPage()))

    // Vendeur : un paquet, puis la première tuile de sa collection mise aux enchères (10, « 10 min »).
    await sp.goto('/pulls')
    await sp.getByRole('button', { name: 'Ouvrir', exact: true }).click()
    for (let n = 1; n < 5; n++) {
      await expect(sp.getByText(`Carte ${n} / 5`, { exact: true })).toBeVisible()
      await sp.getByRole('button', { name: 'Carte suivante' }).click()
    }
    await expect(sp.getByText('Carte 5 / 5', { exact: true })).toBeVisible()
    await sp.getByRole('button', { name: 'Continuer' }).click()
    await expect(sp.getByRole('region', { name: 'Récapitulatif' }).locator('div[class*="glow-"]')).toHaveCount(5)

    await sp.goto('/collection')
    await tiles(sp).first().locator('h3 button').click()
    const dialog = sp.getByRole('dialog')
    const t = (await dialog.locator('h2').textContent())!
    expect(t).not.toBe('')
    await dialog.getByRole('button', { name: 'Mettre aux enchères' }).click()
    await dialog.getByRole('spinbutton', { name: 'Mise de départ' }).fill('10')
    await dialog.getByRole('button', { name: '10 min' }).click()
    await dialog.getByRole('button', { name: 'Lancer l\'enchère' }).click()
    await expect(sp.getByRole('status').getByText(`${t} a bien été mise aux enchères pour ${formatInt(10)} wikibidous`, { exact: true })).toBeVisible()
    await expect(sp).toHaveURL(/\/marketplace\/[0-9a-f-]{36}$/)
    const id = new URL(sp.url()).pathname.split('/').pop()!

    // A mise la mise de départ.
    await ap.goto(`/marketplace/${id}`)
    await expect(amountField(ap)).toHaveValue('10')
    await ap.getByRole('button', { name: 'Miser' }).click()
    await expect(leading(ap)).toBeVisible()
    // Débitée à la mise : le 100 de l'étape 5 est alors un remboursement, pas une mise jamais prélevée.
    await ap.goto('/collection')
    await expect(balance(ap)).toHaveText('90 wikibidous')

    // B : le champ suit min_next_bid, au besoin après un passage du polling (détail partagé jusqu'à 2 s, polling à 10 s).
    await bp.goto(`/marketplace/${id}`)
    await timed('étape 4', () => expect(amountField(bp)).toHaveValue('11', { timeout: 15_000 }))
    await bp.getByRole('button', { name: 'Miser' }).click()
    await expect(leading(bp)).toBeVisible()

    // A, surenchéri, est remboursé.
    await ap.goto('/collection')
    await expect(balance(ap)).toHaveText('100 wikibidous')

    sql('update public.auctions set end_at = now() where id = :\'id\'', { id })

    // Pas de cron sur le banc : la lecture paresseuse du détail règle l'enchère, au premier cache manqué.
    await timed('étape 7', () => expect(async () => {
      await bp.reload()
      await expect(bp.getByText('Remportée')).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 }))

    await bp.goto('/collection')
    await expect(tiles(bp).filter({ has: bp.locator('h3').getByText(t, { exact: true }) })).toHaveCount(1)
    await expect(balance(bp)).toHaveText('89 wikibidous')

    await sp.goto('/collection')
    await expect(balance(sp)).toHaveText('11 wikibidous')
    // M conservé : Σ des soldes des trois joueurs, plus la mise d'une enchère encore active (aucune).
    expect(sql(`select (select sum(wikibidous_balance) from public.profiles where id = any(string_to_array(:'uids', ',')::uuid[]))
  || ' + ' || (select coalesce(sum(current_bid), 0) from public.auctions where id = :'id' and status = 'active')`,
    { uids: [seller, a, b].map((u) => u.uid).join(','), id })).toBe('200 + 0')
    expect(settles).toEqual([])
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})
