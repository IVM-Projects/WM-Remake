import type { BrowserContext, Locator, Page } from '@playwright/test'
import { cookieFor, expect, giveCopies, hydrated, makePlayer, sql, test } from './fixtures'

// Sélecteurs repris de friends.spec.ts, trades.spec.ts, notifications.spec.ts et market-journey.spec.ts.
const section = (page: Page, title: string) =>
  page.locator('main section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
const toasts = (page: Page) => page.locator('#wm-toasts')
// Une page quittée reste dans le DOM, masquée (Activity) : seul le visible compte.
const ready = (page: Page) => page.locator('main [data-ready]').filter({ visible: true }).waitFor()
const tab = (page: Page, name: string) => page.getByRole('tab', { name })
const offers = (page: Page) => page.getByRole('tabpanel').locator('div.card-frame.p-4')
const status = (page: Page) => page.locator('main p[tabindex="-1"]').filter({ visible: true })
const offerPanel = (page: Page) => page.getByRole('region', { name: /^Tu offres/ })
const askPanel = (page: Page) => page.getByRole('region', { name: /^Tu demandes/ })
const tiles = (page: Page) => page.locator('div.flex.flex-wrap.justify-center.gap-3 > div.relative.isolate.group')
const tile = (page: Page, t: string) => tiles(page).filter({ has: page.locator('h3').getByText(t, { exact: true }) })
const balance = (page: Page) => page.locator('main h1 + p')
const bell = (page: Page) => page.locator('button[aria-label="Notifications"]')
const badge = (page: Page) => page.locator('button[aria-label="Notifications"] + span')
const bellLinks = (page: Page) => page.getByRole('dialog', { name: 'Notifications' }).getByRole('list', { name: 'Notifications récentes' }).getByRole('link')
const TRADE_URL = /\/trades\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const titleOf = (copy: string) => sql(`select c.wikipedia_title from public.user_cards u join public.cards c on c.id = u.card_id where u.id = :'copy'`, { copy })

// Clavier seul : focus, puis Entrée, ou tout sélectionner et saisir.
async function press(target: Locator) {
  await target.focus()
  await target.press('Enter')
}
async function typeIn(target: Locator, text: string) {
  await target.focus()
  await target.press('ControlOrMeta+A')
  await target.page().keyboard.type(text)
}
async function openBell(page: Page) {
  await hydrated(bell(page))
  await press(bell(page))
}

// Critère du jalon (M4-17) : A cherche B et l'ajoute, B accepte ; A propose, B contre-propose, A accepte ; copies, soldes et cloches des
// deux côtés. Un contexte de navigateur par joueur ; seules écritures SQL : les joueurs et leurs copies (étape 1).
test('parcours M4a au clavier : demande d\'ami → acceptation → échange → contre-offre → acceptation ; copies, soldes et cloches', async ({ browser, baseURL }) => {
  // 0.
  test.setTimeout(120_000)
  const contexts: BrowserContext[] = []
  const uids: string[] = []
  try {
    // 1.
    const a = makePlayer({ balance: 100 })
    uids.push(a.uid)
    const b = makePlayer({ balance: 100 })
    uids.push(b.uid)
    const [z] = giveCopies(a, 'C', 1)
    const [x, y] = giveCopies(b, 'PC', 2)
    const [Z, X, Y] = [z, x, y].map(titleOf)
    for (const u of [a, b]) {
      const ctx = await browser.newContext()
      contexts.push(ctx)
      await ctx.addCookies([{ ...cookieFor(u), url: baseURL! }])
    }
    const [ap, bp] = await Promise.all(contexts.map((c) => c.newPage()))

    // 2. A cherche B et l'ajoute.
    await ap.goto('/friends')
    await ready(ap)
    await typeIn(ap.locator('#friend-list-search'), b.username)
    await ap.keyboard.press('Enter')
    const results = ap.getByRole('list', { name: 'Résultats de la recherche' }).getByRole('listitem')
    await expect(results).toHaveCount(1)
    await expect(results).toContainText(b.username)
    await press(results.getByRole('button', { name: 'Ajouter' }))
    await expect(toasts(ap)).toContainText(`Demande envoyée à ${b.username}.`)
    // Le toast part avant la relecture : la demande sous « Demandes envoyées » en est le signe.
    await expect(section(ap, 'Demandes envoyées').getByRole('listitem')).toContainText(b.username)

    // 3. B accepte.
    await bp.goto('/friends')
    await ready(bp)
    const received = section(bp, 'Demandes reçues')
    await press(received.getByRole('listitem').filter({ hasText: a.username }).getByRole('button', { name: 'Accepter', exact: true }))
    await expect(toasts(bp)).toContainText(`${a.username} fait maintenant partie de tes amis.`)
    await expect(received.getByText('Aucune demande reçue.', { exact: true })).toBeFocused()

    // 4. A propose : Z offerte, X demandée, 10 wikibidous offerts.
    await ap.goto('/friends')
    await ready(ap)
    const trade = section(ap, 'Amis').getByRole('listitem').filter({ hasText: b.username }).getByRole('link', { name: 'Échanger' })
    await hydrated(trade)
    await press(trade)
    await expect(ap).toHaveURL(`/trades/new?with=${b.uid}`)
    await ready(ap)
    await typeIn(offerPanel(ap).getByLabel(`Quantité de ${Z}`, { exact: true }), '1')
    await typeIn(askPanel(ap).getByLabel(`Quantité de ${X}`, { exact: true }), '1')
    await typeIn(ap.getByLabel('Wikibidous offerts'), '10')
    await press(ap.getByRole('button', { name: 'Proposer l\'échange' }))
    await expect(ap).toHaveURL(TRADE_URL)
    const t1 = new URL(ap.url()).pathname.split('/')[2]
    await expect(toasts(ap)).toContainText(`Échange proposé à ${b.username}.`)

    // 5. B : badge « 2 » (friend_request et trade_received), puis la contre-offre, préremplie à l'inverse, Y en plus.
    await bp.goto('/pulls')
    await expect(badge(bp)).toHaveText('2')
    await bp.goto('/trades')
    await ready(bp)
    await press(tab(bp, 'Reçues'))
    await expect(tab(bp, 'Reçues')).toHaveAttribute('aria-selected', 'true')
    await press(offers(bp).filter({ hasText: `De ${a.username}` }).locator(':scope > button'))
    await expect(bp).toHaveURL(`/trades/${t1}`)
    await ready(bp)
    const counter = bp.getByRole('link', { name: 'Contre-offre', exact: true })
    await hydrated(counter)
    await press(counter)
    await expect(bp).toHaveURL(`/trades/new?with=${a.uid}&parent=${t1}`)
    await ready(bp)
    await expect(askPanel(bp).getByLabel(`Quantité de ${Z}`, { exact: true })).toHaveValue('1')
    await expect(offerPanel(bp).getByLabel(`Quantité de ${X}`, { exact: true })).toHaveValue('1')
    await expect(bp.getByLabel('Wikibidous demandés')).toHaveValue('10')
    await typeIn(offerPanel(bp).getByLabel(`Quantité de ${Y}`, { exact: true }), '1')
    await expect(offerPanel(bp).getByRole('heading')).toHaveText('Tu offres (2/100)')
    await press(bp.getByRole('button', { name: 'Envoyer la contre-offre' }))
    await expect(bp).toHaveURL(TRADE_URL)
    const t2 = new URL(bp.url()).pathname.split('/')[2]
    expect(t2).not.toBe(t1)
    await expect(toasts(bp)).toContainText('Contre-offre envoyée.')

    // 6. A : T1 sous « Historique » en contre-offre ; T2 sous « Reçues », acceptée.
    await ap.goto('/trades')
    await ready(ap)
    await press(tab(ap, 'Historique'))
    await expect(tab(ap, 'Historique')).toHaveAttribute('aria-selected', 'true')
    await expect(offers(ap)).toHaveCount(1)
    await expect(offers(ap)).toContainText(`De ${a.username}`)
    await expect(offers(ap).locator('.text-sky-400')).toHaveText('· Contre-offre')
    await press(tab(ap, 'Reçues'))
    await expect(tab(ap, 'Reçues')).toHaveAttribute('aria-selected', 'true')
    await press(offers(ap).filter({ hasText: `De ${b.username}` }).locator(':scope > button'))
    await expect(ap).toHaveURL(`/trades/${t2}`)
    await ready(ap)
    await press(ap.getByRole('button', { name: 'Accepter' }))
    await expect(toasts(ap)).toContainText('Échange accepté.')
    await expect(status(ap)).toHaveText('Accepté')

    // 7. Copies et soldes des deux côtés ; M conservé.
    await ap.goto('/collection')
    await expect(tile(ap, X)).toHaveCount(1)
    await expect(tile(ap, Y)).toHaveCount(1)
    await expect(tiles(ap)).toHaveCount(2)
    await expect(tile(ap, Z)).toHaveCount(0)
    await expect(balance(ap)).toHaveText('90 wikibidous')
    await bp.goto('/collection')
    await expect(tile(bp, Z)).toHaveCount(1)
    await expect(balance(bp)).toHaveText('110 wikibidous')
    expect(sql(`select sum(wikibidous_balance) from public.profiles where id = any(string_to_array(:'uids', ',')::uuid[])`,
      { uids: uids.join(',') })).toBe('200')

    // 8. Cloches, plus récente d'abord.
    await ap.goto('/pulls')
    await openBell(ap)
    await expect(bellLinks(ap)).toHaveText([`${b.username} a fait une contre-offre`, `${b.username} a accepté ta demande d'ami`])
    await bp.goto('/pulls')
    await openBell(bp)
    await expect(bellLinks(bp)).toHaveText([`${a.username} a accepté ton échange`, `${a.username} te propose un échange`, `${a.username} veut devenir ton ami`])
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
    // Profils, amitiés, échanges, éléments et notifications suivent en cascade.
    sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: uids.join(',') })
  }
})
