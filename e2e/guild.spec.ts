import { randomUUID } from 'node:crypto'
import type { Page, Request } from '@playwright/test'
import { befriend, cookieFor, expect, giveCopies, makeGuild, makePlayer, routeOnce, sql, test } from './fixtures'

// Les workers partagent la base du banc : chaque test a ses joueurs, supprimés à la fin. Leurs guildes (posées par makeGuild ou créées dans
// la page) le sont avant eux : une suppression de compte ne passe pas par une guilde qui a encore des membres.
const trash: string[] = []
// Cible de 44 px à 0,01 près : la mise en page tombe parfois juste sous le pixel (CI run 41034418031), comme profile.spec.ts.
const MIN_TARGET = 44 - 0.01
test.afterEach(() => {
  const uids = trash.splice(0).join(',')
  sql(`delete from public.guilds where leader_id = any(string_to_array(:'uids', ',')::uuid[])
    or id in (select guild_id from public.guild_members where user_id = any(string_to_array(:'uids', ',')::uuid[]))`, { uids })
  sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids })
})

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
const name = () => `Guilde ${randomUUID().slice(0, 8)}`
const invite = (leader: User, to: User) => {
  befriend(leader, to)
  sql(`select wm.guild_invite(:'l', :'m')`, { l: leader.uid, m: to.uid })
}
const guildOf = (u: User) => sql(`select guild_id from public.guild_members where user_id = :'u'`, { u: u.uid })

// data-ready : guilde et session lues (ou en échec).
async function open(page: Page) {
  await page.goto('/guild')
  await page.locator('main [data-ready]').waitFor()
}
// Préflight C5 : depuis la Task 16, Chat est l'onglet par défaut ; les cas de la Task 15 qui lisent les membres cliquent « Membres » ici.
async function openTab(page: Page) {
  await open(page)
  await page.getByRole('tab', { name: 'Membres' }).click()
}
// Cache Components garde les pages quittées dans le DOM (display: none) : seul le visible compte.
const h1 = (page: Page) => page.locator('main h1').filter({ visible: true })
const h2 = (page: Page, text: string) => page.getByRole('heading', { level: 2, name: text, exact: true })
const toasts = (page: Page) => page.locator('#wm-toasts')
const panel = (page: Page) => page.getByRole('tabpanel')
const dialog = (page: Page) => page.getByRole('dialog')
const row = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text })
const posts = (r: Request) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/guilds'
const UNSURE = 'L\'action n\'a pas été confirmée : elle a peut-être eu lieu.'
const FAILS = [['500', { status: 500 }], ['200 illisible', { status: 200, body: 'x' }]] as const

test('sans guilde ni invitation : h1 et titre, les deux phrases, « Aucune invitation. » ; /guild n\'est plus « bientôt »', async ({ page, login }) => {
  await viewer(login)
  await open(page)
  await expect(h1(page)).toHaveText('Guilde')
  await expect(page).toHaveTitle(/^Guilde — /)
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  await expect(page.locator('main')).toContainText('Pour en rejoindre une, demande à un ami membre de t\'inviter.')
  await expect(page.getByText('Aucune invitation.', { exact: true })).toBeVisible()
  await expect(page.locator('main')).not.toContainText('Cette section arrive bientôt.')
})

test('nom blanc : « Créer la guilde » en aria-disabled, aucun POST ; compteurs « n / 40 » et « n / 280 »', async ({ page, login }) => {
  await viewer(login)
  await open(page)
  let sent = 0
  page.on('request', (r) => { if (posts(r)) sent++ })
  const create = page.getByRole('button', { name: 'Créer la guilde' })
  await expect(create).toHaveAttribute('aria-disabled', 'true')
  await page.getByLabel('Nom de la guilde').fill('   ')
  await expect(create).toHaveAttribute('aria-disabled', 'true')
  // aria-disabled : Playwright attend un bouton actif, le clic est forcé.
  await create.click({ force: true })
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  expect(sent).toBe(0)
  await page.getByLabel('Nom de la guilde').fill('Les Sages')
  await expect(page.getByText('9 / 40', { exact: true })).toBeVisible()
  await expect(page.getByText('0 / 280', { exact: true })).toBeVisible()
  await expect(create).not.toHaveAttribute('aria-disabled', 'true')
})

test('créer au clavier (Nom, Tab, Tab, Entrée) : le h2 au nom focalisé, « 1 membre », « Chef » ; une guilde en base', async ({ page, login }) => {
  const me = await viewer(login)
  const g = name()
  await open(page)
  await page.getByLabel('Nom de la guilde').fill(g)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Créer la guilde' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(h2(page, g)).toBeFocused()
  await expect(page.locator('main')).toContainText('1 membre')
  await expect(page.locator('main').getByText('Chef', { exact: true }).first()).toBeVisible()
  expect(sql(`select count(*) from public.guilds where leader_id = :'u'`, { u: me.uid })).toBe('1')
})

