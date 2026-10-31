import { randomUUID } from 'node:crypto'
import type { BrowserContext, Locator, Page } from '@playwright/test'
import { befriend, cookieFor, expect, giveCopies, hydrated, makePlayer, sql, test } from './fixtures'

// Sélecteurs repris de guild.spec.ts, battle-journey.spec.ts et achievements.spec.ts. Une page quittée reste dans le DOM, masquée : seul le visible compte.
const ready = (page: Page) => page.locator('main [data-ready]').filter({ visible: true }).waitFor()
const bell = (page: Page) => page.locator('button[aria-label="Notifications"]')
const h2 = (page: Page, text: string) => page.getByRole('heading', { level: 2, name: text, exact: true })
const tab = (page: Page, name: string) => page.getByRole('tab', { name })
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const dialog = (page: Page) => page.getByRole('dialog')
const toasts = (page: Page) => page.locator('#wm-toasts')
const chatLog = (page: Page) => page.getByRole('log', { name: 'Chat de la guilde' })
// Le poll du chat passe toutes les 5 s : l'autre joueur voit le nouvel état en moins de 10 s.
const POLL = { timeout: 10_000 }
const MIN_TARGET = 44 - 0.01

// Clavier seul : focus, puis Entrée.
async function press(target: Locator) {
  await target.focus()
  await target.press('Enter')
}
// Cible de 44 px (A11y) sur ce qu'on active.
async function target44(target: Locator) {
  const box = (await target.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(MIN_TARGET)
  expect(box.height).toBeGreaterThanOrEqual(MIN_TARGET)
}
async function openGuild(page: Page) {
  await page.goto('/guild')
  await ready(page)
}

// Recette M5b (jalon) : A crée une guilde et invite son ami B ; B l'apprend par la cloche et la rejoint ; chat ; B demande une carte et A la
// donne ; une bataille gagnée par A crédite 500 points au classement ; A réclame « Débutant » ; B quitte la guilde. Un contexte de navigateur par
// joueur ; seules écritures SQL : l'étape 1 (joueurs, amitié, cartes) et la bataille posée par les fonctions (étape 6) ; le reste passe par les pages.
test('parcours M5b : guilde créée, invitation par la cloche, adhésion, chat, demande et don, +500 au classement, succès réclamé, départ de B', async ({ browser, baseURL }) => {
  test.setTimeout(240_000)
  const contexts: BrowserContext[] = []
  const uids: string[] = []
  try {
    // 1. A et B amis ; A a 50 copies C (« Débutant ») et la carte X (R) ; B 3 copies C pour son deck.
    const a = makePlayer()
    uids.push(a.uid)
    const b = makePlayer()
    uids.push(b.uid)
    befriend(a, b)
    const cA = giveCopies(a, 'C', 50)
    const [x] = giveCopies(a, 'R', 1)
    const cB = giveCopies(b, 'C', 3)
    const title = sql(`select snapshot_title from public.user_cards where id = :'x'`, { x })
    for (const u of [a, b]) {
      const ctx = await browser.newContext()
      contexts.push(ctx)
      await ctx.addCookies([{ ...cookieFor(u), url: baseURL! }])
    }
    const [ap, bp] = await Promise.all(contexts.map((c) => c.newPage()))

    // Plancher de requêtes mesurées (écritures réussies par adresse, tous joueurs) et aucune réponse 5xx de toute la recette.
    const posts = new Map<string, number>()
    const failures: string[] = []
    for (const page of [ap, bp]) {
      page.on('response', (r) => {
        const path = new URL(r.url()).pathname
        if (!path.startsWith('/api/')) return
        if (r.status() >= 500) failures.push(`${r.status()} ${r.request().method()} ${path}`)
        if (r.request().method() !== 'GET' && r.ok()) posts.set(path, (posts.get(path) ?? 0) + 1)
      })
    }

    // 2. A crée « Les Archivistes <8 caractères> » au clavier (le nom est unique : le classement est partagé avec les autres E2E), puis invite B.
    const name = `Les Archivistes ${randomUUID().slice(0, 8)}`
    await openGuild(ap)
    await ap.getByLabel('Nom de la guilde').fill(name)
    await ap.keyboard.press('Tab')
    await ap.keyboard.press('Tab')
    await expect(ap.getByRole('button', { name: 'Créer la guilde' })).toBeFocused()
    await ap.keyboard.press('Enter')
    await expect(h2(ap, name)).toBeFocused()
    const guild = sql(`select guild_id from public.guild_members where user_id = :'u'`, { u: a.uid })
    expect(guild).toMatch(/^[0-9a-f-]{36}$/)
    await tab(ap, 'Membres').click()
    await press(ap.getByRole('button', { name: 'Inviter un ami' }))
    const invite = dialog(ap).getByRole('listitem').filter({ hasText: b.username }).getByRole('button', { name: 'Inviter', exact: true })
    await target44(invite)
    await press(invite)
    await expect(toasts(ap)).toContainText(`Invitation envoyée à ${b.username}.`)
    await ap.keyboard.press('Escape')

    // 3. B : la cloche annonce l'invitation, mène à /guild, « Rejoindre » ouvre la vue membre.
    await bp.goto('/pulls')
    await hydrated(bell(bp))
    await press(bell(bp))
    await press(bp.getByRole('dialog', { name: 'Notifications' }).getByRole('link', { name: `${a.username} t'invite dans la guilde ${name}`, exact: true }))
    await expect(bp).toHaveURL('/guild')
    await ready(bp)
    await press(bp.getByRole('button', { name: 'Rejoindre' }))
    await expect(h2(bp, name)).toBeVisible()

    // 4. Chat : B écrit, A le voit sous le pseudo de B.
    await tab(bp, 'Chat').click()
    const field = bp.getByRole('textbox', { name: 'Ton message' })
    await field.focus()
    await bp.keyboard.type('Bonjour')
    await bp.keyboard.press('Enter')
    await expect(chatLog(bp).getByRole('listitem').filter({ hasText: 'Bonjour' })).toContainText('Toi : Bonjour')
    await tab(ap, 'Chat').click()
    await expect(chatLog(ap).getByRole('listitem').filter({ hasText: 'Bonjour' })).toContainText(`${b.username} : Bonjour`, POLL)

    // 5. Entraide : B demande X, A la donne, B voit le don.
    await tab(bp, 'Entraide').click()
    await press(region(bp, 'Ma demande').getByRole('button', { name: 'Demander une carte' }))
    const pick = bp.getByRole('dialog', { name: 'Choisir une carte à demander' })
    const q = pick.getByRole('searchbox', { name: 'Rechercher une carte' })
    await q.fill(title)
    await q.press('Enter')
    await press(pick.getByRole('button', { name: title, exact: true }))
    await expect(region(bp, 'Ma demande').getByRole('heading', { level: 3, name: title })).toBeVisible()
    await tab(ap, 'Entraide').click()
    const wanted = region(ap, 'Demandes de la guilde').getByRole('listitem').filter({ hasText: `Demandée par ${b.username}` })
    await expect(wanted.getByRole('heading', { level: 3, name: title })).toBeVisible(POLL)
    await press(wanted.getByRole('button', { name: 'Donner' }))
    const give = ap.getByRole('dialog', { name: `Donner ${title} à ${b.username} ?` })
    await press(give.getByRole('button', { name: 'Donner', exact: true }))
    await expect(toasts(ap)).toContainText(`Don envoyé à ${b.username} : +1 point de karma.`)
    // L'entraide ne se relit pas seule : B rouvre l'onglet.
    await expect(async () => {
      await openGuild(bp)
      await tab(bp, 'Entraide').click()
      await expect(region(bp, 'Ma demande')).toContainText('Tu as reçu un don aujourd\'hui.', { timeout: 3_000 })
    }).toPass({ timeout: 20_000 })
    expect(sql(`select user_id from public.user_cards where id = :'x'`, { x })).toBe(b.uid)

    // 6. Bataille A contre B posée par les fonctions, close par l'abandon de B : A gagne, la guilde de A reçoit 500 points.
    const battle = sql(`select wm.battle_create(:'a', :'b') ->> 'id'`, { a: a.uid, b: b.uid })
    sql(`select from wm.battle_action(:'b', :'id', 'accept')`, { b: b.uid, id: battle })
    for (const [u, c] of [[a, cA.slice(0, 3)], [b, cB]] as const) {
      sql(`select from wm.battle_action(:'u', :'id', 'submit_deck', jsonb_build_object('card_ids', string_to_array(:'c', ',')))`, { u: u.uid, id: battle, c: c.join(',') })
    }
    sql(`select from wm.battle_action(:'b', :'id', 'forfeit')`, { b: b.uid, id: battle })
    expect(sql(`select winner_id from public.battles where id = :'id'`, { id: battle })).toBe(a.uid)
    // Le classement est mis en cache 30 s : la relecture de l'onglet est dans le toPass.
    await expect(async () => {
      await openGuild(ap)
      await tab(ap, 'Classement').click()
      const mine = ap.getByRole('tabpanel').locator('tr[aria-current="true"]')
      await expect(mine).toBeVisible({ timeout: 3_000 })
      await expect(mine).toContainText('500')
    }).toPass({ timeout: 40_000 })
    expect(sql(`select score_battles || ' ' || total_score from public.guild_weekly_scores where guild_id = :'g' and week_start = wm.week_start(now())`, { g: guild })).toBe('500 500')

    // 7. A réclame « Débutant » (50 cartes) : le check de l'ouverture le débloque ; solde + 10, une ligne ach:<id>.
    const before = Number(sql(`select wikibidous_balance from public.profiles where id = :'u'`, { u: a.uid }))
    await ap.goto('/achievements')
    await ready(ap)
    const debutant = ap.getByRole('listitem').filter({ has: ap.getByRole('heading', { level: 3, name: 'Débutant', exact: true }) })
    await press(debutant.getByRole('button', { name: 'Réclamer' }))
    await expect(toasts(ap)).toContainText('Débutant : +10 wikibidous')
    expect(Number(sql(`select wikibidous_balance from public.profiles where id = :'u'`, { u: a.uid }))).toBe(before + 10)
    expect(sql(`select count(*) from wm.wb_ledger where user_id = :'u' and ref = 'ach:' || md5('wm-ach:cards_50')::uuid`, { u: a.uid })).toBe('1')

    // 8. B quitte la guilde ; A ne le voit plus parmi les membres.
    await tab(bp, 'Membres').click()
    await press(bp.getByRole('button', { name: 'Quitter la guilde' }))
    await press(dialog(bp).getByRole('button', { name: 'Quitter', exact: true }))
    await expect(bp.locator('main')).toContainText('Tu n\'as pas encore de guilde.')
    expect(sql(`select count(*) from public.guild_members where user_id = :'u'`, { u: b.uid })).toBe('0')
    await expect(async () => {
      await openGuild(ap)
      await tab(ap, 'Membres').click()
      await expect(ap.getByRole('tabpanel').getByRole('listitem').filter({ hasText: a.username })).toHaveCount(1, { timeout: 3_000 })
      await expect(ap.getByRole('tabpanel').getByRole('listitem').filter({ hasText: b.username })).toHaveCount(0)
    }).toPass({ timeout: 20_000 })

    // 9. Fin : plancher de requêtes, aucune 5xx, invariants vides pour A, B et leur bataille.
    for (const [path, min] of [['/api/guilds', 1], ['/api/guilds/invite', 1], ['/api/guilds/join', 1], ['/api/guilds/chat', 1], ['/api/guilds/wishlist', 1],
      ['/api/guilds/wishlist/donate', 1], ['/api/guilds/leave', 1], ['/api/achievements/claim', 1]] as const) {
      expect(posts.get(path) ?? 0, `écriture ${path}`).toBeGreaterThanOrEqual(min)
    }
    expect(failures).toEqual([])
    expect(sql(`select coalesce(jsonb_agg(v), '[]') from jsonb_array_elements(wm.check_invariants()) v where v ->> 'user_id' in (:'a', :'b') or v ->> 'battle_id' = :'id' or v ->> 'ref' = 'battle:' || :'id'`,
      { a: a.uid, b: b.uid, id: battle })).toBe('[]')
  } finally {
    await Promise.allSettled(contexts.map((c) => c.close()))
    // Les guildes d'abord (une suppression de compte ne passe pas par une guilde qui a encore des membres), puis les joueurs.
    const ids = uids.join(',')
    sql(`delete from public.guilds where leader_id = any(string_to_array(:'uids', ',')::uuid[])
      or id in (select guild_id from public.guild_members where user_id = any(string_to_array(:'uids', ',')::uuid[]))`, { uids: ids })
    sql(`delete from auth.users where id = any(string_to_array(:'uids', ',')::uuid[])`, { uids: ids })
  }
})
