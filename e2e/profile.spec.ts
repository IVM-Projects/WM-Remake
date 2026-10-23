import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { formatMonthYear } from '../lib/format.ts'
import { befriend, expect, giveCopies, hydrated, imageCopy, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (amitiés, copies, vitrine et signalements suivent).
const trash: string[] = []
test.afterEach(() => void sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') }))

type User = { uid: string; username: string }
const player = (opts?: Parameters<typeof makePlayer>[0]): User => {
  const u = makePlayer(opts)
  trash.push(u.uid)
  return u
}
const viewer = async (login: () => Promise<User>): Promise<User> => {
  const u = await login()
  trash.push(u.uid)
  return u
}

// Le pseudo lu en clair est encodé dans l'adresse (comme la pastille de /global-collection).
const at = (username: string) => `/profile/${encodeURIComponent(username)}`
// data-ready : le profil lu et, quand la vue est permise, sa vitrine et ses raretés, ou l'échec.
async function open(page: Page, username: string) {
  await page.goto(at(username))
  await page.locator('main [data-ready]').waitFor()
}
// Cache Components garde les pages quittées dans le DOM (display: none) : seul le h1 visible compte.
const h1 = (page: Page) => page.locator('main h1').filter({ visible: true })
const toasts = (page: Page) => page.locator('#wm-toasts')
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Vues du profil' })
const panel = (page: Page) => page.getByRole('tabpanel')
const grid = (page: Page) => panel(page).locator('div[class*="glow-"]')
const dialogFor = (page: Page, u: User) => page.getByRole('dialog', { name: `Signaler ${u.username}` })
const showcase = (u: User, copy: string) =>
  sql(`insert into public.showcase (user_id, position, user_card_id) values (:'uid', 0, :'copy')`, { uid: u.uid, copy })
const titleOf = (copy: string) =>
  sql(`select k.wikipedia_title from public.user_cards uc join public.cards k on k.id = uc.card_id where uc.id = :'copy'`, { copy })
// Demande en attente de `from` vers `to`, posée par SQL.
const ask = (from: User, to: User) =>
  sql(`insert into public.friendships (requester_id, addressee_id) values (:'r', :'a')`, { r: from.uid, a: to.uid })
const hide = (u: User) => sql(`update public.profiles set is_public = false where id = :'uid'`, { uid: u.uid })
const reportOf = (from: User, to: User) => sql(`select coalesce(string_agg(reason || ':' || coalesce(details, '<null>'), ','), '')
from public.reports where reporter_id = :'f' and reported_user_id = :'t'`, { f: from.uid, t: to.uid })
const FAILS = [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const
const LOAD_FAILED = 'Impossible de charger cette page.'

test('soi : h1 = son pseudo, « Membre depuis <mois année> », « Modifier mon profil » vers /profile, ni « Ajouter en ami » ni « Signaler »', async ({ page, login }) => {
  const me = await viewer(login)
  const since = sql(`select to_json(created_at) #>> '{}' from public.profiles where id = :'uid'`, { uid: me.uid })
  await open(page, me.username)
  await expect(h1(page)).toHaveText(me.username)
  await expect(page.getByText(`Membre depuis ${formatMonthYear(since)}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Modifier mon profil' })).toHaveAttribute('href', '/profile')
  await expect(tabs(page)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ajouter en ami' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Signaler' })).toHaveCount(0)
})

test('inconnu public, une copie en vitrine : sa Card, Entrée → la modale au titre de la carte, Échap → focus rendu ; « Collection » : la grille et « Page 1 »', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  const copy = imageCopy(owner)
  showcase(owner, copy)
  // 51 copies : deux pages de 50, donc la pagination.
  giveCopies(owner, 'C', 50)
  const title = titleOf(copy)
  await open(page, owner.username)
  await expect(tabs(page).getByRole('tab', { name: 'Vitrine' })).toHaveAttribute('aria-selected', 'true')
  await expect(grid(page)).toHaveCount(1)
  const card = panel(page).getByRole('button', { name: title, exact: true })
  await card.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(card).toBeFocused()
  await tabs(page).getByRole('tab', { name: 'Collection' }).click()
  await expect(grid(page)).toHaveCount(50)
  await expect(panel(page).getByText('Page 1 / 2', { exact: true })).toBeVisible()
  await expect(panel(page).getByRole('searchbox', { name: 'Rechercher dans sa collection' })).toBeVisible()
})

test('inconnu public : « Ajouter en ami » au clavier → toast, le focus sur « Demande envoyée »', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  await open(page, owner.username)
  const add = page.getByRole('button', { name: 'Ajouter en ami' })
  await add.focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText(`Demande envoyée à ${owner.username}.`)
  await expect(add).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('Demande envoyée')
})

test('réponse perdue sur « Ajouter en ami » : la relecture montre la demande ; retirée ailleurs, relue au retour, une demande neuve part', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  const keys: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/friends') keys.push(r.headers()['idempotency-key'] ?? '') })
  await open(page, owner.username)
  // Le serveur crée la demande, la réponse se perd : issue inconnue, apiOnce garde la clé.
  await routeOnce(page, '**/api/friends', async (route) => {
    await route.fetch()
    await route.abort()
  })
  await page.getByRole('button', { name: 'Ajouter en ami' }).click()
  await expect(toasts(page)).toContainText('L\'action n\'a pas été confirmée : elle a peut-être eu lieu.')
  await expect(page.getByText('Demande envoyée', { exact: true })).toBeVisible()
  sql(`delete from public.friendships where addressee_id = :'o'`, { o: owner.uid })
  // Relu au réaffichage (Activity) : la relecture réussie a oublié la clé gardée, qui rejouerait le succès stocké sans rien créer.
  const nav = page.locator('nav a[href="/collection"]').first()
  await hydrated(nav)
  await nav.click()
  await expect(page).toHaveURL('/collection')
  await page.goBack()
  await page.getByRole('button', { name: 'Ajouter en ami' }).click()
  await expect(toasts(page)).toContainText(`Demande envoyée à ${owner.username}.`)
  await expect(page.getByText('Demande envoyée', { exact: true })).toBeVisible()
  expect(sql(`select count(*) from public.friendships where addressee_id = :'o'`, { o: owner.uid })).toBe('1')
  expect(keys).toHaveLength(2)
  expect(keys[1]).not.toBe(keys[0])
})

test('inconnu privé : « Ce profil est réservé aux amis. », aucun onglet, ni vitrine ni collection lues ; « Ajouter en ami »', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  hide(owner)
  const reads: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (path.startsWith('/api/profile/')) reads.push(path)
  })
  await open(page, owner.username)
  await expect(page.getByText('Ce profil est réservé aux amis.', { exact: true })).toBeVisible()
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Ajouter en ami' })).toBeVisible()
  // Le temps qu'une lecture de plus parte si la page la faisait ; la lecture du profil, vue, prouve l'écoute.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  expect(reads).toEqual([`/api/profile/${owner.username}`])
})

test('demande reçue d\'un joueur au profil privé : aucun onglet ; « Accepter sa demande » → toast, les onglets et les raretés, le focus sur « Message »', async ({ page, login }) => {
  const me = await viewer(login)
  const other = player()
  hide(other)
  ask(other, me)
  await open(page, other.username)
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await page.getByRole('button', { name: 'Accepter sa demande' }).click()
  await expect(toasts(page)).toContainText(`${other.username} fait maintenant partie de tes amis.`)
  await expect(tabs(page)).toBeVisible()
  await expect(page.getByRole('list', { name: 'Cartes par rareté' }).getByRole('listitem')).toHaveCount(6)
  await expect(page.getByRole('link', { name: 'Message', exact: true })).toBeFocused()
})

test('ami : « Message » vers /dms?with=<id>, « Proposer un échange » vers /trades/new?with=<id>, et « Signaler »', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  befriend(me, friend)
  await open(page, friend.username)
  await expect(page.getByRole('link', { name: 'Message', exact: true })).toHaveAttribute('href', `/dms?with=${friend.uid}`)
  await expect(page.getByRole('link', { name: 'Proposer un échange' })).toHaveAttribute('href', `/trades/new?with=${friend.uid}`)
  await expect(page.getByRole('button', { name: 'Signaler' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ajouter en ami' })).toHaveCount(0)
})

test('signalement au clavier : un seul arrêt de tabulation pour le motif, flèches, détails, envoi ; rouvert, prérempli', async ({ page, login }) => {
  const me = await viewer(login)
  const target = player()
  await open(page, target.username)
  const report = page.getByRole('button', { name: 'Signaler' })
  const read = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/reports' && r.request().method() === 'GET')
  await report.focus()
  await page.keyboard.press('Enter')
  const dialog = dialogFor(page, target)
  await expect(dialog).toBeVisible()
  await read
  const reason = dialog.getByRole('group', { name: 'Motif' })
  await expect(reason).toBeVisible()
  // Aucun motif coché : le groupe est un seul arrêt, sur « Triche ».
  await page.keyboard.press('Tab')
  await expect(reason.getByRole('radio', { name: 'Triche' })).toBeFocused()
  // Dans un groupe de radios de même name, les flèches déplacent le focus en cochant.
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(reason.getByRole('radio', { name: 'Spam' })).toBeChecked()
  await expect(reason.getByRole('radio', { name: 'Spam' })).toBeFocused()
  await page.keyboard.press('Tab')
  const details = dialog.getByRole('textbox', { name: 'Détails (facultatif)' })
  await expect(details).toBeFocused()
  await page.keyboard.type('pub')
  await expect(dialog.getByText('3 / 500', { exact: true })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Envoyer le signalement' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Signalement envoyé.')
  await expect(dialog).toHaveCount(0)
  await expect(report).toBeFocused()
  expect(reportOf(me, target)).toBe('spam:pub')
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('radio', { name: 'Spam' })).toBeChecked()
  await expect(details).toHaveValue('pub')
  await expect(dialog.getByRole('button', { name: 'Modifier le signalement' })).toBeVisible()
})

// Ruling Task 8 → 11 : details refuse null au corps ; prérempli d'un GET qui rend details: null, l'envoi omet la clé.
test('signalement existant aux détails nuls (sql) : motif changé, envoi sans details → 200, « Signalement modifié. »', async ({ page, login }) => {
  const me = await viewer(login)
  const target = player()
  sql(`insert into public.reports (reporter_id, reported_user_id, reason) values (:'me', :'t', 'cheating')`, { me: me.uid, t: target.uid })
  await open(page, target.username)
  await page.getByRole('button', { name: 'Signaler' }).click()
  const dialog = dialogFor(page, target)
  await expect(dialog.getByRole('radio', { name: 'Triche' })).toBeChecked()
  await expect(dialog.getByRole('textbox', { name: 'Détails (facultatif)' })).toHaveValue('')
  await dialog.getByRole('radio', { name: 'Contenu inapproprié' }).check()
  const sent = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/reports' && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Modifier le signalement' }).click()
  const res = await sent
  expect(res.status()).toBe(200)
  expect(res.request().postDataJSON()).toEqual({ reportedUserId: target.uid, reason: 'inappropriate_content' })
  await expect(toasts(page)).toContainText('Signalement modifié.')
  expect(reportOf(me, target)).toBe('inappropriate_content:<null>')
})

test('signalement à la réponse perdue : le texte de l\'issue incertaine dans la modale ; renvoyé, la même clé, un seul signalement', async ({ page, login }) => {
  const me = await viewer(login)
  const target = player()
  const keys: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/reports') keys.push(r.headers()['idempotency-key'] ?? '')
  })
  await open(page, target.username)
  await page.getByRole('button', { name: 'Signaler' }).click()
  const dialog = dialogFor(page, target)
  await dialog.getByRole('radio', { name: 'Spam' }).check()
  // Le serveur enregistre, la réponse se perd : issue inconnue, apiOnce garde la clé.
  await routeOnce(page, (u) => u.pathname === '/api/reports', async (route) => {
    await route.fetch()
    await route.abort()
  }, (r) => r.request().method() === 'POST')
  const send = dialog.getByRole('button', { name: 'Envoyer le signalement' })
  await send.click()
  await expect(dialog.getByRole('alert')).toHaveText('L\'action n\'a pas été confirmée : elle a peut-être eu lieu.')
  await expect(send).not.toHaveAttribute('aria-disabled')
  await send.click()
  await expect(toasts(page)).toContainText('Signalement envoyé.')
  await expect(dialog).toHaveCount(0)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
  expect(reportOf(me, target)).toBe('spam:<null>')
})

test('Review Focus, pseudo hérité : renommé Élise Ü, a%b puis x?y#z (sql) → /profile/<encodeURIComponent>, le h1 à ce nom, vitrine et collection lues', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  for (const base of ['Élise Ü', 'a%b', 'x?y#z']) {
    // Suffixe aléatoire : l'index unique sur lower(username) vaut pour les workers parallèles.
    const name = `${base} ${randomUUID().slice(-6)}`
    sql(`update public.profiles set username = :'name' where id = :'uid'`, { name, uid: owner.uid })
    await open(page, name)
    await expect(h1(page)).toHaveText(name)
    // Le paramètre arrive encodé et n'est pas réencodé : un second encodage ferait un 404 sur la vitrine, les raretés et la collection.
    await expect(panel(page).getByText('Aucune carte en vitrine.', { exact: true })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Cartes par rareté' })).toBeVisible()
    await tabs(page).getByRole('tab', { name: 'Collection' }).click()
    await expect(panel(page).getByText('Sa collection est vide.', { exact: true })).toBeVisible()
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  }
})

test('/profile/<pseudo inconnu> → « Joueur introuvable » et « Retour aux amis »', async ({ page, login }) => {
  await viewer(login)
  await open(page, `x_${randomUUID().slice(-12)}`)
  await expect(h1(page)).toHaveText('Joueur introuvable')
  await expect(page.getByRole('link', { name: 'Retour aux amis' })).toHaveAttribute('href', '/friends')
})

test('lecture en échec puis « Réessayer » sur un pseudo inconnu : le focus sur « Joueur introuvable »', async ({ page, login }) => {
  await viewer(login)
  await routeOnce(page, '**/api/profile/*', (r) => r.fulfill({ status: 500 }))
  await open(page, `x_${randomUUID().slice(-12)}`)
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(h1(page)).toHaveText('Joueur introuvable')
  await expect(h1(page)).toBeFocused()
})

for (const [label, reply] of FAILS) {
  test(`lecture du profil en échec (${label}) : l'alerte et « Réessayer », sans « Joueur introuvable » ; « Réessayer » → le h1 au pseudo, focalisé`, async ({ page, login }) => {
    await viewer(login)
    const owner = player()
    await routeOnce(page, '**/api/profile/*', (r) => r.fulfill(reply))
    await open(page, owner.username)
    await expect(page.locator('main').getByRole('alert')).toHaveText(LOAD_FAILED)
    await expect(page.getByText('Joueur introuvable')).toHaveCount(0)
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await expect(h1(page)).toHaveText(owner.username)
    await expect(h1(page)).toBeFocused()
  })

  // La vitrine et les raretés (collection?stats=1) sont lues ensemble après le profil : l'échec de l'une ou l'autre est celui du panneau.
  for (const [what, url] of [
    ['vitrine', '**/api/profile/*/showcase'],
    ['raretés', (u: URL) => u.pathname.endsWith('/collection') && u.searchParams.get('stats') === '1'],
  ] as const) {
    test(`lecture de la ${what} en échec (${label}) : l'alerte et « Réessayer » dans « Vitrine », l'identité reste, data-ready ; « Réessayer » → la Card`, async ({ page, login }) => {
      await viewer(login)
      const owner = player()
      const copy = imageCopy(owner)
      showcase(owner, copy)
      await routeOnce(page, url, (r) => r.fulfill(reply))
      await open(page, owner.username)
      await expect(tabs(page).getByRole('tab', { name: 'Vitrine' })).toHaveAttribute('aria-selected', 'true')
      await expect(panel(page).getByRole('alert')).toHaveText(LOAD_FAILED)
      await expect(page.getByText(/^Membre depuis /)).toBeVisible()
      await panel(page).getByRole('button', { name: 'Réessayer' }).click()
      await expect(panel(page).getByRole('button', { name: titleOf(copy), exact: true })).toBeVisible()
      await expect(h1(page)).toBeFocused()
    })
  }

  test(`lecture de l'onglet « Collection » en échec (${label}) : l'alerte et « Réessayer » dans le panneau ; « Réessayer » → la grille`, async ({ page, login }) => {
    await viewer(login)
    const owner = player()
    giveCopies(owner, 'C')
    await open(page, owner.username)
    await routeOnce(page, (u) => u.pathname.endsWith('/collection'), (r) => r.fulfill(reply))
    await tabs(page).getByRole('tab', { name: 'Collection' }).click()
    await expect(panel(page).getByRole('alert')).toHaveText(LOAD_FAILED)
    await panel(page).getByRole('button', { name: 'Réessayer' }).click()
    await expect(grid(page)).toHaveCount(1)
    await expect(h1(page)).toBeFocused()
  })

  test(`lecture du signalement en échec (${label}) : l'alerte et « Réessayer » à la place du formulaire ; « Réessayer » → le motif, le focus sur le titre`, async ({ page, login }) => {
    await viewer(login)
    const target = player()
    await open(page, target.username)
    await routeOnce(page, '**/api/reports*', (r) => r.fulfill(reply), (r) => r.request().method() === 'GET')
    await page.getByRole('button', { name: 'Signaler' }).click()
    const dialog = dialogFor(page, target)
    await expect(dialog.getByRole('alert')).toHaveText(LOAD_FAILED)
    await expect(dialog.getByRole('group', { name: 'Motif' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Réessayer' }).click()
    await expect(dialog.getByRole('group', { name: 'Motif' })).toBeVisible()
    await expect(dialog.getByRole('heading', { name: `Signaler ${target.username}` })).toBeFocused()
  })
}

test('360 px, un ami au pseudo de 24 caractères et à la bio d\'un seul mot de 280 caractères : aucun défilement horizontal ; cibles ≥ 44 px', async ({ page, login }) => {
  const me = await viewer(login)
  const long = player({ username: `w${randomUUID().replaceAll('-', '').slice(0, 23)}` })
  expect(long.username).toHaveLength(24)
  const bio = 'b'.repeat(280)
  sql(`update public.profiles set bio = :'bio' where id = :'uid'`, { bio, uid: long.uid })
  befriend(me, long)
  showcase(long, imageCopy(long))
  await page.setViewportSize({ width: 360, height: 800 })
  await open(page, long.username)
  await expect(page.getByText(bio, { exact: true })).toBeVisible()
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const main = page.locator('main')
  const targets = main.getByRole('button').or(main.getByRole('link', { name: /^(Message|Proposer un échange)$/ })).or(main.getByRole('tab'))
  // Message, Proposer un échange, Signaler, Vitrine, Collection, la carte de la vitrine.
  await expect(targets).toHaveCount(6)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
  }
  // Titre de la modale au pseudo sans coupure : il passe à la ligne, la boîte ne déborde pas.
  await page.getByRole('button', { name: 'Signaler' }).click()
  const dialog = dialogFor(page, long)
  await expect(dialog.getByRole('group', { name: 'Motif' })).toBeVisible()
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true)
})

// PF17 : la page gardée par Activity relit son profil à chaque affichage.
test('réaffichage par Activity : retour sur le profil → un nouveau GET /api/profile/<pseudo>, la bio changée entre-temps affichée', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  await open(page, owner.username)
  const nav = page.locator('nav a[href="/collection"]').first()
  await hydrated(nav)
  // Marqueur du document : un rechargement complet l'efface, et la page gardée par Activity avec lui.
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/collection')
  sql(`update public.profiles set bio = 'Relue au retour' where id = :'uid'`, { uid: owner.uid })
  const reread = page.waitForRequest((r) => new URL(r.url()).pathname === `/api/profile/${owner.username}`)
  await page.goBack()
  await expect(page).toHaveURL(at(owner.username))
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await reread
  await expect(page.getByText('Relue au retour', { exact: true })).toBeVisible()
})

// PF2 (porté de la Task 7) : seule preuve que le stopPropagation de la pastille garde la modale de carte fermée.
test('pastille « ami possède » de /global-collection : clic → le profil au pseudo encodé ; goBack() → aucune modale ouverte', async ({ page, login }) => {
  const me = await viewer(login)
  const friend = player()
  const name = `Élise Ü ${randomUUID().slice(-8)}`
  sql(`update public.profiles set username = :'name' where id = :'id'`, { name, id: friend.uid })
  befriend(me, friend)
  // La première carte de la page 0, dans l'ordre du catalogue.
  sql(`insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where id = (wm.cards_page_shared() -> 'cards' -> 0 ->> 'id')::uuid`,
  { uid: friend.uid })
  await page.goto('/global-collection')
  const chip = page.locator('main div.flex.flex-wrap.justify-center.gap-3 > div[class*="glow-"]').first()
    .getByRole('link', { name: `Profil de ${name}`, exact: true })
  await hydrated(chip)
  await chip.click()
  await expect(page).toHaveURL(at(name))
  await expect(h1(page)).toHaveText(name)
  await page.goBack()
  await expect(page).toHaveURL('/global-collection')
  await expect(h1(page)).toHaveText('Collection Globale')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
