import { randomUUID } from 'node:crypto'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { befriend, expect, giveCopies, imageCopy, makePlayer, sql, test } from './fixtures'
import { stubPush } from './push-stub'

type Known = { rule: string; selector: string }

// D§8.6 : 0 violation serious ou critical (WCAG 2.2 AA). `known` tolère une seule règle sur les seuls nœuds d'un sélecteur.
async function expectNoSeriousViolations(page: Page, known?: Known) {
  // Fondus et transitions de couleur finis avant chaque analyse : en CI, axe lisait un bouton à mi-chemin vers l'accent.
  await settled(page)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  const serious: string[] = []
  for (const v of violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')) {
    const nodes: string[] = []
    for (const n of v.nodes) {
      const target = n.target.join(' ')
      const tolerated = known?.rule === v.id && await page.locator(target).evaluate((el, s) => el.matches(s), known.selector)
      if (!tolerated) nodes.push(target)
    }
    if (nodes.length) serious.push(`${v.id} : ${nodes.join(' | ')}`)
  }
  expect(serious).toEqual([])
}

// R21 : écart de contrat connu, consigné pour le M7 (parity/allowed-diffs) — le DOM de R§6.5 `[role=listbox] li[role=option] button`
// fait lever nested-interactive à axe tant que la liste est ouverte (boutons hors tabulation, clavier par aria-activedescendant).
const TAG_OPTION: Known = { rule: 'nested-interactive', selector: '[role=listbox] li[role=option]' }

// Contenu rendu après l'hydratation (sessionStorage, session lue par le client) : attendu avant l'analyse.
const READY: Record<string, string> = {
  '/reset-password': 'main [role=alert]', '/verify-email': '#signup-otp-code', '/pulls': '[data-stock-bar]',
  '/collection': 'main a[href="/pulls"]', '/global-collection': 'main nav[aria-label="Pagination"]',
  // Les lectures de /settings finies : pseudo, préférences et notifications push (avec le renvoi de l'abonnement).
  '/settings': 'main:has(#settings-username):has(input[name="sounds"]) section[data-ready]',
  // Première lecture de /api/friends finie (sections ou erreur).
  '/friends': 'main [data-ready]',
  // Ami, collections et parent lus (composer, blocage ou erreur).
  '/trades/new': 'main [data-ready]',
  // Profil lu, avec sa vitrine et ses raretés quand la vue est permise (ou l'échec).
  '/profile/[username]': 'main [data-ready]',
  // Ligne du profil et vitrine lues (ou l'échec).
  '/profile': 'main [data-ready]',
  // Liste des conversations lue, avec le fil quand `with` est là (ou l'échec).
  '/dms': 'main [data-ready]',
  // Batailles et amis lus (ou en échec), session connue.
  '/battle': 'main [data-ready]',
}

// Animations finies (fondu, pivot de la carte) : axe mesurerait le contraste d'un texte encore à demi transparent.
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
  .map((a) => a.finished.catch(() => null))))

for (const path of ['/', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email', '/terms', '/rules', '/credits',
  'http://127.0.0.1:3101/gate', '/pulls', '/collection', '/global-collection', '/friends', '/settings', '/battle']) {
  test(`axe ${path}`, async ({ page, login }) => {
    if (['/pulls', '/collection', '/global-collection', '/friends', '/settings', '/battle'].includes(path)) await login()
    // Adresse posée par /login (compte non confirmé) dans sessionStorage, jamais dans l'URL.
    if (path === '/verify-email') await page.addInitScript(() => sessionStorage.setItem('wm.verifyEmail', 'a11y@test.local'))
    await page.goto(path)
    if (READY[path]) await page.locator(READY[path]).waitFor()
    await settled(page)
    await expectNoSeriousViolations(page)
  })
}

test('axe /pulls mobile, feuille « Plus » ouverte', async ({ page, login }) => {
  await login(); await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Plus' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoSeriousViolations(page)
})

