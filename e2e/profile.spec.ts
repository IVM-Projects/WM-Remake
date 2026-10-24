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
const showcase = (u: User, copy: string, position = 0) =>
  sql(`insert into public.showcase (user_id, position, user_card_id) values (:'uid', :'p'::int, :'copy')`, { uid: u.uid, copy, p: String(position) })
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
  // Média de l'image (D§3.4) : la modale ouverte depuis la vitrine en donne l'auteur et la licence.
  sql(`insert into wm.card_media (card_id, file, author, license, license_url)
select card_id, 'Zz.jpg', 'Jean Dupont', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0' from public.user_cards where id = :'copy'`, { copy })
  await open(page, owner.username)
  await expect(tabs(page).getByRole('tab', { name: 'Vitrine' })).toHaveAttribute('aria-selected', 'true')
  await expect(grid(page)).toHaveCount(1)
  const card = panel(page).getByRole('button', { name: title, exact: true })
  await card.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: title })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Texte de l\'article : CC BY-SA 4.0 — crédits sur la page Wikipédia.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Image : Jean Dupont, CC BY-SA 4.0', { exact: true })).toBeVisible()
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

test('onglet « Collection », « Suivant » en échec : l\'alerte et « Réessayer » à la place de la grille, le focus sur « Réessayer », jamais body', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  imageCopy(owner)
  giveCopies(owner, 'C', 50)
  await open(page, owner.username)
  await tabs(page).getByRole('tab', { name: 'Collection' }).click()
  await expect(grid(page)).toHaveCount(50)
  await routeOnce(page, (u) => u.pathname.endsWith('/collection') && u.searchParams.get('page') === '1', (r) => r.fulfill({ status: 500 }))
  await panel(page).getByRole('button', { name: 'Suivant' }).click()
  await expect(panel(page).getByRole('alert')).toHaveText(LOAD_FAILED)
  await expect(panel(page).getByRole('button', { name: 'Réessayer' })).toBeFocused()
})

test('profil passé privé après sa lecture : l\'onglet « Collection » (403) → « Ce profil est réservé aux amis. », plus d\'onglets, le focus sur le h1', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  giveCopies(owner, 'C')
  await open(page, owner.username)
  await expect(tabs(page)).toBeVisible()
  hide(owner)
  await tabs(page).getByRole('tab', { name: 'Collection' }).click()
  await expect(page.getByText('Ce profil est réservé aux amis.', { exact: true })).toBeVisible()
  await expect(tabs(page)).toHaveCount(0)
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  await expect(h1(page)).toBeFocused()
})

