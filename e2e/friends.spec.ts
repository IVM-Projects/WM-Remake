import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { befriend, expect, giveCopies, hydrated, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin (amitiés et échanges suivent en cascade).
const trash: string[] = []
test.afterEach(() => void sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: trash.splice(0).join(',') }))

type User = { uid: string; username: string }
const player = (opts?: Parameters<typeof makePlayer>[0]): User => {
  const u = makePlayer(opts)
  trash.push(u.uid)
  return u
}
// Demande en attente de `from` vers `to`, posée par SQL ; renvoie son id.
const ask = (from: User, to: User) =>
  sql(`insert into public.friendships (requester_id, addressee_id) values (:'r', :'a') returning id`, { r: from.uid, a: to.uid })

// Page lue et hydratée : data-ready est posé par le client après la première lecture. À froid, une seconde lecture suit la première
// lecture de la cloche (version du store, double lecture admise) : attendue aussi, pour qu'aucune route posée ensuite ne la prenne.
async function open(page: Page) {
  let n = 0
  const both = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/friends' && ++n === 2)
  await page.goto('/friends')
  await page.locator('main [data-ready]').waitFor()
  await both
}
const section = (page: Page, title: string) =>
  page.locator('main section').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
const toasts = (page: Page) => page.locator('#wm-toasts')
const results = (page: Page) => page.getByRole('list', { name: 'Résultats de la recherche' }).getByRole('listitem')
const field = (page: Page) => page.locator('#friend-list-search')
const NO_FRIENDS = 'Tu n\'as pas encore d\'amis. Cherche un joueur par son pseudo.'
const badge = (page: Page) => page.locator('button[aria-label="Notifications"] + span')
const onBody = (page: Page) => page.evaluate(() => document.activeElement === document.body)
const SHORT = 'La recherche demande au moins 2 caractères'

// Réponse retenue jusqu'à release() ; fetched se résout dès que la requête est interceptée.
function hold() {
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  let seen = () => {}
  const fetched = new Promise<void>((r) => { seen = r })
  return { release, held, fetched, seen }
}

// Lignes dans l'ordre, chacune commençant par le pseudo.
const names = (users: User[]) => users.map((u) => new RegExp(`^${u.username}`))

// Retour sur /friends gardée par Activity (lien hydraté, document marqué) ; la relecture du réaffichage attend release().
async function reshowHeld(page: Page): Promise<() => void> {
  const { release, held, fetched, seen } = hold()
  await routeOnce(page, '**/api/friends', async (route) => {
    seen()
    await held
    await route.fallback()
  })
  const nav = page.locator('nav a[href="/collection"]').first()
  await hydrated(nav)
  // Marqueur du document : un rechargement complet l'efface, et la page gardée par Activity avec lui.
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/collection')
  await page.locator('nav a[href="/friends"]').first().click()
  await expect(page).toHaveURL('/friends')
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await fetched
  return release
}

async function search(page: Page, q: string) {
  await field(page).fill(q)
  await field(page).press('Enter')
}

test('h1 « Amis », #friend-list-search rendu une seule fois, trois sections vides', async ({ page, login }) => {
  trash.push((await login()).uid)
  await open(page)
  await expect(page.locator('main h1')).toHaveText('Amis')
  await expect(page.locator('#friend-list-search')).toHaveCount(1)
  await expect(page.getByRole('searchbox', { name: 'Rechercher un joueur' })).toHaveAttribute('id', 'friend-list-search')
  await expect(section(page, 'Demandes reçues')).toContainText('Aucune demande reçue.')
  await expect(section(page, 'Demandes envoyées')).toContainText('Aucune demande envoyée.')
  await expect(section(page, 'Amis')).toContainText(NO_FRIENDS)
  // « Tout accepter » seulement s'il y a une demande reçue.
  await expect(page.getByRole('button', { name: 'Tout accepter' })).toHaveCount(0)
})

test('recherche d\'un joueur neuf, « Ajouter » : toast, la ligne sous « Demandes envoyées » ; « Retirer » : l\'état vide', async ({ page, login }) => {
  trash.push((await login()).uid)
  const other = player()
  await open(page)
  await search(page, other.username)
  await expect(results(page)).toHaveCount(1)
  await expect(results(page)).toContainText(other.username)
  await results(page).getByRole('button', { name: 'Ajouter' }).click()
  await expect(toasts(page)).toContainText(`Demande envoyée à ${other.username}.`)
  const sent = section(page, 'Demandes envoyées')
  await expect(sent.getByRole('listitem')).toHaveCount(1)
  await expect(sent.getByRole('listitem')).toContainText(other.username)
  await sent.getByRole('button', { name: 'Retirer' }).click()
  await expect(toasts(page)).toContainText('Demande retirée.')
  // La ligne disparue sous le focus : l'état vide de sa section le prend.
  await expect(sent.getByText('Aucune demande envoyée.', { exact: true })).toBeFocused()
})