test('deux invitations (G puis H) : H en premier ; « Refuser » H → « Rejoindre » de G focalisé ; « Rejoindre » G → la vue membre, h2 « G » focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const [a, b] = [player(), player()]
  const [gName, hName] = [name(), name()]
  makeGuild(a, [], gName)
  makeGuild(b, [], hName)
  invite(a, me)
  invite(b, me)
  await open(page)
  const items = page.getByRole('region', { name: 'Invitations' }).getByRole('listitem')
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText(hName)
  await expect(items.first()).toContainText(`Invitation de ${b.username}`)
  await expect(items.first().locator('time')).toHaveText(/\S/)
  await items.first().getByRole('button', { name: 'Refuser' }).click()
  await expect(items).toHaveCount(1)
  await expect(items.first().getByRole('button', { name: 'Rejoindre' })).toBeFocused()
  await items.first().getByRole('button', { name: 'Rejoindre' }).click()
  await expect(h2(page, gName)).toBeFocused()
  expect(guildOf(me)).not.toBe('')
})

test('dernière invitation refusée → « Aucune invitation. » focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  makeGuild(a)
  invite(a, me)
  await open(page)
  await page.getByRole('button', { name: 'Refuser' }).click()
  await expect(page.getByText('Aucune invitation.', { exact: true })).toBeFocused()
})

test('refus forcé à « Rejoindre » (guilde pleine) : l\'alerte « Cette guilde est pleine » sur la ligne', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  makeGuild(a)
  invite(a, me)
  await open(page)
  const max = sql(`select value ->> 'max_members' from wm.config where key = 'guild'`)
  const setMax = (n: string) => sql(`update wm.config set value = value || jsonb_build_object('max_members', :'n'::int) where key = 'guild'`, { n })
  setMax('1')
  try {
    await page.getByRole('button', { name: 'Rejoindre' }).click()
    await expect(row(page, 'Invitation de').getByRole('alert')).toHaveText('Cette guilde est pleine')
  } finally {
    setMax(max)
  }
})

test('issue incertaine sur « Créer la guilde » : UNSURE ; la relecture montre la vue membre, l\'alerte tombe, une seule guilde en base', async ({ page, login }) => {
  const me = await viewer(login)
  await open(page)
  await routeOnce(page, '**/api/guilds', async (r) => {
    await r.fetch()
    await r.fulfill({ status: 500 })
  }, (r) => r.request().method() === 'POST')
  // La relecture qui suit est retenue : le temps de voir l'alerte.
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let hold = false
  await page.route('**/api/guilds', async (r) => {
    if (hold && r.request().method() === 'GET') await gate
    await r.fallback()
  })
  const g = name()
  await page.getByLabel('Nom de la guilde').fill(g)
  hold = true
  await page.getByRole('button', { name: 'Créer la guilde' }).click()
  await expect(page.getByRole('alert').filter({ hasText: UNSURE })).toBeVisible()
  release()
  await expect(h2(page, g)).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: UNSURE })).toHaveCount(0)
  expect(sql(`select count(*) from public.guilds where leader_id = :'u'`, { u: me.uid })).toBe('1')
})

test('chef de trois membres : trois lignes, « Chef » sur lui ; « Exclure » → modale → la ligne disparaît, toast, « Exclure » du membre suivant focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const [a, b] = [player(), player()]
  makeGuild(me, [a, b])
  await openTab(page)
  await expect(panel(page).getByRole('listitem')).toHaveCount(3)
  await expect(row(page, me.username).getByText('Chef', { exact: true })).toBeVisible()
  await expect(panel(page).getByText('Chef', { exact: true })).toHaveCount(1)
  await expect(row(page, a.username).getByRole('link', { name: a.username })).toHaveAttribute('href', `/profile/${encodeURIComponent(a.username)}`)
  await expect(row(page, a.username)).toContainText('Membre depuis le')
  await row(page, a.username).getByRole('button', { name: 'Exclure' }).click()
  await expect(dialog(page).getByRole('heading', { name: `Exclure ${a.username} de la guilde ?` })).toBeVisible()
  await expect(dialog(page)).toContainText('Il ne pourra revenir que sur une nouvelle invitation.')
  await dialog(page).getByRole('button', { name: 'Exclure', exact: true }).click()
  await expect(row(page, a.username)).toHaveCount(0)
  await expect(toasts(page)).toContainText(`${a.username} a été exclu de la guilde.`)
  await expect(row(page, b.username).getByRole('button', { name: 'Exclure' })).toBeFocused()
  expect(guildOf(a)).toBe('')
})

test('chef : « Nommer chef » → la pastille passe, plus aucun « Exclure », le h2 focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  const g = name()
  makeGuild(me, [a], g)
  await openTab(page)
  await row(page, a.username).getByRole('button', { name: 'Nommer chef' }).click()
  await expect(dialog(page).getByRole('heading', { name: `Nommer ${a.username} chef de la guilde ?` })).toBeVisible()
  await expect(dialog(page)).toContainText('Tu deviendras simple membre.')
  await dialog(page).getByRole('button', { name: 'Nommer chef', exact: true }).click()
  await expect(toasts(page)).toContainText(`${a.username} est maintenant chef de la guilde.`)
  await expect(row(page, a.username).getByText('Chef', { exact: true })).toBeVisible()
  await expect(row(page, me.username).getByText('Chef', { exact: true })).toHaveCount(0)
  await expect(panel(page).getByRole('button', { name: 'Exclure' })).toHaveCount(0)
  await expect(h2(page, g)).toBeFocused()
  expect(sql(`select leader_id from public.guilds where id = :'g'`, { g: guildOf(me) })).toBe(a.uid)
})