test('axe /pulls, panneau des notifications ouvert (3 notifications, dont une lue)', async ({ page, login }) => {
  const { uid } = await login()
  try {
    sql(`insert into public.notifications (user_id, type, data, read)
select :'uid', 'trade_received', jsonb_build_object('trade_id', gen_random_uuid(), 'user_id', gen_random_uuid(), 'username', 'Alice'), i = 3
from generate_series(1, 3) i`, { uid })
    await page.goto('/pulls')
    await expect(page.locator('button[aria-label="Notifications"] + span')).toHaveText('2')
    await page.locator('button[aria-label="Notifications"]').click()
    await expect(page.getByRole('dialog', { name: 'Notifications' }).getByRole('listitem')).toHaveCount(3)
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id = :'uid'`, { uid })
  }
})

test('axe /pulls en révélation', async ({ page, login }) => {
  await login({ humanVerified: true })
  await page.goto('/pulls')
  await page.getByRole('button', { name: 'Ouvrir', exact: true }).click()
  await expect(page.getByText('Carte 1 / 5', { exact: true })).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
})

// Collection garnie : une copie de chaque rareté (2 de C), pour que la grille, les pastilles et la modale aient de quoi s'afficher.
async function collection(page: Page, login: () => Promise<{ uid: string }>) {
  const { uid } = await login()
  sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards
where right(wikipedia_title, 4) in ('0001', '0007', '0031', '0121', '0401', '1001', '1002')`, { uid })
  await page.goto('/collection')
  await expect(page.locator('div.relative.isolate.group')).toHaveCount(7)
  await settled(page)
}

test('axe /collection : grille, pastille de rareté active, sélection', async ({ page, login }) => {
  await collection(page, login)
  await expectNoSeriousViolations(page)
  // Un filtre posé : les autres pastilles passent à l'état inactif.
  await page.getByRole('button', { name: 'L', exact: true }).click()
  await expect(page.locator('div.relative.isolate.group')).toHaveCount(1)
  await expectNoSeriousViolations(page)
  await page.getByRole('button', { name: 'Sélectionner', exact: true }).click()
  await page.getByRole('button', { name: 'Tout sélectionner' }).click()
  await expectNoSeriousViolations(page)
  // Confirmation de la défausse en masse ouverte (bouton rouge, D§8.6).
  await page.getByRole('button', { name: 'Défausser', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Défausser 1 carte ?' })).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
})

test('axe /collection, modale de carte ouverte', async ({ page, login }) => {
  await collection(page, login)
  await page.locator('div.relative.isolate.group h3 button').first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
})

test('axe /collection, liste d\'étiquettes ouverte', async ({ page, login }) => {
  await collection(page, login)
  await page.locator('div.relative.isolate.group h3 button').first().click()
  await page.getByPlaceholder('Ajouter une étiquette…').fill('t')
  await expect(page.getByRole('listbox')).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page, TAG_OPTION)
})

test('axe /global-collection : modale de carte ouverte, liste de souhaits vide, recherche active', async ({ page, login }) => {
  await login()
  await page.goto('/global-collection')
  const cards = page.locator('main div.flex.flex-wrap.justify-center.gap-3 > div[class*="glow-"]')
  await expect(cards).toHaveCount(50)
  await cards.first().locator('h3 button').click()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Ajouter à ma liste de souhaits' })).toBeVisible()
  await settled(page)
  await expectNoSeriousViolations(page)
  await page.keyboard.press('Escape')
  // Bascule pressée (plein émeraude) et état vide de la liste.
  await page.getByRole('button', { name: 'Liste de souhaits', exact: true }).click()
  await expect(page.getByText('Ta liste de souhaits est vide', { exact: true })).toBeVisible()
  await expectNoSeriousViolations(page)
  await page.getByRole('searchbox', { name: 'Rechercher une carte' }).fill('x')
  await page.getByRole('button', { name: 'Rechercher', exact: true }).click()
  await expect(page.locator('main').getByRole('alert')).toBeVisible()
  await expectNoSeriousViolations(page)
})

// Pastille « ami possède » en lien (M4b-21) : sa boîte de 44 px passe target-size (wcag22aa).
test('axe /global-collection, pastille d\'un ami', async ({ page, login }) => {
  const me = await login()
  const friend = makePlayer()
  try {
    befriend(friend, me)
    sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where wikipedia_title = 'Article d''essai n° 0001'`, { uid: friend.uid })
    await page.goto('/global-collection')
    await page.locator('main a[href^="/profile/"]').waitFor()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'f')`, { me: me.uid, f: friend.uid })
  }
})

// Tuile du contrat (R§6.8) attendue avant l'analyse : une enchère d'une carte neuve, filtrée par son titre ; tout est supprimé à la fin.
test('axe /marketplace : tuile d\'une enchère créée par sql', async ({ page, login }) => {
  const { uid } = await login()
  const seller = makePlayer({ humanVerified: true })
  const t = `Zz marché e2e ${randomUUID().slice(-12)}`
  const card = sql(`insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
values (:'t', 'https://fr.wikipedia.org/wiki/' || replace(:'t', ' ', '_'), 'SR', 100, 100, 'Essai', 'Résumé') returning id`, { t })
  try {
    const id = sql(`select from wm.grant_copy(:'s', :'card', true) \\g /dev/null
select wm.create_auction(:'s', :'card', 100, 60) ->> 'id'`, { s: seller.uid, card })
    await page.goto('/marketplace')
    await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).fill(t)
    await page.getByRole('searchbox', { name: 'Rechercher une enchère' }).press('Enter')
    await page.locator(`[id="marketplace-auction-${id}"]`).filter({ visible: true }).waitFor()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'uid', :'s');
delete from public.cards where id = :'card'`, { uid, s: seller.uid, card })
  }
})

test('axe /marketplace/<id> : détail d\'une enchère créée par sql, avec une mise', async ({ page, login }) => {
  const { uid } = await login()
  const seller = makePlayer({ humanVerified: true })
  const bidder = makePlayer({ balance: 100, humanVerified: true })
  const t = `Zz marché e2e ${randomUUID().slice(-12)}`
  const card = sql(`insert into public.cards (wikipedia_title, wikipedia_url, rarity, atk, def, category, summary)
values (:'t', 'https://fr.wikipedia.org/wiki/' || replace(:'t', ' ', '_'), 'SR', 100, 100, 'Essai', 'Résumé') returning id`, { t })
  try {
    const id = sql(`select from wm.grant_copy(:'s', :'card', true) \\g /dev/null
select wm.create_auction(:'s', :'card', 10, 60) ->> 'id' as id \\gset
select from wm.place_bid(:'b', :'id', 10) \\g /dev/null
\\echo :id`, { s: seller.uid, b: bidder.uid, card })
    await page.goto(`/marketplace/${id}`)
    await expect(page.locator('main h1')).toHaveText(t)
    await expect(page.getByRole('list', { name: 'Historique des mises' }).getByRole('listitem')).toHaveCount(1)
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'uid', :'s', :'b');
delete from public.cards where id = :'card'`, { uid, s: seller.uid, b: bidder.uid, card })
  }
})