test('une recherche d\'un caractère : le message, sans requête, les résultats d\'avant effacés ; un préfixe inconnu : « Aucun joueur ne correspond. »', async ({ page, login }) => {
  trash.push((await login()).uid)
  const other = player()
  const asked: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname === '/api/friends/search') asked.push(u.searchParams.get('q') ?? '')
  })
  await open(page)
  await search(page, other.username)
  await expect(results(page)).toHaveCount(1)
  // Fin de la recherche annoncée par la région role=status.
  const count = page.locator('main [role=status] p')
  await expect(count).toHaveText('1 joueur trouvé.')
  // Même recherche, même compte : le texte est remonté (clé), donc annoncé de nouveau.
  await count.evaluate((p) => { p.dataset.seen = '' })
  const again = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/friends/search')
  await search(page, other.username)
  await again
  await expect(count).not.toHaveAttribute('data-seen')
  await expect(count).toHaveText('1 joueur trouvé.')
  await search(page, ' a ')
  await expect(page.locator('main').getByRole('alert')).toHaveText(SHORT)
  await expect(field(page)).toHaveAttribute('aria-invalid', 'true')
  await expect(results(page)).toHaveCount(0)
  // Une vraie recherche ensuite : la requête observée prouve que l'écoute marche, et qu'elle est la seule.
  const q = `zz${randomUUID().slice(-10)}`
  const sent = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/friends/search')
  await search(page, q)
  await sent
  await expect(page.locator('main [role=status]').getByText('Aucun joueur ne correspond.', { exact: true })).toBeVisible()
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  expect(asked).toEqual([other.username, other.username, q])
  // Recherche en échec : le repli, sans aria-invalid (seul le message de longueur rend le champ invalide).
  await routeOnce(page, (u) => u.pathname === '/api/friends/search', (r) => r.fulfill({ status: 500 }))
  await search(page, q)
  await expect(page.locator('main').getByRole('alert')).toHaveText('La recherche n\'a pas abouti.')
  await expect(field(page)).not.toHaveAttribute('aria-invalid')
})

test('demande reçue → « Accepter » : toast, la ligne sous « Amis », « Échanger » vers /trades/new?with=<id>', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const other = player()
  ask(other, me)
  await open(page)
  const received = section(page, 'Demandes reçues')
  await expect(received.getByRole('listitem')).toHaveCount(1)
  await expect(received.getByRole('listitem')).toContainText(other.username)
  await received.getByRole('button', { name: 'Accepter', exact: true }).click()
  await expect(toasts(page)).toContainText(`${other.username} fait maintenant partie de tes amis.`)
  await expect(received.getByText('Aucune demande reçue.', { exact: true })).toBeFocused()
  const row = section(page, 'Amis').getByRole('listitem')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(other.username)
  await expect(row.getByRole('link', { name: 'Échanger' })).toHaveAttribute('href', `/trades/new?with=${other.uid}`)
})

test('demande arrivée sur /friends : le poll de 30 s de la cloche la signale, la page la relit sans navigation ; masquée par Activity, elle ne lit rien', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [a, b] = [player(), player()]
  const friendsReads: string[] = []
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/friends') friendsReads.push(r.method()) })
  await page.clock.install()
  // Badge lu une première fois (aucune non lue) avant la demande, la page relue derrière lui (open) : seul le poll suivant la voit.
  await open(page)
  const received = section(page, 'Demandes reçues')
  await expect(received).toContainText('Aucune demande reçue.')
  // wm.friend_request écrit la demande et sa notification friend_request (M4-12).
  sql(`select wm.friend_request(:'a', :'me')`, { a: a.uid, me: me.uid })
  await page.clock.runFor(30_000)
  await expect(badge(page)).toHaveText('1')
  await expect(received.getByRole('listitem')).toHaveText(names([a]))
  await expect(page).toHaveURL('/friends')
  // Montage, première lecture de la cloche, poll de 30 s.
  expect(friendsReads).toEqual(['GET', 'GET', 'GET'])

  // Page cachée par Activity (lien hydraté, document marqué) : abonnement retiré, le badge change sans relecture de /api/friends.
  const nav = page.locator('nav a[href="/collection"]').first()
  await hydrated(nav)
  await page.evaluate(() => void Object.assign(window, { __spa: true }))
  await nav.click()
  await expect(page).toHaveURL('/collection')
  sql(`select wm.friend_request(:'b', :'me')`, { b: b.uid, me: me.uid })
  await page.clock.runFor(30_000)
  await expect(badge(page)).toHaveText('2')
  expect(friendsReads).toEqual(['GET', 'GET', 'GET'])
  await page.locator('nav a[href="/friends"]').first().click()
  await expect(page).toHaveURL('/friends')
  expect(await page.evaluate(() => '__spa' in window), 'rechargement complet : la page n\'est plus celle gardée par Activity').toBe(true)
  await expect(received.getByRole('listitem')).toHaveText(names([b, a]))
})

