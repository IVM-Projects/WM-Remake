import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test as base, expect } from '@playwright/test'
import { sessionCookie, signJwt } from '../contract/jwt.ts'

type Backend = { supabaseUrl: string; databaseUrl: string; privateJwk: JsonWebKey }

export const test = base.extend<{ login: (uid: string) => Promise<void> }>({
  login: async ({ context, baseURL }, provide) => {
    await provide(async (uid) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uid)) throw new Error(`uid invalide : ${uid}`)
      // Écrit par contract/serve.ts au démarrage du banc.
      const backend = JSON.parse(readFileSync(new URL('../.cache/backend.json', import.meta.url), 'utf8')) as Backend
      // uid fixe, alors que tests.make_user tire le sien : insertion directe, idempotente entre workers.
      execFileSync('psql', [backend.databaseUrl, '-qX', '-v', 'ON_ERROR_STOP=1',
        '-c', `insert into auth.users (id, email) values ('${uid}', '${uid}@test.local') on conflict do nothing`,
        '-c', `insert into public.profiles (id, username) values ('${uid}', 'e2e_${uid.slice(-12)}') on conflict do nothing`,
      ])
      const now = Math.floor(Date.now() / 1000)
      const jwt = signJwt(backend.privateJwk, { sub: uid, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 })
      const cookie = sessionCookie(backend.supabaseUrl, jwt, uid)
      // Au-delà, @supabase/ssr découpe le cookie en morceaux (.0, .1…) : ce cookie unique ne serait plus lu.
      expect(cookie.value.length, 'cookie de session trop long pour un seul morceau').toBeLessThan(3180)
      await context.addCookies([{ ...cookie, url: baseURL! }])
    })
  },
})

export { expect }