test('« Réessayer » de la vitrine pendant la relecture qui suit « Ajouter en ami » : cette relecture n\'est pas jetée, « Demande envoyée » s\'affiche', async ({ page, login }) => {
  await viewer(login)
  const owner = player()
  await routeOnce(page, '**/api/profile/*/showcase', (r) => r.fulfill({ status: 500 }))
  await open(page, owner.username)
  await expect(panel(page).getByRole('alert')).toHaveText(LOAD_FAILED)
  // Relecture du profil après l'action, retenue jusqu'au clic sur « Réessayer » du panneau.
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let seen = () => {}
  const fetched = new Promise<void>((r) => { seen = r })
  await routeOnce(page, (u) => u.pathname === `/api/profile/${owner.username}`, async (r) => {
    seen()
    await held
    await r.fallback()
  })
  await page.getByRole('button', { name: 'Ajouter en ami' }).click()
  await fetched
  await panel(page).getByRole('button', { name: 'Réessayer' }).click()
  release()
  await expect(page.getByText('Demande envoyée', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ajouter en ami' })).toHaveCount(0)
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

test('signalement : motif A puis B, chaque réponse perdue, puis A de nouveau → une clé neuve à chaque intention, la base tient A', async ({ page, login }) => {
  const me = await viewer(login)
  const target = player()
  const keys: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/reports') keys.push(r.headers()['idempotency-key'] ?? '')
  })
  await open(page, target.username)
  await page.getByRole('button', { name: 'Signaler' }).click()
  const dialog = dialogFor(page, target)
  const send = dialog.getByRole('button', { name: 'Envoyer le signalement' })
  for (const reason of ['Triche', 'Spam']) {
    // Le serveur enregistre, la réponse se perd : issue inconnue.
    await routeOnce(page, (u) => u.pathname === '/api/reports', async (route) => {
      await route.fetch()
      await route.abort()
    }, (r) => r.request().method() === 'POST')
    await dialog.getByRole('radio', { name: reason }).check()
    await send.click()
    await expect(dialog.getByRole('alert')).toHaveText(UNSURE)
  }
  expect(reportOf(me, target)).toBe('spam:<null>')
  // La clé gardée de Triche rejouerait sa réponse stockée (« Signalement envoyé. ») sans rien écrire : la base tiendrait Spam.
  await dialog.getByRole('radio', { name: 'Triche' }).check()
  await send.click()
  await expect(dialog).toHaveCount(0)
  expect(reportOf(me, target)).toBe('cheating:<null>')
  expect(new Set(keys).size).toBe(3)
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

// /profile : l'éditeur de son profil (Task 12).
const B10 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'
// data-ready : la ligne du profil et la vitrine lues, ou en échec.
async function edit(page: Page) {
  await page.goto('/profile')
  await page.locator('main [data-ready]').waitFor()
}
const region = (page: Page, name: string | RegExp) => page.getByRole('region', { name, exact: true })
const slot = (page: Page, position: number) => page.locator(`main [data-slot="${position}"]`)
const isPatch = (r: { request: () => { method: () => string } }) => r.request().method() === 'PATCH'
const profileApi = (u: URL) => u.pathname.startsWith('/api/profile/')
const patched = (page: Page) => page.waitForRequest((r) => r.method() === 'PATCH' && profileApi(new URL(r.url())))
// Lecture directe de sa ligne profiles (rest/v1), sans le contrôle préalable CORS.
const rowRead = (page: Page) => page.waitForResponse((r) => new URL(r.url()).pathname === '/rest/v1/profiles' && r.request().method() === 'GET')
const column = (u: User, col: 'bio' | 'is_public' | 'avatar_url') =>
  sql(`select coalesce(${col}::text, '<null>') from public.profiles where id = :'uid'`, { uid: u.uid })
const slots = (u: User) =>
  sql(`select coalesce(string_agg(position || ':' || user_card_id, ',' order by position), '') from public.showcase where user_id = :'uid'`, { uid: u.uid })
const addAt = (page: Page, n: number) => page.getByRole('button', { name: `Ajouter une carte à l'emplacement ${n}`, exact: true })

test('/profile : h1 « Profil », titre « Profil — », « Voir comme les autres » vers /profile/<pseudo hérité encodé>, quatre sections', async ({ page, login }) => {
  const me = await viewer(login)
  const name = `x?y#z %b ${randomUUID().slice(-6)}`
  sql(`update public.profiles set username = :'name' where id = :'uid'`, { name, uid: me.uid })
  await edit(page)
  await expect(h1(page)).toHaveText('Profil')
  await expect(page).toHaveTitle(/^Profil — /)
  await expect(page.getByRole('link', { name: 'Voir comme les autres' })).toHaveAttribute('href', at(name))
  for (const title of ['Avatar', 'À propos', 'Visibilité', 'Vitrine (0/4)']) await expect(region(page, title)).toBeVisible()
  await expect(page.locator('main').getByText('Cette section arrive bientôt.')).toHaveCount(0)
})

// Ruling Task 8 → 12 : bio refuse null au corps ; vidée, elle part en chaîne vide, que le SQL range en null.
test('/profile, bio (pseudo hérité) : « Bonjour », « 7 / 280 », « Enregistrer » → « Profil enregistré. », corps {bio} ; vidée → {bio: ""}, nulle en base', async ({ page, login }) => {
  const me = await viewer(login)
  const name = `a%b x?y#z ${randomUUID().slice(-6)}`
  sql(`update public.profiles set username = :'name' where id = :'uid'`, { name, uid: me.uid })
  await edit(page)
  const about = region(page, 'À propos')
  const field = about.getByRole('textbox', { name: 'À propos' })
  const save = about.getByRole('button', { name: 'Enregistrer' })
  await expect(field).toHaveValue('')
  await expect(field).toHaveAttribute('maxlength', '280')
  await expect(save).toHaveAttribute('aria-disabled', 'true')
  await field.fill('Bonjour')
  await expect(about.getByText('7 / 280', { exact: true })).toBeVisible()
  let sent = patched(page)
  await save.click()
  expect((await sent).postDataJSON()).toEqual({ bio: 'Bonjour' })
  await expect(about.getByRole('status')).toHaveText('Profil enregistré.')
  expect(column(me, 'bio')).toBe('Bonjour')
  await expect(save).toHaveAttribute('aria-disabled', 'true')
  await field.fill('')
  await expect(about.getByRole('status')).toHaveText('')
  sent = patched(page)
  await save.click()
  expect((await sent).postDataJSON()).toEqual({ bio: '' })
  await expect(about.getByRole('status')).toHaveText('Profil enregistré.')
  expect(column(me, 'bio')).toBe('<null>')
})

test('/profile, visibilité : décochée → faux, corps {is_public} sans bio ; refus → remise ; 500 sans r.fetch() → l\'alerte, relue décochée ; 500 après r.fetch() → l\'alerte, relue cochée', async ({ page, login }) => {
  const me = await viewer(login)
  await edit(page)
  const vis = region(page, 'Visibilité')
  const box = vis.getByRole('checkbox', { name: 'Profil public', exact: true })
  await expect(box).toBeChecked()
  await expect(box).toHaveAccessibleDescription('Décochée, seuls tes amis voient ta bio, ta vitrine et ta collection.')
  const sent = patched(page)
  await box.uncheck()
  // Bio nulle en base : la clé est omise, jamais null (ruling Task 8 → 12).
  expect((await sent).postDataJSON()).toEqual({ is_public: false })
  await expect.poll(() => column(me, 'is_public')).toBe('false')

  // Refus (4xx) : la case revient comme avant, le message du serveur en alerte.
  await routeOnce(page, profileApi, (r) => r.fulfill({ status: 403, json: { code: 'FORBIDDEN', error: 'Tu ne peux modifier que ton profil', message: 'Tu ne peux modifier que ton profil' } }), isPatch)
  await box.click()
  await expect(vis.getByRole('alert')).toHaveText('Tu ne peux modifier que ton profil')
  await expect(box).not.toBeChecked()

  // Rien n'a atteint le serveur : relue décochée.
  await routeOnce(page, profileApi, (r) => r.fulfill({ status: 500 }), isPatch)
  let reread = rowRead(page)
  await box.click()
  await reread
  await expect(vis.getByRole('alert')).toHaveText(UNSURE)
  await expect(box).not.toBeChecked()
  expect(column(me, 'is_public')).toBe('false')

  // Le serveur a enregistré, la réponse est perdue : relue cochée.
  await routeOnce(page, profileApi, async (r) => {
    await r.fetch()
    await r.fulfill({ status: 500 })
  }, isPatch)
  reread = rowRead(page)
  await box.click()
  await reread
  await expect(vis.getByRole('alert')).toHaveText(UNSURE)
  await expect(box).toBeChecked()
  expect(column(me, 'is_public')).toBe('true')
})

test('/profile, avatar au clavier : la copie à image et une copie du seed « Sans image », non cliquable ; Entrée → « Avatar changé. », l\'image de B10 ; « Retirer l\'avatar » → plus d\'image, le focus sur « Changer l\'avatar »', async ({ page, login }) => {
  const me = await viewer(login)
  const copy = imageCopy(me)
  const [seed] = giveCopies(me, 'C')
  await edit(page)
  const avatar = region(page, 'Avatar')
  const change = avatar.getByRole('button', { name: 'Changer l\'avatar', exact: true })
  const remove = avatar.getByRole('button', { name: 'Retirer l\'avatar', exact: true })
  await expect(avatar.locator('img')).toHaveCount(0)
  await expect(remove).toHaveCount(0)
  await change.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Choisir ton avatar' })
  const card = dialog.getByRole('button', { name: titleOf(copy), exact: true })
  await expect(card).toBeVisible()
  const plain = dialog.getByRole('listitem').filter({ hasText: titleOf(seed) })
  await expect(plain.getByText('Sans image', { exact: true })).toBeVisible()
  await expect(plain.getByRole('button')).toHaveCount(0)
  await expect(dialog.getByText('Sans image', { exact: true })).toHaveCount(1)
  const sent = patched(page)
  await card.focus()
  await page.keyboard.press('Enter')
  expect((await sent).postDataJSON()).toEqual({ avatar_user_card_id: copy })
  await expect(toasts(page)).toContainText('Avatar changé.')
  await expect(dialog).toHaveCount(0)
  await expect(avatar.locator('img')).toHaveAttribute('src', B10)
  await expect(avatar.locator('img')).toHaveAttribute('alt', '')
  await expect(change).toBeFocused()
  expect(column(me, 'avatar_url')).toBe(B10)

  await remove.focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Avatar retiré.')
  await expect(avatar.locator('img')).toHaveCount(0)
  await expect(remove).toHaveCount(0)
  await expect(change).toBeFocused()
  expect(column(me, 'avatar_url')).toBe('<null>')
})

// Deux réponses perdues de suite, X puis Y : la clé gardée de X rejouerait sa réponse stockée (« Avatar changé. », la base restée à Y).
test('/profile, avatar : X puis Y à la réponse perdue (l\'alerte dans la modale), puis X → X part sous une clé neuve et tient en base', async ({ page, login }) => {
  const me = await viewer(login)
  const [x, y] = [imageCopy(me), imageCopy(me)]
  const keys: string[] = []
  page.on('request', (r) => { if (r.method() === 'PATCH' && profileApi(new URL(r.url()))) keys.push(r.headers()['idempotency-key'] ?? '') })
  const avatarOf = () => sql(`select coalesce(avatar_user_card_id::text, '<null>') from public.profiles where id = :'uid'`, { uid: me.uid })
  // Le serveur écrit, la réponse se perd : issue inconnue, apiOnce garde la clé.
  const lose = () => routeOnce(page, profileApi, async (r) => {
    await r.fetch()
    await r.abort()
  }, isPatch)
  await edit(page)
  await region(page, 'Avatar').getByRole('button', { name: 'Changer l\'avatar', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Choisir ton avatar' })
  // « Annuler » sans aria-disabled : le choix précédent est fini.
  const idle = () => expect(dialog.getByRole('button', { name: 'Annuler' })).not.toHaveAttribute('aria-disabled')
  await lose()
  await dialog.getByRole('button', { name: titleOf(x), exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText(UNSURE)
  await idle()
  expect(avatarOf()).toBe(x)
  await lose()
  await dialog.getByRole('button', { name: titleOf(y), exact: true }).click()
  await expect.poll(avatarOf).toBe(y)
  await idle()
  await expect(dialog.getByRole('alert')).toHaveText(UNSURE)
  await dialog.getByRole('button', { name: titleOf(x), exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(toasts(page)).toContainText('Avatar changé.')
  expect(avatarOf()).toBe(x)
  expect(keys).toHaveLength(3)
  expect(new Set(keys).size).toBe(3)
})

test('/profile, vitrine au clavier : ajout → « Vitrine mise à jour. », « Vitrine (1/4) », le focus sur « Changer » ; « Retirer » → le focus sur l\'ajout ; copie déjà à l\'emplacement 2 → l\'alerte dans la modale', async ({ page, login }) => {
  const me = await viewer(login)
  const copy = imageCopy(me)
  const title = titleOf(copy)
  await edit(page)
  for (const n of [1, 2, 3, 4]) await expect(addAt(page, n)).toBeVisible()
  await addAt(page, 1).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Choisir une carte pour la vitrine' })
  await dialog.getByRole('button', { name: title, exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Vitrine mise à jour.')
  await expect(dialog).toHaveCount(0)
  await expect(region(page, 'Vitrine (1/4)')).toBeVisible()
  const change = slot(page, 0).getByRole('button', { name: 'Changer', exact: true })
  const remove = slot(page, 0).getByRole('button', { name: 'Retirer', exact: true })
  await expect(change).toBeFocused()
  await expect(change).toHaveAccessibleDescription(title)
  await expect(remove).toHaveAccessibleDescription(title)
  await expect(slot(page, 0).locator('div[class*="glow-"]')).toHaveCount(1)
  expect(slots(me)).toBe(`0:${copy}`)

  await remove.focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Carte retirée de la vitrine.')
  await expect(addAt(page, 1)).toBeFocused()
  await expect(region(page, 'Vitrine (0/4)')).toBeVisible()
  expect(slots(me)).toBe('')

  // Même copie posée ailleurs, sans relecture : le serveur refuse, la modale reste ouverte.
  showcase(me, copy, 1)
  await addAt(page, 1).click()
  await dialog.getByRole('button', { name: title, exact: true }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Cette carte est déjà dans ta vitrine')
  await expect(dialog).toBeVisible()
  expect(slots(me)).toBe(`1:${copy}`)
})

test('/profile, sélecteur : 50 copies par page, « Charger la suite », « Filtrer mes cartes » sur Entrée, « Annuler » rend le focus', async ({ page, login }) => {
  const me = await viewer(login)
  const copy = imageCopy(me)
  giveCopies(me, 'C', 50)
  await edit(page)
  const add = addAt(page, 1)
  await add.click()
  const dialog = page.getByRole('dialog', { name: 'Choisir une carte pour la vitrine' })
  const cards = dialog.locator('div[class*="glow-"]')
  await expect(cards).toHaveCount(50)
  // Vitrine : toutes les copies se choisissent, image ou non.
  await expect(dialog.getByText('Sans image', { exact: true })).toHaveCount(0)
  // Suite en échec : les 50 copies restent, l'alerte, et « Charger la suite » pour relancer.
  await routeOnce(page, (u) => u.pathname === '/api/my-collection' && u.searchParams.get('page') === '1', (r) => r.fulfill({ status: 500 }))
  const more = dialog.getByRole('button', { name: 'Charger la suite' })
  await more.click()
  await expect(dialog.getByRole('alert')).toHaveText(LOAD_FAILED)
  await expect(cards).toHaveCount(50)
  // Dernière page au clavier : le bouton disparaît sous le focus, qui va à la première copie arrivée.
  await more.focus()
  await page.keyboard.press('Enter')
  await expect(cards).toHaveCount(51)
  await expect(more).toHaveCount(0)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(cards.nth(50).locator('h3 > button')).toBeFocused()
  const filter = dialog.getByRole('searchbox', { name: 'Filtrer mes cartes' })
  await filter.fill('Zz image e2e')
  await filter.press('Enter')
  await expect(cards).toHaveCount(1)
  await expect(dialog.getByRole('button', { name: titleOf(copy), exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Annuler' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(add).toBeFocused()
})

test('/profile, sélecteur : la lecture filtrée en échec, « Réessayer » relit sous le même filtre', async ({ page, login }) => {
  const me = await viewer(login)
  const copy = imageCopy(me)
  giveCopies(me, 'C')
  await edit(page)
  await addAt(page, 1).click()
  const dialog = page.getByRole('dialog', { name: 'Choisir une carte pour la vitrine' })
  const cards = dialog.locator('div[class*="glow-"]')
  await expect(cards).toHaveCount(2)
  await routeOnce(page, (u) => u.pathname === '/api/my-collection' && u.searchParams.has('q'), (r) => r.fulfill({ status: 500 }))
  const filter = dialog.getByRole('searchbox', { name: 'Filtrer mes cartes' })
  await filter.fill('Zz image e2e')
  await filter.press('Enter')
  await expect(dialog.getByRole('alert')).toHaveText(LOAD_FAILED)
  await dialog.getByRole('button', { name: 'Réessayer' }).click()
  await expect(dialog.getByRole('button', { name: titleOf(copy), exact: true })).toBeVisible()
  await expect(cards).toHaveCount(1)
  await expect(filter).toHaveValue('Zz image e2e')
})

// Corps JSON d'un 2xx sans sa clé (jamais rendu par nos routes) : une issue incertaine, jamais une page qui plante.
test('/profile, écriture à 2xx sans sa clé ({}) : vitrine (cartes en aria-disabled pendant le choix) et bio → l\'alerte d\'issue incertaine, la page reste', async ({ page, login }) => {
  const me = await viewer(login)
  const copy = imageCopy(me)
  await edit(page)
  // Réponse retenue : pendant le choix, les cartes sont en aria-disabled.
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  await routeOnce(page, '**/api/showcase', async (r) => {
    await held
    await r.fulfill({ json: {} })
  }, (r) => r.request().method() === 'PUT')
  await addAt(page, 1).click()
  const dialog = page.getByRole('dialog', { name: 'Choisir une carte pour la vitrine' })
  const pick = dialog.getByRole('button', { name: titleOf(copy), exact: true })
  await expect(pick).not.toHaveAttribute('aria-disabled')
  await pick.click()
  await expect(pick).toHaveAttribute('aria-disabled', 'true')
  release()
  await expect(dialog.getByRole('alert')).toHaveText(UNSURE)
  await expect(pick).not.toHaveAttribute('aria-disabled')
  await dialog.getByRole('button', { name: 'Annuler' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(region(page, 'Vitrine (0/4)')).toBeVisible()
  await routeOnce(page, profileApi, (r) => r.fulfill({ json: {} }), isPatch)
  const about = region(page, 'À propos')
  await about.getByRole('textbox', { name: 'À propos' }).fill('Bonjour')
  await about.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(about.getByRole('alert')).toHaveText(UNSURE)
  await expect(h1(page)).toHaveText('Profil')
})

// PF17 : la page gardée par Activity relit sa ligne et sa vitrine à chaque affichage.
test('/profile, réaffichage par Activity : copie en vitrine défaussée (wm.discard) et bio changée pendant l\'absence → nouvelles lectures, « Vitrine (0/4) », la bio relue', async ({ page, login }) => {
  const me = await viewer(login)
  const copy = imageCopy(me)
  showcase(me, copy)
  await edit(page)
  await expect(region(page, 'Vitrine (1/4)')).toBeVisible()
  const nav = page.locator('nav a[href="/collection"]').first()
  await hydrated(nav)
  // Marqueur du document : un rechargement complet l'efface, et la page gardée par Activity avec lui.
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/collection')
  sql(`select wm.discard(:'uid', :'copy')`, { uid: me.uid, copy })
  sql(`update public.profiles set bio = 'Relue au retour' where id = :'uid'`, { uid: me.uid })
  const reads = Promise.all([
    page.waitForRequest((r) => new URL(r.url()).pathname === '/api/showcase' && r.method() === 'GET'),
    rowRead(page),
  ])
  await page.goBack()
  await expect(page).toHaveURL('/profile')
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await reads
  await expect(region(page, 'Vitrine (0/4)')).toBeVisible()
  await expect(region(page, 'À propos').getByRole('textbox', { name: 'À propos' })).toHaveValue('Relue au retour')
})

for (const [label, reply] of FAILS) {
  test(`/profile, lecture de la ligne du profil en échec (${label}) : l'alerte et « Réessayer » dans « À propos », data-ready ; « Réessayer » → le champ, le focus sur le titre`, async ({ page, login }) => {
    await viewer(login)
    await routeOnce(page, (u) => u.pathname === '/rest/v1/profiles', (r) => r.fulfill(reply))
    await edit(page)
    const about = region(page, 'À propos')
    await expect(about.getByRole('alert')).toBeVisible()
    await expect(about.getByRole('textbox')).toHaveCount(0)
    await about.getByRole('button', { name: 'Réessayer' }).click()
    await expect(about.getByRole('textbox', { name: 'À propos' })).toBeVisible()
    await expect(about.getByRole('heading', { name: 'À propos' })).toBeFocused()
  })

  test(`/profile, lecture de la vitrine en échec (${label}) : l'alerte et « Réessayer » dans « Vitrine », la bio dans « À propos », data-ready ; « Réessayer » → les emplacements, le focus sur le titre`, async ({ page, login }) => {
    const me = await viewer(login)
    sql(`update public.profiles set bio = 'Ma bio' where id = :'uid'`, { uid: me.uid })
    await routeOnce(page, '**/api/showcase', (r) => r.fulfill(reply), (r) => r.request().method() === 'GET')
    await edit(page)
    const vitrine = region(page, /^Vitrine/)
    await expect(vitrine.getByRole('alert')).toBeVisible()
    await expect(region(page, 'À propos').getByRole('textbox', { name: 'À propos' })).toHaveValue('Ma bio')
    await vitrine.getByRole('button', { name: 'Réessayer' }).click()
    await expect(addAt(page, 1)).toBeVisible()
    await expect(vitrine.getByRole('heading', { name: 'Vitrine (0/4)' })).toBeFocused()
  })

  test(`/profile, lecture du sélecteur en échec (${label}) : l'alerte et « Réessayer » dans la modale ; « Réessayer » → les copies, le focus sur le titre`, async ({ page, login }) => {
    const me = await viewer(login)
    const copy = imageCopy(me)
    await edit(page)
    await routeOnce(page, (u) => u.pathname === '/api/my-collection', (r) => r.fulfill(reply))
    await addAt(page, 1).click()
    const dialog = page.getByRole('dialog', { name: 'Choisir une carte pour la vitrine' })
    await expect(dialog.getByRole('alert')).toHaveText(LOAD_FAILED)
    await dialog.getByRole('button', { name: 'Réessayer' }).click()
    await expect(dialog.getByRole('button', { name: titleOf(copy), exact: true })).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Choisir une carte pour la vitrine' })).toBeFocused()
  })
}

test('/profile à 360 px, avatar et un emplacement posés : aucun défilement horizontal, ni dans le sélecteur ; emplacements et boutons d\'au moins 44 px', async ({ page, login }) => {
  const me = await viewer(login)
  const copy = imageCopy(me)
  showcase(me, copy)
  sql(`update public.profiles p set avatar_user_card_id = uc.id, avatar_url = k.image_url, bio = :'bio'
from public.user_cards uc join public.cards k on k.id = uc.card_id where uc.id = :'copy' and p.id = :'uid'`, { copy, uid: me.uid, bio: 'b'.repeat(280) })
  await page.setViewportSize({ width: 360, height: 800 })
  await edit(page)
  await expect(region(page, 'Avatar').locator('img')).toBeVisible()
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const main = page.locator('main')
  const targets = main.getByRole('button').or(main.getByRole('link', { name: 'Voir comme les autres' }))
  // Voir comme les autres, Changer l'avatar, Retirer l'avatar, Enregistrer, Changer, Retirer, trois emplacements vides.
  await expect(targets).toHaveCount(9)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
  }
  await region(page, 'Avatar').getByRole('button', { name: 'Changer l\'avatar' }).click()
  const dialog = page.getByRole('dialog', { name: 'Choisir ton avatar' })
  await expect(dialog.locator('div[class*="glow-"]')).toHaveCount(1)
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true)
})
