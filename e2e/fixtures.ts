import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test as base, expect, type Page } from '@playwright/test'
import type { Backend } from '../contract/harness.ts'
import { authCookie, makeUser, psql } from '../contract/users.ts'

type User = ReturnType<typeof makeUser>

// Écrit par contract/serve.ts au démarrage du banc.
const backend = () => JSON.parse(readFileSync(new URL('../.cache/backend.json', import.meta.url), 'utf8')) as Omit<Backend, 'stop'>

// Joueur neuf, confirmé et sans mot de passe, sans session dans le navigateur.
export const makePlayer = (opts?: Parameters<typeof makeUser>[1]): User => makeUser(backend().databaseUrl, opts)

// psql sur la base du banc (variables :'nom', jamais de concaténation).
export const sql = (query: string, vars?: Record<string, string>): string => psql(backend().databaseUrl, query, vars)

// Cookie de session d'un joueur de makePlayer, pour son propre contexte de navigateur (P22).
export const cookieFor = (u: User) => authCookie(backend(), u.uid)

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