test('« Inviter un ami » : deux amis dont un membre → un seul « Inviter » ; « Inviter » → toast, « Invité », ligne en base', async ({ page, login }) => {
  const me = await viewer(login)
  const [m, f] = [player(), player()]
  makeGuild(me, [m])
  befriend(me, f)
  await openTab(page)
  await page.getByRole('button', { name: 'Inviter un ami' }).click()
  await expect(dialog(page).getByRole('heading', { name: 'Inviter un ami' })).toBeVisible()
  await expect(dialog(page).getByRole('button', { name: 'Inviter', exact: true })).toHaveCount(1)
  await expect(dialog(page).getByRole('listitem').filter({ hasText: m.username })).toHaveCount(0)
  await dialog(page).getByRole('button', { name: 'Inviter', exact: true }).click()
  await expect(toasts(page)).toContainText(`Invitation envoyée à ${f.username}.`)
  await expect(dialog(page).getByText('Invité', { exact: true })).toBeVisible()
  expect(sql(`select count(*) from wm.guild_invites where user_id = :'u'`, { u: f.uid })).toBe('1')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Inviter un ami' })).toBeFocused()
})

test('« Inviter un ami » sans ami à inviter : « Aucun ami à inviter. » ; refus du serveur → l\'alerte dans la modale', async ({ page, login }) => {
  const me = await viewer(login)
  const f = player()
  makeGuild(me)
  await openTab(page)
  await page.getByRole('button', { name: 'Inviter un ami' }).click()
  await expect(dialog(page)).toContainText('Aucun ami à inviter.')
  await page.keyboard.press('Escape')
  befriend(me, f)
  // Un ami déjà dans une guilde : le serveur refuse l'invitation.
  makeGuild(f)
  await page.getByRole('button', { name: 'Inviter un ami' }).click()
  await dialog(page).getByRole('button', { name: 'Inviter', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(/\S/)
})

test('quitter, chef avec membres : « Quitter » en aria-disabled décrit par sa phrase, rien ne part', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  const g = name()
  makeGuild(me, [a], g)
  await openTab(page)
  await page.getByRole('button', { name: 'Quitter la guilde' }).click()
  await expect(dialog(page).getByRole('heading', { name: `Quitter ${g} ?` })).toBeVisible()
  const leave = dialog(page).getByRole('button', { name: 'Quitter', exact: true })
  await expect(leave).toHaveAttribute('aria-disabled', 'true')
  await expect(leave).toHaveAccessibleDescription('Transmets d\'abord ton rôle de chef à un membre.')
  await leave.click({ force: true })
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  expect(guildOf(me)).not.toBe('')
})

test('quitter, simple membre : la vue sans guilde, toast, h1 focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  makeGuild(a, [me])
  await openTab(page)
  await page.getByRole('button', { name: 'Quitter la guilde' }).click()
  await expect(dialog(page)).toContainText('Tu pourras revenir sur une nouvelle invitation.')
  await dialog(page).getByRole('button', { name: 'Quitter', exact: true }).click()
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  await expect(toasts(page)).toContainText('Tu as quitté la guilde.')
  await expect(h1(page)).toBeFocused()
  expect(guildOf(me)).toBe('')
})

test('quitter, chef seul : la phrase de dissolution, puis la guilde n\'existe plus', async ({ page, login }) => {
  const me = await viewer(login)
  makeGuild(me)
  const g = guildOf(me)
  await openTab(page)
  await page.getByRole('button', { name: 'Quitter la guilde' }).click()
  await expect(dialog(page)).toContainText('Tu es le dernier membre : la guilde sera dissoute.')
  await dialog(page).getByRole('button', { name: 'Quitter', exact: true }).click()
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  expect(sql(`select count(*) from public.guilds where id = :'g'`, { g })).toBe('0')
})

test('exclu pendant la visite : la cloche change → la vue sans guilde et le toast', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  makeGuild(a, [me])
  await open(page)
  await expect(page.getByRole('button', { name: 'Quitter la guilde' })).toBeVisible()
  sql(`select wm.guild_kick(:'l', :'m')`, { l: a.uid, m: me.uid })
  // Le poller de la cloche relit tout de suite au retour en visible.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  await expect(toasts(page)).toContainText('Tu ne fais plus partie de cette guilde.')
})

test('exclu puis action (C6) : « Inviter » reçoit 404 « Tu n\'es dans aucune guilde » → la vue sans guilde et le toast', async ({ page, login }) => {
  const me = await viewer(login)
  const [a, f] = [player(), player()]
  makeGuild(a, [me])
  befriend(me, f)
  await openTab(page)
  await page.getByRole('button', { name: 'Inviter un ami' }).click()
  await expect(dialog(page).getByRole('button', { name: 'Inviter', exact: true })).toBeVisible()
  sql(`select wm.guild_kick(:'l', :'m')`, { l: a.uid, m: me.uid })
  await dialog(page).getByRole('button', { name: 'Inviter', exact: true }).click()
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  await expect(toasts(page)).toContainText('Tu ne fais plus partie de cette guilde.')
})