test('axe /friends : une demande reçue et un ami, puis la modale de retrait', async ({ page, login }) => {
  const me = await login()
  const [asker, friend] = [makePlayer(), makePlayer()]
  try {
    sql(`insert into public.friendships (requester_id, addressee_id) values (:'a', :'me')`, { a: asker.uid, me: me.uid })
    befriend(friend, me)
    await page.goto('/friends')
    await page.locator(READY['/friends']).waitFor()
    await expect(page.locator('main section li')).toHaveCount(2)
    await expectNoSeriousViolations(page)
    await page.locator('main section li').filter({ hasText: friend.username }).getByRole('button', { name: 'Retirer' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'a', :'f')`, { me: me.uid, a: asker.uid, f: friend.uid })
  }
})

test('axe /profile/<pseudo> : soi, un ami à la vitrine garnie, un profil privé, puis la modale de signalement ouverte', async ({ page, login }) => {
  const me = await login()
  const [friend, hidden] = [makePlayer(), makePlayer()]
  try {
    befriend(me, friend)
    sql(`insert into public.showcase (user_id, position, user_card_id) values (:'uid', 0, :'copy')`, { uid: friend.uid, copy: imageCopy(friend) })
    sql(`update public.profiles set is_public = false where id = :'uid'`, { uid: hidden.uid })
    for (const u of [me, friend, hidden]) {
      await page.goto(`/profile/${encodeURIComponent(u.username)}`)
      await page.locator(READY['/profile/[username]']).waitFor()
      await expect(page.locator('main h1')).toHaveText(u.username)
      await expectNoSeriousViolations(page)
    }
    await page.getByRole('button', { name: 'Signaler' }).click()
    await expect(page.getByRole('dialog').getByRole('group', { name: 'Motif' })).toBeVisible()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'f', :'h')`, { me: me.uid, f: friend.uid, h: hidden.uid })
  }
})

