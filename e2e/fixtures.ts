import { readFileSync } from 'node:fs'
import { test as base, expect } from '@playwright/test'
import type { Backend } from '../contract/harness.ts'
import { authCookie, makeUser } from '../contract/users.ts'

type User = ReturnType<typeof makeUser>

// login() crée un joueur neuf (makeUser) et pose son cookie de session : aucun état partagé entre tests ni workers.
export const test = base.extend<{ login: (opts?: Parameters<typeof makeUser>[1]) => Promise<User> }>({
  login: async ({ context, baseURL }, provide) => {
    await provide(async (opts) => {
      // Écrit par contract/serve.ts au démarrage du banc.
      const backend = JSON.parse(readFileSync(new URL('../.cache/backend.json', import.meta.url), 'utf8')) as Omit<Backend, 'stop'>
      const user = makeUser(backend.databaseUrl, opts)
      const cookie = authCookie(backend, user.uid)
      // Au-delà, @supabase/ssr découpe le cookie en morceaux (.0, .1…) : ce cookie unique ne serait plus lu.
      expect(cookie.value.length, 'cookie de session trop long pour un seul morceau').toBeLessThan(3180)
      await context.addCookies([{ ...cookie, url: baseURL! }])
      return user
    })
  },
})

export { expect }