for (const [label, reply] of FAILS) {
  test(`lecture de la guilde en échec (${label}) : alerte et « Réessayer », data-ready ; « Réessayer » → la vue, le h1 focalisé`, async ({ page, login }) => {
    await viewer(login)
    let fail = true
    await page.route('**/api/guilds', (r) => (fail && r.request().method() === 'GET' ? r.fulfill(reply) : r.fallback()))
    await open(page)
    await expect(page.locator('main').getByRole('alert')).toHaveText('Impossible de charger cette page.')
    fail = false
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
    await expect(h1(page)).toBeFocused()
  })

  test(`lecture des membres en échec (${label}) : « Les membres n'ont pas pu être chargés. » ; « Réessayer » → les lignes, l'onglet focalisé`, async ({ page, login }) => {
    const me = await viewer(login)
    makeGuild(me)
    let fail = true
    await page.route('**/api/guilds/members*', (r) => (fail ? r.fulfill(reply) : r.fallback()))
    await openTab(page)
    await expect(panel(page).getByRole('alert')).toHaveText('Les membres n\'ont pas pu être chargés.')
    fail = false
    await panel(page).getByRole('button', { name: 'Réessayer' }).click()
    await expect(panel(page).getByRole('listitem')).toHaveCount(1)
    await expect(page.getByRole('tab', { name: 'Membres' })).toBeFocused()
  })
}

test('360 px, nom de guilde de 40 caractères sans espace, pseudo de 24 : aucun défilement horizontal ; boutons et liens de 44 px au moins', async ({ page, login }) => {
  const me = await viewer(login)
  const long = player({ username: `w${randomUUID().replaceAll('-', '').slice(0, 23)}` })
  expect(long.username).toHaveLength(24)
  const g = `g${randomUUID().replaceAll('-', '').slice(0, 31)}abcdefgh`
  expect(g).toHaveLength(40)
  makeGuild(me, [long], g)
  await page.setViewportSize({ width: 360, height: 800 })
  await openTab(page)
  await expect(panel(page).getByRole('listitem')).toHaveCount(2)
  expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const root = page.locator('main [data-ready]')
  const targets = root.getByRole('button').or(root.getByRole('link')).or(root.getByRole('tab'))
  // « Quitter la guilde », les quatre onglets, « Inviter un ami », les deux pseudos, « Nommer chef » et « Exclure » du long pseudo.
  await expect(targets).toHaveCount(10)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(MIN_TARGET)
  }
})


// --- Task 16 : reprises de la revue de la Task 15 ---

test('quitter puis relecture en échec : la vue sans guilde reste, sans « Tu ne fais plus partie de cette guilde. »', async ({ page, login }) => {
  const me = await viewer(login)
  makeGuild(player(), [me])
  await openTab(page)
  let left = false
  await page.route('**/api/guilds', (r) => (left && r.request().method() === 'GET' ? r.fulfill({ status: 500 }) : r.fallback()))
  await page.getByRole('button', { name: 'Quitter la guilde' }).click()
  left = true
  await dialog(page).getByRole('button', { name: 'Quitter', exact: true }).click()
  await expect(toasts(page)).toContainText('Tu as quitté la guilde.')
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  await expect(page.getByRole('button', { name: 'Quitter la guilde' })).toHaveCount(0)
  await expect(h1(page)).toBeFocused()
  // Les toasts sont posés par deux minuteurs de 50 ms : on laisse passer ce délai, puis un seul toast doit rester.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)))
  await expect(toasts(page).locator('p')).toHaveText(['Tu as quitté la guilde.'])
})

test('« Charger la suite » après une exclusion : le décalage est celui du serveur (4), pas la longueur de la liste (3)', async ({ page, login }) => {
  const me = await viewer(login)
  makeGuild(me)
  const fake = (n: number) => ({ user_id: randomUUID(), username: `Fantome${n}`, role: 'member', joined_at: new Date().toISOString() })
  const [f1, f2, f3] = [fake(1), fake(2), fake(3)]
  const lead = { user_id: me.uid, username: me.username, role: 'leader', joined_at: new Date().toISOString() }
  const offsets: string[] = []
  await page.route('**/api/guilds/members*', (r) => {
    const offset = new URL(r.request().url()).searchParams.get('offset')!
    offsets.push(offset)
    const rows = offset === '0' ? [lead, f1, f2, f3] : []
    return r.fulfill({ json: { members: rows.map((m) => ({ ...m, id: m.user_id })), hasMore: offset === '0' } })
  })
  await page.route('**/api/guilds/kick', (r) => r.fulfill({ json: { ok: true } }))
  await openTab(page)
  await expect(panel(page).getByRole('listitem')).toHaveCount(4)
  await row(page, 'Fantome1').getByRole('button', { name: 'Exclure' }).click()
  await dialog(page).getByRole('button', { name: 'Exclure', exact: true }).click()
  await expect(panel(page).getByRole('listitem')).toHaveCount(3)
  await page.getByRole('button', { name: 'Charger la suite' }).click()
  await expect.poll(() => offsets).toEqual(['0', '4'])
})

// --- Task 16 : chat de la guilde ---

const chatLog = (page: Page) => page.getByRole('log', { name: 'Chat de la guilde' })
const bubble = (page: Page, text: string) => chatLog(page).getByRole('listitem').filter({ hasText: text })
const field = (page: Page) => page.getByRole('textbox', { name: 'Ton message' })
const alertOf = (page: Page) => page.locator('main').getByRole('alert')
const CHAT_UNSURE = 'Le message n\'a pas été confirmé : il a peut-être été envoyé. Le chat se met à jour.'
const isChat = (r: Request, method = 'GET') => r.method() === method && new URL(r.url()).pathname === '/api/guilds/chat'
const say = (g: string, u: User, content: string) =>
  sql(`insert into public.guild_chat_messages (guild_id, user_id, content) values (:'g', :'u', :'c') returning id`, { g, u: u.uid, c: content })