test('axe /profile : deux emplacements remplis, puis le sélecteur d\'avatar ouvert (une copie à image, une « Sans image »)', async ({ page, login }) => {
  const me = await login()
  try {
    for (const position of ['0', '1']) {
      sql(`insert into public.showcase (user_id, position, user_card_id) values (:'uid', :'p'::int, :'copy')`, { uid: me.uid, p: position, copy: imageCopy(me) })
    }
    giveCopies(me, 'C')
    await page.goto('/profile')
    await page.locator(READY['/profile']).waitFor()
    await expect(page.getByRole('region', { name: 'Vitrine (2/4)' })).toBeVisible()
    await expectNoSeriousViolations(page)
    await page.getByRole('button', { name: 'Changer l\'avatar' }).click()
    const dialog = page.getByRole('dialog', { name: 'Choisir ton avatar' })
    await expect(dialog.locator('div[class*="glow-"]')).toHaveCount(3)
    await expect(dialog.getByText('Sans image', { exact: true })).toBeVisible()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id = :'me'`, { me: me.uid })
  }
})

test('axe /dms : deux conversations, l\'une à deux non lus', async ({ page, login }) => {
  const me = await login()
  const [a, b] = [makePlayer(), makePlayer()]
  try {
    befriend(me, a)
    befriend(me, b)
    sql(`insert into public.chat_messages (sender_id, recipient_id, content) values (:'me', :'b', 'Pour B'), (:'a', :'me', 'Un'), (:'a', :'me', 'Deux')`,
      { me: me.uid, a: a.uid, b: b.uid })
    await page.goto('/dms')
    await page.locator(READY['/dms']).waitFor()
    await expect(page.getByRole('list', { name: 'Conversations' }).getByRole('listitem')).toHaveCount(2)
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'a', :'b')`, { me: me.uid, a: a.uid, b: b.uid })
  }
})

// Le fil : div[role=log] et son ol sans rôle (un ol au rôle log perdrait sa sémantique de liste, et chaque li lèverait listitem).
test('axe /dms?with=<ami> : dix messages', async ({ page, login }) => {
  const me = await login()
  const friend = makePlayer()
  try {
    befriend(me, friend)
    sql(`insert into public.chat_messages (sender_id, recipient_id, content)
select case when i % 2 = 0 then :'me' else :'f' end::uuid, case when i % 2 = 0 then :'f' else :'me' end::uuid, 'Message ' || i
from generate_series(1, 10) i`, { me: me.uid, f: friend.uid })
    await page.goto(`/dms?with=${friend.uid}`)
    await page.locator(READY['/dms']).waitFor()
    await expect(page.getByRole('log').getByRole('listitem').filter({ hasText: 'Message ' })).toHaveCount(10)
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'f')`, { me: me.uid, f: friend.uid })
  }
})

test('axe /battle : une bataille par onglet (en attente, retirée), puis l\'aide ouverte', async ({ page, login }) => {
  const me = await login()
  const [a, b] = [makePlayer(), makePlayer()]
  try {
    befriend(me, a)
    befriend(me, b)
    sql(`select wm.battle_create(:'me', :'a') \\g /dev/null
select wm.battle_create(:'me', :'b') ->> 'id' as id \\gset
select from wm.battle_action(:'me', :'id', 'withdraw_invite')`, { me: me.uid, a: a.uid, b: b.uid })
    await page.goto('/battle')
    await page.locator(READY['/battle']).waitFor()
    for (const name of ['En cours', 'Terminées']) {
      await page.getByRole('tab', { name }).click()
      await expect(page.getByRole('tabpanel').getByRole('link')).toHaveCount(1)
      await expectNoSeriousViolations(page)
    }
    await page.getByRole('button', { name: 'Comment ça marche ?' }).click()
    await expect(page.getByRole('dialog', { name: 'Comment ça marche ?' })).toBeVisible()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'a', :'b')`, { me: me.uid, a: a.uid, b: b.uid })
  }
})

// Écart de contrat connu, comme R21 (à consigner pour le M7) : l'offre de R§6.8 garde le nom figé « Voir le détail de l'échange » sur un
// bouton qui contient « De <pseudo> », le statut, la date et les colonnes ; axe y lève label-content-name-mismatch (WCAG 2.5.3). Les
// offres se distinguent par aria-describedby (M4-15).
const TRADE_OFFER: Known = { rule: 'label-content-name-mismatch', selector: 'div.card-frame.p-4 > button[aria-label="Voir le détail de l\'échange"]' }

