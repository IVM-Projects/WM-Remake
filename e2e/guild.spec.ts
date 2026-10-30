import { randomUUID } from 'node:crypto'
import type { Page, Request } from '@playwright/test'
import { befriend, expect, makeGuild, makePlayer, routeOnce, sql, test } from './fixtures'

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
// Préflight C5 : la Task 16 fait du Chat l'onglet par défaut ; ces cas cliquent « Membres » explicitement.
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
  // « Quitter la guilde », l'onglet, « Inviter un ami », les deux pseudos, « Nommer chef » et « Exclure » du long pseudo.
  await expect(targets).toHaveCount(7)
  for (const target of await targets.all()) {
    const box = (await target.boundingBox())!
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(MIN_TARGET)
  }
})