const chatCount = (u: User, content: string) =>
  sql(`select count(*) from public.guild_chat_messages where user_id = :'u' and content = :'c'`, { u: u.uid, c: content })

test('chat à deux : A envoie au clavier → sa bulle ; B (horloge) la reçoit au poll de 5 s sous le pseudo de A ; 1 001 caractères impossibles', async ({ page, login, browser, baseURL }) => {
  const a = await viewer(login)
  const b = player()
  makeGuild(a, [b])
  const ctx = await browser.newContext()
  try {
    await ctx.addCookies([{ ...cookieFor(b), url: baseURL! }])
    const bp = await ctx.newPage()
    await bp.clock.install()
    await open(bp)
    await expect(chatLog(bp)).toHaveText('Aucun message pour l\'instant.')
    await open(page)
    await expect(page.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true')
    await expect(chatLog(page)).toHaveText('Aucun message pour l\'instant.')
    await expect(field(page)).toHaveAttribute('maxlength', '1000')
    await field(page).focus()
    await page.keyboard.insertText('x'.repeat(1001))
    await expect(field(page)).toHaveValue('x'.repeat(1000))
    await field(page).fill('')
    await page.keyboard.type('Salut la guilde')
    await page.keyboard.press('Enter')
    await expect(bubble(page, 'Salut la guilde')).toContainText('Toi : Salut la guilde')
    await expect(field(page)).toHaveValue('')
    expect(chatCount(a, 'Salut la guilde')).toBe('1')
    await bp.clock.runFor(5_000)
    await expect(bubble(bp, 'Salut la guilde')).toContainText(`${a.username} : Salut la guilde`)
    await expect(bubble(bp, 'Salut la guilde').getByRole('link', { name: a.username })).toHaveAttribute('href', `/profile/${encodeURIComponent(a.username)}`)
  } finally {
    await ctx.close()
  }
})

test('chat : 429 forcé → « Le site demande de ralentir », le texte reste dans le champ', async ({ page, login }) => {
  const me = await viewer(login)
  makeGuild(me)
  await open(page)
  await routeOnce(page, '**/api/guilds/chat', (r) => r.fulfill({
    status: 429, headers: { 'Retry-After': '30' },
    json: { error: 'Le site demande de ralentir', message: 'Le site demande de ralentir', retry_after: 30 },
  }), (r) => r.request().method() === 'POST')
  await field(page).fill('Salut')
  await field(page).press('Enter')
  await expect(alertOf(page)).toHaveText('Le site demande de ralentir')
  await expect(field(page)).toHaveValue('Salut')
  expect(chatCount(me, 'Salut')).toBe('0')
})

test('chat : issue incertaine (abort du POST) → le texte d\'incertitude ; le renvoi rejoue la même Idempotency-Key', async ({ page, login }) => {
  const me = await viewer(login)
  makeGuild(me)
  const keys: string[] = []
  page.on('request', (r) => { if (isChat(r, 'POST')) keys.push(r.headers()['idempotency-key'] ?? '') })
  await open(page)
  await routeOnce(page, '**/api/guilds/chat', (r) => r.abort(), (r) => r.request().method() === 'POST')
  await field(page).fill('Salut')
  await field(page).press('Enter')
  await expect(alertOf(page)).toHaveText(CHAT_UNSURE)
  await expect(field(page)).toHaveValue('Salut')
  await field(page).press('Enter')
  await expect(bubble(page, 'Salut')).toHaveCount(1)
  expect(keys).toHaveLength(2)
  expect(keys[1]).toBe(keys[0])
  expect(chatCount(me, 'Salut')).toBe('1')
})

test('chat : exclu qui envoie (C6) → 404 « Tu n\'es dans aucune guilde » → la vue sans guilde et le toast', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  makeGuild(a, [me])
  await open(page)
  await expect(field(page)).toBeVisible()
  sql(`select wm.guild_kick(:'l', :'m')`, { l: a.uid, m: me.uid })
  await field(page).fill('Salut')
  await field(page).press('Enter')
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  await expect(toasts(page)).toContainText('Tu ne fais plus partie de cette guilde.')
})

test('chat : un poll en échec garde l\'état affiché, brouillon compris', async ({ page, login }) => {
  const me = await viewer(login)
  const g = makeGuild(me)
  say(g, me, 'Déjà là')
  await page.clock.install()
  await open(page)
  await expect(bubble(page, 'Déjà là')).toHaveCount(1)
  await field(page).fill('brouillon')
  await page.route('**/api/guilds/chat', (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 500 }) : r.fallback()))
  const polled = page.waitForResponse((r) => isChat(r.request()))
  await page.clock.runFor(5_000)
  await polled
  await expect(bubble(page, 'Déjà là')).toHaveCount(1)
  await expect(field(page)).toHaveValue('brouillon')
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0)
})

// --- Task 16 : entraide ---