test('« 9+ » (douze non lues) : une demande arrivée sur /friends est relue au poll suivant, compte inchangé', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const a = player()
  sql(`insert into public.notifications (user_id, type, data) select :'uid', 'trade_received', jsonb_build_object('trade_id',
gen_random_uuid(), 'user_id', gen_random_uuid(), 'username', 'Alice') from generate_series(1, 12)`, { uid: me.uid })
  await page.clock.install()
  await open(page)
  await expect(badge(page)).toHaveText('9+')
  sql(`select wm.friend_request(:'a', :'me')`, { a: a.uid, me: me.uid })
  await page.clock.runFor(30_000)
  await expect(section(page, 'Demandes reçues').getByRole('listitem')).toHaveText(names([a]))
  await expect(badge(page)).toHaveText('9+')
})

test('relecture de fond : « Retirer » focalisé sur une demande envoyée que l\'autre accepte → la ligne passe sous « Amis », le focus à l\'état vide des envoyées', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const b = player()
  const id = ask(me, b)
  await page.clock.install()
  await open(page)
  const sent = section(page, 'Demandes envoyées')
  await sent.getByRole('button', { name: 'Retirer' }).focus()
  // B accepte ailleurs ; la cloche le voit au poll suivant (friend_accepted).
  sql(`select wm.friend_action(:'b', :'id', 'accept')`, { b: b.uid, id })
  await page.clock.runFor(30_000)
  await expect(section(page, 'Amis').getByRole('listitem')).toHaveText(names([b]))
  await expect(sent.getByText('Aucune demande envoyée.', { exact: true })).toBeFocused()
  expect(await onBody(page)).toBe(false)
})

test('relecture de fond en échec : la liste reste, sans alerte ; la suivante la met à jour', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [a, b] = [player(), player()]
  ask(a, me)
  await page.clock.install()
  await open(page)
  const received = section(page, 'Demandes reçues')
  await expect(received.getByRole('listitem')).toHaveText(names([a]))
  sql(`select wm.friend_request(:'b', :'me')`, { b: b.uid, me: me.uid })
  await routeOnce(page, '**/api/friends', (r) => r.fulfill({ status: 500 }))
  const failed = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/friends' && r.status() === 500)
  await page.clock.runFor(30_000)
  await failed
  // Le temps que la page applique l'échec si elle ne le gardait pas pour elle.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await expect(received.getByRole('listitem')).toHaveText(names([a]))
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0)
  await page.clock.runFor(30_000)
  await expect(received.getByRole('listitem')).toHaveText(names([b, a]))
})

test('deux demandes reçues → « Tout accepter » au clavier : « 2 demandes acceptées. », focus sur le premier ami ajouté', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [a, b, old] = [player(), player(), player()]
  ask(a, me)
  ask(b, me)
  // Ami posé après les demandes : la liste (plus récente d'abord) le met en tête, avant les deux amis ajoutés.
  befriend(old, me)
  await open(page)
  await expect(section(page, 'Demandes reçues').getByRole('listitem')).toHaveCount(2)
  await page.getByRole('button', { name: 'Tout accepter' }).focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('2 demandes acceptées.')
  const rows = section(page, 'Amis').getByRole('listitem')
  await expect(rows).toHaveText([old.username, b.username, a.username].map((u) => new RegExp(`^${u}`)))
  await expect(rows.nth(1).getByRole('link', { name: 'Échanger' })).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  await expect(page.getByRole('button', { name: 'Tout accepter' })).toHaveCount(0)
})

