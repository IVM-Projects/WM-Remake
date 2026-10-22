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

// n copies des n premières cartes du seed de cette rareté (P20) ; renvoie les ids des copies.
export const giveCopies = (u: User, rarity: string, n = 1): string[] => giveCards(backend().databaseUrl, u.uid, rarity, n)

// Amis par SQL (P20) : une ligne accepted, `a` demandeur ; renvoie son id.
export const befriend = (a: User, b: User): string =>
  sql(`insert into public.friendships (requester_id, addressee_id, status) values (:'a', :'b', 'accepted') returning id`, { a: a.uid, b: b.uid })

// Cookie de session d'un joueur de makePlayer, pour son propre contexte de navigateur (P22).
export const cookieFor = (u: User) => authCookie(backend(), u.uid)

// { times: 1 } qui reste tout le test (les requêtes suivantes : fallback) : son expiration envoie Fetch.disable, et Chromium perd parfois une requête en vol.
export async function routeOnce(page: Page, url: Parameters<Page['route']>[0], handler: (route: Route) => unknown): Promise<void> {
  let used = false
  await page.route(url, (route) => {
    if (used) return route.fallback()
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