const regionOf = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const goHelp = async (page: Page) => {
  await open(page)
  await page.getByRole('tab', { name: 'Entraide' }).click()
}
const copyTitle = (copy: string) => sql(`select snapshot_title from public.user_cards where id = :'c'`, { c: copy })
const cardOf = (copy: string) => sql(`select card_id from public.user_cards where id = :'c'`, { c: copy })
const wish = (u: User, card: string) => sql(`select wm.guild_wish_set(:'u', :'c') -> 'wishlist' ->> 'id'`, { u: u.uid, c: card })
const shinyOf = (copy: string) => sql(`insert into public.user_cards (user_id, card_id, is_shiny, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
  select user_id, card_id, true, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def from public.user_cards where id = :'c' returning id`, { c: copy })

test('entraide, demande : « Demander une carte » → modale ; « a » → « Tape au moins 2 caractères. » sans requête ; un titre du seed → toast, Card, « Retirer ma demande » focalisé ; retrait → « Demander une carte » focalisé', async ({ page, login }) => {
  const me = await viewer(login)
  makeGuild(me)
  const title = sql(`select wikipedia_title from public.cards where rarity = 'C' order by wikipedia_title limit 1`)
  await goHelp(page)
  const mine = regionOf(page, 'Ma demande')
  await expect(mine).toContainText('Tu ne demandes aucune carte.')
  await expect(regionOf(page, 'Demandes de la guilde').getByText('Aucune demande dans la guilde.', { exact: true })).toBeVisible()
  await expect(regionOf(page, 'Entraide de la semaine').getByText('Aucun don cette semaine.', { exact: true })).toBeVisible()
  const ask = mine.getByRole('button', { name: 'Demander une carte' })
  await ask.click()
  const d = page.getByRole('dialog', { name: 'Choisir une carte à demander' })
  await expect(d).toBeVisible()
  let searches = 0
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/cards') searches++ })
  const q = d.getByRole('searchbox', { name: 'Rechercher une carte' })
  await expect(q).not.toHaveAttribute('placeholder')
  await q.fill('a')
  await q.press('Enter')
  await expect(d.getByRole('alert')).toHaveText('Tape au moins 2 caractères.')
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  expect(searches).toBe(0)
  await q.fill(title)
  await q.press('Enter')
  await d.getByRole('button', { name: title, exact: true }).click()
  await expect(toasts(page)).toContainText(`Demande enregistrée : ${title}.`)
  await expect(d).toHaveCount(0)
  await expect(mine.getByRole('heading', { level: 3, name: title })).toBeVisible()
  const clear = mine.getByRole('button', { name: 'Retirer ma demande' })
  await expect(clear).toBeFocused()
  await clear.click()
  await expect(mine.getByRole('button', { name: 'Demander une carte' })).toBeFocused()
  await expect(mine).toContainText('Tu ne demandes aucune carte.')
  // Annuler rend le focus à l'ouvreur.
  await mine.getByRole('button', { name: 'Demander une carte' }).click()
  await d.getByRole('button', { name: 'Annuler' }).click()
  await expect(mine.getByRole('button', { name: 'Demander une carte' })).toBeFocused()
})

test('entraide, don : deux copies (une brillante) → modale à deux radios et la ligne vitrine-avatar → toast, la demande disparaît, « Aucune demande dans la guilde. » focalisé ; base, invariants, entraide de la semaine ; chez B « Tu as reçu un don aujourd\'hui. »', async ({ page, login, browser, baseURL }) => {
  const a = await viewer(login)
  const b = player()
  makeGuild(a, [b])
  const [copy] = giveCopies(a, 'R', 1)
  const shiny = shinyOf(copy)
  const title = copyTitle(copy)
  wish(b, cardOf(copy))
  await goHelp(page)
  const item = regionOf(page, 'Demandes de la guilde').getByRole('listitem').filter({ hasText: `Demandée par ${b.username}` })
  await expect(item.getByRole('heading', { level: 3, name: title })).toBeVisible()
  await item.getByRole('button', { name: 'Donner' }).click()
  const d = page.getByRole('dialog', { name: `Donner ${title} à ${b.username} ?` })
  await expect(d.getByRole('radio')).toHaveCount(2)
  await expect(d.getByRole('radio').first()).toBeChecked()
  await expect(d.getByRole('radio', { name: 'Copie ×1, brillante' })).toBeVisible()
  await expect(d).toContainText('Si cette copie est dans ta vitrine ou ton avatar, elle en sort.')
  await d.getByRole('radio', { name: 'Copie ×1, brillante' }).check()
  await d.getByRole('button', { name: 'Donner', exact: true }).click()
  await expect(toasts(page)).toContainText(`Don envoyé à ${b.username} : +1 point de karma.`)
  await expect(d).toHaveCount(0)
  await expect(regionOf(page, 'Demandes de la guilde').getByText('Aucune demande dans la guilde.', { exact: true })).toBeFocused()
  expect(sql(`select user_id from public.user_cards where id = :'c'`, { c: shiny })).toBe(b.uid)
  expect(sql(`select user_id from public.user_cards where id = :'c'`, { c: copy })).toBe(a.uid)
  expect(sql(`select count(*) from public.guild_donations where donor_id = :'a' and recipient_id = :'b'`, { a: a.uid, b: b.uid })).toBe('1')
  expect(sql(`select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(wm.check_invariants()) v where v ->> 'user_id' in (:'a', :'b')`, { a: a.uid, b: b.uid })).toBe('[]')
  await expect(regionOf(page, 'Entraide de la semaine').getByRole('listitem')).toHaveText(`${a.username} — 1 don`)
  const ctx = await browser.newContext()
  try {
    await ctx.addCookies([{ ...cookieFor(b), url: baseURL! }])
    const bp = await ctx.newPage()
    await goHelp(bp)
    await expect(regionOf(bp, 'Ma demande')).toContainText('Tu as reçu un don aujourd\'hui.')
  } finally {
    await ctx.close()
  }
})