test('retrait d\'un ami avec un échange en attente : modale, toast, focus sur l\'état vide, échange annulé, nouvelle demande possible', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const other = player()
  const fid = befriend(me, other)
  const [copy] = giveCopies(me, 'C')
  const trade = sql(`select wm.create_trade(:'me', :'other', jsonb_build_array(jsonb_build_object('user_card_id', id, 'card_id', card_id,
  'offered_by', user_id))) ->> 'id' from public.user_cards where id = :'copy'`, { me: me.uid, other: other.uid, copy })
  await open(page)
  const friends = section(page, 'Amis')
  await friends.getByRole('button', { name: 'Retirer' }).click()
  const dialog = page.getByRole('dialog', { name: `Retirer ${other.username} de tes amis ?` })
  await expect(dialog.getByRole('heading')).toHaveText(`Retirer ${other.username} de tes amis ?`)
  await expect(dialog.getByText('Les échanges en attente entre vous seront annulés.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button')).toHaveText(['Annuler', 'Retirer'])
  // DELETE retenu : ni Échap, ni le voile, ni « Annuler » ne ferment la modale pendant le retrait.
  const { release, held } = hold()
  await routeOnce(page, `**/api/friends/${fid}`, async (route) => {
    await held
    await route.fallback()
  })
  const sent = page.waitForRequest((r) => r.method() === 'DELETE')
  await dialog.getByRole('button', { name: 'Retirer' }).click()
  await sent
  await page.keyboard.press('Escape')
  await page.mouse.click(4, 4)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Annuler' })).toHaveAttribute('aria-disabled', 'true')
  release()
  await expect(toasts(page)).toContainText(`${other.username} a été retiré de tes amis.`)
  await expect(dialog).toBeHidden()
  // Après le démontage de la modale (focus rendu au « Retirer » de la ligne, puis la ligne retirée) : l'état vide de « Amis ».
  await expect(friends.getByText(NO_FRIENDS, { exact: true })).toBeFocused()
  expect(sql(`select status from public.trades where id = :'t'`, { t: trade })).toBe('cancelled')
  // Une nouvelle demande passe ensuite.
  await search(page, other.username)
  await results(page).getByRole('button', { name: 'Ajouter' }).click()
  await expect(toasts(page)).toContainText(`Demande envoyée à ${other.username}.`)
  await expect(section(page, 'Demandes envoyées').getByRole('listitem')).toContainText(other.username)
})

test('une ligne d\'ami : le lien « Échanger » et le bouton « Retirer », aucun « Message » (M4-1)', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const other = player()
  befriend(other, me)
  await open(page)
  const row = section(page, 'Amis').getByRole('listitem')
  await expect(row).toHaveCount(1)
  await expect(row.getByRole('link')).toHaveText(['Échanger'])
  await expect(row.getByRole('button')).toHaveText(['Retirer'])
  // Nom = texte visible ; le pseudo du joueur en description.
  await expect(row.getByRole('link')).toHaveAccessibleDescription(other.username)
  await expect(row.getByRole('button')).toHaveAccessibleDescription(other.username)
  await expect(page.locator('main').getByText(/Message/)).toHaveCount(0)
})

