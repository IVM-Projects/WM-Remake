import type { BrowserContext, Locator, Page } from '@playwright/test'
import { cookieFor, expect, giveCopies, hydrated, imageCopy, makePlayer, sql, test } from './fixtures'

// Sélecteurs repris de trade-journey.spec.ts, profile.spec.ts et dms.spec.ts.
const section = (page: Page, title: string) =>
  page.locator('main section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
const toasts = (page: Page) => page.locator('#wm-toasts')
// Une page quittée reste dans le DOM, masquée (Activity) : seul le visible compte.
const ready = (page: Page) => page.locator('main [data-ready]').filter({ visible: true }).waitFor()
const badge = (page: Page) => page.locator('button[aria-label="Notifications"] + span')
const bell = (page: Page) => page.locator('button[aria-label="Notifications"]')
const bellLinks = (page: Page) => page.getByRole('dialog', { name: 'Notifications' }).getByRole('list', { name: 'Notifications récentes' }).getByRole('link')
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const field = (page: Page) => page.getByRole('textbox', { name: 'Ton message' })
const bubble = (page: Page, peer: string, text: string) =>
  page.getByRole('log', { name: `Messages avec ${peer}` }).getByRole('listitem').filter({ hasText: text })
const conversation = (page: Page, peer: string) => page.getByRole('list', { name: 'Conversations' }).getByRole('link').filter({ hasText: peer })
const profileOf = (username: string) => `/profile/${encodeURIComponent(username)}`
const cardOf = (copy: string, col: 'wikipedia_title' | 'image_url') =>
  sql(`select c.${col} from public.user_cards u join public.cards c on c.id = u.card_id where u.id = :'copy'`, { copy })
const isMarkRead = (method: string, url: string) => method === 'PATCH' && new URL(url).pathname === '/rest/v1/chat_messages'

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

// Critère du jalon (M4b) : A demande B en ami depuis son profil, B accepte ; B écrit depuis le profil de A, A lit par la cloche et répond,
// B lit la réponse ; A pose avatar et vitrine, B les voit. Un contexte de navigateur par joueur ; seules écritures SQL : l'étape 1.
test('parcours M4b au clavier : profil → amitié → message → réponse lue → avatar et vitrine vus par l\'ami', async ({ browser, baseURL }) => {
  // 0.
  test.setTimeout(120_000)
  const contexts: BrowserContext[] = []
  const uids: string[] = []
  try {
    // 1.
    const a = makePlayer()
    uids.push(a.uid)
    const b = makePlayer()
    uids.push(b.uid)
    const i = imageCopy(a)
    const [z] = giveCopies(a, 'C', 1)
    const [I, Z] = [i, z].map((copy) => cardOf(copy, 'wikipedia_title'))
    for (const u of [a, b]) {
      const ctx = await browser.newContext()
      contexts.push(ctx)
      await ctx.addCookies([{ ...cookieFor(u), url: baseURL! }])
    }
    const [ap, bp] = await Promise.all(contexts.map((c) => c.newPage()))

    // 2. A ajoute B depuis son profil ; le bouton disparu, le focus passe à « Demande envoyée ».
    await ap.goto(profileOf(b.username))
    await ready(ap)
    await press(ap.getByRole('button', { name: 'Ajouter en ami', exact: true }))
    await expect(toasts(ap)).toContainText(`Demande envoyée à ${b.username}.`)
    await expect(ap.getByText('Demande envoyée', { exact: true })).toBeFocused()

    // 3. B accepte.
    await bp.goto('/friends')
    await ready(bp)
    const received = section(bp, 'Demandes reçues')
    await press(received.getByRole('listitem').filter({ hasText: a.username }).getByRole('button', { name: 'Accepter', exact: true }))
    await expect(toasts(bp)).toContainText(`${a.username} fait maintenant partie de tes amis.`)
    await expect(received.getByText('Aucune demande reçue.', { exact: true })).toBeFocused()

    // 4. B écrit à A depuis son profil.
    await bp.goto(profileOf(a.username))
    await ready(bp)
    const message = bp.getByRole('link', { name: 'Message', exact: true })
    await hydrated(message)
    await press(message)
    await expect(bp).toHaveURL(`/dms?with=${a.uid}`)
    await ready(bp)
    await typeIn(field(bp), 'Salut A')
    await field(bp).press('Enter')
    await expect(bubble(bp, a.username, 'Salut A')).toBeVisible()
    await expect(field(bp)).toHaveValue('')
    // B quitte le fil : resté ouvert (et visible, un contexte par joueur), son poll de 5 s marquerait lu le « Salut B » de l'étape 5.
    await bp.goto('/pulls')

    // 5. A : badge « 2 » (friend_accepted et chat_message) ; la cloche mène au fil, marqué lu par le PATCH direct ; A répond.
    await ap.goto('/pulls')
    await expect(badge(ap)).toHaveText('2')
    await hydrated(bell(ap))
    await press(bell(ap))
    await expect(bellLinks(ap)).toHaveText([`${b.username} t'a écrit`, `${b.username} a accepté ta demande d'ami`])
    const marked = ap.waitForRequest((r) => isMarkRead(r.method(), r.url()))
    await press(bellLinks(ap).first())
    await expect(ap).toHaveURL(`/dms?with=${b.uid}`)
    await ready(ap)
    await expect(bubble(ap, b.username, 'Salut A')).toBeVisible()
    await marked
    await typeIn(field(ap), 'Salut B')
    await field(ap).press('Enter')
    await expect(bubble(ap, b.username, 'Salut B')).toBeVisible()
    await expect(field(ap)).toHaveValue('')

    // 6. B : la conversation avec A à « 1 » non lu ; ouverte, « Salut B » ; les deux messages lus ; badge « 1 » (la friend_request de
    // l'étape 2 ; la chat_message de A, lue par le trigger du marquage).
    await bp.goto('/dms')
    await ready(bp)
    const withA = conversation(bp, a.username)
    await expect(withA.getByText('1 message non lu', { exact: true })).toHaveCount(1)
    await hydrated(withA)
    await press(withA)
    await expect(bp).toHaveURL(`/dms?with=${a.uid}`)
    await ready(bp)
    await expect(bubble(bp, a.username, 'Salut B')).toBeVisible()
    await expect.poll(() => sql(`select string_agg(content || ':' || read, ',' order by created_at) from public.chat_messages
where sender_id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: uids.join(',') })).toBe('Salut A:true,Salut B:true')
    await bp.goto('/pulls')
    await expect(badge(bp)).toHaveText('1')

    // 7. A : avatar I, puis Z à l'emplacement 1 de la vitrine.
    await ap.goto('/profile')
    await ready(ap)
    await press(region(ap, 'Avatar').getByRole('button', { name: 'Changer l\'avatar', exact: true }))
    const avatars = ap.getByRole('dialog', { name: 'Choisir ton avatar' })
    await press(avatars.getByRole('button', { name: I, exact: true }))
    await expect(toasts(ap)).toContainText('Avatar changé.')
    await expect(avatars).toHaveCount(0)
    await press(ap.getByRole('button', { name: 'Ajouter une carte à l\'emplacement 1', exact: true }))
    const cards = ap.getByRole('dialog', { name: 'Choisir une carte pour la vitrine' })
    await press(cards.getByRole('button', { name: Z, exact: true }))
    await expect(toasts(ap)).toContainText('Vitrine mise à jour.')
    await expect(cards).toHaveCount(0)

    // 8. B voit l'avatar et la vitrine de A, et ses actions d'ami.
    await bp.goto(profileOf(a.username))
    await ready(bp)
    await expect(bp.locator('main .card-frame > img')).toHaveAttribute('src', cardOf(i, 'image_url'))
    await expect(bp.getByRole('tab', { name: 'Vitrine' })).toHaveAttribute('aria-selected', 'true')
    await expect(bp.getByRole('tabpanel').getByRole('button', { name: Z, exact: true })).toBeVisible()
    await expect(bp.getByRole('link', { name: 'Message', exact: true })).toBeVisible()
    await expect(bp.getByRole('link', { name: 'Proposer un échange', exact: true })).toBeVisible()
    await expect(bp.getByRole('button', { name: 'Signaler', exact: true })).toBeVisible()
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
    // Profils, amitiés, messages, copies, vitrine et notifications suivent en cascade.
    sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: uids.join(',') })
  }
})