test('entraide, « Donner » désactivé : receveur déjà servi aujourd\'hui, ou aucune copie libre (aria-disabled décrit) ; le clic n\'ouvre rien', async ({ page, login }) => {
  const a = await viewer(login)
  const [b, c] = [player(), player()]
  makeGuild(a, [b, c])
  const [x, y] = giveCopies(a, 'R', 2)
  // b a déjà reçu un don aujourd'hui (ligne posée par SQL) puis demande y ; c demande une carte que a n'a pas.
  const w1 = wish(b, cardOf(x))
  sql(`insert into public.guild_donations (guild_id, wishlist_id, donor_id, recipient_id, user_card_id)
    select guild_id, id, :'a', user_id, :'x' from public.guild_wishlists where id = :'w'`, { a: a.uid, w: w1, x })
  sql(`update public.guild_wishlists set fulfilled_at = now() where id = :'w'`, { w: w1 })
  wish(b, cardOf(y))
  const other = sql(`select id from public.cards where id not in (select card_id from public.user_cards where user_id = :'a') order by wikipedia_title limit 1`, { a: a.uid })
  wish(c, other)
  await goHelp(page)
  const list = regionOf(page, 'Demandes de la guilde')
  const forB = list.getByRole('listitem').filter({ hasText: `Demandée par ${b.username}` }).getByRole('button', { name: 'Donner' })
  const forC = list.getByRole('listitem').filter({ hasText: `Demandée par ${c.username}` }).getByRole('button', { name: 'Donner' })
  await expect(forB).toHaveAttribute('aria-disabled', 'true')
  await expect(forB).toHaveAccessibleDescription(`${b.username} a déjà reçu un don aujourd'hui.`)
  await expect(forC).toHaveAttribute('aria-disabled', 'true')
  await expect(forC).toHaveAccessibleDescription('Tu n\'as pas de copie libre de cette carte.')
  await forC.click({ force: true })
  await expect(dialog(page)).toHaveCount(0)
})

test('entraide, don refusé (409 forcé) : l\'alerte dans la modale, qui reste ouverte', async ({ page, login }) => {
  const a = await viewer(login)
  const b = player()
  makeGuild(a, [b])
  const [copy] = giveCopies(a, 'R', 1)
  wish(b, cardOf(copy))
  await goHelp(page)
  await routeOnce(page, '**/api/guilds/wishlist/donate', (r) => r.fulfill({
    status: 409, json: { error: 'Ce membre a déjà reçu un don aujourd\'hui', message: 'Ce membre a déjà reçu un don aujourd\'hui' },
  }))
  await regionOf(page, 'Demandes de la guilde').getByRole('button', { name: 'Donner' }).click()
  await dialog(page).getByRole('button', { name: 'Donner', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText('Ce membre a déjà reçu un don aujourd\'hui')
  expect(sql(`select count(*) from public.guild_donations where donor_id = :'a'`, { a: a.uid })).toBe('0')
})

test('entraide, exclu qui retire sa demande (C6) → la vue sans guilde et le toast', async ({ page, login }) => {
  const me = await viewer(login)
  const a = player()
  makeGuild(a, [me])
  const [copy] = giveCopies(me, 'R', 1)
  wish(me, cardOf(copy))
  await goHelp(page)
  const clear = regionOf(page, 'Ma demande').getByRole('button', { name: 'Retirer ma demande' })
  await expect(clear).toBeVisible()
  sql(`select wm.guild_kick(:'l', :'m')`, { l: a.uid, m: me.uid })
  await clear.click()
  await expect(page.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
  await expect(toasts(page)).toContainText('Tu ne fais plus partie de cette guilde.')
})

// --- Task 16 : classement ---

const boardBody = (mine: string, over: Record<string, unknown> = {}) => ({
  entries: [
    { rank: 1, guild_id: randomUUID(), guild_name: 'Les Rivaux', member_count: 12, score_battles: 1500, score_wb: 20, total_score: 1520 },
    { rank: 2, guild_id: mine, guild_name: 'Notre Guilde', member_count: 3, score_battles: 500, score_wb: 5, total_score: 505 },
  ],
  week_start: '2026-10-26T00:00:00.000Z', week_end: '2026-11-02T00:00:00.000Z', season: 'S53', reset_in_ms: 2_000, user_guild_id: mine, ...over,
})
const isBoard = (r: Request) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/guilds/leaderboard'
const goBoard = async (page: Page) => {
  await open(page)
  await page.getByRole('tab', { name: 'Classement' }).click()
}

test('classement : « Saison S53 », la ligne de sa guilde en aria-current ; relu après max(reset_in_ms, 5 s), pas avant', async ({ page, login }) => {
  const me = await viewer(login)
  const g = makeGuild(me)
  let reads = 0
  page.on('request', (r) => { if (isBoard(r)) reads++ })
  await page.clock.install()
  await routeOnce(page, '**/api/guilds/leaderboard', (r) => r.fulfill({ json: boardBody(g) }))
  await goBoard(page)
  await expect(panel(page)).toContainText('Saison S53')
  await expect(panel(page)).toContainText('Jusqu\'au')
  const table = panel(page).getByRole('table', { name: 'Classement des guildes, saison S53' })
  await expect(table.getByRole('columnheader')).toHaveText(['Rang', 'Guilde', 'Membres', 'Batailles', 'Enchères', 'Total'])
  const mineRow = table.getByRole('row').filter({ hasText: 'Notre Guilde' })
  await expect(mineRow).toHaveAttribute('aria-current', 'true')
  await expect(mineRow).toContainText('(ta guilde)')
  await expect(table.getByRole('row').filter({ hasText: 'Les Rivaux' })).not.toHaveAttribute('aria-current')
  await expect(table).toContainText('1 520')
  expect(reads).toBe(1)
  await page.clock.runFor(4_000)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)))
  expect(reads).toBe(1)
  await page.clock.runFor(1_000)
  await expect.poll(() => reads).toBe(2)
})