// 500, ou 200 au corps illisible (api() rend null) : la page atteint son état d'échec, jamais un chargement sans fin.
for (const [label, reply] of [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const) {
  test(`lecture en échec (${label}) : « Impossible de charger cette page. » et « Réessayer », qui rend les sections`, async ({ page, login }) => {
    trash.push((await login()).uid)
    // Les deux lectures de l'arrivée à froid (montage, première lecture de la cloche) : sinon la seconde rendrait la page seule.
    for (let i = 0; i < 2; i++) await routeOnce(page, '**/api/friends', (r) => r.fulfill(reply))
    await open(page)
    await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
    await expect(section(page, 'Demandes reçues')).toHaveCount(0)
    await page.getByRole('button', { name: 'Réessayer' }).click()
    for (const title of ['Demandes reçues', 'Demandes envoyées', 'Amis']) await expect(section(page, title)).toBeVisible()
    // « Réessayer » disparu sous le focus : la première section le prend.
    await expect(section(page, 'Demandes reçues').getByText('Aucune demande reçue.', { exact: true })).toBeFocused()
  })
}

test('clavier : Tab jusqu\'à la recherche, saisie, Entrée, Tab jusqu\'à « Ajouter », Entrée → toast ; « Refuser » : focus à la ligne suivante', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [other, a, b] = [player(), player(), player()]
  ask(a, me)
  ask(b, me)
  await open(page)
  for (let i = 0; i < 40 && !(await field(page).evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(field(page)).toBeFocused()
  await page.keyboard.type(other.username)
  await page.keyboard.press('Enter')
  const add = results(page).getByRole('button', { name: 'Ajouter' })
  await expect(add).toBeVisible()
  for (let i = 0; i < 5 && !(await add.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText(`Demande envoyée à ${other.username}.`)
  // Le toast part avant la relecture, que act() attend en gardant sa garde : la demande affichée sous « Demandes envoyées » en est le signe.
  await expect(section(page, 'Demandes envoyées').getByRole('listitem')).toContainText(other.username)

  // Plus récente d'abord : b, puis a. « Refuser » sur b : la ligne de a prend sa place, et le focus va à son « Refuser » (même contrôle :
  // Entrée de nouveau refuse, jamais n'accepte).
  const received = section(page, 'Demandes reçues')
  const refuse = received.getByRole('button', { name: 'Refuser' })
  await expect(received.getByRole('listitem')).toHaveText([b.username, a.username].map((u) => new RegExp(`^${u}`)))
  await expect(refuse.first()).not.toHaveAttribute('aria-disabled')
  await refuse.first().focus()
  await page.keyboard.press('Enter')
  await expect(toasts(page)).toContainText('Demande refusée.')
  await expect(received.getByRole('listitem')).toHaveCount(1)
  await expect(refuse).toBeFocused()
  await expect(refuse).toHaveAccessibleDescription(a.username)
  await expect(refuse).not.toHaveAttribute('aria-disabled')
  await page.keyboard.press('Enter')
  await expect(received.getByText('Aucune demande reçue.', { exact: true })).toBeFocused()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)
  expect(sql(`select count(*) from public.friendships where requester_id in (:'a', :'b')`, { a: a.uid, b: b.uid })).toBe('0')
})

test('360 px, un ami au pseudo de 24 caractères sans coupure : ni main ni la page ne défilent en largeur ; cibles ≥ 44 px', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const long = player({ username: `w${randomUUID().replaceAll('-', '').slice(0, 23)}` })
  expect(long.username).toHaveLength(24)
  befriend(me, long)
  ask(player(), me)
  ask(me, player())
  await page.setViewportSize({ width: 360, height: 800 })
  await open(page)
  await expect(section(page, 'Amis').getByRole('listitem')).toContainText(long.username)
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const targets = page.locator('main').getByRole('button').or(page.locator('main').getByRole('link', { name: 'Échanger' }))
  // Tout accepter, Accepter, Refuser, Retirer (envoyée), Échanger, Retirer (ami).
  await expect(targets).toHaveCount(6)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44)
  }
  // Titre de la modale en text-xl : le pseudo sans coupure y passe à la ligne, la boîte ne déborde pas.
  await section(page, 'Amis').getByRole('button', { name: 'Retirer' }).click()
  const dialog = page.getByRole('dialog', { name: `Retirer ${long.username} de tes amis ?` })
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth)).toBe(true)
})

test('réponse perdue sur « Ajouter » : la relecture montre la demande ; retirée puis ajoutée de nouveau, une demande neuve part', async ({ page, login }) => {
  trash.push((await login()).uid)
  const other = player()
  const keys: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/friends') keys.push(r.headers()['idempotency-key'] ?? '') })
  await open(page)
  // Le serveur crée la demande, la réponse se perd : issue inconnue, apiOnce garde la clé.
  await routeOnce(page, '**/api/friends', async (route) => {
    await route.fetch()
    await route.abort()
  })
  await search(page, other.username)
  await results(page).getByRole('button', { name: 'Ajouter' }).click()
  // Issue inconnue dite comme telle : la relecture montre ensuite la demande faite.
  await expect(toasts(page)).toContainText('L\'action n\'a pas été confirmée : elle a peut-être eu lieu.')
  const sent = section(page, 'Demandes envoyées')
  await expect(sent.getByRole('listitem')).toContainText(other.username)
  await sent.getByRole('button', { name: 'Retirer' }).click()
  await expect(sent.getByText('Aucune demande envoyée.', { exact: true })).toBeVisible()
  // La relecture a vidé les clés gardées : la clé d'avant rejouerait le succès stocké, sans rien créer.
  await results(page).getByRole('button', { name: 'Ajouter' }).click()
  await expect(toasts(page)).toContainText(`Demande envoyée à ${other.username}.`)
  await expect(sent.getByRole('listitem')).toContainText(other.username)
  expect(sql(`select count(*) from public.friendships where addressee_id = :'o'`, { o: other.uid })).toBe('1')
  expect(keys).toHaveLength(2)
  expect(keys[0]).not.toBe(keys[1])
})

