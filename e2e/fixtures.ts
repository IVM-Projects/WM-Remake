import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test as base, expect, type Locator, type Page, type Route } from '@playwright/test'
import type { Backend } from '../contract/harness.ts'
import { authCookie, giveCards, makeUser, psql } from '../contract/users.ts'

type User = ReturnType<typeof makeUser>

// Écrit par contract/serve.ts au démarrage du banc.
const backend = () => JSON.parse(readFileSync(new URL('../.cache/backend.json', import.meta.url), 'utf8')) as Omit<Backend, 'stop'>

// Joueur neuf, confirmé et sans mot de passe, sans session dans le navigateur.
export const makePlayer = (opts?: Parameters<typeof makeUser>[1]): User => makeUser(backend().databaseUrl, opts)

// psql sur la base du banc (variables :'nom', jamais de concaténation).
export const sql = (query: string, vars?: Record<string, string>): string => psql(backend().databaseUrl, query, vars)

// Membre du staff : un joueur de makePlayer avec sa ligne wm.staff (supprimé avec auth.users, en cascade).
export const makeStaff = (role: 'admin' | 'moderator' = 'admin'): User => {
  const u = makePlayer()
  sql(`insert into wm.staff (user_id, role) values (:'uid', :'role')`, { uid: u.uid, role })
  return u
}

// n copies des n premières cartes du seed de cette rareté (P20) ; renvoie les ids des copies.
export const giveCopies = (u: User, rarity: string, n = 1): string[] => giveCards(backend().databaseUrl, u.uid, rarity, n)

// Copie d'une carte R à image (tests.image_card, B11), au titre unique à fin non numérique ; renvoie l'id de la copie.
export const imageCopy = (u: User): string => sql(`select tests.image_card(:'title') as card \\gset
insert into public.user_cards (user_id, card_id, snapshot_title, snapshot_rarity, snapshot_category, snapshot_atk, snapshot_def)
select :'uid', id, wikipedia_title, rarity, category, atk, def from public.cards where id = :'card' returning id`,
{ uid: u.uid, title: `Zz image e2e ${randomUUID().slice(-12)} z` })

// Amis par SQL (P20) : une ligne accepted, `a` demandeur ; renvoie son id.
export const befriend = (a: User, b: User): string =>
  sql(`insert into public.friendships (requester_id, addressee_id, status) values (:'a', :'b', 'accepted') returning id`, { a: a.uid, b: b.uid })

// Guilde par les fonctions (P20) : chaque membre est ami du chef, invité puis inscrit ; renvoie l'id de la guilde.
// L'appelant la supprime avant les auth.users (Global Constraints, E2E).
export const makeGuild = (leader: User, members: User[] = [], name = `Guilde ${randomUUID().slice(0, 8)}`): string => {
  for (const m of members) befriend(leader, m)
  const id = sql(`select wm.guild_create(:'l', :'n') -> 'guild' ->> 'id'`, { l: leader.uid, n: name })
  for (const m of members) {
    sql(`select wm.guild_invite(:'l', :'m')`, { l: leader.uid, m: m.uid })
    sql(`select wm.guild_join(:'m', :'g')`, { m: m.uid, g: id })
  }
  return id
}

// Cookie de session d'un joueur de makePlayer, pour son propre contexte de navigateur (P22).
export const cookieFor = (u: User) => authCookie(backend(), u.uid)

// { times: 1 } qui reste tout le test (les requêtes suivantes : fallback) : son expiration envoie Fetch.disable, et Chromium perd parfois une requête en vol.
// `when` : seule la première requête qui le vérifie est prise (une méthode sur une adresse partagée par GET et PATCH).
export async function routeOnce(page: Page, url: Parameters<Page['route']>[0], handler: (route: Route) => unknown,
  when: (route: Route) => boolean = () => true): Promise<void> {
  let used = false
  await page.route(url, (route) => {
    if (used || !when(route)) return route.fallback()
    used = true
    return handler(route)
  })
}

// login() crée un joueur neuf (makeUser) et pose son cookie de session : aucun état partagé entre tests ni workers.
export const test = base.extend<{ login: (opts?: Parameters<typeof makeUser>[1]) => Promise<User> }>({
  login: async ({ context, baseURL }, provide) => {
    await provide(async (opts) => {
      const b = backend()
      const user = makeUser(b.databaseUrl, opts)
      const cookie = authCookie(b, user.uid)
      // Au-delà, @supabase/ssr découpe le cookie en morceaux (.0, .1…) : ce cookie unique ne serait plus lu.
      expect(cookie.value.length, 'cookie de session trop long pour un seul morceau').toBeLessThan(3180)
      await context.addCookies([{ ...cookie, url: baseURL! }])
      return user
    })
  },
})

// Un <Link> de Next cliqué avant l'hydratation est un <a> nu : rechargement complet, qui sort de l'historique SPA (Activity perdue).
export async function hydrated(link: Locator): Promise<void> {
  await expect.poll(() => link.evaluate((a) => Object.keys(a).some((k) => k.startsWith('__reactProps')))).toBe(true)
}

export type Account = { username: string; email: string; password: string }

// Compte neuf par test : aucun état partagé entre workers.
export function fresh(): Account {
  const id = randomUUID().slice(-12)
  return { username: `e2e_${id}`, email: `e2e_${id}@test.local`, password: 'mot-de-passe-e2e' }
}

export async function logIn(page: Page, email: string, password: string) {
  await page.getByLabel('Adresse courriel').fill(email)
  await page.getByLabel('Mot de passe', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Se connecter' }).click()
}

export { expect }