test('classement : reset_in_ms à 0 à chaque lecture → au plus une requête par 5 s (runFor 20 s)', async ({ page, login }) => {
  const me = await viewer(login)
  const g = makeGuild(me)
  let reads = 0
  page.on('request', (r) => { if (isBoard(r)) reads++ })
  await page.clock.install()
  await page.route('**/api/guilds/leaderboard', (r) => r.fulfill({ json: boardBody(g, { reset_in_ms: 0 }) }))
  await goBoard(page)
  await expect(panel(page)).toContainText('Saison S53')
  await page.clock.runFor(20_000)
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)))
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(reads).toBeLessThanOrEqual(5)
})

test('classement vide : « Aucune guilde classée cette semaine. »', async ({ page, login }) => {
  const me = await viewer(login)
  const g = makeGuild(me)
  await page.route('**/api/guilds/leaderboard', (r) => r.fulfill({ json: boardBody(g, { entries: [], user_guild_id: null }) }))
  await goBoard(page)
  await expect(panel(page).getByText('Aucune guilde classée cette semaine.', { exact: true })).toBeVisible()
})

// --- Task 16 : lectures en échec des onglets ---

for (const [label, reply] of FAILS) {
  for (const [tabName, url, text] of [
    ['Entraide', '**/api/guilds/home', 'L\'entraide n\'a pas pu être chargée.'],
    ['Classement', '**/api/guilds/leaderboard', 'Le classement n\'a pas pu être chargé.'],
  ] as const) {
    test(`lecture de l'onglet ${tabName} en échec (${label}) : « ${text} » ; « Réessayer » → le contenu, l'onglet focalisé`, async ({ page, login }) => {
      const me = await viewer(login)
      makeGuild(me)
      let fail = true
      await page.route(url, (r) => (fail ? r.fulfill(reply) : r.fallback()))
      await open(page)
      await page.getByRole('tab', { name: tabName }).click()
      await expect(panel(page).getByRole('alert')).toHaveText(text)
      fail = false
      await panel(page).getByRole('button', { name: 'Réessayer' }).click()
      await expect(panel(page).getByRole('alert')).toHaveCount(0)
      await expect(page.getByRole('tab', { name: tabName })).toBeFocused()
    })
  }
}

test('360 px : chat (message de 1 000 caractères sans espace), entraide (trois souhaits), classement → aucun défilement horizontal, cibles de 44 px', async ({ page, login }) => {
  const a = await viewer(login)
  const others = [player(), player(), player()]
  const g = makeGuild(a, others)
  say(g, others[0], 'm'.repeat(1000))
  say(g, a, 'bonjour')
  const copies = giveCopies(a, 'R', 3)
  others.forEach((o, i) => wish(o, cardOf(copies[i])))
  // Corps posé : le classement réel est partagé en cache entre les tests, et une guilde sans point n'y figure pas.
  await page.route('**/api/guilds/leaderboard', (r) => r.fulfill({ json: boardBody(g, { reset_in_ms: 3_600_000, entries: [
    { rank: 1, guild_id: g, guild_name: `g${'x'.repeat(39)}`, member_count: 4, score_battles: 1_234_500, score_wb: 1_234_500, total_score: 2_469_000 }] }) }))
  await page.setViewportSize({ width: 360, height: 800 })
  const fits = async () => {
    expect(await page.locator('main').evaluate((m) => m.scrollWidth <= m.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const root = page.locator('main [data-ready]')
    for (const target of await root.getByRole('button').or(root.getByRole('link')).or(root.getByRole('tab')).all()) {
      const box = (await target.boundingBox())!
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(MIN_TARGET)
    }
  }
  await open(page)
  await expect(bubble(page, 'm'.repeat(50))).toHaveCount(1)
  await fits()
  await page.getByRole('tab', { name: 'Entraide' }).click()
  await expect(regionOf(page, 'Demandes de la guilde').getByRole('listitem')).toHaveCount(3)
  await fits()
  await page.getByRole('tab', { name: 'Classement' }).click()
  await expect(panel(page).getByRole('table')).toBeVisible()
  await fits()
})
