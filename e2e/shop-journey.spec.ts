import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { checkoutCompleted, signedPost, subscriptionEvent } from '../contract/stripe-events.ts'
import { cookieFor, expect, makePlayer, sql, test } from './fixtures'

const hex = () => randomUUID().replaceAll('-', '')
const now = () => Math.floor(Date.now() / 1000)
const balance = (page: Page) => page.locator('header button[title="Ouvrir la boutique"]')
const shop = (page: Page) => page.getByRole('dialog', { name: 'Boutique' })
const toasts = (page: Page) => page.locator('#wm-toasts')
const pro = (page: Page) => page.locator('header').getByText('PRO', { exact: true })
const daily = (page: Page) => page.getByRole('region', { name: 'Paquet PRO du jour' })
const subscription = (page: Page) => page.getByRole('region', { name: 'Abonnement', exact: true })
const ok = async (res: Promise<Response>) => expect((await res).status).toBe(200)

// Une page factice tient lieu de Checkout ; l'id de la session se lit dans l'adresse où le navigateur a été envoyé (cs_test_bench_…).
async function checkout(page: Page, button: RegExp): Promise<string> {
  await page.goto('/pulls')
  await balance(page).click()
  await shop(page).getByRole('button', { name: button }).click()
  await page.waitForURL(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_bench_/)
  return new URL(page.url()).pathname.split('/').at(-1)!
}

// Recette M6b (jalon) : achat de WB puis abonnement Pro par Checkout simulé et webhook signé, rejeu sans effet, Pro éteint.
// Seule écriture SQL : le joueur P ; tout le reste vient de l'interface et des événements signés postés au vrai gestionnaire.
test('parcours boutique : 2 500 WB crédités une seule fois, Pro allumé puis éteint, cloche et invariants', async ({ page, baseURL }) => {
  test.setTimeout(180_000)
  const uids: string[] = []
  try {
    // 1. P, à zéro.
    const p = makePlayer({ balance: 0 })
    uids.push(p.uid)
    await page.context().addCookies([{ ...cookieFor(p), url: baseURL! }])
    await page.route('https://checkout.stripe.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<title>Checkout</title>' }))

    // 2. /pulls : solde 0, la boutique, « Acheter » → Checkout.
    await page.goto('/pulls')
    await expect(balance(page)).toHaveText('0 wikibidou')
    const wb = await checkout(page, /^Acheter 2.500 wikibidous pour 4,99.CAD$/)

    // 3. Webhook signé, puis retour de Checkout : toast et solde.
    const paid = checkoutCompleted({ uid: p.uid, session: wb, item: 'wb_2500' })
    await ok(signedPost(baseURL!, paid))
    await page.goto(`/pulls?shop=success&session=${wb}`)
    await expect(toasts(page)).toContainText('2 500 wikibidous crédités.')
    await expect(balance(page)).toHaveText('2 500 wikibidous')

    // 4. Rejeu du même corps signé : sans effet, une seule ligne de grand livre.
    await ok(signedPost(baseURL!, paid))
    await page.reload()
    await expect(balance(page)).toHaveText('2 500 wikibidous')
    expect(sql(`select count(*) from wm.wb_ledger where user_id = :'u' and reason = 'stripe' and ref = :'r'`, { u: p.uid, r: `stripe:${wb}` })).toBe('1')

    // 5. Pro allumé : l'abonnement actif puis la session payée.
    const sub = `sub_bench_${hex()}`
    const customer = `cus_bench_${hex()}`
    const periodEnd = now() + 30 * 86_400
    const proSession = await checkout(page, /^S'abonner à Pro pour 9,99.CAD par mois$/)
    await ok(signedPost(baseURL!, subscriptionEvent({ id: sub, uid: p.uid, status: 'active', type: 'created', created: now(), periodEnd, customer })))
    await ok(signedPost(baseURL!, checkoutCompleted({ uid: p.uid, session: proSession, item: 'pro_monthly', customer })))
    await page.goto(`/pulls?shop=success&session=${proSession}`)
    await expect(toasts(page)).toContainText('Bienvenue chez les membres Pro !')
    await expect(pro(page)).toBeVisible()
    await expect(daily(page).getByRole('button', { name: 'Récupérer', exact: true })).toBeVisible()
    await page.goto('/settings')
    await expect(subscription(page).getByText(/^Abonnement Pro actif\. Prochain renouvellement le .+\.$/)).toBeVisible()

    // 6. Pro éteint : l'abonnement supprimé.
    await ok(signedPost(baseURL!, subscriptionEvent({ id: sub, uid: p.uid, status: 'canceled', type: 'deleted', created: now() + 1, periodEnd, customer })))
    await page.goto('/pulls')
    await expect(daily(page).getByText('Réservé aux membres Pro')).toBeVisible()
    await expect(daily(page).getByRole('button', { name: 'Voir l\'abonnement' })).toBeVisible()
    await expect(daily(page).getByRole('button', { name: 'Récupérer', exact: true })).toHaveCount(0)
    await expect(pro(page)).toHaveCount(0)
    await page.goto('/settings')
    await expect(subscription(page).getByText('Tu n\'as pas d\'abonnement.', { exact: true })).toBeVisible()

    // 7. Invariants vides pour P ; la cloche garde les trois notifications.
    expect(sql(`select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(wm.check_invariants()) v where v ->> 'user_id' = :'p'`, { p: p.uid })).toBe('[]')
    expect(sql(`select string_agg(type || coalesce(':' || (data ->> 'status'), ''), ',' order by type) from public.notifications where user_id = :'p'`, { p: p.uid }))
      .toBe('pro_ended:canceled,pro_started,wb_purchased')
    await page.locator('button[aria-label="Notifications"]').click()
    const rows = page.getByRole('dialog', { name: 'Notifications' }).getByRole('list', { name: 'Notifications récentes' }).getByRole('listitem')
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: '2 500 wikibidous crédités' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Tu es membre Pro : merci !' })).toHaveCount(1)
    await expect(rows.filter({ hasText: 'Ton abonnement Pro est terminé' })).toHaveCount(1)
  } finally {
    if (uids.length) sql(`delete from auth.users where id = any(string_to_array(:'u', ',')::uuid[])`, { u: uids.join(',') })
  }
})