test('première lecture lente, rendue après la relecture d\'un ajout : jetée, la demande reste affichée', async ({ page, login }) => {
  trash.push((await login()).uid)
  const other = player()
  // Lue tout de suite (aucune demande), rendue après l'ajout.
  const { release, held, fetched, seen } = hold()
  await routeOnce(page, '**/api/friends', async (route) => {
    const res = await route.fetch()
    seen()
    await held
    await route.fulfill({ response: res })
  })
  await page.goto('/friends')
  // Requête partie de l'effet : la page est hydratée.
  await fetched
  await search(page, other.username)
  await results(page).getByRole('button', { name: 'Ajouter' }).click()
  const sent = section(page, 'Demandes envoyées')
  await expect(sent.getByRole('listitem')).toContainText(other.username)
  const stale = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/friends' && r.request().method() === 'GET')
  release()
  await stale
  // Le temps que la page l'applique si elle ne la jetait pas.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  await expect(sent.getByRole('listitem')).toContainText(other.username)
})

test('relecture en échec après « Refuser », puis « Réessayer » : le chargement jusqu\'à la relecture, jamais l\'ancienne liste', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  ask(player(), me)
  await open(page)
  await routeOnce(page, '**/api/friends', (r) => r.fulfill({ status: 500 }))
  await section(page, 'Demandes reçues').getByRole('button', { name: 'Refuser' }).click()
  await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
  const { release, held } = hold()
  await routeOnce(page, '**/api/friends', async (route) => {
    await held
    await route.fallback()
  })
  await page.getByRole('button', { name: 'Réessayer' }).click()
  await expect(page.locator('main [role=status]').filter({ hasText: 'Chargement des amis' })).toBeVisible()
  await expect(page.locator('main section')).toHaveCount(0)
  release()
  await expect(section(page, 'Demandes reçues').getByText('Aucune demande reçue.', { exact: true })).toBeFocused()
})

test('ligne retirée par une relecture sous la modale (réaffichage par Activity) : Échap passe le focus au « Retirer » suivant', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [x, y] = [player(), player()]
  befriend(x, me)
  // y plus récent : en tête de « Amis ».
  const fy = befriend(y, me)
  await open(page)
  const friends = section(page, 'Amis')
  await expect(friends.getByRole('listitem')).toHaveText(names([y, x]))
  // La relecture du retour attend que l'amitié de y soit retirée ailleurs.
  const release = await reshowHeld(page)
  await friends.getByRole('listitem').first().getByRole('button', { name: 'Retirer' }).click()
  const dialog = page.getByRole('dialog', { name: `Retirer ${y.username} de tes amis ?` })
  await expect(dialog).toBeVisible()
  sql(`delete from public.friendships where id = :'f'`, { f: fy })
  release()
  await expect(friends.getByRole('listitem')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(friends.getByRole('button', { name: 'Retirer' })).toBeFocused()
})

test('lignes décalées par une relecture sous la modale : après le retrait confirmé, le focus va au « Retirer » de la ligne qui prend sa place', async ({ page, login }) => {
  const me = await login()
  trash.push(me.uid)
  const [x, y, z] = [player(), player(), player()]
  befriend(x, me)
  befriend(y, me)
  await open(page)
  const friends = section(page, 'Amis')
  await expect(friends.getByRole('listitem')).toHaveText(names([y, x]))
  const release = await reshowHeld(page)
  // Modale ouverte sur y, au rang 0 ; la relecture ajoute z, plus récent, en tête : y passe au rang 1.
  await friends.getByRole('listitem').first().getByRole('button', { name: 'Retirer' }).click()
  const dialog = page.getByRole('dialog', { name: `Retirer ${y.username} de tes amis ?` })
  await expect(dialog).toBeVisible()
  befriend(z, me)
  release()
  await expect(friends.getByRole('listitem')).toHaveText(names([z, y, x]))
  await dialog.getByRole('button', { name: 'Retirer' }).click()
  await expect(toasts(page)).toContainText(`${y.username} a été retiré de tes amis.`)
  await expect(friends.getByRole('listitem')).toHaveText(names([z, x]))
  await expect(friends.getByRole('listitem').nth(1).getByRole('button', { name: 'Retirer' })).toBeFocused()
})