// Échange de `from` vers `to` par wm.create_trade : une copie de chacun ; renvoie son id.
const trade = (from: { uid: string; username: string }, to: { uid: string; username: string }) =>
  sql(`select wm.create_trade(:'a', :'b', (select jsonb_agg(jsonb_build_object('user_card_id', id, 'card_id', card_id, 'offered_by', user_id))
from public.user_cards where id in (:'x', :'y'))) ->> 'id'`, { a: from.uid, b: to.uid, x: giveCopies(from, 'SR')[0], y: giveCopies(to, 'C')[0] })

test('axe /trades : une offre par onglet (reçue, envoyée, refusée)', async ({ page, login }) => {
  const me = await login()
  const friend = makePlayer()
  try {
    befriend(me, friend)
    trade(friend, me)
    trade(me, friend)
    sql(`select wm.trade_action(:'me', :'t', 'decline')`, { me: me.uid, t: trade(friend, me) })
    await page.goto('/trades')
    await page.locator('main [data-ready]').waitFor()
    for (const name of ['Reçues', 'Envoyées', 'Historique']) {
      await page.getByRole('tab', { name }).click()
      await expect(page.getByRole('tabpanel').locator('div.card-frame.p-4')).toHaveCount(1)
      await expectNoSeriousViolations(page, TRADE_OFFER)
    }
  } finally {
    sql(`delete from auth.users where id in (:'me', :'f')`, { me: me.uid, f: friend.uid })
  }
})

test('axe /trades/<id> : détail d\'une offre reçue, ses actions', async ({ page, login }) => {
  const me = await login()
  const friend = makePlayer()
  try {
    befriend(me, friend)
    await page.goto(`/trades/${trade(friend, me)}`)
    await page.locator('main [data-ready]').waitFor()
    await expect(page.getByRole('button', { name: 'Accepter' })).toBeVisible()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'f')`, { me: me.uid, f: friend.uid })
  }
})

test('axe /trades/new?with=<id> : deux panneaux garnis, une copie engagée, un choix', async ({ page, login }) => {
  const me = await login()
  const friend = makePlayer()
  try {
    befriend(me, friend)
    trade(me, friend)
    await page.goto(`/trades/new?with=${friend.uid}`)
    await page.locator(READY['/trades/new']).waitFor()
    await expect(page.locator('main').getByText('Déjà dans un échange')).toBeVisible()
    await expectNoSeriousViolations(page)
    await page.getByRole('region', { name: /^Tu demandes/ }).getByRole('spinbutton').fill('1')
    await expect(page.getByRole('list', { name: 'Tes choix' })).toBeVisible()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id in (:'me', :'f')`, { me: me.uid, f: friend.uid })
  }
})

test('axe /settings : section push active (« Messages » cochée, puis « Activer sur cet appareil »)', async ({ page, login }) => {
  const { uid } = await login()
  try {
    await stubPush(page)
    await page.goto('/settings')
    await page.locator(READY['/settings']).waitFor()
    const saved = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/settings/notifications')
    await page.getByRole('checkbox', { name: 'Messages', exact: true }).check()
    await saved
    await page.getByRole('button', { name: 'Activer sur cet appareil' }).click()
    await expect(page.getByText('Notifications activées sur cet appareil.', { exact: true })).toBeVisible()
    await expectNoSeriousViolations(page)
  } finally {
    sql(`delete from auth.users where id = :'uid'`, { uid })
  }
})

test('axe /settings : erreurs affichées (pseudo pris, mots de passe différents)', async ({ page, login }) => {
  await login()
  const { username } = makePlayer()
  await page.goto('/settings')
  await page.getByLabel('Pseudo', { exact: true }).fill(username)
  await page.getByLabel('Pseudo', { exact: true }).blur()
  await expect(page.getByText('Ce pseudo est déjà pris', { exact: true })).toBeVisible()
  await page.getByLabel('Nouveau mot de passe', { exact: true }).fill('abcdef')
  await page.getByLabel('Confirme le nouveau mot de passe').fill('abcdeg')
  await page.getByRole('button', { name: 'Changer le mot de passe' }).click()
  await expect(page.getByText('Les deux mots de passe ne correspondent pas.', { exact: true })).toBeVisible()
  await expect(page.locator('input[name="sounds"]')).toBeVisible()
  await expectNoSeriousViolations(page)
})
